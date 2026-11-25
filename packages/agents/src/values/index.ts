/**
 * `opscrew values` (048): changes an environment's app values without a full provision. Only the
 * GitHub secrets that carry them, OpsCrew's record of them (`./record`) and the plan's `app.env`
 * change, after a `github-secrets` approval that names them, as provision's secret step asks it.
 * No value is ever shown, logged, audited or written into the plan.
 */
import { posix } from "node:path";
import { listText, OpsCrewError } from "@opscrew/core";
import {
  DEPLOY_SECRETS,
  deploySecretName,
  deploySecretNamesFor,
  isBuildValue,
  isClientExposedEnvName,
  siteEnvSecret,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  EnvVarNameSchema,
  isHostingTarget,
  isServerlessTarget,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { followsBranch, workflowBranch } from "../environments/branches";
import { commandFlags } from "../environments/choice";
import type { GitHubSetup } from "../provision/credentials";
import { requireNoMoveInProgress } from "../provision/guard";
import {
  deleteSecretAt,
  deploySecretPlace,
  placeText,
  type SecretPlace,
  setSecretAt,
} from "../provision/secrets";
import { assertValuesCurrent } from "../rotate/record";
import { readPendingRotation, unfinishedRotation } from "../rotate/values-pending";
import {
  appEnvText,
  buildLinesText,
  publicSplitSetting,
  serviceFilledNames,
  storageVariableKind,
} from "../shared/app-env";
import { registerNamedValues } from "../shared/app-secrets";
import { writePlanIfChanged } from "../shared/plan-file";
import { hasDeployment } from "../shared/server-address";
import { type RecordedValues, readAppValues, writeAppValues } from "./record";

export { appValuesFile, type RecordedValues, readAppValues, writeAppValues } from "./record";

/** What `opscrew values set` or `unset` changes. */
export interface ValueChange {
  /** The values to set, by name. */
  set: Readonly<Record<string, string>>;
  /** The names to remove. */
  unset: readonly string[];
  /** `--plain`: a name the plan doesn't have yet is added as not secret. */
  plain?: boolean;
  /** `--redeploy`: start the environment's deploy workflow afterwards. */
  redeploy?: boolean;
}

/** Where the environment's app values live in GitHub. */
type Kind = "server" | "site";

/** What {@link checkValueChange} found: where the values live, and the record. */
interface Checked {
  kind: Kind;
  record: RecordedValues | undefined;
  /** ` --app <key> --env <name>` as the commands it suggests name them. */
  flags: string;
}

/** The plan's variable `name`, if any. */
function variableOf(plan: DeployPlan, name: string) {
  return plan.app.env.find((variable) => variable.name === name);
}

/** Where the app's values of a target that keeps none in GitHub live, for the refusal. */
function elsewhere(plan: DeployPlan): string | undefined {
  if (plan.environment?.previews !== undefined) return "in each preview's own values file";
  if (isHostingTarget(plan.target)) return "on the hosting account";
  if (plan.target.provider === "portainer") return "in the app's stack in your Portainer";
  if (plan.target.provider === "localhost") return "on this computer";
  return undefined;
}

/**
 * Refuses `change` before anything is read from GitHub or changed: a target whose values don't
 * live in GitHub's secrets, an environment not set up or with no record of its values (on a
 * server), a move or an unfinished rotation, a name that isn't one, a generated or derived name,
 * a new build-time name or a new name of a site, a build value of a promoted environment, a
 * multi-line build value, `--plain` on a declared name, removing what has no value, and
 * `--redeploy` in a promoted environment. Registers every value with the redactor first.
 * @throws OpsCrewError `INVALID_INPUT` or `PHASE_PRECONDITION`, saying "Nothing was changed."
 */
export async function checkValueChange(
  deps: PhaseDeps,
  plan: DeployPlan,
  change: ValueChange,
): Promise<Checked> {
  registerNamedValues(deps.redactor, change.set);
  // Address-like names are left out above; a value set by hand is masked whatever its name.
  for (const value of Object.values(change.set)) deps.redactor.addLiteral(value, "app-env");
  const { root, environment, app } = deps.paths;
  const flags = await commandFlags(root, environment, app);
  const provision = `opscrew provision${flags}`;
  const refuse = (message: string, hint?: string) =>
    new OpsCrewError("INVALID_INPUT", `${message} Nothing was changed.`, hint ? { hint } : {});
  const stop = (message: string, hint: string) =>
    new OpsCrewError("PHASE_PRECONDITION", `${message} Nothing was changed.`, { hint });

  const where = elsewhere(plan);
  if (where !== undefined) {
    throw stop(
      `The app's values of ${environment} live ${where}, not in GitHub's secrets, so \`opscrew values\` can't change them.`,
      `Change the value in the file provision reads (.env or .env.${environment}, or the file OPSCREW_APP_ENV_FILE names), then run \`${provision}\`.`,
    );
  }
  if (!hasDeployment(plan)) {
    throw stop(
      `The ${environment} environment isn't set up yet, so it has no values to change.`,
      `Run \`${provision}\` first.`,
    );
  }
  requireNoMoveInProgress(plan);
  if (plan.move !== undefined) {
    throw stop(
      `A move of ${plan.move.service} between the app's servers is under way, and it rewrites the app's values.`,
      `Run \`${provision}\` to finish it, then change the value.`,
    );
  }
  await assertValuesCurrent(deps);
  const rotation = await readPendingRotation(deps);
  if (rotation !== undefined) {
    throw unfinishedRotation(
      rotation,
      environment,
      flags,
      "and it changes the app's values. Nothing was changed.",
    );
  }

  const kind: Kind = isServerlessTarget(plan.target) ? "site" : "server";
  const record = await readAppValues(deps);
  if (kind === "server" && record === undefined) {
    throw stop(
      `This computer has no record of the app's values of ${environment}, so it can't store one value without the others.`,
      `Run \`${provision}\` once on this computer, which records them, or bring the record from the computer that ran it with \`opscrew secrets restore${flags}\`.`,
    );
  }
  const promoted = !followsBranch(plan);
  if (change.redeploy === true && promoted) {
    throw refuse(
      `The ${environment} environment deploys the image of the environment it is promoted from, so --redeploy can't start its deploy.`,
      `Leave --redeploy out: the next promotion to ${environment} applies the values.`,
    );
  }
  const read = new Set(deploySecretNamesFor(plan));
  const names = [...Object.keys(change.set), ...change.unset];
  for (const name of names) {
    if (!EnvVarNameSchema.safeParse(name).success) {
      throw refuse(
        `${name} isn't a variable name.`,
        "A name has letters, digits and underscores and doesn't start with a digit, such as STRIPE_SECRET_KEY.",
      );
    }
    const variable = variableOf(plan, name);
    if (variable?.source === "generated") {
      throw refuse(
        `OpsCrew generates ${name}, a random secret it keeps, so it has no value of yours to set.`,
        `To replace it, run \`opscrew rotate app:${name}${flags}\`.`,
      );
    }
    if (
      variable?.source === "derived" ||
      (variable === undefined && serviceFilledNames(plan).has(name))
    ) {
      throw refuse(
        `OpsCrew fills ${name} from the deployment (a service's address, the domain or a setting it chose), so it has no value of yours to set.`,
      );
    }
    const value = change.set[name];
    if (value === undefined) {
      if (
        variable === undefined &&
        record?.app[name] === undefined &&
        record?.build[name] === undefined
      ) {
        throw refuse(`${name} has no value in ${environment}, so there is nothing to remove.`);
      }
      continue;
    }
    const build = isBuildValue(variable ?? { name });
    if (variable === undefined) {
      const why =
        kind === "site"
          ? "the site's deploy workflow reads each of its values by name"
          : isClientExposedEnvName(name)
            ? `${name} goes to the image's build, whose Dockerfile names each such value`
            : undefined;
      if (why !== undefined) {
        throw refuse(
          `${name} is new to the app, and ${why}, so only provision can add it.`,
          `Add \`- { name: ${name}, secret: ${change.plain !== true}, source: user }\` to app.env in opscrew/plan.yaml and put the value in the file provision reads, then run \`${provision}\`.`,
        );
      }
    } else if (change.plain === true) {
      throw refuse(
        `${name} is in the plan already, as a ${variable.secret ? "secret" : "plain"} value; --plain goes only with a name the plan doesn't have yet.`,
        "Leave --plain out, or change secret in opscrew/plan.yaml.",
      );
    }
    const secret =
      kind === "site" ? siteEnvSecret(name) : build ? DEPLOY_SECRETS.buildEnv : undefined;
    if (secret !== undefined && !read.has(secret)) {
      throw refuse(
        `The ${environment} environment deploys what the environment it is promoted from builds, which holds ${name}, so its own value would change nothing.`,
        "Set the value in the environment that builds it.",
      );
    }
    if (build && /[\r\n]/.test(value))
      throw refuse(`${name} is a build value and must be a single line.`);
  }
  return { kind, record, flags };
}

/** One secret this change sets (with its value) or deletes. */
type SecretChange = SecretPlace & { value?: string };

/** The record with `change` applied: each value where the plan puts it (the build's or the app's). */
function changedRecord(
  plan: DeployPlan,
  record: RecordedValues,
  change: ValueChange,
): RecordedValues {
  const next = { app: { ...record.app }, build: { ...record.build } };
  for (const name of change.unset) {
    delete next.app[name];
    delete next.build[name];
  }
  for (const [name, value] of Object.entries(change.set)) {
    const variable = variableOf(plan, name) ?? { name };
    (isBuildValue(variable) ? next.build : next.app)[name] = value;
  }
  return next;
}

/** The build values of `values` the plan marks `secret` (true) or not. */
function buildPart(plan: DeployPlan, values: Record<string, string>, secret: boolean) {
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => (variableOf(plan, name)?.secret ?? false) === secret),
  );
}

