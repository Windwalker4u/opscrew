/**
 * The app's R2 buckets in a move to another Cloudflare account (plan 4.4.5, 7.1 to 7.3, 7.7, 8.):
 * the app's own (`storage`) and the snapshots' copies (`backups`), each with a same-named bucket in
 * B that its root's shadow plan made. Prepare copies each once; the finish copies the app bucket's
 * last changes in a short maintenance window around the switch of the app's settings, then the
 * snapshots' copies once more; A's buckets are emptied only once B is shown to hold each of their
 * files (B's at an abort, without that check). rclone runs on the app's server over SSH, or through
 * the user's Portainer's Docker proxy, with the buckets' keys only on its standard input or in its
 * container's configuration file (`shared/rclone.ts`). Each step is a `remote-exec` approval.
 */
import { type DockerClient, dockerClient } from "@opscrew/connector-docker";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  plural,
  replaceNames,
  sha256Hex,
  upperFirst,
} from "@opscrew/core";
import {
  appDir,
  portainerStackName,
  portainerTarget,
  processServices,
  providerBucket,
} from "@opscrew/iac-templates";
import { APP_SERVER, backupsBucketOf, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { failureReason } from "../destroy/deletion";
import { withDeploysPaused } from "../move/deploys";
import { moveShell } from "../move/shells";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import { requireOffsiteKey, requireStorageKey } from "../provision/storage";
import { bucketMinutes, syncMinutes } from "../retarget/bucket";
import { serverOps, startService, stopService } from "../retarget/server-ops";
import { appliesNow } from "../retarget/steps";
import {
  approveCommand,
  MAINTENANCE_WINDOW_TITLE,
  sizeText,
  windowMinutes,
} from "../retarget/texts";
import { portainerClientFor, r2Endpoint, type StorageLogin } from "../shared";
import { clearDeployPause } from "../shared/deploy-pause";
import { codeOf, hintOf } from "../shared/errors";
import {
  type BucketSize,
  dockerRclone,
  type RcloneRunner,
  r2Remote,
  rcloneSize,
  sshRclone,
} from "../shared/rclone";
import {
  clearPending,
  clearWindow,
  type MovePlanKey,
  type MoveRoot,
  readAppProgress,
  recordWindowStop,
  writePending,
} from "./progress";
import type { MoveBucketSize, MoveEnvironment, MoveSession, StepStop } from "./types";

const PHASE = "cloudflare-move";
const MINUTE = 60_000;
/** How long one copy of a bucket may run on the app's server: a first copy may take hours. */
const COPY_TIMEOUT_MS = 6 * 60 * MINUTE;

/** One of an environment's R2 buckets, of the same name in both accounts. */
export interface MoveBucket {
  /** The app's files (`storage`) or the snapshots' copies (`backups`). */
  root: Extract<MoveRoot, "storage" | "backups">;
  bucket: string;
}

/** Which account a step reads or changes: A, which the app moves from, or B. */
export type BucketSide = "a" | "b";

/** The environment's buckets on R2: the app's, then the snapshots' copies. */
export function moveBuckets(plan: DeployPlan): MoveBucket[] {
  const buckets: MoveBucket[] = [];
  const own = providerBucket(plan);
  if (own?.provider === "r2") buckets.push({ root: "storage", bucket: own.bucket });
  const backups = backupsBucketOf(plan);
  if (backups?.provider === "r2") buckets.push({ root: "backups", bucket: backups.bucket });
  return buckets;
}

/** `shop-uploads (the app's files)`. */
function bucketWords(bucket: MoveBucket): string {
  return `${bucket.bucket} (${bucket.root === "storage" ? "the app's files" : "the snapshots' copies"})`;
}

/** The account in words: its name as the session read it, else its id. */
function accountWords(session: MoveSession, side: BucketSide): string {
  const account = session.accounts[side];
  return `${side === "a" ? "the current" : "the new"} Cloudflare account ${account.name ?? account.accountId}`;
}

/** The phase deps with the environment's paths (its kept keys, its server's address). */
function environmentDeps(session: MoveSession, environment: MoveEnvironment): PhaseDeps {
  return { ...session.deps, paths: environment.paths };
}

/** `shop (prod)`. */
function appWords(environment: MoveEnvironment): string {
  return `${environment.plan.app.name} (${environment.environment})`;
}

/**
 * `bucket`'s key in the account of `side` (`requireStorageKey` or `requireOffsiteKey` with that
 * account): A's from the plain variables or its kept copy, B's from the `OPSCREW_NEW_*` ones or its
 * kept copy, else asked once in a terminal; registered with the redactor.
 */
function bucketKey(
  session: MoveSession,
  environment: MoveEnvironment,
  bucket: MoveBucket,
  side: BucketSide,
): Promise<StorageLogin> {
  const deps = environmentDeps(session, environment);
  const options = { command: session.command, account: session.accounts[side].accountId };
  return bucket.root === "storage"
    ? requireStorageKey(deps, environment.plan, session.services, options)
    : requireOffsiteKey(deps, environment.plan, session.services, options);
}

/** rclone's remote of `side` (`a` or `b`, its account's R2 endpoint) with `key`. */
function remoteOf(session: MoveSession, side: BucketSide, key: StorageLogin): string[] {
  return r2Remote(side, session.accounts[side].accountId, key);
}

/** Where rclone runs for the app, and how its app stops and starts there. */
interface AppHost {
  /** The place in words: `the app's server`, `your server`, `your Portainer`. */
  words: string;
  /** How the keys reach rclone there, in words. */
  keys: string;
  rclone: RcloneRunner;
  /** Stops the app, its workers and its cron (not its services, not the edge). */
  stopApp(): Promise<void>;
  /** Starts what {@link AppHost.stopApp} stopped. */
  startApp(): Promise<void>;
  /** How to start the app by hand there. */
  byHand: string;
}

/** The Docker API of the user's Portainer environment (`services.docker` in tests). */
async function portainerDocker(
  session: MoveSession,
  deps: PhaseDeps,
  plan: DeployPlan,
): Promise<DockerClient> {
  const injected = session.services.docker?.(APP_SERVER);
  if (injected !== undefined) return dockerClient(injected);
  const connection = await requirePortainerConnection(deps, plan);
  const client = portainerClientFor(deps, {
    connection,
    token: requirePortainerToken(deps),
    client: session.services.portainer?.client,
  });
  return dockerClient(client.dockerProxyTransport(portainerTarget(plan.target).environmentId));
}

/**
 * Where the environment's app runs: in the user's Portainer (through its Docker proxy: rclone in a
 * one-off container, the app stack's containers stopped and started), else on its server as
 * `deploy` over SSH (rclone in a one-off container, `docker compose stop` and `up -d` in the app's
 * folder), whose address what it says names in words.
 */
async function appHost(session: MoveSession, environment: MoveEnvironment): Promise<AppHost> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const names = ["app", ...processServices(plan)];
  if (plan.target.provider === "portainer") {
    const docker = await portainerDocker(session, deps, plan);
    const stack = portainerStackName(plan);
    const each = async (act: (id: string) => Promise<void>) => {
      for (const container of await docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${stack}`])) {
        if (names.includes(container.labels[COMPOSE_SERVICE_LABEL] ?? "")) await act(container.id);
      }
    };
    const words = "your Portainer";
    return {
      words,
      keys: "written into it through Docker's archive API only",
      rclone: dockerRclone(deps.redactor, docker, words),
      stopApp: () => each((id) => docker.stopContainer(id)),
      startApp: () => each((id) => docker.startContainer(id)),
      byHand: `Start the containers of ${listText(names)} in the stack ${stack} in your Portainer`,
    };
  }
  const { remote } = await moveShell(deps, plan, session.services, APP_SERVER);
  const words = plan.target.provider === "own" ? "your server" : "the app's server";
  const ops = { ...serverOps(plan, deps.redactor), command: session.command };
  // What ssh or Compose said, and the hints, may name the server's address: words instead.
  const inWords = async (act: () => Promise<void>) => {
    try {
      await act();
    } catch (error) {
      if (!(error instanceof OpsCrewError)) throw error;
      const hint =
        error.hint === undefined ? {} : { hint: replaceNames(error.hint, [remote.host], words) };
      throw new OpsCrewError(error.code, replaceNames(error.message, [remote.host], words), hint);
    }
  };
  return {
    words,
    keys: "on its standard input only",
    rclone: sshRclone(deps.redactor, remote, words),
    stopApp: () => inWords(() => stopService(remote, "app", ops)),
    startApp: () => inWords(() => startService(remote, "app", ops)),
    byHand: `As deploy on ${words}, run \`docker compose up -d\` in ${appDir(plan)}`,
  };
}

/** The size of `bucket` in the account of `side`, by `rclone size` with that account's `key`. */
function sizeOf(
  session: MoveSession,
  host: AppHost,
  bucket: MoveBucket,
  side: BucketSide,
  key: StorageLogin,
): Promise<BucketSize> {
  return rcloneSize(host.rclone, {
    path: `${side}:${bucket.bucket}`,
    bucket: bucket.bucket,
    command: session.command,
    config: remoteOf(session, side, key),
    timeoutMs: 30 * MINUTE,
    what: `Measuring the bucket ${bucket.bucket} in ${accountWords(session, side)}`,
    hint: `Check that the key of the bucket ${bucket.bucket} in ${accountWords(session, side)} can list it, then run \`${session.command}\` again. Nothing was changed.`,
  });
}

/**
 * The size and objects of each of the environment's R2 buckets in A (`rclone size` on the app's
 * server, or in the user's Portainer, with A's keys only), for the summary before the first change
 * and the first copies' approval. None without a bucket on R2.
 */
export async function measureBuckets(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<MoveBucketSize[]> {
  const keyed: { bucket: MoveBucket; key: StorageLogin }[] = [];
  for (const bucket of moveBuckets(environment.plan)) {
    keyed.push({ bucket, key: await bucketKey(session, environment, bucket, "a") });
  }
  if (keyed.length === 0) return [];
  const host = await appHost(session, environment);
  const sizes: MoveBucketSize[] = [];
  for (const { bucket, key } of keyed) {
    session.deps.reporter.step(
      `Measuring the bucket ${bucketWords(bucket)} of ${appWords(environment)}`,
    );
    const size = await sizeOf(session, host, bucket, "a", key);
    sizes.push({
      environment: environment.environment,
      root: bucket.root,
      bucket: bucket.bucket,
      ...size,
    });
  }
  return sizes;
}

/** The stop of a non-interactive run: the step above waits for `--approve <hash>`. */
function pendingStop(
  session: MoveSession,
  hash: string,
  flags: readonly string[],
  what: string,
): StepStop {
  return {
    pendingPlanHash: hash,
    next: [
      `Review the step above, then run \`${approveCommand(session.command, hash, flags)}\` to ${what} and continue.`,
    ],
  };
}

/** An audit entry of the move: the app is its target; never a key or an address. */
function audit(
  session: MoveSession,
  environment: MoveEnvironment,
  entry: { action: string; decision: "approved" | "refused"; detail: string },
): Promise<void> {
  return session.deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    phase: PHASE,
    target: environment.plan.app.name,
    ...entry,
  });
}

/** What one copy step copies, and how it is approved. */
interface CopyStep {
  buckets: MoveBucket[];
  key: MovePlanKey;
  /** The approval's title. */
  title: string;
  /** Rough minutes of a bucket's copy, from its size in A. */
  minutes: (size: BucketSize) => number;
}

/**
 * Copies each of `step.buckets` from A to B's bucket of the same name (`rclone copy --checksum
 * --metadata`: only what is missing, checksums and metadata compared and kept), in one-off
 * containers where the app runs, after one `remote-exec` approval bound to the step's hash that
 * lists each bucket with its size, objects and minutes. Both accounts' keys are read first, A's
 * buckets measured; a non-interactive run without `--approve <hash>` shows the step, records it as
 * waiting and stops. Resumable: a run after an interruption copies what is still missing.
 */
async function copyBuckets(
  session: MoveSession,
  environment: MoveEnvironment,
  step: CopyStep,
): Promise<StepStop | undefined> {
  if (step.buckets.length === 0) return undefined;
  const deps = environmentDeps(session, environment);
  const { a, b } = session.accounts;
  // Both accounts' keys, before anything is asked or changed.
  const keyed: { bucket: MoveBucket; a: StorageLogin; b: StorageLogin }[] = [];
  for (const bucket of step.buckets) {
    keyed.push({
      bucket,
      a: await bucketKey(session, environment, bucket, "a"),
      b: await bucketKey(session, environment, bucket, "b"),
    });
  }
  const host = await appHost(session, environment);
  const lines: string[] = [];
  for (const { bucket, a: key } of keyed) {
    deps.reporter.step(`Measuring the bucket ${bucketWords(bucket)} of ${appWords(environment)}`);
    const size = await sizeOf(session, host, bucket, "a", key);
    lines.push(
      `  ${bucketWords(bucket)}: ${sizeText(size.bytes)} in ${plural(size.count, "object")}, about ${step.minutes(size)} minutes`,
    );
  }
  const details = [
    `From ${accountWords(session, "a")} into the bucket of the same name in ${accountWords(session, "b")}, with rclone copy in a one-off container on ${host.words}, both keys ${host.keys}: it copies only what is missing there, comparing checksums and keeping the files' metadata.`,
    ...lines,
    "Nothing in the current account changes, and the app keeps using its bucket there until the finish.",
  ].join("\n");
  const hash = sha256Hex(
    canonicalJson({
      action: step.key.action,
      environment: environment.environment,
      app: environment.plan.app.name,
      from: a.accountId,
      to: b.accountId,
      buckets: step.buckets.map((bucket) => bucket.bucket),
    }),
  );
  if (!appliesNow(session, hash)) {
    deps.reporter.info(`${step.title}\n${details}`);
    await writePending(deps, step.key, hash);
    return pendingStop(session, hash, [], "copy them");
  }
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: step.title,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The copy of ${appWords(environment)}'s R2 buckets to the new Cloudflare account was not approved. Nothing was changed.`,
      { hint: `Run \`${session.command}\` again when you are ready.` },
    );
  }
  for (const key of keyed) {
    const { bucket } = key;
    deps.reporter.step(
      `Copying the bucket ${bucketWords(bucket)} to ${accountWords(session, "b")}, from ${host.words}`,
    );
    await host.rclone({
      args: ["copy", `a:${bucket.bucket}`, `b:${bucket.bucket}`, "--checksum", "--metadata"],
      config: [...remoteOf(session, "a", key.a), ...remoteOf(session, "b", key.b)],
      // A copy that runs out of time is no harm: the next run copies only what is still missing.
      timeoutMs: COPY_TIMEOUT_MS,
      what: `Copying the bucket ${bucket.bucket} to the new Cloudflare account`,
      hint: `Check both accounts' keys of the bucket ${bucket.bucket}, then run \`${session.command}\` again: it copies what is missing.`,
    });
    await audit(session, environment, {
      action: "copy bucket",
      decision: "approved",
      detail: `${environment.environment}: copied the bucket ${bucket.bucket} from ${accountWords(session, "a")} to ${accountWords(session, "b")} with rclone`,
    });
  }
  await clearPending(deps, step.key);
  deps.reporter.success(
    `Copied ${listText(step.buckets.map(bucketWords))} to the new Cloudflare account.`,
  );
  return undefined;
}

