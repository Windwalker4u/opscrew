import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ApprovalRequest,
  CommandRunner,
  RemoteExec,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { durationText, listText, OpsCrewError, readTextIfExists, realSleep } from "@opscrew/core";
import { defaultTcpConnect, type TcpConnect } from "@opscrew/secops";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import type { ProviderProfile } from "../providers";
import type { ProvisionServices } from "../provision/types";
import { providerConsole } from "./provider-text";
import { SshRemoteExec } from "./remote";
import type { NetworkReach } from "./server-address";

type Sleep = (ms: number) => Promise<void>;

/** How long to poll and how often; tests inject `sleep` and `now` (monotonic milliseconds). */
export interface WaitOptions {
  timeoutMs: number;
  intervalMs: number;
  sleep?: Sleep;
  now?: () => number;
}

/**
 * Calls `check` until it returns something other than `undefined` and returns that, or returns
 * `undefined` once `timeoutMs` passed. `check` runs at once and every `intervalMs` (never sleeping
 * past the deadline), and once more when the time is up.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  options: WaitOptions,
): Promise<T | undefined> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (now() >= deadline) return undefined;
    await sleep(Math.max(1, Math.min(options.intervalMs, deadline - now())));
  }
}

/** Polls until `host:port` accepts TCP connections. Resolves false on timeout. */
export async function waitForPort(
  host: string,
  port: number,
  options: WaitOptions & { connect: TcpConnect },
): Promise<boolean> {
  const open = await pollUntil(
    async () =>
      (await options.connect(host, port, Math.min(5000, options.intervalMs))) ? true : undefined,
    options,
  );
  return open === true;
}

/** OpsCrew's mark that the first-boot setup succeeded: the template's last command writes it. */
const READY_FILE = "/var/lib/opscrew-ready";
/**
 * cloud-init's result of its last boot that ended, which the deploy user can read. It stays from
 * one boot to the next, so {@link ENDED_FILE} tells whether this boot ended.
 */
const RESULT_FILE = "/var/lib/cloud/data/result.json";
/**
 * cloud-init's link to {@link RESULT_FILE}, made in `/run` (empty at each boot) once this boot's
 * last stage ended: there without {@link READY_FILE}, the setup ended without succeeding.
 */
const ENDED_FILE = "/run/cloud-init/result.json";

/**
 * How a first-boot setup came out: `ready`, `failed` (cloud-init ended without OpsCrew's mark), or
 * still `running` when the wait ended.
 */
export type SetupOutcome = "ready" | "failed" | "running";

/**
 * Polls the server until cloud-init wrote `/var/lib/opscrew-ready` (`ready`), or ended without it
 * (`failed`); `running` when neither happened within the wait. Connection errors are retried.
 */
export async function waitForCloudInit(
  remote: RemoteExec,
  options: WaitOptions,
): Promise<SetupOutcome> {
  const outcome = await pollUntil(async () => {
    try {
      const result = await remote.run(
        `if test -f ${READY_FILE}; then echo ready; elif test -f ${ENDED_FILE}; then echo failed; else echo waiting; fi`,
        { timeoutMs: 20_000 },
      );
      const answer = result.stdout.trim();
      return result.exitCode === 0 && (answer === "ready" || answer === "failed")
        ? answer
        : undefined;
    } catch {
      return undefined; // The server may still be booting; try again.
    }
  }, options);
  return outcome ?? "running";
}

/** cloud-init's result: each error starts with the module that failed, `('<module>', …)`. */
const CloudInitResultSchema = z.looseObject({
  v1: z.looseObject({ errors: z.array(z.string()) }),
});

/** The cloud-init modules a first boot of OpsCrew's fails in, in plain words. */
const SETUP_STEPS: Readonly<Record<string, string>> = {
  package_update_upgrade_install: "the package install",
  runcmd: "OpsCrew's setup script",
  scripts_user: "OpsCrew's setup script",
  bootcmd: "the provider's first-boot command",
};

/**
 * The first-boot steps cloud-init's result on the server names as failed, in plain words, read
 * through the deploy user's shell (`remote`); none when it names none or cannot be read. Only the
 * modules' names are taken from it: its errors can quote commands, so they are never shown.
 */
