// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell, not JavaScript templates.
/**
 * OpsCrew's web filter for a site served directly behind Cloudflare's proxy: Docker-published
 * ports bypass ufw (Docker routes them in the nat table, before ufw's INPUT rules), so the filter
 * sits in Docker's own `DOCKER-USER` chain. For new connections whose original destination port is
 * 80 or 443 (`conntrack --ctstate DNAT --ctorigdstport`), Cloudflare's ranges pass and everything
 * else is dropped. A unit runs it before Docker, and Docker requires that unit, so Docker never
 * publishes ports without the filter (fail closed).
 *
 * IPv4 by default: the site is published on IPv4 only (Caddy binds `0.0.0.0`, no AAAA record),
 * because Docker serves an IPv6 host port of a container without IPv6 through docker-proxy on the
 * INPUT path, which `DOCKER-USER` never sees. A kernel without IPv6 therefore never stops Docker
 * at boot.
 *
 * With IPv6 ranges (a home server behind the proxy without IPv4, published on both families), the
 * script also loads OpsCrew's own nftables table {@link WEB_FILTER_TABLE}, with two base chains
 * whose policy is accept (so they only ever add a restriction): `input` covers docker-proxy's
 * path, `forward` the DNAT'd connections of a Docker that gives the edge's network IPv6. Both let
 * Cloudflare's IPv6 ranges reach the web ports and drop other IPv6 packets to them (`input` not on
 * `lo`). The same unit loads it, so Docker does not start without it either.
 *
 * Docker keeps an existing `DOCKER-USER` chain and its rules when it starts (moby's
 * `setupUserChain` only creates the chain when it is missing and adds the jump from `FORWARD`), so
 * the filter can be installed before Docker. Docker's nftables backend has no `DOCKER-USER` chain:
 * the filter refuses it.
 */
import { sha256Hex } from "@opscrew/core";
import { canonicalIpv4Cidr, canonicalSshSource } from "./parse";

/** The script that installs the rules (run by the unit at boot, and by the step's apply). */
export const WEB_FILTER_SCRIPT = "/usr/local/sbin/opscrew-web-filter";
/** The unit that runs it before Docker. */
export const WEB_FILTER_SERVICE = "opscrew-web-filter.service";
export const WEB_FILTER_UNIT = `/etc/systemd/system/${WEB_FILTER_SERVICE}`;
/** Docker's drop-in: Docker requires the filter and starts after it. */
export const WEB_FILTER_DROP_IN = "/etc/systemd/system/docker.service.d/opscrew-web-filter.conf";
/** OpsCrew's own chain; `DOCKER-USER` jumps to it. */
export const WEB_FILTER_CHAIN = "OPSCREW-WEB";
/** OpsCrew's own nftables table for IPv6 (family and name). */
export const WEB_FILTER_TABLE = "inet opscrew-web";
/** With IPv6 only: the unit's drop-in that makes it follow nftables.service. */
export const WEB_FILTER_NFT_DROP_IN = `/etc/systemd/system/${WEB_FILTER_SERVICE}.d/nftables.conf`;

/** The `web-filter` step's ranges: Cloudflare's, canonical, sorted, without duplicates. */
export interface WebFilterRanges {
  ipv4: string[];
  /** Cloudflare's IPv6 ranges, only for a site published on IPv6 behind the proxy. */
  ipv6?: string[];
}

/** IPv4 networks in the form iptables prints them, sorted and without duplicates. */
export function sortedNetworks(list: readonly string[]): string[] {
  const networks = new Set<string>();
  for (const text of list) {
    const network = canonicalIpv4Cidr(text);
    if (network === null) throw new Error(`not an IPv4 network: ${text.slice(0, 60)}`);
    networks.add(network);
  }
  return [...networks].sort();
}

/** IPv6 networks in the form nft prints them ({@link canonicalSshSource}), sorted, without duplicates. */
export function sortedIpv6Networks(list: readonly string[]): string[] {
  const networks = new Set<string>();
  for (const text of list) {
    const network = text.includes(":") ? canonicalSshSource(text) : null;
    if (network === null) throw new Error(`not an IPv6 network: ${text.slice(0, 60)}`);
    networks.add(network);
  }
  return [...networks].sort();
}

/**
 * Lines that refuse a Docker that does not filter its ports through iptables: its daemon.json, or
 * its unit's command line and environment (`systemctl show docker`), name the nftables backend or
 * turn iptables off. `filter` names the filter that cannot work then ("OpsCrew's web filter").
 */
