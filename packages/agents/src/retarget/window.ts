import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { DockerClient } from "@opscrew/connector-docker";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import { listText, OpsCrewError, replaceNames, upperFirst, writeFileAtomic } from "@opscrew/core";
import {
  checkEnvironmentKey,
  POSTGRES_OWNER,
  portainerStackName,
  ROLLBACK_INPUTS,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  monitoringServerName,
  postgresLogins,
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
import type { MoveServer } from "./removal";
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
  checkCopiedMysqlDump,
  dumpMysql,
  type MoveMysql,
  mysqlDumpVolume,
  removeMysqlDumpVolume,
  restoreMysqlDump,
} from "./sides/mysql";
import {
  checkCopiedDump,
  dumpPostgres,
  emptyPostgres,
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

/** The MySQL and MariaDB services on the app's server that don't start empty (in `empty`). */
function dumpedServices(plan: DeployPlan, empty: ReadonlySet<string>): DumpedService[] {
  return servicesOn(plan, APP_SERVER).flatMap((service) =>
    (service.kind === "mysql" || service.kind === "mariadb") && !empty.has(service.name)
      ? [{ name: service.name, kind: service.kind }]
      : [],
  );
}

/**
 * The owners of data a move's window copies about whole: Postgres (by its dump), MySQL and MariaDB
 * (by their folders, which differ after the restore before the window).
 */
export function copiedWhole(plan: DeployPlan): string[] {
  const postgres = movedPostgres(plan);
  return [
    ...(postgres === undefined ? [] : [postgres]),
    ...dumpedServices(plan, new Set()).map((s) => s.name),
  ];
}

/** The Postgres service on the app's server: a move copies its database by its dump. */
function movedPostgres(plan: DeployPlan): string | undefined {
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

/** A MySQL or MariaDB service of the app's server, which the copy before the window dumps. */
interface DumpedService {
  name: string;
  kind: "mysql" | "mariadb";
}

/** What the window does: the mounts it copies, Postgres's dump, the services it stops. */
interface WindowPlan {
  copies: MountCopy[];
  /** The Postgres service whose database is dumped and restored, unless it starts empty. */
  postgres: string | undefined;
  /**
   * The MySQL and MariaDB services that don't start empty: dumped and restored before the window,
   * their data folders copied in it.
   */
  dumped: DumpedService[];
  /** The bytes copied, Postgres's data folder counting for its dump. */
  bytes: number;
  services: string[];
}

/** True when the window copies mounts or the database (not only a bucket's last copy). */
function hasData(window: WindowPlan): boolean {
  return window.copies.length > 0 || window.postgres !== undefined;
}

/**
 * The window's data by how it is copied: the mounts of which only what changed goes, and those
 * copied about whole (Postgres's folder by its dump; MySQL's and MariaDB's, whose files differ
 * after their restore before the window).
 */
function sizesOf(window: WindowPlan): MoveSizes {
  const dumped = new Set(window.dumped.map((service) => service.name));
  const files = window.copies
    .filter((copy) => !dumped.has(copy.owner))
    .reduce((sum, copy) => sum + copy.bytes, 0);
  return { files, whole: window.bytes - files };
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
  return {
    copies,
    postgres,
    dumped: dumpedServices(plan, empty),
    bytes,
    services: statefulServices(plan),
  };
}

/** Whether the plan's PostgreSQL `service` has the app's two logins (`logins: separate`, 047). */
function withLogins(plan: DeployPlan, service: string): boolean {
  return plan.services.some((each) => each.name === service && postgresLogins(each));
}

/**
 * Postgres's login on one side: the app's `app` user, its generated password (registered with the
 * redactor) and the Compose project the one-off containers join (`opscrew-<app>` in Portainer,
 * `<app>` on a server); with the app's two logins (047), `app_owner`'s password too, which the load
 * restores the app's objects with.
 */
async function postgresOn(
  session: MoveBase,
  side: MoveSide,
  service: string,
): Promise<MovePostgres> {
  const { deps, plan } = session;
  const values = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
  const password = values?.dbPassword;
  const logins = withLogins(plan, service);
  const owner = logins ? values?.services?.[service]?.["owner-password"] : undefined;
  if (password === undefined || (logins && owner === undefined)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew does not have the database's password on this computer, so it cannot copy the database. Nothing was changed.",
      {
        hint: `Run \`${RUN_COMMAND}\` on the computer that provisioned the app (it keeps the password in OpsCrew's folder there).`,
      },
    );
  }
  for (const value of [password, owner])
    if (value !== undefined) deps.redactor.addLiteral(value, "app-env");
  return {
    app: plan.app.name,
    project: composeProject(side, plan),
    service,
    password,
    ...(owner !== undefined ? { ownerPassword: owner } : {}),
  };
}

/**
 * A MySQL or MariaDB service's root login on one side, as {@link postgresOn}: its generated root
 * password (registered with the redactor) and the Compose project there.
 */
async function mysqlOn(
  session: MoveBase,
  side: MoveSide,
  service: DumpedService,
): Promise<MoveMysql> {
  const { deps, plan } = session;
  const values = await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema);
  const password = values?.services?.[service.name]?.["root-password"];
  if (password === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not have ${service.name}'s root password on this computer, so it cannot copy its databases. Nothing was changed.`,
      {
        hint: `Run \`${RUN_COMMAND}\` on the computer that provisioned the app (it keeps the password in OpsCrew's folder there).`,
      },
    );
  }
  deps.redactor.addLiteral(password, "app-env");
  return {
    app: plan.app.name,
    project: composeProject(side, plan),
    service: service.name,
    kind: service.kind,
    password,
  };
}

