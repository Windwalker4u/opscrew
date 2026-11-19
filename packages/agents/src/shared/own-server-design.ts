import {
  type HostFacts,
  inspectHost,
  planHost,
  readableRecords,
  tunnelOf,
} from "@opscrew/connector-ssh-host";
import { listText } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, readOptionalArtifact } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { onAppServer } from "../design/placement";
import type { OwnServerDesignInput, SharedServerDesignInput } from "../design/run";
import { commandFlags } from "../environments/choice";
import {
  hostDeployLogin,
  type PreviewServer,
  previewServer,
  refusedBeforeChange,
} from "../previews/host";
import type { OwnServerServices } from "../provision";
import { desiredHost, ownTarget, ownWebSources } from "../provision/own";
import { firstApp, hostDescription } from "../shares/first-app";
import { otherAppsMemory } from "../shares/guard";
import { secondAppLogin } from "../shares/login";
import { boundHostAdapter } from "./host-plan";
import { appMemoryMb } from "./memory";
import {
  connectOwnServer,
  inspectOwnServer,
  type OwnServerDeps,
  ownServerFacts,
} from "./own-server";
import { appServerShell } from "./server-address";
import { type OwnServerConnection, readOwnServer, type SharesReference } from "./server-record";
import { ensureDeployKey } from "./ssh-keys";

/** Options of {@link inspectOwnServerForDesign}. */
interface DesignInspectOptions {
  hostKey?: string;
  services?: OwnServerServices;
}

/** What design reads a server with: a second app's login also needs the clock. */
type DesignInspectDeps = OwnServerDeps & Pick<PhaseDeps, "clock">;

/**
 * What design needs from the user's own server: connects with the login the interview recorded
 * (confirming and pinning the host key on the first connection, see {@link connectOwnServer}) and
 * inspects the server read-only: its size, whether its CPU has AVX, the OpsCrew apps set up there
 * with their memory limits, its WireGuard interfaces and UDP ports in use (the port of the app's
 * private network there), and its board and the devices of its data (the Raspberry Pi warning).
 * For a server at home (`own.home`) it then reads the home's network in the same session, through
 * the host adapter's `detectHomeNetwork`. A preview environment on another environment's server
 * (`previews.server`) gets that server's ({@link sharedServerDesign}), and a second app on the
 * server OpsCrew created for another app (`own.shares`) that one's ({@link secondAppDesign}).
 * Design itself never connects.
 */
export async function inspectOwnServerForDesign(
  deps: DesignInspectDeps,
  options: DesignInspectOptions = {},
): Promise<OwnServerDesignInput> {
  const plan = await readOptionalArtifact("plan", deps.paths.files.plan);
  if (plan?.environment?.previews?.server !== undefined) {
    return sharedServerDesign(await previewServer(deps, plan), options);
  }
  const own = await readOwnServer(deps.paths);
  if (own?.shares !== undefined) return secondAppDesign(deps, own, own.shares, plan, options);
  const host = options.services?.host;
  deps.reporter.step("Connecting to your server to read its size (read-only)");
  const session = await connectOwnServer(deps, options);
  const inspected = await inspectOwnServer(
    session,
    host === undefined ? {} : { inspect: (shell) => host.inspect(shell) },
  );
  const { facts } = inspected;
  // A server at home: what it sees of its network, read again on every run and never persisted.
  const homeNetwork =
    session.connection.home === undefined
      ? undefined
      : await boundHostAdapter(host).detectHomeNetwork(session.remote);
  return {
    facts: inspected.server,
    apps: activeApps(facts),
    avx: facts.avx,
    network: { udpPortsInUse: facts.udpPortsInUse, wireguardInterfaces: facts.wireguardInterfaces },
    board: facts.board,
    storage: facts.storage,
    ...(homeNetwork === undefined ? {} : { homeNetwork }),
  };
}

/** The OpsCrew apps set up on a server, with their memory limits, from its inspected facts. */
function activeApps(
  facts: Pick<HostFacts, "apps" | "tunnels">,
): NonNullable<OwnServerDesignInput["apps"]> {
  return readableRecords(facts.apps)
    .filter((record) => record.state === "active")
    .map((record) => ({
      name: record.app,
      memoryMb: record.memoryMb,
      tunnel: tunnelOf(facts, record.app).installed,
    }));
}

/**
 * What design needs from the server previews share with another environment (spec.md US9), reached
 * as `server` reaches it: inspected read-only (the user's own through the host's recorded admin
 * login, as {@link inspectOwnServerForDesign} does; one OpsCrew created as the host's `deploy`,
 * root through Docker in the pinned image), served behind Cloudflare's proxy, and the host
 * environment's own needs (its plan's memory limits on its server) in place of its record among
 * the apps, so design fits the previews into what is left.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no deploy login there.
 */
