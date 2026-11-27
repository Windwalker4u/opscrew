/**
 * End-to-end tests for in-place server firewall updates (issue #62):
 * - Reads `/etc/opscrew/firewall-networks.json` over SSH (falling back to the first-boot script in
 *   Terraform state when the record does not yet exist).
 * - Emits a SHA-256 hash-approved `server-firewall` host plan instead of refusing when networks
 *   differ on an existing `firewallCheck: "server"` server.
 * - Subsequent runs compare against `/etc/opscrew/firewall-networks.json` and stay green even while
 *   the first-boot script in Terraform state remains unchanged.
 * - Supports `--plan-only` (saves host plan with hash, changes nothing) and refusal (changes nothing).
 * - Rolls back both `/etc/opscrew/firewall.nft` and `/etc/opscrew/firewall-networks.json` when
 *   fresh SSH login verification fails.
 * - Fails closed when `/etc/opscrew/firewall-networks.json` is damaged JSON.
 * - Supports `module.server_previous` during `opscrew retarget`.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyHostPlan,
  hostPlanHash,
  SERVER_FIREWALL_NETWORKS_FILE,
  SERVER_FIREWALL_RULES,
  serverFirewallListing,
  serverFirewallNetworksJson,
  serverFirewallRulesFile,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  NARROWED_SSH,
  staleServerFirewallPlanJson,
} from "../provision/__fixtures__/stale-server-firewall";
import { planAndApply } from "../provision/plan-apply";
import {
  createdServerFacts,
  createTestPhaseDeps,
  FakeEngine,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { hostPlanFile, recordServerAddress } from "./index";

const WORLD = ["0.0.0.0/0", "::/0"];
const SERVER_IP = "203.0.113.42";

/**
 * Minimal in-memory `RemoteExec` emulating a Kamatera server (deploy user with docker privilege,
 * `/etc/opscrew/firewall.nft`, optional `/etc/opscrew/firewall-networks.json`, and dead-man timer)
 * without importing ssh-host's private test fixture.
 */
class FakeKamateraServer implements RemoteExec {
  readonly host = SERVER_IP;
  readonly files = new Map<string, string>();
  table: string;
  reloads = 0;
  readonly commands: string[] = [];
  private undo: (() => void) | undefined;

  constructor(initial: { ssh: string[]; web: string[]; wireguardPort?: number }) {
    this.files.set(SERVER_FIREWALL_RULES, serverFirewallRulesFile(initial));
    this.table = serverFirewallListing(initial);
  }

