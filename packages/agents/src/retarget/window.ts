import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import { listText, OpsCrewError, replaceNames, upperFirst, writeFileAtomic } from "@opscrew/core";
import { checkEnvironmentKey, portainerStackName, ROLLBACK_INPUTS } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  monitoringServerName,
  type Retarget,
  serviceOf,
  servicesOn,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { changeCheckPause } from "../check/pause";
import { failureReason } from "../destroy/deletion";
import { commandFlags } from "../environments/choice";
import { withDeploysPaused } from "../move/deploys";
import { shortImage } from "../rollback/versions";
import { pollUntil, readServerAddresses, readValidJson, type ServerAddress } from "../shared";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { deployPauseOf, rotationPauseRefusal } from "../shared/deploy-pause";
import { codeOf, hintOf } from "../shared/errors";
import {
  type BucketKeys,
  bucketKeys,
  copyBucket,
  type MovingBucket,
  measureBucket,
  movingBucket,
  syncMinutes,
} from "./bucket";
import { type MountDelta, mountDelta } from "./delta";
import type { DeployedState } from "./server-ops";
import { assertDistinctServers } from "./servers";
import {
  auditMove,
  auditStep,
  type MoveBase,
  type MoveSession,
  moveOf,
  saveMove,
  waitsOf,
} from "./session";
import { composeProject, moveSide, sideWords } from "./sides";
import {
  checkCopiedDump,
  dumpPostgres,
  emptyPostgres,
  ensureDumpVolume,
  type MovePostgres,
  moveDumpVolume,
  removeDumpVolume,
  restoreCheckedDump,
} from "./sides/postgres";
import type { MoveSide, SideDocker, SideSource } from "./sides/types";
import { markerWorkflowStop, runDeployWorkflow } from "./steps";
import {
  ABORT_COMMAND,
  approveCommand,
  downtimeUntilDnsChange,
  MAINTENANCE_WINDOW_TITLE,
  type MoveSizes,
  manualSwitchDowntime,
  moveMinutes,
  RUN_COMMAND,
  sizeText,
  untilSwitched,
} from "./texts";
import type { RetargetOptions, RetargetResult } from "./types";

/** Steps in order; a step at or after `migrated` has the data on the new side. */
const STEPS: readonly Retarget["step"][] = [
  "started",
  "renamed",
  "created",
  "deployed",
  "migrated",
  "switched",
];

/** Position of `step` in the move (0 = started). */
export function stepIndex(step: Retarget["step"]): number {
  return STEPS.indexOf(step);
}

/** True when `step` comes before `other`. */
export function stepBefore(step: Retarget["step"], other: Retarget["step"]): boolean {
  return stepIndex(step) < stepIndex(other);
}

const HEALTH_WAIT_MS = 5 * 60_000;

/** The stateful services on the app's server, which stop and start around the copy. */
function statefulServices(plan: DeployPlan): string[] {
  return servicesOn(plan, APP_SERVER).map((service) => service.name);
}

/**
 * True when the move copies data (first while the old side serves, then what changed in its
 * window): a service on the app's server, the app's own SQLite file or kept folder, or monitoring
 * on the app's server, any of them not started empty, or the bucket the move takes along.
 */
export function copiesData(plan: DeployPlan): boolean {
  const empty = new Set(plan.retarget?.empty ?? []);
  return (
    movingBucket(plan) !== undefined ||
    statefulServices(plan).some((name) => !empty.has(name)) ||
    ((plan.storage?.sqlite !== undefined || plan.storage?.files !== undefined) &&
      !empty.has("app")) ||
    (monitoringServerName(plan) === APP_SERVER && !empty.has("monitoring"))
  );
}

/** The Postgres service on the app's server: a move copies its database by its dump. */
export function movedPostgres(plan: DeployPlan): string | undefined {
  const db = serviceOf(plan, "postgres");
  return db !== undefined && (db.server ?? APP_SERVER) === APP_SERVER ? db.name : undefined;
}

/** One mount the window copies, where it is on each side. */
interface MountCopy {
  owner: string;
  key: string;
  bytes: number;
  from: SideSource;
  to: SideSource;
}

/** What the window does: the mounts it copies, Postgres's dump, the services it stops. */
interface WindowPlan {
  copies: MountCopy[];
  /** The Postgres service whose database is dumped and restored, unless it starts empty. */
  postgres: string | undefined;
  /** The bytes copied, Postgres's data folder counting for its dump. */
  bytes: number;
  services: string[];
}

/** True when the window copies mounts or the database (not only a bucket's last copy). */
function hasData(window: WindowPlan): boolean {
  return window.copies.length > 0 || window.postgres !== undefined;
}

/** The window's data by how it is copied: its mounts' files, and Postgres's folder by its dump. */
function sizesOf(window: WindowPlan): MoveSizes {
  const files = window.copies.reduce((sum, copy) => sum + copy.bytes, 0);
  return { files, postgres: window.bytes - files };
}

/** A mount in words: `db's data at /var/lib/postgresql/data`, `the app's files at /data`. */
export function mountWords(mount: Pick<MountCopy, "owner" | "key">): string {
  return `${mount.owner === "app" ? "the app's" : `${mount.owner}'s`} data at ${mount.key}`;
}

/**
 * What the window copies: each data mount on the old side whose owner does not start empty,
 * paired with the new side's mount of the same owner and key (never by name). Postgres's own data
 * folder is not copied: its dump is. Stops before any change when the new side has no such mount.
 */
async function planWindow(session: MoveBase, old: MoveSide, fresh: MoveSide): Promise<WindowPlan> {
  const { plan } = session;
  const move = moveOf(session);
  const empty = new Set(move.empty);
  const db = movedPostgres(plan);
  const postgres = db !== undefined && !empty.has(db) ? db : undefined;
  const oldMounts = (await old.volumes(session)).filter((mount) => !empty.has(mount.owner));
  const newMounts = await fresh.volumes(session);
  const copies: MountCopy[] = [];
  const missing: string[] = [];
  let bytes = 0;
  for (const mount of oldMounts) {
    bytes += mount.bytes;
    if (mount.owner === postgres) continue;
    const to = newMounts.find((m) => m.owner === mount.owner && m.key === mount.key);
    if (to === undefined) {
      missing.push(mountWords(mount));
      continue;
    }
    copies.push({ ...mount, from: mount.source, to: to.source });
  }
  if (missing.length > 0) {
    const fresh = sideWords(plan.target, "new");
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${upperFirst(fresh)} has no place for ${listText(missing)}, so OpsCrew cannot copy it there. Nothing was changed; the app on ${sideWords(move.from.target, "old")} keeps running.`,
      {
        hint: `The app deployed there differs from the one on the old side. Run \`${RUN_COMMAND}\` again once the deploy there has finished, or start that data empty with \`--empty <service>\` (\`${ABORT_COMMAND}\` and start the move again).`,
      },
    );
  }
  return { copies, postgres, bytes, services: statefulServices(plan) };
}

