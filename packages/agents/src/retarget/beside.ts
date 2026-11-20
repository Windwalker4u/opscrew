/**
 * The new side of a move onto the server OpsCrew created for another app, the first app (feature
 * 030, plan 16.): the move's app becomes a second app there. Its target is an own target that
 * names the first app (`target.shares`), and design's second-app checks run with the moving app's
 * plan before any change.
 */
import { planHost } from "@opscrew/connector-ssh-host";
import { listText, toPosixRelative } from "@opscrew/core";
import { EDGE_PROXIES, edgeMemoryMb, edgeProxy } from "@opscrew/iac-templates";
import {
  type CostEstimate,
  type DeployPlan,
  isCloudTarget,
  monitoringOf,
  type OwnDeployTarget,
  targetArch,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { memoryText } from "../design/components";
import { noServerCost, quotedApps, sharedAccessWarning, sharedPriceNote } from "../design/own";
import { ownServerMemory, type ServerApp } from "../design/sizing";
import { recordSharedServerAnswers } from "../interview/own-server";
import { refusedBeforeChange } from "../previews/host";
import {
  connectSecondApp,
  desiredHost,
  hostPlanOptions,
  ownWebSources,
  secondAppAdapter,
} from "../provision/own";
import {
  appMemoryMb,
  readDeployPublicKey,
  type ServerAddress,
  type SharesReference,
} from "../shared";
import { ownServerFacts } from "../shared/own-server";
import { extraServers, hasExtraServers } from "../shared/servers";
import { firstApp, hostDescription } from "../shares/first-app";
import { otherAppsMemory } from "../shares/guard";
import { sameAddress } from "./servers";
import { RUN_COMMAND } from "./texts";
import type { RetargetServices } from "./types";

/** The command a refusal of a move beside another app says to run again. */
const AGAIN = `${RUN_COMMAND} --to own`;

/** The new side beside the first app, once checked ({@link besideFirstApp}). */
export interface BesideFirstApp {
  /** The own target that names the first app and where OpsCrew created its server. */
  target: OwnDeployTarget;
  /** Nothing: the server is the first app's, which pays for it. */
  cost: CostEstimate;
  /** The first app's server's addresses, which DNS points to after the switch. */
  address: ServerAddress;
  /** The summary's lines: the memory left, why there is no server cost, the shared-access warning. */
  notes: string[];
}

/**
 * The new side of a move beside the first app that `ref` names (spec FR-3021 to FR-3023), checked
 * before any change as design checks a second app (FR-3002, FR-3003), each refusal ending "Nothing
 * was changed.":
 * - the first app as {@link firstApp} reads and refuses it (an app on a server the user owns, one
 *   not provisioned on this computer, previews, closed public SSH, a private network, another
 *   second app, a first app in the middle of a move);
 * - the server the app already runs on (`from`, the old side's address);
 * - what changes the whole server, which is the first app's: the app's private network, Portainer,
 *   Beszel and self-hosted monitoring;
 * - another proxy than the one the first app's server runs, another way of serving (behind
 *   Cloudflare's proxy or DNS only);
 * - a record on the server OpsCrew can't read;
 * - too little memory beside the first app's limits and the other apps' records, the edge and the
 *   system (a warning below 15% free);
 * - what the second app's host plan refuses, planned dry over the server as inspected: the name,
 *   the hostnames, a name read as another app's preview, a kernel setting.
 *
 * The new side's login (`.opscrew/server.json` → `own`, with the reference) is recorded first, so
 * the server is reached as a second app's commands reach it: the first app's deploy login, its
 * deploy key read by path, and its pinned host key, copied into this app's `known_hosts`.
 */
export async function besideFirstApp(
  deps: PhaseDeps,
  input: { plan: DeployPlan; ref: SharesReference; from: ServerAddress | undefined },
  services: RetargetServices,
): Promise<BesideFirstApp> {
  const { plan, ref } = input;
  const app = plan.app.name;
  const first = await firstApp(deps, ref);
  const name = first.plan.app.name;
  if (input.from !== undefined && sameAddress(input.from, first.address)) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${app} already runs on that server, so there is nothing to move.`,
      `Run \`${AGAIN}\` with the folder of another app in server.shares, or with another server's answers.`,
    );
  }
  requireNothingServerWide(plan, name);
  requireSameEdge(deps, plan, first.plan);
  requireSameServing(plan, first.plan);
  if (!isCloudTarget(first.plan.target)) throw new Error("firstApp returns a cloud target only.");
  const shares = { app: name, provider: first.plan.target.provider };
  const target = (arch: OwnDeployTarget["arch"]): OwnDeployTarget => ({
    provider: "own",
    mode: "vps-compose",
    arch,
    access: "public",
    edge: edgeProxy(plan),
    shares,
  });

  await recordSharedServerAnswers(deps.paths, ref, {
    ...first.login,
    hostKey: first.hostKey.fingerprint,
  });
  const own = services.own ?? {};
  const { session, facts } = await connectSecondApp(
    deps,
    { ...plan, target: target(targetArch(plan.target)) },
    {
      services: { ...own, host: secondAppAdapter(own.host) },
      phase: "retarget",
      detail: "the new side of a move",
    },
  );
  requireReadableRecords(facts.apps, name);
  const server = ownServerFacts(facts);
  const beside = target(server.arch);
  const moving: DeployPlan = { ...plan, target: beside };

  // Its memory limits beside the first app's (its plan) and the other apps' (their records).
  const serverMb = server.memoryGb * 1024;
  const others: ServerApp[] = [
    { name, memoryMb: hostDescription(first.plan).memoryMb, tunnel: false },
    ...otherAppsMemory(facts).filter((other) => other.name !== app),
  ];
  const edgeMb = edgeMemoryMb(edgeProxy(first.plan));
  const memory = ownServerMemory(serverMb, appMemoryMb(moving), others, edgeMb);
  if (memory?.refused !== undefined) {
    // Design's figures, with the move's last sentence in place of design's "Nothing was written."
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${app} doesn't fit beside the apps on the server of "${name}": ${memory.refused.message.replace(/ Nothing was written\.$/, "")}`,
      `Lower the memory limits in ${planFile(deps)} (app.memoryMb, and those of the workers and services), or name the folder of another app whose server has more memory free; then run \`${AGAIN}\` again.`,
    );
  }
  if (memory?.warning !== undefined) deps.reporter.warn(memory.warning);

  // The second app's host plan, planned dry over the server as inspected: what it refuses stops
  // here, before any change.
  const deployPublicKey = await readDeployPublicKey(
    deps,
    `cannot check that ${app} fits beside "${name}"`,
  );
  const webSources = await ownWebSources(deps, moving, services.cloudflare);
  const desired = await desiredHost(
    deps,
    { session, facts, target: beside, first, ...(webSources === undefined ? {} : { webSources }) },
    { plan: moving, deployPublicKey },
  );
  const host = planHost(facts, desired, AGAIN, hostPlanOptions(moving));
  const blocked = host.steps.filter((step) => step.state === "blocked");
  if (host.findings.length > 0 || blocked.length > 0) {
    const reasons =
      host.findings.length > 0
        ? host.findings.map((finding) => finding.message)
        : blocked.map((step) => `${step.title}: ${step.reason ?? "blocked"}.`);
    const hints = [...new Set(host.findings.map((finding) => finding.hint))];
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `${app} can't run beside "${name}" on its server: ${reasons.join(" ")}`,
      hints.length > 0
        ? hints.join(" ")
        : `Fix what blocks it on the server, then run \`${AGAIN}\` again.`,
    );
  }

  return {
    target: beside,
    cost: noServerCost(
      `"${name}"'s server (priced with "${name}")`,
      plan.cost.monthly.currency,
      deps.clock.now().toISOString(),
    ),
    address: first.address,
    notes: [
      memoryText(moving, serverMb, edgeMb, undefined, undefined, quotedApps(others)),
      sharedPriceNote(name),
      sharedAccessWarning(name),
    ],
  };
}

