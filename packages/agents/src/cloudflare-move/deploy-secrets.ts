/**
 * The deploy's credentials for the account the app moves to, as extra GitHub secrets with `_NEW`
 * names (plan 10., data model 6): set at prepare beside A's, which the workflow tries first, moved
 * into the plain names at the finish, deleted at an abort. Each change is one `github-secrets`
 * approval bound to a hash over the secrets' names and their values' digests; the values are
 * sealed on this computer and never shown, logged or written to a file.
 */
import { join } from "node:path";
import {
  CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS,
  CLOUDFLARE_TOKEN_PAGE,
} from "@opscrew/connector-cloudflare";
import { canonicalJson, OpsCrewError, plural, sha256Hex, writeFileAtomic } from "@opscrew/core";
import {
  CLOUDFLARE_DEPLOY_SECRETS,
  CLOUDFLARE_DEPLOY_SECRETS_NEW,
  deploysInPlace,
  PORTAINER_DEPLOY_SECRETS,
  PORTAINER_DEPLOY_SECRETS_NEW,
  TUNNEL_DEPLOY_SECRETS,
  TUNNEL_DEPLOY_SECRETS_NEW,
  tunnelMode,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import {
  deleteSecretAt,
  deploySecretPlace,
  placeText,
  type SecretPlace,
  setSecretAt,
} from "../provision/secrets";
import { runDeployWorkflow } from "../retarget/site-steps";
import { appliesNow } from "../retarget/steps";
import { requireWorkersTokens } from "../serverless/cloudflare/checks";
import { readValidJson, requestApproval, stringOutput } from "../shared";
import { clearPending, type MovePlanKey, writePending } from "./progress";
import { shadowOutputs, shadowRoots } from "./shadow";
import { pendingStop } from "./shared";
import { A_TOKEN_VAR, B_TOKEN_VAR } from "./texts";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

const PHASE = "cloudflare-move";

/** B's Workers deploy token, which GitHub gets as the site's `_NEW` deploy token. */
export const NEW_DEPLOY_TOKEN_VAR = "OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN";

/** The outputs of a root that hold its Access deploy service token. */
const TOKEN_ID_OUTPUT = "deploy_service_token_client_id";
const TOKEN_SECRET_OUTPUT = "deploy_service_token_client_secret";

/** What the approvals say of the values. */
const SEALED = "(names only; values are encrypted on this computer before upload and never shown)";

/** The credentials the environment's deploy reads in both accounts during a move. */
interface MovedSecrets {
  /** Through Cloudflare Access (an own server's tunnel SSH, Portainer's webhook), or a site's Worker. */
  kind: "access" | "worker";
  /** Each deploy secret (unprefixed) and its `_NEW` twin. */
  pairs: { plain: string; next: string }[];
}

/**
 * The deploy secrets whose `_NEW` twins the environment's workflow reads (as `isMoveReady` checks
 * the committed workflow): a Workers site's account id and deploy token; Portainer's webhook
 * Access client in redeploy mode `cloudflare`; the tunnel's deploy service token of an own server
 * in tunnel mode deployed from GitHub's machines or a runner machine. `undefined` for any other
 * environment, whose deploy needs nothing of B's.
 */
function movedSecrets(plan: DeployPlan): MovedSecrets | undefined {
  const pairs = (plain: Record<string, string>, next: Record<string, string>) =>
    Object.entries(plain).flatMap(([key, name]) =>
      next[key] === undefined ? [] : [{ plain: name, next: next[key] as string }],
    );
  if (plan.target.provider === "cloudflare-workers") {
    return {
      kind: "worker",
      pairs: pairs(CLOUDFLARE_DEPLOY_SECRETS, CLOUDFLARE_DEPLOY_SECRETS_NEW),
    };
  }
  if (plan.target.provider === "portainer" && plan.target.redeploy === "cloudflare") {
    return { kind: "access", pairs: pairs(PORTAINER_DEPLOY_SECRETS, PORTAINER_DEPLOY_SECRETS_NEW) };
  }
  // A runner on the server or this computer deploys in place, not through Access.
  if (tunnelMode(plan) && !deploysInPlace(plan)) {
    return { kind: "access", pairs: pairs(TUNNEL_DEPLOY_SECRETS, TUNNEL_DEPLOY_SECRETS_NEW) };
  }
  return undefined;
}

/**
 * B's Workers deploy token ({@link NEW_DEPLOY_TOKEN_VAR}), checked as provision checks A's
 * (`requireWorkersTokens` with B's client and B's variables): it is not A's token, which can edit
 * DNS; B's token and the deploy token hold Workers Scripts Edit for B, and the deploy token is not
 * B's own. Registered with the redactor.
 * @throws OpsCrewError naming B's variables and B's account, before any change.
 */
async function bDeployToken(session: MoveSession): Promise<string> {
  const { deps, zone } = session;
  const { b } = session.accounts;
  const given = deps.env[NEW_DEPLOY_TOKEN_VAR]?.trim();
  if (given && given === deps.env[A_TOKEN_VAR]?.trim()) {
    throw new OpsCrewError(
      "CREDENTIALS_INVALID",
      `${NEW_DEPLOY_TOKEN_VAR} is the same token as ${A_TOKEN_VAR}, which can edit your DNS, so OpsCrew does not store it in GitHub. Nothing was changed.`,
      {
        hint: `Create a token at ${CLOUDFLARE_TOKEN_PAGE} with only ${CLOUDFLARE_DEPLOY_TOKEN_PERMISSIONS[0]} for ${bWords(session)}, set ${NEW_DEPLOY_TOKEN_VAR} to it, then run \`${session.command}\` again.`,
      },
    );
  }
  const token = await requireWorkersTokens(deps, {
    client: b.client,
    cloudflare: { accountId: b.accountId, zoneName: zone },
    deployToken: true,
    command: session.command,
    // B by name: "the account that holds" the zone is A while it is active.
    names: { apiToken: B_TOKEN_VAR, deployToken: NEW_DEPLOY_TOKEN_VAR, account: bWords(session) },
  });
  return token as string;
}

/**
 * B's values of the environment's moved deploy secrets, by their plain (unprefixed) names: a
 * site's B account id and deploy token, else B's Access deploy service token from the outputs of
 * the environment's main shadow root (registered with the redactor).
 * @throws OpsCrewError `ENGINE_FAILED` when the outputs hold no service token.
 */
async function bValues(
  session: MoveSession,
  environment: MoveEnvironment,
  moved: MovedSecrets,
  outputs: () => Promise<Record<string, unknown>>,
): Promise<Record<string, string>> {
  if (moved.kind === "worker") {
    return {
      [CLOUDFLARE_DEPLOY_SECRETS.apiToken]: await bDeployToken(session),
      [CLOUDFLARE_DEPLOY_SECRETS.accountId]: session.accounts.b.accountId,
    };
  }
  const [id, secret] = moved.pairs.map((pair) => pair.plain) as [string, string];
  const read = await outputs();
  const tokenId = stringOutput(read, TOKEN_ID_OUTPUT);
  const tokenSecret = stringOutput(read, TOKEN_SECRET_OUTPUT);
  const { redactor } = session.deps;
  if (tokenId !== undefined) redactor.addLiteral(tokenId, "service-token-id");
  if (tokenSecret !== undefined) redactor.addLiteral(tokenSecret, "service-token-secret");
  if (tokenId === undefined || tokenSecret === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      `The new Cloudflare account's infrastructure state of ${environment.environment} has no Access service token for the deploy, so OpsCrew can't give GitHub the deploy's credentials there. Nothing was changed.`,
      { hint: `Run \`${session.command}\` again; it plans the new account's pieces again.` },
    );
  }
  return { [id]: tokenId, [secret]: tokenSecret };
}

