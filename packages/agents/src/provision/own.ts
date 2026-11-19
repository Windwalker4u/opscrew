import { join } from "node:path";
import { CloudflareClient, cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  type DesiredHost,
  type DesiredRunner,
  type HostFacts,
  type HostPlan,
  inspectHost,
  otherActiveApps,
  planAddon,
  planHost,
  planTeardown,
  planUndo,
} from "@opscrew/connector-ssh-host";
import type { IacEngine, PhaseName } from "@opscrew/contracts";
import { OpsCrewError, type ProjectPaths, plural, sha256Hex, toPosixRelative } from "@opscrew/core";
import {
  addressUpdaterName,
  drillName,
  homeIpv4,
  homeIpv6Proxied,
  homeMode,
  hostSysctl,
  IMAGES,
  keepNewerPins,
  type OwnAccessMode,
  ownAccessMode,
  renderPortainerCompose,
  renderTunnelConnectorCompose,
  siteHosts,
  sshHostname,
  usesTunnel,
  wrongTarget,
} from "@opscrew/iac-templates";
import {
  APP_SERVER,
  type DeployPlan,
  type OwnDeployTarget,
  servicesOn,
} from "@opscrew/plan-schema";
import type { CheckKey } from "../check/key";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { homeForwards, homeForwardsInput } from "../home/forwards";
import {
  classifyHomeNetwork,
  type HomeNetworkClass,
  readHomeNetwork,
  sshSourcesUnknown,
} from "../home/network";
import { carrierNatWarning } from "../home/texts";
import { checkUpdaterToken, UPDATER_TOKEN_VAR } from "../home/token";
import { serverNetworkInputs } from "../network";
import {
  applyRunnerSettings,
  lazyRepository,
  planServerRunner,
  type RunnerRepository,
  removeKeptRegistrations,
  repositoryUrl,
  runnerTokens,
} from "../runners";
import {
  addressFromOutputs,
  appMemoryMb,
  approveAndApplyHostPlan,
  committedText,
  ensureSecretFile,
  gitClient,
  githubCoordinates,
  type HostAdapterApi,
  type HostPlanOutcome,
  knownHostsName,
  randomPassword,
  readOwnServer,
  readSecretFile,
  readServerAddresses,
  recordOwnServer,
  requireNoBlockers,
  type SecretFile,
  type ServerAddress,
  setAddressVariables,
  stringOutput,
  updateServerAddresses,
} from "../shared";
import { boundHostAdapter, keepServerSetup } from "../shared/host-plan";
import {
  connectAndInspectOwnServer,
  connectExtraServer,
  inspectOwnHost,
  type OwnServerSession,
  ownServerLoginCheck,
  ownServerNotSetUp,
  ownServerPublicAddress,
  readOwnServerRecord,
} from "../shared/own-server";
import { networkSshPort } from "../shared/server-address";
import type { SharesReference } from "../shared/server-record";
import {
  type ConnectorFirst,
  connectorFirst,
  type HostChangeResult,
  tunnelChange,
} from "../shared/tunnel-connections";
import { type FirstApp, firstApp, hostDescription } from "../shares/first-app";
import { secondAppLogin } from "../shares/login";
import { readShares } from "../shares/reference";
import { hasAppInterface } from "../vpn/dashboards";
import { type CloudflareSetup, cloudflareTokenMissing } from "./credentials";
import { desiredDrills, drillEnv } from "./drills";
import { type PlanAndApplyResult, planAndApply } from "./plan-apply";
import type { ServerReach } from "./secrets";
import type {
  CloudflareApi,
  OwnServerServices,
  ProvisionOptions,
  ProvisionServices,
} from "./types";

/** Cloudflare's IP ranges, the only sources of web traffic when the site is served directly behind the proxy. */
export type OwnWebSources = NonNullable<DesiredHost["webFilter"]>;

/**
 * What provision read of a server at home this run (`homeMode`). It holds no public address: the
 * home's addresses are detected again on every run and stay in the run's memory (a proxied app's
 * registered with the redactor).
 */
export interface OwnHomeRun {
  /** The classification of what the server sees of its network. */
  network: HomeNetworkClass;
  /** The server's address on the home network, which the router forwards to (none without NAT). */
  lanAddress?: string;
  /** The networks that may reach SSH (`.opscrew/server.json` → `own.home.sshFrom`). */
  sshFrom: string[];
  /**
   * The address updater, with the domain's DNS on Cloudflare: the zone, the record's name and,
   * when given this run and checked, its token (on standard input at apply, never kept).
   */
  updater?: { zoneId: string; name: string; token?: string };
}

/** What provision knows about the user's own server once it connected and inspected it. */
export interface OwnServerRun {
  session: OwnServerSession;
  facts: HostFacts;
  target: OwnDeployTarget;
  /** Public mode: the addresses DNS points to (local state only, never committed); none at home. */
  address?: ServerAddress;
  /** A server at home ({@link OwnHomeRun}). */
  home?: OwnHomeRun;
  /**
   * Served directly behind Cloudflare's proxy ({@link ownWebFromCloudflare}): Cloudflare's IP
   * ranges as read at the start of this run, for the host plan's web filter.
   */
  webSources?: OwnWebSources;
  /**
   * The SSH port the deploy reaches: in public mode the login's port (GitHub Actions connects to
   * the public address as the user does, through any router forwarding it); in tunnel mode the
   * port sshd listens on, on the server (the tunnel's SSH route, `ssh://localhost:<port>`).
   */
  sshPort: number;
  host: HostAdapterApi;
  /** Opens new SSH connections as the deploy user and the admin login (see `ownServerLoginCheck`). */
  verifyLogin: () => Promise<boolean>;
  /**
   * The app's GitHub Actions runner (`environment.runner: server`), in every host plan of the run;
   * absent, a runner the app has on the server is removed.
   */
  runner?: DesiredRunner;
  /** The project's GitHub repository, for the runner's tokens and registrations (read when needed). */
  repository: () => Promise<RunnerRepository>;
  /**
   * A second app (`target.shares`): the first app whose server OpsCrew created, as this computer
   * knows it. Its address is the one DNS points to and GitHub's machines reach.
   */
  first?: FirstApp;
}

/** An extra server the user owns (`plan.servers[]`), once provision connected and inspected it. */
export interface ExtraOwnServerRun {
  /** Its name in the plan. */
  name: string;
  session: OwnServerSession;
  facts: HostFacts;
  host: HostAdapterApi;
  /** Opens new SSH connections as the deploy user and the admin login (see `ownServerLoginCheck`). */
  verifyLogin: () => Promise<boolean>;
}

/** Placeholder tunnel id for the check before anything changes (the real one comes from the apply). */
const PENDING_TUNNEL_ID = "00000000-0000-0000-0000-000000000000";

/** The target of an own-server plan; any other here is a bug in OpsCrew. */
export function ownTarget(plan: Pick<DeployPlan, "target">): OwnDeployTarget {
  if (plan.target.provider !== "own") {
    throw wrongTarget("This step only applies to a server you already own.");
  }
  return plan.target;
}

/**
 * The first app whose server this app shares (`target.shares`: its name and provider), or
 * `undefined` when the app is not a second app on a server OpsCrew created.
 */
export function sharesOf(plan: Pick<DeployPlan, "target">): OwnDeployTarget["shares"] {
  return plan.target.provider === "own" ? plan.target.shares : undefined;
}

/**
 * The shared-access warning (spec FR-3004), said in the second app `app`'s host plan approval:
 * both apps run as the deploy user of the server OpsCrew created for `first`.
 */
export function sharedAccessWarning(app: string, first: string): string {
  return `Anyone who can change the deploy workflow or the deploy key of "${app}" can reach the data and secrets of "${first}" too: both apps run as the same deploy user on this server, and that user can become root through Docker.`;
}

/**
 * The host adapter of a second app on a server OpsCrew created: the deploy login reads the apps'
 * records and runs the app's only root step (its record) as root through Docker, in the edge's
 * pinned image. `host` (a fake in tests) replaces ssh-host's `inspectHost` and `applyHostPlan`.
 */
export function secondAppAdapter(host?: HostAdapterApi): Required<HostAdapterApi> {
  const bound = boundHostAdapter(host);
  const rootImage = IMAGES.caddy.ref;
  return {
    ...bound,
    inspect: host === undefined ? (remote) => inspectHost(remote, { rootImage }) : bound.inspect,
    apply: (remote, plan, options) => bound.apply(remote, plan, { ...options, rootImage }),
  };
}

/** `planHost`'s options for `plan`: a second app's plan names the image its data is removed in. */
export function hostPlanOptions(plan: DeployPlan): { image?: string } {
  return sharesOf(plan) === undefined ? {} : { image: IMAGES.busybox.ref };
}

/** The server in a host plan's words: `your server`, or the server of the first app. */
function serverWords(plan: DeployPlan): string {
  const shares = sharesOf(plan);
  return shares === undefined ? "your server" : `the server of "${shares.app}"`;
}

