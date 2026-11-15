/**
 * Finish (`opscrew cloudflare move --finish`, plan 7.): once the switch made B's zone active, each
 * covered environment of the app moves onto its pieces in B, one at a time: B's origin certificate
 * issued and taken (with B's shared record), what the app reads that names A pointed at B in one
 * approval and one deploy (or stack plan), inside the R2 window when the app has a bucket there,
 * the snapshots' copies copied once more, the main connector on B's token, what the switch made in
 * B adopted, and the states swapped with the committed ids patched and checked (`adopted`: no abort
 * from here). Then A's pieces of each environment are removed, and the move ends. Every step reads
 * what is there before it acts, so a run after any stop goes on from where the last one got to;
 * a stopped maintenance window is recovered before anything else.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  exists,
  listText,
  OpsCrewError,
  renameWithRetry,
  toPosixRelative,
  upperFirst,
} from "@opscrew/core";
import type { CloudflareMove } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { promoteNextOriginTls } from "../provision/origin-tls";
import { readCloudflareRecord } from "../provision/shared-cloudflare";
import { forgetStorageKey } from "../provision/storage";
import { appliesNow } from "../retarget/steps";
import { tunnelModules } from "../rotate/infra";
import { readableDeployPause } from "../shared/deploy-pause";
import { bucketWindow, moveBuckets, recoverWindow } from "./buckets";
import { type MoveTunnel, moveTunnels, takeOverConnector } from "./connector";
import { MOVE_PHASE } from "./connector-stacks";
import { backToA, lastCopyOnce, pointAtB } from "./finish-point";
import { endFinish, removeA } from "./finish-removal";
import { adoptSite } from "./finish-site";
import {
  clearPending,
  type MovePlanKey,
  readAppProgress,
  recordWindowStop,
  writePending,
} from "./progress";
import { advancedMove, writeMoveRecord } from "./record";
import { openMoveSession } from "./session";
import {
  patchTfvars,
  shadowFiles,
  shadowOutputs,
  shadowRoots,
  swapShadow,
  tfvarsFile,
} from "./shadow";
import { checkAfterSwap } from "./shadow-plans";
import { aSharedRecordPath, bSharedRecordPath, pendingStop, planBShared } from "./shared";
import { ABORT_COMMAND, FINISH_COMMAND, MOVE_COMMAND, refusal, SWITCH_COMMAND } from "./texts";
import type {
  FinishMoveOptions,
  MoveEnvironment,
  MoveResult,
  MoveSession,
  ShadowRoot,
  StepStop,
} from "./types";

/**
 * The finish's steps that have tests of their own, which it calls in plan 7.'s order (tests
 * replace them).
 */
export const FINISH_STEPS = {
  recoverWindow,
  planBShared,
  pointAtB,
  backToA,
  bucketWindow,
  lastCopyOnce,
  takeOverConnector,
  adoptSite,
  removeA,
  endFinish,
};
export type FinishSteps = typeof FINISH_STEPS;

/** One run of the finish: its session, its options and its steps. */
interface Run {
  session: MoveSession;
  options: FinishMoveOptions;
  steps: FinishSteps;
}

/** `shop (prod)`. */
function appWords(environment: MoveEnvironment): string {
  return `${environment.plan.app.name} (${environment.environment})`;
}

/** The phase deps with the environment's paths. */
function environmentDeps(session: MoveSession, environment: MoveEnvironment): PhaseDeps {
  return { ...session.deps, paths: environment.paths };
}

/**
 * Refuses, before any change, unless every covered environment is prepared in B (or adopted there
 * by an earlier finish), no abort began, and B's zone is active (the switch is done).
 */
