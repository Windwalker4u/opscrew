import type { ProjectPaths } from "@opscrew/core";
import type { DetectOptions } from "@opscrew/detect";
import { readArtifact } from "@opscrew/plan-schema";
import { recordedAppDir } from "../apps/record";

/**
 * How detection describes the app `paths` belong to: in `appDir` (a further app's defaults to its
 * record's folder), with the folders its plan shares (`app.sharedPaths` in `opscrew/plan.yaml`,
 * none without a valid plan), and, for a further app, none of the repository root's own files.
 * @throws ArtifactError when a further app's record is missing or invalid.
 */
export async function appDetectOptions(
  paths: ProjectPaths,
  appDir?: string,
): Promise<DetectOptions> {
  const dir = appDir ?? (await recordedAppDir(paths));
  let sharedPaths: string[] | undefined;
  try {
    sharedPaths = (await readArtifact("plan", paths.files.plan)).app.sharedPaths;
  } catch {
    // no plan yet
  }
  return {
    ...(dir !== undefined ? { appDir: dir } : {}),
    ...(sharedPaths !== undefined ? { sharedPaths } : {}),
    ...(paths.app !== undefined ? { rootFiles: false } : {}),
  };
}
