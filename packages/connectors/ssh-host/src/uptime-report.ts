// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell, not JavaScript templates.
/**
 * The server's part of the Cloudflare uptime check (feature 046, User Story 4): the host step
 * `uptime-report`. A POSIX shell script, run per environment by two systemd template units every 5
 * minutes as the deploy user, checks what the scheduled check in GitHub Actions checks on a
 * server, with the same rules: the disk, the app's last scheduled snapshot and restore drill (read
 * with the check key's own command, `CHECK_KEY_COMMAND`, for the app's folder), the days left on
 * the certificates the server serves for the app, and once a day the age of the credentials its
 * config dates. It reports to the Worker's own address only when a status changes, plus one
 * heartbeat a day, signed with the environment's report key (HMAC-SHA256), which reaches the
 * script as a root-only systemd credential and no other program.
 *
 * This file renders the script, the units and the config, reads the inspection's lines, and plans
 * the step from them; the step's scripts are in `steps.ts`, the plan (`planUptimeReport`) in
 * `plan.ts`.
 */
import { sha256Hex } from "@opscrew/core";
import { z } from "zod";
import { APPS_DIR, CHECK_KEY_COMMAND, OPSCREW_DIR } from "./constants";
import { type HostFacts, type UptimeReportFacts, UptimeReportFactsSchema } from "./facts";
import { shellQuote } from "./shell";
import {
  AppNameSchema,
  type DesiredUptimeReport,
  DesiredUptimeReportSchema,
  type HostStep,
} from "./types";

/** The script and units' version: a step never replaces a newer copy on the server. */
export const UPTIME_REPORT_VERSION = 1;

/** The shared script. */
export const UPTIME_REPORT_SCRIPT = "/usr/local/lib/opscrew/uptime-report.sh";
/** The shared template units. */
export const UPTIME_REPORT_SERVICE_UNIT = "/etc/systemd/system/opscrew-uptime-report@.service";
export const UPTIME_REPORT_TIMER_UNIT = "/etc/systemd/system/opscrew-uptime-report@.timer";
/** The configs and keys (root only), `<instance>.conf` and `<instance>.key`. */
export const UPTIME_REPORT_CONFIG_DIR = `${OPSCREW_DIR}/uptime-report`;
/** Each instance's state folder (systemd's `StateDirectory`), `<instance>/state`. */
export const UPTIME_REPORT_STATE_DIR = "/var/lib/opscrew-uptime-report";
/** The user the script runs as: the one the check key's command runs as. */
export const UPTIME_REPORT_USER = "deploy";
/** The User-Agent of every report (Browser Integrity Check refuses some default ones). */
export const UPTIME_REPORT_USER_AGENT = "OpsCrew uptime report";

/** What the report key can do, as the host plan says it (research R9). */
export const UPTIME_REPORT_KEY_REACH =
  "The report key can only send reports for this one environment: anything with root on this server can read it, the deploy runner included.";

/** The instance of an entry: the first 16 hex characters of its id's SHA-256 (the secret's suffix). */
export function uptimeReportInstance(entry: string): string {
  return sha256Hex(entry).slice(0, 16);
}

/** The instance's timer, `opscrew-uptime-report@<instance>.timer`. */
export function uptimeReportTimer(instance: string): string {
  return `opscrew-uptime-report@${instance}.timer`;
}

/** The instance's service, `opscrew-uptime-report@<instance>.service`. */
export function uptimeReportService(instance: string): string {
  return `opscrew-uptime-report@${instance}.service`;
}

/**
 * The check key's command for the one app folder `$APP` (the script's config gives it): the same
 * reading of `df`, the scheduled snapshot's log and the restore drills' log, so the scheduled
 * check's rules read the same lines.
 */
export const UPTIME_REPORT_READ = CHECK_KEY_COMMAND.replace(
  `for d in ${APPS_DIR}/*/; do`,
  `for d in ${APPS_DIR}/$APP/; do`,
);