export async function failedSetupSteps(remote: RemoteExec): Promise<string[]> {
  const result = await remote
    .run(`cat ${RESULT_FILE}`, { timeoutMs: 20_000 })
    .catch(() => undefined);
  if (result?.exitCode !== 0) return [];
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const parsed = CloudInitResultSchema.safeParse(json);
  if (!parsed.success) return [];
  const steps = parsed.data.v1.errors.map((error) => {
    const module = /^\('([a-z0-9_]+)'/.exec(error)?.[1];
    if (module === undefined) return "a step cloud-init does not name";
    return SETUP_STEPS[module] ?? `cloud-init's ${module} step`;
  });
  return [...new Set(steps)];
}

/** `host keytype key` lines from `ssh-keyscan`, without comments. */
export function parseKeyscan(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .filter((line) => line.split(/\s+/).length >= 3);
}

/** The `type key` of a known_hosts or `ssh-keyscan` line. */
function keyOf(line: string): string {
  return line.split(/\s+/).slice(1, 3).join(" ");
}

/** The `type key` of each key known_hosts text pins for `host` (a {@link knownHostsName}). */
export function keysFor(knownHosts: string, host: string): string[] {
  return parseKeyscan(knownHosts)
    .filter((line) => (line.split(/\s+/)[0] ?? "").split(",").includes(host))
    .map(keyOf);
}

export interface PinHostKeyOptions {
  host: string;
  knownHostsFile: string;
  runner: CommandRunner;
  /** Provider console named in hints (see `providerConsole`); default "your cloud provider's console". */
  console?: string;
  /** Asked when the pinned key differs; refusal (or no handler) throws. */
  confirmChangedKey?: (details: {
    host: string;
    previous: string[];
    current: string[];
  }) => Promise<boolean>;
}

export interface PinnedHostKey {
  /** The known_hosts line(s) for this host, ready for the deploy secret. */
  knownHostsLines: string;
  changed: boolean;
  created: boolean;
}

/**
 * Records the server's Ed25519 host key in OpsCrew's own known_hosts file (trust on first use,
 * right after OpsCrew created the server). A key that differs from the pinned one is only replaced
 * after explicit confirmation.
 */
export async function pinHostKey(options: PinHostKeyOptions): Promise<PinnedHostKey> {
  const scan = await options.runner.run(
    "ssh-keyscan",
    ["-T", "10", "-t", "ed25519", options.host],
    {
      timeoutMs: 30_000,
    },
  );
  const lines = parseKeyscan(scan.stdout);
  if (lines.length === 0) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not read the SSH host key of ${options.host}.`,
      {
        hint: "The server may still be starting; run `opscrew provision` again in a minute.",
      },
    );
  }
  const existing = (await readTextIfExists(options.knownHostsFile)) ?? "";
  const previous = keysFor(existing, options.host);
  const current = lines.map(keyOf);
  const same = previous.length > 0 && current.every((key) => previous.includes(key));
  if (same) {
    return { knownHostsLines: `${lines.join("\n")}\n`, changed: false, created: false };
  }
  if (previous.length > 0) {
    const approved =
      (await options.confirmChangedKey?.({ host: options.host, previous, current })) ?? false;
    if (!approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The SSH host key of ${options.host} changed since OpsCrew pinned it.`,
        {
          hint: `If you did not rebuild the server, someone may be intercepting the connection. Check in ${options.console ? `the ${options.console}` : "your cloud provider's console"} before continuing.`,
        },
      );
    }
  }
  const others = parseKeyscan(existing).filter(
    (line) => !(line.split(/\s+/)[0] ?? "").split(",").includes(options.host),
  );
  await writeFile(options.knownHostsFile, `${[...others, ...lines].join("\n")}\n`, { mode: 0o644 });
  return {
    knownHostsLines: `${lines.join("\n")}\n`,
    changed: previous.length > 0,
    created: previous.length === 0,
  };
}

/**
 * Asks (`remote-exec` approval) whether to trust the new SSH host key of a server OpsCrew pinned
 * earlier, showing both keys: only right after the user rebuilt or replaced the server.
 */