/** `~/.opscrew/projects/<id>/portainer_password` (0600): Portainer's admin password, local only. */
export function portainerPasswordFile(paths: Pick<ProjectPaths, "projectHomeDir">): string {
  return join(paths.projectHomeDir, "portainer_password");
}

/** Portainer's admin password: at least 12 characters (OpsCrew writes 32). */
function portainerPassword(paths: Pick<ProjectPaths, "projectHomeDir">): SecretFile {
  const file = portainerPasswordFile(paths);
  return {
    file,
    valid: (value) => value.length >= 12,
    damaged: {
      message: `The Portainer admin password OpsCrew keeps for this project (${file}) is damaged, so OpsCrew stopped instead of making a new one: Portainer's admin account may already use it. Nothing was changed.`,
      hint: "Put the password back from a backup of that file, then run the command again. If Portainer has no admin account yet, delete the file instead: OpsCrew then makes a new password.",
    },
  };
}

/**
 * Portainer's admin password from {@link portainerPasswordFile}, generated on this computer (32
 * random letters and digits, mode 0600) when the file does not exist yet; a damaged one stops and
 * is never replaced. Never printed.
 */
export async function ensurePortainerPassword(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
): Promise<string> {
  const password = await ensureSecretFile(portainerPassword(deps.paths), () => randomPassword(32));
  deps.redactor.addLiteral(password, "portainer-password");
  return password;
}

/**
 * The password to send when Portainer is started: a new one only when Portainer has no data yet
 * (`required`), else the one in {@link portainerPasswordFile} when it is on this computer. Sending
 * it whenever it exists means the first-start Compose file is used, so a Portainer whose earlier
 * first start stopped before the admin existed still gets its admin; Portainer ignores it when an
 * admin exists. `undefined` when it is not required and not on this computer; a damaged one stops.
 */
export async function portainerPasswordToSend(
  deps: Pick<PhaseDeps, "paths" | "redactor">,
  required: boolean,
): Promise<string | undefined> {
  if (required) return ensurePortainerPassword(deps);
  const existing = await readSecretFile(portainerPassword(deps.paths));
  if (existing !== undefined) deps.redactor.addLiteral(existing, "portainer-password");
  return existing;
}

/**
 * True when the user's own server serves the site directly behind Cloudflare's proxy (the user's
 * explicit choice): public mode, the domain on Cloudflare, proxied, and `security.httpAllowedFrom:
 * cloudflare` (the plan schema refuses `any` there). The host plan's web filter then lets only
 * Cloudflare's IP ranges reach the web ports Docker publishes, as the cloud firewall does on
 * Hetzner and DigitalOcean.
 */
export function ownWebFromCloudflare(plan: DeployPlan): boolean {
  return (
    plan.target.provider === "own" &&
    plan.target.access === "public" &&
    plan.dns.provider === "cloudflare" &&
    plan.dns.proxied &&
    plan.security.httpAllowedFrom === "cloudflare"
  );
}

function rangesUnreadable(cause?: unknown): OpsCrewError {
  return new OpsCrewError(
    "PROVIDER_ERROR",
    "OpsCrew could not read Cloudflare's IP ranges, which your server's web filter needs so that only Cloudflare can reach the app's web ports. Nothing was changed.",
    {
      hint: "Check this computer's internet connection (OpsCrew reads https://api.cloudflare.com/client/v4/ips, which needs no token), then run the command again. OpsCrew never opens the web ports to every address instead.",
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}

/**
 * Cloudflare's current IP ranges for an own server behind Cloudflare's proxy
 * ({@link ownWebFromCloudflare}); `undefined` for any other plan. The IPv4 ranges, and the IPv6
 * ones too for a server at home served over IPv6 behind the proxy (`homeIpv6Proxied`). Read from
 * `api` (the provision services' Cloudflare client) or, without one, from Cloudflare's public
 * endpoint (no token). Throws `PROVIDER_ERROR` in plain English when they cannot be read: OpsCrew
 * never falls back to opening the web ports to every address.
 */
export async function ownWebSources(
  deps: Pick<PhaseDeps, "fetch" | "version">,
  plan: DeployPlan,
  api?: Pick<CloudflareApi, "getIpRanges"> | null,
): Promise<OwnWebSources | undefined> {
  if (!ownWebFromCloudflare(plan)) return undefined;
  const client = api ?? new CloudflareClient({ fetch: deps.fetch, version: deps.version });
  let ranges: { ipv4: string[]; ipv6: string[] };
  try {
    ranges = await client.getIpRanges();
  } catch (error) {
    throw rangesUnreadable(error);
  }
  const ipv6 = homeIpv6Proxied(plan);
  if (ranges.ipv4.length === 0 || (ipv6 && ranges.ipv6.length === 0)) throw rangesUnreadable();
  return { ipv4: [...ranges.ipv4], ...(ipv6 ? { ipv6: [...ranges.ipv6] } : {}) };
}

/**
 * The desired state of the server for the plan: the app and the project's repository (the
 * `origin` remote: no host plan touches another repository's runner), the admin login, the deploy key, SSH and
 * firewall settings for the access mode, the tunnel connector (with the tunnel's id) whenever the
 * plan has a Cloudflare Tunnel (tunnel mode, or a Portainer subdomain in either mode), Portainer
 * when the plan turns it on, and the web filter with Cloudflare's ranges (`run.webSources`) when
 * the site is served directly behind Cloudflare's proxy. The connector's Compose file keeps the
 * newer pins of its committed copy, so the server runs what Dependabot updated. A server at home
 * ({@link homeHost}) also gets SSH only from the home network, `home` in the app's record and,
 * with its DNS on Cloudflare, the address updater. With `snapshots.drills.schedule`, the scheduled
 * restore drills ({@link desiredDrills}). A second app (`target.shares`) also describes the first
 * app (`shares.host`, from `run.first`, else read through this app's reference), so the host plan
 * holds only the app's own steps; the web filter then only says it is served behind the proxy.
 * @throws Error when the plan needs the web filter but `run.webSources` is missing, or is served
 * at home but `run.home` is missing: a host plan must never drop the filter, the SSH firewall or
 * the address updater because the server was not read.
 * @throws OpsCrewError from `firstApp` when a second app's first app is not on this computer.
 */
export async function desiredHost(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "clock">,
  run: Pick<OwnServerRun, "session" | "facts" | "target" | "webSources" | "runner" | "first"> & {
    home?: Pick<OwnHomeRun, "sshFrom" | "updater">;
  },
  input: {
    plan: DeployPlan;
    deployPublicKey: string;
    tunnelId?: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    /**
     * No tunnel connector even when the plan has a tunnel: the host change that goes before a plan
     * deletes the current tunnel (Cloudflare refuses that while the connector runs).
     */
    withoutTunnel?: boolean;
  },
): Promise<DesiredHost> {
  const { plan } = input;
  const filtered = ownWebFromCloudflare(plan);
  if (filtered && run.webSources === undefined) {
    throw new Error("The web filter needs Cloudflare's IP ranges (read them with ownWebSources).");
  }
  if (homeMode(plan) && run.home === undefined) {
    throw new Error("A server at home needs what prepareOwnServer read of it (run.home).");
  }
  const connector = renderTunnelConnectorCompose(plan);
  const tunnel =
    usesTunnel(plan) && input.withoutTunnel !== true
      ? {
          compose: keepNewerPins(
            await committedText(deps.paths.root, [connector.path]),
            connector.content,
          ),
          tunnelId: input.tunnelId ?? PENDING_TUNNEL_ID,
        }
      : undefined;
  // Portainer's web UI is also on the private address only while the server hosts this app alone,
  // and once that address is on the server: Docker never binds an address that isn't there.
  const dashboards = dashboardsOnNetwork(plan, run.facts) && hasAppInterface(plan, run.facts);
  const portainer = plan.portainer?.enabled
    ? {
        version: plan.portainer.version,
        compose: {
          initial: renderPortainerCompose(plan, {
            initialAdmin: true,
            dashboardsOnNetwork: dashboards,
          }).content,
          final: renderPortainerCompose(plan, {
            initialAdmin: false,
            dashboardsOnNetwork: dashboards,
          }).content,
        },
      }
    : undefined;
  // Kernel settings the services need (vm.max_map_count for the search engines).
  const sysctl = hostSysctl(plan);
  const drills = await desiredDrills(deps, plan);
  const first =
    run.target.shares === undefined ? undefined : (run.first ?? (await readFirst(deps)));
  return {
    ...(await hostLogin(deps, run, input)),
    hostnames: siteHosts(plan),
    services: plan.services.filter((service) => service.enabled).map((service) => service.name),
    memoryMb: appMemoryMb(plan),
    access: run.target.access,
    ...(tunnel !== undefined ? { tunnel } : {}),
    ...(portainer !== undefined ? { portainer } : {}),
    ...(Object.keys(sysctl).length > 0 ? { sysctl } : {}),
    ...(run.runner !== undefined ? { runner: run.runner } : {}),
    ...(filtered && run.webSources !== undefined ? { webFilter: run.webSources } : {}),
    ...(homeMode(plan) && run.home !== undefined ? homeHost(plan, run.home) : {}),
    ...(drills !== undefined ? { drills } : {}),
    ...(first !== undefined ? { shares: { host: hostDescription(first.plan) } } : {}),
  };
}

/**
 * The first app of the second app `deps.paths` belongs to, read through its reference
 * (`own.shares`) as {@link firstApp} reads it.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no reference, or from `firstApp`.
 */
async function readFirst(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "clock">,
): Promise<FirstApp> {
  const ref = await readShares(deps.paths);
  if (ref === undefined) throw sharesUnknown();
  return firstApp(deps, ref);
}

/** The stop when the plan shares another app's server but this computer has no reference to it. */
function sharesUnknown(): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    "opscrew/plan.yaml runs the app beside another app on its server, but this computer doesn't know where that app's repository folder is (.opscrew/server.json has no reference to it). Nothing was changed.",
    {
      hint: "Run `opscrew interview` and name that app's repository folder, or run the command on the computer that set this app up.",
    },
  );
}