/** The script, `# opscrew-uptime-report version <n>` on line 2. */
export function renderUptimeReportScript(): string {
  return `#!/bin/sh
# opscrew-uptime-report version ${UPTIME_REPORT_VERSION}
# Managed by OpsCrew: checks this server for one environment of an app and reports to the
# Cloudflare uptime Worker. opscrew-uptime-report@<instance>.timer runs it every 5 minutes as the
# deploy user, with the instance's config and report key as systemd credentials. It reads the
# disk and the app's last scheduled snapshot and restore drill as the scheduled check's key does,
# the days left on the certificates this server serves for the app on 127.0.0.1:443, and once a
# day the age of the credentials its config dates (names and dates only). It sends a signed report
# only when a status changes, and a heartbeat 24 hours after its last report. The key reaches no
# other program: the signature is an HMAC-SHA256 (RFC 2104) built with sha256sum. The journal
# gets one line per run, with the statuses only. \`opscrew destroy\` removes it.
set -eu
LC_ALL=C
export LC_ALL
AGENT=${shellQuote(UPTIME_REPORT_USER_AGENT)}
CONFIG="\${CREDENTIALS_DIRECTORY:-/nonexistent}/config"
KEY_FILE="\${CREDENTIALS_DIRECTORY:-/nonexistent}/key"
STATE="\${STATE_DIRECTORY:?}/state"
DAY=86400
NL='
'
NOW=$(date -u +%s)

# An invalid config or key stops the run before anything is read or sent.
invalid() {
  echo 'uptime report: its config or its key is not valid'
  exit 2
}
# digits <value>: a whole number.
digits() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
}
# days_of <seconds>: the whole days, rounded down, in $days.
days_of() {
  days=$(($1 / DAY))
  if [ "$1" -lt 0 ] && [ $(($1 % DAY)) -ne 0 ]; then days=$((days - 1)); fi
}
# epoch <time>: its Unix seconds in $epoch; false when date cannot read it.
epoch() {
  epoch=$(date -u -d "$1" +%s 2>/dev/null) && digits "$epoch"
}

# 1. The config, read line by line (never sourced), and the key, both checked first.
URL='' ENTRY='' SERVER='' APP='' DRILL='' DISK_WARN='' DISK_HIGH='' CERT_DAYS='' MAX_AGE=''
HOSTS='' CREDS=''
[ -f "$CONFIG" ] || invalid
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'*) ;;
    url=*) URL=\${line#url=} ;;
    entry=*) ENTRY=\${line#entry=} ;;
    server=*) SERVER=\${line#server=} ;;
    app=*) APP=\${line#app=} ;;
    drill=*) DRILL=\${line#drill=} ;;
    disk_warn=*) DISK_WARN=\${line#disk_warn=} ;;
    disk_high=*) DISK_HIGH=\${line#disk_high=} ;;
    cert_days=*) CERT_DAYS=\${line#cert_days=} ;;
    max_age_days=*) MAX_AGE=\${line#max_age_days=} ;;
    host=*) HOSTS="$HOSTS\${line#host=}$NL" ;;
    credential=*) CREDS="$CREDS\${line#credential=}$NL" ;;
    *) invalid ;;
  esac
done < "$CONFIG"
case "$URL" in https://opscrew-uptime.*.workers.dev/report) ;; *) invalid ;; esac
case "$URL" in *[!a-z0-9./:-]*) invalid ;; esac
case "$ENTRY" in '' | *[!A-Za-z0-9._/-]*) invalid ;; esac
case "$SERVER" in '' | *[!A-Za-z0-9._-]*) invalid ;; esac
case "$APP" in '' | *[!a-z0-9-]*) invalid ;; esac
case "$DRILL" in '' | weekly | daily) ;; *) invalid ;; esac
for n in "$DISK_WARN" "$DISK_HIGH" "$CERT_DAYS"; do digits "$n" || invalid; done
[ -z "$MAX_AGE" ] || digits "$MAX_AGE" || invalid
[ -z "$CREDS" ] || [ -n "$MAX_AGE" ] || invalid
while IFS= read -r host; do
  case "$host" in *[!a-z0-9.-]* | .* | *. | *..*) invalid ;; esac
done <<EOF
$HOSTS
EOF
while IFS=' ' read -r name at source rest; do
  [ -n "$name$at$source$rest" ] || continue
  case "$name" in '' | *[!A-Za-z0-9._-]*) invalid ;; esac
  case "$at" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z) ;; *) invalid ;; esac
  case "$at" in *[!0-9TZ:.-]*) invalid ;; esac
  case "$source" in made | rotated | first-deploy) ;; *) invalid ;; esac
  [ -z "$rest" ] || invalid
done <<EOF
$CREDS
EOF
KEY=''
if [ -f "$KEY_FILE" ]; then
  { IFS= read -r KEY || [ -n "$KEY" ]; } < "$KEY_FILE" || KEY=''
fi
case "$KEY" in *[!0-9a-f]*) KEY='' ;; esac
[ "\${#KEY}" -eq 64 ] || invalid
# The HMAC's two keys (RFC 2104) as printf escapes: the key XOR 0x36 and XOR 0x5c, padded to
# SHA-256's 64-byte block. Only the shell's builtins ever see the key.
IPAD='' OPAD='' rest=$KEY i=0
while [ "$i" -lt 64 ]; do
  b=0
  if [ -n "$rest" ]; then
    tail=\${rest#??}
    b=$((0x\${rest%"$tail"}))
    rest=$tail
  fi
  x=$((b ^ 54))
  IPAD="$IPAD\\\\$((x / 64))$((x / 8 % 8))$((x % 8))"
  x=$((b ^ 92))
  OPAD="$OPAD\\\\$((x / 64))$((x / 8 % 8))$((x % 8))"
  i=$((i + 1))
done
KEY='' rest=''
# sign <text>: the hex HMAC-SHA256 of <text> with the report key, in $signature.
sign() {
  inner=$({ printf "$IPAD"; printf '%s' "$1"; } | sha256sum)
  inner=\${inner%% *}
  escaped=''
  while [ -n "$inner" ]; do
    tail=\${inner#??}
    x=$((0x\${inner%"$tail"}))
    escaped="$escaped\\\\$((x / 64))$((x / 8 % 8))$((x % 8))"
    inner=$tail
  done
  signature=$({ printf "$OPAD"; printf "$escaped"; } | sha256sum)
  signature=\${signature%% *}
}

# 2. The last report: when it was sent, its statuses, and the credentials' last daily check.
sent='' checked='' prev='' carried=''
if [ -f "$STATE" ]; then
  while IFS=' ' read -r kind a b c d e; do
    case "$kind" in
      sent) if digits "$a"; then sent=$a; fi ;;
      checked) if digits "$a"; then checked=$a; fi ;;
      status) prev="$prev$NL$a $b" ;;
      credential) carried="$carried$a $b $c $d $e$NL" ;;
    esac
  done < "$STATE"
fi

# 3. The disk, and the app's last scheduled snapshot and restore drill: the check key's own command
# for this app's folder, so the scheduled check's rules read the same lines.
answer=$(${UPTIME_REPORT_READ}) || answer=''
read_ok=no
case "$NL$answer$NL" in *"\${NL}scheduled$NL"*) read_ok=yes ;; esac
# The answer's lines: df's last one, and this app's \`scheduled <app> \` ones.
dfline='' s_at='' s_id='' s_after='' s_running=no d_seen=no d_line='' d_since=''
while IFS= read -r l; do
  case "$l" in
    "scheduled $APP "*) l=\${l#"scheduled $APP "} ;;
    '' | scheduled*) continue ;;
    *)
      dfline=$l
      continue
      ;;
  esac
  case "$l" in
    'at '*) s_at=\${l#at } ;;
    'id '*) s_id=\${l#id } ;;
    'after '*) s_after=\${l#after } ;;
    running) s_running=yes ;;
    drill) d_seen=yes ;;
    'drill '*) d_seen=yes d_line=\${l#drill } ;;
    'since '*) d_since=\${l#since } ;;
  esac
done <<EOF
$answer
EOF
disk=unknown
disk_json='{"status":"unknown"}'
# df's last line: its total, used and available bytes are the 5th to 3rd fields from the end.
set -f
# shellcheck disable=SC2086 # split on blanks, with globbing off.
set -- $dfline
set +f
if [ "$read_ok" = yes ] && [ "$#" -ge 6 ]; then
  while [ "$#" -gt 5 ]; do shift; done
  total=$1 used=$2 free=$3
  if digits "$total" && digits "$used" && digits "$free" && [ $((used + free)) -gt 0 ]; then
    percent=$(((used * 100 + used + free - 1) / (used + free)))
    disk=ok
    if [ "$percent" -ge "$DISK_HIGH" ]; then
      disk=high
    elif [ "$percent" -ge "$DISK_WARN" ]; then
      disk=warn
    fi
    disk_json="{\\"status\\":\\"$disk\\",\\"percent\\":$percent,\\"free\\":$free,\\"total\\":$total}"
  fi
fi
snapshot=unknown
snapshot_json='{"status":"unknown"}'
if [ "$read_ok" != yes ]; then
  :
elif [ -z "$s_at" ]; then
  snapshot=none
  snapshot_json='{"status":"none"}'
elif [ "$s_running" = no ] && digits "$s_at" && digits "$s_after"; then
  case "$s_id" in
    '')
      snapshot=failed
      snapshot_json='{"status":"failed"}'
      ;;
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z)
      snapshot=ok
      if [ "$s_after" -gt 0 ]; then snapshot=copy-failed; fi
      snapshot_json="{\\"status\\":\\"$snapshot\\",\\"id\\":\\"$s_id\\"}"
      ;;
  esac
fi
drill=none
drill_json='{"status":"none"}'
if [ -n "$DRILL" ]; then
  drill=unknown
  drill_json='{"status":"unknown"}'
  period=$((7 * DAY))
  if [ "$DRILL" = daily ]; then period=$DAY; fi
  limit=$((2 * period + 3600))
  if [ "$read_ok" != yes ] || [ "$d_seen" = no ]; then
    :
  elif [ -z "$d_line" ]; then
    # None ran yet: late once the schedule has had a snapshot to restore for that long.
    if digits "$d_since" && [ "\${#d_since}" -le 12 ] && [ $((NOW - d_since)) -gt "$limit" ]; then
      drill=late
      drill_json='{"status":"late"}'
    fi
  else
    end=\${d_line%% *} result=\${d_line#* }
    case "$end" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z)
        case "$result" in
          healthy | unhealthy | not-restored | failed)
            if epoch "$end"; then
              drill=ok
              if [ "$result" != healthy ]; then
                drill=failed
              elif [ $((NOW - epoch)) -gt "$limit" ]; then
                drill=late
              fi
              drill_json="{\\"status\\":\\"$drill\\",\\"result\\":\\"$result\\",\\"at\\":\\"$end\\"}"
            fi
            ;;
        esac
        ;;
    esac
  fi
fi
statuses="disk $disk\${NL}snapshot $snapshot\${NL}drill $drill"
said="disk $disk, snapshot $snapshot, drill $drill"

# 4. The certificates this server serves for the app, as Caddy serves them on 127.0.0.1:443 with
# each hostname as SNI: no file is read. No TLS answer is none.
certs=''
while IFS= read -r host; do
  [ -n "$host" ] || continue
  status=none
  item="{\\"hostname\\":\\"$host\\",\\"status\\":\\"none\\"}"
  end=$(timeout 10 openssl s_client -connect 127.0.0.1:443 -servername "$host" < /dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null) || end=''
  case "$end" in
    notAfter=*)
      if epoch "\${end#notAfter=}"; then
        days_of $((epoch - NOW))
        status=ok
        if [ "$days" -lt 0 ]; then
          status=expired
        elif [ "$days" -lt "$CERT_DAYS" ]; then
          status=warn
        fi
        item="{\\"hostname\\":\\"$host\\",\\"status\\":\\"$status\\",\\"days\\":$days}"
      fi
      ;;
  esac
  certs="\${certs:+$certs,}$item"
  statuses="$statuses\${NL}certificate:$host $status"
  said="$said, certificate $host $status"
done <<EOF
$HOSTS
EOF

# 5. The credentials' ages, once a day (or when the config's dates changed): in between, the last
# check's results, kept in the state file.
creds_json=''
fresh=no
if [ -n "$MAX_AGE" ]; then
  have=''
  while IFS=' ' read -r name at source status days; do
    [ -n "$name" ] || continue
    case "$status" in ok | old) ;; *) have=- ;; esac
    digits "\${days#-}" || have=-
    [ "$have" = - ] || have="$have$name $at $source$NL"
  done <<EOF
$carried
EOF
  lines=$carried
  if [ -z "$checked" ] || [ $((NOW - checked)) -ge "$DAY" ] || [ "$have" != "$CREDS" ]; then
    fresh=yes checked=$NOW lines=''
    while IFS=' ' read -r name at source; do
      [ -n "$name" ] || continue
      epoch "$at" || invalid
      age=$((NOW - epoch))
      days_of "$age"
      status=ok
      if [ "$age" -gt $((MAX_AGE * DAY)) ]; then status=old; fi
      lines="$lines$name $at $source $status $days$NL"
    done <<EOF
$CREDS
EOF
  fi
  creds=''
  while IFS=' ' read -r name at source status days; do
    [ -n "$name" ] || continue
    creds="\${creds:+$creds,}{\\"name\\":\\"$name\\",\\"status\\":\\"$status\\",\\"days\\":$days,\\"source\\":\\"$source\\"}"
    statuses="$statuses\${NL}credential:$name $status"
    said="$said, credential $name $status"
  done <<EOF
$lines
EOF
  creds_json=",\\"credentials\\":[$creds]"
fi

# 6. A change is a status that differs from the last report's; unknown is none, and keeps the
# last known status.
changed=no saved=''
while IFS=' ' read -r key status; do
  [ -n "$key" ] || continue
  was=''
  case "$prev$NL" in *"$NL$key "*)
    was=\${prev#*"$NL$key "}
    was=\${was%%"$NL"*}
    ;;
  esac
  if [ "$status" = unknown ]; then
    saved="$saved$key \${was:-unknown}$NL"
  else
    if [ "$status" != "$was" ]; then changed=yes; fi
    saved="$saved$key $status$NL"
  fi
done <<EOF
$statuses
EOF

# write_state <time of the last report>: the state, through a temporary file and a rename.
write_state() {
  {
    echo "sent $1"
    if [ -n "$checked" ]; then echo "checked $checked"; fi
    while IFS= read -r l; do
      [ -z "$l" ] || echo "status $l"
    done <<EOF
$saved
EOF
    while IFS= read -r l; do
      [ -z "$l" ] || echo "credential $l"
    done <<EOF
\${lines:-}
EOF
  } > "$STATE.tmp"
  mv -f "$STATE.tmp" "$STATE"
}

# 7. Send on a change, or 24 hours after the last report; the state is kept unless the Worker
# accepted it, so the next run sends again.
kind=heartbeat
if [ "$changed" = yes ] || [ -z "$sent" ]; then kind=change; fi
if [ "$kind" = change ] || [ $((NOW - sent)) -ge "$DAY" ]; then
  body="{\\"version\\":1,\\"server\\":\\"$SERVER\\",\\"kind\\":\\"$kind\\",\\"disk\\":$disk_json,\\"snapshot\\":$snapshot_json,\\"drill\\":$drill_json,\\"certificates\\":[$certs]$creds_json}"
  sign "$NOW$NL$body"
  code=$(printf '%s' "$body" | curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -A "$AGENT" \\
    -H 'Content-Type: application/json' -H "X-OpsCrew-Entry: $ENTRY" -H "X-OpsCrew-Time: $NOW" \\
    -H "X-OpsCrew-Signature: $signature" --data-binary @- "$URL" 2>/dev/null) || code=''
  case "$code" in
    2[0-9][0-9])
      write_state "$NOW"
      said="$said; sent a $kind report"
      ;;
    '' | 000) said="$said; the Worker could not be reached, so the next run sends again" ;;
    *) said="$said; the Worker refused the report (HTTP $code), so the next run sends again" ;;
  esac
else
  if [ "$fresh" = yes ]; then write_state "$sent"; fi
  said="$said; no change"
fi
echo "uptime report: $said"
`;
}

