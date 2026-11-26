/**
 * The app's settings around a move's switch (feature 018): `app.env` on the app's server, which
 * the deploy writes from the GitHub secret `OPSCREW_APP_ENV`. The switch changes only the moving
 * service's address in them. With a PostgreSQL's two logins (`logins: separate`, 047), the release
 * command's `release.db.env` (from `OPSCREW_RELEASE_DB_ENV`) holds the owner's address and follows
 * too. Their text holds secrets: it is never logged, shown or audited.
 */
import type { CommandResult } from "@opscrew/contracts";
import { OpsCrewError, type Redactor } from "@opscrew/core";
import {
  appDir,
  DEPLOY_SECRETS,
  maskFileScript,
  RELEASE_DB_ENV,
  releaseVariables,
  serviceSpec,
} from "@opscrew/iac-templates";
import { type DeployPlan, type Move, type PlanService, postgresLogins } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitHubSetup } from "../provision/credentials";
import { deploySecretPlace, setSecretAt } from "../provision/secrets";
import { dotenvLine, readValidJson, serverWords } from "../shared";
import { GeneratedValuesSchema, generatedValuesFile } from "../shared/app-secrets";
import { recordAppEnvText } from "../values/record";
import type { MoveShell } from "./shells";

/** The app's settings file on its server. */
function appEnvFile(plan: DeployPlan): string {
  return `${appDir(plan)}/app.env`;
}

/** The release command's settings file on the app's server (047). */
export function releaseEnvFile(plan: DeployPlan): string {
  return `${appDir(plan)}/${RELEASE_DB_ENV.file}`;
}

/** The app's settings before and after a move's switch, in the GitHub secret's form. */
export interface SwitchedEnv {
  /** With the moving service's address on `move.from`. */
  before: string;
  /** With its address on `move.to`. */
  after: string;
  /** True when the app's server holds `after` already: an earlier window switched them. */
  switched: boolean;
  /**
   * The release command's `release.db.env` before and after the switch, when the moving service
   * is a PostgreSQL with two logins (047).
   */
  release?: { before: string; after: string };
}

/** One side of a switch: the settings before it, or after it. */
export type EnvSide = "before" | "after";

/**
 * `text`'s lines (no final newline) with each `NAME=value` line that holds `pair(NAME)`'s first
 * value holding its second instead, and a final newline.
 */
function swapped(text: string, pair: (name: string) => [string, string] | undefined): string {
  const lines = text.replace(/\n+$/, "").split("\n");
  return `${lines
    .map((line) => {
      const name = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1];
      const values = name === undefined ? undefined : pair(name);
      return name !== undefined && values !== undefined && line === dotenvLine(name, values[0])
        ? dotenvLine(name, values[1])
        : line;
    })
    .join("\n")}\n`;
}

/** Reads `file` on the app's server, or stops plainly, changing nothing. */
async function readSettings(app: MoveShell, file: string, what: string): Promise<string> {
  const result = await app.remote.run(`cat ${file}`, { timeoutMs: 60_000 });
  if (result.exitCode === 0) return result.stdout;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `OpsCrew could not read ${what} on ${serverWords(app.name)} (exit code ${result.exitCode}). Nothing was changed.`,
    { hint: "Check that the app is deployed there, then run `opscrew provision` again." },
  );
}

/**
 * Reads the app's settings on its server (`app`) and gives them before and after the switch of
 * `move`: each variable that holds the moving service's address (as OpsCrew writes it, with the
 * password this computer keeps) on one server, with its address on the other.
 * @throws OpsCrewError when the settings cannot be read, or the service's secrets are not on this
 * computer.
 */
export async function switchedEnv(
  deps: Pick<PhaseDeps, "paths">,
  app: MoveShell,
  plan: DeployPlan,
  move: Move,
): Promise<SwitchedEnv> {
  const service = plan.services.find((s) => s.name === move.service);
  if (service === undefined) throw new Error(`The plan has no service ${move.service}.`);
  const generated = (await readValidJson(generatedValuesFile(deps), GeneratedValuesSchema)) ?? {};
  const secretOf = (of: PlanService, name: string) => {
    const value =
      of.kind === "postgres" && name === "password"
        ? generated.dbPassword
        : generated.services?.[of.name]?.[name];
    if (value !== undefined) return value;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `This computer does not keep the ${name} of ${of.name}, so OpsCrew cannot give the app its new address. Nothing was changed.`,
      {
        hint: "Run `opscrew provision` on the computer that set up the app: it keeps the generated values.",
      },
    );
  };
  const at = (step: Move["step"]): DeployPlan => ({ ...plan, move: { ...move, step } });
  const address = (step: Move["step"]) =>
    serviceSpec(service.kind).address({
      plan: at(step),
      service,
      secretRef: (name) => secretOf(service, name),
    });
  const from = address("deployed");
  const to = address("switched");

  const text = await readSettings(app, appEnvFile(plan), "the app's settings (app.env)");
  const now = swapped(text, () => undefined);
  const before = swapped(text, () => [to, from]);
  const after = swapped(text, () => [from, to]);
  const env: SwitchedEnv = { before, after, switched: now === after && now !== before };
  if (!postgresLogins(service)) return env;
  // The release's variables, with the owner's address on each server.
  const old = releaseVariables(at("deployed"), secretOf);
  const moved = releaseVariables(at("switched"), secretOf);
  const pair =
    (a: Record<string, string>, b: Record<string, string>) =>
    (name: string): [string, string] | undefined => {
      const [x, y] = [a[name], b[name]];
      return x === undefined || y === undefined ? undefined : [x, y];
    };
  const release = await readSettings(app, releaseEnvFile(plan), "the release command's settings");
  return {
    ...env,
    release: {
      before: swapped(release, pair(moved, old)),
      after: swapped(release, pair(old, moved)),
    },
  };
}

