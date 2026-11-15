/**
 * B's tunnel connectors beside A's while an app moves to another Cloudflare account (plan 4.4.3,
 * 7.4, 8., 9.): at prepare B's connector starts beside the one serving A's tunnel; at the finish
 * the main connector takes B's token and the beside one goes; an abort removes the beside one. On
 * a server (the user's own in tunnel mode as root, a cloud server's subdomain connector as the
 * deploy login) each change is a host plan approved by its hash, with B's token only on the host
 * adapter's standard input; in the user's Portainer, the beside stacks go through one stack plan
 * approved by its hash ({@link ./connector-stacks}).
 */
import {
  type HostFacts,
  hostPlanHash,
  planNextTunnelConnector,
  planNextTunnelConnectorRemoval,
  planTunnelToken,
  tunnelProject,
} from "@opscrew/connector-ssh-host";
import { durationText, errorMessage, OpsCrewError } from "@opscrew/core";
import {
  keepNewerPins,
  renderNextTunnelConnectorCompose,
  renderTunnelConnectorCompose,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { CLOUD_TUNNEL_DIR } from "../portainer/settings";
import type { NetworkServer } from "../provision/network";
import { tunnelModules } from "../rotate/infra";
import {
  portainerTunnelConnectors,
  type RotatedTunnel,
  serverTunnelConnectors,
  type TunnelConnectors,
} from "../rotate/infra-connectors";
import { approveAndApplyHostPlan, committedText, pollUntil, serverLogin } from "../shared";
import { TUNNEL_CLOSE_TIMEOUT_MS, tunnelBusyError } from "../shared/tunnel-connections";
import { networkServer, type VpnServices } from "../vpn/servers";
import { MOVE_PHASE, type NextStacksApi, nextStacksApi, nextStacksStep } from "./connector-stacks";
import { stacksForB } from "./finish-point";
import type { MoveAccount, MoveEnvironment, MoveSession } from "./types";

/** The beside connector's folder on a cloud server, as the deploy login (beside the main one's). */
export const CLOUD_NEXT_TUNNEL_DIR = `${CLOUD_TUNNEL_DIR}-next`;

/** How often {@link waitForNoConnection} asks Cloudflare, and says it still waits. */
const POLL_INTERVAL_MS = 5_000;
const PROGRESS_EVERY_MS = 20_000;

/** One of B's tunnels of an environment, with its token (from its shadow root's outputs). */
export type MoveTunnel = RotatedTunnel;

/** What the connector steps can be given besides the session. */
export interface ConnectorOptions {
  /** The beside stacks in Portainer: the Portainer connector's `planNextStacks` and apply. */
  nextStacks?: NextStacksApi;
  /**
   * The main connectors the finish restarts with B's tokens (tests; default rotate's
   * `serverTunnelConnectors`, or `portainerTunnelConnectors` planning the stacks with B's values,
   * `stacksForB`, by the target).
   */
  connectors?: TunnelConnectors;
}

/** The phase's deps with the environment's own paths. */
function environmentDeps(session: MoveSession, environment: MoveEnvironment): PhaseDeps {
  return { ...session.deps, paths: environment.paths };
}

/** The server in words: the user's own, or the one OpsCrew created. */
function serverWords(plan: DeployPlan): string {
  return plan.target.provider === "own" ? "your server" : "the app's server";
}

/**
 * The move's server seams as the host plans' (`networkServer`) take them: the injected shell by
 * the server's address, and the host adapter.
 */
function serverServices(
  deps: PhaseDeps,
  plan: DeployPlan,
  session: MoveSession,
): Pick<VpnServices, "remote" | "host"> {
  const { remote, host } = session.services;
  return {
    ...(remote === undefined
      ? {}
      : { remote: async (name: string) => remote((await serverLogin(deps, plan, name)).host) }),
    ...(host === undefined ? {} : { host }),
  };
}

/** The app's server, inspected read-only now. */
function inspectServer(session: MoveSession, deps: PhaseDeps, plan: DeployPlan) {
  return networkServer(deps, plan, APP_SERVER, serverServices(deps, plan, session), MOVE_PHASE);
}

/** True when a container of the beside connector's Compose project is on the server. */
function besideOnServer(facts: HostFacts, app: string): boolean {
  const project = `${tunnelProject(app)}-next`;
  return facts.containers.some((container) => container.project === project);
}

/** How a host plan of the beside connector runs: as root on the user's own server, else the login. */
function besideRunAs(plan: DeployPlan): { runAs: "root" | "login"; dir?: string } {
  return plan.target.provider === "own"
    ? { runAs: "root" }
    : { runAs: "login", dir: CLOUD_NEXT_TUNNEL_DIR };
}

/** The connector's Compose file `rendered`, with the newer pins of the main connector's committed one. */
async function withCommittedPins(deps: PhaseDeps, plan: DeployPlan, rendered: string) {
  const main = renderTunnelConnectorCompose(plan);
  return keepNewerPins(await committedText(deps.paths.root, [main.path]), rendered);
}

/** The one tunnel a server's connector serves (the app's, or its subdomains'). */
function serverTunnel(tunnels: readonly MoveTunnel[]): MoveTunnel {
  const [tunnel, ...more] = tunnels;
  if (tunnel === undefined || tunnel.module !== "tunnel" || more.length > 0) {
    throw new OpsCrewError(
      "INTERNAL",
      "OpsCrew was given other tunnels than the one whose connector runs on the app's server, so it changed nothing there.",
      {
        hint: "This is a bug in OpsCrew; please report it.",
      },
    );
  }
  return tunnel;
}

/**
 * B's connector beside A's for `environment` (prepare): on a server its host plan
 * (`planNextTunnelConnector`: the Compose project `<app>-tunnel-next`, as root in its folder on the
 * user's own server, as the deploy login in {@link CLOUD_NEXT_TUNNEL_DIR} on a cloud server), its
 * token only on the host adapter's standard input, approved by its hash (`host-apply`); skipped
 * when B's tunnel is connected already (before the finish only the beside connector holds its
 * token). In the user's Portainer the beside stacks, through one stack plan approved by its hash
 * (`stack-apply`), skipped when it changes nothing. `tunnels`: B's tunnels with their tokens;
 * none, nothing to do.
 */
export async function besideConnector(
  session: MoveSession,
  environment: MoveEnvironment,
  tunnels: readonly MoveTunnel[],
  options: ConnectorOptions = {},
): Promise<void> {
  if (tunnels.length === 0) return;
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  for (const tunnel of tunnels) deps.redactor.addLiteral(tunnel.token, "tunnel-token");
  if (plan.target.provider === "portainer") {
    await nextStacksStep(session, deps, plan, nextStacksApi(options), { run: tunnels });
    return;
  }
  const tunnel = serverTunnel(tunnels);
  const words = serverWords(plan);
  const b = session.accounts.b;
  const runs = `The new Cloudflare account's tunnel connector runs beside the current one on ${words}; nothing on it changes.`;
  if ((await b.client.tunnelConnections(b.accountId, tunnel.tunnelId)) === "active") {
    deps.reporter.success(runs);
    return;
  }
  const server = await inspectServer(session, deps, plan);
  const { runAs, dir } = besideRunAs(plan);
  const compose = await withCommittedPins(
    deps,
    plan,
    renderNextTunnelConnectorCompose(plan).content,
  );
  await approveAndApplyHostPlan(deps, {
    plan: planNextTunnelConnector({
      facts: server.facts,
      app: plan.app.name,
      runAs,
      connector: { ...(dir === undefined ? {} : { dir }), compose, tunnelId: tunnel.tunnelId },
    }),
    ...hostAccess(server),
    title: `Run the new Cloudflare account's tunnel connector beside the current one on ${words}`,
    server: words,
    planOf: words,
    upToDate: runs,
    command: session.command,
    phase: MOVE_PHASE,
    secrets: async () => ({ tunnelToken: tunnel.token }),
    applying: `Starting the new Cloudflare account's tunnel connector beside the current one on ${words}`,
  });
}

/** How a host plan reaches the inspected server. */
function hostAccess(server: NetworkServer) {
  return { remote: server.remote, apply: server.apply, verifyLogin: server.verifyLogin };
}

/**
 * The finish's connector step for `environment`: the main connector restarts with B's tunnel
 * token (rotate's `serverTunnelConnectors(…).restart` or `portainerTunnelConnectors(…).restart`,
 * each approved by its hash), then the beside connector is removed, so B's tunnel never pauses.
 * On a server, skipped once the beside connector is gone and B's tunnel is connected (the main
 * connector holds B's token then); a run after the restart restarts the main connector once more
 * while the beside one still serves, and a refused removal names both hashes, which a script
 * approves together. In Portainer each stack plan that changes nothing is skipped. `tunnels`: B's tunnels with their tokens.
 */
export async function takeOverConnector(
  session: MoveSession,
  environment: MoveEnvironment,
  tunnels: readonly MoveTunnel[],
  options: ConnectorOptions = {},
): Promise<void> {
  if (tunnels.length === 0) return;
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  for (const tunnel of tunnels) deps.redactor.addLiteral(tunnel.token, "tunnel-token");
  const command = session.command;
  if (plan.target.provider === "portainer") {
    const api = nextStacksApi(options);
    const connectors =
      options.connectors ??
      portainerTunnelConnectors(deps, plan, {
        command,
        stacksFor: () => stacksForB(session, environment),
      });
    await connectors.restart(tunnels);
    await nextStacksStep(session, deps, plan, api, { remove: true });
    return;
  }
  const tunnel = serverTunnel(tunnels);
  const server = await inspectServer(session, deps, plan);
  const b = session.accounts.b;
  if (
    !besideOnServer(server.facts, plan.app.name) &&
    (await b.client.tunnelConnections(b.accountId, tunnel.tunnelId)) === "active"
  ) {
    deps.reporter.success(
      `The Cloudflare Tunnel connector on ${serverWords(plan)} serves the new account's tunnel, and none runs beside it; nothing on it changes.`,
    );
    return;
  }
  const connectors =
    options.connectors ??
    serverTunnelConnectors(deps, plan, {
      command,
      services: serverServices(deps, plan, session),
    });
  await connectors.restart([tunnel]);
  await removeOnServer(session, deps, plan, server, await restartHash(deps, plan, tunnel));
}

/**
 * The hash of the host plan `serverTunnelConnectors(…).restart` shows for `tunnel`, made from the
 * same inputs, so a refused removal can name both plans a script approves together.
 */
async function restartHash(deps: PhaseDeps, plan: DeployPlan, tunnel: MoveTunnel) {
  const own = plan.target.provider === "own";
  const rendered = renderTunnelConnectorCompose(plan);
  return hostPlanHash(
    planTunnelToken({
      app: plan.app.name,
      runAs: own ? "root" : "login",
      connector: {
        ...(own ? {} : { dir: CLOUD_TUNNEL_DIR }),
        compose: await withCommittedPins(deps, plan, rendered.content),
        tunnelId: tunnel.tunnelId,
      },
    }),
  );
}

/**
 * The abort's connector step for `environment`: the beside connector removed (on a server its
 * host plan, skipped when no container of it is there; in Portainer the stack plan that removes
 * the beside stacks), each approved by its hash; the main connector stays. B's tunnels are then
 * waited on with {@link waitForNoConnection} before they are destroyed.
 */
export async function removeBesideConnector(
  session: MoveSession,
  environment: MoveEnvironment,
  options: ConnectorOptions = {},
): Promise<void> {
  const { plan } = environment;
  if (tunnelModules(plan).length === 0) return;
  const deps = environmentDeps(session, environment);
  if (plan.target.provider === "portainer") {
    await nextStacksStep(session, deps, plan, nextStacksApi(options), { remove: true });
    return;
  }
  await removeOnServer(session, deps, plan, await inspectServer(session, deps, plan));
}

/**
 * The beside connector's removal on `server` (`planNextTunnelConnectorRemoval`), approved by its
 * hash; skipped when no container of it is there. `restarted`: the hash of the main connector's
 * restart this run applied, which a refusal names with the removal's.
 */
async function removeOnServer(
  session: MoveSession,
  deps: PhaseDeps,
  plan: DeployPlan,
  server: NetworkServer,
  restarted?: string,
): Promise<void> {
  const words = serverWords(plan);
  const gone = `No connector of the new Cloudflare account runs beside the current one on ${words}; nothing on it changes.`;
  if (!besideOnServer(server.facts, plan.app.name)) {
    deps.reporter.success(gone);
    return;
  }
  const { runAs, dir } = besideRunAs(plan);
  const removal = planNextTunnelConnectorRemoval({
    facts: server.facts,
    app: plan.app.name,
    runAs,
    ...(dir === undefined ? {} : { dir }),
  });
  const command = session.command;
  await approveAndApplyHostPlan(deps, {
    plan: removal,
    ...hostAccess(server),
    title: `Remove the new Cloudflare account's tunnel connector that ran beside the current one on ${words}`,
    server: words,
    planOf: words,
    upToDate: gone,
    command,
    phase: MOVE_PHASE,
    ...(restarted === undefined
      ? {}
      : {
          refused: {
            message: `The Cloudflare Tunnel connector on ${words} serves the new account's tunnel now, and the host plan that removes the one beside it was not approved, so that one still runs`,
            hint: `Run \`${command} --approve ${restarted} --approve ${hostPlanHash(removal)}\` when you are ready: the first plan restarts the connector once more while the one beside it serves, the second removes that one.`,
          },
        }),
    secrets: async () => ({}),
    applying: `Removing the new Cloudflare account's tunnel connector beside the current one on ${words}`,
  });
}

/**
 * Waits, with read-only calls of `account`'s client, until Cloudflare reports no active
 * connection for its tunnel `tunnelId` (`tunnelConnections` closed or gone), for at most
 * {@link TUNNEL_CLOSE_TIMEOUT_MS}, saying about every 20 seconds that it still waits; then a plain
 * stop that nothing in Cloudflare was deleted and to run the command again. Used before B's tunnels are destroyed (abort) and before A's are (finish).
 */
export async function waitForNoConnection(
  session: MoveSession,
  account: MoveAccount,
  tunnelId: string,
): Promise<void> {
  const { reporter, redactor } = session.deps;
  const { sleep } = session.services;
  const now = session.services.now ?? Date.now;
  const start = now();
  let said = 0;
  reporter.step(
    `Waiting until Cloudflare reports no active connections for the tunnel (up to ${durationText(TUNNEL_CLOSE_TIMEOUT_MS)})`,
  );
  let problem: string | undefined;
  const closed = await pollUntil(
    async () => {
      try {
        const state = await account.client.tunnelConnections(account.accountId, tunnelId);
        problem = undefined;
        if (state !== "active") return true;
      } catch (error) {
        problem = redactor.redact(errorMessage(error));
      }
      const elapsed = now() - start;
      if (elapsed < TUNNEL_CLOSE_TIMEOUT_MS && elapsed - said >= PROGRESS_EVERY_MS) {
        said = elapsed;
        reporter.info(
          `Still waiting for Cloudflare to close the tunnel's connections (${Math.round(elapsed / 1000)} s so far, up to ${durationText(TUNNEL_CLOSE_TIMEOUT_MS)}).`,
        );
      }
      return undefined;
    },
    {
      timeoutMs: TUNNEL_CLOSE_TIMEOUT_MS,
      intervalMs: POLL_INTERVAL_MS,
      now,
      ...(sleep === undefined ? {} : { sleep }),
    },
  );
  if (closed === true) {
    reporter.success("Cloudflare reports no active connections for the tunnel.");
    return;
  }
  throw tunnelBusyError({
    command: session.command,
    reason: "timeout",
    ...(problem === undefined ? {} : { problem }),
  });
}
