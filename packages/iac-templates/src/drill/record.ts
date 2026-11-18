/**
 * What `snapshot.sh drill` reads and writes besides the drill's copy (029 plan.md 19., research
 * R18, R19, R29): its one-time approval, and the one line each drill leaves in
 * `.snapshots/drills.log` and prints on stdout, with no value in it.
 */
import { SNAPSHOTS_DIR } from "../workflow/snapshots";

/**
 * The one-time approval of `snapshot.sh drill` by hand, in the app's folder: `opscrew restore
 * --drill` writes it after the user's approval, and the script reads and removes it before any
 * change. A scheduled drill needs none: the host plan that installs its schedule approves it.
 */
export const DRILL_APPROVAL_FILE = ".drill-snapshot";

/** What a drill by hand does: a drill, a drill whose copy stays, or the removal of a kept copy. */
export type DrillAction = "drill" | "keep" | "remove";

/**
 * The line of {@link DRILL_APPROVAL_FILE}, without its newline: the snapshot's id (`-` for a
 * removal), the action, the time it expires in Unix seconds, and the one part `--only` drills
 * (`-` for every one).
 */
export function drillApprovalLine(input: {
  id?: string;
  action: DrillAction;
  expiresAt: number;
  only?: string;
}): string {
  return `${input.id ?? "-"} ${input.action} ${input.expiresAt} ${input.only ?? "-"}`;
}

/** How long a drill may take in all, then it stops and removes its copy (research R29 8.). */
export const DRILL_LIMIT_SECONDS = 30 * 60;

/** How long the app's health check may take to pass on a drill's copy (R17). */
export const DRILL_HEALTH_SECONDS = 5 * 60;

/** How long an app with no health check must keep running on a drill's copy (R17). */
export const DRILL_RUNNING_SECONDS = 60;

/** The seconds between two reads of the app's health on a drill's copy. */
export const DRILL_HEALTH_POLL_SECONDS = 5;

/** Each drill's line, beside `scheduled.log` in the app's folder: never a value. */
export const DRILLS_LOG = `${SNAPSHOTS_DIR}/drills.log`;

/** Each drill's line on a hosting account, in the app's folder there: never a value. */
export const HOSTING_DRILLS_LOG = "state/drills.log";

/** The start of the line `snapshot.sh drill` prints on stdout: its line of {@link DRILLS_LOG}. */
export const DRILL_RECORD_PREFIX = "drill-record ";

/**
 * How a drill ended (research R19, R29): restored and healthy; restored but the app did not become
 * healthy; a part did not restore (or a database holds no table); skipped (a deploy or a snapshot
 * ran, or too little disk or memory), which is never a failure; or failed otherwise (the image
 * gone, the copy's network not cut off, the time limit, …), its reason a fixed word.
 */
export type DrillResult = "healthy" | "unhealthy" | "not-restored" | "skipped" | "failed";

/** One drill's line of {@link DRILLS_LOG}. */
export interface DrillRecord {
  /** When it ended (ISO). */
  end: string;
  kind: "manual" | "scheduled";
  result: DrillResult;
  /** The snapshot's id, once chosen. */
  id?: string;
  /** The first 12 hex digits of the version the snapshot recorded. */
  version?: string;
  /** When it started (ISO). */
  start?: string;
  /** Each part restored: its file's size in bytes and the seconds it took. */
  parts: { name: string; size: number; seconds: number }[];
  /**
   * The app's state at the end of the health read (`healthy`, `unhealthy`, `starting`, `running`
   * without a health check, `stopped`) and the seconds it took.
   */
  health?: { state: string; seconds: number };
  /** Each restored database's tables (collections for MongoDB); none when it could not be read. */
  tables: { service: string; count?: number }[];
  /** What became of the copy: removed, kept with `--keep`, or its removal failed. */
  removal?: "removed" | "kept" | "failed";
  /** True when a crashed run's leftovers were removed first. */
  cleaned: boolean;
  /** A fixed word: why it was skipped or failed, or the part that did not restore. */
  reason?: string;
}

/** A record's line: its end, kind and result, then `key=value` fields. */
const LINE =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (manual|scheduled) (healthy|unhealthy|not-restored|skipped|failed)((?: [a-z]+=\S+)*)$/;

/** `-` is a field with no value. */
function given(value: string | undefined): string | undefined {
  return value === undefined || value === "-" ? undefined : value;
}

/** The comma-separated items of a field, each matching `pattern`, or `undefined` for a bad one. */
function items(value: string | undefined, pattern: RegExp): RegExpExecArray[] | undefined {
  const text = given(value);
  if (text === undefined) return [];
  const matches = text.split(",").map((item) => pattern.exec(item));
  return matches.every((match) => match !== null) ? (matches as RegExpExecArray[]) : undefined;
}

/**
 * `line` (of {@link DRILLS_LOG}, or the script's stdout after {@link DRILL_RECORD_PREFIX}) as a
 * record, or `undefined` when it is not one.
 */
export function drillRecord(line: string): DrillRecord | undefined {
  const match = LINE.exec(line.trim());
  if (match === null) return undefined;
  const fields = new Map(
    (match[4] ?? "")
      .trim()
      .split(" ")
      .filter((field) => field !== "")
      .map((field) => [field.slice(0, field.indexOf("=")), field.slice(field.indexOf("=") + 1)]),
  );
  const parts = items(fields.get("parts"), /^([a-z0-9-]+):(\d+):(\d+)$/);
  const tables = items(fields.get("tables"), /^([a-z0-9-]+):(\d+|failed)$/);
  const health = given(fields.get("health"));
  const healthMatch = health === undefined ? undefined : /^([a-z]+):(\d+)$/.exec(health);
  const removal = given(fields.get("removal"));
  if (parts === undefined || tables === undefined || healthMatch === null) return undefined;
  if (removal !== undefined && !["removed", "kept", "failed"].includes(removal)) return undefined;
  const id = given(fields.get("id"));
  const version = given(fields.get("version"));
  const start = given(fields.get("start"));
  const reason = given(fields.get("reason"));
  return {
    end: match[1] as string,
    kind: match[2] as DrillRecord["kind"],
    result: match[3] as DrillResult,
    ...(id === undefined ? {} : { id }),
    ...(version === undefined ? {} : { version }),
    ...(start === undefined ? {} : { start }),
    parts: parts.map(([, name, size, seconds]) => ({
      name: name as string,
      size: Number(size),
      seconds: Number(seconds),
    })),
    ...(healthMatch === undefined
      ? {}
      : { health: { state: healthMatch[1] as string, seconds: Number(healthMatch[2]) } }),
    tables: tables.map(([, service, count]) => ({
      service: service as string,
      ...(count === "failed" ? {} : { count: Number(count) }),
    })),
    ...(removal === undefined ? {} : { removal: removal as NonNullable<DrillRecord["removal"]> }),
    cleaned: fields.get("cleaned") === "yes",
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * The records of the {@link DRILL_RECORD_PREFIX} lines in `stdout` (`snapshot.sh drill`'s, or the
 * log of a Portainer stack's `drill-<service>` container), oldest first; other lines are left out.
 */
export function drillRecordsIn(stdout: string): DrillRecord[] {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith(DRILL_RECORD_PREFIX))
    .map((line) => drillRecord(line.slice(DRILL_RECORD_PREFIX.length)))
    .filter((record) => record !== undefined);
}