  async run(command: string, options?: { input?: string }) {
    const raw = options?.input ?? command;
    const header = /# opscrew-host: (\S+)/.exec(raw)?.[1] ?? command.trim();
    this.commands.push(header);
    if (header === "true") return { exitCode: 0, stdout: "", stderr: "" };
    if (header === "privilege") return { exitCode: 0, stdout: "docker\n", stderr: "" };

    const param = (key: string) => {
      const m = new RegExp(`^${key}='((?:[^']|'\\\\'')*)'$`, "m").exec(raw);
      return m?.[1]?.replaceAll("'\\''", "'");
    };

    if (header === "server-firewall.networks.read") {
      const content = this.files.get(SERVER_FIREWALL_NETWORKS_FILE);
      return {
        exitCode: 0,
        stdout: content === undefined ? "absent\n" : `present\n${content}`,
        stderr: "",
      };
    }

    if (header === "record.read") {
      return { exitCode: 0, stdout: this.files.get("/etc/opscrew/host.json") ?? "", stderr: "" };
    }
    if (header === "record.write") {
      this.files.set("/etc/opscrew/host.json", param("RECORD") ?? "");
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    if (header === "deadman.arm.server-firewall") {
      const prevRules = this.files.get(SERVER_FIREWALL_RULES);
      const prevNetworks = this.files.get(SERVER_FIREWALL_NETWORKS_FILE);
      const prevTable = this.table;
      this.undo = () => {
        if (prevRules === undefined) this.files.delete(SERVER_FIREWALL_RULES);
        else this.files.set(SERVER_FIREWALL_RULES, prevRules);
        if (prevNetworks === undefined) this.files.delete(SERVER_FIREWALL_NETWORKS_FILE);
        else this.files.set(SERVER_FIREWALL_NETWORKS_FILE, prevNetworks);
        this.table = prevTable;
        this.reloads += 1;
        this.undo = undefined;
      };
      return { exitCode: 0, stdout: "armed\n", stderr: "" };
    }
    if (header === "deadman.cancel.server-firewall") {
      this.undo = undefined;
      return { exitCode: 0, stdout: "cancelled\n", stderr: "" };
    }
    if (header === "deadman.trigger.server-firewall") {
      this.undo?.();
      return { exitCode: 0, stdout: "restored\n", stderr: "" };
    }

    if (header === "server-firewall.check" || header === "server-firewall.verify") {
      const wantedRules = Buffer.from(param("RULES_B64") ?? "", "base64").toString("utf8");
      const wantedNetworks = Buffer.from(param("NETWORKS_B64") ?? "", "base64").toString("utf8");
      const listing = param("LISTING") ?? "";
      const ok =
        this.files.get(SERVER_FIREWALL_RULES) === wantedRules &&
        this.files.get(SERVER_FIREWALL_NETWORKS_FILE) === wantedNetworks &&
        this.table === listing &&
        this.undo === undefined;
      if (header === "server-firewall.check") {
        return {
          exitCode: 0,
          stdout: `state=${ok ? "in-place" : "change"}\nprev.rules=${this.files.has(SERVER_FIREWALL_RULES) ? "present" : "absent"}\nprev.networks=${this.files.has(SERVER_FIREWALL_NETWORKS_FILE) ? "present" : "absent"}\n`,
          stderr: "",
        };
      }
      return ok
        ? { exitCode: 0, stdout: "", stderr: "" }
        : { exitCode: 5, stdout: "", stderr: "opscrew: firewall not in effect\n" };
    }

    if (header === "server-firewall.apply") {
      const rules = Buffer.from(param("RULES_B64") ?? "", "base64").toString("utf8");
      const networks = Buffer.from(param("NETWORKS_B64") ?? "", "base64").toString("utf8");
      this.files.set(SERVER_FIREWALL_RULES, rules);
      this.table = param("LISTING") ?? "";
      this.reloads += 1;
      this.files.set(SERVER_FIREWALL_NETWORKS_FILE, networks);
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

async function setup(
  options: {
    address?: string;
    answer?: ConstructorParameters<typeof ScriptedApprovalHandler>[0];
    verifyLogin?: () => Promise<boolean>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "opscrew-sf-"));
  const handler = new ScriptedApprovalHandler(options.answer ?? (() => true));
  const deps = await createTestPhaseDeps({ root, approvalHandler: handler });
  const base = testPlan({ backups: false });
  const deployPlan = DeployPlanSchema.parse({
    ...base,
    security: { ...base.security, sshAllowedCidrs: [NARROWED_SSH] },
  });
  await writeArtifact("plan", deps.paths.files.plan, deployPlan);
  await recordServerAddress(deps.paths, { ipv4: SERVER_IP });
  const server = new FakeKamateraServer({ ssh: WORLD, web: WORLD });
  const engine = new FakeEngine({
    changes: [],
    planJson: staleServerFirewallPlanJson(options.address),
  });
  const serverFirewall = {
    plan: deployPlan,
    remote: () => server,
    host: {
      inspect: async () => createdServerFacts(),
      apply: applyHostPlan,
    },
    ...(options.verifyLogin !== undefined ? { verifyLogin: options.verifyLogin } : {}),
    ...(options.address?.includes("server_previous") ? { previousHost: SERVER_IP } : {}),
  };
  return { root, deps, handler, deployPlan, server, engine, serverFirewall };
}

describe("in-place server firewall updates via planAndApply (issue #62)", () => {
  it("emits and applies a SHA-256 hash-approved host plan when networks differ, then stays green on re-run", async () => {
    const s = await setup();
    const first = await planAndApply(s.deps, {
      engine: s.engine,
      dir: join(s.root, s.deployPlan.infra.dir),
      env: {},
      deployPlan: s.deployPlan,
      files: [],
      serverFirewall: s.serverFirewall,
    });

    // Terraform had 0 changes, yet the server's firewall was updated through a hash-approved host plan!
    expect(first.applied).toBe(false);
    expect(first.serverFirewallPlans).toHaveLength(1);
    const outcome = first.serverFirewallPlans?.[0];
    if (outcome === undefined) throw new Error("expected server firewall outcome");
    expect(outcome.applied).toBe(true);
    expect(outcome.steps).toEqual(["server-firewall"]);
    expect(outcome.hash).toBe(hostPlanHash(outcome.plan));

    // Approval was requested as `host-apply` bound to the host plan's SHA-256 hash.
    expect(s.handler.requests).toHaveLength(1);
    expect(s.handler.requests[0]).toMatchObject({
      kind: "host-apply",
      planHash: outcome.hash,
      title: "Update the server's own firewall on server app",
    });

    // Both /etc/opscrew/firewall.nft and /etc/opscrew/firewall-networks.json were written and reloaded.
    const expected = { ssh: [NARROWED_SSH], web: WORLD };
    expect(s.server.files.get(SERVER_FIREWALL_RULES)).toBe(serverFirewallRulesFile(expected));
    expect(s.server.files.get(SERVER_FIREWALL_NETWORKS_FILE)).toBe(
      serverFirewallNetworksJson(expected),
    );
    expect(s.server.reloads).toBe(1);
    expect(s.server.commands).toContain("deadman.arm.server-firewall");
    expect(s.server.commands).toContain("deadman.cancel.server-firewall");

    // Second run: Terraform state's first-boot script is STILL stale (0.0.0.0/0 ::/0),
    // but SecOps reads /etc/opscrew/firewall-networks.json over SSH -> matches plan -> no host plan!
    const second = await planAndApply(s.deps, {
      engine: s.engine,
      dir: join(s.root, s.deployPlan.infra.dir),
      env: {},
      deployPlan: s.deployPlan,
      files: [],
      serverFirewall: s.serverFirewall,
    });
    expect(second.serverFirewallPlans).toBeUndefined();
    expect(s.handler.requests).toHaveLength(1);
    expect(s.server.reloads).toBe(1);
  });

  it("saves the host plan with its SHA-256 hash in --plan-only without changing the server", async () => {
    const s = await setup();
    const planned = await planAndApply(s.deps, {
      engine: s.engine,
      dir: join(s.root, s.deployPlan.infra.dir),
      env: {},
      deployPlan: s.deployPlan,
      files: [],
      planOnly: true,
      serverFirewall: s.serverFirewall,
    });

    expect(planned.serverFirewallPlans).toHaveLength(1);
    const outcome = planned.serverFirewallPlans?.[0];
    if (outcome === undefined) throw new Error("expected server firewall outcome");
    expect(outcome.applied).toBe(false);
    expect(s.handler.requests).toEqual([]);
    expect(s.server.reloads).toBe(0);
    expect(s.server.files.has(SERVER_FIREWALL_NETWORKS_FILE)).toBe(false);
    expect(hostPlanFile(s.deps.paths, outcome.hash)).toContain(`host-${outcome.hash}.json`);
  });

  it("restores both firewall.nft and firewall-networks.json via dead-man rollback when verifyLogin fails", async () => {
    const s = await setup({ verifyLogin: async () => false });
    const beforeRules = s.server.files.get(SERVER_FIREWALL_RULES);

    await expect(
      planAndApply(s.deps, {
        engine: s.engine,
        dir: join(s.root, s.deployPlan.infra.dir),
        env: {},
        deployPlan: s.deployPlan,
        files: [],
        serverFirewall: s.serverFirewall,
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: expect.stringContaining("put the previous server firewall settings back"),
    });

    expect(s.server.files.get(SERVER_FIREWALL_RULES)).toBe(beforeRules);
    expect(s.server.files.has(SERVER_FIREWALL_NETWORKS_FILE)).toBe(false);
    expect(s.server.commands).toContain("deadman.trigger.server-firewall");
  });

  it("fails closed when /etc/opscrew/firewall-networks.json on the server is damaged JSON", async () => {
    const s = await setup();
    s.server.files.set(SERVER_FIREWALL_NETWORKS_FILE, "{corrupt json");

    await expect(
      planAndApply(s.deps, {
        engine: s.engine,
        dir: join(s.root, s.deployPlan.infra.dir),
        env: {},
        deployPlan: s.deployPlan,
        files: [],
        serverFirewall: s.serverFirewall,
      }),
    ).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: expect.stringContaining("not valid JSON"),
    });
    expect(s.handler.requests).toEqual([]);
  });

  it("updates module.server_previous in place during retarget when reachable", async () => {
    const s = await setup({ address: "module.server_previous.kamatera_server.this" });
    const res = await planAndApply(s.deps, {
      engine: s.engine,
      dir: join(s.root, s.deployPlan.infra.dir),
      env: {},
      deployPlan: s.deployPlan,
      files: [],
      phase: "retarget",
      command: "opscrew retarget",
      serverFirewall: s.serverFirewall,
    });

    expect(res.serverFirewallPlans).toHaveLength(1);
    expect(res.serverFirewallPlans?.[0]?.applied).toBe(true);
    expect(s.handler.requests[0]?.title).toBe(
      "Update the server's own firewall on the previous server",
    );
    expect(s.server.files.get(SERVER_FIREWALL_NETWORKS_FILE)).toBe(
      serverFirewallNetworksJson({ ssh: [NARROWED_SSH], web: WORLD }),
    );
  });
});