/**
 * Postgres's login on one side: the app's `app` user, its generated password (registered with the
 * redactor) and the Compose project the one-off containers join (`opscrew-<app>` in Portainer,
 * `<app>` on a server).
 */
async function postgresOn(
  session: MoveBase,
  side: MoveSide,
  service: string,
): Promise<MovePostgres> {
  const { deps, plan } = session;
  const values = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
  const password = values?.dbPassword;
  if (password === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not have the database's password on this computer, so it cannot copy the database. Nothing was changed.",
      {
        hint: `Run \`${RUN_COMMAND}\` on the computer that provisioned the app (it keeps the password in OpsCrew's folder there).`,
      },
    );
  }
  deps.redactor.addLiteral(password, "app-env");
  return { app: plan.app.name, project: composeProject(side, plan), service, password };
}

/**
 * The approval's list of what the window does, on both sides (never an address), after the data
 * was copied while the old side served (on a `server`, with the app started there on that copy):
 * only what changed since is copied, and the app starts again in place, with no workflow run.
 */
function windowCommands(
  session: MoveBase,
  window: WindowPlan,
  minutes: number,
  bucket: MovingBucket | undefined,
  server: boolean,
): string[] {
  const { plan } = session;
  const move = moveOf(session);
  const old = sideWords(move.from.target, "old");
  const fresh = sideWords(plan.target, "new");
  const services = window.services.length > 0 ? listText(window.services) : undefined;
  const empty = move.empty;
  const data = hasData(window);
  const before = [
    ...(data ? [`its data (${sizeText(window.bytes)}) was copied to ${fresh}`] : []),
    ...(server ? [`the app started there${data ? " on that copy" : ""} and answered`] : []),
  ];
  return [
    `About ${minutes} minutes.${before.length > 0 ? ` While your app served, ${before.join(", and ")}.` : ""} The window copies only what changed since, through this computer.`,
    `On ${old}:`,
    "  stop the app, its workers and its cron",
    ...(window.postgres !== undefined
      ? [
          `  dump the PostgreSQL database (${window.postgres}) with pg_dump -Fc into the volume ${moveDumpVolume(plan.app.name)}, in a one-off postgres container`,
        ]
      : []),
    ...(services !== undefined ? [`  stop ${services} cleanly`] : []),
    `On ${fresh}:`,
    `  stop the app${services !== undefined ? ` and ${services}` : ""}`,
    ...(bucket !== undefined
      ? [
          `  copy what changed in the bucket ${bucket.old.bucket} since the first copy into the new bucket ${bucket.next.bucket} (rclone sync in a one-off container, the keys on its standard input only)`,
        ]
      : []),
    ...(data
      ? [
          "Copy, each through Docker's archive API, with a SHA-256 of it on both sides that must match:",
          ...window.copies.map(
            (copy) =>
              `  what changed in ${mountWords(copy)} since the first copy (${sizeText(copy.bytes)} in all)`,
          ),
          ...(window.postgres !== undefined ? ["  the database dump"] : []),
        ]
      : []),
    `On ${fresh}:`,
    ...(services !== undefined ? [`  start ${services}`] : []),
    ...(window.postgres !== undefined
      ? [
          "  recreate the database empty and restore the dump into it (pg_restore --single-transaction)",
        ]
      : []),
    ...(plan.app.releaseCommand !== undefined
      ? [
          "  run the release command (app.releaseCommand) on the final data, which migrates it to the version deployed there",
        ]
      : []),
    ...(window.postgres !== undefined ? ["  remove the dump volume (on both sides)"] : []),
    "  start the app again, its workers and cron, then check its health route",
    ...(server
      ? ["  let the deploys there run as before the move (remove the move's marker)"]
      : []),
    ...(empty.length > 0 ? [`Starting empty there: ${listText(empty)}.`] : []),
    `If any of these fails, OpsCrew empties what it wrote on ${fresh}, removes the dump volumes${server ? `, holds the app on ${fresh} for its data again` : ""} and starts the services and the app on ${old} again.`,
  ];
}

/**
 * The image the new side's deploy left (`.env`, a server's: `deployed`), which the deploy before
 * the window puts on the data copied while the old side serves; none for Portainer's side. Stops
 * before any change when `.env` names none.
 */
function imageForWindow(
  session: MoveBase,
  deployed: DeployedState | undefined,
): string | undefined {
  if (deployed === undefined) return undefined;
  const { image } = deployed;
  if (image !== undefined) return image;
  const words = sideWords(session.plan.target, "new");
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew can't tell which version of the app the deploy put on ${words} (its .env in the app's folder names no image by digest), so it did not start copying the app's data there. Nothing was changed; the app on ${sideWords(moveOf(session).from.target, "old")} keeps running.`,
    {
      hint: `Push a commit, or run the deploy workflow on ${session.plan.cicd.branch}: the deploy secrets point to ${words}. Then run \`${RUN_COMMAND}\` again, or \`${ABORT_COMMAND}\` to undo the move.`,
    },
  );
}

/** A run that stops on purpose (nothing is broken): what to do next. */
function stopped(session: MoveSession, next: string[]): RetargetResult {
  return { step: moveOf(session).step, done: false, next };
}

/** An empty archive: writing it empties a mount. */
function emptyArchive(): Readable {
  return Readable.from([Buffer.alloc(1024)], { objectMode: false });
}

/**
 * Copies what changed in one mount since the first copy ({@link mountDelta} of both sides'
 * manifests): the paths only the new side has removed there, and the paths that differ read on the
 * old side and put over the new side's mount. False when the carrier refuses to list or gather
 * them (`INVALID_INPUT`: a name it can't list, too little free disk on the old side to gather the
 * changes): nothing was written then.
 */