/**
 * Prepare's first copies of the environment's R2 buckets into B's same-named buckets (plan 4.4.5),
 * once B's bucket keys are known: one `remote-exec` approval listing each bucket, its size, objects
 * and minutes, then `rclone copy --checksum --metadata` of each. A's buckets don't change. A script
 * stops with the step's hash (`--approve <hash>`). Nothing to do without a bucket on R2.
 */
export function firstCopies(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  return copyBuckets(session, environment, {
    buckets: moveBuckets(environment.plan),
    key: { action: "copy", environment: environment.environment },
    title: `Copy the R2 buckets of ${appWords(environment)} to the new Cloudflare account`,
    minutes: bucketMinutes,
  });
}

/**
 * The finish's last copy of the snapshots' copies (plan 7.3), after step 1's deploy pointed the
 * server's copies at B's bucket: what A's bucket gained since the first copy goes to B's, through
 * the same approval as the first copies. Nothing to do without that bucket on R2.
 */
export function lastBackupsCopy(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  return copyBuckets(session, environment, {
    buckets: moveBuckets(environment.plan).filter((bucket) => bucket.root === "backups"),
    key: { action: "copy", environment: environment.environment, root: "backups" },
    title: `Copy the snapshots' copies of ${appWords(environment)} made since the first copy to the new Cloudflare account`,
    minutes: (size) => Math.max(1, syncMinutes(size.count)),
  });
}