function requireFinishable(session: MoveSession): void {
  const { zone } = session;
  const records = session.environments.map((environment) => environment.plan.cloudflareMove);
  if (records.every((move) => move === undefined)) {
    throw refusal(
      `There is no move of ${zone} to another Cloudflare account to finish.`,
      `Start one with \`${MOVE_COMMAND} --to <account>\`.`,
    );
  }
  if (records.some((move) => move?.abort !== undefined)) {
    throw refusal(
      `The move of ${zone} is being aborted, so it can't finish.`,
      `Run \`${ABORT_COMMAND}\` again to end the abort.`,
    );
  }
  const unprepared = session.environments.filter(
    (environment) => (environment.plan.cloudflareMove?.step ?? "started") === "started",
  );
  if (unprepared.length > 0) {
    throw refusal(
      `${upperFirst(listText(unprepared.map(appWords)))} ${unprepared.length === 1 ? "is" : "are"} not prepared in the new Cloudflare account yet, so the move can't finish.`,
      `Run \`${MOVE_COMMAND}\` to finish preparing, then \`${SWITCH_COMMAND}\`, then run \`${FINISH_COMMAND}\` again.`,
    );
  }
  if (session.accounts.b.zone?.status !== "active") {
    throw refusal(
      `${zone} is not active in the new Cloudflare account yet, so the move can't finish.`,
      `Run \`${SWITCH_COMMAND}\` (from any repository with an app in ${zone}) until it says the zone is active, then run \`${FINISH_COMMAND}\` again.`,
    );
  }
}

/**
 * The window's recovery, first: when an earlier run stopped the environment's app for the window
 * and its settings did not point at B yet, the app starts again on A's (`recoverWindow`). The app's
 * file can lose the window's stop (a damaged file reads as absent), so the app's deploys still
 * paused for the move tell it too: the stop is recorded again before the recovery.
 */
async function recoverFirst(run: Run, environment: MoveEnvironment): Promise<void> {
  const { session, steps } = run;
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const { window } = await readAppProgress(deps.paths);
  if (
    window?.environment !== environment.environment &&
    moveBuckets(plan).some((bucket) => bucket.root === "storage") &&
    (await readableDeployPause(session.github, plan))?.reason === "move"
  ) {
    deps.reporter.warn(
      `The deploys of ${appWords(environment)} are still paused for the move's maintenance window, and this computer has no record of where the window got to: OpsCrew takes it as stopped before the app pointed at the new account.`,
    );
    await recordWindowStop(deps, environment.environment);
  }
  await steps.recoverWindow(session, environment, () => steps.backToA(session, environment));
}

/**
 * B's origin certificate, now that B's zone is active (plan 13b): while B's record is in the move's
 * folder, B's shared plan issues it into `originTlsNext` (and settles what it set on the pending
 * zone); then the records move: A's aside for the revocation of A's certificate
 * (`aSharedRecordPath`), B's into its place; then the app's origin TLS values take B's certificate
 * (nothing when they have). Once B's record moved, no plan can issue a second certificate.
 */
async function originForB(run: Run, environment: MoveEnvironment): Promise<StepStop | undefined> {
  const { session } = run;
  const next = bSharedRecordPath(environment);
  if (await exists(next)) {
    const { stop } = await run.steps.planBShared(session, environment);
    if (stop !== undefined) return stop;
  }
  const current = environment.paths.files.cloudflareRecord;
  const aside = aSharedRecordPath(environment);
  if ((await readCloudflareRecord(environment.paths))?.zoneId === session.accounts.a.zoneId) {
    if (await exists(aside)) {
      throw new OpsCrewError(
        "INTERNAL",
        `Both the record of ${appWords(environment)}'s Cloudflare rules in the account it moves from and the one kept for its removal exist, so OpsCrew moved neither. Nothing was changed.`,
        { hint: "This is a bug in OpsCrew; please report it." },
      );
    }
    await mkdir(dirname(aside), { recursive: true });
    await renameWithRetry(current, aside);
  }
  if (await exists(next)) await renameWithRetry(next, current);
  await promoteNextOriginTls(environmentDeps(session, environment));
  return undefined;
}

/**
 * Step 1 (plan 7.1), wrapped by the window (plan 7.2): what the app reads that names A pointed at
 * B. Its approval is asked before the window stops anything; a script without its hash, or without
 * `--allow-downtime` when a window follows, stops before either with both (`window`). Once the
 * app reads B's bucket it only goes forward, without a window; once step 1 was deployed it is done.
 */
