/**
 * The address updater's names and words in three packages: the runbook (iac-templates, which
 * doesn't depend on ssh-host) and agents quote ssh-host's, where the updater is written.
 */
import {
  DNS_UPDATER_CONFIG_DIR,
  DNS_UPDATER_STATE_DIR,
  DNS_UPDATER_TOKEN_REACH,
  dnsUpdaterTimer,
} from "@opscrew/connector-ssh-host";
import { renderRunbook } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ownPlan } from "../testing";
import { updaterTokenReach } from "./texts";

describe("the address updater's names and words", () => {
  it("the host plan's words on the token's reach are updaterTokenReach's for its zone", () => {
    expect(updaterTokenReach("its zone")).toBe(DNS_UPDATER_TOKEN_REACH);
  });

  it("the runbook names the updater's timer, config and state as ssh-host writes them", () => {
    const base = ownPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      target: { ...base.target, home: { ipv4: true } },
      environment: { runner: "server" },
    });
    const text = renderRunbook(plan, {
      opscrewVersion: "0.0.0",
      github: { owner: "acme", repo: "shop" },
      deploySshPublicKey: "",
      projectId: "p",
    }).content;
    expect(text).toContain(`\`${dnsUpdaterTimer("shop")}\``);
    expect(text).toContain(`\`${DNS_UPDATER_CONFIG_DIR}/shop.json\``);
    expect(text).toContain(`\`${DNS_UPDATER_CONFIG_DIR}/shop.token\``);
    expect(text).toContain(`\`${DNS_UPDATER_STATE_DIR}/shop/\``);
  });
});
