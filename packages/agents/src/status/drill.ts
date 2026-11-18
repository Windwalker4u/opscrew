/**
 * `status`'s lines on restore drills (029 plan.md 19., research R18, R27, R29): the last drill on
 * each target, in that target's words, and with a schedule a warning when none ran within twice
 * its period. Each target is read with the connection `status` already has, read-only: the app's
 * server's `.snapshots/drills.log` in the snapshots' read, this computer's from the app's folder
 * with no shell, a Portainer's drills by hand from this computer's record and its scheduled dump
 * drills from the log of each `drill-<service>` container through Portainer's Docker proxy, and a
 * hosting account's `state/drills.log` through the account's files.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import type { HostingFiles } from "@opscrew/contracts";
import { errorText, isUserFacingError, OpsCrewError, plural } from "@opscrew/core";
import {
  DRILL_LIMIT_SECONDS,
  DRILL_RECORD_PREFIX,
  DRILLS_LOG,
  type DrillRecord,
  drillRecord,
  drillRecordsIn,
  drillScheduleHours,
  HOSTING_DRILLS_LOG,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, onOneServer } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { hostingFolder } from "../hosting/provision-plans";
import { appFolder } from "../localhost/services";
import { drillCommandText } from "../snapshot/drill-core";
import { readPortainerDrills } from "../snapshot/drill-portainer";
import {
  DRILL_TARGET_WORDS,
  type DrillTarget,
  HOSTING_NOT_RESTORED,
} from "../snapshot/drill-report";
import { portainerPlace } from "../snapshot/portainer";
import type { SnapshotServices } from "../snapshot/types";

/** Why a drill was skipped or failed, by the target's fixed word, in a few words. */
const REASONS: Record<string, string> = {
  locked: "a deploy, a snapshot or a restore was running",
  rotation: "a credential rotation held the app",
  disk: "too little free disk",
  memory: "too little free memory",
  kept: "a kept copy is still there",
  none: "no scheduled snapshot yet",
  version: "the snapshot names no version",
  gone: "that snapshot's version of the app is gone",
  network: "the copy's network was not cut off",
  files: "the copy's files could not be written",
  start: "the copy could not be started",
  timeout: `it ran past its ${DRILL_LIMIT_SECONDS / 60}-minute limit`,
  leftovers: "an earlier drill's copy could not be removed",
  stopped: "it was stopped",
  login: "no drill database login yet",
  quota: "the account's quota leaves less room than the dump",
};

/** The line that says no drill ran yet, with drills on. */
const NONE_YET = (flags: string) =>
  `Restore drills: none yet; \`${drillCommandText(flags)}\` runs one.`;

/** The hour a drill may take past its slot (the check's). */
const GRACE_MS = 3_600_000;

type DrillEvery = "weekly" | "daily";

/** Minutes and seconds between two ISO times: `4 min 10 s`, `52 s`. */
function took(start: string | undefined, end: string): string | undefined {
  if (start === undefined) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return undefined;
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds % 60} s`;
}

/** A skip's or a failure's reason in words; on a hosting account `none` is any snapshot. */
function reasonWords(record: DrillRecord, target: DrillTarget): string {
  if (record.reason === "none" && target === "hosting") return "no snapshot yet";
  return record.reason === undefined ? "" : (REASONS[record.reason] ?? record.reason);
}

/** A hosting account's outcome (research R27): the dump loaded with its tables, or what didn't. */
function hostingOutcome(record: DrillRecord): string {
  const count = record.tables.find((entry) => entry.service === "database")?.count;
  const files = record.parts.some((part) => part.name === "files");
  const archive = "the copy of the shared files is a valid archive";
  if (record.result === "healthy") {
    if (count === undefined) return archive;
    return `the dump loaded with ${plural(count, "table")}${files ? `, and ${archive}` : ""}`;
  }
  const what =
    record.reason === "tables"
      ? count === undefined
        ? "the drill database did not answer once the dump loaded"
        : `the drill database held ${plural(count, "table")} once the dump loaded, not the dump's count`
      : (HOSTING_NOT_RESTORED[record.reason ?? ""] ??
        `${record.reason ?? "a part of it"} did not restore`);
  return `the snapshot did not restore: ${what}`;
}