/** What the finish's step 1 needs of the environment's R2 buckets in B. */
export interface BucketSettings {
  /** The app's bucket: B's key and endpoint (`r2Endpoint(B)`), for the app's settings. */
  storage?: StorageLogin;
  /** The snapshots' copies' bucket: B's key and endpoint, for `OPSCREW_OFFSITE_ENV`. */
  backups?: StorageLogin;
}

/**
 * The bucket's part of the finish's step 1 (plan 7.1): for each of the environment's R2 buckets,
 * B's key with B's S3 endpoint. The names stay. Registered with the redactor; never logged.
 */
export async function appSettingsForB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<BucketSettings> {
  const settings: BucketSettings = {};
  const endpoint = r2Endpoint(session.accounts.b.accountId);
  for (const bucket of moveBuckets(environment.plan)) {
    settings[bucket.root] = { ...(await bucketKey(session, environment, bucket, "b")), endpoint };
  }
  return settings;
}

/** What the finish's window is given besides step 1 itself. */
export interface WindowOptions {
  /** `--allow-downtime`: a script approves the window. */
  allowDowntime?: boolean;
  /**
   * Puts the app's secrets and values back to A's (step 1 undone, with what makes the app use them
   * again): after a failure before step 1's deploy succeeded, and when a run finds the app stopped
   * by an earlier window. Nothing to do when they are A's.
   */
  backToA: () => Promise<void>;
}

