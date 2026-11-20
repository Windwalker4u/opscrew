import type { ComputeCatalog, ComputeOffer, Currency } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { EDGE_PROXIES, type EdgeProxy, edgeProxy } from "@opscrew/iac-templates";
import {
  type CostEstimate,
  CostEstimateSchema,
  type DeployPlan,
  DeployPlanSchema,
  type DesignOption,
  DesignOptionSchema,
  isCloudTarget,
  type OwnDeployTarget,
  type ProjectFacts,
  type Requirements,
  serviceOf,
} from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { refusedBeforeChange } from "../previews/host";
import { deepDomainProblem } from "../shared/deep-domain";
import type { MemoryLimit } from "../shared/memory";
import { type Components, memoryText } from "./components";
import { type PreviewHost, previewMemoryText } from "./previews";
import {
  containersText,
  OWN_SERVER_MEMORY_TOLERANCE,
  ownServerFreeDiskGb,
  sizeFor,
  smallServerWarnings,
} from "./sizing";

/** How the internet reaches a server the user owns: directly, or through a Cloudflare Tunnel. */
export type OwnServerAccess = OwnDeployTarget["access"];

/**
 * How a server the user owns serves the site: through a Cloudflare Tunnel (the default whenever
 * the domain is on Cloudflare, and for a server the internet cannot reach), directly behind
 * Cloudflare's proxy with OpsCrew's web filter (`proxy`, only as the user's explicit choice), or
 * directly with DNS only (the only way without a Cloudflare domain).
 */
export type OwnServerServing = "tunnel" | "proxy" | "dns-only";

/** True when the app's domain is on Cloudflare. */
export function hasCloudflareDomain(
  requirements: Pick<Requirements, "dnsProvider" | "domain">,
): boolean {
  return requirements.dnsProvider === "cloudflare" && requirements.domain !== undefined;
}

/**
 * The serving mode from the interview's answers: not reachable → the tunnel; reachable without a
 * Cloudflare domain → DNS only; reachable with one → the answer (`proxy` or `dns-only`), else the
 * tunnel.
 */
export function ownServerServing(input: {
  reachable: boolean;
  serve?: OwnServerServing | undefined;
  requirements: Pick<Requirements, "dnsProvider" | "domain">;
}): OwnServerServing {
  if (!input.reachable) return "tunnel";
  if (!hasCloudflareDomain(input.requirements)) return "dns-only";
  return input.serve ?? "tunnel";
}

/**
 * False when the server is known to have no public IPv4 address: OpsCrew reaches it by an IPv6
 * address and found no public IPv4 address for it. Serving behind Cloudflare's proxy with the web
 * filter publishes the site on IPv4 only, so it needs one. A host name may have one (provision
 * checks it before any change).
 */
export function mayHavePublicIpv4(server: {
  host: string;
  publicIpv4?: string | undefined;
}): boolean {
  if (server.publicIpv4 !== undefined) return true;
  return !server.host.includes(":");
}

/** The plain refusal when the web filter mode has no public IPv4 address to publish on. */
export function proxyNeedsIpv4Message(): { message: string; hint: string } {
  return {
    message:
      "Serving the site directly behind Cloudflare's proxy needs your server's public IPv4 address, because OpsCrew's web filter publishes the site on IPv4 only, and OpsCrew knows only an IPv6 address for your server.",
    hint: "Run `opscrew interview` and choose the Cloudflare Tunnel (recommended; it needs no public address), or give the server's public IPv4 address as its address.",
  };
}

/** The plan's `target.access` for a serving mode. */
export function servingAccess(serving: OwnServerServing): OwnServerAccess {
  return serving === "tunnel" ? "tunnel" : "public";
}

/** Said wherever OpsCrew designs, documents or removes a deployment on the user's own server. */
export const OWN_SERVER_BACKUPS_NOTE =
  "OpsCrew snapshots the app's data on your server with `opscrew snapshot`; `opscrew snapshot schedule on` takes them on a schedule and `opscrew snapshot offsite on` keeps an encrypted copy off the server. OpsCrew cannot back up the server itself: those backups are your responsibility.";

/** Why an own-server option has no price. */
export const OWN_SERVER_PRICE_NOTE = "No server price: you already pay for this server.";

/** Id of the only design option on a server the user owns. */
export const OWN_SERVER_OPTION_ID = "own-server";

/**
 * The option's `target.serverType` and `target.location`, which the option schema requires but a
 * server the user owns does not have (the location is the same for an existing Portainer).
 * Surfaces that print them (`Server: <type> in <location>`) then read naturally; they never reach
 * the plan.
 */
