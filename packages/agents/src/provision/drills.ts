/**
 * The scheduled restore drills' part of a server's host plan (`snapshots.drills.schedule`, research
 * R28), the same on a server the user owns (`desiredHost`) and on one OpsCrew created (the deploy
 * login's plan, `cloudRunnerPlan`).
 */
import type { DesiredHost } from "@opscrew/connector-ssh-host";
import { sha256Hex } from "@opscrew/core";
import {
  DRILL_RECIPE_DIR,
  drillPlan,
  drillRecipe,
  scheduledDrillParts,
} from "@opscrew/iac-templates";
import { type DeployPlan, ghcrImageFor } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { gitClient, githubCoordinates } from "../shared";
import { drillEnvFor } from "../snapshot/drill-core";

/**
 * The scheduled restore drills' part of the desired host: the copy's files as `drillRecipe`
 * renders them, by path in their folder on the server, the copy's generated values left as the
 * server's placeholders and the app's image named as the manual drill names it
 * (`ghcr.io/<owner>/<repo>[/<key>]`), and the SHA-256 of `.env.preview`'s values, which reach the
 * server only at apply ({@link drillEnv}). `undefined` without a schedule.
 */
export async function desiredDrills(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  plan: DeployPlan,
): Promise<DesiredHost["drills"]> {
  if (plan.snapshots?.drills?.schedule === undefined) return undefined;
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  const env = await drillEnv(deps, plan);
  const files = drillRecipe(plan, {
    repository: ghcrImageFor(`${owner}/${repo}`, plan.app.key),
    env: env.templates,
    ...(env.values === "" ? {} : { previewValues: true }),
  });
  return {
    files: Object.fromEntries(
      files.map((file) => [file.path.slice(DRILL_RECIPE_DIR.length + 1), file.content]),
    ),
    valuesSha256: sha256Hex(env.values),
  };
}

/**
 * The scheduled drill's env files, built for its copy of the parts a scheduled snapshot holds
 * (`scheduledDrillParts`), and `.env.preview`'s values as the text of its `values.env`, each value
 * known to the redactor from here on; never a value of the app's `.env`.
 */
export async function drillEnv(deps: Pick<PhaseDeps, "paths" | "redactor">, plan: DeployPlan) {
  return drillEnvFor(deps, drillPlan(plan, { id: "scheduled", parts: scheduledDrillParts(plan) }));
}
