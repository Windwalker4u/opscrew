/**
 * In-place updates of a server's own firewall (`firewallCheck: "server"`, issue #62; Kamatera):
 * - Reads `/etc/opscrew/firewall-networks.json` over SSH (as root/docker) for existing servers
 *   before `evaluatePlanPolicies`, falling back to the first-boot script in Terraform state only
 *   when the record does not yet exist on the server.
 * - When the planned networks differ from the server's current networks, builds a SHA-256
 *   hash-approved `connector-ssh-host` host plan (`planServerFirewall`) that rewrites
 *   `/etc/opscrew/firewall.nft`, reloads `opscrew-firewall.service`, and atomically writes
 *   `/etc/opscrew/firewall-networks.json` (0600, root-owned) under the dead-man rollback.
 */
import {
  applyHostPlan,
  type HostFacts,
  type HostPrivilege,
  inspectHost,
  planServerFirewall,
  probePrivilege,
  readServerFirewallNetworks,
  SERVER_FIREWALL_NETWORKS_FILE,
  type ServerFirewallNetworksRecord,
} from "@opscrew/connector-ssh-host";
import type { PhaseName, RemoteExec } from "@opscrew/contracts";
import { exists, OpsCrewError } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import {
  existingOwnFirewallServers,
  type ServerFirewallNetworks,
  serverFirewallUpdates,
} from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { approveAndApplyHostPlan, type HostAdapterApi, type HostPlanOutcome } from "./host-plan";
import { SshRemoteExec } from "./remote";
import { serverRemote } from "./server-address";
import { readServerAddresses } from "./server-record";

/** Host adapter operations needed for in-place server firewall updates (fakes in tests). */
export interface ServerFirewallHostApi {
  inspect(remote: RemoteExec, options: { rootImage?: string }): Promise<HostFacts>;
  apply: HostAdapterApi["apply"];
  readNetworks?: (
    remote: RemoteExec,
    privilege: HostPrivilege,
    rootImage?: string,
  ) => Promise<ServerFirewallNetworksRecord | undefined>;
}

/** Collaborators for reading and updating a server's own firewall in place during `planAndApply`. */
export interface ServerFirewallRun {
  /** Plan used to reach the servers (e.g. `beforeApply(plan)`). */
  plan: DeployPlan;
  /** Optional SSH shell override by host address (tests). */
  remote?: ((host: string) => RemoteExec) | undefined;
  /** Optional host adapter override (tests). */
  host?: ServerFirewallHostApi | undefined;
  /** Optional host IP of `module.server_previous` during `opscrew retarget`. */
  previousHost?: string | undefined;
  /** Optional fresh-login check override after updating the firewall (tests). */
  verifyLogin?: ((server: string) => Promise<boolean>) | undefined;
}

/** Result of probing existing `firewallCheck: "server"` servers before policy evaluation. */
export interface ExistingServerFirewallsRead {
  /** Applied networks from `/etc/opscrew/firewall-networks.json`, keyed by Terraform address. */
  networks: Record<string, ServerFirewallNetworks>;
  /** Raw parsed records from `/etc/opscrew/firewall-networks.json`, keyed by Terraform address. */
  records: Record<string, ServerFirewallNetworksRecord>;
  /** Terraform addresses of existing servers reachable with root/sudo/docker privilege. */
  reachable: Set<string>;
}

interface ResolvedServer {
  remote: RemoteExec;
  privilege: HostPrivilege;
  verifyLogin: () => Promise<boolean>;
}

function isRootPrivilege(privilege: HostFacts["privilege"]): privilege is HostPrivilege {
  return privilege === "root" || privilege === "sudo" || privilege === "docker";
}

function recordToSecops(record: ServerFirewallNetworksRecord): ServerFirewallNetworks {
  return {
    ssh: [...record.ssh],
    web: [...record.web],
    wireguard: record.wireguardPort === undefined ? "" : String(record.wireguardPort),
  };
}

function secopsToParams(networks: ServerFirewallNetworks) {
  const wireguardPort =
    networks.wireguard === "" ? undefined : Number.parseInt(networks.wireguard, 10);
  return {
    ssh: [...networks.ssh],
    web: [...networks.web],
    ...(wireguardPort !== undefined && Number.isInteger(wireguardPort) ? { wireguardPort } : {}),
  };
}