/**
 * A server at home's part of the desired host: SSH only from `sshFrom`, `home` in the app's
 * record, and with the DNS on Cloudflare the address updater, which keeps the A record when the
 * site is served over IPv4 and the AAAA record over IPv6 (with DNS only, also beside the A, while
 * the server has IPv6). The token's SHA-256 is in the plan only when its token is sent at apply.
 */
function homeHost(
  plan: DeployPlan,
  home: Pick<OwnHomeRun, "sshFrom" | "updater">,
): Pick<DesiredHost, "home" | "sshFrom" | "dnsUpdater"> {
  const ipv4 = homeIpv4(plan);
  const { proxied } = plan.dns;
  const { updater } = home;
  return {
    home: { ipv4 },
    sshFrom: [...home.sshFrom],
    ...(updater === undefined
      ? {}
      : {
          dnsUpdater: {
            zoneId: updater.zoneId,
            name: updater.name,
            proxied,
            ipv4,
            ipv6: !proxied || !ipv4,
            ...(updater.token === undefined ? {} : { tokenSha256: sha256Hex(updater.token) }),
          },
        }),
  };
}

/**
 * True when the dashboards (Beszel's hub, Portainer's web UI) are also published on the app's
 * server's private address, as the network's host plans and drift say (`serverNetworkInputs`):
 * the network has devices, and the app's server hosts this app alone (always so on a server
 * OpsCrew created, which has no `facts` here; on the user's own, no other OpsCrew app is active
 * there), so its dashboards are this app's.
 */
export function dashboardsOnNetwork(plan: DeployPlan, facts?: Pick<HostFacts, "apps">): boolean {
  const alone = facts === undefined || otherActiveApps(facts.apps, plan.app.name).length === 0;
  return serverNetworkInputs(plan, APP_SERVER, alone).dashboardsOnNetwork;
}

/**
 * True when the dashboards should be on the app's server's private address
 * ({@link dashboardsOnNetwork}) but wait for the next provision: the server does not have the
 * private network's interface yet, which the network host plan sets up.
 */
export function dashboardsWaitForNetwork(
  plan: DeployPlan,
  facts: Pick<HostFacts, "apps" | "network">,
): boolean {
  return dashboardsOnNetwork(plan, facts) && !hasAppInterface(plan, facts);
}

/** True when Portainer's web UI waits for the private network ({@link dashboardsWaitForNetwork}). */
export function portainerWaitsForNetwork(
  plan: DeployPlan,
  facts: Pick<HostFacts, "apps" | "network">,
): boolean {
  return plan.portainer?.enabled === true && dashboardsWaitForNetwork(plan, facts);
}

/**
 * What every server the user owns gets in its desired state: the app, the logins and SSH, which
 * stays off the public firewall once public SSH is closed (`network.publicSsh: false`).
 */
async function hostLogin(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  run: Pick<OwnServerRun, "session" | "facts">,
  input: { plan: DeployPlan; deployPublicKey: string; passwordLogins?: "off" | "keep" },
): Promise<
  Pick<
    DesiredHost,
    | "app"
    | "projectId"
    | "repositoryUrl"
    | "admin"
    | "deploy"
    | "sshPort"
    | "hostKeyType"
    | "disablePasswords"
    | "publicSsh"
  >
> {
  const { connection } = run.session;
  return {
    app: input.plan.app.name,
    projectId: deps.paths.projectId,
    repositoryUrl: repositoryUrl(await githubCoordinates(gitClient(deps))),
    admin: {
      user: run.facts.user || connection.user,
      isRoot: run.facts.privilege === "root",
    },
    deploy: { user: "deploy", publicKey: input.deployPublicKey.trim() },
    sshPort: connection.port,
    // The pinned key's ssh-keyscan type; planHost refuses any other.
    hostKeyType: run.session.hostKey.type as DesiredHost["hostKeyType"],
    ...(input.passwordLogins !== undefined
      ? { disablePasswords: input.passwordLogins === "off" }
      : {}),
    // Public SSH closed: ufw keeps SSH on the private network's interface only.
    ...(input.plan.network?.publicSsh === false ? { publicSsh: false as const } : {}),
  };
}

/**
 * The desired state of an extra server the user owns (`plan.servers`, ADR 0022): the own-server
 * setup an app's server gets (Docker, the deploy user and key, SSH and ufw), for the services
 * placed there only. It serves no site, so it has no hostnames, tunnel, Portainer or runner.
 */
export async function desiredExtraHost(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">,
  run: Pick<ExtraOwnServerRun, "name" | "session" | "facts">,
  input: { plan: DeployPlan; deployPublicKey: string; passwordLogins?: "off" | "keep" },
): Promise<DesiredHost> {
  const services = servicesOn(input.plan, run.name);
  const sysctl = hostSysctl(input.plan, run.name);
  return {
    ...(await hostLogin(deps, run, input)),
    hostnames: [],
    services: services.map((service) => service.name),
    memoryMb: services.reduce((sum, service) => sum + service.memoryMb, 0),
    access: "public",
    web: false,
    ...(Object.keys(sysctl).length > 0 ? { sysctl } : {}),
  };
}

/**
 * Stops before any change when the plan runs MongoDB on `server` (the app's, or an extra one the
 * user owns), an x86 server whose CPU lacks AVX, which MongoDB 5 and later need (FR-1312): the
 * inspected CPU flags say so.
 */
function requireMongoAvx(
  plan: DeployPlan,
  facts: Pick<HostFacts, "arch" | "avx">,
  server = APP_SERVER,
): void {
  const mongo = servicesOn(plan, server).find((service) => service.kind === "mongodb");
  if (mongo === undefined || facts.arch !== "amd64" || facts.avx) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `${server === APP_SERVER ? "Your server's" : `Server ${server}'s`} CPU lacks AVX, which MongoDB needs on x86 since version 5, so the service ${mongo.name} could not start there. Nothing was changed.`,
    {
      hint: "Run the app on a server with a newer CPU (most x86 CPUs since 2011 have AVX), or use a hosted MongoDB such as MongoDB Atlas: put its mongodb+srv:// address in the app's settings, then run `opscrew analyze`, `opscrew design` and `opscrew provision` again (OpsCrew keeps a hosted MongoDB as it is).",
    },
  );
}

/** The phases that change a server the user owns through its host plan (a move's new side too). */
type OwnHostPhase = Extract<
  PhaseName,
  "provision" | "dns" | "portainer" | "retarget" | "cloudflare-move"
>;

/**
 * Connects to the user's own server (host key confirmed or `--host-key`, pinned), inspects it
 * read-only (audited as `phase`), and stops before any change when the host plan would be blocked:
 * an unsupported system, another firewall or web server, another OpsCrew app on the server that
 * holds one of the app's hostnames, its name or another access mode, an app without a domain next
 * to another, a password choice to make, and so on (the stop says to run `command` again). Other
 * OpsCrew apps on the server are welcome otherwise: the host plan sets up only what this app needs
 * that is not there yet. Also checks that the plan's architecture is the server's, and in public
 * mode finds the public address DNS points to. A server at home ({@link prepareHome}) has no such
 * address: it reads the home's network instead, and checks the address updater's token.
 *
 * A second app on a server OpsCrew created (`target.shares`) is connected as `secondAppLogin`
 * logs in (the first app's deploy login until its own key is installed) and inspected as root
 * through Docker ({@link secondAppAdapter}); its host plan is checked against the first app as
 * its plan describes it ({@link firstApp}), whose address DNS points to.
 */
