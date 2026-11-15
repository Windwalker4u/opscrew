/**
 * Abort, before the switch only (`opscrew cloudflare move --abort`, plan 8.): the app's side in
 * the new account (B) removed, each removal approved with its kind and a typed name, and B's zone
 * deleted with its name typed when no other app is prepared in it. The account that holds the zone
 * (A) is only read. Refused once the switch changed anything, as any repository can tell from the
 * delegation, the DS records, B's zone and the records' steps. Every step reads what is there
 * before it acts, so a run after any stop or interruption goes on where the abort got to.
 */
import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  inspectShared,
  OPSCREW_MANAGED_COMMENT,
  sharedRuleHostnames,
} from "@opscrew/connector-cloudflare";
import {
  canonicalJson,
  listText,
  OpsCrewError,
  plural,
  sha256Hex,
  toPosixRelative,
} from "@opscrew/core";
import { cloudflareAddressScope } from "@opscrew/iac-templates";
import { appsOf, type CloudflareMove, environmentsOf } from "@opscrew/plan-schema";
import { appPaths } from "../apps/list";
import type { PhaseDeps } from "../context";
import { hosts, sameHosts } from "../domain/switch";
import { forgetStorageKey } from "../provision/storage";
import { appliesNow } from "../retarget/steps";
import { TUNNEL_ID_OUTPUTS, tunnelModules } from "../rotate/infra";
import {
  hasStateFile,
  PlanRefusedError,
  requestApproval,
  stateContents,
  stringOutput,
} from "../shared";
import { emptyBuckets, moveBuckets } from "./buckets";
import { removeBesideConnector, waitForNoConnection } from "./connector";
import { dropNewCredentials } from "./deploy-secrets";
import { appMark, deleteMark, markName, parseMarks } from "./marks";
import { moveFolder } from "./paths";
import {
  appProgressFile,
  clearPending,
  clearSwitchProgress,
  type MovePlanKey,
  readSwitchProgress,
  writePending,
} from "./progress";
import { abortingMove, readMoveRecords, writeMoveRecord } from "./record";
import { openMoveSession } from "./session";
import { dropShadow, prepareRemoval, shadowOutputs, shadowRoots, unguardedCopy } from "./shadow";
import { planRemoval } from "./shadow-plans";
import { pendingStop, removeBShared } from "./shared";
import { clearDsNotes, readPublished } from "./switch-ds";
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

/**
 * `opscrew cloudflare move --abort`: refused before any change unless the app has a recorded move
 * and the switch changed nothing ({@link switchBegun}). Then, recorded as an abort begun: the app's
 * mark deleted (no switch can start), and per environment the extra `_NEW` deploy secrets deleted,
 * the connectors beside A's removed and B's tunnels waited on until they have no connection, each
 * bucket root still holding its bucket emptied (the name typed) and destroyed from a copy without
 * the `prevent_destroy` guard, the other shadow roots destroyed (the app's name typed), B's shared
 * pieces removed and `originTlsNext` forgotten, the shadow states dropped. Recorded as removed:
 * the move's folders deleted, B's zone deleted ({@link deleteBZone}) or kept with the reason, and
 * the record and the app's local file removed. A script stops with each step's hash.
 */
export async function abortMove(
  deps: PhaseDeps,
  options: AbortMoveOptions = {},
): Promise<MoveResult> {
  const move = await requireRecordedMove(deps);
  const session = await openMoveSession(deps, { ...options, command: ABORT_COMMAND });
  const reading = await switchBegun(session, move);
  if (reading.begun !== undefined) throw begunRefusal(session, move, reading.begun);
  if (move.abort === undefined && reading.publicDns) await confirmDelegation(session);
  if (move.abort?.step !== "removed") {
    await recordAbort(session, "started");
    const stop = await removeFromB(session);
    if (stop !== undefined) return { step: move.step, done: false, ...stop };
    await recordAbort(session, "removed");
  }
  return endAbort(session, move);
}

/** The move's record; stops before anything is read when no environment of the app records one. */
async function requireRecordedMove(deps: PhaseDeps): Promise<CloudflareMove> {
  const { paths } = deps;
  const all = await readMoveRecords(paths, await environmentsOf(paths.root, paths.app));
  const move = all.find((env) => env.plan.cloudflareMove !== undefined)?.plan.cloudflareMove;
  if (move !== undefined) return move;
  throw refusal(
    `${all[0]?.plan.app.name ?? "The app"} is not moving to another Cloudflare account, so there is no move to abort.`,
    `Start a move with \`${MOVE_COMMAND} --to <account>\`.`,
  );
}

/** What the switch's reading came to: begun (why), or not, and whether the public DNS was read. */
type SwitchReading = { begun: string } | { begun?: undefined; publicDns: boolean };

