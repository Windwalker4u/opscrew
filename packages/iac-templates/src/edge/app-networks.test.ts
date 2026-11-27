// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax, not JavaScript templates.
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { previewScript } from "../previews/script";
import { renderCaddyfile, renderCompose, renderEdgeSite } from "../runtime";
import { edgeCheckStep } from "../workflow/edge-check";
import { rollbackCommands, switchCommands } from "../workflow/switch";
import {
  APP_KAMAL_PROXY_SERVICE,
  appProxyAlias,
  appProxyUpstream,
  EDGE_PROJECT,
  edgeAppUpstream,
  KAMAL_PROXY_MEMORY_MB,
  renderEdgeCompose,
} from "./index";

describe("feature 049 (Option B): per-app kamal-proxy and network isolation", () => {
  it("puts app strictly on internal and adds a hardened per-app kamal-proxy bridging internal and opscrew-edge", () => {
    const plan = testPlan();
    const compose = parse(renderCompose(plan).content) as {
      services: Record<string, Record<string, unknown>>;
      networks: Record<string, unknown>;
      volumes?: Record<string, unknown>;
    };

    expect(compose.services.app?.networks).toEqual(["internal"]);

    const proxy = compose.services[APP_KAMAL_PROXY_SERVICE];
    expect(proxy).toBeDefined();
    expect(proxy?.mem_limit).toBe(`${KAMAL_PROXY_MEMORY_MB}m`);
    expect(proxy?.memswap_limit).toBe(`${KAMAL_PROXY_MEMORY_MB}m`);
    expect(proxy?.cap_drop).toEqual(["ALL"]);
    expect(proxy?.security_opt).toEqual(["no-new-privileges:true"]);
    expect(proxy?.volumes).toEqual(["kamal-proxy-config:/home/kamal-proxy/.config/kamal-proxy"]);
    expect(proxy?.networks).toEqual({
      internal: {},
      [EDGE_PROJECT]: { aliases: [appProxyAlias("shop")] },
    });

    expect(compose.networks).toEqual({
      internal: {},
      [EDGE_PROJECT]: { external: true },
    });
    expect(compose.volumes?.["kamal-proxy-config"]).toEqual({});
  });

  it("keeps the legacy shared kamal-proxy in /srv/edge/compose.yaml through the mixed-version transition", () => {
    const plan = testPlan();
    const edge = parse(renderEdgeCompose(plan).content) as {
      services: Record<string, unknown>;
    };
    expect(edge.services["kamal-proxy"]).toBeDefined();
  });

  it("points Caddy, nginx (with per-site upstream zone + resolve), and OpenLiteSpeed at <app>-kamal-proxy:80", () => {
    const ctx = testContext();
    const caddyPlan = testPlan({ domain: "shop.example.com", www: false });
    expect(edgeAppUpstream("caddy", "shop")).toBe("shop-kamal-proxy:80");
    expect(edgeAppUpstream("nginx", "shop")).toBe("shop-kamal-proxy");
    expect(edgeAppUpstream("openlitespeed", "shop")).toBe("shop-kamal-proxy");

    const caddy = renderCaddyfile(caddyPlan, ctx).content;
    expect(caddy).toContain(`reverse_proxy ${appProxyUpstream("shop")}`);
    expect(caddy).not.toContain("reverse_proxy kamal-proxy:80");

    const nginxPlan = DeployPlanSchema.parse({
      ...caddyPlan,
      target: { ...caddyPlan.target, edge: "nginx" },
    });
    const nginxEdge = renderEdgeCompose(nginxPlan).content;
    expect(nginxEdge).toContain("resolver 127.0.0.11 valid=10s ipv6=off;");
    expect(nginxEdge).toContain("upstream kamal-proxy {");
    const nginxSiteFile = renderEdgeSite(nginxPlan, ctx).find((f) =>
      f.path.endsWith("/shop.conf"),
    )?.content;
    expect(nginxSiteFile).toContain("upstream shop-kamal-proxy {");
    expect(nginxSiteFile).toContain("zone shop-kamal-proxy 64k;");
    expect(nginxSiteFile).toContain("server shop-kamal-proxy:80 resolve max_fails=0;");
    expect(nginxSiteFile).toContain("proxy_pass http://shop-kamal-proxy;");

    const olsPlan = DeployPlanSchema.parse({
      ...caddyPlan,
      target: { ...caddyPlan.target, edge: "openlitespeed" },
    });
    const olsSiteFile = renderEdgeSite(olsPlan, ctx).find((f) =>
      f.path.endsWith("/shop.vhconf"),
    )?.content;
    expect(olsSiteFile).toContain("extprocessor shop-kamal-proxy {");
    expect(olsSiteFile).toContain("handler                 shop-kamal-proxy");
    expect(olsSiteFile).toContain("address                 shop-kamal-proxy:80");
    expect(olsSiteFile).toContain(
      "websocket / {\n  address                 shop-kamal-proxy:80\n}",
    );

    const check = edgeCheckStep(olsPlan, { originTls: false, additions: false }).join("\n");
    expect(check).toContain("127.0.0.1 shop-kamal-proxy kamal-proxy");
  });

  it("orders rolling deploy switch so per-app proxy deploys before install_edge and legacy shared route is removed last", () => {
    const plan = testPlan({ domain: "shop.example.com", www: false });
    const script = switchCommands(plan, [], { originTls: false, additions: false }).join("\n");

    const startProxy = script.indexOf(`docker compose up -d --no-deps ${APP_KAMAL_PROXY_SERVICE}`);
    const deployPerApp = script.indexOf(
      `docker compose exec -T ${APP_KAMAL_PROXY_SERVICE} kamal-proxy deploy shop --target "\${name#/}:3000"`,
    );
    const markRolling = script.indexOf("_switch_mode=rolling", deployPerApp);
    const callInstallEdge = script.indexOf("install_edge\n", markRolling);
    const removeLegacy = script.indexOf(
      "edge exec -T kamal-proxy kamal-proxy remove shop < /dev/null > /dev/null 2>&1 || true",
    );

    expect(startProxy).toBeGreaterThan(-1);
    expect(deployPerApp).toBeGreaterThan(startProxy);
    expect(markRolling).toBeGreaterThan(deployPerApp);
    expect(callInstallEdge).toBeGreaterThan(markRolling);
    expect(removeLegacy).toBeGreaterThan(callInstallEdge);

    // On rolling install_edge failure, per-app route is restored only when _switch_mode=rolling.
    expect(script).toContain('if [ "${_switch_mode:-}" = rolling ]; then');
    expect(script).toContain('  if [ -n "${old:-}" ]; then');
    expect(script).not.toContain("opscrew-app-");
  });

  it("installs the edge BEFORE holding or replacing the container on recreate, pauses both proxies, and uses per-app proxy on rollback", () => {
    const base = testPlan({ domain: "shop.example.com", www: false });
    const plan = DeployPlanSchema.parse({
      ...base,
      deploy: { ...base.deploy, strategy: "recreate" },
    });
    const switchScript = switchCommands(plan, [], { originTls: false, additions: false }).join(
      "\n",
    );
    const startProxy = switchScript.indexOf(
      `docker compose up -d --no-deps ${APP_KAMAL_PROXY_SERVICE}`,
      switchScript.indexOf("recreate") > -1 ? 0 : 0,
    );
    const switchTail = switchScript.slice(
      switchScript.lastIndexOf(`docker compose up -d --no-deps ${APP_KAMAL_PROXY_SERVICE}`),
    );
    const callInstallEdge = switchTail.indexOf("\ninstall_edge\n");
    const pausePerApp = switchTail.indexOf(
      `docker compose exec -T ${APP_KAMAL_PROXY_SERVICE} kamal-proxy pause shop`,
    );
    const recreateApp = switchTail.indexOf("docker compose up -d --no-deps --remove-orphans app");
    expect(startProxy).toBeGreaterThan(-1);
    expect(callInstallEdge).toBeGreaterThan(-1);
    expect(pausePerApp).toBeGreaterThan(callInstallEdge);
    expect(recreateApp).toBeGreaterThan(pausePerApp);
    expect(switchScript).toContain("edge exec -T kamal-proxy kamal-proxy pause shop");

    const rollback = rollbackCommands(plan).join("\n");
    expect(rollback).toContain(`docker compose up -d --no-deps ${APP_KAMAL_PROXY_SERVICE}`);
    expect(rollback).toContain(
      `docker compose exec -T ${APP_KAMAL_PROXY_SERVICE} kamal-proxy deploy shop`,
    );
  });

  it("removes preview Caddy site and reloads Caddy before cleaning legacy shared route and tearing down preview project", () => {
    const script = previewScript();
    const removeFn = script.slice(script.indexOf("remove() {"));
    const rmSite = removeFn.indexOf('rm -f "$EDGE_DIR/sites/$NAME.caddy"');
    const reloadCaddy = removeFn.indexOf("caddy reload");
    const removeLegacy = removeFn.indexOf('edge exec -T kamal-proxy kamal-proxy remove "$NAME"');
    const rmContainers = removeFn.indexOf("docker rm -f $ids");

    expect(rmSite).toBeGreaterThan(-1);
    expect(reloadCaddy).toBeGreaterThan(rmSite);
    expect(removeLegacy).toBeGreaterThan(reloadCaddy);
    expect(rmContainers).toBeGreaterThan(removeLegacy);
  });
});
