/**
 * The finish's step 1 (plan 7.1): what the app reads that names the account it runs on, pointed at
 * the account the move goes to. On a server, the deploy secrets that hold such values (the origin
 * certificate, the app's settings with its bucket's endpoint and key, the off-server copies'
 * settings) take B's in one `github-secrets` approval, then one deploy writes them on the server
 * and starts the app. In the user's Portainer, one stack plan with B's values, approved by its
 * hash. A site, GitHub Pages and a hosting account read nothing of the kind. Each change is kept by
 * its hash (`cloudflare-move/finish-point.json`, no value in it), so a run after it changes nothing
 * again.
 */
import { join, posix } from "node:path";
import {
  canonicalJson,
  OpsCrewError,
  replaceNames,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import { appDir, DEPLOY_SECRETS, OFFSITE_ENV_SECRET } from "@opscrew/iac-templates";
import {
  APP_SERVER,
  backupsBucketOf,
  type DeployPlan,
  isHostingTarget,
  isServerlessProvider,
} from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { moveShell } from "../move/shells";
import { originTlsSecret } from "../provision/origin-tls";
import {
  type PlannedStacks,
  type PortainerStacksSetup,
  portainerStacksFor,
} from "../provision/portainer-flow";
import { recordedEdge } from "../provision/render";
import { deploySecretPlace, type SecretPlace, setSecretAt } from "../provision/secrets";
import {
  offsiteEnvFile,
  offsiteValues,
  providerBucket,
  requireOffsiteKey,
  requireStorageKey,
} from "../provision/storage";
import type { ProvisionServices } from "../provision/types";
import { type AppValues, withAppEnv, withAppRecord } from "../rotate/app-values";
import { knownRecipients } from "../secrets/store";
import {
  PlanRefusedError,
  r2Endpoint,
  readValidJson,
  requestApproval,
  type StorageLogin,
} from "../shared";
import { storageVariableKind } from "../shared/app-env";
import { codeOf, hintOf, reasonOf } from "../shared/errors";
import { lastBackupsCopy, type PointAtB } from "./buckets";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

const PHASE = "cloudflare-move";

/** How long the deploy run is awaited. */
const WORKFLOW_WAIT_MS = 30 * 60_000;

/** Whose values: A's (the account the app runs on before the finish) or B's. */
type Side = "a" | "b";

/** Step 1 for one environment, towards B, with what is known of it before it runs. */
export interface PointingAtB extends PointAtB {
  /** True when this side's change was applied and deployed already: nothing is left to do. */
  done: boolean;
  /**
   * True when the app already reads B's bucket (its server's settings, or its stack's values, are
   * B's): a run never takes it back to A's bucket then, only forward.
   */
  pointing: boolean;
  /**
   * The hash {@link PointAtB.secrets} asks its approval with (a script's `--approve <hash>`), and
   * what that approval shows; absent when nothing is asked (B's values written already).
   */
  asks?: { hash: string; details?: string };
}

/** The phase deps with the environment's paths. */
function environmentDeps(session: MoveSession, environment: MoveEnvironment): PhaseDeps {
  return { ...session.deps, paths: environment.paths };
}

/** `shop (prod)`. */
function appWords(environment: MoveEnvironment): string {
  return `${environment.plan.app.name} (${environment.environment})`;
}

/** The account in words. */
function bWords(session: MoveSession): string {
  const { b } = session.accounts;
  return `the Cloudflare account ${b.name ?? b.accountId}`;
}

/**
 * What the record of the last change applied holds: its hash, whether it was deployed, and whether
 * the snapshots' copies were copied once more after that deploy.
 */
const AppliedSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  deployed: z.literal(true).optional(),
  copied: z.literal(true).optional(),
});
type Applied = z.infer<typeof AppliedSchema>;

function appliedFile(environment: MoveEnvironment): string {
  return join(environment.paths.stateDir, "cloudflare-move", "finish-point.json");
}

function readApplied(environment: MoveEnvironment): Promise<Applied | undefined> {
  return readValidJson(appliedFile(environment), AppliedSchema);
}

async function writeApplied(environment: MoveEnvironment, applied: Applied): Promise<void> {
  await writeFileAtomic(appliedFile(environment), `${JSON.stringify(applied)}\n`);
}

/** A deploy secret to store: where it goes and its value. */
type Stored = SecretPlace & { value: string };

/** Where a secret goes, without its value. */
function placeOf({ name, environment }: SecretPlace): SecretPlace {
  return environment === undefined ? { name } : { name, environment };
}

