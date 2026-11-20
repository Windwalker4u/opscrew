import type { DeployPlan } from "@opscrew/plan-schema";

/**
 * True for a Laravel app Railpack builds: PHP built by Railpack without a web root (a plain PHP
 * app has one, design's reading of `facts.webRoot`). Railpack's build of such an app makes
 * Laravel's caches without the app's settings, and its start script migrates the database before
 * it makes them again from the container's environment.
 */
export function railpackLaravel(plan: DeployPlan): boolean {
  const build = plan.app.build;
  return (
    build?.builder === "railpack" && build.runtime.language === "php" && build.webRoot === undefined
  );
}

/**
 * What every container of the app's image gets besides `app.env`: for a Laravel app Railpack builds
 * with a release command, `RAILPACK_SKIP_MIGRATIONS=true`, so the web's start script leaves the
 * migrations to the release step, which runs them once before the new version takes traffic.
 * Without a release command, Railpack's start migrates, as the app's own image would.
 */
export function imageEnvironment(plan: DeployPlan): Record<string, string> {
  return railpackLaravel(plan) && plan.app.releaseCommand !== undefined
    ? { RAILPACK_SKIP_MIGRATIONS: "true" }
    : {};
}
