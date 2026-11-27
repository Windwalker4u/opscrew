import { SERVER_MODULE_FILES } from "../generated/modules";
import { templatefile } from "./cloud-init";

/**
 * The file OpsCrew adds to the server module of a provider with no cloud firewall and a
 * startup-script first boot (`ProviderSecOps.firewallCheck` `server`, issue #13): the server's own
 * firewall, which the module renders from its networks and passes to `first-boot.sh.tftpl` as
 * its first step.
 */
export const SERVER_FIREWALL_FILE = "server-firewall.sh.tftpl";

/** The step's first line, by which SecOps finds it in a planned server's first-boot script. */
export const SERVER_FIREWALL_MARKER = "# opscrew-server-firewall:";

/** OpsCrew's nftables table on such a server (family and name). */
export const SERVER_FIREWALL_TABLE = "inet opscrew-firewall";

/** What the server's firewall lets in from outside the server, as the module's variables say. */
export interface ServerFirewallRules {
  /** Networks that reach SSH (`ssh_allowed_cidrs`); none closes public SSH. */
  sshSources: readonly string[];
  /** Networks that reach the web ports (`http_allowed_cidrs`); none on a server without web. */
  webSources: readonly string[];
  /** The private network's WireGuard port, open to everyone; none without the network. */
  wireguardPort?: number | undefined;
}

/**
 * Renders `server-firewall.sh.tftpl` the way the module's `templatefile` does: each list as one
 * string, space-separated, and no WireGuard port as an empty one.
 */
export function renderServerFirewall(rules: ServerFirewallRules): string {
  return templatefile(SERVER_MODULE_FILES[SERVER_FIREWALL_FILE] ?? "", {
    ssh_sources: rules.sshSources.join(" "),
    web_sources: rules.webSources.join(" "),
    wireguard_port: rules.wireguardPort === undefined ? "" : String(rules.wireguardPort),
  });
}

/** A rule's source as nft lists it: one family's every address, or one network. */
function source(network: string): string {
  if (network === "0.0.0.0/0") return "meta nfproto ipv4";
  if (network === "::/0") return "meta nfproto ipv6";
  return `${network.includes(":") ? "ip6" : "ip"} saddr ${network}`;
}

/** Docker's published web ports, by the port a connection was made to before Docker's DNAT. */
const DNAT_WEB = [
  ["tcp", 80],
  ["tcp", 443],
  ["udp", 443],
].map(
  ([proto, port]) =>
    `ct direction original ct status dnat meta l4proto ${proto} ct original proto-dst ${port}`,
);

/**
 * The table the step writes for `rules`, one statement per line without its indentation, as
 * `nft list table` prints it once loaded when each network is given as nft prints it (`/32` and
 * `/128` left out). The step's shell writes the same lines (its test runs it).
 */
export function serverFirewallTable({
  sshSources,
  webSources,
  wireguardPort,
}: ServerFirewallRules): string[] {
  const inside = [
    'iifname "docker0" accept',
    'iifname "br-*" accept',
    ...(wireguardPort === undefined ? [] : ['iifname "wg-opscrew*" accept']),
  ];
  return [
    `table ${SERVER_FIREWALL_TABLE} {`,
    "chain input {",
    "type filter hook input priority filter; policy drop;",
    'iifname "lo" accept',
    "ct state established,related accept",
    ...inside,
    "meta l4proto icmp accept",
    "meta l4proto ipv6-icmp accept",
    ...sshSources.map((network) => `${source(network)} tcp dport 22 accept`),
    ...webSources.flatMap((network) => [
      `${source(network)} tcp dport { 80, 443 } accept`,
      `${source(network)} udp dport 443 accept`,
    ]),
    ...(wireguardPort === undefined ? [] : [`udp dport ${wireguardPort} accept`]),
    "}",
    "chain forward {",
    "type filter hook forward priority filter; policy accept;",
    ...inside,
    ...webSources.flatMap((network) => DNAT_WEB.map((dnat) => `${dnat} ${source(network)} accept`)),
    "ct direction original ct status dnat drop",
    "}",
    "}",
  ];
}