/** A secret's name with where it lives, when that is a GitHub environment. */
function placeText(place: SecretPlace): string {
  return place.environment === undefined
    ? place.name
    : `${place.name} (in the GitHub environment ${place.environment})`;
}

/** The kind of place the app runs: a server, the user's Portainer, or none of its own. */
function runsOn(plan: DeployPlan): "server" | "portainer" | "none" {
  if (plan.target.provider === "portainer") return "portainer";
  if (isServerlessProvider(plan.target.provider) || isHostingTarget(plan.target)) return "none";
  return "server";
}

/**
 * The login of the environment's R2 bucket `root` (the app's, or the snapshots' copies') on
 * `side`: its key in that account with that account's S3 endpoint; `undefined` without that bucket
 * on R2. Registered with the redactor; never logged.
 */
async function bucketLogin(
  session: MoveSession,
  environment: MoveEnvironment,
  root: "storage" | "backups",
  side: Side,
): Promise<StorageLogin | undefined> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const { accountId } = session.accounts[side];
  const options = { command: session.command, account: accountId };
  if (root === "storage" && providerBucket(plan)?.provider === "r2") {
    const key = await requireStorageKey(deps, plan, session.services, options);
    return { ...key, endpoint: r2Endpoint(accountId) };
  }
  if (root === "backups" && backupsBucketOf(plan)?.provider === "r2") {
    const key = await requireOffsiteKey(deps, plan, session.services, options);
    return { ...key, endpoint: r2Endpoint(accountId) };
  }
  return undefined;
}

/** The app bucket's logins in both accounts, when it is on R2. */
async function storageLogins(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<{ a: StorageLogin; b: StorageLogin } | undefined> {
  const a = await bucketLogin(session, environment, "storage", "a");
  const b = await bucketLogin(session, environment, "storage", "b");
  return a === undefined || b === undefined ? undefined : { a, b };
}

/**
 * The app's bucket variables among `names` that name the account (its keys and endpoint), each
 * with A's value (`old`) and B's (`new`); its bucket's name and region stay.
 */
function storagePairs(names: readonly string[], a: StorageLogin, b: StorageLogin): AppValues {
  const pairs: AppValues = {};
  for (const name of names) {
    const kind = storageVariableKind(name);
    if (kind === "endpoint") pairs[name] = { old: a.endpoint ?? "", new: b.endpoint ?? "" };
    if (kind !== "key") continue;
    pairs[name] =
      name === "AWS_ACCESS_KEY_ID"
        ? { old: a.accessKeyId, new: b.accessKeyId }
        : { old: a.secretAccessKey, new: b.secretAccessKey };
  }
  return pairs;
}

/** The variables' names in an env file's text. */
function envNames(text: string): string[] {
  return [...text.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((match) => match[1] as string);
}

/**
 * The app's settings on its server (`app.env` in the app's folder, as the last deploy wrote it),
 * read over SSH as `deploy`; never shown. The server's address is never said.
 */
async function serverAppEnv(session: MoveSession, environment: MoveEnvironment): Promise<string> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const words = plan.target.provider === "own" ? "your server" : "the app's server";
  const { remote } = await moveShell(deps, plan, session.services, APP_SERVER);
  const failed = (said: string) =>
    new OpsCrewError(
      "COMMAND_FAILED",
      replaceNames(
        deps.redactor.redact(`OpsCrew could not read the app's settings on ${words}: ${said}.`),
        [remote.host],
        words,
      ),
      {
        hint: `Check that ${words} is on and reachable (\`opscrew status\`), then run \`${session.command}\` again.`,
      },
    );
  let result: Awaited<ReturnType<typeof remote.run>>;
  try {
    result = await remote.run(`cat ${appDir(plan)}/app.env`, { timeoutMs: 60_000 });
  } catch (error) {
    throw failed(reasonOf(error));
  }
  if (result.exitCode !== 0) {
    throw failed(result.stderr.trim() || `exit code ${result.exitCode}`);
  }
  deps.redactor.addLiteral(result.stdout, "app-env");
  return result.stdout;
}

/**
 * The deploy secrets `side`'s values take on a server, and whether its `app.env` holds that side's
 * bucket settings already: B's origin certificate (`OPSCREW_ORIGIN_TLS`, B's only: A's is replaced
 * on this computer once B's is issued), the off-server copies' settings (`OPSCREW_OFFSITE_ENV`)
 * with that account's bucket key and endpoint, and the app's settings (`OPSCREW_APP_ENV`, the
 * server's `app.env` with its bucket's keys and endpoint on that side).
 */
async function serverSecrets(
  session: MoveSession,
  environment: MoveEnvironment,
  side: Side,
): Promise<{ set: Stored[]; onSide: boolean }> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const place = (name: string, value: string): Stored => ({
    ...deploySecretPlace(plan, name),
    value,
  });
  const set: Stored[] = [];
  if (side === "b") {
    const { edge, values } = await recordedEdge(deps, plan);
    if (edge.originTls !== undefined) {
      const value = originTlsSecret(values);
      deps.redactor.addLiteral(value, "origin-tls");
      set.push(place(DEPLOY_SECRETS.originTls, value));
    }
  }
  const backups = await bucketLogin(session, environment, "backups", side);
  if (backups !== undefined) {
    const recipient = (await knownRecipients(environment.paths))?.[0];
    if (recipient === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${appWords(environment)}'s off-server copies are encrypted to the age key of its recovery copy, and this computer knows none. Nothing was changed.`,
        {
          hint: `Run \`${session.command}\` on the computer that set the app up, or bring its recovery copy here (\`opscrew secrets restore\`).`,
        },
      );
    }
    const values = offsiteValues(plan, {
      login: backups,
      recipient,
      cloudflare: { accountId: session.accounts[side].accountId },
    });
    const value = offsiteEnvFile(values);
    deps.redactor.addLiteral(value, "offsite-env");
    set.push(place(OFFSITE_ENV_SECRET, value));
  }
  let onSide = false;
  const storage = await storageLogins(session, environment);
  if (storage !== undefined) {
    const text = await serverAppEnv(session, environment);
    const pairs = storagePairs(envNames(text), storage.a, storage.b);
    const wanted = withAppEnv(text, pairs, side === "a" ? "old" : "new");
    onSide = Object.keys(pairs).length > 0 && wanted === text;
    set.push(place(DEPLOY_SECRETS.appEnv, wanted));
  }
  return { set, onSide };
}