/** How the drill `record` ended on `target`, in that target's words (research R19, R27). */
function outcome(record: DrillRecord, target: DrillTarget): string {
  if (record.result === "skipped" || record.result === "failed") {
    return `${record.result}: ${reasonWords(record, target)}`;
  }
  if (target === "hosting") return hostingOutcome(record);
  const tables =
    record.tables.length === 0
      ? ""
      : `, ${record.tables.map((table) => (table.count === undefined ? `${table.service} not read` : `${table.service} ${plural(table.count, "table")}`)).join(", ")}`;
  const result =
    record.result === "healthy"
      ? "healthy"
      : record.result === "unhealthy"
        ? "restored, but the app did not become healthy"
        : `the snapshot did not restore (${record.reason ?? "a part"})`;
  return `${result}${tables}`;
}

/** What became of the drill's copy, when it isn't simply gone. */
function copyWords(record: DrillRecord, target: DrillTarget, flags: string): string {
  if (record.removal === "kept") {
    return `; its copy is kept: \`${drillCommandText(flags, { remove: true })}\` removes it`;
  }
  return record.removal === "failed" ? `; ${DRILL_TARGET_WORDS[target].notRemoved(flags)}` : "";
}

/**
 * The line of `status` for the drill `record` on `target` (a server by default): its snapshot,
 * time, how long it took and how it ended, in the target's words (research R27: healthy where the
 * app started on the copy, the dump loaded with its tables on a hosting account), or skipped or
 * failed with the reason (R29), and a copy it left.
 */
export function drillStatusLine(
  record: DrillRecord,
  flags: string,
  target: DrillTarget = "server",
): string {
  const time = took(record.start, record.end);
  return [
    `Last restore drill: ${record.id ?? "no snapshot"}`,
    `${record.kind === "scheduled" ? "scheduled, " : ""}${formatUtc(record.end)}`,
    ...(time === undefined || record.result === "skipped" ? [] : [`took ${time}`]),
    `${outcome(record, target)}${copyWords(record, target, flags)}.`,
  ].join(", ");
}

/**
 * The line of a Portainer's scheduled dump drill of `service` (research R28): it proves the dump
 * restores into a scratch server of its own, never the app.
 */
function dumpDrillLine(service: string, record: DrillRecord): string {
  const time = took(record.start, record.end);
  const count = record.tables.find((table) => table.service === service);
  const result =
    record.result === "skipped" || record.result === "failed"
      ? `${record.result}: ${reasonWords(record, "portainer")}`
      : record.result === "healthy"
        ? `the dump restored with ${plural(count?.count ?? 0, "table")} (the app isn't started by it)`
        : `the dump did not restore: ${count === undefined ? "it did not load" : count.count === undefined ? "the restored database did not answer" : "it held no table once restored"}`;
  return [
    `Last scheduled dump drill of ${service}: ${record.id ?? "no snapshot"}`,
    formatUtc(record.end),
    ...(time === undefined || record.result === "skipped" ? [] : [`took ${time}`]),
    `${result}.`,
  ].join(", ");
}

/**
 * With a drill schedule, the warning when `since` (the last drill's end, or the time a snapshot
 * waiting for one was taken) is more than twice the schedule and an hour ago, as the scheduled
 * check counts it; `what` says what `since` is.
 */
function overdueWarning(
  deps: PhaseDeps,
  every: DrillEvery | undefined,
  since: string,
  what: string,
  o: { target: DrillTarget; flags: string },
): string[] {
  if (every === undefined) return [];
  if (
    deps.clock.now().getTime() - Date.parse(since) <=
    2 * drillScheduleHours(every) * 3_600_000 + GRACE_MS
  ) {
    return [];
  }
  const span = every === "weekly" ? "two weeks" : "two days";
  return [
    `Warning: no restore drill within ${span}, though they are scheduled ${every}: ${what} ${formatUtc(since)}. \`${drillCommandText(o.flags)}\` runs one now; ${DRILL_TARGET_WORDS[o.target].logged(o.flags)}.`,
  ];
}