/**
 * A database a move copies by its dump, the same way on both sides: Postgres before the window
 * and in it, MySQL and MariaDB before it (the window copies their data folders, stopped).
 */
interface DumpedDatabase {
  /** Its service's Compose name, in messages. */
  service: string;
  /** Its move volume, on each side. */
  volume: string;
  /** Dumps it on the old side while it runs; the dump's SHA-256. */
  dump(old: SideDocker): Promise<string>;
  /** Checks the dump copied to the new side against the old side's `sha256`. */
  check(fresh: SideDocker, sha256: string): Promise<void>;
  /** Restores the checked dump into the new side's service, once it answers. */
  restore(fresh: SideDocker): Promise<void>;
  /** Removes its move volume on a side. */
  remove(client: DockerClient): Promise<void>;
}

/** Postgres as a {@link DumpedDatabase}, with its logins on each side. */
function postgresDump(
  session: MoveBase,
  logins: { old: MovePostgres; fresh: MovePostgres },
): DumpedDatabase {
  const app = session.plan.app.name;
  return {
    service: logins.old.service,
    volume: moveDumpVolume(app),
    dump: (old) => dumpPostgres(old, logins.old),
    check: (fresh, sha256) => checkCopiedDump(fresh, logins.fresh, sha256),
    restore: (fresh) => restoreCheckedDump(fresh, logins.fresh, waitsOf(session.services)),
    remove: (client) => removeDumpVolume(client, app),
  };
}

/** A MySQL or MariaDB service as a {@link DumpedDatabase}, with its root logins on each side. */
function mysqlDump(
  session: MoveBase,
  logins: { old: MoveMysql; fresh: MoveMysql },
): DumpedDatabase {
  return {
    service: logins.old.service,
    volume: mysqlDumpVolume(logins.old),
    dump: (old) => dumpMysql(old, logins.old),
    check: (fresh, sha256) => checkCopiedMysqlDump(fresh, logins.fresh, sha256),
    restore: (fresh) => restoreMysqlDump(fresh, logins.fresh, waitsOf(session.services)),
    remove: (client) => removeMysqlDumpVolume(client, logins.old),
  };
}

/** Runs `run`, then records `action` on `where` in the audit log, with `detail` when given. */
async function audited(
  session: MoveBase,
  action: string,
  where: string,
  run: () => Promise<unknown>,
  detail?: string,
): Promise<void> {
  await run();
  await auditMove(session, {
    kind: "remote-exec",
    action,
    target: where,
    decision: "approved",
    ...(detail !== undefined ? { detail } : {}),
  });
}

/** The audit entries' detail of the copy before the window. */
const SERVING = "while the app serves, before the maintenance window";

/** Where a database's copy runs: the session, both sides' Docker APIs, the audit's detail. */
interface CopyContext {
  session: MoveSession;
  docker: { old: SideDocker; fresh: SideDocker };
  /** {@link SERVING} before the window; none in it. */
  detail?: string;
}

/** The words of both sides of a copy, and what its progress says of the old app. */
function copyWords(ctx: CopyContext) {
  return {
    old: sideWords(moveOf(ctx.session).from.target, "old"),
    fresh: sideWords(ctx.session.plan.target, "new"),
    serving: ctx.detail === undefined ? "" : " while your app serves",
  };
}