export async function sharedServerDesign(
  server: PreviewServer<DesignInspectDeps>,
  options: DesignInspectOptions = {},
): Promise<OwnServerDesignInput> {
  const { deps, plan, host } = server;
  let input: OwnServerDesignInput;
  if (plan.target.provider === "own") {
    input = await inspectOwnServerForDesign(deps, options);
  } else {
    deps.reporter.step(`Connecting to ${host}'s server to read its size (read-only)`);
    const remote = await appServerShell(deps, plan, await hostDeployLogin(server));
    const adapter = options.services?.host;
    const facts =
      adapter === undefined
        ? await inspectHost(remote, { rootImage: IMAGES.caddy.ref })
        : await adapter.inspect(remote);
    input = { facts: ownServerFacts(facts), apps: activeApps(facts), avx: facts.avx };
  }
  const app = plan.app.name;
  return {
    ...input,
    apps: [
      { name: app, memoryMb: appMemoryMb(onAppServer(plan)), tunnel: false },
      ...(input.apps ?? []).filter((other) => other.name !== app),
    ],
    access: "public",
    serving: "proxy",
  };
}

/**
 * What design needs from the server a second app shares with the first app, the one OpsCrew
 * created it for (`own.shares`, plan 7.): the first app as its folder on this computer describes
 * it (`firstApp`, which refuses a server that can't take another app), and the server read-only
 * through the deploy login (`secondAppLogin`: the first app's deploy key until this app's own is
 * installed), root through Docker in the pinned image, so the other apps' records are read too.
 * The first app's memory limits (from its plan) and the other apps' (from their records, without
 * this app's own on a later design, `plan`) are the apps design fits this one beside, and the site
 * is served as the first app's is: behind Cloudflare's proxy, or DNS only.
 * @throws OpsCrewError `PHASE_PRECONDITION` from `firstApp` or the login, and when a record there
 * can't be read (that app's memory and hostnames are unknown), each before anything is written.
 */
async function secondAppDesign(
  deps: DesignInspectDeps,
  own: OwnServerConnection,
  ref: SharesReference,
  plan: DeployPlan | undefined,
  options: DesignInspectOptions,
): Promise<OwnServerDesignInput> {
  deps.reporter.step("Connecting to the server this app shares to read its size (read-only)");
  const login = await secondAppLogin(
    deps,
    ref,
    own,
    options.services === undefined ? {} : { services: options.services },
  );
  const first = login.first ?? (await firstApp(deps, ref));
  const adapter = options.services?.host;
  const { remote } = login.session;
  const facts =
    adapter === undefined
      ? await inspectHost(remote, { rootImage: IMAGES.caddy.ref })
      : await adapter.inspect(remote);
  const name = first.plan.app.name;
  const unreadable = facts.apps.filter((app) => app.record === null).map((app) => `"${app.name}"`);
  if (unreadable.length > 0) {
    const one = unreadable.length === 1;
    const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      `The server of "${name}" also runs ${listText(unreadable)}, whose record there OpsCrew can't read (written by a newer OpsCrew, or damaged), so OpsCrew doesn't know the memory ${one ? "it takes" : "they take"} or the hostnames ${one ? "it serves" : "they serve"}.`,
      `Run \`opscrew provision\` with a current OpsCrew in the repository of ${one ? "that app" : "each of them"}, which writes ${one ? "its" : "their"} record again, then run \`opscrew design${flags}\` here again.`,
    );
  }
  const described = hostDescription(first.plan);
  return {
    facts: ownServerFacts(facts),
    apps: [
      { name, memoryMb: described.memoryMb, tunnel: false },
      ...otherAppsMemory(facts).filter((app) => app.name !== plan?.app.name),
    ],
    avx: facts.avx,
    access: "public",
    serving: first.plan.dns.proxied ? "proxy" : "dns-only",
    shares: { first: first.plan, facts, session: login.session },
  };
}

/**
 * Design's look ahead at a second app's host plan (plan 7., step 7): the plan its provision would
 * make over the server as design read it (`shares`), in the second-app mode, whose blocking
 * findings stop design before plan.yaml is written: a name or hostname another app there holds,
 * a name read as another app's preview, a kernel setting only the first app's setup may change,
 * a login that can't write the app's record. Nothing is applied or saved. The plan describes this
 * app's deploy key, made now when it has none (provision uses the same one), and behind
 * Cloudflare's proxy Cloudflare's IP ranges, read as provision reads them.
 * @throws OpsCrewError `PHASE_PRECONDITION` naming each finding, before anything is written.
 */
export async function requireSecondAppFits(
  deps: PhaseDeps,
  shares: SharedServerDesignInput,
  plan: DeployPlan,
): Promise<void> {
  const { session, facts, first } = shares;
  const key = await ensureDeployKey(deps.paths, deps.redactor);
  const webSources = await ownWebSources(deps, plan);
  const desired = await desiredHost(
    deps,
    {
      session,
      facts,
      target: ownTarget(plan),
      first: { plan: first },
      ...(webSources === undefined ? {} : { webSources }),
    },
    { plan, deployPublicKey: key.publicKeyOpenSsh },
  );
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const host = planHost(facts, desired, `opscrew design${flags}`, {
    image: IMAGES.busybox.ref,
  });
  const blocked = host.steps.filter((step) => step.state === "blocked");
  if (host.findings.length === 0 && blocked.length === 0) return;
  const reasons =
    host.findings.length > 0
      ? host.findings.map((finding) => finding.message)
      : blocked.map((step) => `${step.title}: ${step.reason ?? "blocked"}.`);
  const hints = [...new Set(host.findings.map((finding) => finding.hint))];
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `This app can't run beside "${first.app.name}" on its server: ${reasons.join(" ")}`,
    hints.length > 0
      ? hints.join(" ")
      : `Fix what blocks it on the server, then run \`opscrew design${flags}\` again.`,
  );
}
