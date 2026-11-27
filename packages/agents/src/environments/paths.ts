import { type ProjectPaths, resolveProjectPaths } from "@opscrew/core";
import { type DeployPlan, environmentsOf, readOptionalArtifact } from "@opscrew/plan-schema";

/**
 * The paths of the environment `name` of the app `paths` belong to (`paths.app`, a further app's
 * key, kept), beside `paths`: the same project and OpsCrew home.
 */
export function environmentPaths(paths: ProjectPaths, name: string): ProjectPaths {
  return resolveProjectPaths(paths.root, {
    env: { OPSCREW_HOME: paths.homeDir },
    ...(paths.app === undefined ? {} : { app: paths.app }),
    environment: name,
  });
}

/**
 * The app's base name (without `-<env>`) from an environment's plan: `prod`'s `app.name` as-is, or
 * another environment's `app.name` with its trailing `-<env>` stripped.
 */
export function baseAppNameFrom(plan: Pick<DeployPlan, "app">, environment: string): string {
  if (environment === "prod") return plan.app.name;
  const suffix = `-${environment}`;
  return plan.app.name.endsWith(suffix) && plan.app.name.length > suffix.length
    ? plan.app.name.slice(0, -suffix.length)
    : plan.app.name;
}

/**
 * The app's base name from its reference plan (`prod` when it exists, else the first other
 * existing environment); `undefined` when no other environment has a plan yet.
 */
export async function referenceAppName(paths: ProjectPaths): Promise<string | undefined> {
  const prod = await readOptionalArtifact("plan", environmentPaths(paths, "prod").files.plan);
  if (prod !== undefined) return prod.app.name;
  for (const env of await environmentsOf(paths.root, paths.app)) {
    if (env === paths.environment) continue;
    const plan = await readOptionalArtifact("plan", environmentPaths(paths, env).files.plan);
    if (plan !== undefined) return baseAppNameFrom(plan, env);
  }
  return undefined;
}