export function dockerBackendCheck(filter: string): string {
  return `if [ -f /etc/docker/daemon.json ] && grep -Eq '"firewall-backend"[[:space:]]*:[[:space:]]*"nftables"' /etc/docker/daemon.json; then
  fail "Docker is set to its nftables firewall backend (/etc/docker/daemon.json), which has no DOCKER-USER chain, so ${filter} cannot work."
fi
if [ -f /etc/docker/daemon.json ] && grep -Eq '"iptables"[[:space:]]*:[[:space:]]*false' /etc/docker/daemon.json; then
  fail "Docker does not manage iptables (\\"iptables\\": false in /etc/docker/daemon.json), so ${filter} cannot work."
fi
docker_unit=$(systemctl show docker -p ExecStart -p Environment 2>/dev/null) || docker_unit=''
case "$docker_unit" in
  *firewall-backend=nftables* | *"firewall-backend nftables"* | *DOCKER_FIREWALL_BACKEND=nftables*)
    fail "Docker's service is set to its nftables firewall backend, which has no DOCKER-USER chain, so ${filter} cannot work." ;;
  *--iptables=false*)
    fail "Docker's service does not manage iptables (--iptables=false), so ${filter} cannot work." ;;
esac`;
}

/** {@link dockerBackendCheck} for the web filter. */
export const WEB_FILTER_BACKEND_CHECK = dockerBackendCheck("OpsCrew's web filter");

/**
 * Shell functions for the filter's rules, shared by the script on the server and the step's
 * checks: `leading_ok` (OpsCrew's three jumps are the first rules of DOCKER-USER) and
 * `chain_ok <networks>` (the chain lets exactly those networks pass and drops the rest).
 */
export const WEB_FILTER_FUNCTIONS = `leading_ok() {
  top=$(iptables -w -S DOCKER-USER 2>/dev/null | grep '^-A ' | head -n 3) || return 1
  for spec in 'tcp 80' 'tcp 443' 'udp 443'; do
    proto=\${spec% *}
    port=\${spec#* }
    printf '%s\\n' "$top" | grep -- "-p $proto " | grep -- "--ctorigdstport $port " | grep -q -- " -j ${WEB_FILTER_CHAIN}\\$" || return 1
  done
}
chain_ok() {
  iptables -w -n -L ${WEB_FILTER_CHAIN} >/dev/null 2>&1 || return 1
  rules=$(iptables -w -S ${WEB_FILTER_CHAIN} | grep -c '^-A ') || return 1
  n=0
  for net in $1; do
    n=$((n + 1))
    iptables -w -C ${WEB_FILTER_CHAIN} -s "$net" -j RETURN 2>/dev/null || return 1
  done
  [ "$rules" -eq $((n + 1)) ] || return 1
  [ "$(iptables -w -S ${WEB_FILTER_CHAIN} | grep '^-A ' | tail -n 1)" = "-A ${WEB_FILTER_CHAIN} -j DROP" ]
}`;

/**
 * `table6_ok <networks>`, for the step's checks with IPv6: OpsCrew's table {@link WEB_FILTER_TABLE}
 * has its input and forward chains, the three rules of each of those networks and nothing else
 * but the `lo` exception and the three drops.
 */
export const WEB_FILTER_IPV6_FUNCTIONS = `table6_ok() {
  listing=$(nft list table ${WEB_FILTER_TABLE} 2>/dev/null) || return 1
  printf '%s\\n' "$listing" | grep -q 'hook input ' || return 1
  printf '%s\\n' "$listing" | grep -q 'hook forward ' || return 1
  n=0
  for net in $1; do
    n=$((n + 1))
    [ "$(printf '%s\\n' "$listing" | grep -cF -- "ip6 saddr $net ")" -eq 3 ] || return 1
  done
  [ "$(printf '%s\\n' "$listing" | grep -c ' accept$')" -eq $((3 * n + 1)) ] || return 1
  [ "$(printf '%s\\n' "$listing" | grep -c ' drop$')" -eq 3 ]
}`;

/**
 * `table6_hash`, for the inspection: the SHA-256 of {@link WEB_FILTER_TABLE} as nft lists it, one
 * statement per line without its indentation, the lines joined with `|` (older nft prints a
 * priority of 0, newer `filter`); `-` when there is no such table (or no nft). The plan compares it
 * with {@link webFilterTable6Hash}, so no address is printed.
 */