export const OWN_SERVER_TYPE = "your server";
export const OWN_SERVER_LOCATION = "its current location";

/** The cost of an option on a server or Portainer the user already pays for: nothing, billed `free`. */
export function noServerCost(item: string, currency: Currency, asOf: string): CostEstimate {
  return CostEstimateSchema.parse({
    monthly: { amount: 0, currency },
    breakdown: [{ item, monthly: { amount: 0, currency }, billing: "free" }],
    pricesIncludeVat: false,
    source: "live",
    asOf,
  });
}

/**
 * What is said of another environment's server (`env`'s) instead of the own server's price and
 * backups.
 */
export function hostServerNote(env: string): string {
  return `The server is ${env}'s: it is priced and backed up with ${env}.`;
}

/**
 * A second app beside the first app on the server OpsCrew created for it (030): what design says
 * of that server instead of the own server's.
 */
export interface SharedServerOption {
  /** The first app's name. */
  app: string;
  /** Where OpsCrew created the server, as its provider is named ("Hetzner Cloud"). */
  provider: string;
  /**
   * The first app is served behind Cloudflare's proxy: its cloud firewall lets only Cloudflare in.
   */
  proxied: boolean;
  /** The memory limits of the other apps there: the first app's, then the other second apps'. */
  others: readonly MemoryLimit[];
}

/** {@link SharedServerOption} for the first app `first` and the other apps' memory limits. */
export function sharedServerOption(
  first: DeployPlan,
  others: readonly MemoryLimit[],
): SharedServerOption {
  return {
    app: first.app.name,
    provider: cloudProvider(first.target.provider).displayName,
    proxied: first.dns.proxied,
    others: quotedApps(others),
  };
}

/** The other apps' memory limits as a memory line names them: `"shop" 1024 MB`. */
export function quotedApps(apps: readonly MemoryLimit[]): MemoryLimit[] {
  return apps.map((app) => ({ name: `"${app.name}"`, memoryMb: app.memoryMb }));
}

/** Why a second app's option has no price: the server is the first app's (`app`). */
export function sharedPriceNote(app: string): string {
  return `No server price: the server is "${app}"'s, which pays for it.`;
}

/** What a second app backs up, and what the first app (`app`) does. */
export function sharedBackupsNote(app: string): string {
  return `OpsCrew snapshots this app's data on the server with \`opscrew snapshot\`; the server itself is backed up with "${app}".`;
}

/** A second app's cost item: the server of the app `first`, which is priced with that app. */
export function sharedServerCostItem(first: string): string {
  return `"${first}"'s server (priced with "${first}")`;
}

/**
 * The warning a second app's design summary and host plan approval say plainly (FR-3004), and
 * design's for a server the user owns that holds other OpsCrew apps: every app there runs as the
 * same `deploy` user, which can become root through Docker, so this app's deploys reach the data
 * and secrets of the others (`apps`, each named).
 */
export function sharedAccessWarning(...apps: [string, ...string[]]): string {
  const named = listText(apps.map((app) => `"${app}"`));
  const all = apps.length === 1 ? "both apps run" : "all these apps run";
  return `Anyone who can change this app's deploy workflow or its deploy key can reach the data and secrets of ${named} too: ${all} on the server as the same deploy user, which can become root through Docker. Share the server only between apps the same people may change.`;
}

/**
 * Stops design for a second app beside a first app (`first`) served behind Cloudflare's proxy
 * (plan 7., step 3), whose firewall lets only Cloudflare reach the web ports, so this app is
 * proxied too: when its domain is not on Cloudflare, and when it is more than one level below its
 * zone, which Cloudflare's free certificate doesn't cover. Says the alternatives.
 * @throws OpsCrewError `PHASE_PRECONDITION`, or `INVALID_INPUT` for the domain's depth, before
 * anything is written.
 */