/** The app's plan file, relative to the repository (`opscrew/plan.yaml` for its first app). */
function planFile(deps: Pick<PhaseDeps, "paths">): string {
  return toPosixRelative(deps.paths.root, deps.paths.files.plan);
}

/**
 * Stops before any change when the app has what changes the whole server, which is the first
 * app's (`first`): a private network (its other servers or its devices' VPN), Portainer, Beszel
 * or self-hosted monitoring. A second app's host plan holds only its own parts.
 */
function requireNothingServerWide(plan: DeployPlan, first: string): void {
  const app = plan.app.name;
  const network =
    plan.network === undefined
      ? []
      : [
          hasExtraServers(plan)
            ? `runs services on other servers (${listText(extraServers(plan))})`
            : "has a private network for your devices",
        ];
  const addons = [
    ...(plan.portainer?.enabled === true ? ["Portainer"] : []),
    ...(plan.observability?.beszel?.enabled === true ? ["Beszel"] : []),
    ...(monitoringOf(plan) !== undefined ? ["self-hosted monitoring"] : []),
  ];
  if (network.length === 0 && addons.length === 0) return;
  const off = [
    ...(plan.portainer?.enabled === true ? ["`opscrew portainer disable`"] : []),
    ...(plan.observability?.beszel?.enabled === true ? ["`opscrew addon disable beszel`"] : []),
    ...(monitoringOf(plan) !== undefined ? ["`opscrew addon disable monitoring`"] : []),
  ];
  const what = [...network, ...(addons.length === 0 ? [] : [`runs ${listText(addons)}`])];
  const one = network.length + addons.length === 1;
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `${app} ${listText(what)}, which ${one ? "changes" : "change"} the whole server, and the server of "${first}" is that app's: an app beside it changes only its own parts there.`,
    network.length > 0
      ? `Move ${app} to a server of its own instead (\`${RUN_COMMAND} --to <provider>\`).`
      : `Turn ${addons.length === 1 ? "it" : "them"} off first (${listText(off)}), then run \`${AGAIN}\` again; or move ${app} to a server of its own (\`${RUN_COMMAND} --to <provider>\`).`,
  );
}