/** The records of the drills' log lines in `text`, oldest first. */
function drillRecords(text: string): DrillRecord[] {
  return text
    .split(/\r?\n/)
    .map((line) => drillRecord(line))
    .filter((record) => record !== undefined);
}

/** The last of `records` that ran (not a skip), whose end the overdue warning counts from. */
function lastRan(records: readonly DrillRecord[]): DrillRecord | undefined {
  return records.findLast((record) => record.result !== "skipped");
}

/** The drills' log in the app's folder on this computer, `""` without one. */
async function computerDrillLog(deps: PhaseDeps, plan: DeployPlan): Promise<string> {
  try {
    return await readFile(join(appFolder(deps.paths, plan), DRILLS_LOG), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not read ${DRILLS_LOG} in the app's folder on this computer (${(error as NodeJS.ErrnoException).code ?? "unknown error"}).`,
      { hint: "Check that the folder can be read, then try again." },
    );
  }
}

/**
 * Each scheduled dump drill's last record in the user's Portainer, by its service, and its last
 * that ran (not a skip): the {@link DRILL_RECORD_PREFIX} lines of each `drill-<service>`
 * container of the app's stack, through Portainer's Docker proxy. A recreated container starts a
 * new log, so its records are gone then.
 */
async function readDumpDrills(
  deps: PhaseDeps,
  plan: DeployPlan,
  flags: string,
  services: SnapshotServices,
): Promise<{ service: string; record: DrillRecord; ran?: DrillRecord }[]> {
  const place = await portainerPlace({
    deps,
    plan,
    environment: deps.paths.environment,
    flags,
    services,
  });
  const loops = (await place.docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${place.stack}`]))
    .map((container) => ({ container, name: container.labels[COMPOSE_SERVICE_LABEL] ?? "" }))
    .filter(({ name }) => name.startsWith("drill-"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const drills: { service: string; record: DrillRecord; ran?: DrillRecord }[] = [];
  for (const { container, name } of loops) {
    const { stdout } = await place.docker.containerLogs(container.id);
    const records = drillRecordsIn(stdout);
    const record = records.at(-1);
    const ran = lastRan(records);
    if (record !== undefined) {
      drills.push({ service: name.slice("drill-".length), record, ...(ran ? { ran } : {}) });
    }
  }
  return drills;
}

/** The newest end among `records`, if any. */
function newestEnd(records: readonly DrillRecord[]): string | undefined {
  return records
    .map((record) => record.end)
    .sort()
    .at(-1);
}

/**
 * The lines on restore drills of the app's server, this computer or the user's Portainer when it
 * holds data: the last drill (in a Portainer the last by hand and each dump's last scheduled
 * one), or with `snapshots.drills` on and none yet a line that says so; with a schedule, a warning
 * when the newest drill that ran (skips aside) ended more than twice the schedule and an hour ago;
 * a note when they cannot be read. None elsewhere, or with neither a drill nor the setting. On a
 * server `serverLog` holds the drills' log's last line that ran and its last line, read with the
 * snapshots (`snapshotStatusReport`), and there is none without it;
 * on this computer it is read from the app's folder, with no shell; in a Portainer through
 * `services`' client, the scheduled ones only with the schedule on.
 */
export async function drillStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  serverLog?: string,
  services: SnapshotServices = {},
): Promise<{ lines: string[] }> {
  const { provider } = plan.target;
  const target: DrillTarget =
    provider === "localhost" ? "computer" : provider === "portainer" ? "portainer" : "server";
  if (target === "server" && !onOneServer(provider)) return { lines: [] };
  if (snapshotParts(plan, APP_SERVER).length === 0) return { lines: [] };
  if (target === "server" && serverLog === undefined) return { lines: [] };
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const every = plan.snapshots?.drills?.schedule;
  const redact = (lines: string[]) => lines.map((line) => deps.redactor.redact(line));
  try {
    if (target === "portainer") {
      const manuals = await readPortainerDrills(deps.paths);
      const manual = manuals.at(-1);
      const dumps = every === undefined ? [] : await readDumpDrills(deps, plan, flags, services);
      if (manual === undefined && dumps.length === 0) {
        return { lines: plan.snapshots?.drills === undefined ? [] : [NONE_YET(flags)] };
      }
      const since = newestEnd(
        [lastRan(manuals), ...dumps.map((each) => each.ran)].filter((each) => each !== undefined),
      );
      return {
        lines: redact([
          ...(manual === undefined ? [] : [drillStatusLine(manual, flags, target)]),
          ...dumps.map(({ service, record }) => dumpDrillLine(service, record)),
          ...(since === undefined
            ? []
            : overdueWarning(deps, every, since, "the last one ended", { target, flags })),
        ]),
      };
    }
    const records = drillRecords(
      target === "computer" ? await computerDrillLog(deps, plan) : (serverLog ?? ""),
    );
    const drill = records.at(-1);
    if (drill === undefined) {
      return { lines: plan.snapshots?.drills === undefined ? [] : [NONE_YET(flags)] };
    }
    const ran = lastRan(records);
    const warning =
      ran === undefined
        ? []
        : overdueWarning(deps, every, ran.end, "the last one ended", { target, flags });
    return { lines: redact([drillStatusLine(drill, flags, target), ...warning]) };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { lines: redact([`Restore drills: ${errorText(error)}`]) };
  }
}

/** A snapshot `opscrew snapshot` took on a hosting account, by its file in `dumps/`. */
const ACCOUNT_SNAPSHOT =
  /^(snapshot-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z(?:-\d+)?)\.(?:sql\.gz|shared\.tar\.gz)$/;

/**
 * The lines on restore drills of an app on a hosting account with a panel (research R25, R28),
 * through the account's `files`, read-only: the last line of the agent's `state/drills.log`, in a
 * hosting account's words ("the dump loaded with N tables", never "healthy"), or with
 * `snapshots.drills` on and none yet a line that says so. With a schedule, the agent drills the
 * newest snapshot once no drill (skips aside) proved it, so the warning comes when that snapshot
 * was taken more than twice the schedule and an hour ago. A note when they cannot be read.
 * Redacted.
 */
export async function hostingDrillStatusLines(
  deps: PhaseDeps,
  plan: DeployPlan,
  files: HostingFiles,
): Promise<string[]> {
  const folder = hostingFolder(plan);
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const every = plan.snapshots?.drills?.schedule;
  try {
    const records = drillRecords((await files.readFile(`${folder}/${HOSTING_DRILLS_LOG}`)) ?? "");
    const last = records.at(-1);
    const lines =
      last !== undefined
        ? [drillStatusLine(last, flags, "hosting")]
        : plan.snapshots?.drills === undefined
          ? []
          : [NONE_YET(flags)];
    if (every !== undefined) {
      const proved = lastRan(records)?.id;
      const newest = ((await files.list(`${folder}/dumps`)) ?? [])
        .map((name) => ACCOUNT_SNAPSHOT.exec(name))
        .filter((match) => match !== null)
        .sort((a, b) => (a[1] as string).localeCompare(b[1] as string))
        .at(-1);
      if (newest !== undefined && newest[1] !== proved) {
        const [, id, year, month, day, hour, minute, second] = newest;
        lines.push(
          ...overdueWarning(
            deps,
            every,
            `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
            `the snapshot ${id} has waited for one since`,
            { target: "hosting", flags },
          ),
        );
      }
    }
    return lines.map((line) => deps.redactor.redact(line));
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return [deps.redactor.redact(`Restore drills: ${errorText(error)}`)];
  }
}
