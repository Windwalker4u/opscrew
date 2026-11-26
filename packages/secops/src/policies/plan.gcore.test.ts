import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testsslResults } from "../deep/testssl";
import { blockingPolicyFailures, evaluatePlanPolicies } from "./plan";

function gcorePlan() {
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
    dns: { provider: "gcore", domain: "shop.example.com", proxied: true },
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

describe("Gcore SecOps policies and TLS reporting (036 PR 3)", () => {
  it("passes safe Gcore CDN plans and blocks static_request_headers in Terraform state as critical", () => {
    const safeJson = {
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: "module.edge",
              resources: [
                {
                  address: "module.edge.gcore_cdn_resource.this[0]",
                  type: "gcore_cdn_resource",
                  values: {
                    origin_protocol: "HTTPS",
                    options: [{ edge_cache_settings: [{ enabled: false }] }],
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const safe = evaluatePlanPolicies(safeJson, gcorePlan());
    expect(blockingPolicyFailures(safe)).toEqual([]);
    expect(safe.find((r) => r.policyId === "gcore-cache-disabled")?.passed).toBe(true);
    expect(safe.find((r) => r.policyId === "gcore-origin-https")?.passed).toBe(true);

    const leakyJson = {
      planned_values: {
        root_module: {
          child_modules: [
            {
              address: "module.edge",
              resources: [
                {
                  address: "module.edge.gcore_cdn_resource.this[0]",
                  type: "gcore_cdn_resource",
                  values: {
                    origin_protocol: "HTTP",
                    options: [
                      {
                        edge_cache_settings: [{ enabled: true }],
                        static_request_headers: [{ enabled: true }],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const leaky = evaluatePlanPolicies(leakyJson, gcorePlan());
    const blockers = blockingPolicyFailures(leaky);
    expect(blockers.map((r) => r.policyId)).toEqual([
      "gcore-origin-https",
      "gcore-no-secret-header-in-state",
    ]);
    expect(blockers.find((r) => r.policyId === "gcore-no-secret-header-in-state")?.severity).toBe(
      "critical",
    );
  });

  it("uses Gcore's edge label and TLS hint in testsslResults", () => {
    const results = testsslResults(
      [{ id: "TLS1", severity: "HIGH", finding: "offered" }],
      "shop.example.com",
      true,
      "gcore",
    );
    expect(results[0]?.target).toBe("shop.example.com (Gcore's edge)");
    expect(results[0]?.remediation).toContain("Gcore");
  });
});
