// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell, not JavaScript templates.
/**
 * OpsCrew's address updater on a home server (feature 029, contracts/dns-updater.md): a POSIX
 * shell script run per app by two systemd template units. Every 2 minutes the app's instance
 * (`opscrew-dns-updater@<app>.timer`) runs the script as a dynamic user, with the app's config and
 * Cloudflare token as root-only credentials. It reads this server's own public address, then
 * writes only the app's A and AAAA records that carry {@link DNS_UPDATER_RECORD_COMMENT}. The token
 * goes to curl on standard input, and no address reaches the journal.
 *
 * This file renders the script, the units and the config, and plans the `dns-updater` step from
 * the inspected facts; the step's scripts are in `steps.ts`. The records themselves are deleted by
 * the agents (`home/records.ts`), never by the server.
 */
import { canonicalJson, sha256Hex } from "@opscrew/core";
import { HOSTNAME_RE } from "./constants";
import type { DnsUpdaterConfig, DnsUpdaterFiles, HostFacts } from "./facts";
import { shellQuote } from "./shell";
import type { DesiredDnsUpdater, HostFinding, HostStep, HostStepId } from "./types";

/** The script and units' version: a step never replaces a newer copy on the server. */
export const DNS_UPDATER_VERSION = 1;

/** The comment of every record the updater writes; it touches no record without it. */
export const DNS_UPDATER_RECORD_COMMENT = "Managed by OpsCrew (address updater)";

/** The shared script. */
export const DNS_UPDATER_SCRIPT = "/usr/local/sbin/opscrew-dns-updater";
/** The shared template units. */
export const DNS_UPDATER_SERVICE_UNIT = "/etc/systemd/system/opscrew-dns-updater@.service";
export const DNS_UPDATER_TIMER_UNIT = "/etc/systemd/system/opscrew-dns-updater@.timer";
/** The configs and tokens (root only), `<app>.json` and `<app>.token`. */
export const DNS_UPDATER_CONFIG_DIR = "/etc/opscrew/dns-updater";
/** Each instance's state folder (systemd's `StateDirectory`), `<app>/state.json`. */
export const DNS_UPDATER_STATE_DIR = "/var/lib/opscrew-dns-updater";
/** Where systemd keeps a dynamic user's state folder; the path above links to it. */
export const DNS_UPDATER_PRIVATE_STATE_DIR = "/var/lib/private/opscrew-dns-updater";

/** The instance's timer, `opscrew-dns-updater@<app>.timer`. */
export function dnsUpdaterTimer(app: string): string {
  return `opscrew-dns-updater@${app}.timer`;
}

/** The instance's service, `opscrew-dns-updater@<app>.service`. */
export function dnsUpdaterService(app: string): string {
  return `opscrew-dns-updater@${app}.service`;
}

/** The URLs the script talks to: Cloudflare's API and the two IPv4 sources. */
export interface DnsUpdaterEndpoints {
  api: string;
  trace: string;
  checkip: string;
}

/** The endpoints the step always renders. */
export const DNS_UPDATER_ENDPOINTS: DnsUpdaterEndpoints = {
  api: "https://api.cloudflare.com/client/v4",
  trace: "https://one.one.one.one/cdn-cgi/trace",
  checkip: "https://checkip.amazonaws.com",
};

/**
 * The jq program that picks the stable global IPv6 address from `ip -j -6 addr show dev <it>
 * scope global`: not temporary, deprecated, tentative or failed, and not in fc00::/7; of several,
 * the longest preferred lifetime (forever first), then the lowest address.
 */
const STABLE_IPV6 = `def full: (if test("::") then split("::") | (.[0] | if . == "" then [] else split(":") end) as $a | (.[1] | if . == "" then [] else split(":") end) as $b | $a + [range(8 - ($a | length) - ($b | length)) | "0"] + $b else split(":") end) | map(("0000" + .)[-4:]) | join(":");
[.[]? | .addr_info[]? | select(.family == "inet6" and .scope == "global" and (.temporary | not) and (.deprecated | not) and (.tentative | not) and (.dadfailed | not) and (.local | type == "string") and (.local | test("^f[cd][0-9a-f]{2}:") | not))]
| sort_by(-(.preferred_life_time // 0), (.local | full)) | .[0].local // empty`;