/** The template service (one instance per environment). */
export const UPTIME_REPORT_SERVICE_TEXT = `# ${UPTIME_REPORT_SERVICE_UNIT}
# Managed by OpsCrew: checks this server for the uptime entry %i and reports its changes to the
# Cloudflare uptime Worker. \`opscrew destroy\` removes it.
[Unit]
Description=OpsCrew uptime report %i
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=${UPTIME_REPORT_USER}
LoadCredential=config:${UPTIME_REPORT_CONFIG_DIR}/%i.conf
LoadCredential=key:${UPTIME_REPORT_CONFIG_DIR}/%i.key
StateDirectory=opscrew-uptime-report/%i
StateDirectoryMode=0700
ExecStart=${UPTIME_REPORT_SCRIPT}
TimeoutStartSec=300
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
SystemCallArchitectures=native
`;

/** The template timer: two minutes after boot, then every 5 minutes. */
export const UPTIME_REPORT_TIMER_TEXT = `# ${UPTIME_REPORT_TIMER_UNIT}
# Managed by OpsCrew: runs the uptime report %i every 5 minutes.
[Unit]
Description=OpsCrew uptime report %i, every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`;

/** SHA-256 of the shared files this version writes. */
export function uptimeReportFileHashes(): { script: string; service: string; timer: string } {
  return {
    script: sha256Hex(renderUptimeReportScript()),
    service: sha256Hex(UPTIME_REPORT_SERVICE_TEXT),
    timer: sha256Hex(UPTIME_REPORT_TIMER_TEXT),
  };
}