async function pointStep(run: Run, environment: MoveEnvironment): Promise<StepStop | undefined> {
  const { session, steps, options } = run;
  const deps = environmentDeps(session, environment);
  const point = await steps.pointAtB(session, environment);
  const { window } = await readAppProgress(deps.paths);
  const own = window?.environment === environment.environment ? window : undefined;
  if (point.done && own === undefined) return undefined;
  const key: MovePlanKey = { action: "window", environment: environment.environment };
  const windowed =
    !point.pointing &&
    own?.pointingAt === undefined &&
    moveBuckets(environment.plan).some((bucket) => bucket.root === "storage");
  // A script that would stop at the window's downtime stops here, its approval kept for one rerun.
  const needsDowntime = windowed && !deps.interactive && options.allowDowntime !== true;
  if (point.asks !== undefined) {
    if (needsDowntime || !appliesNow(session, point.asks.hash)) {
      if (point.asks.details !== undefined) deps.reporter.info(point.asks.details);
      await writePending(deps, key, point.asks.hash);
      return pendingStop(session, point.asks.hash, windowed ? ["--allow-downtime"] : []);
    }
    await point.approve();
  }
  if (point.pointing && own === undefined) {
    // The app reads B's bucket already: a window would copy A's older files over B's.
    await point.secrets();
    await point.deploy();
  } else {
    const stop = await steps.bucketWindow(session, environment, {
      pointAtB: point,
      backToA: () => steps.backToA(session, environment),
      ...(options.allowDowntime === true ? { allowDowntime: true } : {}),
    });
    if (stop !== undefined) return stop;
  }
  await clearPending(deps, key);
  return undefined;
}

/**
 * B's tunnels of the environment with their tokens, from its main shadow root's outputs (each
 * token registered with the redactor); none without a tunnel.
 */
async function bTunnels(session: MoveSession, environment: MoveEnvironment): Promise<MoveTunnel[]> {
  if (tunnelModules(environment.plan).length === 0) return [];
  const main = (await shadowRoots(session, environment)).find((root) => root.name === "main");
  if (main === undefined) return [];
  return moveTunnels(session, environment, await shadowOutputs(session, main), {
    message: `The new Cloudflare account's infrastructure state of ${appWords(environment)} has no tunnel with its token, so OpsCrew can't give the connector its token there. Nothing was changed.`,
    hint: `Run \`${MOVE_COMMAND}\` again: it plans the new account's pieces again.`,
  });
}

/**
 * The connector (plan 7.4): the main connector takes B's tunnel token, then the one beside it
 * goes (`takeOverConnector`; in the user's Portainer the stacks keep B's values from step 1). A
 * script stops at each plan with its hash.
 */
async function connectorStep(
  run: Run,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const { session } = run;
  const tunnels = await bTunnels(session, environment);
  if (tunnels.length === 0) return undefined;
  return run.steps.takeOverConnector(session, environment, tunnels);
}

/**
 * The state swap (plan 7.6): each root's shadow state in for the environment's (the main root's
 * first, so a run finds that the swap began), the id keys of its committed values patched to B's,
 * then each root's check plan with B's token (`checkAfterSwap`): no change needs no approval;
 * in-place updates of Cloudflare pieces are approved by hash (a script stops with it).
 */
async function swapStates(
  session: MoveSession,
  environment: MoveEnvironment,
  roots: readonly ShadowRoot[],
): Promise<StepStop | undefined> {
  const ordered = [...roots].sort((x, y) => Number(y.name === "main") - Number(x.name === "main"));
  let swapped = false;
  for (const root of ordered) {
    if (await exists(root.statePath)) swapped = true;
    await swapShadow(root);
    await patchTfvars(root);
  }
  if (swapped) {
    await session.deps.audit.append({
      kind: "iac",
      actor: "opscrew",
      action: "states swapped",
      phase: MOVE_PHASE,
      target: environment.plan.app.name,
      detail: `${environment.environment}: ${listText(ordered.map((root) => root.name))} now on the new account's states; the committed ids are the new account's`,
    });
  }
  for (const root of ordered) {
    const step = await checkAfterSwap(session, root);
    if (step.kind === "pending") return pendingStop(session, step.planHash);
  }
  return undefined;
}

/**
 * Steps 1 to 6 of plan 7. for `environment`, in order, each skipped when done: B's origin
 * certificate, step 1 in the window, the last copy of the snapshots' copies, the connector, the
 * adoption of what the switch made in B, and the swap; then the record at `adopted`. Once the main
 * root's state was swapped (A's former one kept), the steps before the swap are done and only the
 * swap goes on.
 */