/**
 * The updater's script, `# opscrew-dns-updater version <n>` on line 2. The step always renders
 * {@link DNS_UPDATER_ENDPOINTS}; `options.endpoints` is for the Docker-gated test only.
 */
export function renderDnsUpdaterScript(options: { endpoints?: DnsUpdaterEndpoints } = {}): string {
  const endpoints = options.endpoints ?? DNS_UPDATER_ENDPOINTS;
  return `#!/bin/sh
# opscrew-dns-updater version ${DNS_UPDATER_VERSION}
# Managed by OpsCrew: keeps one app's A and AAAA records at Cloudflare pointed at this server's own
# public address. opscrew-dns-updater@<app>.timer runs it every 2 minutes as a dynamic user, with
# the app's config and token as systemd credentials. It writes only the records named in its
# config that carry the comment below, and only an address this server detected and that is
# public. The token goes to curl on standard input, never on a command line; no address goes to
# the journal. \`opscrew destroy\` removes it.
set -euf
API=${shellQuote(endpoints.api)}
TRACE=${shellQuote(endpoints.trace)}
CHECKIP=${shellQuote(endpoints.checkip)}
VERSION=${DNS_UPDATER_VERSION}
COMMENT=${shellQuote(DNS_UPDATER_RECORD_COMMENT)}
NAME_RE=${shellQuote(HOSTNAME_RE.source)}
STABLE6=${shellQuote(STABLE_IPV6)}
STATE="\${STATE_DIRECTORY:?}/state.json"
CONFIG="\${CREDENTIALS_DIRECTORY:-/nonexistent}/config"
TOKEN_FILE="\${CREDENTIALS_DIRECTORY:-/nonexistent}/token"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NL='
'

# What the run found and did: the journal's phrases, the state's values ('' for none, ? for what
# the records held before, when the run could not read them), and its error.
said=''
changed=''
error=''
http=''
codes='[]'
seen4=''
seen6=''
rec4='?'
rec6='?'

say() { said="\${said:+$said; }$1"; }
mark() { case " $changed " in *" $1 "*) ;; *) changed="\${changed:+$changed }$1" ;; esac; }
# stop_run <code> <phrase> [<http status> <Cloudflare's error codes>]: the run's error.
stop_run() {
  error=$1
  http=\${3:-}
  codes=\${4:-[]}
  say "$2"
}
# A failed detection: the run's error unless it already has one; the run goes on.
detect_error() {
  [ -n "$error" ] || error=$1
  say "$2"
}

prev='{}'
if [ -f "$STATE" ]; then
  prev=$(jq -c 'if type == "object" then . else {} end' < "$STATE" 2>/dev/null) || prev='{}'
  [ -n "$prev" ] || prev='{}'
fi

# Writes the state (a temporary file, then a rename), prints the run's one journal line, exits.
finish() {
  ok=yes
  [ -z "$error" ] || ok=no
  printf '%s' "$prev" | jq -c --arg now "$NOW" --argjson version "$VERSION" --arg ok "$ok" \\
    --arg seen4 "$seen4" --arg seen6 "$seen6" --arg rec4 "$rec4" --arg rec6 "$rec6" \\
    --arg changed "$changed" --arg error "$error" --arg http "$http" --argjson codes "$codes" '
    def value: if . == "" then null else . end;
    . as $prev
    | {schemaVersion: 1, version: $version, lastRun: $now,
       lastSuccess: (if $ok == "yes" then $now else $prev.lastSuccess end),
       seen: {ipv4: ($seen4 | value), ipv6: ($seen6 | value)},
       records: {ipv4: (if $rec4 == "?" then $prev.records.ipv4 else ($rec4 | value) end),
                 ipv6: (if $rec6 == "?" then $prev.records.ipv6 else ($rec6 | value) end)},
       lastWrite: (if $changed == "" then $prev.lastWrite else {at: $now, changed: ($changed | split(" "))} end),
       lastError: (if $error == "" then $prev.lastError
                   elif $http == "" then {at: $now, code: $error}
                   else {at: $now, code: $error, http: ($http | tonumber), cloudflare: $codes} end)}
    | with_entries(select(.value != null))' > "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
  echo "address updater: \${said:-no change}"
  exit "\${1:-0}"
}

# 1. The config and the token, both checked before anything else.
settings=''
if [ -f "$CONFIG" ]; then
  settings=$(jq -r --arg re "$NAME_RE" '
    if .schemaVersion == 1
      and (.zoneId | type == "string" and test("^[0-9a-f]{32}$"))
      and (.name | type == "string" and test($re))
      and (.proxied | type == "boolean") and (.ipv4 | type == "boolean") and (.ipv6 | type == "boolean")
    then "\\(.zoneId) \\(.name) \\(.proxied) \\(.ipv4) \\(.ipv6)" else empty end' < "$CONFIG" 2>/dev/null) || settings=''
fi
TOKEN=''
if [ -f "$TOKEN_FILE" ]; then
  { IFS= read -r TOKEN || [ -n "$TOKEN" ]; } < "$TOKEN_FILE" || TOKEN=''
fi
case "$TOKEN" in *[!!-~]*) TOKEN='' ;; esac
if [ -z "$settings" ] || [ "\${#TOKEN}" -lt 40 ] || [ "\${#TOKEN}" -gt 255 ]; then
  TOKEN=''
  stop_run config-invalid "its config or its token is not valid"
  finish 2
fi
# The token as a quoted value of curl's config, read by sed on its standard input.
TOKEN_Q=$(printf '%s' "$TOKEN" | sed 's/[\\\\"]/\\\\&/g')
TOKEN=''
# shellcheck disable=SC2086 # the checked words: zone id, name, three booleans.
set -- $settings
ZONE=$1
NAME=$2
PROXIED=$3
IPV4=$4
IPV6=$5
TTL=60
if [ "$PROXIED" = true ]; then TTL=1; fi

# 2. IPv4 as two outside sources see it: an answer counts only when it is a public address.
public4() {
  case "$1" in '' | *[!0-9.]* | .* | *. | *..*) return 1 ;; esac
  ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # split on the dots (globbing is off).
  set -- $1
  IFS=$ifs
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    case "$octet" in 0?* | ????*) return 1 ;; esac
    [ "$octet" -le 255 ] || return 1
  done
  if [ "$1" -eq 0 ] || [ "$1" -eq 10 ] || [ "$1" -eq 127 ] || [ "$1" -ge 224 ]; then return 1; fi
  if [ "$1" -eq 100 ] && [ "$2" -ge 64 ] && [ "$2" -le 127 ]; then return 1; fi
  if [ "$1" -eq 169 ] && [ "$2" -eq 254 ]; then return 1; fi
  if [ "$1" -eq 172 ] && [ "$2" -ge 16 ] && [ "$2" -le 31 ]; then return 1; fi
  if [ "$1" -eq 192 ] && [ "$2" -eq 168 ]; then return 1; fi
  return 0
}
found4=unknown
if [ "$IPV4" = true ]; then
  trace=$(curl -4 -fsS --max-time 10 "$TRACE" 2>/dev/null | sed -n 's/^ip=//p' | head -n 1 | tr -d '\\r') || trace=''
  checkip=$(curl -4 -fsS --max-time 10 "$CHECKIP" 2>/dev/null | head -n 1 | tr -d '\\r') || checkip=''
  public4 "$trace" || trace=''
  public4 "$checkip" || checkip=''
  if [ -n "$trace" ] && [ -n "$checkip" ] && [ "$trace" != "$checkip" ]; then
    detect_error sources-disagree "the two IPv4 sources disagree"
  elif [ -z "$trace$checkip" ]; then
    detect_error address-unknown "neither IPv4 source gave a public address"
  else
    seen4=\${trace:-$checkip}
    found4=known
  fi
fi

# 3. The stable IPv6 address of the interface of the IPv6 default route: none without that route
# or such an address, unknown when ip fails.
found6=unknown
detect6() {
  routes=$(ip -j -6 route show default 2>/dev/null) || return 1
  dev=$(printf '%s' "$routes" | jq -r '[.[]? | select(.dev != null)] | sort_by(.metric // 0) | .[0].dev // empty' 2>/dev/null) || return 1
  if [ -z "$dev" ]; then
    found6=none
    return 0
  fi
  addresses=$(ip -j -6 addr show dev "$dev" scope global 2>/dev/null) || return 1
  seen6=$(printf '%s' "$addresses" | jq -r "$STABLE6" 2>/dev/null) || return 1
  if [ -n "$seen6" ]; then found6=known; else found6=none; fi
}
if [ "$IPV6" = true ] && ! detect6; then
  seen6=''
  found6=unknown
  detect_error address-unknown "the IPv6 address could not be read"
fi

# cf <method> <url> [<body>]: one call to Cloudflare, its answer in $answer and its HTTP status in
# $status; false, with the run's error, when it failed. The token, the URL and the body reach curl
# on its standard input (-K -), never on a command line.
cf() {
  out=$({
    printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN_Q"
    jq -nr --arg method "$1" --arg url "$2" --arg body "\${3:-}" '
      "request = \\($method | tojson)", "url = \\($url | tojson)",
      if $body == "" then empty else "header = \\"Content-Type: application/json\\"", "data = \\($body | tojson)" end'
  } | curl -sS --max-time 15 -K - -w '\\n%{http_code}' 2>/dev/null) || out=''
  status=\${out##*"$NL"}
  answer=\${out%"$NL"*}
  case "$status" in
    [0-9][0-9][0-9]) ;;
    *)
      stop_run cloudflare-unreachable "Cloudflare did not answer"
      return 1
      ;;
  esac
  case "$status" in
    2??) if printf '%s' "$answer" | jq -e '.success == true' >/dev/null 2>&1; then return 0; fi ;;
  esac
  numbers=$(printf '%s' "$answer" | jq -c '[.errors[]?.code | numbers] | .[:5]' 2>/dev/null) || numbers='[]'
  [ -n "$numbers" ] || numbers='[]'
  case "$status" in
    401 | 403) stop_run token-refused "Cloudflare refused the token (HTTP $status)" "$status" "$numbers" ;;
    429) stop_run rate-limited "Cloudflare limited the requests (HTTP 429); the next run tries again" "$status" "$numbers" ;;
    *) stop_run cloudflare-error "Cloudflare answered with an error (HTTP $status)" "$status" "$numbers" ;;
  esac
  return 1
}

# 4. The records at the name: its own (A or AAAA with its comment), and nothing foreign.
RECORDS=$(jq -nr --arg api "$API" --arg zone "$ZONE" '"\\($api)/zones/\\($zone | @uri)/dns_records"')
url=$(jq -nr --arg records "$RECORDS" --arg name "$NAME" '"\\($records)?name=\\($name | @uri)&per_page=50"')
cf GET "$url" || finish
list=$(printf '%s' "$answer" | jq -c --arg name "$NAME" '[.result[] | select(.name == $name)]' 2>/dev/null) || list=''
if [ -z "$list" ]; then
  stop_run cloudflare-error "Cloudflare answered with an error (HTTP $status)" "$status" '[]'
  finish
fi
# own <type> <field>: that field of each of its own records of that type, the first one first.
own() {
  printf '%s' "$list" | jq -r --arg type "$1" --arg comment "$COMMENT" --arg field "$2" \\
    '.[] | select(.type == $type and .comment == $comment) | .[$field] | tostring'
}
rec4=$(own A content | head -n 1)
rec6=$(own AAAA content | head -n 1)
foreign=$(printf '%s' "$list" | jq -r --arg comment "$COMMENT" '
  if any(.[]; .type == "CNAME") then "cname-at-name"
  elif any(.[]; (.type == "A" or .type == "AAAA") and .comment != $comment) then "foreign-record"
  else "" end')
case "$foreign" in
  cname-at-name)
    stop_run cname-at-name "a CNAME record holds the name"
    finish
    ;;
  foreign-record)
    stop_run foreign-record "an A or AAAA record without the updater's comment holds the name"
    finish
    ;;
esac

# 5. Only what differs, per family. remove <type> <id> <phrase>: one record of its own goes.
remove() {
  target=$(jq -nr --arg records "$RECORDS" --arg id "$2" '"\\($records)/\\($id | @uri)"')
  cf DELETE "$target" || return 1
  mark "$1-deleted"
  say "$3"
}
# family <type> <kept> <known|none|unknown> <address>: the records of its own of that type, as the
# run found the address; $current holds what the first one has after it. An address that could
# not be read changes nothing, so an A record never goes because detection failed.
family() {
  current=$(own "$1" content | head -n 1)
  first=''
  for id in $(own "$1" id); do
    if [ -z "$first" ]; then
      first=$id
    else
      remove "$1" "$id" "a duplicate $1 record removed" || return 1
    fi
  done
  if [ -n "$first" ] && [ "$2" != true ]; then
    remove "$1" "$first" "$1 record removed (the app no longer uses it)" || return 1
    current=''
  elif [ -n "$first" ] && [ "$3" = none ]; then
    remove "$1" "$first" "$1 record removed (no IPv6 address)" || return 1
    current=''
  elif [ "$2" = true ] && [ "$3" = known ] && [ -z "$first" ]; then
    body=$(jq -nc --arg type "$1" --arg name "$NAME" --arg content "$4" --argjson ttl "$TTL" \\
      --argjson proxied "$PROXIED" --arg comment "$COMMENT" \\
      '{type: $type, name: $name, content: $content, ttl: $ttl, proxied: $proxied, comment: $comment}')
    cf POST "$RECORDS" "$body" || return 1
    mark "$1"
    mark created
    say "$1 record created"
    current=$4
  elif [ "$2" = true ] && [ "$3" = known ]; then
    ttl=$(own "$1" ttl | head -n 1)
    proxied=$(own "$1" proxied | head -n 1)
    if [ "$current" != "$4" ] || [ "$ttl" != "$TTL" ] || [ "$proxied" != "$PROXIED" ]; then
      body=$(jq -nc --arg content "$4" --argjson ttl "$TTL" --argjson proxied "$PROXIED" \\
        '{content: $content, ttl: $ttl, proxied: $proxied}')
      target=$(jq -nr --arg records "$RECORDS" --arg id "$first" '"\\($records)/\\($id | @uri)"')
      cf PATCH "$target" "$body" || return 1
      mark "$1"
      if [ "$current" != "$4" ]; then
        say "$1 record updated (the address changed)"
      else
        say "$1 record updated (its settings changed)"
      fi
      current=$4
    fi
  fi
  return 0
}
family A "$IPV4" "$found4" "$seen4" || {
  rec4=$current
  finish
}
rec4=$current
family AAAA "$IPV6" "$found6" "$seen6" || {
  rec6=$current
  finish
}
rec6=$current

# 6 to 8. The state, the journal line, exit 0 (the next run retries any error).
finish
`;
}