/**
 * Stops before any change when the app's proxy (`target.edge`) is not the one the first app's
 * (`first`) server runs for every app on it.
 */
function requireSameEdge(
  deps: Pick<PhaseDeps, "paths">,
  plan: DeployPlan,
  first: DeployPlan,
): void {
  const mine = edgeProxy(plan);
  const theirs = edgeProxy(first);
  if (mine === theirs) return;
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `${plan.app.name}'s proxy is ${EDGE_PROXIES[mine].label} (target.edge in ${planFile(deps)}), and the server of "${first.app.name}" runs ${EDGE_PROXIES[theirs].label} for every app on it.`,
    `Switch ${plan.app.name} to ${EDGE_PROXIES[theirs].label} first (target.edge: ${theirs} in ${planFile(deps)}, then \`opscrew provision\`), or name the folder of an app whose server runs ${EDGE_PROXIES[mine].label}; then run \`${AGAIN}\` again.`,
  );
}

/**
 * Stops before any change when the app is served otherwise than the first app (`first`): behind
 * Cloudflare's proxy (the first app's cloud firewall then lets only Cloudflare in) or with DNS
 * only. Every app on the server is served the same way, and a move keeps how the app is served.
 */
function requireSameServing(plan: DeployPlan, first: DeployPlan): void {
  if (plan.dns.proxied === first.dns.proxied) return;
  const app = plan.app.name;
  const theirs = first.dns.proxied
    ? `"${first.app.name}" is served behind Cloudflare's proxy, so its server's firewall lets web traffic in only from Cloudflare`
    : `"${first.app.name}" is served with DNS only, so its server answers everyone on ports 80 and 443`;
  const mine = plan.dns.proxied ? "behind Cloudflare's proxy" : "with DNS only";
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `${theirs}, and ${app} is served ${mine}: the apps on one server are served the same way, and a move keeps how the app is served.`,
    `Name the folder of an app served ${mine} in server.shares, or move ${app} to a server of its own (\`${RUN_COMMAND} --to <provider>\`).`,
  );
}

/**
 * Stops before any change when the server holds a record OpsCrew can't read (written by a newer
 * OpsCrew, or damaged): that app's memory and hostnames are unknown.
 */
function requireReadableRecords(
  apps: readonly { name: string; record: unknown }[],
  first: string,
): void {
  const unreadable = apps
    .filter((other) => other.record === null)
    .map((other) => `"${other.name}"`);
  if (unreadable.length === 0) return;
  const one = unreadable.length === 1;
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `The server of "${first}" also runs ${listText(unreadable)}, whose record there OpsCrew can't read (written by a newer OpsCrew, or damaged), so OpsCrew doesn't know the memory ${one ? "it takes" : "they take"} or the hostnames ${one ? "it serves" : "they serve"}.`,
    `Run \`opscrew provision\` with a current OpsCrew in the repository of ${one ? "that app" : "each of them"}, which writes ${one ? "its" : "their"} record again, then run \`${AGAIN}\` here again.`,
  );
}