/**
 * Dumps `db` on the old side while its service runs, into its move volume, made on the new side
 * too so the copy has a place there. Returns the dump's SHA-256.
 */
async function dumpDatabase(ctx: CopyContext, db: DumpedDatabase): Promise<string> {
  const { session, docker } = ctx;
  const words = copyWords(ctx);
  session.deps.reporter.step(`Dumping ${db.service}'s data on ${words.old}${words.serving}`);
  const { client } = docker.fresh;
  if (!(await client.volumeExists(db.volume))) await client.createVolume(db.volume);
  let sha256 = "";
  await audited(
    session,
    "dump database",
    words.old,
    async () => {
      sha256 = await db.dump(docker.old);
    },
    ctx.detail,
  );
  return sha256;
}

/**
 * Copies `db`'s dump to the new side through the carrier, checks it against `sha256` before
 * anything there is dropped, and restores it (`restoring` says first that the restore begins).
 */
async function restoreDatabase(
  ctx: CopyContext,
  db: DumpedDatabase,
  sha256: string,
  restoring?: () => void,
): Promise<void> {
  const { session, docker } = ctx;
  const words = copyWords(ctx);
  const volume: SideSource = { kind: "volume", name: db.volume };
  session.deps.reporter.step(`Copying ${db.service}'s dump to ${words.fresh}${words.serving}`);
  await audited(
    session,
    "copy database dump",
    words.fresh,
    async () =>
      docker.fresh.carrier.writeVolume(volume, await docker.old.carrier.readVolume(volume)),
    ctx.detail,
  );
  await db.check(docker.fresh, sha256);
  restoring?.();
  session.deps.reporter.step(`Restoring ${db.service}'s data on ${words.fresh}${words.serving}`);
  await audited(
    session,
    "restore database",
    words.fresh,
    () => db.restore(docker.fresh),
    ctx.detail,
  );
}

/** Removes `db`'s move volume on both sides. */
async function removeDumps(ctx: CopyContext, db: DumpedDatabase): Promise<void> {
  const { session, docker } = ctx;
  const words = copyWords(ctx);
  await audited(
    session,
    "remove database dump",
    words.old,
    () => db.remove(docker.old.client),
    ctx.detail,
  );
  await audited(
    session,
    "remove database dump",
    words.fresh,
    () => db.remove(docker.fresh.client),
    ctx.detail,
  );
}

/**
 * What the restore of the database `service` does, in the window's words: with the app's two logins
 * (047), the dump keeps its owners and grants.
 */