/**
 * The refusal once the switch has begun: go on with the move, or, once B's pieces are removed
 * (`abort.step` `removed`), set A's nameservers back at the registrar.
 */
function begunRefusal(session: MoveSession, move: CloudflareMove, begun: string): OpsCrewError {
  const { zone } = session;
  const { a } = session.accounts;
  const aName = a.name ?? a.accountId;
  const hint =
    move.abort?.step === "removed"
      ? `The app's pieces in the new account are removed already, so the move can't go on: set the nameservers of ${zone} back to the account ${aName}'s (${(a.zone?.nameServers ?? []).join(", ")}) at its registrar, then run \`${ABORT_COMMAND}\` again.`
      : `Go on with the move: run \`${SWITCH_COMMAND}\`, then \`${FINISH_COMMAND}\`. Moving the app back later is a move from the new account to the current one; OpsCrew never publishes a removed DNSSEC (DS) record again.`;
  return refusal(
    `The switch of ${zone} to the new Cloudflare account has begun (${begun}), so the move can't be aborted.`,
    hint,
  );
}

/**
 * When this repository approved a switch plan for the zone and the nameservers were read from the
 * public DNS only (which may still show A's after they changed at the registrar), one typed
 * confirmation (`domain-settings`, the zone's name; `--confirm <zone>` in a script) before anything
 * changes. Nothing asked without that approval.
 */
async function confirmDelegation(session: MoveSession): Promise<void> {
  const { deps, zone } = session;
  const progress = await readSwitchProgress(session.paths);
  if (progress?.zone !== zone || progress.approved === undefined) return;
  const { a } = session.accounts;
  const aName = a.name ?? a.accountId;
  const servers = (a.zone?.nameServers ?? []).join(", ");
  const approval = await deps.approvals.request({
    kind: "domain-settings",
    title: `Abort the move of ${zone}, whose switch plan was approved on this computer`,
    details: [
      `The switch plan was approved here, and OpsCrew read the nameservers of ${zone} from the public DNS only, which can show the old ones for a while after a change.`,
      `Check that the registrar of ${zone} still lists the account ${aName}'s nameservers (${servers}). If it lists the new account's, don't abort: run the switch and the finish instead (\`${SWITCH_COMMAND}\`, then \`${FINISH_COMMAND}\`).`,
      "Type the zone's name to confirm.",
    ].join("\n"),
    confirmPhrase: zone,
  });
  if (approval.approved) return;
  throw new PlanRefusedError({
    plan: "abort",
    ...(approval.reason === undefined ? {} : { reason: approval.reason }),
    unchanged: "Nothing was changed.",
    hint: `Check the nameservers at the registrar of ${zone}, then run \`${ABORT_COMMAND}\` again (in a script: --confirm ${zone}).`,
  });
}

/**
 * Why the switch has begun, in words, or `undefined` while it changed nothing (plan 8.): an
 * environment is `adopted`, B's zone is active, A's is no longer active, the delegation (the
 * registrar's API, else the public DNS) no longer names A's nameservers, or the registry published
 * a DS record when the move started and publishes none now. Read-only.
 */
async function switchBegun(session: MoveSession, move: CloudflareMove): Promise<SwitchReading> {
  const { zone } = session;
  const { a, b } = session.accounts;
  const aName = a.name ?? a.accountId;
  if (session.environments.some((env) => env.plan.cloudflareMove?.step === "adopted")) {
    return { begun: "the finish has moved the app to the new account" };
  }
  if (b.zone?.status === "active") return { begun: `${zone} is active in the new account` };
  if (a.zone?.status !== "active") {
    return { begun: `${zone} is no longer active in the account ${aName}` };
  }
  const registrar = await findSwitchRegistrar(session);
  const delegation = await currentNameservers(session, registrar);
  if (!sameHosts(hosts(delegation), hosts(a.zone.nameServers))) {
    return { begun: `its nameservers are no longer those of the account ${aName}` };
  }
  if (move.dsAtStart) {
    // Either source showing none is enough: the registrar's API before the public DNS's cache.
    const ds = await readPublished(session, registrar);
    if (ds.public.length === 0 || ds.api?.length === 0) {
      return { begun: "its DNSSEC (DS) record is no longer published" };
    }
  }
  const api = registrar.kind === "api" ? registrar.registrar : undefined;
  return { publicDns: api?.getNameservers === undefined };
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

/** The environment's shadow state files that are not empty (`cloudflare-move/tfstate/`). */
async function shadowStates(environment: MoveEnvironment): Promise<string[]> {
  const dir = moveFolder(environment.paths, "tfstate");
  const found: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith(".tfstate") && (await hasStateFile(join(dir, name))))
      found.push(join(dir, name));
  }
  return found;
}