async function adopt(run: Run, environment: MoveEnvironment): Promise<StepStop | MoveEnvironment> {
  const { session, steps } = run;
  const roots = await shadowRoots(session, environment);
  const main = roots.find((root) => root.name === "main");
  const swapping = main !== undefined && (await exists(shadowFiles(main).removalState));
  if (!swapping) {
    const before: (() => Promise<StepStop | undefined>)[] = [
      () => originForB(run, environment),
      () => pointStep(run, environment),
      () => steps.lastCopyOnce(session, environment),
      () => connectorStep(run, environment),
      () => steps.adoptSite(session, environment),
    ];
    for (const step of before) {
      const stop = await step();
      if (stop !== undefined) return stop;
    }
  }
  const stop = await swapStates(session, environment, roots);
  if (stop !== undefined) return stop;
  // Every covered environment has its record (`requireFinishable`).
  const move = environment.plan.cloudflareMove as CloudflareMove;
  const plan = await writeMoveRecord(
    session.deps,
    environment.paths,
    advancedMove(move, "adopted", session.deps.clock.now()),
  );
  session.deps.reporter.success(
    `${upperFirst(appWords(environment))} runs on its pieces in the new Cloudflare account; the move can't be aborted from here.`,
  );
  return { ...environment, plan };
}

/** Forgets A's kept keys of the environment's R2 buckets once A's buckets are gone; B's stay. */
async function forgetAKeys(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  const { a, b } = session.accounts;
  for (const { bucket } of moveBuckets(environment.plan)) {
    await forgetStorageKey(
      environmentDeps(session, environment),
      { provider: "r2", bucket },
      { account: a.accountId, moveTo: b.accountId },
    );
  }
}

/**
 * The repository's files the finish changes: each covered environment's plan (its record, then
 * its removal) and each of its roots' committed `terraform.tfvars.json` (B's ids).
 */
async function changedFiles(session: MoveSession): Promise<string[]> {
  const files: string[] = [];
  for (const environment of session.environments) {
    files.push(toPosixRelative(session.paths.root, environment.paths.files.plan));
    for (const root of await shadowRoots(session, environment)) {
      files.push(toPosixRelative(session.paths.root, tfvarsFile(root.dir)));
    }
  }
  return [...new Set(files)];
}

/**
 * `opscrew cloudflare move --finish` (plan 7.): refused, before any change, unless every covered
 * environment is prepared in B (or adopted there by an earlier finish) and B's zone is active.
 * Then a stopped maintenance window is recovered first; each environment not adopted yet goes
 * through steps 1 to 6, one at a time; then A's pieces of each are removed (`removeA`) and A's kept
 * bucket keys forgotten; then the end (`endFinish`). Stops on purpose (`done: false`, `next` says
 * what to do) for an approval a script gives with `--approve <hash>`, the window in a script
 * without `--allow-downtime`, and the revocation of A's origin certificate until the server serves
 * B's. Once it has ended, `next` also names the files it changed, to commit and push. `steps`:
 * the steps it calls (tests replace them).
 */
export async function finishMove(
  deps: PhaseDeps,
  options: FinishMoveOptions = {},
  steps: FinishSteps = FINISH_STEPS,
): Promise<MoveResult> {
  const session = await openMoveSession(deps, { ...options, command: FINISH_COMMAND });
  requireFinishable(session);
  const run: Run = { session, options, steps };
  const adopted = (environment: MoveEnvironment) =>
    environment.plan.cloudflareMove?.step === "adopted";
  for (const environment of session.environments) {
    if (!adopted(environment)) await recoverFirst(run, environment);
  }
  for (const [index, environment] of session.environments.entries()) {
    if (adopted(environment)) continue;
    const outcome = await adopt(run, environment);
    if (!("plan" in outcome)) return { step: "prepared", done: false, ...outcome };
    session.environments[index] = outcome;
  }
  for (const environment of session.environments) {
    const stop = await steps.removeA(session, environment);
    if (stop !== undefined) return { step: "adopted", done: false, ...stop };
    await forgetAKeys(session, environment);
  }
  const files = await changedFiles(session);
  const result = await steps.endFinish(session);
  if (!result.done) return result;
  return {
    ...result,
    next: [
      ...result.next,
      `Commit and push the files the move changed (${listText(files)}), so OpsCrew on every computer, and the next provision, work with the app in the new Cloudflare account.`,
    ],
  };
}
