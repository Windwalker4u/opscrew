/**
 * The apps from other repositories on the first app's server OpsCrew created, as its `status`
 * names them (spec US2 #5, FR-3015): their records, read through the first app's deploy login.
 */
import { listText } from "@opscrew/core";
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  type OtherAppsDeps,
  type OtherAppsServices,
  otherAppsOnServer,
  repositoryOf,
} from "../shares/guard";

/**
 * `Also on this server: inventory (github.com/example/inventory).`: each app from another
 * repository whose record is on the server of `plan`, with its data kept when that is all it
 * left, and each one whose record OpsCrew can't read; none on another kind of target, without a
 * deployment, when the server holds no other app, or when OpsCrew couldn't look (status reads the
 * server for its components first, and says when it can't).
 */
export async function otherAppsLines(
  deps: OtherAppsDeps,
  plan: DeployPlan,
  services: OtherAppsServices,
): Promise<string[]> {
  const found = await otherAppsOnServer(deps, plan, { services });
  if (!found.reached) return [];
  const apps = [
    ...found.apps.map((record) => {
      const from = repositoryOf(record);
      const notes = [
        ...(from === undefined ? [] : [from]),
        ...(record.state === "active" ? [] : ["only its data kept"]),
      ];
      return notes.length === 0 ? record.app : `${record.app} (${notes.join(", ")})`;
    }),
    ...found.unreadable.map((app) => `${app} (an app whose record OpsCrew can't read)`),
  ];
  return apps.length === 0 ? [] : [`Also on this server: ${listText(apps)}.`];
}
