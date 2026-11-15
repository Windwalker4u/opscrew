/**
 * The plans of a move's shadow roots (plan 3.): B's pieces planned in the shadow states, the check
 * plan after the swap, and the destroy plans of A's account-scoped pieces (the finish) or of all of
 * B's (an abort). Each goes through `planAndApply` with its `move` option: approved by its hash,
 * saved under `-move.tfplan` (which no other command applies), checked with `planBounded` before
 * the approval. A non-interactive run stops with the hash; `--approve <hash>` applies the saved plan.
 */
import type { ResourceChange } from "@opscrew/contracts";
import { isUserFacingError, OpsCrewError, toPosixRelative } from "@opscrew/core";
import { hashFile } from "@opscrew/iac-engine";
import { cloudflareAddressScope } from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";
import {
  findSavedPlan,
  isMovesOnly,
  type PlanAndApplyOptions,
  planAndApply,
  type SavedPlan,
} from "../provision";
import { discardSaved, type PlanStep, planBounded, quietly } from "../retarget/plans";
import { hasStateFile } from "../shared";
import { accessHostnames } from "./marks";
import {
  clearPending,
  type MovePlanAction,
  type MovePlanKey,
  type MoveRoot,
  pendingMatches,
  readAppProgress,
  writePending,
} from "./progress";
import {
  accountIds,
  committedValues,
  environmentOf,
  removalTarget,
  removedBy,
  seedShadow,
  shadowEngineEnv,
  shadowFiles,
  tfvarsFile,
} from "./shadow";
import { A_TOKEN_VAR, accountName, environmentDeps, MOVE_PHASE, refusal } from "./texts";
import type { MoveSession, MoveSide, ShadowRoot } from "./types";

/** What a root's pieces are called in an approval's title. */
const ROOT_WORDS: Readonly<Record<MoveRoot, string>> = {
  main: "Cloudflare pieces",
  storage: "bucket",
  backups: "bucket of the snapshots' copies",
  "pages-verification": "GitHub domain verification record",
};

/** One plan of a shadow root. */
interface ShadowPlan {
  action: MovePlanAction;
  statePath: string;
  env: Record<string, string | undefined>;
  vars?: Record<string, string>;
  destroy?: boolean;
  /** The variable of the token the plan runs with, for the hints (default B's). */
  tokenVar?: string;
  /** Stops before any approval when the plan does more than this step may do. */
  check: (saved: SavedPlan) => void;
  title: string;
}

/** `name (environment)`, for example `bucket of example-app (prod)`. */
function rootWords(session: MoveSession, root: ShadowRoot): string {
  const app = environmentOf(session, root).plan.app.name;
  return `${app}'s ${ROOT_WORDS[root.name]} (${root.environment})`;
}

/**
 * The hash of `key`'s saved plan when `--approve <hash>` names it, re-checked with `check` (a plan
 * that fails it is deleted and forgotten); `undefined` when it names no plan this step waits for.
 * The approval is used up either way; a missing or changed plan file stops with nothing changed.
 */