/** The template service (one instance per app). */
export const DNS_UPDATER_SERVICE_TEXT = `# /etc/systemd/system/opscrew-dns-updater@.service
# Managed by OpsCrew: keeps the DNS records of the app %i pointed at this server's address.
# \`opscrew destroy\` removes it.
[Unit]
Description=OpsCrew address updater for %i
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
DynamicUser=yes
LoadCredential=config:${DNS_UPDATER_CONFIG_DIR}/%i.json
LoadCredential=token:${DNS_UPDATER_CONFIG_DIR}/%i.token
StateDirectory=opscrew-dns-updater/%i
ExecStart=${DNS_UPDATER_SCRIPT}
TimeoutStartSec=90
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_NETLINK AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
`;

/** The template timer: a minute after boot, then every 2 minutes. */
export const DNS_UPDATER_TIMER_TEXT = `# /etc/systemd/system/opscrew-dns-updater@.timer
# Managed by OpsCrew: runs the address updater of %i every 2 minutes.
[Unit]
Description=OpsCrew address updater for %i, every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
RandomizedDelaySec=20s
AccuracySec=10s

[Install]
WantedBy=timers.target
`;

/** SHA-256 of the shared files this version writes. */
export function dnsUpdaterFileHashes(): { script: string; service: string; timer: string } {
  return {
    script: sha256Hex(renderDnsUpdaterScript()),
    service: sha256Hex(DNS_UPDATER_SERVICE_TEXT),
    timer: sha256Hex(DNS_UPDATER_TIMER_TEXT),
  };
}