export async function prepareOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    options: Pick<ProvisionOptions, "hostKey" | "passwordLogins" | "planOnly">;
    services: ProvisionServices;
    deployPublicKey: string;
    deployKeyFile: string;
    phase: OwnHostPhase;
    /** The command a stop says to run again, for example `opscrew portainer enable`. */
    command: string;
    /** The connection and inspection made earlier in this run (a preview environment's). */
    inspected?: { session: OwnServerSession; facts: HostFacts };
    /**
     * The app's Cloudflare zone (`setupCloudflare`), which a server at home's address updater
     * keeps the records in. Without it the updater stays as the server has it.
     */
    cloudflare?: Pick<CloudflareSetup, "zoneId" | "zoneName" | "accountId">;
  },
): Promise<OwnServerRun> {
  const { plan } = input;
  const target = ownTarget(plan);
  const own = input.services.own ?? {};
  // Bound, so `run.host.apply` can be passed on as a function.
  const host =
    target.shares === undefined ? boundHostAdapter(own.host) : secondAppAdapter(own.host);
  if (target.access === "tunnel") sshHostname(plan); // a tunnel needs a Cloudflare domain
  // Behind Cloudflare's proxy the firewall needs Cloudflare's current ranges; read them first, so
  // a failure stops before anything is changed.
  const webSources = await ownWebSources(deps, plan, input.services.cloudflare);
  const second =
    target.shares === undefined
      ? undefined
      : await connectSecondApp(deps, plan, { services: { ...own, host }, phase: input.phase });
  // Provision compares a second app with the first app's plan, read from its folder.
  const first =
    second === undefined ? undefined : (second.first ?? (await firstApp(deps, second.ref)));
  const { session, facts } =
    second ??
    input.inspected ??
    (await connectAndInspectOwnServer(deps, {
      hostKey: input.options.hostKey,
      services: { ...own, host },
      phase: input.phase,
    }));
  if ((facts.arch === "amd64" || facts.arch === "arm64") && facts.arch !== target.arch) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml builds the app for ${target.arch}, but your server is ${facts.arch}. Nothing was changed.`,
      {
        hint: `Run \`opscrew design\` again so OpsCrew builds the image for ${facts.arch}, then run \`opscrew provision\` again.`,
      },
    );
  }
  requireMongoAvx(plan, facts);
  const repo = lazyRepository(deps, input.services.runnerGitHub);
  // The server's runner, after the repository's check (a public one needs its own approval).
  const runner =
    plan.environment?.runner === "server"
      ? await planServerRunner(await repo(), plan, {
          arch: target.arch,
          host: session.connection.host,
        })
      : {};
  const home = homeMode(plan)
    ? await prepareHome(deps, {
        plan,
        session,
        facts,
        host,
        phase: input.phase,
        command: input.command,
        ...(input.cloudflare !== undefined ? { cloudflare: input.cloudflare } : {}),
      })
    : undefined;
  const run: OwnServerRun = {
    session,
    facts,
    target,
    ...(home !== undefined ? { home } : {}),
    // Public mode: the login's port, which differs from sshd's when a router forwards it (2222 to
    // 22). Only the tunnel's SSH route, on the server itself, needs sshd's own port.
    sshPort:
      target.access === "tunnel"
        ? networkSshPort(facts, session.connection.port)
        : session.connection.port,
    ...(webSources !== undefined ? { webSources } : {}),
    host,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, session, {
        deployKeyFile: input.deployKeyFile,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
    ...(runner.step !== undefined ? { runner: runner.step } : {}),
    repository: repo,
    ...(first !== undefined ? { first } : {}),
  };
  // The check before anything changes: the tunnel's id is not known yet, so a placeholder stands in.
  requireNoBlockers(
    planHost(
      facts,
      await desiredHost(deps, run, {
        plan,
        deployPublicKey: input.deployPublicKey,
        ...(input.options.passwordLogins !== undefined
          ? { passwordLogins: input.options.passwordLogins }
          : {}),
      }),
      input.command,
      hostPlanOptions(plan),
    ),
    {
      server: serverWords(plan),
      command: input.command,
      // A move offers the choice about password logins itself.
      ...(input.phase === "retarget" ? { passwordLogins: input.command } : {}),
    },
  );
  if (first !== undefined) {
    // DNS points to the first app's server, at the address this computer keeps for it.
    run.address = first.address;
  } else if (target.access === "public" && home === undefined) {
    const address = ownServerPublicAddress(session.connection, facts);
    if (address === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "OpsCrew could not find your server's public IPv4 address, which the app's DNS record and GitHub Actions' deploys need. Nothing was changed.",
        {
          hint: "Give the server's public IP address as its address in `opscrew interview`. If the internet cannot reach the server, answer no to that question instead: OpsCrew then serves the app through a Cloudflare Tunnel.",
        },
      );
    }
    run.address = address;
  }
  // The last check before any change: a public repository's runner needs every outside
  // contributor's workflow runs approved first, set after its own approval (FR-1527).
  if (runner.settings !== undefined && runner.refusal !== undefined) {
    await applyRunnerSettings(
      deps,
      await repo(),
      { settings: runner.settings, refusal: runner.refusal },
      {
        phase: input.phase,
        command: input.command,
        ...(input.options.planOnly === true ? { planOnly: true } : {}),
      },
    );
  }
  return run;
}

/**
 * Connects to the server the second app `plan` shares with `secondAppLogin` (with this app's own
 * key once `own.joined`, else the first app's deploy login, through the reference `own.shares`)
 * and inspects it read-only as root through Docker (`services.host`, a {@link secondAppAdapter}),
 * audited as `phase`. The session's connection is this app's own recorded login. Once joined, the
 * first app's folder is not read; before, `first` is the first app the login read.
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no login or no reference to the
 * first app, and the login's own stops.
 */
export async function connectSecondApp(
  deps: PhaseDeps,
  plan: DeployPlan,
  input: {
    services: Pick<OwnServerServices, "remote" | "homeDir"> & { host: Required<HostAdapterApi> };
    phase?: PhaseName;
    detail?: string;
  },
): Promise<{
  session: OwnServerSession;
  facts: HostFacts;
  ref: SharesReference;
  first?: FirstApp;
}> {
  const own = await readOwnServerRecord(deps.paths);
  if (own === undefined) throw ownServerNotSetUp();
  const ref = own.shares;
  if (ref === undefined) throw sharesUnknown();
  const where = serverWords(plan);
  deps.reporter.step(`Connecting to ${where}`);
  const { session, first } = await secondAppLogin(deps, ref, own, { services: input.services });
  const facts = await inspectOwnHost(deps, session, {
    services: input.services,
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    machine: { noun: where, target: "own server" },
  });
  return { session, facts, ref, ...(first !== undefined ? { first } : {}) };
}

/** A stop before any change on a server at home. */
function homeStop(message: string, hint: string): OpsCrewError {
  return new OpsCrewError("PHASE_PRECONDITION", `${message} Nothing was changed.`, { hint });
}

/**
 * A server at home, before any change and read-only (plan 10., step 1): reads what the server sees
 * of its network (registering a proxied app's addresses with the redactor first), stops when the
 * address family the plan serves the site over is gone (design decides again), repeats design's
 * warning of a connection that looks like it has no public IPv4 address, and takes SSH's sources
 * from `.opscrew/server.json`. With the DNS on Cloudflare, the address updater's zone and token
 * ({@link homeUpdater}).
 */
async function prepareHome(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    session: OwnServerSession;
    facts: HostFacts;
    host: Required<HostAdapterApi>;
    phase: OwnHostPhase;
    command: string;
    cloudflare?: Pick<CloudflareSetup, "zoneId" | "zoneName" | "accountId">;
  },
): Promise<OwnHomeRun> {
  const { plan, session } = input;
  const ipv4 = homeIpv4(plan);
  const proxied = plan.dns.provider === "cloudflare" && plan.dns.proxied;
  deps.reporter.step("Reading your home network from your server (read-only)");
  const detected = await readHomeNetwork(deps, session, {
    host: input.host,
    proxied,
    phase: input.phase,
  });
  const network = classifyHomeNetwork(detected);
  const flags = await commandFlags(deps.paths.root, deps.paths.environment, deps.paths.app);
  const planFile = toPosixRelative(deps.paths.root, deps.paths.files.plan);
  const design = `Run \`opscrew design${flags}\` again: it decides how your server at home serves the site now. Then run \`${input.command}${flags}\` again.`;
  if (ipv4 && network.ipv4 === "none") {
    throw homeStop(
      `Your server at home has no IPv4 connection to the internet now, and ${planFile} serves the site over IPv4 (target.home.ipv4: true).`,
      design,
    );
  }
  if (ipv4 && network.ipv4 === "unknown") {
    throw homeStop(
      "Your server at home couldn't see its public IPv4 address: the two address checks over HTTPS didn't answer, or gave different addresses.",
      `Check that the server can make outgoing HTTPS connections, then run \`${input.command}${flags}\` again.`,
    );
  }
  if (!ipv4 && network.ipv6 !== "present") {
    throw homeStop(
      `Your server at home has no IPv6 address now, and ${planFile} serves the site over IPv6 only (target.home.ipv4: false).`,
      design,
    );
  }
  if (ipv4 && network.warning !== undefined) {
    const ipv6 = network.ipv6 === "present";
    for (const line of carrierNatWarning(network.warning, { ipv6, proxied })) {
      deps.reporter.info(line);
    }
  }
  const sshFrom = session.connection.home?.sshFrom;
  if (sshFrom === undefined)
    throw sshSourcesUnknown(flags, input.command, ". Nothing was changed.");
  const updater = await homeUpdater(deps, { ...input, flags });
  const lanAddress = network.noNat ? undefined : detected.lan?.address;
  return {
    network,
    ...(lanAddress !== undefined ? { lanAddress } : {}),
    sshFrom: [...sshFrom],
    ...(updater !== undefined ? { updater } : {}),
  };
}