async function copyChanges(
  docker: { old: SideDocker; fresh: SideDocker },
  copy: MountCopy,
): Promise<boolean> {
  let delta: MountDelta;
  let archive: Readable;
  try {
    const [old, fresh] = await Promise.all([
      docker.old.carrier.volumeManifest(copy.from),
      docker.fresh.carrier.volumeManifest(copy.to),
    ]);
    delta = mountDelta(old, fresh);
    if (delta.copy.length === 0 && delta.remove.length === 0) return true;
    // The archive always holds the root folder, also when only removals are left.
    archive = await docker.old.carrier.readPaths(copy.from, delta.copy);
  } catch (error) {
    if (error instanceof OpsCrewError && error.code === "INVALID_INPUT") return false;
    throw error;
  }
  await docker.fresh.carrier.updateVolume(copy.to, archive, delta.remove);
  return true;
}

/**
 * Copies what changed in one mount since the first copy ({@link copyChanges}; one the carrier
 * can't do that for is copied whole), between its digest on the old side and its digest on the
 * new side, which must match.
 */
async function copyMount(
  session: MoveBase,
  docker: { old: SideDocker; fresh: SideDocker },
  copy: MountCopy,
): Promise<void> {
  const before = await docker.old.carrier.volumeDigest(copy.from);
  if (!(await copyChanges(docker, copy))) {
    session.deps.reporter.info(
      `OpsCrew can't copy only what changed in ${mountWords(copy)} (a name in it can't be listed, or ${sideWords(moveOf(session).from.target, "old")} has too little free disk to gather the changes), so it copies it whole (${sizeText(copy.bytes)}).`,
    );
    await docker.fresh.carrier.writeVolume(copy.to, await docker.old.carrier.readVolume(copy.from));
  }
  const after = await docker.fresh.carrier.volumeDigest(copy.to);
  if (before !== after) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The copy of ${mountWords(copy)} on ${sideWords(session.plan.target, "new")} differs from the data on ${sideWords(moveOf(session).from.target, "old")}: their SHA-256 digests do not match.`,
      {
        hint: `Check the free disk space on the new side; \`${RUN_COMMAND}\` copies it again.`,
      },
    );
  }
}

/**
 * `.opscrew/retarget-precopied.json`: the move (its `startedAt`) whose data {@link preCopy} copied
 * to the new side while the old side served, until its window is done. Machine-local.
 */
function preCopiedFile(session: Pick<MoveBase, "deps">): string {
  return join(session.deps.paths.stateDir, "retarget-precopied.json");
}

/** True when this move's data was copied to the new side while the old side served. */
async function preCopiedInThisMove(session: MoveBase): Promise<boolean> {
  const startedAt = await readValidJson(preCopiedFile(session), z.string());
  return startedAt === moveOf(session).startedAt;
}

/**
 * The maintenance window (plan.md "3."), when the move copies data: the data's sizes → on a
 * server, GitHub's workflow must know the move's marker, or the move stops with its pull request
 * → the data copied while the old side serves ({@link preCopy}, once per move: a run stopped at
 * the window's approval doesn't copy again) → the window's minutes and one `remote-exec` approval
 * listing both sides' steps (scripts need `allowDowntime`) → the scheduled check paused →
 * `oldAppStoppedAt` → the old app stops → Postgres is dumped into the dump volume while it still
 * runs → the old services stop → the new app and services stop → what changed in each mount since
 * the first copy is copied with the carrier ({@link copyMount}: the digests must match), and the
 * dump volume → the new services start → Postgres is recreated and restored → the release command
 * runs on the final data, the dump volumes go, and the app starts again in place and answers; on a
 * server the move's marker goes. No workflow runs in the window → `migrated`. Any failure empties
 * the mounts written on the new side, removes the dump volumes, stops the new side's app and
 * services (on a server its marker back to waiting), then starts the old side's services and app,
 * and stops with the cause: the step stays `deployed`. Nothing to copy: no window (`done` at once),
 * but a server's deploy that waits for data starts the app with {@link startWithoutCopy}.
 */