/** The secrets of a server's environment that differ between `before` and `after`. */
function serverSecrets(
  plan: DeployPlan,
  before: RecordedValues,
  after: RecordedValues,
): SecretChange[] {
  const changes: SecretChange[] = [];
  const appEnv = appEnvText(after.app);
  if (appEnv !== appEnvText(before.app)) {
    changes.push({ ...deploySecretPlace(plan, DEPLOY_SECRETS.appEnv), value: appEnv });
  }
  for (const [name, secret] of [
    [DEPLOY_SECRETS.buildEnv, false],
    [DEPLOY_SECRETS.buildSecrets, true],
  ] as const) {
    const text = buildLinesText(buildPart(plan, after.build, secret));
    if (text !== buildLinesText(buildPart(plan, before.build, secret))) {
      // The build job reads them outside any GitHub environment: repository secrets.
      changes.push({ name: deploySecretName(plan, name), value: text });
    }
  }
  return changes;
}

/** A site's secrets: one repository secret per variable, set or deleted. */
function siteSecrets(plan: DeployPlan, change: ValueChange): SecretChange[] {
  const place = (name: string) => deploySecretName(plan, siteEnvSecret(name));
  return [
    ...Object.entries(change.set).map(([name, value]) => ({ name: place(name), value })),
    ...change.unset.map((name) => ({ name: place(name) })),
  ];
}

