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

import type { ApprovalRecord } from "@opscrew/contracts";
import {
  canonicalJson,
  OpsCrewError,
  replaceNames,
  sha256Hex,
  writeFileAtomic,
} from "@opscrew/core";
import {
  appDir,
  DEPLOY_SECRETS,
  OFFSITE_ENV_SECRET,
  type ProviderBucket,
  providerBucket,
} from "@opscrew/iac-templates";
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
import { deploySecretPlace, placeText } from "../provision/secrets";
import { offsiteEnvFile, offsiteValues } from "../provision/storage";
import type { ProvisionServices } from "../provision/types";
import { runDeployWorkflow } from "../retarget/site-steps";
import { type AppValues, withAppEnv } from "../rotate/app-values";
import { knownRecipients } from "../secrets/store";
import { r2Endpoint, readValidJson, requestApproval, type StorageLogin } from "../shared";
import { dotenvLine, parseDotenv, storageLoginValue, storageVariableKind } from "../shared/app-env";
import { reasonOf } from "../shared/errors";
import { recordAppEnvText } from "../values/record";
import { bucketKey, lastBackupsCopy, moveBuckets, type PointAtB } from "./buckets";
import { serverWords } from "./connector";
import { SEALED, type StoredSecret, secretPlace, storeSecrets } from "./deploy-secrets";
import { moveFolder } from "./paths";
import { accountWords, appWords, bug, environmentDeps, MOVE_PHASE } from "./texts";
import type { MoveEnvironment, MoveSession, MoveSide, StepStop } from "./types";

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
   * The hash of the approval {@link PointingAtB.approve} asks (a script's `--approve <hash>`), and
   * what that approval shows; absent when nothing is asked (B's values written already).
   */
  asks?: { hash: string; details?: string };
  /**
   * Asks the approval of {@link PointingAtB.asks}, before the window stops anything: B's values
   * are written only under it, and only while they still have its hash.
   */
  approve(): Promise<void>;
}

/** Step 1 with nothing left to do (`pointing`: the app reads B's bucket already). */
function nothingLeft(pointing: boolean): PointingAtB {
  const nothing = async () => {};
  return { done: true, pointing, approve: nothing, secrets: nothing, deploy: nothing };
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
  return moveFolder(environment.paths, "finish-point.json");
}

function readApplied(environment: MoveEnvironment): Promise<Applied | undefined> {
  return readValidJson(appliedFile(environment), AppliedSchema);
}

async function writeApplied(environment: MoveEnvironment, applied: Applied): Promise<void> {
  await writeFileAtomic(appliedFile(environment), `${JSON.stringify(applied)}\n`);
}

/** Step 1's values were to be written without their approval: OpsCrew's bug. */
function unapproved(): OpsCrewError {
  return bug(
    "OpsCrew was about to write the new account's values without their approval, so it wrote none.",
  );
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
  side: MoveSide,
): Promise<StorageLogin | undefined> {
  const bucket = moveBuckets(environment.plan).find((one) => one.root === root);
  if (bucket === undefined) return undefined;
  const key = await bucketKey(session, environment, bucket, side);
  return { ...key, endpoint: r2Endpoint(session.accounts[side].accountId) };
}

/**
 * The app's bucket variables among `names` that name the account (its keys and endpoint), each
 * with A's value (`old`) and B's (`new`); its bucket's name and region stay.
 */
function storagePairs(
  names: readonly string[],
  storage: ProviderBucket,
  a: StorageLogin,
  b: StorageLogin,
): AppValues {
  const pairs: AppValues = {};
  for (const name of names) {
    const old = storageLoginValue(name, storage, a);
    if (old === undefined) continue;
    pairs[name] = { old, new: storageLoginValue(name, storage, b) ?? "" };
  }
  return pairs;
}

/**
 * Registers each value of the app's settings `values` with the redactor, by itself, but those the
 * plan says are not secret and its bucket's public settings (its name, region and endpoint), which
 * the move's messages name.
 */
function registerValues(
  deps: Pick<PhaseDeps, "redactor">,
  plan: DeployPlan,
  values: ReadonlyMap<string, string>,
): void {
  const open = new Set(plan.app.env.filter((variable) => !variable.secret).map((one) => one.name));
  for (const [name, value] of values) {
    const kind = storageVariableKind(name);
    if (open.has(name) || (kind !== undefined && kind !== "key")) continue;
    deps.redactor.addLiteral(value, "app-env");
  }
}

/**
 * The app's settings on its server (`app.env` in the app's folder, as the last deploy wrote it),
 * read over SSH as `deploy`; never shown. The server's address is never said.
 */
async function serverAppEnv(session: MoveSession, environment: MoveEnvironment): Promise<string> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const words = serverWords(plan);
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
  registerValues(deps, plan, parseDotenv(result.stdout));
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
  side: MoveSide,
): Promise<{ set: StoredSecret[]; onSide: boolean }> {
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const place = (name: string, value: string): StoredSecret => ({
    ...deploySecretPlace(plan, name),
    value,
  });
  const set: StoredSecret[] = [];
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
  const a = await bucketLogin(session, environment, "storage", "a");
  const b = await bucketLogin(session, environment, "storage", "b");
  const storage = providerBucket(plan);
  if (storage !== undefined && a !== undefined && b !== undefined) {
    const text = await serverAppEnv(session, environment);
    const lines = text.split(/\r?\n/);
    const pairs = storagePairs([...parseDotenv(text).keys()], storage, a, b);
    const to = side === "a" ? "old" : "new";
    // Each of its bucket's variables on the server already holds this side's value.
    onSide =
      Object.keys(pairs).length > 0 &&
      Object.entries(pairs).every(([name, pair]) => lines.includes(dotenvLine(name, pair[to])));
    set.push(place(DEPLOY_SECRETS.appEnv, withAppEnv(text, pairs, to)));
  }
  return { set, onSide };
}

