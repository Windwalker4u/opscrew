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
 * For a Laravel app Railpack builds, `RAILPACK_SKIP_MIGRATIONS=true`, which keeps Railpack's start
 * script from migrating the database; nothing for another image.
 */
export function noStartMigrations(plan: DeployPlan): Record<string, string> {
  return railpackLaravel(plan) ? { RAILPACK_SKIP_MIGRATIONS: "true" } : {};
}

/**
 * What every container of the app's image gets besides `app.env`: with a release command,
 * {@link noStartMigrations}, so the web's start script leaves the migrations to the release step,
 * which runs them once before the new version takes traffic. Without a release command, Railpack's
 * start migrates, as the app's own image would.
 */
export function imageEnvironment(plan: DeployPlan): Record<string, string> {
  return plan.app.releaseCommand === undefined ? {} : noStartMigrations(plan);
}
