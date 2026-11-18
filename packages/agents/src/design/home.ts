/**
 * Design for a server at the user's home (plan 3. and 12.; research R1, R3, R5, R10): what the
 * server sees of its network decides `target.home`, or stops design before anything is written;
 * the plan gets `target.home` and the server's runner; `.opscrew/server.json` gets SSH's sources
 * and the network's classification (never a public address); and the summary says what to set on
 * the router, the terms, and the address updater's token. A proxied app's home address is
 * registered with the redactor and never printed.
 */
import {
  agreedIpv4,
  canonicalSshSource,
  type HomeNetwork,
  type HostFacts,
} from "@opscrew/connector-ssh-host";
import { listText, type OpsCrewError, type ProjectPaths, toPosixRelative } from "@opscrew/core";
import { snapshotParts } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  likelyCloudflareZone,
  type Requirements,
} from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { commandFlags } from "../environments/choice";
import { homeForwards, homeForwardsInput } from "../home/forwards";
import { classifyHomeNetwork, type HomeNetworkClass, registerHomeAddresses } from "../home/network";
import {
  carrierNatWarning,
  DNS_ELSEWHERE,
  ISP_TERMS,
  LARGE_MEDIA,
  updaterTokenReach,
} from "../home/texts";
import { UPDATER_TOKEN_VAR, updaterTokenRecipe } from "../home/token";
import { refusedBeforeChange, requireNoSharedPreviews } from "../previews/host";
import { type OwnHome, readOwnServer, updateServerAddresses } from "../shared/server-record";
import type { OwnServerServing } from "./own";

/** IPv6 link-local addresses, which may always reach SSH beside the home network. */
const LINK_LOCAL = "fe80::/10";

/** What {@link designHome} needs besides the project. */
export interface HomeDesignInput {
  /** How the site is served (`ownServerServing`, from the interview's `server.serve`). */
  serving: OwnServerServing;
  /** What `detectHomeNetwork` read on the server this run, after inspection. */
  network: HomeNetwork | undefined;
  /** The plan on disk: its `target.home.ipv4: false` is the user's and is kept. */
  previous: DeployPlan | undefined;
  requirements: Pick<Requirements, "dnsProvider" | "domain">;
}

/** What design decided for a server at home. */
export interface HomeDesign {
  /** `target.home.ipv4`: the site is served over IPv4. */
  ipv4: boolean;
  /** `.opscrew/server.json` → `own.home` as design leaves it: SSH's sources and the network read. */
  record: OwnHome;
  /** The summary, one line each; never a proxied app's address. */
  lines: string[];
  /** The plan's file and the app's and environment's command flags, for the refusals. */
  planFile: string;
  flags: string;
}

/** The plan's `target.home`, when it has one. */
function plannedHome(plan: DeployPlan | undefined): { ipv4: boolean } | undefined {
  return plan?.target.provider === "own" ? plan.target.home : undefined;
}

/**
 * A server at home (`own.home` recorded, not served through the tunnel): registers a proxied app's
 * detected addresses with the redactor, refuses while a preview environment names this server
 * (M5), then decides `target.home.ipv4` from the network (plan 3.'s table) and SSH's sources (the
 * answer, else the home network and {@link LINK_LOCAL}), and words the summary. `undefined` for a
 * server not at home, or at home through the tunnel. Reads only: nothing is written here.
 * @throws OpsCrewError `PHASE_PRECONDITION` for each stop of the table, and when SSH's sources are
 * needed but not answered.
 */
