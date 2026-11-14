/**
 * The shadow states of a move to another Cloudflare account (plan 3., data model 3): each covered
 * environment's roots that hold Cloudflare resources, planned in B from the same committed root
 * modules, with B's ids as `-var`s, B's token, and a state and a data folder of their own under the
 * environment's `cloudflare-move/`. A's states and the committed files don't change before the
 * finish, which swaps each shadow state in for the environment's, patches the id keys of the
 * root's `terraform.tfvars.json` and keeps A's former state under `cloudflare-move/a-removal/` for
 * the removal of A's account-scoped pieces. The plans are in `shadow-plans.ts`.
 */
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  exists,
  OpsCrewError,
  type ProjectPaths,
  renameWithRetry,
  tfstateFile,
  toPosixRelative,
  writeFileAtomic,
} from "@opscrew/core";
import {
  accountVariables,
  backupsRootDir,
  type CloudflareAddressScope,
  cloudflareAddressScope,
  pagesVerificationRootDir,
  providerBucket,
  storageRootDir,
} from "@opscrew/iac-templates";
import { backupsBucketOf } from "@opscrew/plan-schema";
import { z } from "zod";
import {
  backupsStateFile,
  pagesVerificationStateFile,
  projectEngine,
  readOutputsAfterInit,
  readValidJson,
  stateContents,
  storageStateFile,
} from "../shared";
import { rootVariables } from "../shared/root-variables";
import type { MoveRoot } from "./progress";
import { A_TOKEN_VAR, B_TOKEN_VAR, MOVE_COMMAND, refusal } from "./texts";
import type { MoveEnvironment, MoveSession, ShadowRoot } from "./types";

/** Whose pieces: A's (the account that holds the zone when the move starts) or B's. */
export type ShadowSide = "a" | "b";

const BUG = "This is a bug in OpsCrew; please report it.";

/** The environment's state of each root, in its `tfstate/` folder; a shadow state has its name. */
const ENVIRONMENT_STATES: Readonly<Record<MoveRoot, (paths: ProjectPaths) => string>> = {
  main: tfstateFile,
  storage: storageStateFile,
  backups: backupsStateFile,
  "pages-verification": pagesVerificationStateFile,
};

/** The variable of the id of the account's one-time PIN login, which only some roots have. */
const PIN_VARIABLE = "one_time_pin_identity_provider_id";

/** The covered environment `root` belongs to. */
export function environmentOf(session: MoveSession, root: ShadowRoot): MoveEnvironment {
  const found = session.environments.find((env) => env.environment === root.environment);
  if (found !== undefined) return found;
  throw new OpsCrewError(
    "INTERNAL",
    `The move of ${session.zone} doesn't cover the environment ${root.environment}.`,
    { hint: BUG },
  );
}

/**
 * The files beside a shadow root's own: the environment's state it stands in for (`tfstate/` of
 * the environment's state folder, the same name), and A's removal state and data folder under
 * `cloudflare-move/a-removal/`, where the environment's state goes at the swap.
 */
export function shadowFiles(root: ShadowRoot): {
  environmentState: string;
  removalState: string;
  removalDataDir: string;
} {
  const folder = dirname(dirname(root.statePath));
  const name = basename(root.statePath);
  return {
    environmentState: join(dirname(folder), "tfstate", name),
    removalState: join(folder, "a-removal", "tfstate", name),
    removalDataDir: join(folder, "a-removal", "tf", basename(root.dataDir)),
  };
}

/** The state and data folder a side's removal works on: A's former state, or B's shadow state. */
export function removalTarget(
  root: ShadowRoot,
  side: ShadowSide,
): { statePath: string; dataDir: string } {
  if (side === "b") return { statePath: root.statePath, dataDir: root.dataDir };
  const { removalState, removalDataDir } = shadowFiles(root);
  return { statePath: removalState, dataDir: removalDataDir };
}

/**
 * Whether a side's removal deletes a resource of `scope`: A's only its account-scoped pieces (its
 * zone-scoped ones go with A's moved zone, which Cloudflare deletes), B's every Cloudflare piece
 * (B's zone may stay for other apps). Nothing that isn't Cloudflare's.
 */
export function removedBy(side: ShadowSide, scope: CloudflareAddressScope | undefined): boolean {
  return side === "a" ? scope === "account" : scope !== undefined;
}