async function approvedPending(
  session: MoveSession,
  deps: PhaseDeps,
  key: MovePlanKey,
  check: (saved: SavedPlan) => void,
): Promise<string | undefined> {
  const { pending } = await readAppProgress(deps.paths);
  if (!pendingMatches(pending, key, session.approve)) return undefined;
  session.approve = undefined;
  const again = `Run \`${session.command}\` without --approve to plan again, review the plan and approve the new hash.`;
  let saved: SavedPlan | undefined;
  try {
    saved = await findSavedPlan(deps.paths.files.plansDir, pending.planHash, { hint: again });
  } catch (error) {
    await clearPending(deps, key);
    throw error;
  }
  if (saved === undefined || (await hashFile(saved.planFile).catch(() => "")) !== saved.planHash) {
    await clearPending(deps, key);
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The plan you approved (hash ${pending.planHash}) is missing or was changed after it was saved, so OpsCrew will not apply it. Nothing was changed.`,
      { hint: again },
    );
  }
  try {
    check(saved);
  } catch (error) {
    await discardSaved(saved.planFile);
    await clearPending(deps, key);
    throw error;
  }
  return saved.planHash;
}

/**
 * Plans `root` as `plan` says through `planAndApply` (in the environment's plans folder, with the
 * same `vars` for the plan and its apply), checks it, records it as the plan the move waits for
 * and, in a terminal, applies it after the approval bound to its hash; a script stops with the
 * hash. With `--approve <hash>` naming this step's saved plan, that plan is checked again and
 * applied. A refused approval keeps the saved plan for `--approve`; any other outcome forgets it.
 */
async function shadowPlanStep(
  session: MoveSession,
  root: ShadowRoot,
  plan: ShadowPlan,
): Promise<PlanStep> {
  const environment = environmentOf(session, root);
  const deps = environmentDeps(session, environment);
  const key: MovePlanKey = { action: plan.action, environment: root.environment, root: root.name };
  const options: PlanAndApplyOptions = {
    engine: session.engine,
    dir: root.dir,
    env: plan.env,
    ...(plan.vars === undefined ? {} : { vars: plan.vars }),
    deployPlan: environment.plan,
    files: [],
    statePath: plan.statePath,
    command: session.command,
    phase: MOVE_PHASE,
    move: true,
    costDelta: null,
    approvalTitle: plan.title,
    ...(plan.destroy === true ? { destroy: true } : {}),
    ...(plan.tokenVar === undefined ? {} : { tokenVar: plan.tokenVar }),
  };
  let planHash = await approvedPending(session, deps, key, plan.check);
  if (planHash === undefined) {
    const planned = await planAndApply(deps.interactive ? quietly(deps) : deps, {
      ...options,
      planOnly: true,
    });
    const saved = planned.plan;
    if (saved === undefined || (saved.changes.length === 0 && !isMovesOnly(saved))) {
      return { kind: "unchanged", outputs: planned.outputs };
    }
    try {
      plan.check(saved);
    } catch (error) {
      await discardSaved(saved.planFile);
      throw error;
    }
    await writePending(deps, key, saved.planHash);
    if (!deps.interactive) return { kind: "pending", planHash: saved.planHash };
    planHash = saved.planHash;
  }
  try {
    const result = await planAndApply(deps, { ...options, approvePlanHash: planHash });
    await clearPending(deps, key);
    return {
      kind: "applied",
      planHash,
      outputs: result.outputs,
      ...(result.approval === undefined ? {} : { approval: result.approval }),
    };
  } catch (error) {
    if (!(isUserFacingError(error) && error.code === "APPROVAL_REFUSED")) {
      await clearPending(deps, key);
    }
    throw error;
  }
}

/**
 * The roots' variables B's plan sets to `false` while B's zone is pending (plan 13b): Cloudflare
 * refuses Access applications on a pending zone, and a protected hostname's record to B's tunnel
 * would be public without its application; the switch makes both once B is active.
 */
const HELD_BACK_WHILE_PENDING = ["access_applications", "protected_route_records"] as const;

/**
 * `false` for each of {@link HELD_BACK_WHILE_PENDING} the root's committed values have, while B's
 * zone is not active; none once it is, or in a root without them. Refuses a main root with Access
 * whose values lack them (rendered before them): planned as it is, B's plan would make the Access
 * applications Cloudflare refuses there.
 */
async function heldBackWhilePending(
  session: MoveSession,
  root: ShadowRoot,
): Promise<Record<string, string>> {
  if (session.accounts.b.zone?.status === "active") return {};
  const values = await committedValues(session, root.dir);
  const held = HELD_BACK_WHILE_PENDING.filter((name) => name in values);
  const { plan } = environmentOf(session, root);
  if (
    root.name === "main" &&
    held.length < HELD_BACK_WHILE_PENDING.length &&
    accessHostnames(plan, session.zone).length > 0
  ) {
    throw refusal(
      `${toPosixRelative(session.paths.root, tfvarsFile(root.dir))} is from before OpsCrew could hold back Access applications, which Cloudflare refuses on the new account's pending zone.`,
      `Run \`opscrew provision\` to bring the app's files up to date and commit them, then run \`${session.command}\` again.`,
    );
  }
  return Object.fromEntries(held.map((name) => [name, "false"]));
}

/** True when `change` is a `action` of a Cloudflare resource. */
function cloudflare(change: ResourceChange, action: ResourceChange["action"]): boolean {
  return change.action === action && cloudflareAddressScope(change.address) !== undefined;
}

/**
 * Plans B's pieces of `root` in its shadow state, seeded first (`seedShadow`, which also finishes a
 * seeding that stopped half-way): the committed root module with B's token, B's ids as `-var`s
 * (`root.vars`, with the Access applications and the records they protect held back while B's zone
 * is pending) and the shadow data folder, allowed only to create Cloudflare resources; anything
 * else stops before the approval with the plan's lines.
 */