/**
 * Starts the environment's app on A's settings: `backToA`, then the app, its workers and cron
 * started; the window's stop forgotten. A failure keeps it, so the next run tries again first, and
 * stops plainly: the app is offline until it runs again.
 */
async function restartOnA(
  session: MoveSession,
  environment: MoveEnvironment,
  host: AppHost,
  backToA: () => Promise<void>,
): Promise<void> {
  const deps = environmentDeps(session, environment);
  deps.reporter.step(
    `Putting the current Cloudflare account's settings back and starting ${appWords(environment)} again on ${host.words}`,
  );
  try {
    await backToA();
    await host.startApp();
  } catch (error) {
    const reason = deps.redactor.redact(failureReason(error));
    await audit(session, environment, {
      action: "window rollback",
      decision: "refused",
      detail: `${environment.environment}: starting the app on the current account's settings failed: ${reason}`,
    });
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not start ${appWords(environment)} again on the current Cloudflare account's settings: ${reason}. Your app is offline until it runs again.`,
      {
        hint: `${hintOf(error)}${host.byHand}, then run \`${session.command}\` again; it starts the app first.`,
      },
    );
  }
  await clearWindow(deps);
  await audit(session, environment, {
    action: "window rollback",
    decision: "approved",
    detail: `${environment.environment}: the app runs again on the current account's settings`,
  });
  deps.reporter.success(
    `${upperFirst(appWords(environment))} runs again on the current Cloudflare account's bucket.`,
  );
}