export async function designHome(
  deps: Pick<PhaseDeps, "paths" | "redactor" | "clock">,
  input: HomeDesignInput,
): Promise<HomeDesign | undefined> {
  const own = await readOwnServer(deps.paths);
  if (own?.home === undefined || input.serving === "tunnel") return undefined;
  const { network } = input;
  if (network === undefined) {
    throw new Error("Design for a server at home needs what detectHomeNetwork read on it.");
  }
  const proxied = input.serving === "proxy";
  registerHomeAddresses(deps.redactor, network, proxied);
  const { paths } = deps;
  const flags = await commandFlags(paths.root, paths.environment, paths.app);
  await requireNoSharedPreviews(paths, "serving it at home", `opscrew design${flags}`, true);

  const planFile = toPosixRelative(paths.root, paths.files.plan);
  const found = classifyHomeNetwork(network);
  const planned = plannedHome(input.previous)?.ipv4;
  const ipv4 = servedOverIpv4(found, proxied, planned, { planFile, flags });
  const lan = found.noNat ? undefined : homeLan(network);
  // A carrier-grade NAT address on the server's own interface: its network is the provider's,
  // shared with other customers, so it is never SSH's default.
  const sshDefault = found.warning === "cgnat-interface" ? undefined : lan;
  const sshFrom =
    own.home.sshFrom ?? (sshDefault === undefined ? undefined : [sshDefault.network, LINK_LOCAL]);
  if (sshFrom === undefined) throw sshFromNeeded(found, flags);
  const record: OwnHome = {
    ...own.home,
    sshFrom,
    network: {
      detectedAt: deps.clock.now().toISOString(),
      ...(lan === undefined ? {} : { lan }),
      ...found,
    },
  };
  const { dnsProvider, domain } = input.requirements;
  const zone =
    dnsProvider === "cloudflare" && domain !== undefined
      ? (input.previous?.dns.zone ?? likelyCloudflareZone(domain))
      : undefined;
  const lines = summary({ network, found, proxied, ipv4, planned, lan, sshFrom }, planFile);
  if (zone === undefined) lines.push(DNS_ELSEWHERE);
  else {
    lines.push(
      "The address updater on your server keeps the site's DNS records at your home's address, with a Cloudflare token of its own.",
      ...updaterTokenRecipe(zone, UPDATER_TOKEN_VAR, `opscrew provision${flags}`, true).split("\n"),
      updaterTokenReach(zone),
    );
  }
  return { ipv4, record, lines, planFile, flags };
}

/** The refusals' words for the command to run again. */
interface Again {
  planFile: string;
  flags: string;
}

/**
 * Whether the site is served over IPv4 (plan 3.): yes when the server sees a public IPv4 address,
 * unless the plan says `ipv4: false`; no behind the proxy when it has no IPv4 route but IPv6; and
 * with DNS only over IPv6 alone only when the plan says so (the user's acceptance).
 * @throws OpsCrewError `PHASE_PRECONDITION` when its public IPv4 address is unknown, when nothing
 * would serve the site (no IPv4 and no IPv6), and for DNS only over IPv6 the plan doesn't accept.
 */
function servedOverIpv4(
  found: HomeNetworkClass,
  proxied: boolean,
  planned: boolean | undefined,
  { planFile, flags }: Again,
): boolean {
  const tunnel = `run \`opscrew interview${flags}\` and answer server.serve tunnel (a Cloudflare Tunnel works on any connection; it needs a domain on your Cloudflare account), then run \`opscrew design${flags}\` again`;
  if (found.ipv4 === "unknown") {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      "Your server at home couldn't see its public IPv4 address: the two address checks over HTTPS didn't answer, or gave different addresses.",
      `Check that the server can make outgoing HTTPS connections, then run \`opscrew design${flags}\` again. Or, since a tunnel needs no public address, ${tunnel}.`,
    );
  }
  const ipv6 = found.ipv6 === "present";
  const ipv4 = found.ipv4 === "seen" && planned !== false;
  if (!ipv4 && !ipv6) {
    throw found.ipv4 === "none"
      ? refusedBeforeChange(
          "PHASE_PRECONDITION",
          "Your server at home has no IPv4 connection to the internet and no IPv6 address, so visitors couldn't reach it at your home's address.",
          `To serve it anyway, ${tunnel}.`,
        )
      : refusedBeforeChange(
          "PHASE_PRECONDITION",
          `${planFile} says target.home.ipv4: false, so the site would be served over IPv6 only, but your server at home has no IPv6 address: visitors couldn't reach it.`,
          `Remove target.home.ipv4: false from ${planFile} to serve over IPv4, then run \`opscrew design${flags}\` again; or ${tunnel}.`,
        );
  }
  if (!ipv4 && !proxied && planned !== false) {
    throw refusedBeforeChange(
      "PHASE_PRECONDITION",
      "Your server at home has no IPv4 connection to the internet, only IPv6, so with DNS only visitors without IPv6 couldn't reach the site.",
      `Run \`opscrew interview${flags}\` and answer server.serve proxy (Cloudflare's proxy answers every visitor and reaches your server over IPv6) or tunnel, then run \`opscrew design${flags}\` again. To serve only visitors with IPv6, set target.home.ipv4: false in ${planFile} and run \`opscrew design${flags}\` again.`,
    );
  }
  return ipv4;
}

