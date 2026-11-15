/**
 * The finish's last steps (plan 7.7, 7.8): the removal of A's pieces of an environment once the
 * finish adopted it in B (its tunnels waited on, A's account-scoped pieces destroyed from A's former
 * states, A's buckets checked, emptied and deleted, A's origin certificate revoked), and the move's
 * end (the app's mark, its record and its local files deleted). Nothing zone-scoped in A is ever
 * planned: A's records, rules and settings go with A's moved zone, which Cloudflare deletes.
 */
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { exists, listText, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { backupsBucketOf } from "@opscrew/plan-schema";
import { providerProfile } from "../providers";
import {
  NEW_OFFSITE_KEY_VARS,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  providerBucket,
  STORAGE_KEY_VARS,
} from "../provision/storage";
import { readOutputsAfterInit, stateContents, stringOutput } from "../shared";
import { emptyBuckets } from "./buckets";
import { waitForNoConnection } from "./connector";
import { NEW_DEPLOY_TOKEN_VAR } from "./deploy-secrets";
import { deleteMark, readMarks } from "./marks";
import { appProgressFile, type MoveRoot } from "./progress";
import { writeMoveRecord } from "./record";
import {
  dropShadow,
  hasContent,
  prepareRemoval,
  shadowEngineEnv,
  shadowFiles,
  shadowRoots,
} from "./shadow";
import { planRemoval } from "./shadow-plans";
import { aSharedRecordPath, pendingStop, revokeAOrigin } from "./shared";
import { A_TOKEN_VAR, B_TOKEN_VAR, refusal } from "./texts";
import type { MoveEnvironment, MoveResult, MoveSession, ShadowRoot, StepStop } from "./types";

/** The roots whose bucket carries `prevent_destroy`. */
const GUARDED: ReadonlySet<MoveRoot> = new Set(["storage", "backups"]);

/** The bucket's guard as OpsCrew renders it: `lifecycle { prevent_destroy = true }`. */
const GUARD = /\r?\n[ \t]*lifecycle \{\s*prevent_destroy = true\s*\}/g;

/** The root-module outputs with the id of each of the app's tunnels. */
const TUNNEL_ID_OUTPUTS = ["tunnel_id", "portainer_tunnel_id"] as const;

/** `shop (prod)`. */
function appWords(environment: MoveEnvironment): string {
  return `${environment.plan.app.name} (${environment.environment})`;
}

/** The account in words: its name as the session read it, else its id. */
function accountWords(account: { accountId: string; name?: string }): string {
  return `the Cloudflare account ${account.name ?? account.accountId}`;
}

/**
 * A copy of a bucket root without the bucket's guard, for its destroy plan (as
 * `destroy --delete-data` plans one): the committed root's files in
 * `cloudflare-move/a-removal/root/<root folder>/`, its `.tf` files without `prevent_destroy`.
 * Never written into the repository; made again on every run.
 */
async function unguardedCopy(root: ShadowRoot): Promise<ShadowRoot> {
  const removal = dirname(dirname(shadowFiles(root).removalState));
  const dir = join(removal, "root", basename(root.dir));
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(root.dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = join(root.dir, entry.name);
    if (!entry.name.endsWith(".tf")) {
      await copyFile(from, join(dir, entry.name));
      continue;
    }
    const text = (await readFile(from, "utf8")).replace(GUARD, "");
    if (text.includes("prevent_destroy")) {
      throw new OpsCrewError(
        "INTERNAL",
        `OpsCrew couldn't take the guard off the bucket in ${basename(root.dir)}/${entry.name} for its removal, so it planned nothing. Nothing was changed.`,
        { hint: "This is a bug in OpsCrew; please report it." },
      );
    }
    await writeFile(join(dir, entry.name), text);
  }
  return { ...root, dir };
}

/**
 * Waits until Cloudflare reports no connection for each of A's tunnels the main root's former
 * state names (its `tunnel_id` and `portainer_tunnel_id` outputs, read with A's token): the
 * connectors serve B's tunnels by now, and Cloudflare refuses to delete a connected tunnel.
 */
async function waitForATunnels(session: MoveSession, main: ShadowRoot): Promise<void> {
  const { removalState, removalDataDir } = shadowFiles(main);
  if (!(await hasContent(removalState))) return;
  const env = await shadowEngineEnv(session, main, "a", removalDataDir);
  const outputs = await readOutputsAfterInit(session.engine, main.dir, removalState, env);
  for (const name of TUNNEL_ID_OUTPUTS) {
    const tunnelId = stringOutput(outputs, name);
    if (tunnelId !== undefined) {
      await waitForNoConnection(session, session.accounts.a, tunnelId);
    }
  }
}

/**
 * A's account-scoped pieces of `root` removed: its former state prepared (`prepareRemoval`), then
 * its destroy plan (`planRemoval`), approved by its hash with `allowDestroy` and the app's name
 * typed. A script stops with the hash.
 */
async function removeRoot(
  session: MoveSession,
  environment: MoveEnvironment,
  root: ShadowRoot,
): Promise<StepStop | undefined> {
  await prepareRemoval(session, root, "a");
  if (root.name === "main") await waitForATunnels(session, root);
  const step = await planRemoval(session, root, "a");
  const app = environment.plan.app.name;
  if (step.kind === "pending") return pendingStop(session, step.planHash, ["--confirm", app]);
  if (step.kind === "applied") {
    await session.deps.audit.append({
      kind: "iac",
      actor: "opscrew",
      action: `A removed ${root.name}`,
      phase: "cloudflare-move",
      target: app,
      detail: `${environment.environment}: the ${root.name} root's pieces deleted in ${accountWords(session.accounts.a)} (plan ${step.planHash})`,
    });
  }
  return undefined;
}

/** What A's former state of `root` holds (`stateContents`). */
function removalContents(session: MoveSession, environment: MoveEnvironment, root: ShadowRoot) {
  const deps = { ...session.deps, paths: environment.paths };
  return stateContents(deps, shadowFiles(root).removalState, async () => session.engine);
}

/**
 * Removes A's pieces of `environment` once the finish adopted it in B (plan 7.7), in order: A's
 * tunnels waited on until Cloudflare reports no connection; the destroy plans of A's account-scoped
 * pieces of the main root (and of GitHub's verification record's, which has none) from A's former
 * states; a copy of each bucket root without the bucket's guard (any guard left stops before a file
 * is deleted); A's buckets checked against B's and emptied (`emptyBuckets`, each after its name is
 * typed, only those A's former state still holds); each bucket root's destroy plan, from its copy;
 * A's origin certificate revoked (`revokeAOrigin`), and A's record (`aSharedRecordPath`)
 * deleted once nothing of it is left to revoke. Every destroy plan is approved by its hash with
 * `allowDestroy` and the app's name typed. Resumable: a run plans each step again, and a step
 * that is done plans nothing. A refused approval leaves the app on B and the step to run again. A
 * script stops with each step's hash.
 */
export async function removeA(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  if (environment.plan.cloudflareMove?.step !== "adopted") {
    throw refusal(
      `${appWords(environment)} still runs on its pieces in ${accountWords(session.accounts.a)}: OpsCrew removes them only once the finish has moved the app to the new account.`,
      `Run \`${session.command}\` to finish the move first.`,
    );
  }
  const roots = await shadowRoots(session, environment);
  for (const root of roots.filter((one) => !GUARDED.has(one.name))) {
    const stop = await removeRoot(session, environment, root);
    if (stop !== undefined) return stop;
  }
  const copies: ShadowRoot[] = [];
  for (const root of roots.filter((one) => GUARDED.has(one.name))) {
    copies.push(await unguardedCopy(root));
  }
  const standing: MoveRoot[] = [];
  for (const copy of copies) {
    if ((await removalContents(session, environment, copy)) !== "nothing") standing.push(copy.name);
  }
  if (standing.length > 0) {
    const stop = await emptyBuckets(session, environment, "a", standing);
    if (stop !== undefined) return stop;
  }
  for (const copy of copies) {
    const stop = await removeRoot(session, environment, copy);
    if (stop !== undefined) return stop;
    await rm(copy.dir, { recursive: true, force: true });
  }
  const stop = await revokeAOrigin(session, environment);
  if (stop !== undefined) return stop;
  await rm(aSharedRecordPath(environment), { force: true });
  return undefined;
}

/**
 * Refuses, changing nothing, while the end would lose something: a state of the move that still
 * holds pieces (or can't be read), or A's record naming an origin certificate still to revoke.
 */
async function requireNothingLeft(session: MoveSession): Promise<void> {
  for (const environment of session.environments) {
    const deps = { ...session.deps, paths: environment.paths };
    for (const root of await shadowRoots(session, environment)) {
      for (const state of [root.statePath, shadowFiles(root).removalState]) {
        if ((await stateContents(deps, state, async () => session.engine)) === "nothing") continue;
        throw refusal(
          `${toPosixRelative(session.paths.root, state)} still holds pieces of ${environment.plan.app.name} OpsCrew hasn't removed, or can't be read, so the move can't end yet.`,
          `Run \`${session.command}\` again: it plans their removal first.`,
        );
      }
    }
    if (await exists(aSharedRecordPath(environment))) {
      throw refusal(
        `The origin certificate of ${appWords(environment)} in ${accountWords(session.accounts.a)} isn't revoked yet, so the move can't end.`,
        `Run \`${session.command}\` again: it revokes it once the server serves the new account's origin certificate.`,
      );
    }
  }
}

/**
 * The variables to change once every app in the zone has finished its move, as `[new, plain]`:
 * B's token, and the app's other `OPSCREW_NEW_*` values it read (B's bucket keys, a site's deploy
 * token).
 */
function renames(session: MoveSession): [string, string][] {
  const plans = session.environments.map((environment) => environment.plan);
  const pairs: [string, string][] = [[B_TOKEN_VAR, A_TOKEN_VAR]];
  if (plans.some((plan) => providerBucket(plan)?.provider === "r2")) {
    pairs.push(
      [NEW_STORAGE_KEY_VARS.accessKeyId, STORAGE_KEY_VARS.accessKeyId],
      [NEW_STORAGE_KEY_VARS.secretAccessKey, STORAGE_KEY_VARS.secretAccessKey],
    );
  }
  if (plans.some((plan) => backupsBucketOf(plan)?.provider === "r2")) {
    pairs.push(
      [NEW_OFFSITE_KEY_VARS.accessKeyId, OFFSITE_KEY_VARS.accessKeyId],
      [NEW_OFFSITE_KEY_VARS.secretAccessKey, OFFSITE_KEY_VARS.secretAccessKey],
    );
  }
  if (plans.some((plan) => plan.target.provider === "cloudflare-workers")) {
    pairs.push([NEW_DEPLOY_TOKEN_VAR, providerProfile("cloudflare-workers").deployTokenVar]);
  }
  return pairs;
}

/**
 * The move's end (plan 7.8), once every covered environment is adopted in B and A's pieces are
 * removed: refused, changing nothing, while a state of the move still holds pieces or A's record
 * is still there; then the app's mark deleted from B's zone (a zone plan approved by its hash;
 * other apps' marks stay), then the move's local files (each root's states and data folders, each
 * environment's `cloudflare-move/` folder and the app's `cloudflare-move.json`), then
 * `cloudflareMove` removed from every covered plan. Resumable after
 * each. The result says which variables to give B's values once every app in the zone has
 * finished: now, or once the apps whose marks are still in B's zone have.
 */
export async function endFinish(session: MoveSession): Promise<MoveResult> {
  const waiting = session.environments.filter(
    (environment) => environment.plan.cloudflareMove?.step !== "adopted",
  );
  if (waiting.length > 0) {
    throw refusal(
      `The finish hasn't moved ${listText(waiting.map(appWords))} to the new account yet, so the move can't end.`,
      `Run \`${session.command}\` again: it goes on where it stopped.`,
    );
  }
  await requireNothingLeft(session);
  const stop = await deleteMark(session);
  if (stop !== undefined) return { step: "adopted", done: false, ...stop };
  for (const environment of session.environments) {
    for (const root of await shadowRoots(session, environment)) await dropShadow(session, root);
    await rm(join(environment.paths.stateDir, "cloudflare-move"), { recursive: true, force: true });
  }
  await rm(appProgressFile(session.paths), { force: true });
  for (const environment of session.environments) {
    await writeMoveRecord(session.deps, environment.paths, undefined);
  }
  const [first] = session.environments;
  const app = first?.plan.app.name ?? session.zone;
  await session.deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "move finished",
    phase: "cloudflare-move",
    target: app,
    detail: `${session.zone}: ${app} runs in ${accountWords(session.accounts.b)}; its mark, record and local files of the move are deleted`,
  });
  session.deps.reporter.success(
    `${app} runs in ${accountWords(session.accounts.b)}, and nothing of it is left in ${accountWords(session.accounts.a)}.`,
  );
  const others = (await readMarks(session)).marks.map((read) => read.mark.app);
  const when =
    others.length === 0
      ? `Every OpsCrew app in ${session.zone} has finished its move, so now`
      : `Once ${listText(others)} in ${session.zone} ${others.length === 1 ? "has" : "have"} finished ${others.length === 1 ? "its move" : "their moves"} too,`;
  return {
    step: "finished",
    done: true,
    next: [
      `${when} give these variables the new account's values wherever you run OpsCrew (this computer, your scripts):`,
      ...renames(session).map(
        ([next, plain]) => `  ${plain}: the value of ${next}; then remove ${next}.`,
      ),
    ],
  };
}
