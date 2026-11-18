/**
 * A server at home in a move to another Cloudflare account (plan 15.): its address updater keeps
 * the app's A and AAAA records in A's zone, with a token of its own for that zone, until the
 * finish gives it B's zone id and B's updater token through the server's host plan, approved by
 * its hash. Until then it writes A's moved zone, which serves nothing. B's updater token comes
 * from `OPSCREW_NEW_DNS_UPDATER_TOKEN`, else from one question in a terminal (hidden); it goes to
 * the server on the host adapter's standard input only and is never kept on this computer. An
 * abort deletes the updater's records the zone plan copied into B's zone when that zone stays.
 */
import { CLOUDFLARE_TOKEN_PAGE } from "@opscrew/connector-cloudflare";
import { addressUpdaterName, usesTunnel } from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";
import { deleteUpdaterRecords, planRecordDeletion } from "../home/records";
import { checkUpdaterToken } from "../home/token";
import { applyOwnHostPlan, prepareOwnServer } from "../provision/own";
import type { ProvisionServices } from "../provision/types";
import { ensureDeployKey } from "../shared/ssh-keys";
import {
  clearPending,
  type MovePlanKey,
  pendingMatches,
  readAppProgress,
  writePending,
} from "./progress";
import { shadowOutputs, shadowRoots } from "./shadow";
import { pendingStop } from "./shared";
import {
  accountName,
  B_TOKEN_VAR,
  B_UPDATER_TOKEN_VAR,
  bug,
  environmentDeps,
  MOVE_PHASE,
} from "./texts";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

/**
 * The provision services a home server's host plan is made with: the move's server seams, and
 * B's client for Cloudflare's IP ranges (read without a token).
 */
function ownServices(session: MoveSession): ProvisionServices {
  const { own, runnerGitHub, sleep, now } = session.services;
  return {
    ...(own === undefined ? {} : { own }),
    ...(runnerGitHub === undefined ? {} : { runnerGitHub }),
    ...(sleep === undefined ? {} : { sleep }),
    ...(now === undefined ? {} : { now }),
    cloudflare: session.accounts.b.client,
  };
}

/**
 * B's updater token: `OPSCREW_NEW_DNS_UPDATER_TOKEN`, else asked once in a terminal; `undefined`
 * without either (the token's check then refuses, naming the variable and the token's recipe).
 */
async function newUpdaterToken(session: MoveSession, deps: PhaseDeps): Promise<string | undefined> {
  const given = deps.env[B_UPDATER_TOKEN_VAR];
  if (given?.trim()) return given;
  const ask = session.services.askUpdaterToken;
  if (!deps.interactive || ask === undefined) return undefined;
  const { zone } = session;
  return ask({
    zone,
    prompt: `The address updater on your server needs a Cloudflare token of the new account for ${zone}, limited to its DNS: make it at ${CLOUDFLARE_TOKEN_PAGE} with Zone → DNS → Edit and Include → Specific zone → ${zone}, then paste it here. It goes to your server only; OpsCrew keeps no copy.`,
  });
}

/**
 * B's main shadow root's outputs, for a plan with a Cloudflare Tunnel: the host plan's connector
 * keeps B's tunnel, which the finish's connector step gave it. None for any other plan.
 */
