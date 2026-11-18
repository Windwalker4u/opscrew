/**
 * `status`'s line on restore drills (029 plan.md 19., research R18, R29): the last drill on the
 * app's server or this computer, from the last line of `.snapshots/drills.log` there, read-only.
 * A Portainer's and a hosting account's drills are read where they run.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { errorText, isUserFacingError, OpsCrewError, plural } from "@opscrew/core";
import { DRILLS_LOG, type DrillRecord, drillRecord, snapshotParts } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, onOneServer } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { appFolder } from "../localhost/services";

/** Why a drill was skipped or failed, by the script's reason, in a few words. */
const REASONS: Record<string, string> = {
  locked: "a deploy, a snapshot or a restore was running",
  rotation: "a credential rotation held the app",
  disk: "too little free disk",
  memory: "too little free memory",
  gone: "that snapshot's version of the app is gone",
  network: "the copy's network was not cut off",
  timeout: "it ran past its 30-minute limit",
  leftovers: "an earlier drill's copy could not be removed",
  stopped: "it was stopped",
};

/** Minutes and seconds between two ISO times: `4 min 10 s`, `52 s`. */
function took(start: string | undefined, end: string): string | undefined {
  if (start === undefined) return undefined;
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return undefined;
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds % 60} s`;
}

/**
 * The line of `status` for the drill `record`: its snapshot, time, how long it took and how it
 * ended, healthy, failed or skipped with the reason (research R29), and a copy it left.
 */
export function drillStatusLine(record: DrillRecord, flags: string): string {
  const reason = record.reason === undefined ? "" : (REASONS[record.reason] ?? record.reason);
  const result =
    record.result === "healthy"
      ? "healthy"
      : record.result === "unhealthy"
        ? "restored, but the app did not become healthy"
        : record.result === "not-restored"
          ? `the snapshot did not restore (${record.reason ?? "a part"})`
          : `${record.result}: ${reason}`;
  const time = took(record.start, record.end);
  const copy =
    record.removal === "kept"
      ? `; its copy is kept: \`opscrew restore --drill --remove${flags}\` removes it`
      : record.removal === "failed"
        ? `; its copy could not be removed: run \`opscrew restore --drill --remove${flags}\``
        : "";
  return [
    `Last restore drill: ${record.id ?? "no snapshot"}`,
    `${record.kind === "scheduled" ? "scheduled, " : ""}${formatUtc(record.end)}`,
    ...(time === undefined || record.result === "skipped" ? [] : [`took ${time}`]),
    `${result}${record.tables.length === 0 ? "" : `, ${record.tables.map((table) => (table.count === undefined ? `${table.service} not read` : `${table.service} ${plural(table.count, "table")}`)).join(", ")}`}${copy}.`,
  ].join(", ");
}

/** The last line of the drills' log in the app's folder on this computer, `""` without one. */
async function computerDrillLog(deps: PhaseDeps, plan: DeployPlan): Promise<string> {
  try {
    const text = await readFile(join(appFolder(deps.paths, plan), DRILLS_LOG), "utf8");
    return text.split(/\r?\n/).findLast((line) => line.trim() !== "") ?? "";
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
 * The line on restore drills of the app's server or this computer when it holds data: the last
 * drill, or with `snapshots.drills` on and none yet a line that says so; a note when it cannot be
 * read. None elsewhere, or with neither a drill nor the setting. On a server the drills' log's
 * last line is `serverLog`, read with the snapshots (`snapshotStatusReport`), and none without it;
 * on this computer it is read from the app's folder, with no shell.
 */
export async function drillStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  serverLog?: string,
): Promise<{ lines: string[]; drill?: DrillRecord }> {
  const { provider } = plan.target;
  const local = provider === "localhost";
  if (!onOneServer(provider) && !local) return { lines: [] };
  if (snapshotParts(plan, APP_SERVER).length === 0) return { lines: [] };
  if (!local && serverLog === undefined) return { lines: [] };
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  try {
    const log = local ? await computerDrillLog(deps, plan) : (serverLog ?? "");
    const drill = log === "" ? undefined : drillRecord(log);
    if (drill !== undefined) {
      return { lines: [deps.redactor.redact(drillStatusLine(drill, flags))], drill };
    }
    return plan.snapshots?.drills === undefined
      ? { lines: [] }
      : { lines: [`Restore drills: none yet; \`opscrew restore --drill${flags}\` runs one.`] };
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    return { lines: [deps.redactor.redact(`Restore drills: ${errorText(error)}`)] };
  }
}