export async function maintenanceWindow(
  session: MoveSession,
  options: Pick<RetargetOptions, "allowDowntime">,
  /** The approved switch plan that follows the window, named again when a script must re-run. */
  switchPlanHash?: string,
): Promise<"done" | RetargetResult> {
  const { deps, plan } = session;
  // Before any command reaches a side: the window replaces the new side's data.
  assertDistinctServers(session.servers, session.command);
  const old = moveSide(session, "old");
  const fresh = moveSide(session, "new");
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");

  deps.reporter.step(`Measuring the app's data on ${oldWords}`);
  const window = await planWindow(session, old, fresh);
  const bucket = movingBucket(plan);
  // A server's new side starts the app with a deploy of the image its deploy left there, which
  // needs a deploy workflow on GitHub that knows the move's marker (FR-3027).
  const deployed = await fresh.deployed?.(session);
  if (deployed !== undefined) {
    const stop = await markerWorkflowStop(session);
    if (stop !== undefined) return stop;
  }
  const nothing =
    window.copies.length === 0 && window.postgres === undefined && bucket === undefined;
  // A deploy that waits for data starts the app anyway, with a deploy of its own.
  const waiting = deployed?.waiting === true ? deployed.image : undefined;
  if (nothing && waiting === undefined) return "done";
  // A credential rotation's pause holds the deploys until it ends; the move's would end it.
  const paused = await deployPauseOf(session.github, plan);
  if (paused?.reason === "rotation") {
    const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
    throw await rotationPauseRefusal(deps, {
      environment: checkEnvironmentKey(plan),
      pause: paused,
      flags,
      why: `and the move needs the app's deploys to copy its data. Nothing was changed; the app on ${oldWords} keeps running.`,
      command: RUN_COMMAND,
    });
  }
  if (nothing && waiting !== undefined) {
    await startWithoutCopy(session, fresh, waiting);
    return "done";
  }
  // The database's logins and the buckets' keys, before anything is asked or changed.
  const db = window.postgres;
  const logins =
    db === undefined
      ? undefined
      : { old: await postgresOn(session, old, db), fresh: await postgresOn(session, fresh, db) };
  const keys = bucket === undefined ? undefined : await bucketKeys(session, bucket);
  // The bucket's last copy compares each of its objects: its count, read before the window.
  const sync =
    bucket === undefined || keys === undefined
      ? undefined
      : { keys, minutes: syncMinutes((await measureBucket(session, bucket, keys.old)).count) };
  const image = imageForWindow(session, deployed);
  const server = image !== undefined;
  const estimate = moveMinutes(sizesOf(window), {
    portainer: old.kind === "portainer" || fresh.kind === "portainer",
    server,
  });
  // The first copy, while the old side serves: once per move.
  const preCopies = hasData(window) || server;
  if (preCopies && !(await preCopiedInThisMove(session))) {
    await preCopy(session, { old, fresh, window, logins, image, minutes: estimate.preCopy });
  }
  const minutes = estimate.window + (sync?.minutes ?? 0);
  const downtime = `about ${minutes} minutes`;
  // Without managed DNS the old app stays stopped after the copy until the user's switch is live.
  const byHand = downtimeUntilDnsChange(plan, true);
  const warning = manualSwitchDowntime(plan, { old: oldWords, fresh: freshWords }, true);
  deps.reporter.info(
    byHand
      ? `The maintenance window copies only what changed in the app's data since, in ${downtime}; the app is offline from then ${untilSwitched(plan)}.`
      : `The maintenance window copies only what changed in the app's data since, in ${downtime}; the app is offline for that long.`,
  );
  if (!deps.interactive && options.allowDowntime !== true) {
    const command =
      switchPlanHash === undefined
        ? `${RUN_COMMAND} --allow-downtime`
        : approveCommand(RUN_COMMAND, switchPlanHash, ["--allow-downtime"]);
    return {
      ...stopped(session, [
        byHand
          ? `The next step stops ${plan.app.name} on ${oldWords} while what changed in its data is copied to ${freshWords} (${downtime}), and it stays stopped ${untilSwitched(plan)}.`
          : `The next step stops ${plan.app.name} on ${oldWords} for ${downtime} while what changed in its data is copied to ${freshWords}.`,
        ...warning,
        `Run \`${command}\` when that is acceptable, or \`${ABORT_COMMAND}\` to undo the move.`,
      ]),
      ...(switchPlanHash !== undefined ? { pendingPlanHash: switchPlanHash } : {}),
    };
  }
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `${MAINTENANCE_WINDOW_TITLE} stop ${plan.app.name} on ${oldWords} and copy what changed in its data${hasData(window) ? ` (${sizeText(window.bytes)}, copied while your app served)` : ""} to ${freshWords} (${byHand ? `downtime: ${downtime} for the copy, plus ${plan.dns.domain !== undefined ? "your DNS change" : "your users' move to the new address"}` : `${downtime} of downtime`})`,
    details: [
      ...windowCommands(session, window, minutes, bucket, server),
      ...(byHand ? ["", ...warning] : []),
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The maintenance window was not approved. The app on ${oldWords} keeps running; the copy of its data on ${freshWords} stays for the next run.`,
      {
        hint: `Run \`${RUN_COMMAND}\` again when the downtime is acceptable (\`--allow-downtime\` in scripts), or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }

  // The scheduled check opens no issue while the app is offline for the window.
  if ((await changeCheckPause(deps, session.github, plan, "retarget", "retarget")) === "refused") {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The scheduled check was not paused, so it would open an issue while the app is offline for the copy. Nothing was changed; the app on ${oldWords} keeps running.`,
      {
        hint: `Run \`${RUN_COMMAND}\` again and approve the pause, or \`${ABORT_COMMAND}\` to undo the move.`,
      },
    );
  }
  const docker = { old: await old.docker(session), fresh: await fresh.docker(session) };
  const clean = await withoutAddresses(session);
  try {
    // No deploy runs during the window: each would restart the app on one side or the other.
    await withDeploysPaused(deps, session.github, plan, session.services, RUN_COMMAND, () =>
      runWindow(session, { old, fresh, docker, window, minutes, logins, sync, clean }),
    );
  } finally {
    await docker.old.close();
    await docker.fresh.close();
  }
  await saveMove(session, { ...moveOf(session), step: "migrated" });
  await rm(preCopiedFile(session), { force: true });
  deps.reporter.success(
    `The app's data is on ${freshWords} and the app answers there. The app on ${oldWords} stays stopped.`,
  );
  await auditStep(session, "migrated", `data copied to ${freshWords}; the old app stays stopped`);
  return "done";
}

/**
 * The first copy of the move's data (plan.md "3."), before the window, while the old side serves
 * and with the deploys paused: the new side's app and the services whose data is copied stop,
 * each mount is copied whole, those services start, and the database is dumped on the old side
 * (consistent while it runs), copied and restored on the new side; on a server ({@link startOnData}
 * with `image`), the deploy then runs the release command on that copy and starts the app, which
 * must answer. Recorded once done ({@link preCopiedFile}). On failure the new side's app stops, a
 * server's marker holds it for its data again and its edge stays stopped, the dump volumes go, and
 * the move stops with the cause: nothing of the old side was stopped, and a rerun copies again.
 */
