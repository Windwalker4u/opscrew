import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { evaluatePlanPolicies } from "./index";

// A provider whose server takes its key by name, as OVHcloud's does (`ssh_key_name`); built on
// Hetzner's definition so every other fact stays real.
vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const hetzner = actual.cloudProvider("hetzner");
  const named = {
    ...hetzner,
    id: "named-key",
    terraform: { ...hetzner.terraform, serverResourceType: "named_key_server" },
    texts: {
      ...hetzner.texts,
      secops: { ...hetzner.texts.secops, sshKeyAttribute: "ssh_key_name" },
    },
  };
  return { ...actual, CLOUD_PROVIDERS: [...actual.CLOUD_PROVIDERS, named] };
});

const plan = DeployPlanSchema.parse({
  schemaVersion: 1,
  createdAt: "2026-11-21T12:00:00.000Z",
  updatedAt: "2026-11-21T12:00:00.000Z",
  app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
  target: {
    provider: "hetzner",
    mode: "vps-compose",
    location: "nbg1",
    serverType: "cx23",
    backups: false,
  },
  services: [],
  externalServices: [],
  cost: {
    monthly: { amount: 7.59, currency: "EUR" },
    breakdown: [{ item: "server", monthly: { amount: 7.59, currency: "EUR" } }],
    pricesIncludeVat: false,
    source: "static",
    asOf: "2026-11-21T00:00:00.000Z",
  },
  codeChanges: [],
  infra: {},
  dns: { provider: "none", proxied: false },
  cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
  security: {},
});

/** A plan JSON with one `named_key_server` whose values are `values`. */
function planJson(values: Record<string, unknown>, afterUnknown: Record<string, unknown> = {}) {
  const address = "module.server.named_key_server.this";
  return {
    planned_values: {
      root_module: {
        child_modules: [
          {
            resources: [
              { address, mode: "managed", type: "named_key_server", name: "this", values },
            ],
          },
        ],
      },
    },
    resource_changes: [{ address, change: { after_unknown: afterUnknown } }],
  };
}

function sshCheck(json: unknown) {
  return evaluatePlanPolicies(json, plan).find((r) => r.policyId === "ssh-keys-set");
}

describe("the SSH key check reads the provider's own key attribute", () => {
  it("passes for a server that takes its key by name", () => {
    expect(sshCheck(planJson({ name: "shop", ssh_key_name: "shop-deploy" }))?.passed).toBe(true);
  });

  it("passes when the key's name is only known after apply", () => {
    expect(sshCheck(planJson({ name: "shop" }, { ssh_key_name: true }))?.passed).toBe(true);
  });

  it("still fails for such a server without a key", () => {
    for (const values of [{ name: "shop" }, { name: "shop", ssh_key_name: "" }]) {
      expect(sshCheck(planJson(values))?.passed).toBe(false);
    }
  });

  it("doesn't take `ssh_keys` for a provider that names another attribute", () => {
    expect(sshCheck(planJson({ name: "shop", ssh_keys: ["k"] }))?.passed).toBe(false);
  });
});