export function confirmChangedHostKey(
  deps: Pick<PhaseDeps, "approvals">,
): NonNullable<PinHostKeyOptions["confirmChangedKey"]> {
  return async ({ host, previous, current }) => {
    const decision = await deps.approvals.request({
      kind: "remote-exec",
      // The title is kept in the approvals record and the audit log: no address there.
      title: "Trust the server's new SSH host key",
      details: [
        `Server: ${host}`,
        "The server's SSH host key is different from the one OpsCrew pinned earlier.",
        "Only accept this if you rebuilt or replaced the server yourself.",
        "Pinned:",
        ...previous.map((line) => `  ${line}`),
        "Now:",
        ...current.map((line) => `  ${line}`),
      ].join("\n"),
    });
    return decision.approved;
  };
}

/** How long a server OpsCrew created may take to accept SSH, and how often it is tried. */
const SSH_WAIT_MS = 5 * 60_000;
/** How long a server that already exists may take to answer SSH over the private network. */
const NETWORK_SSH_WAIT_MS = 30_000;
const SSH_INTERVAL_MS = 5_000;
/** How long its first-boot setup (cloud-init) may take, and how often it is checked. */
const CLOUD_INIT_WAIT_MS = 8 * 60_000;
const CLOUD_INIT_INTERVAL_MS = 10_000;

/** `run \`<command>\` again; it continues where it stopped.`: the end of a hint after a stop. */
export function continuesHint(command: string): string {
  return `run \`${command}\` again; it continues where it stopped.`;
}

/** The next step after an apply failed that deleted nothing, telling the user to run `command`. */
export function nothingDeletedHint(command: string): string {
  return `Fix the cause shown above, then run \`${command}\` again. Nothing was deleted.`;
}

/** Quotes a path for a copy-pasteable shell command. */
function quotePath(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/** How long a server may take to answer with a new SSH host key after its install. */
const INSTALL_WAIT_MS = 10 * 60_000;

/**
 * The repair of a server OpsCrew just created whose first boot failed (FR-3109), offered only for
 * a server that holds nothing yet (before the app's first deploy there), and only through the
 * methods its provider's connector has.
 */
export interface NewServerRepair {
  /** The provider's server API; a restart and an install are offered only where it has them. */
  servers: Pick<ServerSnapshotApi, "restart" | "reinstall"> | undefined;
  /** The provider's id of the server. */
  serverId: string;
  /** The app's name: the server's name at the provider, and what the user types to approve. */
  app: string;
  /** The provider's image the server was created from. */
  image: string;
  /** The server's first-boot file, as its module renders it (`renderCloudInit`). */
  userData: () => Promise<string>;
  /** The command that comes back to this step, for a refusal's hint (`opscrew provision`). */
  command: string;
  /** How a script approves it, after "in a script, ": ``run `opscrew retarget --confirm shop` ``. */
  script: string;
}

/** The start of the titles of a new server's repairs, which {@link isNewServerRepairRequest} reads. */
const RESTART_TITLE = "Restart the new ";
const INSTALL_TITLE = "Install the new ";

/**
 * True for the approval of a new server's repair (its restart, or its install again), which the
 * app's name typed approves, or `--confirm <app>` in a script.
 */
export function isNewServerRepairRequest(
  request: Pick<ApprovalRequest, "kind" | "title">,
): boolean {
  return (
    request.kind === "remote-exec" &&
    (request.title.startsWith(RESTART_TITLE) || request.title.startsWith(INSTALL_TITLE))
  );
}

type ReadyDeps = Pick<PhaseDeps, "reporter" | "approvals" | "audit" | "paths" | "runner">;
type ReadyProfile = Pick<ProviderProfile, "serverNoun" | "displayName" | "consoleUrl">;

/**
 * Asks for a repair of the new server, `failure` saying why, with the app's name typed; a refusal
 * stops the run with nothing changed and the command that offers it again.
 */
async function approveRepair(
  deps: ReadyDeps,
  repair: NewServerRepair,
  request: { title: string; failure: string; does: string[]; destroys: boolean; verb: string },
): Promise<void> {
  const decision = await deps.approvals.request({
    kind: "remote-exec",
    // The title is kept in the approvals record and the audit log: no address there.
    title: request.title,
    details: [
      request.failure,
      "It holds nothing yet: OpsCrew created it and has not deployed to it.",
      ...request.does,
    ].join("\n"),
    ...(request.destroys ? { allowDestroy: true } : {}),
    confirmPhrase: repair.app,
  });
  if (decision.approved) return;
  throw new OpsCrewError(
    "APPROVAL_REFUSED",
    `${request.failure} OpsCrew did not ${request.verb} it${decision.reason === undefined ? "" : `: ${decision.reason}`}. Nothing was changed.`,
    {
      hint: `To repair it, run \`${repair.command}\` again and type ${repair.app} when asked; in a script, ${repair.script}.`,
    },
  );
}

/** Records a repair's call to the provider in the audit log, before it is made. */
async function auditRepair(
  deps: ReadyDeps,
  repair: NewServerRepair,
  profile: ReadyProfile,
  action: string,
): Promise<void> {
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action,
    target: `${profile.displayName} ${profile.serverNoun} ${repair.serverId}`,
    decision: "approved",
    detail: `the new ${profile.serverNoun} ${repair.app}, whose first boot failed`,
  });
}