/** The instance's config (data-model.md): names and dates only, never a value. */
export function uptimeReportConfigText(app: string, report: DesiredUptimeReport): string {
  return [
    `# ${UPTIME_REPORT_CONFIG_DIR}/${uptimeReportInstance(report.entry)}.conf`,
    `# Managed by OpsCrew: what the uptime report of ${report.entry} checks on this server.`,
    `url=${report.url}`,
    `entry=${report.entry}`,
    `server=${report.server}`,
    `app=${app}`,
    `drill=${report.drill ?? ""}`,
    `disk_warn=${report.thresholds.diskWarn}`,
    `disk_high=${report.thresholds.diskHigh}`,
    `cert_days=${report.thresholds.certDays}`,
    ...report.hosts.map((host) => `host=${host}`),
    ...(report.credentials === undefined
      ? []
      : [
          `max_age_days=${report.credentials.maxAgeDays}`,
          ...report.credentials.dates.map(
            (date) => `credential=${date.name} ${date.at} ${date.source}`,
          ),
        ]),
    "",
  ].join("\n");
}

/** The packages the script needs that the server lacks, as the step's `packages` names them. */
const PACKAGE_SETS = ["", "curl", "openssl", "curl openssl"] as const;

/**
 * The step's parameters, read back into the app, the instance, the packages and the report (the
 * key by its SHA-256 only), checked as `planUptimeReport` checks its input.
 */
