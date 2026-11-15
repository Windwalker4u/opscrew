/**
 * Abort, before the switch only (`opscrew cloudflare move --abort`, plan 8.): the app's side in
 * the new account (B) removed, each removal approved with its kind and a typed name, and B's zone
 * deleted with its name typed when no other app is prepared in it. The account that holds the zone
 * (A) is only read. Refused once the switch changed anything, as any repository can tell from the
 * delegation, the DS records, B's zone and the records' steps. Every step reads what is there
 * before it acts, so a run after any stop or interruption goes on where the abort got to.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import { canonicalJson, listText, OpsCrewError, plural, sha256Hex } from "@opscrew/core";
import { appsOf, type CloudflareMove, environmentsOf } from "@opscrew/plan-schema";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { readDs } from "../domain";
import { hosts, sameHosts } from "../domain/switch";
import { appliesNow } from "../retarget/steps";
import { tunnelModules } from "../rotate/infra";
import { requestApproval, stateContents, stringOutput } from "../shared";
import { emptyBuckets } from "./buckets";
import { removeBesideConnector, waitForNoConnection } from "./connector";
import { dropNewCredentials } from "./deploy-secrets";
import { deleteMark, markName, parseMarks } from "./marks";
import {
  appProgressFile,
  clearPending,
  clearSwitchProgress,
  type MovePlanKey,
  writePending,
} from "./progress";
import { abortingMove, readMoveRecords, writeMoveRecord } from "./record";
import { openMoveSession } from "./session";
import { dropShadow, prepareRemoval, shadowOutputs, shadowRoots } from "./shadow";
import { planRemoval } from "./shadow-plans";
import { pendingStop, removeBShared } from "./shared";
import { clearDsNotes } from "./switch-ds";
import { currentNameservers, findSwitchRegistrar } from "./switch-registrar";
import { ABORT_COMMAND, FINISH_COMMAND, MOVE_COMMAND, refusal, SWITCH_COMMAND } from "./texts";
import type {
  AbortMoveOptions,
  MoveEnvironment,
  MoveResult,
  MoveSession,
  ShadowRoot,
  StepStop,
} from "./types";

const PHASE = "cloudflare-move";

/** The main root's output with each tunnel's id (as rotate reads them). */
const TUNNEL_ID_OUTPUTS = { tunnel: "tunnel_id", portainer_tunnel: "portainer_tunnel_id" } as const;

/** A bucket root's `prevent_destroy` guard, as the storage and backups roots are rendered. */
const DESTROY_GUARD = /\s*lifecycle\s*\{\s*prevent_destroy\s*=\s*true\s*\}/g;

/**
 * `opscrew cloudflare move --abort`: refused before any change unless the app has a recorded move
 * and the switch changed nothing ({@link switchBegun}). Then, recorded as an abort begun: the app's
 * mark deleted (no switch can start), and per environment the extra `_NEW` deploy secrets deleted,
 * the connectors beside A's removed and B's tunnels waited on until they have no connection, B's
 * buckets emptied (each name typed) and their roots destroyed from a copy without the
 * `prevent_destroy` guard, the other shadow roots destroyed (the app's name typed), B's shared
 * pieces removed and `originTlsNext` forgotten, the shadow states dropped. Recorded as removed:
 * the move's folders deleted, B's zone deleted ({@link deleteBZone}) or kept with the reason, and
 * the record and the app's local file removed. A script stops with each step's hash.
 */
export async function abortMove(
  deps: PhaseDeps,
  options: AbortMoveOptions = {},
): Promise<MoveResult> {
  await requireRecordedMove(deps);
  const session = await openMoveSession(deps, { ...options, command: ABORT_COMMAND });
  const move = recordOf(session);
  const begun = await switchBegun(session, move);
  if (begun !== undefined) {
    throw refusal(
      `The switch of ${session.zone} to the new Cloudflare account has begun (${begun}), so the move can't be aborted.`,
      `Go on with the move: run \`${SWITCH_COMMAND}\`, then \`${FINISH_COMMAND}\`. Moving the app back later is a move from the new account to the current one; OpsCrew never publishes a removed DNSSEC (DS) record again.`,
    );
  }
  if (move.abort?.step !== "removed") {
    await recordAbort(session, "started");
    const stop = await removeFromB(session);
    if (stop !== undefined) return { step: move.step, done: false, ...stop };
    await recordAbort(session, "removed");
  }
  return endAbort(session, move);
}