/** Resolves an SSH shell + fresh-login verifier for `server` (`app`, `<extra>`, or `previous`). */
async function resolveServerShell(
  deps: PhaseDeps,
  run: ServerFirewallRun,
  server: string,
): Promise<{ remote: RemoteExec; verifyLogin: () => Promise<boolean> } | undefined> {
  const addresses = await readServerAddresses(deps.paths);
  const customVerify = run.verifyLogin;
  const customRemote = run.remote;
  if (server === "previous") {
    const host = run.previousHost ?? addresses.retarget?.from?.ipv4 ?? addresses.deployment?.ipv4;
    if (host === undefined) return undefined;
    if (customRemote !== undefined) {
      const remote = customRemote(host);
      return {
        remote,
        verifyLogin:
          customVerify !== undefined
            ? () => customVerify(server)
            : async () =>
                (
                  await customRemote(host)
                    .run("true", { timeoutMs: 30_000 })
                    .catch(() => undefined)
                )?.exitCode === 0,
      };
    }
    if (!(await exists(deps.paths.files.deployKey))) return undefined;
    const make = (fresh: boolean) =>
      new SshRemoteExec({
        host,
        user: "deploy",
        keyFile: deps.paths.files.deployKey,
        knownHostsFile: deps.paths.files.knownHosts,
        runner: deps.runner,
        ...(fresh ? { fresh: true } : {}),
      });
    return {
      remote: make(false),
      verifyLogin:
        customVerify !== undefined
          ? () => customVerify(server)
          : async () =>
              (
                await make(true)
                  .run("true", { timeoutMs: 30_000 })
                  .catch(() => undefined)
              )?.exitCode === 0,
    };
  }

  const host =
    server === APP_SERVER ? addresses.deployment?.ipv4 : addresses.servers?.[server]?.ipv4;
  if (customRemote !== undefined) {
    if (host === undefined) return undefined;
    const remote = customRemote(host);
    return {
      remote,
      verifyLogin:
        customVerify !== undefined
          ? () => customVerify(server)
          : async () =>
              (
                await customRemote(host)
                  .run("true", { timeoutMs: 30_000 })
                  .catch(() => undefined)
              )?.exitCode === 0,
    };
  }
  if (host === undefined || !(await exists(deps.paths.files.deployKey))) return undefined;
  let remote: RemoteExec;
  try {
    remote = await serverRemote(deps, run.plan, server);
  } catch {
    return undefined;
  }
  return {
    remote,
    verifyLogin:
      customVerify !== undefined
        ? () => customVerify(server)
        : async () =>
            (
              await serverRemote(deps, run.plan, server, { fresh: true })
                .then((fresh) => fresh.run("true", { timeoutMs: 30_000 }))
                .catch(() => undefined)
            )?.exitCode === 0,
  };
}

/** Connects to `server` and verifies it has root, sudo, or docker privilege. */
async function probeServer(
  deps: PhaseDeps,
  run: ServerFirewallRun,
  server: string,
): Promise<ResolvedServer | undefined> {
  const shell = await resolveServerShell(deps, run, server);
  if (shell === undefined) return undefined;
  let privilege: HostFacts["privilege"];
  try {
    privilege = await probePrivilege(shell.remote);
  } catch {
    return undefined;
  }
  if (!isRootPrivilege(privilege)) return undefined;
  return { ...shell, privilege };
}

/** True when `error` indicates `/etc/opscrew/firewall-networks.json` exists on disk but is damaged. */
function isDamagedRecordError(error: unknown): boolean {
  return (
    error instanceof OpsCrewError &&
    error.code === "COMMAND_FAILED" &&
    error.message.includes(SERVER_FIREWALL_NETWORKS_FILE) &&
    (error.message.includes("not valid JSON") || error.message.includes("damaged or incomplete"))
  );
}

/**
 * Reads `/etc/opscrew/firewall-networks.json` over SSH (read-only) for every existing server on a
 * `firewallCheck: "server"` provider in `planJson`.
 * - When the file exists and is valid, records it in `networks[address]` and marks `address`
 *   reachable.
 * - When the file does not exist yet (`absent`), omits `networks[address]` (so SecOps falls back
 *   to the first-boot script in Terraform state) and still marks `address` reachable.
 * - When the file exists on disk but is damaged JSON, throws (fail closed).
 * - When the server cannot be reached over SSH or lacks root/sudo/docker access, leaves `address`
 *   out of `reachable` so `server-firewall-as-planned` fails closed if networks differ.
 */