export const UptimeReportParamsSchema = z.preprocess(
  (input) => {
    if (typeof input !== "object" || input === null) return input;
    const {
      url,
      entry,
      server,
      drill,
      hosts,
      diskWarn,
      diskHigh,
      certDays,
      maxAgeDays,
      credentials,
      keySha256,
      ...rest
    } = input as Record<string, unknown>;
    return {
      ...rest,
      report: {
        url,
        entry,
        server,
        ...(drill === "" ? {} : { drill }),
        // The hostnames, space-separated.
        hosts: typeof hosts === "string" ? hosts.split(" ").filter((host) => host !== "") : hosts,
        thresholds: { diskWarn, diskHigh, certDays },
        // One `<name> <date> <source>` line per credential, with `maxAgeDays`.
        ...(maxAgeDays === undefined && credentials === undefined
          ? {}
          : {
              credentials: {
                maxAgeDays,
                dates:
                  typeof credentials === "string"
                    ? credentials
                        .split("\n")
                        .filter((line) => line !== "")
                        .map((line) => {
                          const [name, at, source, ...more] = line.split(" ");
                          return more.length === 0 ? { name, at, source } : line;
                        })
                    : (credentials ?? []),
              },
            }),
        keySha256,
      },
    };
  },
  z
    .strictObject({
      app: AppNameSchema,
      instance: z.string().regex(/^[0-9a-f]{16}$/),
      version: z.literal(UPTIME_REPORT_VERSION),
      packages: z.enum(PACKAGE_SETS),
      report: DesiredUptimeReportSchema,
    })
    .refine((p) => p.instance === uptimeReportInstance(p.report.entry), {
      message: "must be the entry's instance",
      path: ["instance"],
    }),
);

