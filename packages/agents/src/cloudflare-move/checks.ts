/**
 * The refusals of a move to another Cloudflare account before any change (the spec's edge cases),
 * and the other OpsCrew apps found in A's zone.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AccountPermissionNeed,
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  type CloudflareDnsRecord,
  OPSCREW_MANAGED_COMMENT,
} from "@opscrew/connector-cloudflare";
import { listText, type ProjectPaths } from "@opscrew/core";
import { isMoveReady, opscrewRecordNames, tunnelMode, usesTunnel } from "@opscrew/iac-templates";
import { type DeployPlan, previewEnvironmentOf, snapshotOffsiteOf } from "@opscrew/plan-schema";
import { UPDATER_RECORD_COMMENT } from "../home/records";
import { portainerCloudflare } from "../provision/credentials";
import { planWhere } from "../runners/words";
import { hasState, stateCopyPaths, stateNotHere } from "../shared";
import { otherAppMoves, readMoveRecords } from "./record";
import {
  A_TOKEN_VAR,
  ABORT_COMMAND,
  accountName,
  B_TOKEN_VAR,
  MOVE_COMMAND,
  refusal,
} from "./texts";
import type { MoveEnvironment, MoveSession } from "./types";

/**
 * Stops when the app has a preview environment: previews per pull request don't move with it
 * (their zone and certificate are set up again by turning them on after the move).
 */
export async function requireNoPreviews(paths: ProjectPaths): Promise<void> {
  const preview = await previewEnvironmentOf(paths.root, paths.app);
  if (preview === undefined) return;
  throw refusal(
    `The app has previews per pull request (the environment ${preview}), which don't move to another Cloudflare account.`,
    `Turn previews off first (\`opscrew destroy --env ${preview}\`, then \`opscrew env remove ${preview}\`), move the app, then turn them on again.`,
  );
}

/** Stops while an environment of the app moves to another server (`opscrew retarget`). */
export async function requireNoRetarget(
  paths: ProjectPaths,
  environments: readonly MoveEnvironment[],
): Promise<void> {
  const moving = environments.find((env) => env.plan.retarget !== undefined);
  if (moving === undefined) return;
  const { flag } = await planWhere(paths.root, moving.plan);
  throw refusal(
    `${moving.plan.app.name} is moving to another server, and a move to another Cloudflare account waits until that move is finished or aborted.`,
    `Run \`opscrew retarget${flag}\` to the end (or \`opscrew retarget --abort${flag}\`), then start this move again.`,
  );
}

/**
 * Every check of the move's start that reads Cloudflare or the repository, before any change: each
 * covered environment's infrastructure state on this computer, A's zone active and without a zone
 * hold, no other app of the repository moving the zone to another account, B's account permissions
 * for the app's pieces, and committed files the move can use.
 */
export async function checkMoveStart(session: MoveSession): Promise<void> {
  await requireStates(session);
  await requireActiveZone(session);
  await requireNoOtherMove(session);
  await requireAccountPermissions(session);
  await requireMoveReady(session);
}

/** Stops unless every covered environment's infrastructure state is on this computer. */
async function requireStates(session: MoveSession): Promise<void> {
  for (const env of session.environments) {
    if (await hasState(env.paths)) continue;
    const { folder, passphrase } = stateCopyPaths(env.plan);
    const { flag } = await planWhere(session.paths.root, env.plan);
    throw stateNotHere(
      env.plan,
      "move it to another Cloudflare account",
      `Run OpsCrew on the computer that ran \`opscrew provision${flag}\`, or copy its ${folder} folder (and, with OpenTofu, the state passphrase from ${passphrase}) here, then try again.`,
    );
  }
}

