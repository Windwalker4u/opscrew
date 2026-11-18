/**
 * `opscrew restore --drill` in the user's Portainer (029 plan.md 19., research R24): a second stack
 * `opscrew-<app>-drill`, approved as a stack plan by its hash. Not built yet.
 */
import { OpsCrewError } from "@opscrew/core";
import type { SnapshotRun } from "./run";
import type { DrillReport, DrillRequest, SnapshotServices } from "./types";

/**
 * The drill `request` asks in the user's Portainer of `run`.
 * @throws OpsCrewError `INTERNAL`: not built yet.
 */
export async function drillInPortainer(
  _run: SnapshotRun,
  _services: SnapshotServices,
  _request: DrillRequest,
): Promise<DrillReport> {
  throw new OpsCrewError("INTERNAL", "Restore drills in a Portainer are not built yet.");
}