/** The outputs of the environment's main shadow root (B's pieces), read again. */
async function mainShadowOutputs(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<Record<string, unknown>> {
  const roots = await shadowRoots(session, environment);
  const main = roots.find((root) => root.name === "main");
  return main === undefined ? {} : shadowOutputs(session, main);
}

/**
 * The digest of the last secrets change applied for the environment, kept beside its shadow
 * states (`cloudflare-move/deploy-secrets.json`, machine-local, deleted with that folder): the
 * hash of the change, which binds names and their values' digests, never a value.
 */
const AppliedSchema = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

function appliedFile(environment: MoveEnvironment): string {
  return join(environment.paths.stateDir, "cloudflare-move", "deploy-secrets.json");
}

/** A secret to store: where it goes and its value. */
type Stored = SecretPlace & { value: string };

/** One change of the environment's deploy secrets, approved on its own. */
interface SecretsChange {
  key: MovePlanKey;
  set: Stored[];
  delete: SecretPlace[];
  title: string;
  intro: string[];
  /** Said when the change was applied already. */
  done: string;
  /** Run after the secrets changed, before the change counts as applied. */
  after?: () => Promise<void>;
}

/**
 * Applies `change`: skipped when it changes nothing or the environment's last applied change has
 * its hash; else shown, and approved by its hash (`github-secrets`) when this run applies it
 * (interactive, or `--approve <hash>`), otherwise recorded as waiting with a stop naming the
 * command. Then each secret is stored (sealed locally) and each deleted, both audited by name,
 * `after` runs, and the hash is kept.
 * @throws PlanRefusedError when it is not approved: no secret changed.
 */
async function applySecretsChange(
  session: MoveSession,
  environment: MoveEnvironment,
  change: SecretsChange,
): Promise<StepStop | undefined> {
  const { deps, github } = session;
  const repository = `${github.owner}/${github.repo}`;
  const where = ({ name, environment }: SecretPlace): SecretPlace =>
    environment === undefined ? { name } : { name, environment };
  const hash = sha256Hex(
    canonicalJson({
      action: change.key.action,
      environment: environment.environment,
      repository,
      set: change.set.map((place) => ({ ...where(place), sha256: sha256Hex(place.value) })),
      delete: change.delete.map(where),
    }),
  );
  const file = appliedFile(environment);
  const none = change.set.length === 0 && change.delete.length === 0;
  if (none || (await readValidJson(file, AppliedSchema))?.sha256 === hash) {
    deps.reporter.info(change.done);
    await clearPending(deps, change.key);
    return undefined;
  }
  const details = [
    ...change.intro,
    ...(change.set.length > 0
      ? [`Stored ${SEALED}:`, ...change.set.map((place) => `  ${placeText(place)}`)]
      : []),
    ...(change.delete.length > 0
      ? ["Deleted (names only):", ...change.delete.map((place) => `  ${placeText(place)}`)]
      : []),
  ].join("\n");
  if (!appliesNow(session, hash)) {
    deps.reporter.info(`${change.title}\n${details}`);
    await writePending(deps, change.key, hash);
    return pendingStop(session, hash);
  }
  await requestApproval(deps, {
    kind: "github-secrets",
    title: change.title,
    details,
    hash,
    refused: {
      plan: "change of the deploy's GitHub secrets",
      unchanged: "No GitHub secret was changed.",
      again: session.command,
    },
  });
  const at = { api: session.githubApi, owner: github.owner, repo: github.repo };
  for (const place of change.set) await setSecretAt(deps, at, where(place), place.value, PHASE);
  for (const place of change.delete) await deleteSecretAt(deps, at, place, PHASE);
  await change.after?.();
  await writeFileAtomic(file, `${JSON.stringify({ sha256: hash })}\n`);
  await clearPending(deps, change.key);
  deps.reporter.success(change.done);
  return undefined;
}

/**
 * Runs the environment's deploy workflow on its branch and waits for it to succeed, so B's Worker
 * runs the site's current code (the workflow deploys to both accounts while the `_NEW` secrets
 * are set).
 * @throws OpsCrewError when it could not run or did not succeed; A's Worker still serves the site.
 */
async function deployToBoth(session: MoveSession, environment: MoveEnvironment): Promise<void> {
  const { command } = session;
  const github = { ...session.github, api: session.githubApi };
  await runDeployWorkflow(session.deps, github, environment.plan, PHASE, {
    purpose: "so the Worker in the new account runs the site's current code",
    unchanged: "The site is still served from the current Cloudflare account.",
    failedHint: `Check the workflow in your repository's Actions tab, then run \`${command}\` again.`,
    unsuccessfulHint: `Open the run to see what failed and push a fix, then run \`${command}\` again.`,
    environment: environment.environment,
  });
}

/** The account the move goes to, in words. */
function bWords(session: MoveSession): string {
  const { b } = session.accounts;
  return `the Cloudflare account ${b.name ?? b.accountId}`;
}

/**
 * Prepare's extra deploy secrets of `environment` (plan 4.4.4): one `github-secrets` approval
 * naming the `_NEW` secrets (never their values), where the environment's deploy secrets live.
 * Through Access, B's deploy service token from `outputs` (the main shadow root's); for a Workers
 * site, B's account id and {@link NEW_DEPLOY_TOKEN_VAR} (checked against B first), then the deploy
 * workflow run and awaited so B's Worker runs the current code. Skipped when the same values were
 * set already (and, for a site, deployed); nothing for an environment whose deploy needs nothing
 * of B's. A run that doesn't apply it now stops with the command that does.
 */
export async function addNewCredentials(
  session: MoveSession,
  environment: MoveEnvironment,
  outputs: Record<string, unknown>,
): Promise<StepStop | undefined> {
  const { plan } = environment;
  const moved = movedSecrets(plan);
  if (moved === undefined) return undefined;
  const values = await bValues(session, environment, moved, async () => outputs);
  const set = moved.pairs.map(({ plain, next }) => ({
    ...deploySecretPlace(plan, next),
    value: values[plain] as string,
  }));
  const site = moved.kind === "worker";
  const name = environment.environment;
  return applySecretsChange(session, environment, {
    key: { action: "secrets", environment: name },
    set,
    delete: [],
    title: `Store the deploy's credentials for ${bWords(session)} as ${plural(set.length, "extra GitHub secret")} of ${name}`,
    intro: site
      ? [
          `While these are set, each deploy of ${name} also deploys the site's Worker in ${bWords(session)}; OpsCrew runs the deploy workflow once now, so that Worker runs the site's current code.`,
        ]
      : [
          `During the move the deploy of ${name} tries the current account's Access credentials first and these once Cloudflare Access refuses those, so deploys keep working on both sides of the switch.`,
        ],
    done: `The deploy of ${name} has its credentials for ${bWords(session)}.`,
    ...(site ? { after: () => deployToBoth(session, environment) } : {}),
  });
}

/**
 * The finish's deploy secrets of `environment` (plan 7.1, 7.5): one `github-secrets` approval in
 * which the plain deploy secrets take B's values (B's service token from the main shadow root's
 * outputs, or a site's B account id and deploy token) and the `_NEW` ones are deleted. Skipped
 * when that was done already; nothing for an environment whose deploy needs nothing of B's.
 */
export async function promoteNewCredentials(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const { plan } = environment;
  const moved = movedSecrets(plan);
  if (moved === undefined) return undefined;
  const values = await bValues(session, environment, moved, () =>
    mainShadowOutputs(session, environment),
  );
  const name = environment.environment;
  return applySecretsChange(session, environment, {
    key: { action: "finish-secrets", environment: name },
    set: moved.pairs.map(({ plain }) => ({
      ...deploySecretPlace(plan, plain),
      value: values[plain] as string,
    })),
    delete: moved.pairs.map(({ next }) => deploySecretPlace(plan, next)),
    title: `Give the deploy of ${name} its credentials for ${bWords(session)} under their usual names`,
    intro: [
      `The deploy's secrets take the credentials of ${bWords(session)}, and the extra ones the move added are deleted.`,
    ],
    done: `The deploy of ${name} uses its credentials for ${bWords(session)}.`,
  });
}

/**
 * Whether GitHub has the secret at `place` (read-only, never its value). One in a GitHub
 * environment counts as there: GitHub's client reads no environment secret's existence.
 */
async function onGitHub(session: MoveSession, place: SecretPlace): Promise<boolean> {
  if (place.environment !== undefined) return true;
  const { owner, repo } = session.github;
  return session.githubApi.actionsSecretExists(owner, repo, place.name);
}

/**
 * The abort's deploy secrets of `environment` (plan 8.): one `github-secrets` approval deleting
 * each `_NEW` secret of its deploy that GitHub has, so it works with A's credentials only, as
 * before the move. Skipped when that was done already or GitHub has none of them; nothing for an
 * environment whose deploy needs nothing of B's.
 */
export async function dropNewCredentials(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const { plan } = environment;
  const moved = movedSecrets(plan);
  if (moved === undefined) return undefined;
  const name = environment.environment;
  const remove: SecretPlace[] = [];
  for (const { next } of moved.pairs) {
    const place = deploySecretPlace(plan, next);
    if (await onGitHub(session, place)) remove.push(place);
  }
  return applySecretsChange(session, environment, {
    key: { action: "abort-secrets", environment: name },
    set: [],
    delete: remove,
    title: `Delete the ${plural(remove.length, "extra GitHub secret")} the move added for the deploy of ${name}`,
    intro: [`The deploy of ${name} goes on with the current account's credentials only.`],
    done: `The deploy of ${name} has no credentials for ${bWords(session)} left.`,
  });
}