/** The step's parameters for `report` of `app` (see {@link UptimeReportParamsSchema}). */
function uptimeReportParams(
  app: string,
  report: DesiredUptimeReport,
  packages: string,
): HostStep["params"] {
  return {
    app,
    instance: uptimeReportInstance(report.entry),
    url: report.url,
    entry: report.entry,
    server: report.server,
    drill: report.drill ?? "",
    hosts: report.hosts.join(" "),
    diskWarn: report.thresholds.diskWarn,
    diskHigh: report.thresholds.diskHigh,
    certDays: report.thresholds.certDays,
    ...(report.credentials === undefined
      ? {}
      : {
          maxAgeDays: report.credentials.maxAgeDays,
          credentials: report.credentials.dates
            .map((date) => `${date.name} ${date.at} ${date.source}`)
            .join("\n"),
        }),
    version: UPTIME_REPORT_VERSION,
    packages,
    keySha256: report.keySha256,
  };
}

/**
 * The read-only lines inspection prints, as root: the shared files' mode, owner and SHA-256, the
 * config folder's mode and owner, the script's version, whether `curl` and `openssl` are there,
 * then for each instance's config its mode, owner and SHA-256, its `app=` line, its key file's
 * mode, owner and SHA-256 (never its content) and its timer. Never follows a link.
 */
export const UPTIME_REPORT_SNIPPET = `hashed() {
  if [ -f "$2" ] && [ ! -L "$2" ]; then echo "$1 $(stat -c '%a %U' "$2") $(sha256sum "$2" | cut -d ' ' -f 1)"; fi
}
hashed script ${UPTIME_REPORT_SCRIPT}
hashed service ${UPTIME_REPORT_SERVICE_UNIT}
hashed timer ${UPTIME_REPORT_TIMER_UNIT}
if [ -d ${UPTIME_REPORT_CONFIG_DIR} ] && [ ! -L ${UPTIME_REPORT_CONFIG_DIR} ]; then echo "dir $(stat -c '%a %U' ${UPTIME_REPORT_CONFIG_DIR})"; fi
if [ -f ${UPTIME_REPORT_SCRIPT} ] && [ ! -L ${UPTIME_REPORT_SCRIPT} ]; then
  sed -n '2s/^# opscrew-uptime-report version \\([0-9][0-9]*\\)$/version \\1/p' ${UPTIME_REPORT_SCRIPT}
fi
for t in curl openssl; do
  if command -v "$t" >/dev/null 2>&1; then echo "tool $t"; fi
done
for f in ${UPTIME_REPORT_CONFIG_DIR}/*.conf; do
  if [ -L "$f" ] || [ ! -f "$f" ]; then continue; fi
  i=\${f##*/}
  i=\${i%.conf}
  case "$i" in *[!0-9a-f]*) continue ;; esac
  [ "\${#i}" -eq 16 ] || continue
  hashed "config $i" "$f"
  echo "app $i $(sed -n 's/^app=\\([a-z0-9-]*\\)$/\\1/p' "$f" | head -n 1)"
  hashed "key $i" "${UPTIME_REPORT_CONFIG_DIR}/$i.key"
  en=$(systemctl is-enabled "opscrew-uptime-report@$i.timer") || true
  ac=$(systemctl is-active "opscrew-uptime-report@$i.timer") || true
  echo "unit $i \${en:--} \${ac:--}"
done`;