/**
 * The address updater of a server at home with its DNS on Cloudflare (research R6): with the
 * app's zone, its token is checked (`checkUpdaterToken`) when `OPSCREW_DNS_UPDATER_TOKEN` is set
 * or the server has no token for the app yet; without the variable, the server's token stays.
 * Without the zone (a command that changes the server only), the updater stays as the server
 * has it: its zone, and its token. `undefined` with the DNS elsewhere.
 * @throws OpsCrewError from the token's checks, and `PHASE_PRECONDITION` when the server has no
 * updater to keep and no zone was given.
 */
async function homeUpdater(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    facts: HostFacts;
    command: string;
    /** The app's and environment's command flags. */
    flags: string;
    cloudflare?: Pick<CloudflareSetup, "zoneId" | "zoneName" | "accountId">;
  },
): Promise<OwnHomeRun["updater"]> {
  const { plan, cloudflare: zone, flags } = input;
  const name = addressUpdaterName(plan);
  if (name === undefined) return undefined;
  const onServer = input.facts.dnsUpdaters?.find((item) => item.app === plan.app.name);
  if (zone === undefined) {
    const zoneId = onServer?.config?.zoneId;
    if (zoneId === undefined) {
      throw homeStop(
        "Your server's address updater isn't set up yet, which keeps the site's DNS records at your home's address.",
        `Run \`opscrew provision${flags}\` first, then \`${input.command}${flags}\` again.`,
      );
    }
    return { zoneId, name };
  }
  const given = deps.env[UPDATER_TOKEN_VAR];
  if (!given?.trim() && onServer?.token.present === true) return { zoneId: zone.zoneId, name };
  const ownToken = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  const client = cloudflareConnector(deps).client;
  if (!ownToken || client === undefined) throw cloudflareTokenMissing(deps);
  const checked = await checkUpdaterToken({
    token: given,
    own: { token: ownToken, client },
    zone: { id: zone.zoneId, name: zone.zoneName, accountId: zone.accountId },
    command: `${input.command}${flags}`,
    deps,
  });
  return { zoneId: zone.zoneId, name, token: checked.token };
}

/**
 * What provision says last for a server at home (plan 10., step 7): the router's settings, which
 * the site needs before the deploy pull request is merged (with DNS only, the first deploy fetches
 * its certificate through them), then the outside check. None for any other server.
 */
export function homeProvisionLines(plan: DeployPlan, home: OwnHomeRun | undefined): string[] {
  if (home === undefined || !homeMode(plan)) return [];
  const proxied = plan.dns.provider === "cloudflare" && plan.dns.proxied;
  const forwards = homeForwardsInput({
    ipv4: homeIpv4(plan),
    proxied,
    network: home.network,
    lanAddress: home.lanAddress,
    sshFrom: home.sshFrom,
  });
  const router = homeForwards(forwards);
  const settings = (forwards.ipv4 && !forwards.noNat) || forwards.aaaa;
  const when = proxied
    ? "so Cloudflare reaches your server"
    : "set them before you merge: the first deploy fetches its certificate through them";
  return [
    ...(settings
      ? [`Your router's settings (${when}):`, ...router.map((line) => `  ${line}`)]
      : router),
    "Merge, then run `npx opscrew verify`, which checks from outside your home.",
  ];
}

/**
 * The engine environment for an own server: its public address as `TF_VAR_server_ipv4` and
 * `TF_VAR_server_ipv6`, never in a file (FR-902). In tunnel mode the address of an earlier public
 * setup still feeds the old configuration while its records are removed: from the local state, else
 * from the infrastructure state's outputs (`outputs`, read only when needed). A server at home sets
 * none: its root has no address variables, and the home's address never reaches the engine.
 */
export async function ownEngineEnv(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<OwnServerRun, "address" | "target">,
  env: Record<string, string | undefined>,
  outputs?: () => Promise<Record<string, unknown> | undefined>,
): Promise<void> {
  if (run.target.access === "public" && run.target.home !== undefined) {
    setAddressVariables(env, undefined);
    return;
  }
  const recorded = (await readServerAddresses(deps.paths).catch(() => undefined))?.deployment;
  const address =
    run.address ??
    recorded ??
    (outputs === undefined ? undefined : addressFromOutputs((await outputs()) ?? {}));
  setAddressVariables(env, address);
}

/** Each {@link OwnAccessMode} in words. */
export const MODE_TEXT: Record<OwnAccessMode, string> = {
  public: "serving the app directly on its public address",
  tunnel: "serving the app through a Cloudflare Tunnel",
  home: "serving the app from your home",
};

/**
 * The {@link OwnAccessMode} the infrastructure state was applied in, from its outputs: the
 * tunnel's SSH hostname, the home root's `address_updater` (a home root with the DNS elsewhere
 * holds no records, so it reads as none), or the public address; `undefined` when none.
 */
export function appliedAccessMode(outputs: Record<string, unknown>): OwnAccessMode | undefined {
  if (stringOutput(outputs, "ssh_hostname") !== undefined) return "tunnel";
  if (outputs.address_updater === true) return "home";
  return stringOutput(outputs, "server_ipv4") !== undefined ? "public" : undefined;
}

/**
 * Switching an own server between its access modes runs as two applies where Cloudflare could
 * hold an A/AAAA record and a CNAME for the same name: this one removes everything the last setup
 * created (DNS records, or the tunnel, its records and Access), from the files and state of that
 * setup; the normal plan adds the new ones afterwards. Each apply has its own approval (this one
 * deletes, so it needs the typed app name). `undefined` when the mode did not change, and between
 * public mode and home (`outputs`, the state's, read by the caller, say which mode was applied):
 * from public mode the home root's plan deletes the A and AAAA records itself before the address
 * updater writes its own, and leaving home the updater's records go first (`switchAccessMode`), so
 * only a tunnel then needs the home root's records (`www`, CAA) removed here.
 *
 * When this removal deletes the Cloudflare Tunnel (the old setup had one), Cloudflare refuses while
 * the tunnel's connector still runs on the server. Then, after the removal's approval, the host
 * plan of the new setup without a connector (`input.host`) is shown, approved by its hash and
 * applied first; OpsCrew waits until Cloudflare reports no active connections for the tunnel
 * (read-only, up to 3 minutes) and only then applies the removal. The host plan is returned as
 * `host` (with `planOnly`, shown and saved only, so a script can approve both hashes). Going home,
 * that host plan leaves out the address updater: its first run would find the tunnel's CNAME at
 * the name, so the host plan after the new setup's apply installs it.
 */
