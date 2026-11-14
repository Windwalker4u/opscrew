/**
 * The session of a move to another Cloudflare account: the app's environments the move covers,
 * both accounts reached with their own tokens, GitHub and the engine, all checked before any change.
 */
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareClient,
  cloudflareConnector,
} from "@opscrew/connector-cloudflare";
import { errorMessage, OpsCrewError } from "@opscrew/core";
import { type CloudflareMove, type DeployPlan, environmentsOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { resolveAccount } from "../domain/common";
import { environmentDeployed } from "../environments/list";
import { type CloudflareSetup, setupCloudflare, setupGitHub } from "../provision";
import { existingStateEngine, githubClientFromToken, requireGitRepo } from "../shared";
import { otherAppHostnames, requireNoPreviews, requireNoRetarget } from "./checks";
import { readMoveRecords } from "./record";
import { A_TOKEN_VAR, B_TOKEN_VAR, MOVE_COMMAND, refusal } from "./texts";
import type {
  MoveAccount,
  MoveAccounts,
  MoveCommandOptions,
  MoveEnvironment,
  MoveServices,
  MoveSession,
  MoveZone,
  StayingEnvironment,
} from "./types";

export interface OpenMoveSessionOptions extends MoveCommandOptions {
  /** The command that continues after a stop. */
  command: string;
  /** `--to`: B's id or exact name; without it the recorded move's account. */
  to?: string;
}

/** `variable`'s token, registered with the redactor; stops when it is not set. */
function requireToken(deps: PhaseDeps, variable: string, why: string, hint: string): string {
  const token = deps.env[variable]?.trim();
  if (!token) throw refusal(`${variable} is not set: ${why}.`, hint, "CREDENTIALS_MISSING");
  deps.redactor.addLiteral(token, variable);
  return token;
}

/** A client with `token` (the injected one when given); stops when Cloudflare refuses the token. */
async function verifiedClient(
  deps: PhaseDeps,
  services: MoveServices,
  token: string,
  injected: CloudflareClient | undefined,
  variable: string,
  command: string,
): Promise<CloudflareClient> {
  const client =
    injected ??
    (cloudflareConnector({
      env: { CLOUDFLARE_API_TOKEN: token },
      fetch: deps.fetch,
      redactor: deps.redactor,
      version: deps.version,
      ...(services.sleep ? { sleep: services.sleep } : {}),
    }).client as CloudflareClient);
  const check = await client.verifyToken();
  if (!check.ok) {
    throw refusal(
      deps.redactor.redact(`${variable} does not work: ${check.message}`),
      `Create a working token at ${CLOUDFLARE_TOKEN_PAGE}, set ${variable} to it, then run \`${command}\` again.`,
      "CREDENTIALS_INVALID",
    );
  }
  return client;
}

/**
 * The zone the environment's domain is in, in `accountId`: the one A's token finds there for
 * `dns.zone` when the plan names it (that zone only), else for `dns.domain`; `undefined` off
 * Cloudflare or when the account has none.
 */
async function zoneOf(
  plan: DeployPlan,
  a: CloudflareClient,
  accountId: string,
): Promise<MoveZone | undefined> {
  const { dns } = plan;
  if (dns.provider !== "cloudflare" || dns.domain === undefined) return undefined;
  const found = await a.findZone(dns.zone ?? dns.domain, { accountId });
  if (found === undefined || (dns.zone !== undefined && found.name !== dns.zone)) return undefined;
  return { ...found, accountId };
}

/** The zone of the plan's domain in the first of `accounts` that has one, an active one first. */
async function zoneInAccounts(
  plan: DeployPlan,
  a: CloudflareClient,
  accounts: readonly string[],
): Promise<MoveZone | undefined> {
  let found: MoveZone | undefined;
  for (const accountId of accounts) {
    const zone = await zoneOf(plan, a, accountId);
    if (zone !== undefined && (found === undefined || zone.status === "active")) found = zone;
    if (found?.status === "active") break;
  }
  return found;
}

/** The zone named `zone` in `accountId`, when the account has it. */
async function zoneIn(
  client: CloudflareClient,
  zone: string,
  accountId: string,
): Promise<MoveZone | undefined> {
  const found = await client.findZone(zone, { accountId });
  return found?.name === zone ? found : undefined;
}

/** The app's environments, split by the zone: covered, in the zone but not deployed, staying. */
interface Split {
  zone: string;
  /** A's account and zone. */
  a: { accountId: string; zoneId: string; zone: MoveZone | undefined };
  environments: MoveEnvironment[];
  skipped: MoveEnvironment[];
  staying: StayingEnvironment[];
}

/**
 * The zone that moves (the recorded move's, else the first deployed environment's), A's account
 * and zone (the record's, else the zone's as A's token finds it), and the app's environments split
 * by it.
 */
async function splitEnvironments(
  all: readonly MoveEnvironment[],
  recorded: CloudflareMove | undefined,
  a: CloudflareClient,
  accounts: readonly string[],
): Promise<Split> {
  const deployed = new Map<string, boolean>();
  for (const env of all) {
    deployed.set(env.environment, await environmentDeployed(env.paths, env.plan));
  }
  let start: Split["a"] & { name: string };
  if (recorded !== undefined) {
    const { zone, from } = recorded;
    if (!accounts.includes(from.accountId)) {
      throw refusal(
        `${A_TOKEN_VAR} can't use the Cloudflare account ${from.accountId}, which held ${zone} when the move started.`,
        `Set ${A_TOKEN_VAR} to that account's token, then run \`${MOVE_COMMAND}\` again.`,
        "CREDENTIALS_INVALID",
      );
    }
    start = {
      name: zone,
      accountId: from.accountId,
      zoneId: from.zoneId,
      zone: await zoneIn(a, zone, from.accountId),
    };
  } else {
    const env = all.find(
      (one) => deployed.get(one.environment) && one.plan.dns.provider === "cloudflare",
    );
    if (env?.plan.dns.domain === undefined) throw nothingToMove(all);
    const found = await zoneInAccounts(env.plan, a, accounts);
    if (found?.accountId === undefined) {
      throw refusal(
        `${A_TOKEN_VAR} sees no Cloudflare zone for ${env.plan.dns.domain}, where ${env.plan.app.name} is served.`,
        `Set ${A_TOKEN_VAR} to the token of the account that holds its zone, then start the move again.`,
        "CREDENTIALS_INVALID",
      );
    }
    start = { name: found.name, accountId: found.accountId, zoneId: found.id, zone: found };
  }
  const split: Split = {
    zone: start.name,
    a: { accountId: start.accountId, zoneId: start.zoneId, zone: start.zone },
    environments: [],
    skipped: [],
    staying: [],
  };
  const others = accounts.filter((id) => id !== start.accountId);
  for (const env of all) {
    // A recorded environment is covered without a lookup: A's moved zone is deleted after a week.
    if (env.plan.cloudflareMove?.zone === start.name) {
      split.environments.push(env);
      continue;
    }
    const own = await zoneOf(env.plan, a, start.accountId);
    if (own?.name === start.name) {
      (deployed.get(env.environment) ? split.environments : split.skipped).push(env);
      continue;
    }
    const cloudflare = env.plan.dns.provider === "cloudflare";
    const elsewhere = cloudflare ? (own ?? (await zoneInAccounts(env.plan, a, others))) : undefined;
    const zone = elsewhere?.name ?? env.plan.dns.zone;
    split.staying.push({
      name: env.environment,
      cloudflare,
      ...(zone === undefined ? {} : { zone }),
    });
  }
  return split;
}

/** `{ name }` of the account `id` among `accounts`, when it is there. */
function nameOf(accounts: readonly { id: string; name: string }[], id: string): { name?: string } {
  const found = accounts.find((one) => one.id === id);
  return found === undefined ? {} : { name: found.name };
}

/** The stop when no environment of the app is deployed behind a Cloudflare zone. */
function nothingToMove(all: readonly MoveEnvironment[]): OpsCrewError {
  const name = all[0]?.plan.app.name ?? "The app";
  if (all.some((env) => env.plan.target.provider === "localhost")) {
    return refusal(
      `${name} runs on this computer (the localhost target), which has nothing on Cloudflare to move.`,
      `Run \`${MOVE_COMMAND}\` from the repository of an app deployed behind Cloudflare.`,
    );
  }
  return refusal(
    `${name} has no deployed environment whose domain is in a Cloudflare zone, so there is nothing to move.`,
    "Run `opscrew provision` to deploy the app behind Cloudflare first.",
  );
}

/**
 * B's account: the recorded move's (a different `--to` refused), else `--to` resolved like the
 * domain commands' `--account` among the accounts B's token sees.
 */
async function targetAccount(
  b: CloudflareClient,
  recorded: CloudflareMove | undefined,
  to: string | undefined,
  zone: string,
): Promise<{ id: string; name: string }> {
  const accounts = await b.listAccounts();
  if (accounts.length === 0) {
    throw refusal(
      `${B_TOKEN_VAR} sees no Cloudflare account.`,
      `Create the token in the account ${zone} moves to (${CLOUDFLARE_TOKEN_PAGE}), set ${B_TOKEN_VAR} to it, then run \`${MOVE_COMMAND} --to <account>\` again.`,
      "CREDENTIALS_INVALID",
    );
  }
  let given: { id: string; name: string } | undefined;
  if (to !== undefined) {
    try {
      given = resolveAccount(accounts, to, "--to");
    } catch (error) {
      if (!(error instanceof OpsCrewError)) throw error;
      throw refusal(`${B_TOKEN_VAR}: ${errorMessage(error)}`, error.hint ?? "", error.code);
    }
  }
  if (recorded === undefined) {
    if (given !== undefined) return given;
    throw refusal(
      `Name the Cloudflare account ${zone} moves to.`,
      `Run \`${MOVE_COMMAND} --to <account id or exact name>\`; ${B_TOKEN_VAR} can use ${accounts.map((one) => `${one.name} (${one.id})`).join(", ")}.`,
      "INVALID_INPUT",
    );
  }
  const target = recorded.to.accountId;
  if (given !== undefined && given.id !== target) {
    throw refusal(
      `The move of ${zone} goes to the Cloudflare account ${target}, not to ${given.name} (${given.id}).`,
      `Run \`${MOVE_COMMAND}\` without --to to continue it, or abort it first (\`${MOVE_COMMAND} --abort\`).`,
      "INVALID_INPUT",
    );
  }
  const found = accounts.find((one) => one.id === target);
  if (found === undefined) {
    throw refusal(
      `${B_TOKEN_VAR} can't use the Cloudflare account ${target}, where the move of ${zone} goes.`,
      `Set ${B_TOKEN_VAR} to that account's token, then run \`${MOVE_COMMAND}\` again.`,
      "CREDENTIALS_INVALID",
    );
  }
  return found;
}

/**
 * Opens the move's session, checking before any change: the app's environments read (previews and
 * a retarget refused), both tokens set and working (registered with the redactor before any call),
 * the zone (the recorded move's, else `dns.zone` or the zone A's token finds for `dns.domain` of
 * the first deployed environment), A's account from A's zone, the covered environments (every
 * deployed one in the zone; one in another zone stays, one not deployed is skipped), B's account
 * (`--to`, or the record's) not A, B's zone and its `CloudflareSetup` when B has it, the other
 * apps' hostnames in A's zone while it is active, GitHub, and the engine with the state passphrase
 * as `existingStateEngine` reads them.
 */
export async function openMoveSession(
  deps: PhaseDeps,
  options: OpenMoveSessionOptions,
): Promise<MoveSession> {
  const services = options.services ?? {};
  const { command } = options;
  const paths = deps.paths;
  const all = await readMoveRecords(paths, await environmentsOf(paths.root, paths.app));
  await requireNoPreviews(paths);
  await requireNoRetarget(paths, all);
  const again = `then run \`${command}\` again`;
  const aToken = requireToken(
    deps,
    A_TOKEN_VAR,
    "the move reads the app's zone with the token of the account that holds it now",
    `Set ${A_TOKEN_VAR} to the token OpsCrew deployed the app with, ${again}.`,
  );
  const bToken = requireToken(
    deps,
    B_TOKEN_VAR,
    "the move builds the app's pieces in the new account with a token of that account's own",
    `Create a token in the new account at ${CLOUDFLARE_TOKEN_PAGE} with the permissions ${A_TOKEN_VAR} has, and Zone → Zone → Edit so OpsCrew can add the zone there; set ${B_TOKEN_VAR} to it, ${again}.`,
  );
  deps.reporter.step("Checking both Cloudflare accounts and GitHub");
  const aClient = await verifiedClient(
    deps,
    services,
    aToken,
    services.cloudflare,
    A_TOKEN_VAR,
    command,
  );
  const bClient = await verifiedClient(
    deps,
    services,
    bToken,
    services.newCloudflare,
    B_TOKEN_VAR,
    command,
  );
  const recorded = all.find((env) => env.plan.cloudflareMove !== undefined)?.plan.cloudflareMove;
  const aAccounts = await aClient.listAccounts();
  const split = await splitEnvironments(
    all,
    recorded,
    aClient,
    aAccounts.map((one) => one.id),
  );
  const { zone } = split;
  const target = await targetAccount(bClient, recorded, options.to, zone);
  if (target.id === split.a.accountId) {
    throw refusal(
      `The account ${target.name} (${target.id}) holds ${zone} already, and the move goes to another account.`,
      `Pass another account with --to, or set ${B_TOKEN_VAR} to the new account's token, ${again}.`,
      "INVALID_INPUT",
    );
  }
  const [first] = split.environments;
  if (first === undefined) throw nothingToMove(all);
  const bZone = await zoneIn(bClient, zone, target.id);
  const setup: CloudflareSetup | undefined =
    bZone === undefined
      ? undefined
      : await setupCloudflare(
          { ...deps, paths: first.paths },
          first.plan,
          { cloudflare: bClient },
          { accountId: target.id, foreignRecords: "report" },
        );
  const a: MoveAccounts["a"] = {
    client: aClient,
    accountId: split.a.accountId,
    zoneId: split.a.zoneId,
    ...nameOf(aAccounts, split.a.accountId),
    ...(split.a.zone === undefined ? {} : { zone: split.a.zone }),
  };
  const b: MoveAccount & { setup?: CloudflareSetup } = {
    client: bClient,
    accountId: target.id,
    name: target.name,
    ...(bZone === undefined ? {} : { zone: bZone }),
    ...(setup === undefined ? {} : { setup }),
  };
  const otherHostnames =
    a.zone?.status === "active"
      ? await otherAppHostnames(a, zone, [...split.environments, ...split.skipped])
      : [];

  const git = await requireGitRepo(deps);
  const githubApi =
    services.github !== undefined ? services.github : await githubClientFromToken(deps);
  // Stops with CREDENTIALS_MISSING when there is no token, so the API exists after it.
  const github = await setupGitHub(deps, git, { github: githubApi ?? null });
  if (githubApi === null || githubApi === undefined) {
    throw new OpsCrewError("INTERNAL", "The GitHub API is not available.", {
      hint: "This is a bug in OpsCrew; please report it.",
    });
  }
  const { engine, env } = await existingStateEngine({ ...deps, paths: first.paths }, first.plan, {
    ...(options.engine !== undefined ? { engine: options.engine } : {}),
    services,
    command,
  });
  return {
    deps,
    services,
    paths,
    zone,
    environments: split.environments,
    staying: split.staying,
    skipped: split.skipped.map((env) => env.environment),
    accounts: { a, b },
    otherHostnames,
    git,
    github,
    githubApi,
    engine,
    env,
    approve: options.approvePlanHash?.trim() || undefined,
    command,
  };
}
