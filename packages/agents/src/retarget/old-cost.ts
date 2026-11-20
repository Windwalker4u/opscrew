/**
 * The old side's running cost items while a move runs (031 US4). The move's plan carries the new
 * side's cost, so the old side's items, with when each started, are kept on this computer from
 * the move's start; `--finish` ends them when it removes the old side, and `--abort` gives them
 * back their start.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@opscrew/core";
import { type CostItem, CostItemSchema, type DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { withoutServerCost } from "../design/servers";
import { readValidJson } from "../shared";

const OldCostSchema = z.strictObject({ items: z.array(CostItemSchema) });

/** `.opscrew/retarget-cost.json`: machine-local, as the move's other records. */
function oldCostFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.stateDir, "retarget-cost.json");
}

/**
 * Keeps the running items of the app's server in `plan`'s cost (those with `since`; the extra
 * servers' lines stay out, as those servers do not move).
 */
export async function keepOldCost(deps: Pick<PhaseDeps, "paths">, plan: DeployPlan): Promise<void> {
  const app = (plan.servers ?? []).reduce(
    (cost, server) => withoutServerCost(cost, server.name),
    plan.cost,
  );
  const items = app.breakdown.filter((line) => line.since !== undefined);
  await writeFileAtomic(oldCostFile(deps), `${JSON.stringify({ items })}\n`);
}

/** The old side's running items kept at the move's start; none without a (readable) record. */
export async function readOldCost(deps: Pick<PhaseDeps, "paths">): Promise<CostItem[]> {
  return (await readValidJson(oldCostFile(deps), OldCostSchema))?.items ?? [];
}

/** Forgets the old side's items (the move ended). */
export async function forgetOldCost(deps: Pick<PhaseDeps, "paths">): Promise<void> {
  await rm(oldCostFile(deps), { force: true });
}