export async function removeOldAccessMode(
  deps: PhaseDeps,
  input: {
    engine: IacEngine;
    dir: string;
    env: Record<string, string | undefined>;
    plan: DeployPlan;
    /** The infrastructure state's outputs (none without a state: nothing to remove). */
    outputs: Record<string, unknown>;
    approvePlanHash?: string;
    planOnly?: boolean;
    phase: Extract<PhaseName, "provision" | "dns">;
    /** The server, for the host change that goes before a removal that deletes the tunnel. */
    host: {
      run: OwnServerRun;
      deployPublicKey: string;
      passwordLogins?: ProvisionOptions["passwordLogins"];
      sleep?: (ms: number) => Promise<void>;
    };
  },
): Promise<(PlanAndApplyResult & { host?: HostChangeResult }) | undefined> {
  const { plan } = input;
  const last = appliedAccessMode(input.outputs);
  const next = ownAccessMode(plan);
  if (last === undefined || last === next) return undefined;
  // Between public mode and home there is nothing to remove first (see above).
  if (last !== "tunnel" && next !== "tunnel") return undefined;
  deps.reporter.warn(
    `Your server switches from ${MODE_TEXT[last]} to ${MODE_TEXT[next]}. Cloudflare cannot hold the old records and the new ones for the same name at once, so OpsCrew first removes what the current setup created (this plan), then adds the new setup in a second plan. The app is unreachable between the two applies.`,
  );
  const removed =
    last === "tunnel"
      ? "the Cloudflare Tunnel, its DNS records and Access"
      : last === "home"
        ? "the DNS records of your server at home"
        : "the DNS records pointing at your server";
  const command = `opscrew ${input.phase}`;
  // The host change that goes first when the removal deletes the tunnel (see above).
  const first = ownConnectorFirst(deps, {
    ...input.host,
    plan,
    phase: input.phase,
    done: `Your server is switched to ${MODE_TEXT[next]} already (its Cloudflare Tunnel connector is removed); the current setup's Cloudflare resources are still there, so the app is unreachable until the switch finishes.`,
    ...(next === "home" ? { adjust: withoutUpdater } : {}),
  });
  let result: PlanAndApplyResult;
  try {
    result = await planAndApply(deps, {
      engine: input.engine,
      dir: input.dir,
      env: input.env,
      deployPlan: plan,
      files: [],
      command,
      phase: input.phase,
      destroy: true,
      costDelta: null,
      approvalTitle: `Remove ${removed} before switching your server to ${MODE_TEXT[next]} (first of two applies)`,
      ...first.hooks,
      ...(input.approvePlanHash !== undefined ? { approvePlanHash: input.approvePlanHash } : {}),
      ...(input.planOnly ? { planOnly: true } : {}),
    });
  } catch (error) {
    throw first.stopped(error);
  }
  // `--plan-only`: a removal that deletes the tunnel needs the host plan too; show it now.
  const pending = (result.plan?.changes.length ?? 0) > 0 && !result.applied;
  if (input.planOnly && pending && tunnelChange(result.plan?.changes ?? [], "delete")) {
    return { ...result, host: await first.show() };
  }
  return first.host === undefined ? result : { ...result, host: first.host };
}

/**
 * Inspects the user's own server again (read-only, audited as `phase` with `detail`) after a host
 * change that goes before the new setup, so the next host plan starts from what the server is now.
 */
export async function inspectAgain(
  deps: PhaseDeps,
  run: OwnServerRun,
  phase: OwnHostPhase,
  detail: string,
): Promise<void> {
  run.facts = await run.host.inspect(run.session.remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "inspect host (read-only)",
    phase,
    target: "own server",
    decision: "allow",
    detail,
  });
}

/** The desired host without the address updater of a server at home. */
function withoutUpdater({ dnsUpdater: _updater, ...desired }: DesiredHost): DesiredHost {
  return desired;
}

/**
 * {@link connectorFirst} on a server the user owns: the host change that goes before a plan that
 * deletes the tunnel is the host plan of `plan` without a tunnel connector (its own `host-apply`
 * approval by its hash), its desired host changed by `adjust` when given. After it applied, the
 * server is inspected again, so the next host plan (of the new setup) starts from what the server
 * is now. `show()` only shows and saves it (`--plan-only`).
 */