/** True when `file` exists and is not empty. */
export async function hasContent(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * The mark of a seeding under way: while it is there, the shadow state is a copy of A's state with
 * nothing of B's in it.
 */
function seedingMark(root: ShadowRoot): string {
  return `${root.statePath}.seeding`;
}

/** The root's `terraform.tfvars.json`. */
export function tfvarsFile(dir: string): string {
  return join(dir, "terraform.tfvars.json");
}

/** The root's committed `terraform.tfvars.json`; stops plainly when it is missing or damaged. */
export async function committedValues(
  session: MoveSession,
  dir: string,
): Promise<Record<string, unknown>> {
  const values = await readValidJson(tfvarsFile(dir), z.record(z.string(), z.unknown()));
  if (values !== undefined) return values;
  const file = toPosixRelative(session.paths.root, tfvarsFile(dir));
  throw refusal(
    `${file} is missing or damaged, so OpsCrew can't tell which Cloudflare ids the app's pieces have.`,
    `Restore it from Git, then run \`${session.command}\` again.`,
  );
}

/**
 * The Cloudflare ids among the root's variables (`values`, its `terraform.tfvars.json`), with
 * `side`'s values (`accountVariables`): its zone's and account's ids and, when the root has the
 * variable, the id of the account's one-time PIN login, read with that side's client (a refusal
 * when the account has none: B's shared plan makes it).
 */
export async function accountIds(
  session: MoveSession,
  side: ShadowSide,
  values: Readonly<Record<string, unknown>>,
): Promise<Record<string, string>> {
  const { a, b } = session.accounts;
  const account =
    side === "a"
      ? { client: a.client, accountId: a.accountId, zoneId: a.zoneId }
      : { client: b.client, accountId: b.accountId, zoneId: b.setup?.zoneId };
  const { client, accountId, zoneId } = account;
  if (zoneId === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      `${session.zone} isn't in the Cloudflare account ${accountId} yet, so the app's pieces can't be planned there.`,
      { hint: BUG },
    );
  }
  if (!(PIN_VARIABLE in values))
    return accountVariables(values, { cloudflare: { zoneId, accountId } });
  const providers = await client.accessIdentityProviders(accountId);
  const pin = providers.find((one) => one.type === "onetimepin")?.id;
  if (pin === undefined) {
    const name = (side === "a" ? a.name : b.name) ?? accountId;
    throw refusal(
      `The app's Access in the Cloudflare account ${name} logs in with a one-time PIN, but the account's one-time PIN login is missing; preparing again makes it.`,
      session.command === MOVE_COMMAND
        ? `Run \`${MOVE_COMMAND}\` again.`
        : `Run \`${MOVE_COMMAND}\` first, then run \`${session.command}\` again.`,
    );
  }
  return accountVariables(values, {
    cloudflare: { zoneId, accountId, oneTimePinIdentityProviderId: pin },
  });
}

/**
 * The roots of `environment` that hold Cloudflare resources (plan 3.), each with its shadow state
 * under the environment's `cloudflare-move/tfstate/` (named as the environment's state), its data
 * folder under `cloudflare-move/tf/<root folder>/` and B's ids as `vars` (`accountVariables` with
 * B's setup): the main root (`plan.infra.dir`), `storage` and `backups` when their bucket is on R2,
 * and GitHub's verification record once provision made it. A Workers site's root also gets
 * `custom_domains = false`: the switch attaches its custom domains in B.
 */
