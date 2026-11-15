/**
 * Prepare (`opscrew cloudflare move --to <account>`, plan 4.): the app's side in the new account,
 * built while the old one serves. After the checks and the summary the move's record is written
 * (`started`); then the zone plan (B's zone added, A's other records copied), and for each covered
 * environment B's shared plan, its shadow roots, B's tunnel connector beside A's, the deploy's
 * extra credentials and the first copies of its R2 buckets, after which its record is `prepared`;
 * the app's mark in B's zone comes last. Every step reads what is there before it acts, so a run
 * after any interruption (or a script's run with `--approve <hash>`) goes on from where the last
 * one stopped and does nothing twice. A's account is only read.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import type { CloudflareMove } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { lookupPublishedDs } from "../domain/connect-dns";
import { setupCloudflare } from "../provision";
import { firstCopies, measureBuckets } from "./buckets";
import { checkMoveStart } from "./checks";
import { besideConnector, moveTunnels } from "./connector";
import { addNewCredentials } from "./deploy-secrets";
import { readMarks, writeMark } from "./marks";
import {
  advancedMove,
  type MoveStart,
  startedMove,
  withTargetZone,
  writeMoveRecord,
} from "./record";
import { openMoveSession } from "./session";
import { shadowRoots } from "./shadow";
import { planShadow } from "./shadow-plans";
import { pendingStop, planBShared } from "./shared";
import { confirmMoveStart, moveSummary } from "./summary";
import { ABORT_COMMAND, FINISH_COMMAND, MOVE_COMMAND, refusal, SWITCH_COMMAND } from "./texts";
import type {
  MoveEnvironment,
  MoveResult,
  MoveSession,
  MoveZone,
  PrepareMoveOptions,
  StepStop,
} from "./types";
import { applyZone, planZone } from "./zone";

/**
 * `opscrew cloudflare move [--to <account>]`: prepares the app in B, or continues a recorded
 * move's prepare (without `--to`; a different `--to` is refused). Refused before any change while
 * the move is being aborted or finished. Until every covered environment is `prepared`: the checks
 * of the move's start, then, on the first run only, the summary and `confirmStart` (refused:
 * nothing changed) and the record written with `dsAtStart` from the public DS lookup; then the zone
 * plan and each environment's steps (plan 4.4). The mark is written last. Stops on purpose
 * (`done: false`, `next` says what to do) when a step's plan waits for `--approve <hash>`.
 */
export async function prepareMove(
  deps: PhaseDeps,
  options: PrepareMoveOptions = {},
): Promise<MoveResult> {
  const session = await openMoveSession(deps, { ...options, command: MOVE_COMMAND });
  requirePreparing(session);
  requireRecordedZone(session);
  if (!session.environments.every(isPrepared)) {
    await checkMoveStart(session);
    await startMove(session, options.confirmStart);
    const zoneStop = await zoneStep(session);
    if (zoneStop !== undefined) return stopped(session, zoneStop);
    for (const environment of session.environments) {
      if (isPrepared(environment)) continue;
      const stop = await prepareEnvironment(session, environment);
      if (stop !== undefined) return stopped(session, stop);
    }
  }
  const markStop = await writeMark(session);
  if (markStop !== undefined) return stopped(session, markStop);
  return prepared(session);
}

/** The environment's record of the move; written by {@link startMove} before any step reads it. */
function recordOf(environment: MoveEnvironment): CloudflareMove {
  const move = environment.plan.cloudflareMove;
  if (move !== undefined) return move;
  throw new OpsCrewError(
    "INTERNAL",
    `The plan of ${environment.environment} has no record of the move yet.`,
    { hint: "This is a bug in OpsCrew; please report it." },
  );
}

function isPrepared(environment: MoveEnvironment): boolean {
  return environment.plan.cloudflareMove?.step === "prepared";
}