export function ownConnectorFirst(
  deps: PhaseDeps,
  input: {
    run: OwnServerRun;
    plan: DeployPlan;
    deployPublicKey: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    phase: Extract<PhaseName, "provision" | "dns">;
    sleep?: (ms: number) => Promise<void>;
    done: string;
    notes?: readonly string[];
    adjust?: (desired: DesiredHost) => DesiredHost;
  },
): ConnectorFirst & { show(): Promise<HostPlanOutcome> } {
  const { run } = input;
  let shownHash: string | undefined;
  const apply = (planOnly: boolean) =>
    applyOwnHostPlan(deps, run, {
      plan: input.plan,
      outputs: {},
      deployPublicKey: input.deployPublicKey,
      ...(input.passwordLogins !== undefined ? { passwordLogins: input.passwordLogins } : {}),
      planOnly,
      phase: input.phase,
      command: `opscrew ${input.phase}`,
      withoutTunnel: true,
      ...(input.adjust !== undefined ? { adjust: input.adjust } : {}),
      shown: (hash) => {
        shownHash = hash;
      },
    });
  const first = connectorFirst(deps, {
    command: `opscrew ${input.phase}`,
    app: input.plan.app.name,
    where: "on your server",
    hostChange: async () => {
      const host = await apply(false);
      if (host.applied) {
        await inspectAgain(deps, run, input.phase, "after removing the tunnel connector");
      }
      return host;
    },
    hostHash: () => shownHash,
    done: input.done,
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  return Object.assign(first, { show: () => apply(true) });
}

/** The infrastructure outputs a tunnel-mode host plan needs: the tunnel's id and token. */
function tunnelOutputs(
  deps: Pick<PhaseDeps, "redactor">,
  outputs: Record<string, unknown>,
): { id: string; token: string } {
  const id = stringOutput(outputs, "tunnel_id");
  const token = stringOutput(outputs, "tunnel_token");
  if (token !== undefined) deps.redactor.addLiteral(token, "tunnel-token");
  if (id === undefined || token === undefined) {
    throw new OpsCrewError(
      "ENGINE_FAILED",
      "The infrastructure state has no Cloudflare Tunnel id or token, so OpsCrew cannot set up the tunnel connector on your server.",
      {
        hint: "Run `opscrew provision` again; it plans what is missing. If the tunnel was deleted in the Cloudflare dashboard, the next plan creates a new one.",
      },
    );
  }
  return { id, token };
}

/**
 * The host plan for the user's own server, after the infrastructure exists (the tunnel's id is
 * part of it), through {@link approveAndApplyHostPlan}: saved, shown, checked for blocking
 * findings, approved by its hash (`host-apply`) and applied through the host adapter, which gets
 * the tunnel token (and Portainer's password, the runner's token) only then and calls
 * `verifyLogin` before keeping an SSH or firewall change; audited as `phase`, and a refusal or stop
 * says to run `command`. A runner registration GitHub kept after its removal is deleted through
 * GitHub's API. With `planOnly` it stops after saving and showing the plan.
 */
export async function applyOwnHostPlan(
  deps: PhaseDeps,
  run: OwnServerRun,
  input: {
    plan: DeployPlan;
    outputs: Record<string, unknown>;
    deployPublicKey: string;
    /** A rotation's old deploy key, kept beside `deployPublicKey` (`planHost`'s `previousDeployKey`). */
    previousDeployKey?: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    planOnly?: boolean;
    phase: OwnHostPhase;
    /** The command that applies the plan later (`--approve <hash>`), e.g. `opscrew portainer enable`. */
    command: string;
    /** Said when the plan changes nothing (default: `Your server is already prepared; …`). */
    upToDate?: string;
    /** No tunnel connector (see {@link desiredHost}); `outputs` are then not needed. */
    withoutTunnel?: boolean;
    /** How the host change that goes first in a mode switch differs from the plan's. */
    adjust?: (desired: DesiredHost) => DesiredHost;
    /** Told the host plan's hash as soon as it is shown. */
    shown?: (hash: string) => void;
  },
): Promise<HostPlanOutcome> {
  // The connector runs whenever the plan has a tunnel: tunnel mode or a Portainer subdomain.
  const tunnel =
    usesTunnel(input.plan) && input.withoutTunnel !== true
      ? tunnelOutputs(deps, input.outputs)
      : undefined;
  const desired = await desiredHost(deps, run, {
    plan: input.plan,
    deployPublicKey: input.deployPublicKey,
    ...(tunnel !== undefined ? { tunnelId: tunnel.id } : {}),
    ...(input.passwordLogins !== undefined ? { passwordLogins: input.passwordLogins } : {}),
    ...(input.withoutTunnel === true ? { withoutTunnel: true } : {}),
  });
  const plan = planHost(
    run.facts,
    input.adjust === undefined ? desired : input.adjust(desired),
    input.command,
    { previousDeployKey: input.previousDeployKey, ...hostPlanOptions(input.plan) },
  );
  const changes = plural(plan.steps.filter((step) => step.state === "change").length, "change");
  const app = input.plan.app.name;
  const shares = sharesOf(input.plan);
  const where = serverWords(input.plan);
  // The scheduled drills delete their copy's data each run (and their removal a kept copy): the
  // plan is approved as a destroy, with the copy's name typed.
  const drills = plan.steps.some((step) => step.id === "drills" && step.state === "change");
  const outcome = await approveAndApplyHostPlan(deps, {
    plan,
    remote: run.session.remote,
    apply: run.host.apply,
    verifyLogin: run.verifyLogin,
    title: `Apply the host plan to ${where} (${changes})`,
    server: where,
    planOf: where,
    upToDate:
      input.upToDate ??
      (shares === undefined
        ? "Your server is already prepared; nothing on it changes."
        : `"${app}" is already set up on ${where}; nothing on it changes.`),
    // Said in the approval of a second app: it shares the deploy user with the first app.
    ...(shares === undefined ? {} : { intro: [sharedAccessWarning(app, shares.app)] }),
    command: input.command,
    phase: input.phase,
    ...(drills ? { allowDestroy: true, confirmPhrase: drillName(input.plan.app.name) } : {}),
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async (steps) => {
      const portainerStep = steps.find((step) => step.id === "portainer");
      const portainerPassword =
        portainerStep === undefined || portainerStep.params.remove === true
          ? undefined
          : await portainerPasswordToSend(deps, portainerStep.params.needsPassword === true);
      // The updater's token, when the step names its hash: it reaches the server on stdin only.
      const updater = steps.find((step) => step.id === "dns-updater");
      const dnsUpdaterToken =
        updater?.params.tokenSha256 === undefined ? undefined : run.home?.updater?.token;
      // The drill's values, when its step installs them: on stdin only, checked by their SHA-256.
      const installs = steps.some((step) => step.id === "drills" && step.params.remove !== true);
      const previewValues = installs ? (await drillEnv(deps, input.plan)).values : undefined;
      return {
        ...(tunnel !== undefined ? { tunnelToken: tunnel.token } : {}),
        ...(portainerPassword !== undefined ? { portainerPassword } : {}),
        ...(dnsUpdaterToken !== undefined ? { dnsUpdaterToken } : {}),
        ...(previewValues !== undefined ? { previewValues } : {}),
      };
    },
    runnerToken: runnerTokens(deps, run.repository),
    applying:
      shares === undefined
        ? `Preparing your server (${changes}; installing Docker can take a few minutes)`
        : `Setting up "${app}" on ${where} (${changes})`,
    ...(input.shown !== undefined ? { shown: input.shown } : {}),
  });
  if (shares !== undefined && input.planOnly !== true) await recordJoined(deps, plan, outcome);
  if (!outcome.approval) return outcome;
  if (outcome.stillRegistered !== undefined) {
    await removeKeptRegistrations(deps, run.repository, input.plan, {
      phase: input.phase,
      stillRegistered: outcome.stillRegistered,
      host: run.session.connection.host,
    });
  }
  deps.reporter.success(
    shares === undefined
      ? `Prepared your server (${plural(outcome.steps.length, "change")} applied).`
      : `Set up "${app}" on ${where} (${plural(outcome.steps.length, "change")} applied).`,
  );
  if (switchesToWebFilter(run.facts, plan, input.plan.app.name, outcome.steps)) {
    deps.reporter.warn(SWITCH_TO_FILTER_NOTE);
  }
  return outcome;
}

/**
 * Records `own.joined` for a second app once its own deploy key is on the server: the host plan's
 * `deploy-key` step was applied (`outcome`) or found it in place. From then on its commands log in
 * with that key. The record starts from the login as the connection just recorded it.
 */
async function recordJoined(
  deps: Pick<PhaseDeps, "paths">,
  plan: HostPlan,
  outcome: Pick<HostPlanOutcome, "steps">,
): Promise<void> {
  const key = plan.steps.find((step) => step.id === "deploy-key");
  if (key?.state !== "in-place" && !outcome.steps.includes("deploy-key")) return;
  const own = await readOwnServer(deps.paths);
  if (own === undefined || own.joined === true) return;
  await recordOwnServer(deps.paths, { ...own, joined: true });
}

/** Said after a running app switched to the web filter mode (published on IPv4 only). */
export const SWITCH_TO_FILTER_NOTE =
  "Your site stops answering on the server's IPv6 address only after the next deploy re-creates Caddy (until then the running Caddy still listens on IPv6 ports 80 and 443, around the web filter): merge the deploy pull request, or re-run the deploy workflow now.";

/**
 * True when this apply installed the web filter for the first time on a server where the app
 * already runs (a switch from DNS only or the tunnel): the running Caddy keeps its IPv6 listeners
 * until the next deploy re-creates it with the filter mode's IPv4-only ports.
 */
function switchesToWebFilter(
  facts: HostFacts,
  plan: HostPlan,
  app: string,
  applied: readonly string[],
): boolean {
  const filter = plan.steps.find((step) => step.id === "web-filter");
  if (filter === undefined || filter.params.remove === true || !applied.includes("web-filter")) {
    return false;
  }
  const wasFiltered = facts.webFilter.files.script !== null;
  return !wasFiltered && facts.containers.some((container) => container.project === app);
}

/**
 * What the deploy secrets hold for the user's own server: the host GitHub Actions connects to
 * (the public address, or the tunnel's SSH hostname) and the pinned host key under that name, and
 * in tunnel mode the Access service token from the infrastructure outputs. A server at home is
 * never reached from GitHub's machines: a runner machine on the home network (`runner: host`)
 * reaches the login's address there (`connection.host`) with the pinned key, and the server's own
 * runner deploys in place, so the deploy reads no host at all (`deploysInPlace`): GitHub never
 * holds a home address.
 */
export function ownDeployTarget(
  deps: Pick<PhaseDeps, "redactor">,
  run: Pick<OwnServerRun, "session" | "address" | "target" | "sshPort">,
  input: { plan: DeployPlan; outputs: Record<string, unknown> },
): {
  host: string;
  knownHosts: string;
  tunnel?: { serviceTokenId: string; serviceTokenSecret: string };
} {
  const key = run.session.hostKey;
  if (run.target.access === "public" && run.target.home !== undefined) {
    const { host } = run.session.connection;
    return { host, knownHosts: `${knownHostsName(host, run.sshPort)} ${key.type} ${key.key}\n` };
  }
  if (run.target.access === "tunnel") {
    const host = sshHostname(input.plan) as string;
    const serviceTokenId = stringOutput(input.outputs, "deploy_service_token_client_id");
    const serviceTokenSecret = stringOutput(input.outputs, "deploy_service_token_client_secret");
    if (serviceTokenId !== undefined) deps.redactor.addLiteral(serviceTokenId, "service-token-id");
    if (serviceTokenSecret !== undefined) {
      deps.redactor.addLiteral(serviceTokenSecret, "service-token-secret");
    }
    if (serviceTokenId === undefined || serviceTokenSecret === undefined) {
      throw new OpsCrewError(
        "ENGINE_FAILED",
        "The infrastructure state has no Cloudflare Access service token for deploys, so GitHub Actions could not reach your server through the tunnel.",
        { hint: "Run `opscrew provision` again; it plans what is missing." },
      );
    }
    // The workflow connects to the SSH hostname through cloudflared, so ssh looks the key up there.
    return {
      host,
      knownHosts: `${host} ${key.type} ${key.key}\n`,
      tunnel: { serviceTokenId, serviceTokenSecret },
    };
  }
  const address = run.address as ServerAddress;
  // The deploy workflow connects to the login's port (`run.sshPort`, `-o Port=<port>` when it is
  // not 22), so ssh looks the key up as `[ip]:port` there.
  const name = knownHostsName(address.ipv4, run.sshPort);
  return { host: address.ipv4, knownHosts: `${name} ${key.type} ${key.key}\n` };
}

/**
 * Connects to the extra server `name` the user owns with the login design recorded
 * (`.opscrew/server.json` → `ownServers`, its host key pinned there) and inspects it read-only
 * (`connectExtraServer`) through the host adapter of `services.own` (default `inspectHost` and
 * `applyHostPlan`).
 * @throws OpsCrewError `PHASE_PRECONDITION` when this computer has no login for it.
 */
async function connectExtraOwnServer(
  deps: PhaseDeps,
  input: { name: string; services: ProvisionServices; deployKeyFile: string; phase: PhaseName },
): Promise<ExtraOwnServerRun> {
  const { name } = input;
  const own = input.services.own ?? {};
  const host = boundHostAdapter(own.host);
  const login = (await readServerAddresses(deps.paths)).ownServers?.[name];
  if (login === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not know how to log in to server ${name} on this computer. Nothing was changed.`,
      {
        hint: "Run `opscrew design` in a terminal: it asks for the server's address and SSH login once and keeps them on this computer.",
      },
    );
  }
  deps.reporter.step(`Connecting to server ${name}`);
  const { session, facts } = await connectExtraServer(deps, name, login, {
    services: { ...own, host },
    phase: input.phase,
  });
  return {
    name,
    session,
    facts,
    host,
    verifyLogin:
      own.verifyLogin ??
      ownServerLoginCheck(deps, session, {
        deployKeyFile: input.deployKeyFile,
        ...(own.homeDir !== undefined ? { homeDir: own.homeDir } : {}),
      }),
  };
}

/**
 * Connects to the extra server `name` the user owns and inspects it ({@link
 * connectExtraOwnServer}), then stops before any change, as {@link prepareOwnServer} does for the
 * app's server, when its architecture is not the plan's or its setup host plan would be blocked.
 */
export async function prepareExtraOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    name: string;
    services: ProvisionServices;
    deployPublicKey: string;
    deployKeyFile: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    phase: OwnHostPhase;
    command: string;
  },
): Promise<ExtraOwnServerRun> {
  const { plan, name } = input;
  const run = await connectExtraOwnServer(deps, input);
  const target = plan.servers?.find((server) => server.name === name)?.target;
  const arch = run.facts.arch;
  if (
    target?.provider === "own" &&
    (arch === "amd64" || arch === "arm64") &&
    arch !== target.arch
  ) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `opscrew/plan.yaml says server ${name} is ${target.arch}, but it is ${arch}. Nothing was changed.`,
      {
        hint: "Run `opscrew design` again so OpsCrew reads the server again, then run `opscrew provision` again.",
      },
    );
  }
  requireMongoAvx(plan, run.facts, name);
  // A server that only holds a moving service's old copy has nothing new to set up.
  if (servicesOn(plan, name).length > 0) {
    requireNoBlockers(
      planHost(run.facts, await desiredExtraHost(deps, run, input), input.command),
      {
        server: `server ${name}`,
        command: input.command,
      },
    );
  }
  return run;
}

/**
 * The own-server setup host plan of the extra server `run.name` ({@link desiredExtraHost}),
 * through {@link approveAndApplyHostPlan}: saved, shown with the server's name, approved by its
 * hash and applied, the host adapter checking new logins after an SSH or firewall change. Once the
 * server is as the plan says (applied, or nothing to change), it is kept as the server's last setup
 * ({@link lastServerSetup}). `undefined` for a server with no service placed on it.
 */
export async function applyExtraOwnHostPlan(
  deps: PhaseDeps,
  run: ExtraOwnServerRun,
  input: {
    plan: DeployPlan;
    deployPublicKey: string;
    /** A rotation's old deploy key, kept beside `deployPublicKey` (`planHost`'s `previousDeployKey`). */
    previousDeployKey?: string;
    passwordLogins?: ProvisionOptions["passwordLogins"];
    planOnly?: boolean;
    phase: OwnHostPhase;
    command: string;
  },
): Promise<HostPlanOutcome | undefined> {
  if (servicesOn(input.plan, run.name).length === 0) return undefined;
  const plan = planHost(run.facts, await desiredExtraHost(deps, run, input), input.command, {
    previousDeployKey: input.previousDeployKey,
  });
  const pending = plan.steps.filter((step) => step.state === "change").length;
  const changes = plural(pending, "change");
  const outcome = await approveAndApplyHostPlan(deps, {
    plan,
    remote: run.session.remote,
    apply: run.host.apply,
    verifyLogin: run.verifyLogin,
    title: `Apply the host plan to server ${run.name} (${changes})`,
    server: `server ${run.name}`,
    planOf: `server ${run.name}`,
    upToDate: `Server ${run.name} is already prepared; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => ({}),
    applying: `Preparing server ${run.name} (${changes}; installing Docker can take a few minutes)`,
  });
  if (outcome.applied || pending === 0) await keepServerSetup(deps, run.name, outcome.hash);
  if (outcome.applied) {
    deps.reporter.success(
      `Prepared server ${run.name} (${plural(outcome.steps.length, "change")} applied).`,
    );
  }
  return outcome;
}

/**
 * The scheduled check's key (`key`, the repository's) on the extra server `run.name` the user
 * owns, as the app's server the user owns gets it: the `check-key` host step as root, shown with
 * the server's name and approved by its hash. `undefined` when its inspection found the key there.
 */
export async function addExtraServerCheckKey(
  deps: PhaseDeps,
  run: ExtraOwnServerRun,
  input: {
    plan: DeployPlan;
    key: CheckKey;
    repository: string;
    planOnly?: boolean;
    phase: OwnHostPhase;
    command: string;
  },
): Promise<HostPlanOutcome | undefined> {
  const { repository } = input;
  const known = run.facts.deployUser?.checkKeys ?? [];
  if (known.some((name) => name.toLowerCase() === repository.toLowerCase())) return undefined;
  const server = `server ${run.name}`;
  return approveAndApplyHostPlan(deps, {
    plan: planAddon("check-key", {
      app: input.plan.app.name,
      runAs: "root",
      repository,
      enable: { publicKey: input.key.publicKeyOpenSsh },
    }),
    remote: run.session.remote,
    apply: run.host.apply,
    // The step changes no SSH or firewall setting.
    verifyLogin: async () => true,
    title: `Let the scheduled check of ${repository} read the disk of ${server} with its own key`,
    server,
    planOf: server,
    upToDate: `The scheduled check's key is on ${server}; nothing on it changes.`,
    command: input.command,
    phase: input.phase,
    ...(input.planOnly === true ? { planOnly: true } : {}),
    secrets: async () => ({}),
    applying: `Adding the scheduled check's key to ${server}`,
  });
}

/**
 * How the deploy reaches the extra server `run.name` the user owns: its public address (as design
 * recorded it in `.opscrew/server.json` → `servers`) on the login's SSH port, with the pinned host
 * key under that name (`[host]:port` when the port is not 22); once public SSH is closed, where
 * this run connected to it instead (`session.reach`: its private address, sshd's port there).
 * @throws OpsCrewError `PHASE_PRECONDITION` when its public address is not known.
 */
export async function extraOwnReach(
  deps: Pick<PhaseDeps, "paths">,
  run: Pick<ExtraOwnServerRun, "name" | "session" | "facts">,
): Promise<ServerReach> {
  const { connection, hostKey, reach } = run.session;
  const at = (host: string, port: number): ServerReach => ({
    name: run.name,
    host,
    knownHosts: `${knownHostsName(host, port)} ${hostKey.type} ${hostKey.key}\n`,
  });
  if (reach !== undefined) return at(reach.host, reach.port);
  const address =
    (await readServerAddresses(deps.paths)).servers?.[run.name] ??
    ownServerPublicAddress(connection, run.facts);
  if (address === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew could not find the public IPv4 address of server ${run.name}, which the deploys reach it at.`,
      {
        hint: "Run `opscrew design` again: it reads the server's addresses and keeps them on this computer.",
      },
    );
  }
  return at(address.ipv4, connection.port);
}

/**
 * Takes the app off the extra server `name` the user owns, which `servers` no longer lists, and
 * leaves what was there before: the teardown host plan (the app's containers, its folder, its
 * private network and its record; its data stays), then, when no other OpsCrew app is on the
 * server, the undo host plan (OpsCrew's own host settings). Each is shown with the server's name
 * and needs an approval that allows destroying, with the server's name typed. Then this computer
 * forgets the server. With `planOnly` the teardown is only shown and saved.
 */
export async function removeExtraOwnServer(
  deps: PhaseDeps,
  input: {
    plan: DeployPlan;
    name: string;
    services: ProvisionServices;
    deployKeyFile: string;
    planOnly?: boolean;
    phase: OwnHostPhase;
    command: string;
  },
): Promise<HostPlanOutcome[]> {
  const { plan, name, command } = input;
  const run = await connectExtraOwnServer(deps, input);
  const repository = repositoryUrl(await githubCoordinates(gitClient(deps)));
  const apply = (hostPlan: HostPlan, title: string) =>
    approveAndApplyHostPlan(deps, {
      plan: hostPlan,
      remote: run.session.remote,
      apply: run.host.apply,
      verifyLogin: run.verifyLogin,
      title,
      server: `server ${name}`,
      planOf: `server ${name}`,
      upToDate: `Nothing on server ${name} needs to change.`,
      command,
      phase: input.phase,
      allowDestroy: true,
      confirmPhrase: name,
      intro: [`Server ${name} is no longer in servers in opscrew/plan.yaml.`],
      auditAs: `host ${hostPlan.purpose}`,
      ...(input.planOnly === true ? { planOnly: true } : {}),
      secrets: async () => ({}),
    });
  const teardown = await apply(
    planTeardown(
      run.facts,
      {
        deleteData: false,
        app: plan.app.name,
        projectId: deps.paths.projectId,
        repositoryUrl: repository,
      },
      command,
    ),
    `Remove ${plan.app.name} from server ${name} (its data stays)`,
  );
  if (input.planOnly === true) return [teardown];
  const outcomes = [teardown];
  const facts = await run.host.inspect(run.session.remote);
  if (otherActiveApps(facts.apps, plan.app.name).length === 0) {
    outcomes.push(
      await apply(
        planUndo(facts, { repositoryUrl: repository }, command),
        `Undo OpsCrew's settings on server ${name}`,
      ),
    );
  }
  await updateServerAddresses(deps.paths, ({ servers, ownServers, ...rest }) => {
    const { [name]: _address, ...otherServers } = servers ?? {};
    const { [name]: _login, ...otherLogins } = ownServers ?? {};
    return {
      ...rest,
      ...(Object.keys(otherServers).length > 0 ? { servers: otherServers } : {}),
      ...(Object.keys(otherLogins).length > 0 ? { ownServers: otherLogins } : {}),
    };
  });
  deps.reporter.success(`Took the app off server ${name}; OpsCrew no longer reaches it.`);
  return outcomes;
}