/** The hash of a change of the deploy secrets: their places and their values' digests. */
function changeHash(
  session: MoveSession,
  environment: MoveEnvironment,
  set: readonly StoredSecret[],
) {
  const { owner, repo } = session.github;
  return sha256Hex(
    canonicalJson({
      action: "window",
      environment: environment.environment,
      repository: `${owner}/${repo}`,
      set: set.map((stored) => ({ ...secretPlace(stored), sha256: sha256Hex(stored.value) })),
    }),
  );
}

/**
 * Runs the environment's deploy workflow on its branch and waits for it to succeed: it writes the
 * deploy secrets on the server and starts the app on them.
 * @throws OpsCrewError when it could not run or did not succeed.
 */
async function runDeploy(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  const { command } = session;
  const github = { ...session.github, api: session.githubApi };
  await runDeployWorkflow(
    environmentDeps(session, environment),
    github,
    environment.plan,
    MOVE_PHASE,
    {
      purpose: `so ${appWords(environment)} runs on its settings for ${accountWords(session.accounts.b)}`,
      failedHint: `Check the workflow in your repository's Actions tab, then run \`${command}\` again.`,
      unsuccessfulHint: `Open the run to see what failed and push a fix, then run \`${command}\` again.`,
      environment: environment.environment,
    },
  );
}