/** Writes `move` as the environment's record and keeps its plan as written. */
async function saveRecord(
  session: MoveSession,
  environment: MoveEnvironment,
  move: CloudflareMove,
): Promise<void> {
  environment.plan = await writeMoveRecord(session.deps, environment.paths, move);
}

/** Stops before any change once an abort of the move began or the finish took an environment over. */
function requirePreparing(session: MoveSession): void {
  const { zone } = session;
  const records = session.environments.map((env) => env.plan.cloudflareMove);
  if (records.some((move) => move?.abort !== undefined)) {
    throw refusal(
      `The move of ${zone} to another Cloudflare account is being aborted.`,
      `Run \`${ABORT_COMMAND}\` to the end; start the move again after that.`,
    );
  }
  const adopted = session.environments.find((env) => env.plan.cloudflareMove?.step === "adopted");
  if (adopted !== undefined) {
    throw refusal(
      `The move of ${zone} is finishing: ${adopted.environment} runs on the new Cloudflare account already, so there is nothing left to prepare.`,
      `Run \`${FINISH_COMMAND}\` to go on with the finish.`,
    );
  }
}

/**
 * Stops before any change when the record names B's zone and B has no zone of that name now, or
 * one with another id: the pieces prepared there went with it, and a zone plan would add it again.
 */
function requireRecordedZone(session: MoveSession): void {
  const recorded = session.environments.find((env) => env.plan.cloudflareMove?.to.zoneId)?.plan
    .cloudflareMove?.to.zoneId;
  const { b } = session.accounts;
  if (recorded === undefined || b.zone?.id === recorded) return;
  throw refusal(
    `${session.zone} in the Cloudflare account ${b.name ?? b.accountId} is not the zone the move was prepared in: it is gone, or it was added again.`,
    `Run \`${ABORT_COMMAND}\` to remove what the move made, then start the move again (\`${MOVE_COMMAND} --to <account>\`).`,
  );
}

/**
 * The record of each covered environment that has none, at `started`: the recorded move's start
 * when another environment has one; otherwise, on the move's first run, after the summary (with
 * each bucket measured on the app's servers) was shown and `confirmStart` agreed, with B's zone
 * when B has it and `dsAtStart` from the public DS lookup (read before the summary is shown).
 */
async function startMove(
  session: MoveSession,
  confirmStart: PrepareMoveOptions["confirmStart"],
): Promise<void> {
  const missing = session.environments.filter((env) => env.plan.cloudflareMove === undefined);
  if (missing.length === 0) return;
  const recorded = session.environments.find((env) => env.plan.cloudflareMove !== undefined)?.plan
    .cloudflareMove;
  let start: MoveStart;
  if (recorded !== undefined) {
    const { zone, from, to, dsAtStart } = recorded;
    start = { zone, from, to, dsAtStart };
  } else {
    const { a, b } = session.accounts;
    const fetch = session.services.fetch ?? session.deps.fetch;
    const { records } = await lookupPublishedDs(fetch, session.zone);
    const sizes = [];
    for (const env of session.environments) sizes.push(...(await measureBuckets(session, env)));
    await confirmMoveStart(session, moveSummary(session, sizes), confirmStart);
    start = {
      zone: session.zone,
      from: { accountId: a.accountId, zoneId: a.zoneId },
      to: { accountId: b.accountId, ...(b.zone === undefined ? {} : { zoneId: b.zone.id }) },
      dsAtStart: records.length > 0,
    };
  }
  const now = session.deps.clock.now();
  for (const env of missing) await saveRecord(session, env, startedMove(start, now));
}

/**
 * The zone plan (plan 4.3): B's zone added when it is missing (its nameservers and B's zone
 * permissions checked before anything else changes), A's records that are no OpsCrew app's copied
 * create-only. Then B's zone is in every covered environment's record, and the session holds B's
 * `CloudflareSetup` (read again when this run added the zone).
 */
