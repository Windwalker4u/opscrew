/**
 * A second app's reference to the first app, whose server OpsCrew created and this app shares:
 * where that app's repository is on this computer (`.opscrew/server.json` → `own.shares`), and its
 * paths from there. Local only: nothing of it is committed.
 */
import { type ProjectPaths, resolveProjectPaths } from "@opscrew/core";
import { readOwnServerRecord } from "../shared/own-server";
import type { SharesReference } from "../shared/server-record";

/**
 * The reference this app keeps to the first app (`own.shares`); `undefined` when the app is not a
 * second app on another app's server. A damaged `.opscrew/server.json` stops with
 * `ARTIFACT_INVALID`.
 */
export async function readShares(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<SharesReference | undefined> {
  return (await readOwnServerRecord(paths))?.shares;
}

/**
 * The first app's paths, from its repository folder, app key and environment in `ref`, laid out
 * as every phase lays out a project's, with the OpsCrew home of `paths` (this computer's: the
 * first app's deploy key and pinned host key are there).
 * @throws OpsCrewError `INVALID_INPUT` when the app key or the environment is not a valid name.
 */
export function firstAppPaths(paths: Pick<ProjectPaths, "homeDir">, ref: SharesReference) {
  return resolveProjectPaths(ref.root, {
    env: { OPSCREW_HOME: paths.homeDir },
    ...(ref.app === undefined ? {} : { app: ref.app }),
    environment: ref.environment,
  });
}
