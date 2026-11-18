import { findExecutable, OpsCrewError } from "@opscrew/core";
import { portainerWebhookHostname, sshHostname } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  change,
  type FinishTarget,
  type FinishWorld,
  finishWorld,
  TOKEN_ID,
  TOKEN_SECRET,
} from "./finish-removal.fakes";
import { adoptSite } from "./finish-site";
import { readAppProgress } from "./progress";
import { asScript } from "./record.fakes";
import { ZONE } from "./session.fakes";

const SCRIPT = "module.worker.cloudflare_workers_script.this";
const DOMAIN = "module.worker.cloudflare_workers_custom_domain.domain[0]";
const B_TUNNEL = "0f0e0d0c-0000-4000-8000-0000000000b1";
const B_WEBHOOK_TUNNEL = "0f0e0d0c-0000-4000-8000-0000000000b2";
const OUTPUTS = {
  deploy_service_token_client_id: TOKEN_ID,
  deploy_service_token_client_secret: TOKEN_SECRET,
};

/** The environment's plan with the zone that moves. */
function inZone(w: FinishWorld): DeployPlan {
  const { plan } = w.environment;
  return { ...plan, dns: { ...plan.dns, zone: ZONE } };
}

/**
 * What the switch made in B for an app behind Access: the Access application of `hostname` and
 * its record to B's tunnel `tunnel`. Returns their ids.
 */
function protectedInB(w: FinishWorld, hostname: string, tunnel: string) {
  w.fresh.accessApps.push({ id: "b-access-app", name: "OpsCrew SSH (shop)", domain: hostname });
  const record = w.cloudflare.addRecord(w.bZone, {
    type: "CNAME",
    name: hostname,
    content: `${tunnel}.cfargotunnel.com`,
    proxied: true,
    comment: "Managed by OpsCrew",
  });
  return { app: `accounts/${w.fresh.id}/b-access-app`, record: `${w.bZone.id}/${record.id}` };
}

/** The GitHub secrets the deploy reads, by name. */
function secrets(w: FinishWorld): Record<string, string> {
  return Object.fromEntries(w.github.secrets);
}