/**
 * When an earlier run stopped the environment's app for the window and did not end it (the app's
 * file still holds `window.stoppedAt` for it), the deploy pause it left is lifted, the secrets and
 * values go back to A's (`backToA`) and the app starts again, before anything else; nothing to do
 * otherwise. The finish calls it first; {@link bucketWindow} does too.
 */
export async function recoverWindow(
  session: MoveSession,
  environment: MoveEnvironment,
  backToA: () => Promise<void>,
): Promise<void> {
  const deps = environmentDeps(session, environment);
  const { window } = await readAppProgress(deps.paths);
  if (window?.environment !== environment.environment) return;
  deps.reporter.warn(
    `An earlier run stopped ${appWords(environment)} for the maintenance window at ${window.stoppedAt} and did not end it. OpsCrew starts the app on the current Cloudflare account's settings first; the window is repeated.`,
  );
  await clearDeployPause(deps, session.github, environment.plan, "move");
  await restartOnA(session, environment, await appHost(session, environment), backToA);
}

/**
 * The finish's maintenance window around step 1 (plan 7.2), with an app bucket on R2: a run that
 * finds the app stopped by an earlier window starts it on A first ({@link recoverWindow}); then
 * the `remote-exec` approval with the window's length (scripts: `allowDowntime`; its title is a
 * maintenance window's), the deploys paused and a running one awaited, `window.stoppedAt`, the app,
 * its workers and cron stopped, `rclone sync --checksum --metadata` from A's bucket to B's (B's was
 * made by the move, so `sync` deletes there only what A no longer has), the deploys resumed, then
 * `pointAtB` (step 1: B's secrets and values, and the deploy that starts the app). On any failure
 * once the app stopped, `backToA` and the app started on A; the window's stop is forgotten once the
 * app runs again. Without an app bucket on R2, `pointAtB` runs as it is.
 * @returns a script's stop when it lacks `allowDowntime`.
 */