/** {@link UPTIME_REPORT_SNIPPET}'s lines as facts; a line in another form is left out. */
export function parseUptimeReport(text: string): UptimeReportFacts {
  const hashed = (rest: string[]) =>
    rest.length === 3 && /^[0-7]{3,4}$/.test(rest[0] ?? "") && /^[0-9a-f]{64}$/.test(rest[2] ?? "")
      ? { mode: rest[0] ?? "", owner: rest[1] ?? "", sha256: rest[2] ?? "" }
      : null;
  const files: Record<string, { mode: string; owner: string; sha256: string } | null> = {};
  let dir: { mode: string; owner: string } | null = null;
  let version: number | null = null;
  const tools = { curl: false, openssl: false };
  const byInstance = new Map<
    string,
    {
      app: string | null;
      config: { mode: string; owner: string; sha256: string } | null;
      key: { mode: string; owner: string; sha256: string } | null;
      timer: { enabled: boolean; active: boolean };
    }
  >();
  const instance = (id: string) => {
    let found = byInstance.get(id);
    if (found === undefined) {
      found = { app: null, config: null, key: null, timer: { enabled: false, active: false } };
      byInstance.set(id, found);
    }
    return found;
  };
  for (const line of text.split("\n")) {
    const [kind = "", ...rest] = line.trim().split(/\s+/);
    if (kind === "script" || kind === "service" || kind === "timer") files[kind] = hashed(rest);
    else if (kind === "dir" && rest.length === 2)
      dir = { mode: rest[0] ?? "", owner: rest[1] ?? "" };
    else if (kind === "version" && /^[1-9]\d{0,5}$/.test(rest[0] ?? "")) version = Number(rest[0]);
    else if (kind === "tool" && (rest[0] === "curl" || rest[0] === "openssl"))
      tools[rest[0]] = true;
    else if (/^[0-9a-f]{16}$/.test(rest[0] ?? "")) {
      const [id = "", ...values] = rest;
      if (kind === "config") instance(id).config = hashed(values);
      else if (kind === "key") instance(id).key = hashed(values);
      else if (kind === "app") {
        instance(id).app = AppNameSchema.safeParse(values[0]).success ? (values[0] ?? null) : null;
      } else if (kind === "unit") {
        instance(id).timer = { enabled: values[0] === "enabled", active: values[1] === "active" };
      }
    }
  }
  return UptimeReportFactsSchema.parse({
    version,
    script: files.script ?? null,
    service: files.service ?? null,
    timer: files.timer ?? null,
    dir,
    tools,
    instances: [...byInstance]
      .flatMap(([id, found]) =>
        found.config === null ? [] : [{ instance: id, ...found, config: found.config }],
      )
      .sort((a, b) => a.instance.localeCompare(b.instance)),
  });
}

/** A file is root's with these permission bits. */
function rootOwned(file: { mode: string; owner: string } | null | undefined, mode: string) {
  return file?.mode === mode && file.owner === "root";
}

/** The shared files are this version's, or a newer version's (which stays). */
function sharedInPlace(facts: UptimeReportFacts): boolean {
  if (facts.version === null) return false;
  if (facts.version > UPTIME_REPORT_VERSION) {
    return facts.script !== null && facts.service !== null && facts.timer !== null;
  }
  const hashes = uptimeReportFileHashes();
  return (
    facts.version === UPTIME_REPORT_VERSION &&
    facts.script?.sha256 === hashes.script &&
    facts.service?.sha256 === hashes.service &&
    facts.timer?.sha256 === hashes.timer &&
    rootOwned(facts.script, "755") &&
    rootOwned(facts.service, "644") &&
    rootOwned(facts.timer, "644")
  );
}