/** The hash of a change of the deploy secrets: their places and their values' digests. */
function changeHash(session: MoveSession, environment: MoveEnvironment, set: readonly Stored[]) {
  const { owner, repo } = session.github;
  return sha256Hex(
    canonicalJson({
      action: "window",
      environment: environment.environment,
      repository: `${owner}/${repo}`,
      set: set.map((stored) => ({ ...placeOf(stored), sha256: sha256Hex(stored.value) })),
    }),
  );
}

/** Stores each of `set` where GitHub keeps it, sealed on this computer; audited by name. */
async function storeSecrets(session: MoveSession, environment: MoveEnvironment, set: Stored[]) {
  const deps = environmentDeps(session, environment);
  const { owner, repo } = session.github;
  for (const stored of set) {
    await setSecretAt(
      deps,
      { api: session.githubApi, owner, repo },
      placeOf(stored),
      stored.value,
      PHASE,
    );
  }
}

/**
 * Runs the environment's deploy workflow on its branch and waits for it to succeed: it writes the
 * deploy secrets on the server and starts the app on them.
 * @throws OpsCrewError when it could not run or did not succeed.
 */
async function runDeploy(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  const deps = environmentDeps(session, environment);
  const { githubApi, command } = session;
  const { owner, repo } = session.github;
  const { plan } = environment;
  const workflowFile = posix.basename(plan.cicd.workflowPath);
  const ref = plan.cicd.branch;
  deps.reporter.step(
    `Running the deploy workflow (${workflowFile} on ${ref}) so ${appWords(environment)} runs on its settings for ${bWords(session)}`,
  );
  let run: Awaited<ReturnType<typeof githubApi.waitForWorkflowRun>>;
  try {
    const { runId } = await githubApi.dispatchWorkflow(owner, repo, workflowFile, ref, {}, () =>
      deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "dispatch workflow",
        phase: PHASE,
        target: `${owner}/${repo}`,
        detail: `${workflowFile} on ${ref}`,
      }),
    );
    run = await githubApi.waitForWorkflowRun(owner, repo, {
      workflowFile,
      ref,
      runId,
      timeoutMs: WORKFLOW_WAIT_MS,
      onWaiting: (url) =>
        deps.reporter.info(
          `${environment.environment}'s deploy run waits in GitHub for a required reviewer: approve it at ${url}. OpsCrew follows the run until it ends.`,
        ),
    });
  } catch (error) {
    throw new OpsCrewError(
      codeOf(error),
      deps.redactor.redact(`Running the deploy workflow failed: ${reasonOf(error)}.`),
      {
        hint: `${hintOf(error)}Check the workflow in your repository's Actions tab, then run \`${command}\` again.`,
      },
    );
  }
  const ok = run.conclusion === "success";
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "deploy workflow",
    phase: PHASE,
    target: run.htmlUrl,
    decision: ok ? "approved" : "refused",
    detail: `workflow run ${run.id} finished: ${run.conclusion ?? "no result"}`,
  });
  if (!ok) {
    throw new OpsCrewError(
      "COMMAND_FAILED",
      `The deploy workflow did not succeed (${run.conclusion ?? "no result"}): ${run.htmlUrl}.`,
      { hint: `Open the run to see what failed and push a fix, then run \`${command}\` again.` },
    );
  }
  deps.reporter.success(`The deploy workflow succeeded (${run.htmlUrl}).`);
}