/**
 * The environment's shadow roots: none while it has no shadow state (prepare made nothing of its
 * roots in B, and may not have made what they need there, such as B's one-time PIN login). While B
 * has no zone, none either, unless a shadow state still holds Cloudflare pieces of the app in B (or
 * can't be read): then a plain stop that keeps the move's folder.
 */
async function rootsOf(session: MoveSession, environment: MoveEnvironment): Promise<ShadowRoot[]> {
  const states = await shadowStates(environment);
  if (states.length === 0) return [];
  const { b } = session.accounts;
  if (b.setup !== undefined) return shadowRoots(session, environment);
  // Only Cloudflare's pieces count: a seeded state also holds the copied server, which is A's.
  const held: string[] = [];
  for (const state of states) {
    const addresses = await session.engine
      .stateResources(state, { env: session.env })
      .catch(() => undefined);
    if (addresses?.every((address) => cloudflareAddressScope(address) === undefined) !== true) {
      held.push(toPosixRelative(session.paths.root, state));
    }
  }
  if (held.length === 0) return [];
  const bName = b.name ?? b.accountId;
  const app = environment.plan.app.name;
  const one = held.length === 1;
  const folder = toPosixRelative(session.paths.root, moveFolder(environment.paths));
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${session.zone} is no longer in the Cloudflare account ${bName}, but ${listText(held)} still ${one ? "holds" : "hold"} pieces of ${app} there, so OpsCrew keeps ${one ? "it" : "them"}. Nothing was deleted.`,
    {
      hint: `Delete what is left of ${app} (its tunnels, Access applications, policies and service tokens, Worker or R2 buckets) in the Cloudflare dashboard of the account ${bName}, then delete ${folder} and run \`${session.command}\` again.`,
    },
  );
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
  const connector = await removeBesideConnector(session, environment);
  if (connector !== undefined) return connector;
  const roots = await rootsOf(session, environment);
  const main = roots.find((root) => root.name === "main");
  if (main !== undefined) {
    for (const id of await tunnelIds(session, environment, main)) {
      await waitForNoConnection(session, session.accounts.b, id);
    }
  }
  const buckets = roots.filter((root) => root.name === "storage" || root.name === "backups");
  const others = roots.filter((root) => !buckets.includes(root));
  // Each bucket root still holding its bucket, with its copy without the guard, checked before
  // any bucket is emptied. A root that holds nothing is left alone, and so is any bucket B has of
  // that name.
  const held = await bucketsHeld(session, environment, buckets);
  const pairs: [ShadowRoot, ShadowRoot][] = [];
  for (const root of held) {
    const dir = moveFolder(environment.paths, "delete", basename(root.dir));
    pairs.push([root, await unguardedCopy(session, root, dir)]);
  }
  for (const [root, copy] of pairs) {
    const emptied = await emptyBuckets(session, environment, "b", [root.name]);
    if (emptied !== undefined) return emptied;
    const stop = await destroyRoot(session, environment, root, copy);
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
 * The bucket roots of `buckets` whose shadow state holds their bucket. Stops plainly, before any
 * deletion, when one can't be read.
 */
async function bucketsHeld(
  session: MoveSession,
  environment: MoveEnvironment,
  buckets: readonly ShadowRoot[],
): Promise<ShadowRoot[]> {
  const deps = { ...session.deps, paths: environment.paths };
  const { b } = session.accounts;
  const held: ShadowRoot[] = [];
  for (const root of buckets) {
    const contents = await stateContents(deps, root.statePath, async () => session.engine);
    if (contents === "resources") held.push(root);
    if (contents !== "unknown") continue;
    const state = toPosixRelative(session.paths.root, root.statePath);
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${state} can't be read, so OpsCrew neither empties nor deletes the bucket ${bucketOf(environment, root)} in the account ${b.name ?? b.accountId}. Nothing was deleted.`,
      {
        hint: `Restore ${state}, or run \`${session.command}\` on the computer that keeps the project's state passphrase.`,
      },
    );
  }
  return held;
}

/** The name of the bucket of a bucket root of the environment. */
function bucketOf(environment: MoveEnvironment, root: ShadowRoot): string {
  return moveBuckets(environment.plan).find((bucket) => bucket.root === root.name)?.bucket ?? "";
}