/** The plan's `app.env` with the removed names out and the new names in (`source: user`). */
function changedPlan(plan: DeployPlan, change: ValueChange): DeployPlan {
  const added = Object.keys(change.set)
    .filter((name) => variableOf(plan, name) === undefined)
    .map((name) => ({ name, secret: change.plain !== true, source: "user" as const }));
  const env = [
    ...plan.app.env.filter((variable) => !change.unset.includes(variable.name)),
    ...added,
  ];
  return { ...plan, app: { ...plan.app, env } };
}

/** What {@link changeAppValues} did. */
export interface ChangedValues {
  /** The plan, with `app.env` changed when names were added or removed. */
  plan: DeployPlan;
  /** True when `opscrew/plan.yaml` changed, for the deploy pull request. */
  planChanged: boolean;
  /** The deploy run `--redeploy` started. */
  runUrl?: string;
}

/** What the approval says before the secrets' names, as provision's secret step says it. */
const SEALED = "(names only; values are encrypted on this computer before upload and never shown)";

/**
 * Changes the environment's app values (`change`, checked with {@link checkValueChange}): after
 * one `github-secrets` approval naming the secrets, the variables and the plan's change, stores
 * the secrets that changed (a server's app env file and build values, or a site's one secret per
 * variable) and deletes a site's removed ones, each audited by name; then the record and the plan.
 * With `redeploy` it starts the deploy workflow on its branch, otherwise it says the next deploy
 * applies them. A refusal changes nothing.
 * @throws OpsCrewError for {@link checkValueChange}'s refusals, `APPROVAL_REFUSED`.
 */