export async function shadowRoots(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<ShadowRoot[]> {
  const { plan, paths } = environment;
  const dirs: [MoveRoot, string][] = [["main", plan.infra.dir]];
  if (providerBucket(plan)?.provider === "r2") dirs.push(["storage", storageRootDir(plan)]);
  if (backupsBucketOf(plan)?.provider === "r2") dirs.push(["backups", backupsRootDir(plan)]);
  if (
    plan.target.provider === "github-pages" &&
    (await exists(pagesVerificationStateFile(paths)))
  ) {
    dirs.push(["pages-verification", pagesVerificationRootDir(plan)]);
  }
  const folder = join(paths.stateDir, "cloudflare-move");
  const roots: ShadowRoot[] = [];
  for (const [name, relative] of dirs) {
    const dir = join(session.paths.root, relative);
    const ids = await accountIds(session, "b", await committedValues(session, dir));
    const site = name === "main" && plan.target.provider === "cloudflare-workers";
    roots.push({
      environment: environment.environment,
      name,
      dir,
      statePath: join(folder, "tfstate", basename(ENVIRONMENT_STATES[name](paths))),
      dataDir: join(folder, "tf", basename(dir)),
      vars: { ...ids, ...(site ? { custom_domains: "false" } : {}) },
    });
  }
  return roots;
}

/**
 * The engine's environment for `root`'s environment and `side`: the phase's, with that
 * environment's own `TF_ENCRYPTION` (its passphrase and key name, as `existingStateEngine` reads
 * them) and the root's variables from OpsCrew's local records (`rootVariables`: an own server's or
 * Portainer's address), `side`'s token as `CLOUDFLARE_API_TOKEN` (B's token under no other name)
 * and `TF_DATA_DIR` when `dataDir` is given. Never logged.
 */
export async function shadowEngineEnv(
  session: MoveSession,
  root: ShadowRoot,
  side: ShadowSide,
  dataDir?: string,
): Promise<Record<string, string | undefined>> {
  const environment = environmentOf(session, root);
  const deps = { ...session.deps, paths: environment.paths };
  const setup = await projectEngine(deps, environment.plan, {
    preference: session.engine.info.name,
    services: { engine: async () => session.engine },
    passphrase: { requiredBy: session.command },
  });
  await rootVariables(deps, environment.plan, setup, session.command);
  const { [B_TOKEN_VAR]: _b, ...rest } = setup.env;
  return {
    ...rest,
    CLOUDFLARE_API_TOKEN: session.deps.env[side === "a" ? A_TOKEN_VAR : B_TOKEN_VAR]?.trim(),
    ...(dataDir === undefined ? {} : { TF_DATA_DIR: dataDir }),
  };
}

/** Records in the audit log a state-only change of the move (`state rm`, `import`). */
function auditState(
  session: MoveSession,
  root: ShadowRoot,
  action: string,
  detail: string,
): Promise<void> {
  return session.deps.audit.append({
    kind: "iac",
    actor: "opscrew",
    action,
    phase: "cloudflare-move",
    target: `${root.environment} ${root.name} root`,
    detail,
  });
}

/**
 * Takes every resource `leaves` names out of the state `statePath`, initialised in the data folder
 * `env` names: a state-only change, nothing in either account changes.
 */
async function removeFromState(
  session: MoveSession,
  root: ShadowRoot,
  target: { statePath: string; env: Record<string, string | undefined> },
  leaves: (scope: CloudflareAddressScope | undefined) => boolean,
  detail: string,
): Promise<void> {
  const { engine } = session;
  const { statePath, env } = target;
  await engine.init(root.dir, { env, backendConfig: { path: statePath } });
  // `state list` runs outside the root, where a data folder of the root's would ask for its init.
  const { TF_DATA_DIR: _data, ...outside } = env;
  const addresses = (await engine.stateResources(statePath, { env: outside })).filter((address) =>
    leaves(cloudflareAddressScope(address)),
  );
  if (addresses.length === 0) return;
  await engine.stateRemove(root.dir, addresses, { env });
  await auditState(session, root, "state rm", `${detail}: ${addresses.join(", ")}`);
}

/**
 * Seeds `root`'s shadow state: a copy of the environment's state with every Cloudflare address
 * taken out (`stateRemove` against the shadow backend), so B's plan sees the server, network and
 * firewall resources as they are and plans only B's pieces; a Cloudflare-only root ends up empty.
 * Without an environment state there is nothing to copy, and B's plan starts from none. A seeded
 * state is kept; a seeding that stopped half-way (its `.seeding` mark left) is done again.
 */
export async function seedShadow(session: MoveSession, root: ShadowRoot): Promise<void> {
  const mark = seedingMark(root);
  if ((await exists(root.statePath)) && !(await exists(mark))) return;
  const { environmentState } = shadowFiles(root);
  if (!(await hasContent(environmentState))) return;
  await mkdir(dirname(root.statePath), { recursive: true });
  await writeFile(mark, "");
  await copyFile(environmentState, root.statePath);
  const env = await shadowEngineEnv(session, root, "b", root.dataDir);
  await removeFromState(
    session,
    root,
    { statePath: root.statePath, env },
    (scope) => scope !== undefined,
    "left out of the copy for the new Cloudflare account",
  );
  await rm(mark);
}

/**
 * The root-module outputs of `root`'s shadow state (B's tunnel token, B's deploy service token, the
 * webhook's Access client), read with `readOutputsAfterInit` against the shadow backend. They may
 * hold secrets: the caller registers them with the redactor.
 */
export async function shadowOutputs(
  session: MoveSession,
  root: ShadowRoot,
): Promise<Record<string, unknown>> {
  const env = await shadowEngineEnv(session, root, "b", root.dataDir);
  return readOutputsAfterInit(session.engine, root.dir, root.statePath, env);
}

/**
 * Records the existing object `id` at `address` in `root`'s shadow state (`importResource`, state
 * only), with B's token and ids and the root's committed `custom_domains`: a Workers site's custom
 * domains, which the switch attached in B, exist in its configuration only then.
 */
export async function importIntoShadow(
  session: MoveSession,
  root: ShadowRoot,
  address: string,
  id: string,
): Promise<void> {
  const env = await shadowEngineEnv(session, root, "b", root.dataDir);
  const { custom_domains: _committed, ...vars } = root.vars;
  await session.engine.init(root.dir, { env, backendConfig: { path: root.statePath } });
  await session.engine.importResource(root.dir, address, id, { env, vars });
  await auditState(session, root, "import", `${address} (id ${id}) into the new account's state`);
}

/**
 * Swaps `root`'s shadow state in for the environment's, in two renames: the environment's state to
 * `a-removal/tfstate/` (when there is one), then the shadow state to the environment's. A run that
 * stopped between them finds from the files present where it was: with no shadow state left the
 * swap is done. Never writes over a state already in `a-removal/`.
 */
export async function swapShadow(root: ShadowRoot): Promise<void> {
  if (!(await exists(root.statePath))) return;
  const { environmentState, removalState } = shadowFiles(root);
  if (await exists(environmentState)) {
    if (await exists(removalState)) {
      throw new OpsCrewError(
        "INTERNAL",
        `Both the infrastructure state ${basename(environmentState)} and the former one kept for the removal of the old account's pieces exist, so OpsCrew can't swap the new account's state in. Nothing was changed.`,
        { hint: BUG },
      );
    }
    await mkdir(dirname(removalState), { recursive: true });
    await renameWithRetry(environmentState, removalState);
  }
  await renameWithRetry(root.statePath, environmentState);
}

/**
 * Gives the id keys of `root`'s committed `terraform.tfvars.json` B's values (those of
 * `accountVariables` in `root.vars`, not `custom_domains`), leaving the file otherwise byte for
 * byte the same. Returns whether it changed.
 */
export async function patchTfvars(root: ShadowRoot): Promise<boolean> {
  const file = tfvarsFile(root.dir);
  const text = await readFile(file, "utf8");
  const { custom_domains: _site, ...ids } = root.vars;
  let patched = text;
  for (const [name, value] of Object.entries(ids)) {
    const key = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`);
    patched = patched.replace(key, (_match, before: string) => `${before}${JSON.stringify(value)}`);
  }
  const after = JSON.parse(patched) as Record<string, unknown>;
  if (Object.entries(ids).some(([name, value]) => after[name] !== value)) {
    throw new OpsCrewError(
      "INTERNAL",
      `OpsCrew couldn't give the Cloudflare ids in ${basename(root.dir)}/terraform.tfvars.json the new account's values. Nothing was changed.`,
      { hint: BUG },
    );
  }
  if (patched === text) return false;
  await writeFileAtomic(file, patched, { mode: 0o644 });
  return true;
}

/**
 * Prepares `side`'s state of `root` for its destroy plan: from A's former state every address that
 * is not Cloudflare's or is zone-scoped is taken out (A's records go with its moved zone, and the
 * server stays), from B's shadow state every address that is not Cloudflare's (the copied server
 * resources). State only; nothing without a state. A shadow state whose seeding stopped half-way
 * holds only A's copy and nothing of B's: it is deleted with its mark, and nothing is planned.
 */
export async function prepareRemoval(
  session: MoveSession,
  root: ShadowRoot,
  side: ShadowSide,
): Promise<void> {
  const { statePath, dataDir } = removalTarget(root, side);
  if (side === "b" && (await exists(seedingMark(root)))) {
    await rm(statePath, { force: true });
    await rm(seedingMark(root));
    return;
  }
  if (!(await hasContent(statePath))) return;
  const env = await shadowEngineEnv(session, root, side, dataDir);
  await removeFromState(
    session,
    root,
    { statePath, env },
    (scope) => !removedBy(side, scope),
    side === "a"
      ? "kept out of the removal in the old Cloudflare account"
      : "kept out of the removal in the new Cloudflare account",
  );
}

/**
 * Deletes `root`'s files of the move: its shadow state, A's former state and their data folders.
 * Refuses, deleting nothing, while either state holds resources (or can't be read): the pieces in
 * it would be left without a state.
 */
export async function dropShadow(session: MoveSession, root: ShadowRoot): Promise<void> {
  const environment = environmentOf(session, root);
  const deps = { ...session.deps, paths: environment.paths };
  const { removalState, removalDataDir } = shadowFiles(root);
  for (const state of [root.statePath, removalState]) {
    if ((await stateContents(deps, state, async () => session.engine)) === "nothing") continue;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${toPosixRelative(session.paths.root, state)} still holds pieces of ${environment.plan.app.name} OpsCrew hasn't removed, or can't be read, so OpsCrew keeps it. Nothing was deleted.`,
      { hint: `Run \`${session.command}\` again: it plans their removal first.` },
    );
  }
  for (const path of [
    root.statePath,
    `${root.statePath}.backup`,
    seedingMark(root),
    root.dataDir,
    removalState,
    `${removalState}.backup`,
    removalDataDir,
  ]) {
    await rm(path, { recursive: true, force: true });
  }
}