/** Step 1 on a server: B's deploy secrets in one approval, then one deploy. */
async function serverPointAtB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PointingAtB> {
  const deps = environmentDeps(session, environment);
  const { set, onSide } = await serverSecrets(session, environment, "b");
  const nothing = async () => {};
  if (set.length === 0) return { done: true, pointing: false, secrets: nothing, deploy: nothing };
  const hash = changeHash(session, environment, set);
  const applied = await readApplied(environment);
  const done = applied?.sha256 === hash && applied.deployed === true;
  const name = environment.environment;
  const title = `Give the deploy secrets of ${name} their values for ${bWords(session)}`;
  const details = [
    `These deploy secrets name the account the app runs on; they take their values for ${bWords(session)}, and the deploy that follows writes them on the server and starts the app on them:`,
    ...set.map((stored) => `  ${placeText(stored)}`),
    "(names only; values are encrypted on this computer before upload and never shown)",
  ].join("\n");
  return {
    done,
    pointing: onSide,
    ...(applied?.sha256 === hash ? {} : { asks: { hash, details: `${title}\n${details}` } }),
    secrets: async () => {
      if ((await readApplied(environment))?.sha256 === hash) {
        deps.reporter.info(
          `The deploy secrets of ${name} hold their values for ${bWords(session)}.`,
        );
        return;
      }
      await requestApproval(deps, {
        kind: "github-secrets",
        title,
        details,
        hash,
        refused: {
          plan: "change of the deploy's GitHub secrets",
          unchanged: "No GitHub secret was changed.",
          again: session.command,
        },
      });
      await storeSecrets(session, environment, set);
      await writeApplied(environment, { sha256: hash });
      deps.reporter.success(
        `The deploy secrets of ${name} hold their values for ${bWords(session)}.`,
      );
    },
    deploy: async () => {
      const now = await readApplied(environment);
      if (now?.sha256 === hash && now.deployed === true) return;
      await runDeploy(session, environment);
      await writeApplied(environment, { sha256: hash, deployed: true });
    },
  };
}

/**
 * The provision services the app's stacks in Portainer are planned with: the move's, with B's
 * client standing for Cloudflare, so an R2 bucket's endpoint is B's.
 */
function provisionServices(session: MoveSession): ProvisionServices {
  const { engine, remote, docker, own, portainer, askStorageKey, sleep, now } = session.services;
  return {
    ...(engine === undefined ? {} : { engine }),
    ...(remote === undefined ? {} : { remote }),
    ...(docker === undefined ? {} : { docker }),
    ...(own === undefined ? {} : { own }),
    ...(portainer === undefined ? {} : { portainer }),
    ...(askStorageKey === undefined ? {} : { askStorageKey }),
    ...(sleep === undefined ? {} : { sleep }),
    ...(now === undefined ? {} : { now }),
    github: session.githubApi,
    cloudflare: session.accounts.b.client,
  };
}

/**
 * The app's stacks in the user's Portainer with B's values (`portainerStacksFor` with B's client):
 * the stack Caddy's origin certificate as the environment's record has it (B's once the finish
 * took it), and the app bucket's keys and endpoint B's. The tunnels' tokens are the state's.
 * @throws OpsCrewError `INTERNAL` for off-server copies on R2, whose settings in the stack OpsCrew
 * can't give B's bucket key yet.
 */