export async function changeAppValues(
  deps: PhaseDeps,
  plan: DeployPlan,
  change: ValueChange,
  github: Pick<GitHubSetup, "owner" | "repo" | "defaultBranch"> & {
    api: Pick<
      GitHubSetup["api"],
      | "setActionsSecret"
      | "setEnvironmentSecret"
      | "deleteActionsSecret"
      | "deleteEnvironmentSecret"
      | "dispatchWorkflow"
    >;
  },
): Promise<ChangedValues> {
  const { kind, record, flags } = await checkValueChange(deps, plan, change);
  const { environment } = deps.paths;
  const repository = `${github.owner}/${github.repo}`;
  const next = record === undefined ? undefined : changedRecord(plan, record, change);
  const secrets =
    kind === "site"
      ? siteSecrets(plan, change)
      : serverSecrets(plan, record as RecordedValues, next as RecordedValues);
  const nextPlan = changedPlan(plan, change);
  const added = nextPlan.app.env.filter((v) => variableOf(plan, v.name) === undefined);
  const removed = plan.app.env.filter((v) => change.unset.includes(v.name));
  const planChanged = added.length > 0 || removed.length > 0;
  if (secrets.length === 0 && !planChanged) {
    deps.reporter.info(
      `The ${environment} environment has these values already; nothing was changed.`,
    );
    return { plan, planChanged: false };
  }
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const branch = workflowBranch(plan, github.defaultBranch);
  const setNames = Object.keys(change.set).sort();
  const stored = secrets.filter((secret) => secret.value !== undefined);
  const deleted = secrets.filter((secret) => secret.value === undefined);
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Change the app's values of ${environment} in GitHub Actions for ${repository}`,
    details: [
      ...(setNames.length > 0 ? [`Set: ${listText(setNames)}.`] : []),
      ...(change.unset.length > 0 ? [`Removed: ${listText([...change.unset].sort())}.`] : []),
      ...(stored.length > 0
        ? [`Secrets ${SEALED}:`, ...stored.map((s) => `  ${placeText(s)}`)]
        : []),
      ...(deleted.length > 0
        ? ["Deleted (names only):", ...deleted.map((s) => `  ${placeText(s)}`)]
        : []),
      ...(added.length > 0
        ? [
            `opscrew/plan.yaml lists ${listText(added.map((v) => `${v.name} (${v.secret ? "secret" : "plain"})`))} among the app's values from now on.`,
          ]
        : []),
      ...(removed.length > 0
        ? [`opscrew/plan.yaml no longer lists ${listText(removed.map((v) => v.name))}.`]
        : []),
      change.redeploy === true
        ? `Then ${workflowFile} is started on ${branch}, which deploys the app with them.`
        : "The app gets them at its next deploy.",
      "No infrastructure, Cloudflare, DNS or server change.",
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The app's values of ${environment} were not changed. Nothing was changed.`,
      { hint: "Run the command again when you are ready." },
    );
  }
  const at = { api: github.api, owner: github.owner, repo: github.repo };
  for (const secret of secrets) {
    const place: SecretPlace =
      secret.environment === undefined
        ? { name: secret.name }
        : { name: secret.name, environment: secret.environment };
    if (secret.value === undefined) await deleteSecretAt(deps, at, place);
    else await setSecretAt(deps, at, place, secret.value);
  }
  if (next !== undefined) await writeAppValues(deps, next);
  if (planChanged) await writePlanIfChanged(deps, nextPlan);
  const changed = listText([...setNames, ...change.unset]);
  deps.reporter.success(`Changed ${changed} in ${environment}.`);
  if (change.redeploy !== true) {
    deps.reporter.info(
      followsBranch(plan)
        ? `The app gets the new values at its next deploy: a push to ${branch}, or \`opscrew values set${flags} --redeploy\` next time.`
        : `The app gets the new values at its next promotion to ${environment}.`,
    );
    return { plan: nextPlan, planChanged };
  }
  deps.reporter.step(`Starting ${workflowFile} on ${branch}, which deploys the app with them`);
  const run = await github.api.dispatchWorkflow(
    github.owner,
    github.repo,
    workflowFile,
    branch,
    {},
    async () => {
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "dispatch workflow",
        target: repository,
        detail: `${workflowFile} on ${branch}: the deploy of the app's changed values`,
      });
    },
  );
  deps.reporter.success(`Started the deploy of ${environment}: ${run.url}`);
  return { plan: nextPlan, planChanged, runUrl: run.url };
}

/** One line of `opscrew values list`: a name, whether it is secret, and where its value comes from. */
export interface AppValueRow {
  name: string;
  secret: boolean;
  source: "user" | "generated" | "derived";
}

/**
 * The app's values of `plan` by name: each variable of `app.env`, and each value OpsCrew fills from
 * a running service it doesn't list (`serviceFilledNames`), as derived. Sorted by name; no value.
 */
export function appValueRows(plan: DeployPlan): AppValueRow[] {
  const rows: AppValueRow[] = plan.app.env.map(({ name, secret, source }) => ({
    name,
    secret,
    source,
  }));
  for (const name of serviceFilledNames(plan)) {
    if (variableOf(plan, name) !== undefined) continue;
    const storage = storageVariableKind(name);
    rows.push({
      name,
      secret: storage === undefined ? !publicSplitSetting(name) : storage === "key",
      source: "derived",
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}