export async function bucketWindow(
  session: MoveSession,
  environment: MoveEnvironment,
  pointAtB: () => Promise<void>,
  options: WindowOptions,
): Promise<StepStop | undefined> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  await recoverWindow(session, environment, options.backToA);
  const bucket = moveBuckets(plan).find((one) => one.root === "storage");
  if (bucket === undefined) {
    await pointAtB();
    return undefined;
  }
  const keys = {
    a: await bucketKey(session, environment, bucket, "a"),
    b: await bucketKey(session, environment, bucket, "b"),
  };
  const host = await appHost(session, environment);
  const app = appWords(environment);
  // The last copy compares each of the bucket's objects: its count, read before the window.
  const { count } = await sizeOf(session, host, bucket, "a", keys.a);
  const sync = syncMinutes(count);
  const minutes = windowMinutes(0, plan.target.provider === "portainer") + sync;
  const downtime = `about ${minutes} minutes`;
  if (!deps.interactive && options.allowDowntime !== true) {
    return {
      next: [
        `The finish stops ${app} on ${host.words} for ${downtime} while the last changes of its bucket ${bucket.bucket} are copied to the new Cloudflare account.`,
        `Run \`${session.command} --allow-downtime\` when that is acceptable.`,
      ],
    };
  }
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `${MAINTENANCE_WINDOW_TITLE} stop ${app} on ${host.words} while its bucket's last changes are copied to the new Cloudflare account (${downtime} of downtime)`,
    details: [
      `About ${minutes} minutes: the app is stopped while what changed in its bucket ${bucket.bucket} (${plural(count, "object")}) since the first copy is copied to the new account.`,
      "  pause the app's deploys and wait for a running one to end",
      `  on ${host.words}: stop the app, its workers and its cron`,
      `  copy what changed in ${bucket.bucket} into the new account's bucket of the same name (rclone sync in a one-off container, both keys ${host.keys})`,
      "  resume the deploys",
      "  point the app at the new account (its settings, then the deploy that starts it)",
      "If any of these fails, OpsCrew puts the current account's settings back and starts the app again; its bucket there keeps every file.",
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The maintenance window was not approved. Nothing was changed; ${app} keeps using its bucket in the current Cloudflare account.`,
      {
        hint: `Run \`${session.command}\` again when the downtime is acceptable (\`--allow-downtime\` in scripts).`,
      },
    );
  }
  let stopped = false;
  try {
    await withDeploysPaused(
      deps,
      session.github,
      plan,
      session.services,
      session.command,
      async () => {
        await recordWindowStop(deps, environment.environment);
        stopped = true;
        await audit(session, environment, {
          action: "window",
          decision: "approved",
          detail: `${environment.environment}: maintenance window started, about ${minutes} minutes`,
        });
        deps.reporter.step(`Stopping ${app} on ${host.words}`);
        await host.stopApp();
        deps.reporter.step(
          `Copying what changed in the bucket ${bucket.bucket} to the new Cloudflare account`,
        );
        await host.rclone({
          args: ["sync", `a:${bucket.bucket}`, `b:${bucket.bucket}`, "--checksum", "--metadata"],
          config: [...remoteOf(session, "a", keys.a), ...remoteOf(session, "b", keys.b)],
          timeoutMs: (3 * sync + 5) * MINUTE,
          what: `Copying what changed in the bucket ${bucket.bucket} to the new Cloudflare account`,
          hint: `Check both accounts' keys of the bucket ${bucket.bucket}.`,
        });
      },
    );
    deps.reporter.step(`Pointing ${app} at the new Cloudflare account`);
    await pointAtB();
  } catch (error) {
    if (!stopped) throw error;
    throw await rollBack(session, environment, host, error, options.backToA);
  }
  await clearWindow(deps);
  await audit(session, environment, {
    action: "window",
    decision: "approved",
    detail: `${environment.environment}: maintenance window ended; the app uses the new account's bucket`,
  });
  deps.reporter.success(`${upperFirst(app)} runs again, on the new Cloudflare account's bucket.`);
  return undefined;
}

