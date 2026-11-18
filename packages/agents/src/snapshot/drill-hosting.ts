/**
 * `opscrew restore --drill` on a hosting account with a panel (029 plan.md 19., research R25): a
 * hash-bound `drill` request the account's agent carries out into the standing drill database.
 * Not built yet.
 */
import { OpsCrewError } from "@opscrew/core";
import type { SnapshotRun } from "./run";
import type { DrillReport, DrillRequest, SnapshotServices } from "./types";

/**
 * The drill `request` asks on the hosting account of `run`.
 * @throws OpsCrewError `INTERNAL`: not built yet.
 */
export async function drillOnHosting(
  _run: SnapshotRun,
  _services: SnapshotServices,
  _request: DrillRequest,
): Promise<DrillReport> {
  throw new OpsCrewError("INTERNAL", "Restore drills on a hosting account are not built yet.");
}