describe.skipIf(!findExecutable("git"))("adoptSite", () => {
  it("imports a site's custom domains, checks the plan with them and promotes its deploy token", async () => {
    const w = await finishWorld("site", { step: "prepared" });
    await w.seedShadow("main", [SCRIPT]);
    w.fresh.workerDomains.push({
      id: "b-domain",
      hostname: `site.${ZONE}`,
      service: "example-app",
      zone_id: w.bZone.id,
      zone_name: ZONE,
    });
    w.cloudflare.calls.length = 0;
    expect(await adoptSite(w.session, w.environment)).toBeUndefined();
    expect(w.engine.imports.map(({ address, id }) => [address, id])).toEqual([
      [DOMAIN, `${w.fresh.id}/b-domain`],
    ]);
    // The check plan runs with the committed custom_domains (true): no -var holds it back.
    const check = w.engine.planOptions.at(-1);
    expect(check?.vars).toEqual({
      cloudflare_zone_id: w.bZone.id,
      cloudflare_account_id: w.fresh.id,
    });
    expect(check?.env?.CLOUDFLARE_API_TOKEN).toBe(w.tokens.b);
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["github-secrets"]);
    expect(secrets(w)).toMatchObject({
      OPSCREW_CLOUDFLARE_ACCOUNT_ID: w.fresh.id,
    });
    expect(Object.keys(secrets(w)).filter((name) => name.endsWith("_NEW"))).toEqual([]);
    expect(w.aWrites()).toEqual([]);
    // Nothing in A is even read.
    expect(w.cloudflare.calls.filter((call) => call.accountId === w.old.id)).toEqual([]);
    expect(w.cloudflare.calls.length).toBeGreaterThan(0);

    // A run after it imports nothing again and asks nothing.
    expect(await adoptSite(w.session, w.environment)).toBeUndefined();
    expect(w.engine.imports).toHaveLength(1);
    expect(w.handler.requests).toHaveLength(1);
    expect(w.leaks()).toBe(false);
  });

  const behindAccess: [FinishTarget, (w: FinishWorld) => string, string, string, string][] = [
    [
      "own",
      (w) => sshHostname(inZone(w)) ?? "",
      B_TUNNEL,
      "module.tunnel",
      "OPSCREW_TUNNEL_SERVICE_TOKEN_ID",
    ],
    [
      "portainer",
      (w) => portainerWebhookHostname(inZone(w)) ?? "",
      B_WEBHOOK_TUNNEL,
      "module.portainer_tunnel",
      "OPSCREW_PORTAINER_ACCESS_CLIENT_ID",
    ],
  ];
  for (const [target, hostnameOf, tunnel, module, secret] of behindAccess) {
    it(`imports the Access application and its record the switch made, then promotes the service token (${target})`, async () => {
      const w = await finishWorld(target, { step: "prepared" });
      await w.seedShadow(
        "main",
        ["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this"],
        OUTPUTS,
      );
      const hostname = hostnameOf(w);
      expect(hostname).not.toBe("");
      const ids = protectedInB(w, hostname, tunnel);
      expect(await adoptSite(w.session, w.environment)).toBeUndefined();
      expect(w.engine.imports.map(({ address, id }) => [address, id])).toEqual([
        ["module.access.cloudflare_zero_trust_access_application.ssh[0]", ids.app],
        [`${module}.cloudflare_dns_record.route["${hostname}"]`, ids.record],
      ]);
      // The check plan holds nothing back: B's zone is active.
      expect(w.engine.planOptions.at(-1)?.vars).not.toHaveProperty("access_applications");
      // The empty check plan asks nothing: only the credentials are approved.
      expect(w.handler.requests.map((r) => r.kind)).toEqual(["github-secrets"]);
      expect(secrets(w)[secret]).toBe(TOKEN_ID);
      expect(Object.keys(secrets(w)).filter((name) => name.endsWith("_NEW"))).toEqual([]);
      expect(w.aWrites()).toEqual([]);
      expect(w.leaks()).toBe(false);
    });
  }

  it("imports nothing and runs no check without a main shadow state", async () => {
    const w = await finishWorld("site", { step: "prepared" });
    w.fresh.workerDomains.push({
      id: "b-domain",
      hostname: `site.${ZONE}`,
      service: "example-app",
      zone_id: w.bZone.id,
      zone_name: ZONE,
    });
    expect(await adoptSite(w.session, w.environment)).toBeUndefined();
    expect(w.engine.imports).toEqual([]);
    expect(w.engine.planOptions).toEqual([]);
    expect(w.engine.calls).not.toContain("init");
  });

  it("has nothing to adopt for a cloud server without Access", async () => {
    const w = await finishWorld("cloud", { step: "prepared" });
    expect(await adoptSite(w.session, w.environment)).toBeUndefined();
    expect(w.engine.imports).toEqual([]);
    expect(w.engine.planOptions).toEqual([]);
    expect(w.handler.requests).toEqual([]);
  });

  it("waits for the approval of an in-place update of the imported pieces (Cloudflare's defaults the module leaves unset), then promotes the credentials", async () => {
    const w = await finishWorld("own", { step: "prepared" });
    await w.seedShadow(
      "main",
      ["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this"],
      OUTPUTS,
    );
    protectedInB(w, sshHostname(inZone(w)) ?? "", B_TUNNEL);
    const app = "module.access.cloudflare_zero_trust_access_application.ssh[0]";
    w.engine.checkChanges = [change(app, "update")];
    const stop = await adoptSite(asScript(w), w.environment);
    const hash = stop?.pendingPlanHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stop?.next[0]).toContain(`--approve ${hash}`);
    expect(w.engine.applied).toEqual([]);
    expect(secrets(w).OPSCREW_TUNNEL_SERVICE_TOKEN_ID).toBeUndefined();

    // Interactively: the update shown and approved, applied, then the credentials promoted.
    expect(await adoptSite(w.session, w.environment)).toBeUndefined();
    expect(w.engine.applied.length).toBe(1);
    expect(w.handler.requests.at(-1)?.kind).toBe("github-secrets");
    expect(w.handler.requests).toHaveLength(2);
    expect(secrets(w).OPSCREW_TUNNEL_SERVICE_TOKEN_ID).toBe(TOKEN_ID);
    expect(w.leaks()).toBe(false);
  });

  it("stops before any approval and before the credentials when the check plan would create something", async () => {
    const w = await finishWorld("own", { step: "prepared" });
    await w.seedShadow(
      "main",
      ["module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this"],
      OUTPUTS,
    );
    const hostname = sshHostname(inZone(w)) ?? "";
    // The switch made the record, not the application: only the record is imported.
    const record = w.cloudflare.addRecord(w.bZone, {
      type: "CNAME",
      name: hostname,
      content: `${B_TUNNEL}.cfargotunnel.com`,
      proxied: true,
    });
    const app = "module.access.cloudflare_zero_trust_access_application.ssh[0]";
    w.engine.checkChanges = [change(app, "create")];
    for (const session of [w.session, asScript(w)]) {
      const error = await adoptSite(session, w.environment).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OpsCrewError);
      expect((error as OpsCrewError).message).toBe(
        [
          "Once the custom domains and Access pieces are imported, the plan of shop's Cloudflare pieces (prod) in the Cloudflare account New would do more than update Cloudflare pieces in place, so OpsCrew stopped. Nothing was changed.",
          `  create ${app}`,
        ].join("\n"),
      );
      expect((error as OpsCrewError).hint).toContain("opscrew drift");
    }
    expect(w.engine.imports.map(({ id }) => id)).toEqual([`${w.bZone.id}/${record.id}`]);
    expect(w.engine.applied).toEqual([]);
    expect(w.handler.requests).toEqual([]);
    expect((await readAppProgress(w.environment.paths)).pending).toBeUndefined();
    expect(secrets(w).OPSCREW_TUNNEL_SERVICE_TOKEN_ID).toBeUndefined();
    expect(w.leaks()).toBe(false);
  });
});