/** Stops before anything is read when no environment of the app records a move. */
async function requireRecordedMove(deps: PhaseDeps): Promise<void> {
  const { paths } = deps;
  const all = await readMoveRecords(paths, await environmentsOf(paths.root, paths.app));
  if (all.some((env) => env.plan.cloudflareMove !== undefined)) return;
  throw refusal(
    `${all[0]?.plan.app.name ?? "The app"} is not moving to another Cloudflare account, so there is no move to abort.`,
    `Start a move with \`${MOVE_COMMAND} --to <account>\`.`,
  );
}

/** The move's record, as the covered environments hold it. */
function recordOf(session: MoveSession): CloudflareMove {
  const move = session.environments.find((env) => env.plan.cloudflareMove !== undefined)?.plan
    .cloudflareMove;
  if (move !== undefined) return move;
  throw new OpsCrewError("INTERNAL", `No environment records the move of ${session.zone}.`, {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}

/**
 * Why the switch has begun, in words, or `undefined` while it changed nothing (plan 8.): an
 * environment is `adopted`, B's zone is active, A's is no longer active, the delegation (the
 * registrar's API, else the public DNS) no longer names A's nameservers, or the registry published
 * a DS record when the move started and publishes none now. Read-only.
 */
async function switchBegun(
  session: MoveSession,
  move: CloudflareMove,
): Promise<string | undefined> {
  const { deps, services, zone } = session;
  const { a, b } = session.accounts;
  const aName = a.name ?? a.accountId;
  if (session.environments.some((env) => env.plan.cloudflareMove?.step === "adopted")) {
    return "the finish has moved the app to the new account";
  }
  if (b.zone?.status === "active") return `${zone} is active in the new account`;
  if (a.zone?.status !== "active") return `${zone} is no longer active in the account ${aName}`;
  const registrar = await findSwitchRegistrar(session);
  const delegation = await currentNameservers(session, registrar);
  if (!sameHosts(hosts(delegation), hosts(a.zone.nameServers))) {
    return `its nameservers are no longer those of the account ${aName}`;
  }
  if (move.dsAtStart) {
    const ds = await readDs({
      deps: { ...deps, fetch: services.fetch ?? deps.fetch },
      domain: zone,
      ...(registrar.kind === "api" ? { registrar: registrar.registrar } : {}),
    });
    if (ds.records.length === 0) return "its DNSSEC (DS) record is no longer published";
  }
  return undefined;
}

/** Writes the abort at `step` into every covered environment's record (kept in the session). */
async function recordAbort(session: MoveSession, step: "started" | "removed"): Promise<void> {
  for (const env of session.environments) {
    const move = env.plan.cloudflareMove;
    if (move === undefined) continue;
    env.plan = await writeMoveRecord(session.deps, env.paths, abortingMove(move, step));
  }
}

/** The app's mark deleted first, then each environment's pieces in B; a stop when a step waits. */
async function removeFromB(session: MoveSession): Promise<StepStop | undefined> {
  const mark = await deleteMark(session);
  if (mark !== undefined) return mark;
  for (const environment of session.environments) {
    const stop = await removeEnvironment(session, environment);
    if (stop !== undefined) return stop;
  }
  return undefined;
}

/** The environment's shadow roots, none while B has no zone (nothing was planned there then). */
function rootsOf(session: MoveSession, environment: MoveEnvironment): Promise<ShadowRoot[]> {
  if (session.accounts.b.setup === undefined) return Promise.resolve([]);
  return shadowRoots(session, environment);
}

/** Whether `root`'s shadow state may hold resources (it does, or can't be read). */
async function holds(session: MoveSession, environment: MoveEnvironment, root: ShadowRoot) {
  const deps = { ...session.deps, paths: environment.paths };
  return (await stateContents(deps, root.statePath, async () => session.engine)) !== "nothing";
}

/** Plan 8.'s steps for one environment, in order, each skipped once done. */
async function removeEnvironment(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const secrets = await dropNewCredentials(session, environment);
  if (secrets !== undefined) return secrets;
  await removeBesideConnector(session, environment);
  const roots = await rootsOf(session, environment);
  const main = roots.find((root) => root.name === "main");
  if (main !== undefined) {
    for (const id of await tunnelIds(session, environment, main)) {
      await waitForNoConnection(session, session.accounts.b, id);
    }
  }
  const buckets = roots.filter((root) => root.name === "storage" || root.name === "backups");
  const others = roots.filter((root) => !buckets.includes(root));
  let filled = false;
  for (const root of buckets) filled ||= await holds(session, environment, root);
  if (filled) {
    const emptied = await emptyBuckets(session, environment, "b");
    if (emptied !== undefined) return emptied;
  }
  for (const root of buckets) {
    const stop = await destroyRoot(session, environment, root, await withoutGuard(root));
    if (stop !== undefined) return stop;
  }
  for (const root of others) {
    const stop = await destroyRoot(session, environment, root, root);
    if (stop !== undefined) return stop;
  }
  const shared = await removeBShared(session, environment);
  if (shared !== undefined) return shared;
  for (const root of roots) await dropShadow(session, root);
  return undefined;
}

/**
 * The ids of B's tunnels of the environment, from its main shadow root's outputs (the other
 * outputs, which may hold secrets, registered with the redactor); none without a tunnel or once
 * the root holds nothing.
 */
async function tunnelIds(
  session: MoveSession,
  environment: MoveEnvironment,
  main: ShadowRoot,
): Promise<string[]> {
  const modules = tunnelModules(environment.plan);
  if (modules.length === 0 || !(await holds(session, environment, main))) return [];
  const outputs = await shadowOutputs(session, main);
  const names: readonly string[] = modules.map((module) => TUNNEL_ID_OUTPUTS[module]);
  for (const [name, value] of Object.entries(outputs)) {
    if (!names.includes(name) && typeof value === "string" && value !== "") {
      session.deps.redactor.addLiteral(value, name);
    }
  }
  return names.flatMap((name) => stringOutput(outputs, name) ?? []);
}

/**
 * B's pieces of `root` destroyed: its copied server resources taken out of the shadow state, then
 * the destroy plan of the rest, planned in `planned` (the root, or its copy without the guard),
 * approved with the app's name typed. A script stops with its hash.
 */
async function destroyRoot(
  session: MoveSession,
  environment: MoveEnvironment,
  root: ShadowRoot,
  planned: ShadowRoot,
): Promise<StepStop | undefined> {
  await prepareRemoval(session, root, "b");
  const step = await planRemoval(session, planned, "b");
  if (step.kind !== "pending") return undefined;
  return pendingStop(session, step.planHash, ["--confirm", environment.plan.app.name]);
}

/**
 * A copy of a bucket root's committed files without its `prevent_destroy` guard, in the
 * environment's move folder (`cloudflare-move/delete/<root folder>/`), as `destroy --delete-data`
 * plans from one: the root with its folder there. The committed root keeps the guard.
 */
async function withoutGuard(root: ShadowRoot): Promise<ShadowRoot> {
  const dir = join(dirname(dirname(root.statePath)), "delete", basename(root.dir));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const name of await readdir(root.dir)) {
    const from = join(root.dir, name);
    if (!(await stat(from)).isFile()) continue;
    const text = await readFile(from, "utf8");
    await writeFile(join(dir, name), name.endsWith(".tf") ? text.replace(DESTROY_GUARD, "") : text);
  }
  return { ...root, dir };
}

/**
 * After B's pieces are gone: each environment's move folder deleted, B's zone deleted or kept,
 * then the record removed from every covered plan and the app's local file deleted; the
 * repository's switch file and DS notes too once no app of it records a move (an approved switch
 * plan kept there would let a later move switch without asking).
 */
async function endAbort(session: MoveSession, move: CloudflareMove): Promise<MoveResult> {
  const { deps, zone } = session;
  const { a } = session.accounts;
  for (const env of session.environments) {
    await rm(join(env.paths.stateDir, "cloudflare-move"), { recursive: true, force: true });
  }
  const outcome = await deleteBZone(session);
  if ("stop" in outcome) return { step: move.step, done: false, ...outcome.stop };
  for (const env of session.environments) {
    env.plan = await writeMoveRecord(deps, env.paths, undefined);
  }
  await rm(appProgressFile(session.paths), { force: true });
  if (!(await anyMoveRecorded(session.paths))) {
    await clearSwitchProgress(session.paths);
    await clearDsNotes(session.paths);
  }
  const app = session.environments[0]?.plan.app.name ?? zone;
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "abort ended",
    phase: PHASE,
    target: app,
    detail: `the move of ${zone} is aborted; ${outcome.kept === undefined ? "the new account's zone is deleted" : "the new account's zone stays"}`,
  });
  deps.reporter.success(`The move of ${app} to the new Cloudflare account is aborted.`);
  return {
    step: "aborted",
    done: true,
    next: [
      ...(outcome.kept === undefined ? [] : [outcome.kept]),
      `${zone} goes on serving from the account ${a.name ?? a.accountId}, which the move never changed. To move later, start again with \`${MOVE_COMMAND} --to <account>\`.`,
    ],
  };
}