/**
 * After an install of the server: waits until it presents an SSH host key other than `old` (the
 * old system can still answer for a while after the provider accepted the install), then forgets
 * the old pin and pins the new key with no question (FR-3110).
 */
async function pinInstalledServer(
  deps: ReadyDeps,
  input: {
    host: string;
    server: string;
    profile: ReadyProfile;
    again: string;
    old: readonly string[];
    waits: Pick<WaitOptions, "sleep" | "now">;
  },
): Promise<PinnedHostKey> {
  const { host, server, profile, old } = input;
  deps.reporter.step(
    `Waiting for the ${server} at ${host} to start from its new install (up to ${durationText(INSTALL_WAIT_MS)})`,
  );
  let answered = false;
  const changed = await pollUntil(
    async () => {
      const scan = await deps.runner
        .run("ssh-keyscan", ["-T", "10", "-t", "ed25519", host], { timeoutMs: 30_000 })
        .catch(() => undefined);
      const keys = parseKeyscan(scan?.stdout ?? "").map(keyOf);
      if (keys.length === 0) return undefined;
      answered = true;
      return keys.every((key) => !old.includes(key)) ? true : undefined;
    },
    { timeoutMs: INSTALL_WAIT_MS, intervalMs: CLOUD_INIT_INTERVAL_MS, ...input.waits },
  );
  if (changed !== true) {
    const asked = `${durationText(INSTALL_WAIT_MS)} after ${profile.displayName} accepted its install`;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      answered
        ? `The ${server} at ${host} still had its old SSH host key ${asked}: the install did not take effect.`
        : `The ${server} at ${host} did not open SSH within ${asked}.`,
      {
        hint: `Check the ${profile.serverNoun} in the ${providerConsole(profile)}, then ${input.again}`,
      },
    );
  }
  const knownHostsFile = deps.paths.files.knownHosts;
  await writeKnownHost(knownHostsFile, host, []);
  return pinHostKey({
    host,
    console: providerConsole(profile),
    knownHostsFile,
    runner: deps.runner,
  });
}

/** Why the setup did not finish, with the steps cloud-init named as failed. */
function setupFailure(subject: string, outcome: SetupOutcome, steps: readonly string[]): string {
  const within = outcome === "running" ? ` within ${durationText(CLOUD_INIT_WAIT_MS)}` : "";
  if (steps.length > 0) {
    return `${subject} did not finish its first-boot setup${within}: ${listText(steps)} failed.`;
  }
  const unnamed = outcome === "failed" ? " (cloud-init named no failed step)" : "";
  return `${subject} did not finish its first-boot setup${within}${unnamed}.`;
}

/**
 * Makes a server OpsCrew just created ready to use: waits until `host` accepts SSH, pins its SSH
 * host key (a changed key only after {@link confirmChangedHostKey}) and waits until its first-boot
 * setup (cloud-init) is done, through the deploy user's shell (`services.remote`, else SSH with
 * `keyFile`). Once public SSH is closed (`network`, see `networkReach`) it does so at the server's
 * private address, through `network.remote`, with the key pinned there. `server` names it in the
 * messages (`server`, `new Droplet`); a stop names the steps cloud-init reports as failed (FR-3108)
 * and says what to check and then `again` ({@link continuesHint}).
 *
 * With `repair` (a new server reached at its public address), each after its own approval with
 * the app's name typed, at most once per run (FR-3109): a server that never opens SSH is
 * restarted through its provider and waited for again; one whose setup does not finish is
 * installed again from the same image with the same first-boot file, and its new host key
 * replaces the old pin with no question (FR-3110). Returns the key pinned where it was reached.
 */