/**
 * Undoes a failed window ({@link restartOnA}) and returns the error to throw: the cause, that the
 * app runs again on A's bucket with nothing else changed, and the way on.
 */
async function rollBack(
  session: MoveSession,
  environment: MoveEnvironment,
  host: AppHost,
  cause: unknown,
  backToA: () => Promise<void>,
): Promise<OpsCrewError> {
  const deps = environmentDeps(session, environment);
  const reason = deps.redactor.redact(failureReason(cause));
  await audit(session, environment, {
    action: "window",
    decision: "refused",
    detail: `${environment.environment}: maintenance window failed: ${reason}`,
  });
  deps.reporter.warn(
    `The maintenance window failed: ${reason}. OpsCrew puts the current Cloudflare account's settings back and starts the app again.`,
  );
  try {
    await restartOnA(session, environment, host, backToA);
  } catch (error) {
    if (error instanceof OpsCrewError) return error;
    throw error;
  }
  return new OpsCrewError(
    codeOf(cause),
    `The maintenance window failed: ${reason}. ${upperFirst(appWords(environment))} runs again on the current Cloudflare account's bucket, and nothing else changed.`,
    {
      hint: `${hintOf(cause)}Then run \`${session.command}\` again: it repeats the maintenance window.`,
    },
  );
}

/**
 * Empties the environment's R2 buckets in the account of `side`, each after its own `remote-exec`
 * approval with `allowDestroy` and the bucket's name typed, bound to the step's hash: at the
 * finish A's (`a`), each only once `rclone check --one-way --checksum` shows that B's bucket holds
 * every file of it; at an abort B's (`b`), without the check. `rclone delete` removes the files;
 * the bucket itself goes with its root's destroy plan. An empty bucket is skipped. A script stops
 * with the hash (`--confirm <bucket> --approve <hash>`), one bucket at a time.
 */