/** True when any app of the repository `paths` belong to records a move in any environment. */
async function anyMoveRecorded(paths: MoveSession["paths"]): Promise<boolean> {
  for (const { key } of await appsOf(paths.root)) {
    const own = appPaths(paths, key);
    const records = await readMoveRecords(own, await environmentsOf(paths.root, key));
    if (records.some((env) => env.plan.cloudflareMove !== undefined)) return true;
  }
  return false;
}

/** What the zone step came to: deleted, kept (and why), or a stop for its approval. */
type ZoneOutcome = { kept?: string } | { stop: StepStop };

/** The hash the deletion of B's zone is approved by: the zone, its status and its records. */
async function zoneDeletion(session: MoveSession, zoneId: string) {
  const { b } = session.accounts;
  const zone = await b.client.getZone(zoneId);
  const records = await b.client.listZoneRecords(zoneId);
  const body = {
    action: "abort-zone",
    zone: session.zone,
    accountId: b.accountId,
    zoneId,
    status: zone.status,
    records: records.map((record) => record.id).sort(),
  };
  return { zone, records, hash: sha256Hex(canonicalJson(body)) };
}

/**
 * B's zone deleted (`cloudflare-apply`, `allowDestroy`, the zone's name typed) when it holds no
 * other app's mark (a damaged one counts) and no OpsCrew record, and is not active; otherwise kept,
 * with the reason. After the approval it is read again, and nothing is deleted when it changed.
 * A script stops with the hash (`--confirm <zone> --approve <hash>`).
 */
