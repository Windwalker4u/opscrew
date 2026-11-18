/**
 * `status`'s line on restore drills (029 plan.md 19., research R18, R29): the last drill on the
 * app's server or this computer, from the last line of `.snapshots/drills.log` there, read-only.
 * A Portainer's and a hosting account's drills are read where they run.
 */
import { errorText, isUserFacingError, plural } from "@opscrew/core";
import { DRILLS_LOG, type DrillRecord, drillRecord, snapshotParts } from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, onOneServer } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { dataHosts, hostFailure, READ_TIMEOUT_MS, type ScriptHost } from "../snapshot/hosts";
import type { SnapshotRun } from "../snapshot/run";
import type { SnapshotServices } from "../snapshot/types";

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

/** The last line of the drills' log on `host`, as a record; `undefined` without one. */
async function lastDrill(run: SnapshotRun, host: ScriptHost): Promise<DrillRecord | undefined> {
  const result = await host.run(
    `if [ -f ${DRILLS_LOG} ]; then tail -n 1 ${DRILLS_LOG}; fi`,
    READ_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) throw hostFailure(run, host, result, "read the restore drills");
  const line = result.stdout.split(/\r?\n/).find((each) => each.trim() !== "");
  return line === undefined ? undefined : drillRecord(line);
}

/**
 * The line on restore drills of the app's server or this computer when it holds data: the last
 * drill, or with `snapshots.drills` on and none yet a line that says so; a note when it cannot be
 * read. None elsewhere, or with neither a drill nor the setting.
 */
export async function drillStatusReport(
  deps: PhaseDeps,
  plan: DeployPlan,
  services: SnapshotServices,
): Promise<{ lines: string[]; drill?: DrillRecord }> {
  const { provider } = plan.target;
  if (!onOneServer(provider) && provider !== "localhost") return { lines: [] };
  if (snapshotParts(plan, APP_SERVER).length === 0) return { lines: [] };
  const environment = deps.paths.environment;
  const flags = await commandFlags(deps.paths.root, environment, deps.paths.app);
  const run: SnapshotRun = { deps, plan, environment, flags, services };
  try {
    const host = (await dataHosts(run, [APP_SERVER])).get(APP_SERVER) as ScriptHost;
    const drill = await lastDrill(run, host);
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
