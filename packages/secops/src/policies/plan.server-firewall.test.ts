// biome-ignore-all lint/suspicious/noTemplateCurlyInString: templatefile's placeholders, not JavaScript templates.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it, vi } from "vitest";
import { blockingPolicyFailures, evaluatePlanPolicies } from "./index";

// A provider with no cloud firewall whose server's own firewall is the first step of its
// startup-script first boot, as Kamatera's is; built on Hetzner's definition so every other fact
// stays real, and alone in the registry so no other provider's checks run.
vi.mock("@opscrew/providers", async (importActual) => {
  const actual = await importActual<typeof import("@opscrew/providers")>();
  const hetzner = actual.cloudProvider("hetzner");
  const own = {
    ...hetzner,
    offering: { ...hetzner.offering, deleteProtection: false },
    terraform: { ...hetzner.terraform, serverResourceType: "own_server", firewallResourceType: "" },
    texts: {
      ...hetzner.texts,
      secops: {
        ...hetzner.texts.secops,
        firewallCheck: "server",
        rules: () => [],
        attached: () => false,
        attachedText: "Cloud firewall: none; server firewall: on.",
        unattachedText: "Cloud firewall: none; server firewall: off.",
      },
    },
  };
  return { ...actual, CLOUD_PROVIDERS: [own] };
});