export async function emptyBuckets(
  session: MoveSession,
  environment: MoveEnvironment,
  side: BucketSide,
): Promise<StepStop | undefined> {
  const buckets = moveBuckets(environment.plan);
  if (buckets.length === 0) return undefined;
  const deps = environmentDeps(session, environment);
  // Each bucket's key in the account emptied (`own`), and B's, which the finish's check reads too.
  const keyed: { bucket: MoveBucket; own: StorageLogin; b: StorageLogin }[] = [];
  for (const bucket of buckets) {
    const b = await bucketKey(session, environment, bucket, "b");
    const own = side === "a" ? await bucketKey(session, environment, bucket, "a") : b;
    keyed.push({ bucket, own, b });
  }
  const host = await appHost(session, environment);
  const where = accountWords(session, side);
  for (const { bucket, own, b } of keyed) {
    const { count } = await sizeOf(session, host, bucket, side, own);
    if (count === 0) {
      deps.reporter.success(`The bucket ${bucket.bucket} in ${where} is empty.`);
      continue;
    }
    if (side === "a") {
      deps.reporter.step(
        `Checking that the bucket ${bucket.bucket} in ${accountWords(session, "b")} holds every file of it in ${where}`,
      );
      await host.rclone({
        args: ["check", `a:${bucket.bucket}`, `b:${bucket.bucket}`, "--one-way", "--checksum"],
        config: [...remoteOf(session, "a", own), ...remoteOf(session, "b", b)],
        timeoutMs: COPY_TIMEOUT_MS,
        what: `Checking that the new Cloudflare account's bucket ${bucket.bucket} holds every file of the current one's`,
        hint: `Nothing was deleted: the bucket ${bucket.bucket} in ${where} keeps every file. Compare both buckets in Cloudflare's dashboard, then run \`${session.command}\` again.`,
      });
    }
    const planKey: MovePlanKey = {
      action: side === "a" ? "a-empty" : "abort-empty",
      environment: environment.environment,
      root: bucket.root,
    };
    const hash = sha256Hex(
      canonicalJson({
        action: planKey.action,
        environment: environment.environment,
        app: environment.plan.app.name,
        account: session.accounts[side].accountId,
        bucket: bucket.bucket,
      }),
    );
    const title = `Empty the bucket ${bucket.bucket} in ${where}`;
    const details = [
      `Every file of ${bucketWords(bucket)} in ${where} (${plural(count, "object")}) is deleted with rclone delete in a one-off container on ${host.words}, its key ${host.keys}. This cannot be undone.`,
      ...(side === "a"
        ? [
            `rclone check read just now that the bucket of the same name in ${accountWords(session, "b")} holds every one of them with the same checksum.`,
          ]
        : []),
      "The bucket itself is deleted afterwards by its own plan. Type the bucket's name to approve.",
    ].join("\n");
    if (!appliesNow(session, hash)) {
      deps.reporter.info(`${title}\n${details}`);
      await writePending(deps, planKey, hash);
      return pendingStop(session, hash, ["--confirm", bucket.bucket], "empty it");
    }
    const approval = await deps.approvals.request({
      kind: "remote-exec",
      title,
      details,
      planHash: hash,
      allowDestroy: true,
      confirmPhrase: bucket.bucket,
    });
    if (!approval.approved) {
      throw new OpsCrewError(
        "APPROVAL_REFUSED",
        `The bucket ${bucket.bucket} in ${where} was not emptied. Nothing was deleted.`,
        {
          hint: `Run \`${session.command}\` again when you are ready, and type the bucket's name to approve (\`--confirm ${bucket.bucket}\` in scripts).`,
        },
      );
    }
    deps.reporter.step(`Emptying the bucket ${bucket.bucket} in ${where}`);
    await host.rclone({
      args: ["delete", `${side}:${bucket.bucket}`],
      config: remoteOf(session, side, own),
      timeoutMs: COPY_TIMEOUT_MS,
      what: `Emptying the bucket ${bucket.bucket}`,
      hint: `Check the key of the bucket ${bucket.bucket} in ${where}, then run \`${session.command}\` again: it deletes what is left.`,
    });
    await audit(session, environment, {
      action: "bucket emptied",
      decision: "approved",
      detail: `${environment.environment}: emptied the bucket ${bucket.bucket} in ${where} with rclone`,
    });
    await clearPending(deps, planKey);
    deps.reporter.success(`Emptied the bucket ${bucket.bucket} in ${where}.`);
  }
  return undefined;
}