async function preCopy(
  session: MoveSession,
  ctx: {
    old: MoveSide;
    fresh: MoveSide;
    window: WindowPlan;
    logins: { old: MovePostgres; fresh: MovePostgres } | undefined;
    image: string | undefined;
    minutes: number;
  },
): Promise<void> {
  const { deps, plan } = session;
  const { old, fresh, window, logins, image } = ctx;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  const app = plan.app.name;
  // The new side's Postgres keeps running: its database is restored, not copied as files.
  const freshServices = window.services.filter((name) => name !== window.postgres);
  const data = hasData(window);
  deps.reporter.info(
    data
      ? `OpsCrew copies the app's data (${sizeText(window.bytes)}) to ${freshWords} while your app serves (about ${ctx.minutes} minutes); the app on ${oldWords} keeps running.`
      : `OpsCrew starts the app on ${freshWords} with its deploy while your app serves (about ${ctx.minutes} minutes); the app on ${oldWords} keeps running.`,
  );
  const audited: Audited = async (action, where, run) => {
    await run();
    await auditMove(session, {
      kind: "remote-exec",
      action,
      target: where,
      decision: "approved",
      detail: "while the app serves, before the maintenance window",
    });
  };
  const docker = { old: await old.docker(session), fresh: await fresh.docker(session) };
  const clean = await withoutAddresses(session);
  let started = false;
  try {
    await withDeploysPaused(deps, session.github, plan, session.services, RUN_COMMAND, async () => {
      await audited("stop app", freshWords, () => fresh.stopApp(session));
      await audited("stop services", freshWords, () => fresh.stopServices(session, freshServices));
      for (const copy of window.copies) {
        deps.reporter.step(
          `Copying ${mountWords(copy)} (${sizeText(copy.bytes)}) to ${freshWords} while your app serves`,
        );
        await audited(`copy ${copy.owner} ${copy.key}`, freshWords, async () =>
          docker.fresh.carrier.writeVolume(copy.to, await docker.old.carrier.readVolume(copy.from)),
        );
      }
      await audited("start services", freshWords, () =>
        fresh.startServices(session, freshServices),
      );
      if (window.postgres !== undefined && logins !== undefined) {
        deps.reporter.step(
          `Copying the database (${window.postgres}) to ${freshWords} while your app serves`,
        );
        let dump = "";
        await ensureDumpVolume(docker.fresh.client, app);
        await audited("dump database", oldWords, async () => {
          dump = await dumpPostgres(docker.old, logins.old);
        });
        const volume: SideSource = { kind: "volume", name: moveDumpVolume(app) };
        await audited("copy database dump", freshWords, async () => {
          await docker.fresh.carrier.writeVolume(
            volume,
            await docker.old.carrier.readVolume(volume),
          );
        });
        await checkCopiedDump(docker.fresh, logins.fresh, dump);
        await audited("restore database", freshWords, () =>
          restoreCheckedDump(docker.fresh, logins.fresh, waitsOf(session.services)),
        );
        await audited("remove database dump", oldWords, () =>
          removeDumpVolume(docker.old.client, app),
        );
        await audited("remove database dump", freshWords, () =>
          removeDumpVolume(docker.fresh.client, app),
        );
      }
      if (image !== undefined) {
        started = true;
        await startOnData(session, { fresh, image, audited });
      }
    });
  } catch (error) {
    throw await rollBackPreCopy(session, error, { fresh, docker, window, started, clean });
  } finally {
    await docker.old.close();
    await docker.fresh.close();
  }
  await writeFileAtomic(preCopiedFile(session), `${JSON.stringify(moveOf(session).startedAt)}\n`);
  deps.reporter.success(
    `${image === undefined ? `The app's data is copied to ${freshWords}` : `The app answers on ${freshWords}${data ? " on its data copied" : ""}`} while your app serves; the maintenance window copies only what changed since.`,
  );
}

/**
 * Undoes a failed {@link preCopy} on the new side and returns the error to throw: its app stops, a
 * server's marker holds it for its data again with its edge stopped (`started`: the deploy may
 * have started it), and the dump volumes go. The old side was only read.
 */
async function rollBackPreCopy(
  session: MoveSession,
  cause: unknown,
  ctx: {
    fresh: MoveSide;
    docker: { old: SideDocker; fresh: SideDocker };
    window: WindowPlan;
    started: boolean;
    clean: (text: string) => string;
  },
): Promise<OpsCrewError> {
  const { deps, plan } = session;
  const { clean, docker, fresh } = ctx;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  const reason = clean(deps.redactor.redact(failureReason(cause)));
  await auditMove(session, {
    kind: "remote-exec",
    action: "copy while the app serves",
    target: freshWords,
    decision: "refused",
    detail: `copying the app's data while it serves failed: ${reason}`,
  });
  await quietly(session, clean, `stop the app on ${freshWords}`, () => fresh.stopApp(session));
  if (ctx.started) {
    await quietly(session, clean, `hold the app on ${freshWords} for its data again`, async () =>
      fresh.markMove?.(session, "waiting"),
    );
    await quietly(session, clean, `stop the web server on ${freshWords}`, () =>
      fresh.stopEdge(session),
    );
  }
  if (ctx.window.postgres !== undefined) {
    await quietly(session, clean, `remove the database dump on ${oldWords}`, () =>
      removeDumpVolume(docker.old.client, plan.app.name),
    );
    await quietly(session, clean, `remove the database dump on ${freshWords}`, () =>
      removeDumpVolume(docker.fresh.client, plan.app.name),
    );
  }
  return new OpsCrewError(
    codeOf(cause),
    `Copying the app's data to ${freshWords} while your app serves failed: ${reason}. The app on ${oldWords} kept serving: nothing there was stopped.`,
    {
      hint: clean(
        `${hintOf(cause)}Then run \`${RUN_COMMAND}\` again (it copies the data again while your app serves), or \`${ABORT_COMMAND}\` to undo the move.`,
      ),
    },
  );
}

/**
 * A function that puts each side's words in place of its addresses (its public address and the
 * login of the user's own server): ssh's and Docker's own messages may name them.
 */
async function withoutAddresses(session: MoveBase): Promise<(text: string) => string> {
  const local = await readServerAddresses(session.deps.paths);
  const { from, next } = session.servers;
  const names = (
    address: ServerAddress | undefined,
    login: { host: string } | undefined,
  ): string[] =>
    [address?.ipv4, address?.ipv6, login?.host].filter((name): name is string => !!name);
  const old = names(from, local.retarget?.fromOwn);
  const fresh = names(next, local.own);
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(session.plan.target, "new");
  return (text) => replaceNames(replaceNames(text, old, oldWords), fresh, freshWords);
}