/** OpsCrew's shared first-boot templates, as iac-templates adds them to the server's module. */
const shared = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../iac-templates/shared/${name}`, import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");

const WORLD = ["0.0.0.0/0", "::/0"];
const CLOUDFLARE = ["173.245.48.0/20", "2400:cb00::/32"];

/** The networks the module passes the server firewall's step. */
interface Networks {
  ssh?: string[];
  web?: string[];
  wireguard?: number;
}

/**
 * The startup script the module renders with `templatefile`: the wrapper with the server
 * firewall's step first, or without it (`firewall: false`), as a provider with a cloud firewall
 * would have it.
 */
function startupScript({ ssh = WORLD, web = WORLD, wireguard }: Networks, firewall = true) {
  const step = shared("server-firewall.sh.tftpl")
    .replace("${ssh_sources}", ssh.join(" "))
    .replace("${web_sources}", web.join(" "))
    .replace("${wireguard_port}", wireguard === undefined ? "" : String(wireguard));
  return shared("first-boot.sh.tftpl")
    .replace("${server_firewall}", firewall ? step : "")
    .replace("${cloud_config_b64}", Buffer.from("#cloud-config\n").toString("base64"));
}

/**
 * A plan's JSON with the app's server, its startup script `script` (none: no script at all), and
 * what the plan does to it (`actions`: created by default).
 */
function planJson(script?: string, actions: string[] = ["create"]) {
  const address = "module.server.own_server.this";
  const values = {
    name: "shop",
    ssh_keys: ["deploy"],
    ...(script === undefined ? {} : { startup_script: script }),
  };
  return {
    planned_values: {
      root_module: {
        child_modules: [
          {
            address: "module.server",
            resources: [{ address, mode: "managed", type: "own_server", name: "this", values }],
          },
        ],
      },
    },
    resource_changes: [{ address, change: { actions, after_unknown: { id: true } } }],
  };
}

/** A deploy plan: SSH from `sshAllowedCidrs`, proxied through Cloudflare or not, a network. */
function deployPlan(o: { sshAllowedCidrs?: string[]; proxied?: boolean; wireguard?: number } = {}) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-27T12:00:00.000Z",
    updatedAt: "2026-11-27T12:00:00.000Z",
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
      asOf: "2026-11-27T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: {
      provider: "cloudflare",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: o.proxied ?? false,
    },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: o.sshAllowedCidrs === undefined ? {} : { sshAllowedCidrs: o.sshAllowedCidrs },
    ...(o.wireguard === undefined
      ? {}
      : {
          network: {
            range: "10.200.4.0/24",
            members: [
              {
                name: "app",
                address: "10.200.4.1",
                port: o.wireguard,
                publicKey: randomBytes(32).toString("base64"),
              },
            ],
          },
        }),
  });
}

function result(results: ReturnType<typeof evaluatePlanPolicies>, policyId: string) {
  return results.find((r) => r.policyId === policyId);
}

describe("a provider whose firewall is the server's own", () => {
  it("passes a server whose first boot starts with OpsCrew's firewall and the plan's networks", () => {
    const plan = deployPlan({ sshAllowedCidrs: ["203.0.113.7/32"], wireguard: 51820 });
    const results = evaluatePlanPolicies(
      planJson(startupScript({ ssh: ["203.0.113.7/32"], wireguard: 51820 })),
      plan,
    );
    expect(result(results, "firewall-attached")).toMatchObject({
      passed: true,
      severity: "high",
      message: "Cloud firewall: none; server firewall: on.",
      resource: "module.server.own_server.this",
    });
    expect(result(results, "ssh-not-public")?.passed).toBe(true);
    expect(result(results, "no-open-admin-ports")).toMatchObject({ passed: true });
    expect(result(results, "no-open-admin-ports")?.message).toContain("UDP 51820");
    expect(blockingPolicyFailures(results)).toEqual([]);
    // No cloud firewall is looked for: no finding says the plan creates a server without one.
    expect(results.filter((r) => r.policyId === "firewall-attached")).toHaveLength(1);
  });

  it("fails a server whose first boot doesn't set up the firewall, or that has no first boot", () => {
    for (const json of [planJson(startupScript({}, false)), planJson()]) {
      const results = evaluatePlanPolicies(json, deployPlan());
      expect(result(results, "firewall-attached")).toMatchObject({
        passed: false,
        message: "Cloud firewall: none; server firewall: off.",
      });
      expect(blockingPolicyFailures(results).map((r) => r.policyId)).toEqual(["firewall-attached"]);
      // Nothing to read the ports from.
      expect(result(results, "no-open-admin-ports")).toBeUndefined();
    }
  });

  it("fails a firewall step whose networks can't be read", () => {
    const script = startupScript({}).replace(/^web_sources=.*\n/m, "");
    const results = evaluatePlanPolicies(planJson(script), deployPlan());
    expect(result(results, "firewall-attached")?.passed).toBe(false);
  });

  it("holds SSH to the plan's networks", () => {
    const results = evaluatePlanPolicies(
      planJson(startupScript({ ssh: WORLD })),
      deployPlan({ sshAllowedCidrs: ["203.0.113.7/32"] }),
    );
    expect(result(results, "ssh-not-public")).toMatchObject({ passed: false, severity: "high" });
    // Public SSH closed: no SSH rule at all.
    const closed = evaluatePlanPolicies(
      planJson(startupScript({ ssh: [] })),
      deployPlan({ sshAllowedCidrs: [] }),
    );
    expect(result(closed, "ssh-not-public")?.passed).toBe(true);
  });

  it("holds the web ports to Cloudflare's ranges when the site is proxied", () => {
    const proxied = deployPlan({ proxied: true });
    const open = evaluatePlanPolicies(planJson(startupScript({ web: WORLD })), proxied);
    expect(result(open, "origin-cloudflare-only")).toMatchObject({ passed: false });
    expect(result(open, "origin-cloudflare-only")?.message).toContain("tcp/80, tcp/443, udp/443");
    const held = evaluatePlanPolicies(planJson(startupScript({ web: CLOUDFLARE })), proxied);
    expect(result(held, "origin-cloudflare-only")?.passed).toBe(true);
    expect(blockingPolicyFailures(held)).toEqual([]);
  });

  it("opens WireGuard's port only where the plan uses it", () => {
    const results = evaluatePlanPolicies(
      planJson(startupScript({ wireguard: 51820 })),
      deployPlan(),
    );
    expect(result(results, "no-open-admin-ports")).toMatchObject({ passed: false });
    expect(result(results, "no-open-admin-ports")?.message).toContain("udp/51820");
  });

  // The module ignores changes to the startup script, so a server that exists keeps the script it
  // was created with: its planned script is the stored one, not the plan's.
  it("reads no rules from the stored script of a server that already exists", () => {
    const narrowed = deployPlan({ sshAllowedCidrs: ["203.0.113.7/32"], proxied: true });
    const stored = startupScript({ ssh: WORLD, web: WORLD, wireguard: 51820 });
    for (const actions of [["no-op"], ["update"]]) {
      const results = evaluatePlanPolicies(planJson(stored, actions), narrowed);
      expect(blockingPolicyFailures(results), actions[0]).toEqual([]);
      const attached = result(results, "firewall-attached");
      expect(attached).toMatchObject({ passed: true, resource: "module.server.own_server.this" });
      expect(attached?.message).toContain("Cloud firewall: none; server firewall: on.");
      expect(attached?.message).toContain("`opscrew secure`");
      for (const policy of ["ssh-not-public", "no-open-admin-ports", "origin-cloudflare-only"]) {
        expect(result(results, policy), policy).toBeUndefined();
      }
    }
  });

  it("still fails a server that exists without the firewall's step", () => {
    for (const json of [
      planJson(startupScript({}, false), ["no-op"]),
      planJson(undefined, ["update"]),
    ]) {
      const results = evaluatePlanPolicies(json, deployPlan());
      expect(result(results, "firewall-attached")).toMatchObject({
        passed: false,
        message: "Cloud firewall: none; server firewall: off.",
      });
    }
  });

  it("checks the script of a server the plan creates, or replaces, as the plan's", () => {
    const narrowed = deployPlan({ sshAllowedCidrs: ["203.0.113.7/32"] });
    for (const actions of [["create"], ["delete", "create"], ["create", "delete"]]) {
      const results = evaluatePlanPolicies(
        planJson(startupScript({ ssh: WORLD }), actions),
        narrowed,
      );
      expect(result(results, "ssh-not-public"), actions.join()).toMatchObject({ passed: false });
      expect(blockingPolicyFailures(results).map((r) => r.policyId)).toEqual(["ssh-not-public"]);
    }
  });
});