async function deleteBZone(session: MoveSession): Promise<ZoneOutcome> {
  const { deps, zone } = session;
  const { a, b } = session.accounts;
  if (b.zone === undefined) return {};
  const bName = b.name ?? b.accountId;
  const first = await zoneDeletion(session, b.zone.id);
  const own = await markName(session);
  const { marks, damaged } = parseMarks(first.records);
  const apps = [
    ...marks.filter((read) => read.name !== own).map((read) => read.mark.app),
    ...damaged.filter((name) => name !== own),
  ];
  const opscrew = [
    ...new Set(
      first.records
        .filter((record) => record.comment?.trim() === OPSCREW_MANAGED_COMMENT)
        .map((record) => record.name),
    ),
  ].sort();
  if (apps.length > 0 || opscrew.length > 0 || first.zone.status === "active") {
    const why =
      apps.length > 0
        ? `it holds the move ${apps.length === 1 ? "mark" : "marks"} of ${listText(apps)}, prepared there from ${apps.length === 1 ? "its own repository" : "their own repositories"}`
        : opscrew.length > 0
          ? `it holds OpsCrew's records of other apps (${listText(opscrew)})`
          : "it is active there";
    return {
      kept: `${zone} stays in the account ${bName}: ${why}. The last abort of an app prepared there deletes it.`,
    };
  }
  const key: MovePlanKey = { action: "abort-zone" };
  const title = `Delete the zone ${zone} from the Cloudflare account ${bName}`;
  const details = [
    `${zone} in the account ${bName} is ${first.zone.status} and has never served the app. It holds no other app's mark and no OpsCrew record; its ${plural(first.records.length, "record")} (copies of the account ${a.name ?? a.accountId}'s) go with it.`,
    `Nothing in the account ${a.name ?? a.accountId} changes. Type the zone's name to approve.`,
  ].join("\n");
  if (!appliesNow(session, first.hash)) {
    deps.reporter.info(`${title}\n${details}`);
    await writePending(deps, key, first.hash);
    return { stop: pendingStop(session, first.hash, ["--confirm", zone]) };
  }
  await requestApproval(deps, {
    kind: "cloudflare-apply",
    title,
    details,
    hash: first.hash,
    guard: { allowDestroy: true, confirmPhrase: zone },
    refused: {
      plan: "deletion of the zone",
      unchanged: "Nothing in Cloudflare was changed.",
      again: session.command,
    },
  });
  await deps.approvals.assertApprovedCloudflarePlan(first.hash, { allowDestroy: true });
  const again = await zoneDeletion(session, b.zone.id);
  if (again.hash !== first.hash) {
    await clearPending(deps, key);
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `${zone} changed in the account ${bName} since its deletion was approved, so OpsCrew did not delete it. Nothing was changed.`,
      { hint: `Run \`${session.command}\` again to see what it holds now.` },
    );
  }
  await b.client.deleteZone(b.zone.id);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "abort zone deleted",
    phase: PHASE,
    target: first.hash,
    decision: "approved",
    detail: `${zone} in the account ${b.accountId}`,
  });
  await clearPending(deps, key);
  deps.reporter.success(`Deleted ${zone} from the account ${bName}.`);
  return {};
}