/**
 * The server's place on the home network as `own.home.network.lan` keeps it: its address, the
 * network (`192.168.1.0/24`), the interface and the router. `undefined` without an IPv4 route.
 */
function homeLan(
  network: HomeNetwork,
): NonNullable<NonNullable<OwnHome["network"]>["lan"]> | undefined {
  const lan = network.lan;
  const range = lan === undefined ? null : canonicalSshSource(`${lan.address}/${lan.prefix}`);
  if (lan === undefined || range === null) return undefined;
  return {
    address: lan.address,
    network: range,
    interface: lan.interface,
    ...(lan.gateway === undefined ? {} : { gateway: lan.gateway }),
  };
}

/**
 * The stop when SSH's sources have no default: the server holds its public IPv4, its own address is
 * a carrier-grade NAT one (the provider's network), or it has no IPv4 home network.
 */
function sshFromNeeded(found: HomeNetworkClass, flags: string): OpsCrewError {
  return refusedBeforeChange(
    "PHASE_PRECONDITION",
    found.noNat
      ? "Your server at home has its public IPv4 address itself, so there is no home network OpsCrew can keep SSH to."
      : found.warning === "cgnat-interface"
        ? "Your server at home has a carrier-grade NAT address (100.64.0.0/10) on its own interface, so its network is your internet provider's, shared with other customers: OpsCrew can't keep SSH to it."
        : "OpsCrew found no IPv4 home network for your server at home, so there is no home network it can keep SSH to.",
    `Name the networks that may reach SSH in server.sshFrom in an answers file (for example \`server.sshFrom: 192.168.1.0/24 2001:db8:1::/64\`), run \`opscrew interview${flags} --answers <file>\`, then run \`opscrew design${flags}\` again.`,
  );
}

/** What {@link summary} words. */
interface SummaryInput {
  network: HomeNetwork;
  found: HomeNetworkClass;
  proxied: boolean;
  ipv4: boolean;
  planned: boolean | undefined;
  lan: ReturnType<typeof homeLan>;
  sshFrom: readonly string[];
}

/**
 * The summary before the token's lines: the address found (a proxied app's never shown, DNS only's
 * printed), the carrier-NAT warning, the router's lines, the provider's terms and, behind the
 * proxy, large media.
 */