async function bOutputs(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<Record<string, unknown>> {
  if (!usesTunnel(environment.plan)) return {};
  const main = (await shadowRoots(session, environment)).find((root) => root.name === "main");
  if (main === undefined) {
    throw bug(
      "The app's tunnel has no root in the new Cloudflare account, so OpsCrew changed nothing on your server.",
    );
  }
  return shadowOutputs(session, main);
}

/**
 * The finish's address updater step for `environment` (plan 15.), before the states are swapped:
 * nothing for a plan without one. The server is connected and inspected as provision does it,
 * the updater left as the server has it; when it keeps the records in B's zone already, nothing
 * changes. Otherwise B's updater token is read ({@link newUpdaterToken}) and checked against B's
 * zone and B's own token (`checkUpdaterToken`: OpsCrew's own token refused, and one wider than
 * the zone's DNS), then the server's host plan, whose `dns-updater` step names B's zone id and the
 * token's SHA-256, is shown, approved by its hash and applied, the token on standard input only.
 * A run that doesn't apply it now (no terminal, no `--approve`) stops with its hash.
 * @throws OpsCrewError from the token's checks and the host plan, `APPROVAL_REFUSED` when it is
 * not approved (nothing changed).
 */
export async function updaterToB(
  session: MoveSession,
  environment: MoveEnvironment,
): Promise<StepStop | undefined> {
  const { plan } = environment;
  const name = addressUpdaterName(plan);
  if (name === undefined) return undefined;
  const deps = environmentDeps(session, environment);
  const { b } = session.accounts;
  // B's zone is active: the finish refuses before any change otherwise.
  const zone = b.zone;
  if (zone === undefined) throw bug(`The new Cloudflare account has no zone ${session.zone}.`);
  const { command } = session;
  const deployKey = await ensureDeployKey(deps.paths, deps.redactor);
  const base = {
    plan,
    deployPublicKey: deployKey.publicKeyOpenSsh,
    // MOVE_PHASE, as the host plan's phase type names it.
    phase: "cloudflare-move" as const,
    command,
  };
  // Without the zone: the updater as the server has it, A's zone and the token there.
  const run = await prepareOwnServer(deps, {
    ...base,
    options: {},
    services: ownServices(session),
    deployKeyFile: deployKey.privateKeyFile,
  });
  const home = run.home;
  if (home === undefined) throw bug("A server at home was read without its home network.");
  if (home.updater?.zoneId === zone.id) {
    deps.reporter.success(
      `The address updater on your server keeps ${name} in the account ${accountName(b)} already; nothing on it changes.`,
    );
    return undefined;
  }
  const checked = await checkUpdaterToken({
    token: await newUpdaterToken(session, deps),
    variable: B_UPDATER_TOKEN_VAR,
    own: { token: deps.env[B_TOKEN_VAR] ?? "", client: b.client },
    zone: { id: zone.id, name: session.zone, accountId: b.accountId },
    command,
    deps,
  });
  home.updater = { zoneId: zone.id, name, token: checked.token };
  const key: MovePlanKey = { action: "updater", environment: environment.environment };
  // A script without `--approve` only sees the plan; `--approve` naming it is used up here.
  const planOnly = !deps.interactive && session.approve === undefined;
  const outcome = await applyOwnHostPlan(deps, run, {
    ...base,
    outputs: await bOutputs(session, environment),
    planOnly,
    upToDate: "Your server is up to date; nothing on it changes.",
    shown: (hash) => {
      if (session.approve === hash) session.approve = undefined;
    },
  });
  if (planOnly && outcome.plan.steps.some((step) => step.state === "change")) {
    await writePending(deps, key, outcome.hash);
    return pendingStop(session, outcome.hash);
  }
  await clearPending(deps, key);
  return undefined;
}

/**
 * The abort's deletion, while B's zone stays (other apps are prepared there): for each covered
 * environment served at home, the address updater's records the zone plan copied into B's zone,
 * deleted through `deleteUpdaterRecords` with B's client (`cloudflare-apply`, `allowDestroy`, the
 * app's name typed). A run that doesn't apply it now (no terminal, and no `--approve` naming the
 * deletion it showed) shows it and stops with its hash; with it, the records are read again and
 * nothing is deleted when they changed. Nothing is asked where B holds none of them.
 */
export async function deleteUpdaterCopies(session: MoveSession): Promise<StepStop | undefined> {
  const { b } = session.accounts;
  if (b.zone === undefined) return undefined;
  for (const environment of session.environments) {
    const name = addressUpdaterName(environment.plan);
    if (name === undefined) continue;
    const deps = environmentDeps(session, environment);
    const app = environment.plan.app.name;
    const key: MovePlanKey = { action: "abort-updater", environment: environment.environment };
    const request = {
      app,
      zoneId: b.zone.id,
      name,
      command: session.command,
      phase: MOVE_PHASE,
    };
    const { pending } = await readAppProgress(deps.paths);
    if (pendingMatches(pending, key, session.approve)) {
      session.approve = undefined;
      await deleteUpdaterRecords(deps, b.client, { ...request, approvedHash: pending.planHash });
    } else if (deps.interactive) {
      await deleteUpdaterRecords(deps, b.client, request);
    } else {
      const plan = await planRecordDeletion(b.client, request);
      if (plan === undefined) continue;
      const listed = plan.records.map((record) => `${record.type} ${record.name}`).join(", ");
      deps.reporter.info(
        `Delete the address updater's records of ${app} that the move copied into ${session.zone} in the Cloudflare account ${accountName(b)}, which stays there for other apps (hash ${plan.planHash}): ${listed}. Type the app's name to approve.`,
      );
      await writePending(deps, key, plan.planHash);
      return pendingStop(session, plan.planHash, ["--confirm", app]);
    }
    await clearPending(deps, key);
  }
  return undefined;
}
