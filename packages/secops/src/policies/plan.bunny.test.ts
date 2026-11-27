import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testsslResults } from "../deep/testssl";
import { blockingPolicyFailures, evaluatePlanPolicies } from "./plan";

function bunnyPlan() {
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
    },
    dns: { provider: "bunny", domain: "shop.example.com", proxied: true },
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

describe("Bunny.net SecOps policies and TLS reporting (036 PR 2)", () => {
  it("passes safe Bunny Pull Zone plans and blocks SetRequestHeader in Terraform state as critical", () => {
    const safeJson = {
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: "module.edge",
              resources: [
                {
                  address: "module.edge.bunnynet_pullzone.this[0]",
                  type: "bunnynet_pullzone",
                  values: { cache_enabled: false, origin: [{ verify_ssl: true }] },
                },
                {
                  address: "module.edge.bunnynet_pullzone_edgerule.block_probes[0]",
                  type: "bunnynet_pullzone_edgerule",
                  values: { actions: [{ type: "BlockRequest" }] },
                },
              ],
            },
          ],
        },
      },
    };
    const safe = evaluatePlanPolicies(safeJson, bunnyPlan());
    expect(blockingPolicyFailures(safe)).toEqual([]);
    expect(safe.find((r) => r.policyId === "bunny-cache-disabled")?.passed).toBe(true);
    expect(safe.find((r) => r.policyId === "bunny-origin-ssl-verify")?.passed).toBe(true);

    const leakyJson = {
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: "module.edge",
              resources: [
                {
                  address: "module.edge.bunnynet_pullzone.this[0]",
                  type: "bunnynet_pullzone",
                  values: { cache_enabled: true, origin: [{ verify_ssl: false }] },
                },
                {
                  address: "module.edge.bunnynet_pullzone_edgerule.leak",
                  type: "bunnynet_pullzone_edgerule",
                  values: { actions: [{ type: "SetRequestHeader" }] },
                },
              ],
            },
          ],
        },
      },
    };
    const leaky = evaluatePlanPolicies(leakyJson, bunnyPlan());
    const blockers = blockingPolicyFailures(leaky);
    expect(blockers.map((r) => r.policyId)).toEqual([
      "bunny-origin-ssl-verify",
      "bunny-no-secret-header-in-state",
    ]);
    expect(blockers.find((r) => r.policyId === "bunny-no-secret-header-in-state")?.severity).toBe(
      "critical",
    );
  });

  it("uses Bunny.net's edge label and TLS hint in testsslResults", () => {
    const results = testsslResults(
      [{ id: "TLS1", severity: "HIGH", finding: "offered" }],
      "shop.example.com",
      true,
      "bunny",
    );
    expect(results[0]?.target).toBe("shop.example.com (Bunny.net's edge)");
    expect(results[0]?.remediation).toContain("Bunny.net");
  });
});