function summary(input: SummaryInput, planFile: string): string[] {
  const { network, found, proxied, ipv4, planned } = input;
  const forwards = homeForwardsInput({
    ipv4,
    proxied,
    network: found,
    lanAddress: input.lan?.address,
    sshFrom: input.sshFrom,
  });
  const v6 = network.ipv6.stable;
  let address: string;
  if (ipv4) {
    address = proxied
      ? "OpsCrew found your home's public IPv4 address from your server. It isn't shown: behind Cloudflare's proxy no visitor sees it."
      : `Your home's public address is ${agreedIpv4(network.ipv4)}${forwards.aaaa && v6 !== undefined ? ` and ${v6}` : ""}: the site's DNS records point there, so anyone can look it up.`;
  } else if (planned !== false) {
    address =
      "Your server has no IPv4 connection to the internet, but it has IPv6: OpsCrew serves the site over IPv6 behind Cloudflare's proxy (target.home.ipv4: false), and Cloudflare still answers visitors over IPv4. A Cloudflare Tunnel works on any connection too (answer server.serve tunnel).";
  } else {
    address = proxied
      ? `${planFile} says target.home.ipv4: false, so OpsCrew serves the site over IPv6 behind Cloudflare's proxy.`
      : `${planFile} says target.home.ipv4: false, so the site is served over IPv6 only, at ${v6}: visitors without IPv6 can't reach it.`;
  }
  return [
    address,
    ...(ipv4 && found.warning !== undefined
      ? carrierNatWarning(found.warning, { ipv6: found.ipv6 === "present", proxied })
      : []),
    ...homeForwards(forwards),
    ISP_TERMS,
    ...(proxied ? [LARGE_MEDIA] : []),
  ];
}

/**
 * `plan` served from home: `target.home` with `ipv4`, and the deploys on the server's runner
 * unless the plan has a runner machine (`runner: host`).
 * @throws OpsCrewError `INVALID_INPUT` naming the field when the plan can't go with a server at
 * home (extra servers, a private network, no domain), before anything is written.
 */
export function homePlan(
  plan: DeployPlan,
  home: Pick<HomeDesign, "ipv4" | "planFile" | "flags">,
): DeployPlan {
  if (plan.target.provider !== "own") throw new Error("A server at home is the user's own server.");
  const { edge, ...target } = plan.target;
  const { environment } = plan;
  const parsed = DeployPlanSchema.safeParse({
    ...plan,
    target: { ...target, home: { ipv4: home.ipv4 }, edge },
    environment:
      environment?.runner === "host" ? environment : { ...environment, runner: "server" },
  });
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  throw refusedBeforeChange(
    "INVALID_INPUT",
    `OpsCrew can't serve this app from your server at home: ${issue?.path.join(".") || "plan"} ${issue?.message ?? "is not valid"}.`,
    `Fix the field shown above in ${home.planFile}, or change your answers with \`opscrew interview${home.flags}\`, then run \`opscrew design${home.flags}\` again.`,
  );
}

/** Records what design read of the home's network, and SSH's sources, in `.opscrew/server.json`. */
export async function recordHomeDesign(paths: ProjectPaths, home: OwnHome): Promise<void> {
  await updateServerAddresses(paths, (current) =>
    current.own === undefined ? current : { ...current, own: { ...current.own, home } },
  );
}

/**
 * The Raspberry Pi warning (plan 12., research R10): the board is a Raspberry Pi, Docker's data or
 * `/srv` is on an SD card (or a memory card inspection can't tell from eMMC), and the app keeps
 * data on the server (what `opscrew snapshot` copies). It recommends an SSD and never refuses.
 */
export function piStorageWarning(
  host: { board?: HostFacts["board"]; storage?: HostFacts["storage"] },
  plan: DeployPlan,
): string | undefined {
  if (!/raspberry pi/i.test(host.board ?? "")) return undefined;
  const card = [host.storage?.docker, host.storage?.srv].find(
    (device) => device?.kind === "sd" || device?.kind === "mmc-unknown",
  );
  const data = snapshotParts(plan).map((part) => part.name);
  if (card == null || data.length === 0) return undefined;
  const what =
    card.kind === "sd"
      ? "an SD card"
      : "a memory card (an SD card or eMMC: OpsCrew can't tell which)";
  return `Your server is a Raspberry Pi whose data is on ${what} (${card.source}), and the app keeps ${listText(data)} there. SD cards wear out under a database's writes and can fail without warning, taking the data with them: move the data to a USB or NVMe SSD (boot from it, or mount it at /srv and Docker's data root) before you deploy.`;
}