/** Stops unless A's zone is active and has no zone hold. */
async function requireActiveZone(session: MoveSession): Promise<void> {
  const { zone } = session;
  const { a } = session.accounts;
  const status = a.zone?.status;
  if (status === "moved") {
    throw refusal(
      `${zone} has moved to another Cloudflare account already.`,
      `Set ${A_TOKEN_VAR} to the token of the account that holds ${zone} now, then start the move again.`,
    );
  }
  if (status !== "active") {
    throw refusal(
      `${zone} is ${status ?? "gone"} in the account ${a.accountId}, and only an active zone moves to another account.`,
      `Wait until the Cloudflare dashboard shows ${zone} as Active, then start the move again.`,
    );
  }
  if ((await a.client.zoneHold(a.zoneId)).hold) {
    throw refusal(
      `${zone} has a zone hold, which keeps it from being added to another account.`,
      `Release the hold in the Cloudflare dashboard (the zone's Overview, Zone Hold), then start the move again.`,
    );
  }
}

/** Stops when another app of the repository moves the same zone to another account. */
async function requireNoOtherMove(session: MoveSession): Promise<void> {
  const { zone } = session;
  const b = session.accounts.b.accountId;
  const other = (await otherAppMoves(session.paths)).find(
    ({ move }) => move.zone === zone && move.to.accountId !== b,
  );
  if (other === undefined) return;
  const to = other.move.to.accountId;
  const flag = other.key === undefined ? "" : ` --app ${other.key}`;
  throw refusal(
    `Another app of this repository is moving ${zone} to the Cloudflare account ${to}, and a zone moves to one account.`,
    `Move this app to that account too (\`${MOVE_COMMAND} --to ${to}\`), or abort that move first (\`${ABORT_COMMAND}${flag}\`).`,
  );
}

/** The account-scoped Cloudflare pieces of a plan, which B's token needs permissions for. */
export interface AccountPieces {
  /** A Cloudflare Tunnel: tunnel mode, Portainer or Beszel on a subdomain, a Portainer tunnel. */
  tunnel: boolean;
  /** Access applications and the Zero Trust organization: SSH, the subdomains, the webhook. */
  access: boolean;
  /** Access service tokens: the deploy's SSH in tunnel mode, Portainer's webhook. */
  serviceTokens: boolean;
  /** The app's bucket on R2. */
  storage: boolean;
  /** The snapshots' copies on R2. */
  backups: boolean;
  /** A site's Worker. */
  worker: boolean;
}

/** {@link AccountPieces} of `plan`. */
export function accountPieces(plan: DeployPlan): AccountPieces {
  const portainer = portainerCloudflare(plan);
  const webhook = portainer?.webhook === true;
  return {
    tunnel: usesTunnel(plan) || portainer?.appTunnel === true || webhook,
    access: usesTunnel(plan) || webhook,
    serviceTokens: tunnelMode(plan) || webhook,
    storage: plan.storage?.objectStorage?.provider === "r2",
    backups: snapshotOffsiteOf(plan)?.provider === "r2",
    worker: plan.target.provider === "cloudflare-workers",
  };
}

/** The account permissions B's token needs for `plan`'s pieces (only those). */
export function accountNeeds(plan: DeployPlan): AccountPermissionNeed[] {
  const pieces = accountPieces(plan);
  const needs: [boolean, AccountPermissionNeed[]][] = [
    [pieces.tunnel, ["tunnel"]],
    [pieces.access, ["access-apps", "access-organization"]],
    [pieces.serviceTokens, ["access-service-tokens"]],
    [pieces.storage || pieces.backups, ["r2"]],
    [pieces.worker, ["workers"]],
  ];
  return needs.flatMap(([needed, names]) => (needed ? names : []));
}

