/**
 * The words said about serving from home (research R3, R6, R14; FR-2908, FR-2914): the provider's
 * terms, large media and Cloudflare's proxy, what the address updater's token can reach, the
 * warning of a connection without a public IPv4 address of its own, and what works with DNS
 * elsewhere. Callers print them; none holds an address of the home.
 */
import type { HomeNetworkWarning } from "./network";

/** The provider's terms on running servers, with no claim about any provider. */
export const ISP_TERMS =
  "Check your internet provider's terms: many home plans restrict running servers.";

/** Large media and Cloudflare's proxy. */
export const LARGE_MEDIA =
  "Don't serve videos or large downloads through Cloudflare's proxy: its terms limit that without paid services.";

/** With the domain's DNS elsewhere there is no updater: only a fixed address keeps working. */
export const DNS_ELSEWHERE =
  "Your domain's DNS isn't on Cloudflare, so OpsCrew can't update the site's records when your home's address changes: only a fixed address keeps working. Add the records yourself; if your provider changes your address, move the domain's DNS to Cloudflare.";

/** What the updater's token can reach in the zone `zone`, said plainly (R6, R14). */
export function updaterTokenReach(zone: string): string {
  return `The updater changes only this app's A/AAAA records, but the token can change any record in ${zone}. Anything with root on your server can use it, the deploy runner included: it runs your repository's code in the docker group, which is as good as root.`;
}

/** What each warning saw. */
const WARNING_SEEN: Record<HomeNetworkWarning, string> = {
  "cgnat-hop": "a router after yours has a carrier-grade NAT address (100.64.0.0/10)",
  "private-hop":
    "a router after yours has a private address, so another NAT may stand between your router and the internet",
  "cgnat-interface": "your server's own address is a carrier-grade NAT address (100.64.0.0/10)",
};

/**
 * The warning (design goes on) that the connection looks like it has no public IPv4 address:
 * what was seen, that the outside check decides, and the alternatives: the tunnel, and with
 * IPv6 serving over IPv6 behind Cloudflare's proxy (`proxied`: the app already is).
 */
export function carrierNatWarning(
  warning: HomeNetworkWarning,
  options: { ipv6: boolean; proxied: boolean },
): string[] {
  const proxy = options.proxied ? "set" : "answer server.serve proxy and set";
  const ipv6 = options.ipv6
    ? `, or, since your server has IPv6, serve over IPv6 behind Cloudflare's proxy (${proxy} target.home.ipv4: false in opscrew/plan.yaml)`
    : "";
  return [
    `! Your connection looks like it has no public IPv4 address: ${WARNING_SEEN[warning]}.`,
    "  Forwards on your router may then never answer from outside. `npx opscrew verify` checks that once the app runs.",
    `  Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel)${ipv6}.`,
  ];
}