/** B's kept key of each of the environment's R2 buckets forgotten; A's keys stay. */
async function forgetBKeys(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  const { b } = session.accounts;
  for (const { bucket } of moveBuckets(environment.plan)) {
    await forgetStorageKey(
      { ...session.deps, paths: environment.paths },
      { provider: "r2", bucket },
      { account: b.accountId, moveTo: b.accountId },
    );
  }
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
 * After B's pieces are gone: each environment's move folder deleted, B's zone deleted or kept,
 * B's kept bucket keys forgotten, the repository's switch file and DS notes deleted when no other
 * app of it records a move (an approved switch plan kept there would let a later move switch
 * without asking), then the record removed from every covered plan and the app's local file
 * deleted.
 */
async function endAbort(session: MoveSession, move: CloudflareMove): Promise<MoveResult> {
  const { deps, zone } = session;
  const { a } = session.accounts;
  for (const env of session.environments) {
    await rm(moveFolder(env.paths), { recursive: true, force: true });
  }
  const outcome = await deleteBZone(session);
  if ("stop" in outcome) return { step: move.step, done: false, ...outcome.stop };
  const zoneWords = outcome.deleted
    ? "the new account's zone is deleted"
    : outcome.kept === undefined
      ? "the new account had no zone"
      : "the new account's zone stays";
  // Before the records go, so an interrupted abort never leaves them behind.
  for (const env of session.environments) await forgetBKeys(session, env);
  if (!(await otherMoveRecorded(session.paths))) {
    await clearSwitchProgress(session.paths);
    await clearDsNotes(session.paths);
  }
  for (const env of session.environments) {
    env.plan = await writeMoveRecord(deps, env.paths, undefined);
  }
  await rm(appProgressFile(session.paths), { force: true });
  const app = session.environments[0]?.plan.app.name ?? zone;
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "abort ended",
    phase: PHASE,
    target: app,
    detail: `the move of ${zone} is aborted; ${zoneWords}`,
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

/** True when an app of the repository other than `paths`' own records a move in any environment. */
async function otherMoveRecorded(paths: MoveSession["paths"]): Promise<boolean> {
  for (const { key } of await appsOf(paths.root)) {
    if (key === paths.app) continue;
    const own = appPaths(paths, key);
    const records = await readMoveRecords(own, await environmentsOf(paths.root, key));
    if (records.some((env) => env.plan.cloudflareMove !== undefined)) return true;
  }
  return false;
}

/** The zone's records in words, by type and name: `Its 2 records go with it: MX example.com, TXT example.com.` */
function recordsText(records: readonly { type: string; name: string }[]): string {
  if (records.length === 0) return "It holds no record.";
  const names = records.map((record) => `${record.type} ${record.name}`).sort();
  const go = records.length === 1 ? "goes" : "go";
  return `Its ${plural(records.length, "record")} ${go} with it: ${names.join(", ")}.`;
}

/** What the zone step came to: deleted or not (kept, and why), or a stop for its approval. */
type ZoneOutcome = { deleted: boolean; kept?: string } | { stop: StepStop };

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
    records: records
      .map(({ id, type, name, content, comment }) => ({
        id,
        type,
        name,
        content,
        comment: comment ?? null,
      }))
      .sort((x, y) => x.id.localeCompare(y.id)),
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
  if (b.zone === undefined) return { deleted: false };
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
  const why =
    apps.length > 0
      ? `it holds the move ${apps.length === 1 ? "mark" : "marks"} of ${listText(apps)}, prepared there from ${apps.length === 1 ? "its own repository" : "their own repositories"}`
      : opscrew.length > 0
        ? `it holds OpsCrew's records of other apps (${listText(opscrew)})`
        : first.zone.status === "active"
          ? "it is active there"
          : await otherRules(session, b.zone.id, first.zone.status);
  if (why !== undefined) {
    return {
      deleted: false,
      kept: `${zone} stays in the account ${bName}: ${why}. The last abort of an app prepared there deletes it.`,
    };
  }
  const key: MovePlanKey = { action: "abort-zone" };
  const title = `Delete the zone ${zone} from the Cloudflare account ${bName}`;
  const details = [
    `${zone} in the account ${bName} is ${first.zone.status} and has never served the app. It holds no other app's mark and no OpsCrew record. ${recordsText(first.records)}`,
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
  return { deleted: true };
}

/**
 * Why B's zone stays for OpsCrew's rules there (`inspectShared` with B's client): they list
 * hostnames that aren't this app's (another repository's app part-way through its prepare), or
 * some of their phases can't be read; `undefined` when neither.
 */
async function otherRules(
  session: MoveSession,
  zoneId: string,
  status: string,
): Promise<string | undefined> {
  const { b } = session.accounts;
  const facts = await inspectShared(b.client, {
    zoneId,
    accountId: b.accountId,
    access: false,
    redirect: true,
    pendingZone: status !== "active",
  });
  const denied = facts.deniedPhases ?? [];
  if (denied.length > 0) {
    return `OpsCrew can't read its rules there (the phases ${listText(denied)}), so it can't tell whether another app uses them`;
  }
  const mine = new Set((await appMark(session)).hosts);
  const others = sharedRuleHostnames(facts).filter((name) => !mine.has(name));
  if (others.length === 0) return undefined;
  return `OpsCrew's rules there list hostnames of other apps (${listText(others)})`;
}