export async function planShadow(session: MoveSession, root: ShadowRoot): Promise<PlanStep> {
  const what = rootWords(session, root);
  const b = accountName(session.accounts.b);
  const held = await heldBackWhilePending(session, root);
  await seedShadow(session, root);
  return shadowPlanStep(session, root, {
    action: "shadow-create",
    statePath: root.statePath,
    env: await shadowEngineEnv(session, root, "b", root.dataDir),
    vars: { ...root.vars, ...held },
    check: planBounded({
      lead: `The plan of ${what} in the Cloudflare account ${b} would do more than create them there, so OpsCrew stopped. Nothing was changed.`,
      change: (change) => cloudflare(change, "create"),
      hint: `Run \`opscrew drift\` to see what differs between the app's files and what runs, put that right, then run \`${session.command}\` again.`,
    }),
    title: `Create ${what} in the Cloudflare account ${b} (nothing changes in the account that holds ${session.zone} now)`,
  });
}

/**
 * The check plan once `root`'s states are swapped and its `terraform.tfvars.json` patched: the
 * environment's own state and data folder with B's token and no `-var`. No change needs no
 * approval; in-place updates of Cloudflare resources are shown and approved by hash; anything else
 * stops before the approval.
 */
export async function checkAfterSwap(session: MoveSession, root: ShadowRoot): Promise<PlanStep> {
  const what = rootWords(session, root);
  const b = accountName(session.accounts.b);
  return shadowPlanStep(session, root, {
    action: "swap-check",
    statePath: shadowFiles(root).environmentState,
    env: await shadowEngineEnv(session, root, "b"),
    check: planBounded({
      lead: `Now that the infrastructure state of ${what} is the Cloudflare account ${b}'s, its plan would do more than update Cloudflare pieces in place, so OpsCrew stopped. Nothing was changed.`,
      change: (change) => cloudflare(change, "update"),
      hint: `Run \`opscrew drift\` to see what differs between the app's files and what runs, put that right, then run \`${session.command}\` again.`,
    }),
    title: `Update ${what} in place in the Cloudflare account ${b}`,
  });
}

/**
 * The check plan of `root`'s shadow state once the finish imported what the switch made in B (a
 * site's custom domains, the Access applications and their records): the shadow state and data
 * folder with B's token and `root.vars` (the committed values, nothing held back). It must be
 * empty: no change needs no approval, and any change stops before one.
 */
export async function checkAdoption(session: MoveSession, root: ShadowRoot): Promise<PlanStep> {
  const what = rootWords(session, root);
  const b = accountName(session.accounts.b);
  return shadowPlanStep(session, root, {
    action: "site-adopt",
    statePath: root.statePath,
    env: await shadowEngineEnv(session, root, "b", root.dataDir),
    vars: root.vars,
    check: planBounded({
      lead: `Once the custom domains and Access pieces are imported, the plan of ${what} in the Cloudflare account ${b} would still change something, so OpsCrew stopped. Nothing was changed.`,
      hint: `Run \`opscrew drift\` to see what differs between the app's files and what runs, put that right, then run \`${session.command}\` again.`,
    }),
    title: `Check ${what} in the Cloudflare account ${b}`,
  });
}

/**
 * The destroy plan of `side`'s pieces of `root` (after `prepareRemoval`): with A's token, A's ids
 * and A's removal state and data folder, only A's account-scoped pieces; with B's, from the shadow
 * state, every piece B has of the app. Its approval needs the app's name typed (`allowDestroy`).
 * Nothing to plan without a state.
 */
export async function planRemoval(
  session: MoveSession,
  root: ShadowRoot,
  side: MoveSide,
): Promise<PlanStep> {
  const { statePath, dataDir } = removalTarget(root, side);
  if (!(await hasStateFile(statePath))) return { kind: "unchanged", outputs: {} };
  const what = rootWords(session, root);
  const { a, b } = session.accounts;
  const account = accountName(side === "a" ? a : b);
  const vars =
    side === "a"
      ? await accountIds(session, "a", await committedValues(session, root.dir))
      : root.vars;
  return shadowPlanStep(session, root, {
    action: side === "a" ? "a-removal" : "abort-shadow",
    ...(side === "a" ? { tokenVar: A_TOKEN_VAR } : {}),
    statePath,
    env: await shadowEngineEnv(session, root, side, dataDir),
    vars,
    destroy: true,
    check: planBounded({
      lead:
        side === "a"
          ? `The removal of ${what} in the Cloudflare account ${account} would do more than delete its pieces that stay in that account, so OpsCrew stopped. Nothing was changed.`
          : `The removal of ${what} in the Cloudflare account ${account} would do more than delete its pieces there, so OpsCrew stopped. Nothing was changed.`,
      change: (change) =>
        change.action === "delete" && removedBy(side, cloudflareAddressScope(change.address)),
      hint: `Run \`${session.command}\` again: it prepares the state for the removal first.`,
    }),
    title: `Delete ${what} in the Cloudflare account ${account}`,
  });
}