/**
 * What a failed command on a server said, to follow its description: `: <its error output>`
 * (redacted, at most 300 characters), or ` (exit code <n>)` when it said nothing.
 */
export function failureDetail(
  result: Pick<CommandResult, "exitCode" | "stderr">,
  redactor: Pick<Redactor, "redact">,
): string {
  const said = redactor.redact(result.stderr.trim()).slice(0, 300);
  return said ? `: ${said}` : ` (exit code ${result.exitCode})`;
}

/**
 * Writes `env`'s `side` as the app's settings on its server (`app`), owner-only, each file
 * replaced in one step: the release command's first (with two logins, 047), then `app.env`, which
 * tells whether the switch was made.
 * @throws OpsCrewError `COMMAND_FAILED` with the server's words, never the settings.
 */
export async function writeAppEnv(
  app: MoveShell,
  plan: DeployPlan,
  env: SwitchedEnv,
  side: EnvSide,
  redactor: Pick<Redactor, "redact">,
): Promise<void> {
  const write = async (file: string, text: string, what: string) => {
    const result = await app.remote.run(
      `umask 077 && cat > ${file}.opscrew && mv ${file}.opscrew ${file}`,
      { input: text, timeoutMs: 60_000 },
    );
    if (result.exitCode === 0) return;
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `Could not write ${what} on ${serverWords(app.name)}${failureDetail(result, redactor)}.`,
      { hint: "Check the free disk space on the app's server (`df -h /srv`)." },
    );
  };
  if (env.release !== undefined) {
    await write(releaseEnvFile(plan), env.release[side], "the release command's settings");
  }
  await write(appEnvFile(plan), env[side], "the app's settings (app.env)");
}

/**
 * Rewrites Grafana Alloy's masking file `mask.re` on the app's server from the `app.env` there,
 * with the deploy's own script (`maskFileScript`), so the logs it sends mask the settings' new
 * values too; nothing when Alloy masks no log line on the app's server (neither Grafana Cloud nor
 * self-hosted monitoring is on).
 * @throws OpsCrewError `COMMAND_FAILED` with the server's words, never the settings.
 */
export async function writeMask(
  app: MoveShell,
  plan: DeployPlan,
  redactor: Pick<Redactor, "redact">,
): Promise<void> {
  const script = maskFileScript(plan);
  if (script === "") return;
  const result = await app.remote.run("bash -s", { input: script, timeoutMs: 60_000 });
  if (result.exitCode === 0) return;
  throw new OpsCrewError(
    "COMMAND_FAILED",
    `Could not rewrite Grafana Alloy's masking file (mask.re) on ${serverWords(app.name)}${failureDetail(result, redactor)}.`,
    { hint: "Check the free disk space on the app's server (`df -h /srv`)." },
  );
}

/**
 * Stores `env`'s `side` as the GitHub secret `OPSCREW_APP_ENV` of the plan's environment (where its
 * deploy secrets live), after the release command's `OPSCREW_RELEASE_DB_ENV` with two logins
 * (047), so the next deploy writes the same settings, and in OpsCrew's record of the app's values
 * (048). Audited by name only.
 */
export async function storeAppEnv(
  deps: Pick<PhaseDeps, "audit" | "paths">,
  github: Pick<GitHubSetup, "api" | "owner" | "repo">,
  plan: DeployPlan,
  env: SwitchedEnv,
  side: EnvSide,
): Promise<void> {
  if (env.release !== undefined) {
    const place = deploySecretPlace(plan, RELEASE_DB_ENV.secret);
    await setSecretAt(deps, github, place, env.release[side], "provision");
  }
  await setSecretAt(
    deps,
    github,
    deploySecretPlace(plan, DEPLOY_SECRETS.appEnv),
    env[side],
    "provision",
  );
  await recordAppEnvText(deps, plan, env[side]);
}