async function zoneStep(session: MoveSession): Promise<StepStop | undefined> {
  const stop = await applyZone(session, await planZone(session));
  if (stop !== undefined) return stop;
  const { b } = session.accounts;
  const zone = b.zone as MoveZone;
  if (b.setup === undefined) {
    const [first] = session.environments as [MoveEnvironment];
    b.setup = await setupCloudflare(
      { ...session.deps, paths: first.paths },
      first.plan,
      { cloudflare: b.client },
      { accountId: b.accountId, foreignRecords: "report" },
    );
  }
  for (const env of session.environments) {
    await saveRecord(session, env, withTargetZone(recordOf(env), zone.id));
  }
  return undefined;
}

/**
 * One environment's steps in B (plan 4.4), each checked before it acts: B's shared plan, the
 * shadow roots, B's connector beside A's, the deploy's extra credentials (from the main shadow
 * root's outputs) and the first copies of its R2 buckets; then its record is `prepared`. A step
 * whose plan waits for `--approve <hash>` stops the run.
 */
async function prepareEnvironment(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const { b } = session.accounts;
  session.deps.reporter.step(
    `Preparing ${environment.environment} of ${environment.plan.app.name} in the Cloudflare account ${b.name ?? b.accountId}`,
  );
  const shared = await planBShared(session, environment);
  if (shared.stop !== undefined) return shared.stop;
  let outputs: Record<string, unknown> = {};
  for (const root of await shadowRoots(session, environment)) {
    const step = await planShadow(session, root);
    if (step.kind === "pending") return pendingStop(session, step.planHash);
    if (root.name === "main") outputs = step.outputs;
  }
  const tunnels = moveTunnels(session, environment, outputs, {
    message: `The new Cloudflare account's infrastructure state of ${environment.environment} has no Cloudflare Tunnel with its token, so OpsCrew can't run its connector beside the current one. Nothing on the server was changed.`,
    hint: `Run \`${session.command}\` again; it plans the new account's pieces again.`,
  });
  const connector = await besideConnector(session, environment, tunnels);
  if (connector !== undefined) return connector;
  const secrets = await addNewCredentials(session, environment, outputs);
  if (secrets !== undefined) return secrets;
  const copies = await firstCopies(session, environment);
  if (copies !== undefined) return copies;
  const move = advancedMove(recordOf(environment), "prepared", session.deps.clock.now());
  await saveRecord(session, environment, move);
  return undefined;
}

/** A stop on purpose: the step every covered environment reached at least, and what to do next. */
function stopped(session: MoveSession, stop: StepStop): MoveResult {
  return {
    step: session.environments.every(isPrepared) ? "prepared" : "started",
    done: false,
    ...stop,
  };
}

/**
 * The end of prepare: the app is prepared and marked in B. The output names the other OpsCrew
 * apps of A's zone that no mark holds yet (by hostname), each to prepare from its own repository,
 * and the switch.
 */
async function prepared(session: MoveSession): Promise<MoveResult> {
  const { zone } = session;
  const { b } = session.accounts;
  const app = session.environments[0]?.plan.app.name ?? "The app";
  const { marks } = await readMarks(session);
  const marked = new Set(marks.flatMap((read) => read.mark.hosts));
  const waiting = session.otherHostnames.filter((name) => !marked.has(name));
  session.deps.reporter.success(
    `${app} is prepared in the Cloudflare account ${b.name ?? b.accountId}; the current account keeps serving it until the switch.`,
  );
  const next =
    waiting.length === 0
      ? [`Run \`${SWITCH_COMMAND}\` to point ${zone} at the new account.`]
      : [
          `Prepare the other OpsCrew apps in ${zone} too, each from the repository that deploys it (\`${MOVE_COMMAND} --to ${b.accountId}\`): ${listText(waiting)}.`,
          `Then run \`${SWITCH_COMMAND}\` from any of these repositories to point ${zone} at the new account.`,
        ];
  return { step: "prepared", done: true, next };
}
