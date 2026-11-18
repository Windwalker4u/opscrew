/**
 * A home server's network (research R3): its read through the host adapter's `detectHomeNetwork`
 * ({@link readHomeNetwork}), and the classification of what it found, turned into the facts
 * design, provision and verify act on and `.opscrew/server.json` keeps (`own.home.network`,
 * beside the LAN facts and the time). The classification holds no address, so the public
 * addresses stay in the run's memory only, hidden from output for a proxied app.
 */
import { agreedIpv4, type HomeNetwork, isPublicAddress } from "@opscrew/connector-ssh-host";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError, type Redactor } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import { boundHostAdapter, type HostAdapterApi } from "../shared/host-plan";
import type { OwnServerSession } from "../shared/own-server";
import type { OwnHome } from "../shared/server-record";

/** What {@link classifyHomeNetwork} found: `own.home.network` without the LAN facts and the time. */
export type HomeNetworkClass = Omit<NonNullable<OwnHome["network"]>, "detectedAt" | "lan">;

/** A sign the connection may have no public IPv4 address of its own. */
export type HomeNetworkWarning = NonNullable<HomeNetworkClass["warning"]>;

/** The label a proxied app's detected addresses are hidden behind in every line. */
export const HOME_ADDRESS_LABEL = "your home's address";

/** An IPv4 address as a number, or undefined when it isn't one. */
function ipv4Number(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = value * 256 + Number(part);
  }
  return value;
}

/** True when `address` is in the IPv4 network `base`/`prefix`. */
function holds(base: string, prefix: number, address: string): boolean {
  const network = ipv4Number(base);
  const value = ipv4Number(address);
  if (network === undefined || value === undefined) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(network / size) === Math.floor(value / size);
}

/** Carrier-grade NAT's shared range (RFC 6598). */
const isCarrierNat = (address: string) => holds("100.64.0.0", 10, address);

/** The private ranges (RFC 1918). */
const isPrivate = (address: string) =>
  holds("10.0.0.0", 8, address) ||
  holds("172.16.0.0", 12, address) ||
  holds("192.168.0.0", 16, address);

/**
 * The hops after the home router: those neither the router nor on the home network. When the home
 * network isn't known, the first hop is taken as the router.
 */
function hopsAfterRouter(network: HomeNetwork): string[] {
  const lan = network.lan;
  if (lan === undefined) return network.hops.slice(1);
  return network.hops.filter((hop) => hop !== lan.gateway && !holds(lan.address, lan.prefix, hop));
}

/**
 * Classifies the home's network (research R3, data model 2):
 * - `ipv4`: `seen` when a source, or both agreeing, gave a public address; `none` without an IPv4
 *   route; `unknown` when IPv4 routes but no source answered, or the two disagree;
 * - `noNat`: the public IPv4 address is on the server's own interface, so no forwards are needed;
 * - `warning`, only for a public IPv4 address seen through NAT: `cgnat-interface` (a carrier-grade
 *   NAT address on the server's own interface), else `cgnat-hop` or `private-hop` (such a hop
 *   after the home router). The outside check has the final word;
 * - `ipv6`: as detected.
 */
export function classifyHomeNetwork(network: HomeNetwork): HomeNetworkClass {
  const ipv6 = network.ipv6.state;
  if (!network.ipv4.route) return { ipv4: "none", noNat: false, ipv6 };
  const seen = agreedIpv4(network.ipv4);
  if (seen === undefined) return { ipv4: "unknown", noNat: false, ipv6 };
  const onInterface = network.ipv4.interface;
  if (onInterface === seen) return { ipv4: "seen", noNat: true, ipv6 };
  const after = hopsAfterRouter(network);
  const warning: HomeNetworkWarning | undefined =
    onInterface !== undefined && isCarrierNat(onInterface)
      ? "cgnat-interface"
      : after.some(isCarrierNat)
        ? "cgnat-hop"
        : after.some(isPrivate)
          ? "private-hop"
          : undefined;
  return { ipv4: "seen", noNat: false, ...(warning === undefined ? {} : { warning }), ipv6 };
}

/**
 * For a proxied app, registers the home's detected public addresses (each source's IPv4 answer,
 * the one on the server's own interface, the stable IPv6 address) with the redactor as names
 * labelled {@link HOME_ADDRESS_LABEL}, so no line of the run shows them. A DNS-only app's address
 * is in its public DNS records, so nothing is registered for it.
 */
export function registerHomeAddresses(
  redactor: Pick<Redactor, "addName">,
  network: HomeNetwork,
  proxied: boolean,
): void {
  if (!proxied) return;
  const { cloudflare, aws, interface: onInterface } = network.ipv4;
  for (const address of [cloudflare, aws, onInterface, network.ipv6.stable]) {
    if (address !== undefined && isPublicAddress(address)) {
      redactor.addName(address, HOME_ADDRESS_LABEL);
    }
  }
}

/**
 * Reads the home's network from the server over `session` (read-only, through `host`'s
 * `detectHomeNetwork`), audits it as "detect home network (read-only)" under `phase` with
 * `detail`, and for a proxied app registers the detected addresses ({@link registerHomeAddresses}).
 */
export async function readHomeNetwork(
  deps: Pick<PhaseDeps, "audit" | "redactor">,
  session: Pick<OwnServerSession, "remote">,
  options: {
    host: HostAdapterApi | undefined;
    proxied: boolean;
    phase?: PhaseName;
    detail?: string;
  },
): Promise<HomeNetwork> {
  const network = await boundHostAdapter(options.host).detectHomeNetwork(session.remote);
  await deps.audit.append({
    kind: "remote-exec",
    actor: "opscrew",
    action: "detect home network (read-only)",
    ...(options.phase !== undefined ? { phase: options.phase } : {}),
    target: "own server",
    decision: "allow",
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  });
  registerHomeAddresses(deps.redactor, network, options.proxied);
  return network;
}

/**
 * The stop when this computer doesn't know which networks may reach SSH at home
 * (`own.home.sshFrom`): design finds them, then `command` runs again. `consequence` ends the
 * first sentence (`, so …` or `. Nothing was changed.`).
 */
export function sshSourcesUnknown(
  flags: string,
  command: string,
  consequence: string,
): OpsCrewError {
  return new OpsCrewError(
    "PHASE_PRECONDITION",
    `OpsCrew doesn't know on this computer which networks may reach your server's SSH at home${consequence}`,
    {
      hint: `Run \`opscrew design${flags}\` again: it finds your home network. Then run \`${command}${flags}\` again.`,
    },
  );
}