export async function readyNewServer(
  deps: ReadyDeps,
  input: {
    host: string;
    server: string;
    profile: ReadyProfile;
    keyFile: string;
    again: string;
    services: Pick<ProvisionServices, "tcpConnect" | "remote" | "sleep" | "now">;
    network?: NetworkReach;
    repair?: NewServerRepair;
  },
): Promise<PinnedHostKey> {
  const { server, profile, services, network } = input;
  const host = network?.host ?? input.host;
  const port = network?.port ?? 22;
  const knownHostsFile = deps.paths.files.knownHosts;
  const waits = {
    ...(services.sleep ? { sleep: services.sleep } : {}),
    ...(services.now ? { now: services.now } : {}),
  };
  // A server reached over the private network was set up long ago: never repaired here.
  const repair = network === undefined ? input.repair : undefined;
  const subject = `The ${server} at ${host}`;
  const servers = repair?.servers;
  const named = `the new ${profile.displayName} ${profile.serverNoun} ${repair?.app ?? ""}`;
  const api = `${profile.displayName}'s API`;
  let restarted = false;
  /** The keys pinned before the install, once OpsCrew installed the server again. */
  let installedOver: string[] | undefined;
  for (;;) {
    let pinned: PinnedHostKey;
    if (installedOver !== undefined) {
      pinned = await pinInstalledServer(deps, {
        host,
        server,
        profile,
        again: input.again,
        old: installedOver,
        waits,
      });
    } else {
      deps.reporter.step(
        `Waiting for the ${server} at ${host} to accept SSH${network ? " over the app's private network" : ""}`,
      );
      const waitMs = network ? NETWORK_SSH_WAIT_MS : SSH_WAIT_MS;
      const open = await waitForPort(host, port, {
        timeoutMs: waitMs,
        intervalMs: SSH_INTERVAL_MS,
        connect: services.tcpConnect ?? defaultTcpConnect,
        ...waits,
      });
      if (!open) {
        if (network?.unreachable !== undefined) throw network.unreachable;
        const failure = `${subject} did not open SSH within ${durationText(waitMs)}${restarted ? " after OpsCrew restarted it" : ""}.`;
        if (repair !== undefined && servers?.restart !== undefined && !restarted) {
          await approveRepair(deps, repair, {
            title: `${RESTART_TITLE}${profile.displayName} ${profile.serverNoun} ${repair.app}`,
            failure,
            does: [`OpsCrew restarts ${named} through ${api}, then waits for it again.`],
            destroys: false,
            verb: "restart",
          });
          deps.reporter.step(`Restarting ${named} through ${api}`);
          await auditRepair(deps, repair, profile, "restart server");
          await servers.restart(repair.serverId);
          restarted = true;
          continue;
        }
        throw new OpsCrewError("PROVIDER_ERROR", failure, {
          hint: `Check the ${profile.serverNoun} in the ${providerConsole(profile)}, then ${input.again}`,
        });
      }
      pinned = network
        ? await pinnedLines(knownHostsFile, knownHostsName(host, port))
        : await pinHostKey({
            host,
            console: providerConsole(profile),
            knownHostsFile,
            runner: deps.runner,
            confirmChangedKey: confirmChangedHostKey(deps),
          });
    }
    const remote =
      network?.remote ??
      services.remote?.(host) ??
      new SshRemoteExec({ host, keyFile: input.keyFile, knownHostsFile, runner: deps.runner });
    deps.reporter.step(
      `Waiting for the ${server} to finish its first-boot setup (up to ${durationText(CLOUD_INIT_WAIT_MS)})`,
    );
    const outcome = await waitForCloudInit(remote, {
      timeoutMs: CLOUD_INIT_WAIT_MS,
      intervalMs: CLOUD_INIT_INTERVAL_MS,
      ...waits,
    });
    if (outcome === "ready") {
      deps.reporter.success(`The ${server} at ${host} is ready.`);
      return pinned;
    }
    const failure = setupFailure(subject, outcome, await failedSetupSteps(remote));
    if (repair !== undefined && servers?.reinstall !== undefined && installedOver === undefined) {
      await approveRepair(deps, repair, {
        title: `${INSTALL_TITLE}${profile.displayName} ${profile.serverNoun} ${repair.app} again`,
        failure,
        does: [
          `OpsCrew installs ${named} again through ${api}, from the same image with the same first-boot setup: its disk is wiped, and it keeps its id and addresses.`,
          "Then OpsCrew pins its new SSH host key and waits for its setup again.",
        ],
        destroys: true,
        verb: "install",
      });
      const old = keysFor(pinned.knownHostsLines, host);
      const userData = await repair.userData();
      deps.reporter.step(`Installing ${named} again through ${api}`);
      await auditRepair(deps, repair, profile, "reinstall server");
      await servers.reinstall(repair.serverId, { image: repair.image, userData });
      installedOver = old;
      continue;
    }
    const check = `ssh -i ${quotePath(input.keyFile)} -o UserKnownHostsFile=${quotePath(knownHostsFile)} deploy@${host} cloud-init status --long`;
    throw new OpsCrewError("PROVIDER_ERROR", failure, {
      hint: `Check what it is doing with \`${check}\`, then ${input.again}`,
    });
  }
}