/** "a, b and c". */
function listed(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** What the step installs and what the script does, for the host plan. */
function setupText(app: string, report: DesiredUptimeReport, packages: string): string {
  const instance = uptimeReportInstance(report.entry);
  const config = `${UPTIME_REPORT_CONFIG_DIR}/${instance}.conf`;
  const key = `${UPTIME_REPORT_CONFIG_DIR}/${instance}.key`;
  return [
    ...(packages === "" ? [] : [`It installs ${listed(packages.split(" "))} first.`]),
    `It writes ${UPTIME_REPORT_SCRIPT} (version ${UPTIME_REPORT_VERSION}, mode 755, root's) and the template units ${UPTIME_REPORT_SERVICE_UNIT} and ${UPTIME_REPORT_TIMER_UNIT} (644, root's), unless a newer version is there; then ${config} (600, root's), with the report address ${report.url}, the entry ${report.entry}, the server's id ${report.server}, the app "${app}", ${report.drill === undefined ? "no drill schedule" : `the ${report.drill} drill schedule`}, the thresholds (disk ${report.thresholds.diskWarn}% and ${report.thresholds.diskHigh}%, certificates ${report.thresholds.certDays} days), ${report.hosts.length === 0 ? "no hostname" : `the hostnames ${listed(report.hosts)}`}${report.credentials === undefined ? "" : `, and the names and dates of ${report.credentials.dates.length === 1 ? "the credential" : "the credentials"} ${listed(report.credentials.dates.map((date) => date.name))} with their ${report.credentials.maxAgeDays}-day limit`}, never a value; and ${key} (600, root's), the report key supplied at apply time, which this plan names by its SHA-256 only. It turns on ${uptimeReportTimer(instance)}.`,
    `Every 5 minutes the timer runs the script as ${UPTIME_REPORT_USER}, with the config and the key handed over by systemd (LoadCredential=) and its state in ${UPTIME_REPORT_STATE_DIR}/${instance}: it reads the disk and the last scheduled snapshot and restore drill of "${app}" as the scheduled check's key does, the days left on the certificates this server serves on 127.0.0.1:443 for each hostname${report.credentials === undefined ? "" : ", and once a day the credentials' ages"}. It sends a report signed with the key to the Worker only when a status changes, and once a day; a report holds statuses and figures only, never a log line, an address or a secret.`,
    UPTIME_REPORT_KEY_REACH,
  ].join(" ");
}

/**
 * The `uptime-report` step that installs `report` of `app` on the server (`facts`): in place when
 * the shared files are this version's (or newer), the instance's config and key are as planned,
 * root's and 0600, its timer runs, and `curl` and `openssl` are there.
 */
export function uptimeReportStep(
  facts: UptimeReportFacts,
  app: string,
  report: DesiredUptimeReport,
): HostStep {
  const instance = uptimeReportInstance(report.entry);
  const packages = [
    ...(facts.tools.curl ? [] : ["curl"]),
    ...(facts.tools.openssl ? [] : ["openssl"]),
  ].join(" ");
  const own = facts.instances.find((item) => item.instance === instance);
  const inPlace =
    packages === "" &&
    sharedInPlace(facts) &&
    rootOwned(facts.dir, "700") &&
    own !== undefined &&
    own.config.sha256 === sha256Hex(uptimeReportConfigText(app, report)) &&
    rootOwned(own.config, "600") &&
    own.key?.sha256 === report.keySha256 &&
    rootOwned(own.key, "600") &&
    own.timer.enabled &&
    own.timer.active;
  return {
    id: "uptime-report",
    title: `Report this server's checks of ${report.entry} to the Cloudflare uptime Worker (every 5 minutes, sent on a change and once a day)`,
    state: inPlace ? "in-place" : "change",
    scope: "app",
    reason: inPlace ? "Already running." : setupText(app, report, packages),
    params: uptimeReportParams(app, report, packages),
  };
}

/**
 * The step that removes the instances `instances` (their timer, config, key and state) and, with
 * `shared`, the script and units once no other instance is left.
 */
export function uptimeReportRemoval(
  instances: readonly string[],
  shared: boolean,
  scope: HostStep["scope"],
): HostStep {
  const sorted = [...instances].sort();
  const whose =
    sorted.length === 1
      ? `the uptime report ${sorted[0]}`
      : sorted.length === 0
        ? "what is left of the uptime report"
        : "the uptime reports";
  return {
    id: "uptime-report",
    title: `Remove ${whose}${shared && sorted.length > 0 ? ", and its script and units with the last one" : ""}`,
    state: "change",
    scope,
    reason: `${sorted.length > 0 ? `Stops and disables ${sorted.map(uptimeReportTimer).join(", ")}, and removes ${sorted.length === 1 ? "its" : "each one's"} config, key file and state. ` : ""}${shared ? `Once no other environment's report is left, ${UPTIME_REPORT_SCRIPT} and its units go too.` : "The other environments' reports stay."}`,
    params: { remove: true, instances: sorted.join(" "), shared },
  };
}

/**
 * A teardown's removal of the app's instances (by their config's app), with the script and units
 * when no other is left; undefined when the app has none.
 */
export function uptimeReportTeardownStep(facts: HostFacts, app: string): HostStep | undefined {
  const all = facts.uptimeReport?.instances ?? [];
  const own = all.filter((item) => item.app === app).map((item) => item.instance);
  if (own.length === 0) return undefined;
  return uptimeReportRemoval(own, own.length === all.length, "app");
}

/**
 * An undo's removal of what is left of the uptime report once every app is gone: any instance,
 * and the script, units and folder; undefined when nothing is there.
 */
export function uptimeReportUndoStep(facts: HostFacts): HostStep | undefined {
  const found = facts.uptimeReport;
  if (found === undefined) return undefined;
  const left =
    found.script !== null || found.service !== null || found.timer !== null || found.dir !== null;
  if (found.instances.length === 0 && !left) return undefined;
  return uptimeReportRemoval(
    found.instances.map((item) => item.instance),
    true,
    "shared",
  );
}