/** Step 1 on a server: B's deploy secrets in one approval, then one deploy. */
async function serverPointAtB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PointingAtB> {
  const deps = environmentDeps(session, environment);
  const { set, onSide } = await serverSecrets(session, environment, "b");
  if (set.length === 0) return nothingLeft(false);
  const hash = changeHash(session, environment, set);
  const applied = await readApplied(environment);
  const done = applied?.sha256 === hash && applied.deployed === true;
  const name = environment.environment;
  const title = `Give the deploy secrets of ${name} their values for ${accountWords(session.accounts.b)}`;
  const details = [
    `These deploy secrets name the account the app runs on; they take their values for ${accountWords(session.accounts.b)}, and the deploy that follows writes them on the server and starts the app on them:`,
    ...set.map((stored) => `  ${placeText(stored)}`),
    SEALED,
  ].join("\n");
  let approved = false;
  return {
    done,
    pointing: onSide,
    ...(applied?.sha256 === hash ? {} : { asks: { hash, details: `${title}\n${details}` } }),
    approve: async () => {
      if ((await readApplied(environment))?.sha256 === hash) return;
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
      approved = true;
    },
    secrets: async () => {
      if ((await readApplied(environment))?.sha256 === hash) {
        deps.reporter.info(
          `The deploy secrets of ${name} hold their values for ${accountWords(session.accounts.b)}.`,
        );
        return;
      }
      if (!approved) throw unapproved();
      // Read again: what is written must be what was approved.
      const now = await serverSecrets(session, environment, "b");
      if (changeHash(session, environment, now.set) !== hash) {
        throw new OpsCrewError(
          "PHASE_PRECONDITION",
          `What the deploy secrets of ${name} would hold for ${accountWords(session.accounts.b)} changed since you approved it, so OpsCrew wrote none of them.`,
          { hint: `Run \`${session.command}\` again to see the change and approve it.` },
        );
      }
      await storeSecrets(session, now.set);
      await recordStoredAppEnv(session, environment, now.set);
      await writeApplied(environment, { sha256: hash });
      deps.reporter.success(
        `The deploy secrets of ${name} hold their values for ${accountWords(session.accounts.b)}.`,
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
  const { engine, remote, docker, own, portainer, askStorageKey, askEnv, sleep, now } =
    session.services;
  return {
    ...(engine === undefined ? {} : { engine }),
    ...(remote === undefined ? {} : { remote }),
    ...(docker === undefined ? {} : { docker }),
    ...(own === undefined ? {} : { own }),
    ...(portainer === undefined ? {} : { portainer }),
    ...(askStorageKey === undefined ? {} : { askStorageKey }),
    ...(askEnv === undefined ? {} : { askEnv }),
    ...(sleep === undefined ? {} : { sleep }),
    ...(now === undefined ? {} : { now }),
    github: session.githubApi,
    cloudflare: session.accounts.b.client,
  };
}

/**
 * The app's stacks in the user's Portainer with B's values (`portainerStacksFor` with B's client
 * and B's bucket keys): the stack Caddy's origin certificate as the environment's record has it
 * (B's once the finish took it), and the app's bucket and the off-server copies' with B's keys and
 * endpoint. The tunnels' tokens are the state's. The finish's step 1 and its connector's restart
 * plan the stacks with it.
 */
export async function stacksForB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PortainerStacksSetup> {
  const storage = await bucketLogin(session, environment, "storage", "b");
  const offsite = await bucketLogin(session, environment, "backups", "b");
  return portainerStacksFor(
    environmentDeps(session, environment),
    environment.plan,
    provisionServices(session),
    {
      phase: MOVE_PHASE,
      command: session.command,
      keys: {
        ...(storage === undefined ? {} : { storage }),
        ...(offsite === undefined ? {} : { offsite }),
      },
    },
  );
}

/**
 * Step 1 in the user's Portainer: one stack plan with B's values, approved by its hash, and kept
 * once applied: a run after it plans nothing again (the connector's restart gives the stacks B's
 * tunnel tokens afterwards, which a plan from the state's outputs would take back).
 */
async function portainerPointAtB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<PointingAtB> {
  const deps = environmentDeps(session, environment);
  if ((await readApplied(environment))?.deployed === true) return nothingLeft(true);
  const setup = await stacksForB(session, environment);
  const planned: PlannedStacks = await setup.stacks.plan(setup.outputs);
  if (planned.changes === 0) return nothingLeft(true);
  const { hash } = planned;
  let approved: ApprovalRecord | undefined;
  return {
    done: false,
    pointing: false,
    // The stack plan was shown as it was made.
    asks: { hash },
    approve: async () => {
      const approval = await requestApproval(deps, {
        kind: "stack-apply",
        title: `Give the app's stacks in your Portainer their values for ${accountWords(session.accounts.b)}`,
        details: planned.details,
        hash,
        refused: {
          plan: "stack plan",
          unchanged: "Nothing in Portainer was changed.",
          again: session.command,
        },
      });
      await deps.approvals.assertApprovedStackPlan(hash);
      approved = approval;
    },
    // Nothing is written before the stack plan's apply, which sends the values it was approved by.
    secrets: async () => {
      if (approved === undefined) throw unapproved();
    },
    deploy: async () => {
      if (approved === undefined) throw unapproved();
      await setup.stacks.apply(planned, approved);
      await writeApplied(environment, { sha256: hash, deployed: true });
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
  return nothingLeft(false);
}

/**
 * Step 1 undone before the app's settings pointed at B (the window's rollback, under the window's
 * approval): on a server, the bucket settings among the deploy secrets take A's values again,
 * unless they are recorded as A's (a write of B's may have stopped part-way); B's origin
 * certificate stays (A's edge no longer serves the zone). No deploy: none ran on B's values, and
 * the server's files are still A's. Nothing in Portainer, whose stack gets B's values only after
 * that point.
 */
export async function backToA(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  if (runsOn(environment.plan) !== "server") return;
  const { set } = await serverSecrets(session, environment, "a");
  const hash = changeHash(session, environment, set);
  if (set.length === 0 || (await readApplied(environment))?.sha256 === hash) return;
  await storeSecrets(session, set);
  await recordStoredAppEnv(session, environment, set);
  await writeApplied(environment, { sha256: hash });
}

/** The app's settings among `set`, when it holds them, into OpsCrew's record of its values (048). */
async function recordStoredAppEnv(
  session: MoveSession,
  environment: MoveEnvironment,
  set: readonly StoredSecret[],
): Promise<void> {
  const { name } = deploySecretPlace(environment.plan, DEPLOY_SECRETS.appEnv);
  const appEnv = set.find((stored) => stored.name === name)?.value;
  if (appEnv !== undefined) await recordAppEnvText(environmentDeps(session, environment), appEnv);
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