/** The key pinned for `name` (a {@link knownHostsName}) in a known_hosts file, unchanged. */
async function pinnedLines(knownHostsFile: string, name: string): Promise<PinnedHostKey> {
  const keys = keysFor((await readTextIfExists(knownHostsFile)) ?? "", name);
  return {
    knownHostsLines: `${keys.map((key) => `${name} ${key}`).join("\n")}\n`,
    changed: false,
    created: false,
  };
}

/** A host key the server presented: its type (`ssh-ed25519`), base64 key and fingerprint. */
export interface ScannedHostKey {
  type: string;
  key: string;
  /** `SHA256:` and the unpadded base64 SHA-256 of the key, as `ssh-keygen -lf` prints it. */
  fingerprint: string;
}

/** A pinned host key fingerprint: `SHA256:` and 43 base64 characters. */
export const HOST_KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

/**
 * The SHA-256 fingerprint of an SSH public key (the base64 field of a key line), written as
 * OpenSSH prints it: `SHA256:` and the unpadded base64 digest.
 */
export function hostKeyFingerprint(keyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

/** How known_hosts names a server: `host` on port 22, `[host]:port` on any other port. */
export function knownHostsName(host: string, port = 22): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

/** Ed25519 first, then ECDSA, then RSA: the order a user is shown and asked to confirm. */
function keyRank(type: string): number {
  if (type === "ssh-ed25519") return 0;
  if (type.startsWith("ecdsa-")) return 1;
  if (type === "ssh-rsa") return 2;
  return 3;
}

/**
 * The host keys the server at `host:port` presents (`ssh-keyscan`), Ed25519 first, each with its
 * SHA-256 fingerprint. Empty when the server did not answer. `ssh-keyscan` alone cannot tell a
 * real server from a man in the middle: a caller pins a key only after the user confirmed its
 * fingerprint (or named it with `--host-key`).
 */
export async function scanHostKeys(options: {
  host: string;
  port?: number;
  runner: CommandRunner;
}): Promise<ScannedHostKey[]> {
  const scan = await options.runner.run(
    "ssh-keyscan",
    ["-T", "10", "-p", String(options.port ?? 22), "-t", "ed25519,ecdsa,rsa", options.host],
    { timeoutMs: 30_000 },
  );
  const seen = new Set<string>();
  const keys: ScannedHostKey[] = [];
  for (const line of parseKeyscan(scan.stdout)) {
    const [, type, key] = line.split(/\s+/);
    if (type === undefined || key === undefined || !/^[A-Za-z0-9+/]+={0,3}$/.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push({ type, key, fingerprint: hostKeyFingerprint(key) });
  }
  return keys.sort((a, b) => keyRank(a.type) - keyRank(b.type));
}

/**
 * Replaces the entries of `name` (see {@link knownHostsName}) in a known_hosts file with `keys`,
 * keeping every other host's entries, and returns the new lines for `name`.
 */
export async function writeKnownHost(
  file: string,
  name: string,
  keys: readonly Pick<ScannedHostKey, "type" | "key">[],
): Promise<string> {
  const existing = (await readTextIfExists(file)) ?? "";
  const others = parseKeyscan(existing).filter(
    (line) => !(line.split(/\s+/)[0] ?? "").split(",").includes(name),
  );
  const lines = keys.map((k) => `${name} ${k.type} ${k.key}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${[...others, ...lines].join("\n")}\n`, { mode: 0o644 });
  return `${lines.join("\n")}\n`;
}
