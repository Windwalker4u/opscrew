import { join } from "node:path";
import {
  ENVIRONMENT_NAME_MESSAGE,
  ENVIRONMENT_NAME_PATTERN,
  exists,
  OpsCrewError,
  resolveProjectPaths,
} from "@opscrew/core";
import { environmentsOf, resolveEnvironmentPaths } from "@opscrew/plan-schema";
import { appFlag } from "../apps/choice";

/** How {@link resolveEnvironment} asks which environment to act on, and of which app. */
export interface EnvironmentChoiceDeps {
  /** The further app whose environments these are (`resolveApp`'s key); absent: the first app's. */
  app?: string | undefined;
  /** Asks the user to pick one of `environments`; given only when a person can answer. */
  choose?: (environments: readonly string[]) => Promise<string>;
  /**
   * When true (design commands only), accept a valid missing environment name (`"prod"` or
   * `ENVIRONMENT_NAME_PATTERN`) when the app has no environments yet (bootstrapping a first
   * environment) or when `requested === "prod"` (adding `prod` later). Once an environment exists,
   * adding a new non-`prod` environment still goes through `opscrew env add <name>`.
   */
  allowNew?: boolean | undefined;
}

/**
 * `name` when the app `app` has that environment; else plan-schema's `INVALID_INPUT` with the
 * list.
 */
async function known(root: string, name: string, app: string | undefined): Promise<string> {
  // Only the check matters here, so no OpsCrew home is read for the paths.
  await resolveEnvironmentPaths(root, name, { env: {}, ...(app === undefined ? {} : { app }) });
  return name;
}

/**
 * ` --env <name>` for the commands OpsCrew suggests for the environment `name` of the app `app`
 * (a further app's key; absent: the first app) while that app has several environments (prod
 * included: a bare command then asks, or stops in a script), else "". The app's own flag is
 * `appFlag`'s.
 */
export async function environmentFlag(
  root: string,
  name: string,
  app?: string | undefined,
): Promise<string> {
  // Skips reading the plans while prod is alone (no environments folder): a hint is then never
  // stopped by a plan that cannot be read, as requireOwnHostnames does.
  const paths = resolveProjectPaths(root, { env: {}, ...(app === undefined ? {} : { app }) });
  if (!(await exists(join(paths.artefactsDir, "environments")))) return "";
  return (await environmentsOf(root, app)).length > 1 ? ` --env ${name}` : "";
}

/**
 * What the commands OpsCrew suggests for the environment `name` of the app `app` add: the app's
 * `appFlag` (` --app <key>`, or ` --app .` beside further apps), then {@link environmentFlag}.
 */
export async function commandFlags(
  root: string,
  name: string,
  app: string | undefined,
): Promise<string> {
  return `${await appFlag(root, app)}${await environmentFlag(root, name, app)}`;
}

/**
 * The environment a command acts on (`--env`, the MCP tools' `environment`) of the app
 * `deps.app` (the first app by default): `requested`, which must be one of the app's
 * environments (or, when `deps.allowNew` is true, any valid environment name — `"prod"` or
 * `ENVIRONMENT_NAME_PATTERN` — even before its plan exists); else the only one (`"prod"` for an
 * app without a plan yet); else, with several, the one the user picks through `deps.choose`.
 * @throws OpsCrewError `INVALID_INPUT` for an unknown or invalid name, and `PHASE_PRECONDITION`
 * with the names when there are several and no one can be asked (a script).
 */
export async function resolveEnvironment(
  root: string,
  requested: string | undefined,
  deps: EnvironmentChoiceDeps = {},
): Promise<string> {
  const { app, allowNew } = deps;
  if (requested !== undefined) {
    if (allowNew === true) {
      if (requested !== "prod" && !ENVIRONMENT_NAME_PATTERN.test(requested)) {
        throw new OpsCrewError(
          "INVALID_INPUT",
          `Environment name "${requested}" is not valid: an environment's name ${ENVIRONMENT_NAME_MESSAGE}.`,
          { hint: "Use lowercase letters, digits and hyphens, for example staging or dev." },
        );
      }
      const existing = await environmentsOf(root, app);
      if (existing.includes(requested) || existing.length === 0 || requested === "prod") {
        return requested;
      }
      const appFlagText = app === undefined ? "" : ` --app ${app}`;
      throw new OpsCrewError(
        "INVALID_INPUT",
        `The app${app === undefined ? "" : ` ${app}`} has no environment "${requested}". Its environments: ${existing.map((name) => `"${name}"`).join(", ")}.`,
        {
          hint: `Add it first with \`opscrew env add ${requested}${appFlagText}\`, or run \`opscrew env list${appFlagText}\` to see the app's environments.`,
        },
      );
    }
    return known(root, requested, app);
  }
  const names = await environmentsOf(root, app);
  if (names.length <= 1) return names[0] ?? "prod";
  if (deps.choose !== undefined) return known(root, await deps.choose(names), app);
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The app${app === undefined ? "" : ` ${app}`} has several environments (${names.map((name) => `"${name}"`).join(", ")}), so OpsCrew needs to know which one this is for. Nothing was changed.`,
    { hint: `Add \`--env <name>\`, for example \`--env ${names[1]}\`.` },
  );
}