export const WEB_FILTER_TABLE6_HASH = `table6_hash() {
  if listing=$(nft list table ${WEB_FILTER_TABLE} 2>/dev/null); then
    printf '%s\\n' "$listing" | sed -e 's/^[[:space:]]*//' -e 's/ priority 0;/ priority filter;/' -e '/^$/d' | tr '\\n' '|' | sha256sum | cut -d ' ' -f 1
  else
    echo -
  fi
}`;

/**
 * The IPv6 table's rules, loaded in one transaction (the table is created first, so the delete
 * never fails, and loading it again never adds a second copy). One rule per range, so ranges that
 * overlap never make nft refuse a set.
 */
function ipv6TableRules(ranges: readonly string[]): string {
  const rules = [
    '\t\tiifname "lo" accept',
    ...ranges.flatMap((net) => [
      `\t\tip6 saddr ${net} tcp dport { 80, 443 } accept`,
      `\t\tip6 saddr ${net} udp dport 443 accept`,
    ]),
    "\t\tmeta nfproto ipv6 tcp dport { 80, 443 } drop",
    "\t\tmeta nfproto ipv6 udp dport 443 drop",
  ];
  const dnat = "ct direction original ct status dnat ct original proto-dst { 80, 443 }";
  const forward = [
    ...ranges.map((net) => `\t\t${dnat} ip6 saddr ${net} accept`),
    `\t\t${dnat} meta nfproto ipv6 drop`,
  ];
  return `add table ${WEB_FILTER_TABLE}
delete table ${WEB_FILTER_TABLE}
table ${WEB_FILTER_TABLE} {
\tchain input {
\t\ttype filter hook input priority 0; policy accept;
${rules.join("\n")}
\t}
\tchain forward {
\t\ttype filter hook forward priority 0; policy accept;
${forward.join("\n")}
\t}
}`;
}

/**
 * What {@link WEB_FILTER_TABLE6_HASH} prints once the script has loaded the table for these
 * (sorted) ranges: nft lists the rules as the script writes them.
 */
export function webFilterTable6Hash(ipv6: readonly string[]): string {
  const rules = ipv6TableRules(ipv6);
  const listing = rules
    .slice(rules.indexOf(`table ${WEB_FILTER_TABLE} {`))
    .split("\n")
    .map((line) => line.trimStart().replace(" priority 0;", " priority filter;"))
    .filter((line) => line !== "");
  return sha256Hex(`${listing.join("|")}|`);
}

/** The script's lines that load {@link WEB_FILTER_TABLE} for `ipv6` (after the IPv4 filter). */
function ipv6Part(ipv6: readonly string[]): string {
  return `# IPv6: OpsCrew's own nftables table, replaced in one transaction. Its input chain covers
# docker-proxy (an IPv6 host port of a container without IPv6), its forward chain a Docker that
# gives the edge's network IPv6 (DNAT'd connections to 80 and 443, which DOCKER-USER never sees).
nft -f - <<'NFT'
${ipv6TableRules(ipv6)}
NFT
`;
}