export async function readExistingServerFirewalls(
  deps: PhaseDeps,
  run: ServerFirewallRun,
  planJson: unknown,
  phase: PhaseName,
): Promise<ExistingServerFirewallsRead> {
  const networks: Record<string, ServerFirewallNetworks> = {};
  const records: Record<string, ServerFirewallNetworksRecord> = {};
  const reachable = new Set<string>();
  const servers = existingOwnFirewallServers(planJson);
  if (servers.length === 0) return { networks, records, reachable };

  const readNetworks = run.host?.readNetworks ?? readServerFirewallNetworks;
  for (const item of servers) {
    const probed = await probeServer(deps, run, item.server);
    if (probed === undefined) continue;
    try {
      const record = await readNetworks(probed.remote, probed.privilege, IMAGES.caddy.ref);
      reachable.add(item.address);
      if (record !== undefined) {
        records[item.address] = record;
        networks[item.address] = recordToSecops(record);
      }
      await deps.audit.append({
        kind: "remote-exec",
        actor: "opscrew",
        action: "read server firewall networks (read-only)",
        phase,
        target: `server ${item.server}`,
        decision: "allow",
        detail: record === undefined ? "absent (first-boot fallback)" : "present",
      });
    } catch (error) {
      if (isDamagedRecordError(error)) throw error;
      // Unreachable / exec error: leave out of `reachable` so policies fail closed on drift.
    }
  }
  return { networks, records, reachable };
}

/**
 * Emits (and unless `planOnly`, approves by SHA-256 hash and applies under the dead-man rollback)
 * a `server-firewall` host plan for every existing `firewallCheck: "server"` server in `planJson`
 * whose current networks differ from the plan's networks.
 */
export async function applyServerFirewallUpdates(
  deps: PhaseDeps,
  input: {
    run: ServerFirewallRun;
    planJson: unknown;
    read?: ExistingServerFirewallsRead | undefined;
    planOnly: boolean;
    command: string;
    phase: PhaseName;
  },
): Promise<HostPlanOutcome[]> {
  const read =
    input.read ?? (await readExistingServerFirewalls(deps, input.run, input.planJson, input.phase));
  const updates = serverFirewallUpdates(input.planJson, {
    serverFirewallNetworks: read.networks,
  });
  if (updates.length === 0) return [];

  const host = input.run.host ?? { inspect: inspectHost, apply: applyHostPlan };
  const outcomes: HostPlanOutcome[] = [];
  for (const update of updates) {
    const probed = await probeServer(deps, input.run, update.server);
    if (probed === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew could not reach server ${update.server} over SSH to update its own firewall (${update.differences.join("; ")}). Nothing on the server was changed.`,
        {
          hint: `Check that server ${update.server} is reachable over SSH, then run \`${input.command}\` again.`,
        },
      );
    }
    const rootImage = probed.privilege === "docker" ? IMAGES.caddy.ref : undefined;
    deps.reporter.step(`Inspecting server ${update.server} for its firewall update (read-only)`);
    const facts = await host.inspect(probed.remote, rootImage === undefined ? {} : { rootImage });
    const hostPlan = planServerFirewall(
      facts,
      {
        app: input.run.plan.app.name,
        serverFirewall: secopsToParams(update.planned),
        current: read.records[update.address],
      },
      input.command,
    );
    const where = update.server === "previous" ? "the previous server" : `server ${update.server}`;
    const outcome = await approveAndApplyHostPlan(deps, {
      plan: hostPlan,
      remote: probed.remote,
      apply:
        rootImage === undefined
          ? (remote, applied, options) => host.apply(remote, applied, options)
          : (remote, applied, options) => host.apply(remote, applied, { ...options, rootImage }),
      verifyLogin: probed.verifyLogin,
      title: `Update the server's own firewall on ${where}`,
      intro: [
        `The plan's networks for ${where} differ from its current firewall (${update.differences.join("; ")}).`,
      ],
      server: where,
      planOf: where,
      upToDate: `The firewall on ${where} already has the plan's networks.`,
      command: input.command,
      phase: input.phase,
      ...(input.planOnly ? { planOnly: true } : {}),
      secrets: async () => ({}),
      applying: `Updating the server's own firewall on ${where} under the automatic undo`,
    });
    outcomes.push(outcome);
  }
  return outcomes;
}