/** The app's config (data model 4): no secret and no address. */
export function dnsUpdaterConfig(
  app: string,
  updater: Omit<DesiredDnsUpdater, "tokenSha256">,
): DnsUpdaterConfig {
  return {
    schemaVersion: 1,
    app,
    zoneId: updater.zoneId,
    name: updater.name,
    proxied: updater.proxied,
    ipv4: updater.ipv4,
    ipv6: updater.ipv6,
  };
}

/** The config file's text, as the step writes it. */
export function dnsUpdaterConfigText(config: DnsUpdaterConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

const ID: HostStepId = "dns-updater";

/** A file is root's with these permission bits. */
function rootOwned(file: { mode: string; owner: string } | null | undefined, mode: string) {
  return file?.mode === mode && file.owner === "root";
}

/** The shared files are this version's, or a newer version's (which stays). */
function sharedInPlace(files: DnsUpdaterFiles | undefined): boolean {
  if (files === undefined || files.version === null) return false;
  const all = files.script !== null && files.service !== null && files.timer !== null;
  if (files.version > DNS_UPDATER_VERSION) return all;
  const hashes = dnsUpdaterFileHashes();
  return (
    files.version === DNS_UPDATER_VERSION &&
    files.script?.sha256 === hashes.script &&
    files.service?.sha256 === hashes.service &&
    files.timer?.sha256 === hashes.timer &&
    rootOwned(files.script, "755") &&
    rootOwned(files.service, "644") &&
    rootOwned(files.timer, "644")
  );
}

/** `the A record`, `the AAAA record` or `the A and AAAA records`. */
function recordsText(updater: Pick<DesiredDnsUpdater, "ipv4" | "ipv6">): string {
  if (updater.ipv4 && updater.ipv6) return "the A and AAAA records";
  return updater.ipv4 ? "the A record" : "the AAAA record";
}

/** What the step does and what the token can reach, for the host plan (plan 6., research R14). */
function setupText(app: string, updater: DesiredDnsUpdater): string {
  return [
    `Every 2 minutes, the timer ${dnsUpdaterTimer(app)} runs ${DNS_UPDATER_SCRIPT} as an unprivileged user: it reads this server's own address only (IPv4 as two outside sources see it, when they agree, and the stable IPv6 address) and changes only ${recordsText(updater)} of ${updater.name} that carry the comment "${DNS_UPDATER_RECORD_COMMENT}", ${updater.proxied ? "behind Cloudflare's proxy" : "DNS only, with a 60-second TTL"}.`,
    updater.ipv6
      ? "The AAAA record goes when the server has no IPv6 address; the A record never goes because the address could not be read."
      : "The A record never goes because the address could not be read.",
    "It never touches another record, and a record at that name it did not write stops it.",
    updater.tokenSha256 === undefined
      ? `The token already in ${DNS_UPDATER_CONFIG_DIR}/${app}.token stays.`
      : `The token you gave is written to ${DNS_UPDATER_CONFIG_DIR}/${app}.token (root only) and nowhere else: OpsCrew keeps no copy.`,
    "The updater changes only this app's A/AAAA records, but the token can change any record in its zone. Anything with root on your server can use it, the deploy runner included: it runs your repository's code in the docker group, which is as good as root.",
  ].join(" ");
}

function dnsStep(
  title: string,
  state: HostStep["state"],
  params: HostStep["params"],
  reason: string,
  scope: HostStep["scope"] = "app",
): HostStep {
  return { id: ID, title, state, scope, reason, params };
}

/** The other apps' instances on the server. */
function othersOf(facts: HostFacts, app: string): string[] {
  return (facts.dnsUpdaters ?? []).map((item) => item.app).filter((name) => name !== app);
}

/**
 * The step that removes the instances `apps` (their timer, config, token and state) and, with
 * `shared`, the script and units once no other config is left.
 */
function removalStep(apps: readonly string[], shared: boolean, scope: HostStep["scope"]): HostStep {
  const whose = apps.length === 1 ? `the address updater of "${apps[0]}"` : "the address updaters";
  return dnsStep(
    `Remove ${whose}${shared ? " and the updater's script and units" : ""}`,
    "change",
    { remove: true, apps: [...apps].sort().join(" "), shared },
    `${apps.length > 0 ? `Stops and disables ${apps.map(dnsUpdaterTimer).join(", ")}, and removes ${apps.length === 1 ? "its" : "each one's"} config, token and state. ` : ""}${shared ? `No other app's updater is left, so ${DNS_UPDATER_SCRIPT} and its units go too.` : "The other apps' updaters stay."} The DNS records at Cloudflare are not touched here.`,
    scope,
  );
}

/**
 * The `dns-updater` step of a setup plan for the app `app`: with `updater`, the app's instance in
 * place, to change, or blocked when no token is on the server and none is given (with a finding
 * that names `command`); without it, the removal of an instance the app has there; undefined when
 * there is none to remove.
 */
export function dnsUpdaterStep(
  facts: HostFacts,
  app: string,
  updater: DesiredDnsUpdater | undefined,
  command: string,
): { step: HostStep; finding?: HostFinding } | undefined {
  const own = facts.dnsUpdaters?.find((item) => item.app === app);
  if (updater === undefined) {
    if (own === undefined) return undefined;
    return { step: removalStep([app], othersOf(facts, app).length === 0, "app") };
  }
  const config = dnsUpdaterConfig(app, updater);
  const packages = [
    ...(facts.packages.curl ? [] : ["curl"]),
    ...(facts.packages.jq === true ? [] : ["jq"]),
  ];
  const params: HostStep["params"] = {
    app,
    zoneId: updater.zoneId,
    name: updater.name,
    proxied: updater.proxied,
    ipv4: updater.ipv4,
    ipv6: updater.ipv6,
    version: DNS_UPDATER_VERSION,
    packages: packages.join(" "),
    ...(updater.tokenSha256 === undefined ? {} : { tokenSha256: updater.tokenSha256 }),
  };
  const title = `Keep ${recordsText(updater)} of ${updater.name} at this server's own address (the address updater of "${app}", every 2 minutes)`;
  if (updater.tokenSha256 === undefined && own?.token.present !== true) {
    const hint = `Set OPSCREW_DNS_UPDATER_TOKEN (the guide's recipe) and run ${command} again.`;
    return {
      step: dnsStep(title, "blocked", params, `No updater token is on this server. ${hint}`),
      finding: {
        code: "dns-updater-token-missing",
        message: `The address updater of "${app}" has no token on this server, and none was given.`,
        hint,
      },
    };
  }
  const tokenInPlace =
    own?.token.present === true &&
    rootOwned(own.token, "600") &&
    (updater.tokenSha256 === undefined || own.token.sha256 === updater.tokenSha256);
  const inPlace =
    sharedInPlace(facts.dnsUpdaterFiles) &&
    rootOwned(facts.dnsUpdaterFiles?.dir, "700") &&
    own !== undefined &&
    own.config !== null &&
    canonicalJson(own.config) === canonicalJson(config) &&
    rootOwned(own.configFile, "600") &&
    tokenInPlace &&
    own.timer.enabled &&
    own.timer.active;
  return inPlace
    ? { step: dnsStep(title, "in-place", params, "Already running.") }
    : { step: dnsStep(title, "change", params, setupText(app, updater)) };
}

/**
 * A teardown's removal of the app's instance, with the script and units when it is the last one;
 * undefined when the app has none.
 */
export function dnsUpdaterTeardownStep(facts: HostFacts, app: string): HostStep | undefined {
  return dnsUpdaterStep(facts, app, undefined, "")?.step;
}

/**
 * An undo's removal of what is left of the updater once every app is gone: any instance, and the
 * script, units and folder; undefined when nothing is there.
 */
export function dnsUpdaterUndoStep(facts: HostFacts): HostStep | undefined {
  const apps = (facts.dnsUpdaters ?? []).map((item) => item.app);
  const files = facts.dnsUpdaterFiles;
  const left =
    files !== undefined &&
    (files.script !== null || files.service !== null || files.timer !== null || files.dir !== null);
  if (apps.length === 0 && !left) return undefined;
  return removalStep(apps, true, "shared");
}