export function requireSharedServing(
  first: DeployPlan,
  requirements: Pick<Requirements, "dnsProvider" | "domain">,
  flags: string,
): void {
  if (!first.dns.proxied) return;
  const app = first.app.name;
  const { domain } = requirements;
  if (hasCloudflareDomain(requirements) && domain !== undefined) {
    const deep = deepDomainProblem(domain, "give this app a server of its own");
    if (deep === undefined) return;
    throw refusedBeforeChange(
      "INVALID_INPUT",
      `"${app}" is served behind Cloudflare's proxy, so this app is too, and ${deep.reason}.`,
      `In \`opscrew interview${flags}\`, ${deep.next}; then run \`opscrew design${flags}\` again.`,
    );
  }
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `"${app}" is served behind Cloudflare's proxy, so its server's firewall lets web traffic in only from Cloudflare, and this app's domain ${requirements.domain === undefined ? "isn't set" : "isn't on Cloudflare"}: it would be served behind Cloudflare's proxy too, which needs its domain on your Cloudflare account.`,
    `Put the domain's DNS on Cloudflare (or use a name in a zone you have there) and answer dnsProvider cloudflare with \`opscrew interview${flags}\`; or give this app a server of its own there; then run \`opscrew design${flags}\` again.`,
  );
}

/**
 * Stops design for a second app whose proxy (`target.edge` in plan.yaml) differs from the one the
 * first app's (`first`) server runs for every app on it (plan 7., step 2), naming both. `hint`
 * replaces design's next step (another command's: a move onto the server).
 * @throws OpsCrewError `PHASE_PRECONDITION`, before anything is written.
 */
export function requireSharedEdge(
  plan: DeployPlan,
  first: DeployPlan,
  where: { planFile: string; flags: string },
  hint?: string,
): void {
  const mine = edgeProxy(plan);
  const theirs = edgeProxy(first);
  if (mine === theirs) return;
  throw refusedBeforeChange(
    "PHASE_PRECONDITION",
    `This app's proxy is ${EDGE_PROXIES[mine].label} (target.edge in ${where.planFile}), and the server of "${first.app.name}" runs ${EDGE_PROXIES[theirs].label} for every app on it.`,
    hint ??
      `Set target.edge: ${theirs} in ${where.planFile}, then run \`opscrew design${where.flags}\` again.`,
  );
}

/**
 * The second app's plan on the server of the first app (`first`): `target.shares` names it and
 * where OpsCrew created its server, and a plan with no proxy of its own yet (`keepEdge` false)
 * takes the one that server runs.
 */
export function sharedPlan(plan: DeployPlan, first: DeployPlan, keepEdge: boolean): DeployPlan {
  if (plan.target.provider !== "own" || !isCloudTarget(first.target)) {
    throw new Error("A second app is an own target on a server OpsCrew created.");
  }
  const shares = { app: first.app.name, provider: first.target.provider };
  const edge = keepEdge ? plan.target.edge : edgeProxy(first);
  return DeployPlanSchema.parse({ ...plan, target: { ...plan.target, shares, edge } });
}

export interface OwnServerOptionInput {
  facts: ProjectFacts;
  requirements: Requirements;
  /** The own-server catalogue: the inspected server as its single offer. */
  catalog: ComputeCatalog;
  access: OwnServerAccess;
  /** How the site is served (default: from `access`, a public server as DNS only). */
  serving?: OwnServerServing;
  /** What runs next to the app (`designComponents`); by default designed from the facts. */
  components?: Components;
  /** The server's proxy (`target.edge`), whose memory the sizing counts; Caddy by default. */
  edge?: EdgeProxy;
  /** A preview server's cap: its memory line counts that many previews. */
  previewCap?: number;
  /** A preview server that is another environment's (`previews.server`): that environment. */
  previewHost?: PreviewHost;
  /** A second app beside the first app on the server OpsCrew created for it. */
  shares?: SharedServerOption;
}

export interface OwnServerDesign {
  option: DesignOption;
  /** Plain-English problems: too little memory or disk, a tunnel without a Cloudflare domain. */
  warnings: string[];
}

/** True when the app is served through a tunnel but the user gave no domain on Cloudflare. */
export function tunnelNeedsCloudflareDomain(
  requirements: Pick<Requirements, "dnsProvider" | "domain">,
  access: OwnServerAccess,
): boolean {
  return access === "tunnel" && !(requirements.dnsProvider === "cloudflare" && requirements.domain);
}

/** The plain error (and next step) when a tunnel has no domain on Cloudflare. */
export function tunnelDomainMessage(): { message: string; hint: string } {
  return {
    message:
      "The internet cannot reach your server, so OpsCrew serves the app through a Cloudflare Tunnel, which needs a domain on your Cloudflare account, and you have not given one.",
    hint: "Run `opscrew interview` again and give a domain whose DNS is on Cloudflare, or say that the internet can reach the server.",
  };
}

/** `7.8` for 7.75 GB: at most one decimal. */
function gb(amount: number): string {
  return String(Math.round(amount * 10) / 10);
}