/** The window's changes, from `oldAppStoppedAt` on; any failure rolls them back. */
async function runWindow(
  session: MoveSession,
  ctx: {
    old: MoveSide;
    fresh: MoveSide;
    docker: { old: SideDocker; fresh: SideDocker };
    window: WindowPlan;
    minutes: number;
    /** The database's logins on each side, when it is copied. */
    logins: { old: MovePostgres; fresh: MovePostgres } | undefined;
    /** The bucket's last copy (its keys and minutes), when the move takes the bucket along. */
    sync: { keys: BucketKeys; minutes: number } | undefined;
    clean: (text: string) => string;
  },
): Promise<void> {
  const { deps, plan } = session;
  const { old, fresh, docker, window, logins, sync } = ctx;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  // The new side's Postgres keeps running: its data is not copied, its database is restored.
  const freshServices = window.services.filter((name) => name !== window.postgres);
  await saveMove(session, { ...moveOf(session), oldAppStoppedAt: deps.clock.now().toISOString() });
  await auditMove(session, {
    kind: "remote-exec",
    action: "maintenance window",
    target: oldWords,
    decision: "approved",
    detail: `maintenance window started: ${window.bytes} bytes of data, about ${ctx.minutes} minutes`,
  });
  const audited: Audited = async (action, where, run) => {
    await run();
    await auditMove(session, { kind: "remote-exec", action, target: where, decision: "approved" });
  };
  /** What the window changed on the new side so far: a rollback undoes it. */
  const changed: Changed = { written: [], restoring: false };
  const app = plan.app.name;
  try {
    deps.reporter.step(`Stopping ${app} on ${oldWords}`);
    await audited("stop app", oldWords, () => old.stopApp(session));
    let dump: string | undefined;
    if (window.postgres !== undefined && logins !== undefined) {
      deps.reporter.step(`Dumping the database (${window.postgres}) on ${oldWords}`);
      await ensureDumpVolume(docker.fresh.client, app);
      await audited("dump database", oldWords, async () => {
        dump = await dumpPostgres(docker.old, logins.old);
      });
    }
    await audited("stop services", oldWords, async () => {
      await old.stopServices(session, window.services);
      await requireCleanStop(session, old, docker.old, window.services);
    });
    await audited("stop app", freshWords, () => fresh.stopApp(session));
    await audited("stop services", freshWords, () => fresh.stopServices(session, freshServices));
    // The bucket's last copy: nothing writes to it while the old app is stopped.
    if (sync !== undefined) {
      await copyBucket(session, "sync", sync.keys, (3 * sync.minutes + 5) * 60_000);
    }
    for (const copy of window.copies) {
      deps.reporter.step(`Copying what changed in ${mountWords(copy)} to ${freshWords}`);
      changed.written.push(copy);
      await audited(`copy ${copy.owner} ${copy.key}`, freshWords, () =>
        copyMount(session, docker, copy),
      );
    }
    if (dump !== undefined) {
      const volume: SideSource = { kind: "volume", name: moveDumpVolume(app) };
      deps.reporter.step(`Copying the database dump to ${freshWords}`);
      await audited("copy database dump", freshWords, async () => {
        await docker.fresh.carrier.writeVolume(volume, await docker.old.carrier.readVolume(volume));
      });
    }
    await audited("start services", freshWords, () => fresh.startServices(session, freshServices));
    if (window.postgres !== undefined && logins !== undefined && dump !== undefined) {
      const sha = dump;
      deps.reporter.step(`Restoring the database (${window.postgres}) on ${freshWords}`);
      // The copy is checked against the old side's dump before the database is dropped.
      await checkCopiedDump(docker.fresh, logins.fresh, sha);
      changed.restoring = true;
      await audited("restore database", freshWords, () =>
        restoreCheckedDump(docker.fresh, logins.fresh, waitsOf(session.services)),
      );
    }
    // The release command on the final data: the version deployed there migrates it forward.
    if (plan.app.releaseCommand !== undefined) {
      deps.reporter.step(
        `Running the release command (app.releaseCommand) on the final data, migrating it to the version on ${freshWords}`,
      );
    }
    await audited("run release command", freshWords, () => fresh.release(session, window.bytes));
    if (window.postgres !== undefined) {
      await audited("remove database dump", oldWords, () =>
        removeDumpVolume(docker.old.client, app),
      );
      await audited("remove database dump", freshWords, () =>
        removeDumpVolume(docker.fresh.client, app),
      );
    }
    // In place: the app's container and its route are the ones the deploy before the window left.
    deps.reporter.step(`Starting the app on ${freshWords} again`);
    await audited("start app", freshWords, () => fresh.startApp(session));
    await waitHealthy(session, fresh);
    if (fresh.markMove !== undefined) {
      await audited("remove the move's marker", freshWords, async () =>
        fresh.markMove?.(session, undefined),
      );
    }
  } catch (error) {
    throw await rollBackWindow(session, error, { ...ctx, freshServices, changed });
  }
}

/** Runs `run`, then records `action` on `where` in the audit log. */
type Audited = (action: string, where: string, run: () => Promise<void>) => Promise<void>;

/**
 * A server's new side, once data is there (FR-3027): the move's marker says `copied`, so the
 * deploy workflow's run with `image`'s digest (no build, and not a rollback) runs the release
 * command on that data, switches to the app and starts its workers and cron, and leaves the check
 * to the move: the app's domain still leads to the old side. Its start of the edge is undone (the
 * edge stays stopped until the switch, as the move's deploy step left it), and the app must answer
 * on the server.
 */
async function startOnData(
  session: MoveSession,
  ctx: { fresh: MoveSide; image: string; audited: Audited },
): Promise<void> {
  const { fresh, image, audited } = ctx;
  const words = sideWords(session.plan.target, "new");
  await audited("let the deploys start the app on its data", words, async () =>
    fresh.markMove?.(session, "copied"),
  );
  await runDeployWorkflow(session, {
    inputs: {
      [ROLLBACK_INPUTS.digest]: image.slice(image.indexOf("@") + 1),
      [ROLLBACK_INPUTS.rollback]: "false",
    },
    purpose: `with the image deployed on ${words} (${shortImage(image)}), on its data`,
    still: `It ran on ${words} only; your users' data on ${sideWords(moveOf(session).from.target, "old")} is untouched.`,
    hint: `Open the run to see which step failed (the release command's output stays on ${words}, in release.log in the app's folder) and push a fix.`,
  });
  await fresh.stopEdge(session);
  await waitHealthy(session, fresh);
}

/**
 * A server's new side whose deploy waits for data the window found nothing of, with `image`: it
 * starts the app there with {@link startOnData}, with no downtime, as the old side keeps serving,
 * then the marker goes. A failure leaves the deploys there waiting again.
 */
