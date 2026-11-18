/**
 * What the user sets on their router for a server at home (FR-2902): the forwards of TCP 80 and
 * 443 to the server's address on the home network, its DHCP reservation, SSH left unforwarded,
 * and the IPv6 firewall rule whenever an AAAA record is published (M12). OpsCrew never touches the
 * router: these lines are all it does about it.
 */
import { listText } from "@opscrew/core";

/** What {@link homeForwards} needs to know about the server and its records. */
export interface HomeForwardsInput {
  /** The server's address on the home network (`own.home.network.lan.address`). */
  lanAddress?: string;
  /** The site is served over IPv4: an A record is published (`target.home.ipv4`). */
  ipv4: boolean;
  /** The public IPv4 address is on the server's own interface (the classification's `noNat`). */
  noNat: boolean;
  /** An AAAA record is published. */
  aaaa: boolean;
  /** The networks that may reach SSH (`own.home.sshFrom`). */
  sshFrom?: readonly string[];
}

/** The rule for the router's IPv6 firewall, said whenever an AAAA record is published. */
export const ROUTER_IPV6_RULE =
  "Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.";

/**
 * The router lines, one sentence each: over IPv4 through NAT, the two forwards, the DHCP
 * reservation and SSH staying unforwarded; without NAT, that no forwards are needed; then the
 * IPv6 firewall rule when an AAAA record is published.
 */
export function homeForwards(input: HomeForwardsInput): string[] {
  const lines: string[] = [];
  if (input.ipv4 && input.noNat) {
    lines.push("Your server has its public IPv4 address itself, so your router needs no forwards.");
  } else if (input.ipv4) {
    const address = input.lanAddress;
    lines.push(
      `On your router, forward TCP 80 and TCP 443 to ${address ?? "this server's address on your network"}.`,
      `Reserve ${address ?? "that address"} for this server in the router's DHCP settings so it stays fixed.`,
      input.sshFrom === undefined || input.sshFrom.length === 0
        ? "Don't forward SSH."
        : `Don't forward SSH: only ${listText(input.sshFrom)} may reach it.`,
    );
  }
  if (input.aaaa) lines.push(ROUTER_IPV6_RULE);
  return lines;
}