/** The script on the server, with the ranges in it (its SHA-256 is what the step checks). */
export function webFilterScript(ranges: WebFilterRanges): string {
  const { ipv6 } = ranges;
  const families =
    ipv6 === undefined
      ? "IPv4; the site is not published on IPv6"
      : `IPv4 in DOCKER-USER,\n# IPv6 in OpsCrew's nftables table ${WEB_FILTER_TABLE}`;
  return `#!/bin/sh
# Managed by OpsCrew: only Cloudflare's addresses reach the web ports (80 and 443) that Docker
# publishes (${families}). ${WEB_FILTER_SERVICE} runs this before
# Docker, and Docker requires that service: when the filter cannot be installed, Docker does not
# start. \`opscrew destroy --undo-host\` removes it; \`opscrew provision\` updates the ranges.
set -eu
# PATH comes from systemd (or from OpsCrew's step, which runs it once right away).
IPV4='${ranges.ipv4.join(" ")}'
fail() {
  echo "opscrew-web-filter: $1" >&2
  exit 1
}
${WEB_FILTER_BACKEND_CHECK}
${WEB_FILTER_FUNCTIONS}
command -v iptables >/dev/null 2>&1 || fail "iptables is not installed."
command -v iptables-restore >/dev/null 2>&1 || fail "iptables-restore is not installed."
${ipv6 === undefined ? "" : 'command -v nft >/dev/null 2>&1 || fail "nft is not installed."\n'}# OpsCrew's chain in one atomic change: Cloudflare's ranges pass, everything else is dropped.
{
  echo '*filter'
  echo ':${WEB_FILTER_CHAIN} - [0:0]'
  for net in $IPV4; do echo "-A ${WEB_FILTER_CHAIN} -s $net -j RETURN"; done
  echo '-A ${WEB_FILTER_CHAIN} -j DROP'
  echo 'COMMIT'
} | iptables-restore -w --noflush
# Before Docker starts DOCKER-USER may not exist yet; Docker keeps it and its rules.
iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || iptables -w -N DOCKER-USER
# The jumps for new connections to published ports 80 and 443 come first in DOCKER-USER.
if ! leading_ok; then
  for spec in 'udp 443' 'tcp 443' 'tcp 80'; do
    set -- $spec
    iptables -w -I DOCKER-USER 1 -p "$1" -m conntrack --ctstate DNAT --ctorigdstport "$2" --ctdir ORIGINAL -j ${WEB_FILTER_CHAIN}
  done
  # Older copies of the jumps further down go, from the bottom up. The chain is listed again
  # before each delete, and rule n goes only while it still is one of OpsCrew's jumps (another
  # program may have changed the chain in between).
  iptables -w -S DOCKER-USER | grep '^-A ' | awk 'NR > 3 && / -j ${WEB_FILTER_CHAIN}$/ { print NR }' | sort -rn |
    while read -r n; do
      rule=$(iptables -w -S DOCKER-USER | grep '^-A ' | sed -n "\${n}p")
      case "$rule" in
        *" -j ${WEB_FILTER_CHAIN}") iptables -w -D DOCKER-USER "$n" ;;
      esac
    done
fi
${ipv6 === undefined ? "" : ipv6Part(ipv6)}`;
}

/** The unit that runs the script before Docker (Docker requires it through the drop-in). */
export const WEB_FILTER_UNIT_TEXT = `# Managed by OpsCrew: only Cloudflare's addresses reach the web ports that Docker publishes.
# Docker requires this service (docker.service.d/opscrew-web-filter.conf), so it does not start
# without the filter. \`opscrew destroy --undo-host\` removes it.
[Unit]
Description=OpsCrew web filter: only Cloudflare reaches ports 80 and 443 that Docker publishes
After=local-fs.target ufw.service firewalld.service nftables.service netfilter-persistent.service iptables.service ip6tables.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${WEB_FILTER_SCRIPT}

[Install]
WantedBy=multi-user.target
`;

/** Docker's drop-in: Docker starts only after the filter, and not at all when it fails. */
export const WEB_FILTER_DROP_IN_TEXT = `# Managed by OpsCrew: Docker starts only after OpsCrew's web filter is in place, and not at all
# when it fails (fail closed). \`opscrew destroy --undo-host\` removes this file.
[Unit]
Requires=${WEB_FILTER_SERVICE}
After=${WEB_FILTER_SERVICE}
`;

/**
 * With IPv6 only, the unit's drop-in: nftables.service flushes every table when it stops, restarts
 * or reloads (`nft flush ruleset`, and /etc/nftables.conf starts with one), so the filter follows
 * it, as OpsCrew's SSH firewall does. A reload of nftables runs the script again; a restart
 * restarts the filter, and Docker, which requires it, with it; a stop stops both (fail closed).
 * The unit itself stays the same in both modes.
 */
export const WEB_FILTER_NFT_DROP_IN_TEXT = `# Managed by OpsCrew: nftables.service flushes every table when it stops, restarts or reloads,
# so OpsCrew's web filter follows it and loads its table ${WEB_FILTER_TABLE} again. Docker
# requires the filter, so it restarts or stops with it.
# \`opscrew destroy --undo-host\` removes this file.
[Unit]
PartOf=nftables.service
ReloadPropagatedFrom=nftables.service

[Service]
ExecReload=${WEB_FILTER_SCRIPT}
`;

/** SHA-256 of the files the step writes for these ranges (the nftables drop-in only with IPv6). */
export function webFilterFileHashes(ranges: WebFilterRanges): {
  script: string;
  unit: string;
  dropIn: string;
  nftDropIn?: string;
} {
  return {
    script: sha256Hex(webFilterScript(ranges)),
    unit: sha256Hex(WEB_FILTER_UNIT_TEXT),
    dropIn: sha256Hex(WEB_FILTER_DROP_IN_TEXT),
    ...(ranges.ipv6 === undefined ? {} : { nftDropIn: sha256Hex(WEB_FILTER_NFT_DROP_IN_TEXT) }),
  };
}
