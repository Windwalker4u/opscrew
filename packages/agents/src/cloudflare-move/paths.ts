import { join } from "node:path";
import type { ProjectPaths } from "@opscrew/core";

/**
 * The environment's move folder, `<state folder>/cloudflare-move/` (data model 3), or the path
 * `parts` name in it: every file of the move that is not in the app's own records is there.
 */
export function moveFolder(paths: Pick<ProjectPaths, "stateDir">, ...parts: string[]): string {
  return join(paths.stateDir, "cloudflare-move", ...parts);
}