async function startWithoutCopy(
  session: MoveSession,
  fresh: MoveSide,
  image: string,
): Promise<void> {
  const words = sideWords(session.plan.target, "new");
  session.deps.reporter.info(
    `There is no data to copy after all, so OpsCrew starts the app on ${words} with its deploy; the app on ${sideWords(moveOf(session).from.target, "old")} keeps serving meanwhile.`,
  );
  const audited: Audited = async (action, where, run) => {
    await run();
    await auditMove(session, { kind: "remote-exec", action, target: where, decision: "approved" });
  };
  try {
    await startOnData(session, { fresh, image, audited });
  } catch (error) {
    const clean = await withoutAddresses(session);
    await quietly(session, clean, `hold the app on ${words} for its data again`, async () =>
      fresh.markMove?.(session, "waiting"),
    );
    // The deploy may have started the edge: it stays stopped until the switch (a shared one runs).
    await quietly(session, clean, `stop the web server on ${words}`, () => fresh.stopEdge(session));
    throw error;
  }
  await audited("remove the move's marker", words, async () =>
    fresh.markMove?.(session, undefined),
  );
}

/** What a window changed on the new side so far. */
interface Changed {
  /** The new side's mounts that may hold part of a copy. */
  written: MountCopy[];
  /** The restore began: the new side's database may hold part of the copy. */
  restoring: boolean;
}

/** Docker's exit code of a container it killed: at the end of its stop timeout, or out of memory. */
const KILLED = 137;

/**
 * Stops unless each of the old side's stateful services `names` stopped cleanly (T2306), failing
 * closed: only a container that exited on its own (any code but 137) or never ran (`created`)
 * counts. One still running, restarting or paused, or one Docker killed (exit 137: its stop
 * timeout ran out, or it ran out of memory), may have left its files half-written, so they are
 * not copied.
 */
async function requireCleanStop(
  session: MoveBase,
  side: MoveSide,
  docker: SideDocker,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  const { plan } = session;
  const project = composeProject(side, plan);
  const unclean: string[] = [];
  for (const container of await docker.client.listContainers([
    `${COMPOSE_PROJECT_LABEL}=${project}`,
  ])) {
    const service = container.labels[COMPOSE_SERVICE_LABEL] ?? "";
    if (!names.includes(service) || container.state === "created") continue;
    const clean =
      container.state === "exited" && (await docker.client.waitContainer(container.id)) !== KILLED;
    if (!clean) unclean.push(service);
  }
  if (unclean.length === 0) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `${listText(unclean)} did not stop cleanly on ${sideWords(moveOf(session).from.target, "old")} (Docker killed ${unclean.length === 1 ? "it" : "them"} when the 120 seconds to stop ran out or for lack of memory, or ${unclean.length === 1 ? "it" : "they"} did not stop), so OpsCrew does not copy ${unclean.length === 1 ? "its" : "their"} files.`,
    {
      hint: "Check the service's logs there and give it more memory if it ran out, then run the move again.",
    },
  );
}

/** Waits up to 5 minutes for the app to answer its health route on the new side. */
async function waitHealthy(session: MoveBase, fresh: MoveSide): Promise<void> {
  const healthy = await pollUntil(async () => ((await fresh.healthy(session)) ? true : undefined), {
    timeoutMs: HEALTH_WAIT_MS,
    intervalMs: 5000,
    ...waitsOf(session.services),
  });
  if (healthy) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `The app on ${sideWords(session.plan.target, "new")} did not answer on its health route (${session.plan.app.healthPath}) within 5 minutes.`,
    {
      hint: "Look at the app's logs there (as deploy: `docker compose logs --tail 200 app` in the app's folder; in Portainer: the app container's logs).",
    },
  );
}

/**
 * Runs `act`; a failure is only a warning `what` (best effort while rolling back), with the sides'
 * addresses in words (`clean`) and redacted.
 */
async function quietly(
  session: MoveBase,
  clean: (text: string) => string,
  what: string,
  act: () => Promise<void>,
): Promise<void> {
  try {
    await act();
  } catch (error) {
    session.deps.reporter.warn(
      session.deps.redactor.redact(clean(`OpsCrew could not ${what}: ${failureReason(error)}.`)),
    );
  }
}

/**
 * Undoes a failed window and returns the error to throw (with the cause and the next step): the
 * new side's app and services stop (Postgres keeps running), a server's marker holds the app for
 * its data again, the mounts written so far are emptied (so the next run copies them again while
 * the old side serves) and the database recreated empty when its restore began, so nothing of a
 * part copy stays there; they stay stopped until the window runs again. Both dump volumes go,
 * then the old side's services and app start (SC-2302: the old side's data was only read). Every
 * text names the sides in words, never their addresses.
 */
async function rollBackWindow(
  session: MoveSession,
  cause: unknown,
  ctx: {
    old: MoveSide;
    fresh: MoveSide;
    docker: { old: SideDocker; fresh: SideDocker };
    freshServices: readonly string[];
    logins: { old: MovePostgres; fresh: MovePostgres } | undefined;
    changed: Changed;
    clean: (text: string) => string;
  },
): Promise<OpsCrewError> {
  const { deps, plan } = session;
  const { clean, docker, fresh } = ctx;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  const app = plan.app.name;
  const reason = clean(deps.redactor.redact(failureReason(cause)));
  await auditMove(session, {
    kind: "remote-exec",
    action: "maintenance window",
    target: oldWords,
    decision: "refused",
    detail: `maintenance window failed: ${reason}`,
  });
  deps.reporter.warn(
    `The maintenance window failed: ${reason}. OpsCrew empties what it wrote on ${freshWords} and starts the app on ${oldWords} again.`,
  );
  await quietly(session, clean, `stop the app and its services on ${freshWords}`, async () => {
    await fresh.stopApp(session);
    await fresh.stopServices(session, ctx.freshServices);
  });
  // The deploys there wait for the data again; the window never started the web server.
  if (fresh.markMove !== undefined) {
    await quietly(session, clean, `hold the app on ${freshWords} for its data again`, async () =>
      fresh.markMove?.(session, "waiting"),
    );
  }
  for (const copy of ctx.changed.written) {
    await quietly(session, clean, `empty ${mountWords(copy)} on ${freshWords}`, () =>
      docker.fresh.carrier.writeVolume(copy.to, emptyArchive()),
    );
  }
  // The data copied while the old side served is gone from those mounts: the next run copies again.
  if (ctx.changed.written.length > 0) await rm(preCopiedFile(session), { force: true });
  const login = ctx.logins?.fresh;
  if (ctx.changed.restoring && login !== undefined) {
    await quietly(session, clean, `empty the database on ${freshWords}`, () =>
      emptyPostgres(docker.fresh, login),
    );
  }
  await quietly(session, clean, `remove the database dump on ${oldWords}`, () =>
    removeDumpVolume(docker.old.client, app),
  );
  await quietly(session, clean, `remove the database dump on ${freshWords}`, () =>
    removeDumpVolume(docker.fresh.client, app),
  );
  try {
    await restartOldApp(session, `The maintenance window failed (${reason}), and `);
  } catch (error) {
    const failed = asOpsCrewError(error);
    return new OpsCrewError(failed.code, clean(failed.message), {
      ...(failed.hint !== undefined ? { hint: clean(failed.hint) } : {}),
    });
  }
  return new OpsCrewError(
    codeOf(cause),
    `The maintenance window failed: ${reason}. The app on ${oldWords} runs again with its data unchanged, and nothing else changed.`,
    {
      hint: clean(
        `${hintOf(cause)}Then run \`${RUN_COMMAND}\` again (it repeats the maintenance window), or \`${ABORT_COMMAND}\` to undo the move.`,
      ),
    },
  );
}

