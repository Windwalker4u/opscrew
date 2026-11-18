/**
 * `opscrew init` for a server at home with its DNS on Cloudflare (plan 6.): the address updater's
 * own token is listed, with its recipe while it isn't set, and never shown.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared";
import { createTestPhaseDeps, LAN_IPV4, ownPlan } from "../testing";
import { type InitCheck, runInitChecks } from "./index";

const UPDATER = fakeSecret("cloudflare-token", "init-updater");

/** `shop.example.com` on a server at home, its DNS on Cloudflare unless `dns` is `none`. */
function homePlan(dns: "cloudflare" | "none" = "cloudflare"): DeployPlan {
  const base = ownPlan({ proxied: dns === "cloudflare" });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: true } },
    dns: { ...base.dns, provider: dns },
    security: { ...base.security, httpAllowedFrom: dns === "cloudflare" ? "cloudflare" : "any" },
    environment: { runner: "server" },
  });
}

async function updaterCheck(plan: DeployPlan, token?: string): Promise<InitCheck | undefined> {
  const deps = await createTestPhaseDeps({
    env: token === undefined ? {} : { OPSCREW_DNS_UPDATER_TOKEN: token },
  });
  await writeFile(join(deps.paths.root, ".gitignore"), ".opscrew/\n.terraform/\n");
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await recordOwnServer(deps.paths, { host: LAN_IPV4, port: 22, user: "root", agent: true });
  const checks = await runInitChecks(deps, {
    offline: true,
    services: { which: () => undefined, nodeVersion: "22.12.0" },
  });
  const found = checks.find((check) => check.id === "dns-updater");
  expect(JSON.stringify(checks)).not.toContain(UPDATER);
  return found;
}

describe("opscrew init for a server at home", () => {
  it("gives the address updater's token recipe while the token isn't set", async () => {
    const check = await updaterCheck(homePlan());
    expect(check).toMatchObject({
      title: "Cloudflare token for the address updater",
      status: "warn",
      message:
        "OPSCREW_DNS_UPDATER_TOKEN is not set. Your server's address updater needs a Cloudflare token of its own, limited to example.com's DNS, the first time `opscrew provision` sets it up.",
    });
    // The recipe of the guide and provision's refusal.
    for (const part of [
      "Make it at https://dash.cloudflare.com/profile/api-tokens → Create Token → Create Custom Token, with:",
      "  permission Zone → DNS → Edit,",
      "  zone resources Include → Specific zone → example.com.",
      "Then set OPSCREW_DNS_UPDATER_TOKEN to it and run `opscrew init` again.",
      "It stays only on your server, readable by root alone; OpsCrew keeps no copy.",
    ]) {
      expect(check?.fix).toContain(part);
    }
  });

  it("passes once it is set, never showing it", async () => {
    const check = await updaterCheck(homePlan(), UPDATER);
    expect(check).toMatchObject({
      status: "pass",
      message:
        "OPSCREW_DNS_UPDATER_TOKEN is set. `opscrew provision` checks that it is limited to example.com's DNS before it changes anything.",
    });
  });

  it("isn't listed with the DNS elsewhere or for a server away from home", async () => {
    expect(await updaterCheck(homePlan("none"))).toBeUndefined();
    expect(await updaterCheck(ownPlan())).toBeUndefined();
  });
});