export async function stacksForB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PortainerStacksSetup> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  if (backupsBucketOf(plan)?.provider === "r2") {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew can't give the off-server copies of ${appWords(environment)} in your Portainer their bucket in the new Cloudflare account yet, so the finish stopped. Nothing was changed.`,
      { hint: "This is a bug in OpsCrew; please report it." },
    );
  }
  const storage = await storageLogins(session, environment);
  return portainerStacksFor(deps, plan, provisionServices(session), {
    phase: PHASE,
    command: session.command,
    ...(storage === undefined
      ? {}
      : {
          // Built with A's key, kept for the bucket before the move, and B's endpoint.
          rewrite: (built) => {
            const { app } = built.values;
            const pairs = storagePairs(Object.keys(app), storage.a, storage.b);
            return { ...built, values: { ...built.values, app: withAppRecord(app, pairs, "new") } };
          },
        }),
  });
}

/** Step 1 in the user's Portainer: one stack plan with B's values, approved by its hash. */
async function portainerPointAtB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PointingAtB> {
  const deps = environmentDeps(session, environment);
  const setup = await stacksForB(session, environment);
  const planned: PlannedStacks = await setup.stacks.plan(setup.outputs);
  const nothing = async () => {};
  if (planned.changes === 0) {
    return { done: true, pointing: true, secrets: nothing, deploy: nothing };
  }
  const { hash } = planned;
  let approved: Awaited<ReturnType<typeof deps.approvals.request>> | undefined;
  return {
    done: false,
    pointing: false,
    // The stack plan was shown as it was made.
    asks: { hash },
    secrets: async () => {
      const approval = await deps.approvals.request({
        kind: "stack-apply",
        title: `Give the app's stacks in your Portainer their values for ${bWords(session)}`,
        details: planned.details,
        planHash: hash,
      });
      if (!approval.approved) {
        throw new PlanRefusedError({
          plan: "stack plan",
          ...(approval.reason ? { reason: approval.reason } : {}),
          unchanged: "Nothing in Portainer was changed.",
          hint: `Run \`${session.command}\` again when you are ready (in a script: --approve ${hash}).`,
        });
      }
      await deps.approvals.assertApprovedStackPlan(hash);
      approved = approval;
    },
    deploy: async () => {
      if (approved === undefined) throw new Error("The stack plan is applied after its approval.");
      await setup.stacks.apply(planned, approved);
    },
  };
}

/**
 * The finish's step 1 for `environment`, towards B (plan 7.1): on a server B's deploy secrets and
 * the deploy, in the user's Portainer B's stack plan, else nothing. Reads what is there first, so
 * a change applied already is not asked for again and a deploy done already does not run again.
 */
export async function pointAtB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PointingAtB> {
  const where = runsOn(environment.plan);
  if (where === "server") return serverPointAtB(session, environment);
  if (where === "portainer") return portainerPointAtB(session, environment);
  const nothing = async () => {};
  return { done: true, pointing: false, secrets: nothing, deploy: nothing };
}

/**
 * Step 1 undone before the app's settings pointed at B (the window's rollback, under the window's
 * approval): on a server, when B's deploy secrets were written, the bucket settings among them take
 * A's values again (B's origin certificate stays: A's edge no longer serves the zone). No deploy:
 * none ran on B's values, and the server's files are still A's. Nothing in Portainer, whose stack
 * gets B's values only after that point.
 */
export async function backToA(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  if (runsOn(environment.plan) !== "server") return;
  const applied = await readApplied(environment);
  if (applied === undefined) return;
  const { set } = await serverSecrets(session, environment, "a");
  const hash = changeHash(session, environment, set);
  if (set.length === 0 || applied.sha256 === hash) return;
  await storeSecrets(session, environment, set);
  await writeApplied(environment, { sha256: hash });
}

/**
 * The finish's last copy of the snapshots' copies (plan 7.3, `lastBackupsCopy`), once step 1's
 * deploy pointed the server's copies at B's bucket: what A's bucket gained until then goes to B's.
 * Kept with step 1's record, so a run after it neither copies nor asks again. Nothing without that
 * bucket on R2.
 */
export async function lastCopyOnce(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  if (backupsBucketOf(environment.plan)?.provider !== "r2") return undefined;
  if ((await readApplied(environment))?.copied === true) return undefined;
  const stop = await lastBackupsCopy(session, environment);
  if (stop !== undefined) return stop;
  const applied = await readApplied(environment);
  if (applied !== undefined) await writeApplied(environment, { ...applied, copied: true });
  return undefined;
}