function restoreWords(plan: DeployPlan, service: string): string {
  return withLogins(plan, service)
    ? `recreate the database empty, owned by ${POSTGRES_OWNER}, and restore the dump into it (pg_restore --single-transaction), keeping its owners and grants and granting again what the dump lacks`
    : "recreate the database empty and restore the dump into it (pg_restore --single-transaction)";
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
  const dumped = new Set(window.dumped.map((service) => service.name));
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
          ...window.copies.map((copy) =>
            dumped.has(copy.owner)
              ? `  ${mountWords(copy)} (${sizeText(copy.bytes)}), about all of it: its files differ after its restore while your app served`
              : `  what changed in ${mountWords(copy)} since the first copy (${sizeText(copy.bytes)} in all)`,
          ),
          ...(window.postgres !== undefined ? ["  the database dump"] : []),
        ]
      : []),
    `On ${fresh}:`,
    ...(services !== undefined ? [`  start ${services}`] : []),
    ...(window.postgres !== undefined ? [`  ${restoreWords(plan, window.postgres)}`] : []),
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
 * the window's approval doesn't copy again; the databases by their dumps; the app checked there,
 * then stopped again) → the window's minutes and one `remote-exec` approval
 * listing both sides' steps (scripts need `allowDowntime`) → the scheduled check paused →
 * `oldAppStoppedAt` → the old app stops → Postgres is dumped into the dump volume while it still
 * runs → the old services stop → the new app and services stop → what changed in each mount since
 * the first copy is copied with the carrier ({@link copyMount}: the digests must match; a MySQL's
 * or MariaDB's folder about whole), and the dump volume → the new services start, waiting until
 * they run → Postgres is recreated and restored → the release command
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
    // Every database by its dump; the MySQL and MariaDB logins are needed for this copy only.
    const databases = logins === undefined ? [] : [postgresDump(session, logins)];
    for (const service of window.dumped) {
      const there = { old: await mysqlOn(session, old, service) };
      databases.push(
        mysqlDump(session, { ...there, fresh: await mysqlOn(session, fresh, service) }),
      );
    }
    await preCopy(session, { old, fresh, window, databases, image, minutes: estimate.preCopy });
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
 * and with the deploys paused: the new side's app and the services whose data is copied stop; each
 * mount is copied whole, but a MySQL's or MariaDB's, which isn't a consistent snapshot while it
 * writes: its folder there is emptied instead; those services start (waiting until they run, the
 * emptied ones set up anew from their environment); then each database (`databases`: Postgres, MySQL, MariaDB) is
 * dumped on the old side, consistent while it runs, copied, checked and restored on the new side.
 * Other stateful services (Mongo, Valkey, …) start on their live copy: one that refuses to fails
 * here, before any downtime. On a server ({@link startOnData} with `image`), the deploy then runs
 * the release command on that copy and starts the app, which must answer; then the app, its
 * workers and its cron stop again and the marker holds them, so nothing of the app runs on both
 * servers until the window. Recorded once done ({@link preCopiedFile}). On failure (inside the
 * pause) the new side's app stops, a server's marker holds it for its data again and its edge
 * stays stopped, the dump volumes go, and the move stops with the cause: nothing of the old side
 * was stopped, and a rerun copies again.
 */
async function preCopy(
  session: MoveSession,
  ctx: {
    old: MoveSide;
    fresh: MoveSide;
    window: WindowPlan;
    databases: DumpedDatabase[];
    image: string | undefined;
    minutes: number;
  },
): Promise<void> {
  const { deps, plan } = session;
  const { old, fresh, window, databases, image } = ctx;
  const oldWords = sideWords(moveOf(session).from.target, "old");
  const freshWords = sideWords(plan.target, "new");
  // The new side's Postgres keeps running: its database is restored, not copied as files.
  const freshServices = window.services.filter((name) => name !== window.postgres);
  // A MySQL's or MariaDB's folder goes by its dump here, and as files in the window.
  const dumped = new Set(window.dumped.map((service) => service.name));
  const data = hasData(window);
  deps.reporter.info(
    data
      ? `OpsCrew copies the app's data (${sizeText(window.bytes)}) to ${freshWords} while your app serves (about ${ctx.minutes} minutes); the app on ${oldWords} keeps running.`
      : `OpsCrew starts the app on ${freshWords} with its deploy while your app serves (about ${ctx.minutes} minutes); the app on ${oldWords} keeps running.`,
  );
  const docker = { old: await old.docker(session), fresh: await fresh.docker(session) };
  const copying: CopyContext = { session, docker, detail: SERVING };
  const clean = await withoutAddresses(session);
  let started = false;
  try {
    await withDeploysPaused(deps, session.github, plan, session.services, RUN_COMMAND, async () => {
      try {
        await audited(session, "stop app", freshWords, () => fresh.stopApp(session), SERVING);
        await audited(
          session,
          "stop services",
          freshWords,
          () => fresh.stopServices(session, freshServices),
          SERVING,
        );
        // A MySQL's or MariaDB's folder there starts empty: its image sets the server up from its
        // environment, and the dump lands in an empty server, never on what a failed run left
        // (a migration of its release command would fail on every rerun). Postgres's restore
        // recreates its database empty itself.
        for (const copy of window.copies.filter((mount) => dumped.has(mount.owner))) {
          await audited(
            session,
            `empty ${copy.owner} ${copy.key}`,
            freshWords,
            () => docker.fresh.carrier.writeVolume(copy.to, emptyArchive()),
            SERVING,
          );
        }
        for (const copy of window.copies.filter((mount) => !dumped.has(mount.owner))) {
          deps.reporter.step(
            `Copying ${mountWords(copy)} (${sizeText(copy.bytes)}) to ${freshWords} while your app serves`,
          );
          await audited(
            session,
            `copy ${copy.owner} ${copy.key}`,
            freshWords,
            async () =>
              docker.fresh.carrier.writeVolume(
                copy.to,
                await docker.old.carrier.readVolume(copy.from),
              ),
            SERVING,
          );
        }
        await audited(
          session,
          "start services",
          freshWords,
          () => fresh.startServices(session, freshServices),
          SERVING,
        );
        for (const db of databases) {
          await restoreDatabase(copying, db, await dumpDatabase(copying, db));
          await removeDumps(copying, db);
        }
        if (image === undefined) return;
        started = true;
        await startOnData(session, { fresh, image, detail: SERVING });
        // Its workers and cron would write to the copy while the old app's write to the data.
        await audited(session, "stop app", freshWords, () => fresh.stopApp(session), SERVING);
        await audited(
          session,
          "hold the app for its data",
          freshWords,
          async () => fresh.markMove?.(session, "waiting"),
          SERVING,
        );
      } catch (error) {
        throw await rollBackPreCopy(session, error, { fresh, docker, databases, started, clean });
      }
    });
  } finally {
    await docker.old.close();
    await docker.fresh.close();
  }
  await writeFileAtomic(preCopiedFile(session), `${JSON.stringify(moveOf(session).startedAt)}\n`);
  deps.reporter.success(
    `${image === undefined ? `The app's data is copied to ${freshWords}` : `The app answered on ${freshWords}${data ? " on its data copied" : ""}`} while your app serves; the maintenance window copies only what changed since.`,
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
    databases: readonly DumpedDatabase[];
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
  for (const db of ctx.databases) {
    await quietly(session, clean, `remove ${db.service}'s dump on ${oldWords}`, () =>
      db.remove(docker.old.client),
    );
    await quietly(session, clean, `remove ${db.service}'s dump on ${freshWords}`, () =>
      db.remove(docker.fresh.client),
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
  /** What the window changed on the new side so far: a rollback undoes it. */
  const changed: Changed = { written: [], restoring: false };
  const copying: CopyContext = { session, docker };
  const postgres = logins === undefined ? undefined : postgresDump(session, logins);
  try {
    deps.reporter.step(`Stopping ${plan.app.name} on ${oldWords}`);
    await audited(session, "stop app", oldWords, () => old.stopApp(session));
    // Postgres's dump is consistent while it runs; its files are not copied.
    const dump = postgres === undefined ? undefined : await dumpDatabase(copying, postgres);
    await audited(session, "stop services", oldWords, async () => {
      await old.stopServices(session, window.services);
      await requireCleanStop(session, old, docker.old, window.services);
    });
    await audited(session, "stop app", freshWords, () => fresh.stopApp(session));
    await audited(session, "stop services", freshWords, () =>
      fresh.stopServices(session, freshServices),
    );
    // The bucket's last copy: nothing writes to it while the old app is stopped.
    if (sync !== undefined) {
      await copyBucket(session, "sync", sync.keys, (3 * sync.minutes + 5) * 60_000);
    }
    for (const copy of window.copies) {
      deps.reporter.step(`Copying what changed in ${mountWords(copy)} to ${freshWords}`);
      changed.written.push(copy);
      await audited(session, `copy ${copy.owner} ${copy.key}`, freshWords, () =>
        copyMount(session, docker, copy),
      );
    }
    await audited(session, "start services", freshWords, () =>
      fresh.startServices(session, freshServices),
    );
    if (postgres !== undefined && dump !== undefined) {
      await restoreDatabase(copying, postgres, dump, () => {
        changed.restoring = true;
      });
    }
    // The release command on the final data: the version deployed there migrates it forward.
    if (plan.app.releaseCommand !== undefined) {
      deps.reporter.step(
        `Running the release command (app.releaseCommand) on the final data, migrating it to the version on ${freshWords}`,
      );
    }
    await audited(session, "run release command", freshWords, () =>
      fresh.release(session, window.bytes),
    );
    if (postgres !== undefined) await removeDumps(copying, postgres);
    // In place: the app's container and its route are the ones the deploy before the window left.
    deps.reporter.step(`Starting the app on ${freshWords} again`);
    await audited(session, "start app", freshWords, () => fresh.startApp(session));
    await waitHealthy(session, fresh);
    if (fresh.markMove !== undefined) {
      await audited(session, "remove the move's marker", freshWords, async () =>
        fresh.markMove?.(session, undefined),
      );
    }
  } catch (error) {
    throw await rollBackWindow(session, error, { ...ctx, freshServices, changed });
  }
}

/**
 * A server's new side, once data is there (FR-3027): the move's marker says `copied`, so the
 * deploy workflow's run with `image`'s digest (no build, and not a rollback) runs the release
 * command on that data, switches to the app and starts its workers and cron, and leaves the check
 * to the move: the app's domain still leads to the old side. Its start of the edge is undone (the
 * edge stays stopped until the switch, as the move's deploy step left it), and the app must answer
 * on the server. `detail` goes with the audit entries.
 */
async function startOnData(
  session: MoveSession,
  ctx: { fresh: MoveSide; image: string; detail?: string },
): Promise<void> {
  const { fresh, image, detail } = ctx;
  const words = sideWords(session.plan.target, "new");
  await audited(
    session,
    "let the deploys start the app on its data",
    words,
    async () => fresh.markMove?.(session, "copied"),
    detail,
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
  try {
    await startOnData(session, { fresh, image });
  } catch (error) {
    const clean = await withoutAddresses(session);
    await quietly(session, clean, `hold the app on ${words} for its data again`, async () =>
      fresh.markMove?.(session, "waiting"),
    );
    // The deploy may have started the edge: it stays stopped until the switch (a shared one runs).
    await quietly(session, clean, `stop the web server on ${words}`, () => fresh.stopEdge(session));
    throw error;
  }
  await audited(session, "remove the move's marker", words, async () =>
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
 * and clears the mark; the app starts even when a service didn't. Stops with a plain error (the
 * mark stays, so the next run tries again first) when either cannot be started: the app is offline
 * then. When the window `copied` the data, the new side's app first stops and waits for its data
 * again ({@link holdNewApp}).
 *
 * Once the old app takes writes again, a copy made before is stale. So when the copy is done
 * (`migrated`), the move first goes back to `deployed` (keeping the mark) and only then is the app
 * started: whatever happens next (a failed start, the user starting it by hand, the process
 * dying), the next run repeats the maintenance window before any switch.
 */
export async function restartOldApp(
  session: MoveBase,
  before = "",
  /** The window copied the data (step `migrated`, or a switch's rollback that left it). */
  copied = moveOf(session).step === "migrated",
): Promise<void> {
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
  // The window started the app on the new side: it stops and waits for its data again, so the app
  // never runs on both servers.
  if (copied) await holdNewApp(session);
  deps.reporter.step(`Starting the app on ${words} again`);
  const old = moveSide(session, "old");
  let failure: unknown;
  try {
    await old.startServices(session, statefulServices(session.plan));
  } catch (error) {
    failure = error;
  }
  // The app starts even when a service didn't: it may serve without it. The failure is said.
  try {
    await old.startApp(session);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    const error = failure;
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

/**
 * Stops the new side's app (its workers and cron too) and holds it there for its data again, with
 * the move's marker; each a warning only when it fails, so it never keeps the old app offline.
 */
async function holdNewApp(session: MoveBase): Promise<void> {
  const fresh = moveSide(session, "new");
  const words = sideWords(session.plan.target, "new");
  const clean = await withoutAddresses(session);
  await quietly(session, clean, `stop the app on ${words}`, () => fresh.stopApp(session));
  if (fresh.markMove === undefined) return;
  await quietly(session, clean, `hold the app on ${words} for its data again`, async () =>
    fresh.markMove?.(session, "waiting"),
  );
}

/**
 * Removes the move volumes a killed run may have left on each of `sides`: Postgres's dump, and each
 * MySQL's or MariaDB's from the copy before the window. A failure is only a warning (best effort).
 */
export async function removeLeftoverDumps(
  session: MoveBase,
  sides: readonly MoveServer[],
): Promise<void> {
  const { plan } = session;
  const app = plan.app.name;
  const removals = [
    ...(movedPostgres(plan) === undefined
      ? []
      : [(client: DockerClient) => removeDumpVolume(client, app)]),
    ...dumpedServices(plan, new Set()).map(
      (service) => (client: DockerClient) =>
        removeMysqlDumpVolume(client, { app, service: service.name }),
    ),
  ];
  if (removals.length === 0) return;
  const clean = await withoutAddresses(session);
  for (const which of sides) {
    const target = which === "old" ? moveOf(session).from.target : plan.target;
    await quietly(
      session,
      clean,
      `remove the database dumps on ${sideWords(target, which)}`,
      async () => {
        const docker = await moveSide(session, which).docker(session);
        try {
          for (const remove of removals) await remove(docker.client);
        } finally {
          await docker.close();
        }
      },
    );
  }
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
  await removeLeftoverDumps(session, stepBefore(move.step, "deployed") ? ["old"] : ["old", "new"]);
}

/** `error` itself when it is an `OpsCrewError`, else a plain internal error. */
export function asOpsCrewError(error: unknown): OpsCrewError {
  if (error instanceof OpsCrewError) return error;
  return new OpsCrewError("INTERNAL", "OpsCrew stopped because of an unexpected error.", {
    hint: "This is a bug in OpsCrew; please report it.",
    cause: error,
  });
}