/** Stops naming each account permission B's token lacks for the app's pieces. */
async function requireAccountPermissions(session: MoveSession): Promise<void> {
  const needs = [...new Set(session.environments.flatMap((env) => accountNeeds(env.plan)))];
  if (needs.length === 0) return;
  const { b } = session.accounts;
  const { missing } = await b.client.accountPermissions(b.accountId, needs);
  if (missing.length === 0) return;
  throw refusal(
    `${B_TOKEN_VAR} lacks ${listText(missing)} for the account ${accountName(b)}, which the app's pieces need there.`,
    `Add ${missing.length === 1 ? "it" : "them"} to the token at ${CLOUDFLARE_TOKEN_PAGE}, then run \`${session.command}\` again.`,
    "CREDENTIALS_INVALID",
  );
}

/** Stops when an environment's committed files can't deploy to both accounts yet (`isMoveReady`). */
async function requireMoveReady(session: MoveSession): Promise<void> {
  const { root } = session.paths;
  const read = (path: string) => readFile(join(root, path), "utf8").catch(() => undefined);
  const stale: string[] = [];
  for (const env of session.environments) {
    if (!(await isMoveReady(env.plan, read))) {
      stale.push(`\`opscrew provision${(await planWhere(root, env.plan)).flag}\``);
    }
  }
  if (stale.length === 0) return;
  throw refusal(
    "The app's files come from an earlier version of OpsCrew, which can't deploy to two Cloudflare accounts during a move.",
    `Run ${listText(stale)} to bring the app's files up to date and commit them, then start the move.`,
  );
}

/** OpsCrew's names in a zone ({@link opscrewNamesInZone}). */
export interface OpscrewZoneNames {
  /** The zone's records with OpsCrew's comment, or its address updater's. */
  records: CloudflareDnsRecord[];
  /** The hostnames of the account's Workers custom domains in the zone. */
  domains: string[];
  /** False when the token may not read the account's Workers: `domains` is then empty. */
  workers: boolean;
}

/** The comments of OpsCrew's records: its roots', and the address updater's on a server at home. */
const OPSCREW_COMMENTS: ReadonlySet<string> = new Set([
  OPSCREW_MANAGED_COMMENT,
  UPDATER_RECORD_COMMENT,
]);

/**
 * OpsCrew's names in a zone, read-only: its records (by their comment, OpsCrew's or its address
 * updater's; of `listed`, the zone's records read just before, when given) and the account's
 * Workers custom domains in it, unless the token may not read the account's Workers.
 */
export async function opscrewNamesInZone(
  client: CloudflareClient,
  accountId: string,
  zoneId: string,
  listed?: readonly CloudflareDnsRecord[],
): Promise<OpscrewZoneNames> {
  const records = (listed ?? (await client.listDnsRecords(zoneId))).filter((record) =>
    OPSCREW_COMMENTS.has(record.comment?.trim() ?? ""),
  );
  const workers = (await client.workersPermissions(accountId)).missing.length === 0;
  const domains = workers
    ? (await client.listZoneWorkerDomains(accountId, zoneId)).map((domain) => domain.hostname)
    : [];
  return { records, domains, workers };
}

/**
 * The hostnames of the other OpsCrew apps in A's zone, sorted, read while A's zone is active (none
 * otherwise): OpsCrew's names there (its records with OpsCrew's comment or its address updater's,
 * and its Workers custom domains) that none of the app's environments in the zone (covered or
 * skipped) gives a record or a custom domain, and none of the `_`-named records (verification
 * records, not hostnames). Read-only.
 */
export async function otherAppHostnames(session: MoveSession): Promise<string[]> {
  const { zone } = session;
  const { a } = session.accounts;
  if (a.zone?.status !== "active") return [];
  const skipped = (await readMoveRecords(session.paths)).filter((env) =>
    session.skipped.includes(env.environment),
  );
  const environments = [...session.environments, ...skipped];
  const own = new Set(environments.flatMap((env) => opscrewRecordNames(env.plan, zone)));
  const { records, domains } = await opscrewNamesInZone(a.client, a.accountId, a.zoneId);
  return [...new Set([...records.map((record) => record.name), ...domains])]
    .sort()
    .filter((name) => !own.has(name) && !name.split(".").some((label) => label.startsWith("_")));
}