/** What starting the old side again by hand means, without its address. */
function startByHand(session: MoveBase): string {
  const from = moveOf(session).from.target;
  const words = sideWords(from, "old");
  return from.provider === "portainer"
    ? `Start the app's stack (${portainerStackName(session.plan)}) in your Portainer`
    : `As deploy on ${words}, run \`docker compose up -d\` in the app's folder`;
}

/**
 * Starts the old side's services and its app again when OpsCrew stopped them (`oldAppStoppedAt`)
 * and clears the mark. Stops with a plain error (the mark stays, so the next run tries again first)
 * when they cannot be started: the app is offline then.
 *
 * Once the old app takes writes again, a copy made before is stale. So when the copy is done
 * (`migrated`), the move first goes back to `deployed` (keeping the mark) and only then is the app
 * started: whatever happens next (a failed start, the user starting it by hand, the process
 * dying), the next run repeats the maintenance window before any switch.
 */
export async function restartOldApp(session: MoveBase, before = ""): Promise<void> {
  let move = moveOf(session);
  if (move.oldAppStoppedAt === undefined) return;
  const { deps } = session;
  const words = sideWords(move.from.target, "old");
  const stale = move.step === "migrated";
  if (stale) {
    await saveMove(session, { ...move, step: "deployed" });
    await auditMove(session, {
      kind: "phase",
      action: "retarget deployed",
      detail:
        "the old app is started again, so the copy of its data is out of date and is made again before the switch",
    });
    move = moveOf(session);
  }
  deps.reporter.step(`Starting the app on ${words} again`);
  const old = moveSide(session, "old");
  try {
    await old.startServices(session, statefulServices(session.plan));
    await old.startApp(session);
  } catch (error) {
    await auditMove(session, {
      kind: "remote-exec",
      action: "start app",
      target: words,
      decision: "refused",
      detail: `starting the app on the old side failed: ${failureReason(error)}`,
    });
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `${before}OpsCrew could not start the app on ${words} again: ${failureReason(error)}. Your app is offline until it runs again.`,
      {
        hint: `${startByHand(session)}, then run \`${RUN_COMMAND}\` (or \`${ABORT_COMMAND}\`); OpsCrew checks it again first.`,
      },
    );
  }
  const { oldAppStoppedAt: _stopped, ...rest } = move;
  await saveMove(session, rest);
  await auditMove(session, {
    kind: "remote-exec",
    action: "start app",
    target: words,
    decision: "approved",
    detail: stale
      ? "the app on the old side runs again; the copy of its data is out of date and is made again before the switch"
      : "the app on the old side runs again",
  });
  deps.reporter.success(`The app on ${words} runs again.`);
  if (stale) {
    deps.reporter.info(
      `The copy of the data on ${sideWords(session.plan.target, "new")} is out of date now; \`${RUN_COMMAND}\` copies it again (maintenance window) before switching.`,
    );
  }
}

/** Removes the dump volume on a side; a failure is only a warning (best effort). */
async function removeDumpQuietly(
  session: MoveBase,
  which: "old" | "new",
  clean: (text: string) => string,
): Promise<void> {
  const side = moveSide(session, which);
  const target = which === "old" ? moveOf(session).from.target : session.plan.target;
  await quietly(
    session,
    clean,
    `remove the database dump on ${sideWords(target, which)}`,
    async () => {
      const docker = await side.docker(session);
      try {
        await removeDumpVolume(docker.client, session.plan.app.name);
      } finally {
        await docker.close();
      }
    },
  );
}

/**
 * A run that finds the old app stopped by an interrupted maintenance window (`oldAppStoppedAt`
 * set, data not yet on the new side) starts the old side's services and app again first and
 * removes leftover dump volumes, so users are served while the window is repeated from a fresh
 * copy.
 */
export async function recoverInterruptedWindow(session: MoveBase): Promise<void> {
  const move = moveOf(session);
  if (move.oldAppStoppedAt === undefined || !stepBefore(move.step, "migrated")) return;
  session.deps.reporter.warn(
    "An earlier run stopped during the maintenance window, before the copy completed. OpsCrew starts the app on the old side again first; the window is repeated with a fresh copy.",
  );
  await restartOldApp(session);
  if (serviceOf(session.plan, "postgres") === undefined) return;
  const clean = await withoutAddresses(session);
  await removeDumpQuietly(session, "old", clean);
  if (stepBefore(move.step, "deployed")) return;
  await removeDumpQuietly(session, "new", clean);
}

/** `error` itself when it is an `OpsCrewError`, else a plain internal error. */
export function asOpsCrewError(error: unknown): OpsCrewError {
  if (error instanceof OpsCrewError) return error;
  return new OpsCrewError("INTERNAL", "OpsCrew stopped because of an unexpected error.", {
    hint: "This is a bug in OpsCrew; please report it.",
    cause: error,
  });
}
