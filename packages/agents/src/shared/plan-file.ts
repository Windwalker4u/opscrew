import {
  type DeployPlan,
  readOptionalArtifact,
  serializeArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { prunedPlan } from "./cost-times";

/**
 * Writes `plan` to `file` as it is, its cost's ended items and one-time fees older than the
 * previous calendar month left out (`prunedCost`). Every write of a plan goes through here or
 * {@link writePlanIfChanged}.
 */
export async function writePlan(
  deps: Pick<PhaseDeps, "clock">,
  file: string,
  plan: DeployPlan,
): Promise<void> {
  await writeArtifact("plan", file, prunedPlan(plan, deps.clock.now()));
}

/**
 * Writes `plan` to `opscrew/plan.yaml` with `updatedAt` now, pruned as {@link writePlan} prunes,
 * unless it equals the plan there apart from `updatedAt`: then the file stays as it is, so a run
 * with nothing to change commits nothing. Every phase that records something in the plan writes it here.
 */
export async function writePlanIfChanged(
  deps: Pick<PhaseDeps, "paths" | "clock">,
  plan: DeployPlan,
): Promise<void> {
  const file = deps.paths.files.plan;
  const onDisk = await readOptionalArtifact("plan", file);
  const pruned = prunedPlan(plan, deps.clock.now());
  if (
    onDisk !== undefined &&
    serializeArtifact("plan", { ...pruned, updatedAt: onDisk.updatedAt }) ===
      serializeArtifact("plan", onDisk)
  ) {
    return;
  }
  await writeArtifact("plan", file, { ...pruned, updatedAt: deps.clock.now().toISOString() });
}