/**
 * Two amounts in GB for one sentence ("has X, needs Y"): whole numbers, or one decimal (then two)
 * when rounding would show the same number for both and the sentence would contradict itself.
 */
export function distinctAmounts(a: number, b: number): [string, string] {
  for (const decimals of [0, 1, 2]) {
    const factor = 10 ** decimals;
    const show = (amount: number) => String(Math.round(amount * factor) / factor);
    if (show(a) !== show(b)) return [show(a), show(b)];
  }
  return [String(a), String(b)];
}

/**
 * The single design option on a server the user already owns: the inspected server (the
 * catalogue's only offer) with no price ("you already pay for this server"), warnings when its
 * memory is clearly below what the sizing table plans for the app (below 90%: inspected memory
 * sits a little under the nominal size) or its free disk below what the app itself needs (the
 * operating system is already installed; `ownServerFreeDiskGb`), the Cloudflare Tunnel
 * when the internet cannot reach it (which needs a domain on Cloudflare), and the note on what
 * OpsCrew backs up (the app's data, by its snapshots) and what is the user's. Validated with `DesignOptionSchema`.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the server has not been inspected (no offer).
 */
export async function buildOwnServerOption(input: OwnServerOptionInput): Promise<OwnServerDesign> {
  const { facts, requirements, catalog, access } = input;
  const serving = input.serving ?? (access === "tunnel" ? "tunnel" : "dns-only");
  if (catalog.provider !== "own") {
    throw new Error(`Design needs the own-server catalogue but got the ${catalog.provider} one.`);
  }
  const server: ComputeOffer | undefined = (await catalog.listOffers())[0];
  if (server === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      "OpsCrew has not inspected your server yet, so it cannot check that the server is big enough for this app.",
      {
        hint: "OpsCrew reads the server's memory, disk and architecture over SSH before it designs the deployment. Check the answers about your server with `opscrew interview` and run `opscrew design` again.",
      },
    );
  }
  const sizing = sizeFor(facts, requirements, input.components, input.edge);
  const containers = containersText(sizing);
  const arch = server.architecture === "arm" ? "arm64" : "amd64";

  // One warning per shortfall: a service's own smallest server, else the server's size overall.
  const warnings = smallServerWarnings(sizing.services, server.memoryGb * 1024);
  if (warnings.length === 0 && server.memoryGb < sizing.memoryGb * OWN_SERVER_MEMORY_TOLERANCE) {
    const [has, needs] = distinctAmounts(server.memoryGb, sizing.memoryGb);
    warnings.push(
      `Your server has ${has} GB of memory, but OpsCrew plans at least ${needs} GB for ${containers} at the number of users you expect. The app may slow down or stop when memory runs out: add memory to the server, or expect fewer users.`,
    );
  }
  const freeDiskNeed = ownServerFreeDiskGb(sizing);
  if (server.diskGb < freeDiskNeed) {
    const [has, needs] = distinctAmounts(server.diskGb, freeDiskNeed);
    warnings.push(
      `Your server has ${has} GB of free disk, but OpsCrew plans at least ${needs} GB of free disk for ${containers}, their images and updates. Free up space or add disk before you deploy.`,
    );
  }
  if (tunnelNeedsCloudflareDomain(requirements, access)) {
    const { message, hint } = tunnelDomainMessage();
    warnings.push(`${message} ${hint}`);
  }

  const host = input.previewHost;
  const { shares } = input;
  const hostLine = host === undefined ? undefined : hostServerNote(host.environment);
  const cost = noServerCost(
    shares !== undefined
      ? sharedServerCostItem(shares.app)
      : host === undefined
        ? "Your own server (you already pay for it)"
        : `${host.environment}'s server (priced with ${host.environment})`,
    requirements.budgetMonthly.currency,
    server.asOf,
  );

  const os = server.description === undefined ? "" : `, ${server.description}`;
  const served =
    shares !== undefined
      ? shares.proxied
        ? ` The app is served behind Cloudflare's proxy: the server's firewall lets only Cloudflare's addresses reach ports 80 and 443, as the plan of "${shares.app}" sets it.`
        : ` The app is served with DNS only: the server lets everyone reach ports 80 and 443, as the plan of "${shares.app}" sets it.`
      : host !== undefined
        ? host.cloudflareOnly
          ? ` The previews are served behind Cloudflare's proxy, and ${host.environment}'s server lets only Cloudflare's addresses reach ports 80 and 443.`
          : ` The previews are served behind Cloudflare's proxy, and ${host.environment}'s server lets everyone reach ports 80 and 443, as ${host.environment}'s plan sets it.`
        : access === "tunnel"
          ? " The app is served through a Cloudflare Tunnel, so no ports are opened on the server."
          : serving === "proxy"
            ? " The app is served directly behind Cloudflare's proxy; a filter in Docker lets only Cloudflare's addresses reach ports 80 and 443."
            : "";
  const where =
    shares !== undefined
      ? `The ${shares.provider} server OpsCrew created for "${shares.app}"`
      : host === undefined
        ? "Your own server"
        : `${host.environment}'s server`;
  const summary = [
    `${where} (${server.vcpus} vCPU, ${gb(server.memoryGb)} GB memory, ${gb(server.diskGb)} GB free disk, ${arch}${os}) running ${containers} with Docker Compose behind ${EDGE_PROXIES[sizing.edge].label}.${served}`,
    input.previewCap === undefined
      ? memoryText(
          sizing.components,
          server.memoryGb * 1024,
          sizing.edgeMb,
          undefined,
          undefined,
          shares?.others ?? [],
        )
      : previewMemoryText(
          sizing.components,
          input.previewCap,
          server.memoryGb * 1024,
          sizing.edgeMb,
          input.previewHost,
        ),
    ...(shares !== undefined
      ? [
          sharedPriceNote(shares.app),
          sharedBackupsNote(shares.app),
          sharedAccessWarning(shares.app),
        ]
      : hostLine === undefined
        ? [OWN_SERVER_PRICE_NOTE, OWN_SERVER_BACKUPS_NOTE]
        : [hostLine]),
  ].join(" ");

  const tradeoffs = [...warnings];
  if (shares !== undefined) {
    tradeoffs.push(
      shares.proxied
        ? `Served behind Cloudflare's proxy, as "${shares.app}" is: the server's cloud firewall lets only Cloudflare reach ports 80 and 443, for every app on it.`
        : `DNS only, as "${shares.app}" is: the server answers everyone on ports 80 and 443, and Cloudflare only answers DNS, so it neither hides nor protects the server.`,
    );
  } else if (access === "tunnel") {
    tradeoffs.push(
      "OpsCrew serves the app through a Cloudflare Tunnel on your Cloudflare domain: no inbound ports are opened, and deploys from GitHub go through the tunnel too.",
    );
  } else if (host === undefined && serving === "proxy") {
    tradeoffs.push(
      "Ports 80 and 443 stay open, but OpsCrew's filter in Docker's DOCKER-USER chain lets only Cloudflare's addresses through (no Cloudflare Zero Trust needed). It fails closed: if the filter cannot be installed, Docker does not start and the site is down until it is fixed. A Cloudflare Tunnel opens no port at all.",
    );
  } else if (hasCloudflareDomain(requirements)) {
    tradeoffs.push(
      "DNS only: your server answers everyone on ports 80 and 443, and Cloudflare only answers DNS, so it neither hides nor protects the server. A Cloudflare Tunnel opens no port at all.",
    );
  }
  if (arch === "arm64") {
    tradeoffs.push("Your server uses arm64, so OpsCrew builds the app image for arm64.");
  }
  tradeoffs.push("A single server: if it fails, the app is down until the server is restored.");
  if (serviceOf(sizing, "postgres")) {
    tradeoffs.push(
      "Postgres runs in a container on the same server, so its data is only as safe as that server: keep the snapshots' encrypted copy off it.",
    );
  }
  tradeoffs.push(
    shares !== undefined ? sharedBackupsNote(shares.app) : (hostLine ?? OWN_SERVER_BACKUPS_NOTE),
  );

  const option = DesignOptionSchema.parse({
    id: OWN_SERVER_OPTION_ID,
    title:
      shares !== undefined
        ? `Beside "${shares.app}" on its ${shares.provider} server`
        : host === undefined
          ? "Your server"
          : `${host.environment}'s server`,
    summary,
    target: {
      provider: "own",
      location: OWN_SERVER_LOCATION,
      serverType: OWN_SERVER_TYPE,
      vcpus: server.vcpus,
      // The option schema needs positive sizes; a full disk (0 GB free) already has its warning.
      memoryGb: Math.max(server.memoryGb, 0.01),
      diskGb: Math.max(server.diskGb, 0.01),
      cpuType: server.cpuType,
      architecture: server.architecture,
    },
    services: [...sizing.services],
    externalServices: [...sizing.externalServices],
    backups: false,
    cost,
    fitsBudget: true,
    recommended: true,
    tradeoffs,
  });
  return { option, warnings };
}
