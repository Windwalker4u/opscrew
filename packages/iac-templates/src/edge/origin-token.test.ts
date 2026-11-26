import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { renderEdgeSite } from "../runtime";
import {
  ORIGIN_TOKEN_HEADER,
  originTokenContainerPath,
  originTokenServerPath,
  originTokenSnippet,
} from "./origin-token";

const TOKEN_A = "a".repeat(64);
const TOKEN_B = "b".repeat(64);

function bunnyPlan(edge: "caddy" | "nginx" | "openlitespeed") {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "fsn1",
      serverType: "cx23",
      backups: true,
      edge,
    },
    dns: {
      provider: "bunny",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
      www: true,
    },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: { httpAllowedFrom: "edge", wafCustomRules: true },
    services: [],
    externalServices: [],
    codeChanges: [],
    cost: {
      monthly: { amount: 4.5, currency: "EUR" },
      breakdown: [{ item: "Hetzner cx23", monthly: { amount: 4.5, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-26T00:00:00.000Z",
    },
  });
}

describe("shared-header origin protection across Caddy, nginx, and OpenLiteSpeed (ADR 0038 D6)", () => {
  it("renders valid single-token and dual-token (rotation) snippets for all three proxies", () => {
    const caddySingle = originTokenSnippet("caddy", ORIGIN_TOKEN_HEADER, [TOKEN_A]);
    expect(caddySingle).toContain("not path /.well-known/acme-challenge/*");
    expect(caddySingle).toContain(`not header_regexp ${ORIGIN_TOKEN_HEADER} ^(${TOKEN_A})$`);
    expect(caddySingle).toContain("respond @bad_origin_token 403");

    const caddyDual = originTokenSnippet("caddy", ORIGIN_TOKEN_HEADER, [TOKEN_B, TOKEN_A]);
    expect(caddyDual).toContain(`^(${TOKEN_B}|${TOKEN_A})$`);

    const nginxSingle = originTokenSnippet("nginx", ORIGIN_TOKEN_HEADER, [TOKEN_A]);
    expect(nginxSingle).toContain(`if ($http_x_opscrew_origin_token !~ "^(${TOKEN_A})$")`);
    expect(nginxSingle).toContain("return 403;");

    const nginxDual = originTokenSnippet("nginx", ORIGIN_TOKEN_HEADER, [TOKEN_B, TOKEN_A]);
    expect(nginxDual).toContain(`"^(bbbb`);
    expect(nginxDual).toContain(`${TOKEN_B}|${TOKEN_A}`);

    const olsSingle = originTokenSnippet("openlitespeed", ORIGIN_TOKEN_HEADER, [TOKEN_A]);
    expect(olsSingle).toContain("RewriteCond %{REQUEST_URI} !^/\\.well-known/acme-challenge/");
    expect(olsSingle).toContain(`RewriteCond %{HTTP:${ORIGIN_TOKEN_HEADER}} !^(${TOKEN_A})$`);
    expect(olsSingle).toContain("RewriteRule ^ - [F]");

    const olsDual = originTokenSnippet("openlitespeed", ORIGIN_TOKEN_HEADER, [TOKEN_B, TOKEN_A]);
    expect(olsDual).toContain(`!^(${TOKEN_B}|${TOKEN_A})$`);
  });

  it("refuses malformed tokens or headers to prevent config injection", () => {
    expect(() => originTokenSnippet("caddy", ORIGIN_TOKEN_HEADER, ["not-hex"])).toThrow(/64/);
    expect(() => originTokenSnippet("nginx", ORIGIN_TOKEN_HEADER, [])).toThrow(/1 or 2/);
    expect(() =>
      originTokenSnippet("caddy", ORIGIN_TOKEN_HEADER, [TOKEN_A, TOKEN_B, "c".repeat(64)]),
    ).toThrow(/1 or 2/);
    expect(() => originTokenSnippet("nginx", "Bad Header;", [TOKEN_A])).toThrow(/header/i);
  });

  it("Caddy site imports the 0600 token file before reverse_proxy, strips the secret, and forwards X-Real-IP only after the gate", () => {
    const [site] = renderEdgeSite(bunnyPlan("caddy"), {
      cloudflareRanges: ["173.245.48.0/20"],
    });
    const content = site?.content ?? "";
    const tokenFile = originTokenContainerPath("caddy", "shop");
    expect(tokenFile).toBe("/etc/caddy/tls/shop/origin-token.caddy");
    expect(originTokenServerPath("caddy", "shop")).toBe("/srv/edge/tls/shop/origin-token.caddy");
    expect(content).toContain(`\timport ${tokenFile}`);
    expect(content.indexOf(`import ${tokenFile}`)).toBeLessThan(content.indexOf("reverse_proxy "));
    expect(content).toContain(`\t\theader_up -${ORIGIN_TOKEN_HEADER}`);
    expect(content).toContain("\t\theader_up X-Forwarded-For {http.request.header.X-Real-IP}");
    expect(content).not.toContain("{client_ip}");
  });

  it("nginx site includes the 0600 token file before proxy_pass without set_real_ip_from, strips the secret, and forwards $http_x_real_ip", () => {
    const [site] = renderEdgeSite(bunnyPlan("nginx"), {
      cloudflareRanges: ["173.245.48.0/20"],
    });
    const content = site?.content ?? "";
    const tokenFile = originTokenContainerPath("nginx", "shop");
    expect(tokenFile).toBe("/etc/nginx/tls/shop/origin-token.conf");
    expect(content).toContain(`\tinclude ${tokenFile};`);
    expect(content.indexOf(`include ${tokenFile};`)).toBeLessThan(content.indexOf("proxy_pass "));
    expect(content).not.toContain("set_real_ip_from");
    expect(content).toContain(`\tproxy_set_header ${ORIGIN_TOKEN_HEADER} "";`);
    expect(content).toContain("\tproxy_set_header X-Forwarded-For $http_x_real_ip;");
  });

  it("OpenLiteSpeed site loads the 0600 rewriteFile in top-level rewrite and strips the secret header in context /", () => {
    const files = renderEdgeSite(bunnyPlan("openlitespeed"), {
      cloudflareRanges: ["173.245.48.0/20"],
    });
    const vhconf = files.find((f) => f.path.endsWith("shop.vhconf"))?.content ?? "";
    const tokenFile = originTokenContainerPath("openlitespeed", "shop");
    expect(tokenFile).toBe("/etc/opscrew/tls/shop/origin-token.conf");
    expect(vhconf).toContain(`rewriteFile ${tokenFile}`);
    expect(vhconf).toContain(`RequestHeader unset ${ORIGIN_TOKEN_HEADER}`);
  });
});
