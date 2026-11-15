# Contract: the address updater on a home server

Owner: `packages/connectors/ssh-host/src/dns-updater.ts` (T2904). It renders the script, the
units and the config, and holds the `dns-updater` step's scripts. The setup host plan's
`dns-updater` step installs it; the teardown removes it.

Callers:
- agents provision (T2913a): `DesiredHost.dnsUpdater`, the token on standard input;
- the dedicated host plan of a switch out of home (T2913b): the instance removed;
- rotate (T2915a): a new token;
- the 028 finish (T2916b): B's zone and token;
- destroy (T2915b): the teardown;
- status, verify, secure and drift (T2914a to T2914c): the state and the files, read through
  inspection's `dnsUpdaters`.

The records themselves are deleted by agents (`home/records.ts`, plan 14.), never by the server.

## Files on the server

| Path | Mode, owner | Scope | Holds |
|---|---|---|---|
| `/usr/local/sbin/opscrew-dns-updater` | 0755 root | shared | the script, with `# opscrew-dns-updater version <n>` on line 2 |
| `/etc/systemd/system/opscrew-dns-updater@.service` | 0644 root | shared | the template service |
| `/etc/systemd/system/opscrew-dns-updater@.timer` | 0644 root | shared | the template timer |
| `/etc/opscrew/dns-updater/` | 0700 root | shared | the configs and tokens |
| `/etc/opscrew/dns-updater/<app>.json` | 0600 root | the app's | the config (data model 4); no secret, no address |
| `/etc/opscrew/dns-updater/<app>.token` | 0600 root | the app's | the token, one line, no newline at its end |
| `/var/lib/opscrew-dns-updater/<app>/state.json` | the service's (systemd `StateDirectory`) | the app's | the state (data model 5) |

The shared files stay while any instance is installed. A step never replaces a script or unit
whose version is newer than its own (`version` param).

## The units

```ini
# /etc/systemd/system/opscrew-dns-updater@.service
# Managed by OpsCrew: keeps the DNS records of the app %i pointed at this server's address.
# `opscrew destroy` removes it.
[Unit]
Description=OpsCrew address updater for %i
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
DynamicUser=yes
LoadCredential=config:/etc/opscrew/dns-updater/%i.json
LoadCredential=token:/etc/opscrew/dns-updater/%i.token
StateDirectory=opscrew-dns-updater/%i
ExecStart=/usr/local/sbin/opscrew-dns-updater
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
```

```ini
# /etc/systemd/system/opscrew-dns-updater@.timer
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
```

- **Credentials:** systemd copies the two root-only files into `$CREDENTIALS_DIRECTORY`, readable
  only by the dynamic user.
- **State:** `$STATE_DIRECTORY` is the state folder.
- **Requirements:** `LoadCredential=` needs systemd 247 or newer. Ubuntu 22.04 has 249 and Debian
  12 has 252.

## A run, in order

The script is POSIX `sh` (`set -eu`) and uses curl, jq and `ip` (iproute2).

1. **Read the config** from `$CREDENTIALS_DIRECTORY/config` and check it with jq:
   - `schemaVersion` is 1;
   - `zoneId` is 32 lower-case hex;
   - `name` matches the hostname pattern of `HostnameSchema`;
   - the booleans are booleans.
   Otherwise the state records `config-invalid` and the run exits 2. The token is read from
   `$CREDENTIALS_DIRECTORY/token` and must be 40 to 255 printable characters with no whitespace.
2. **Detect the IPv4 address** (when `ipv4`):
   - ask `https://one.one.one.one/cdn-cgi/trace` with `curl -4 -fsS --max-time 10`, and take its
     `ip=` line;
   - ask `https://checkip.amazonaws.com` the same way, and take its first line;
   - an answer counts only when it's a dotted IPv4 address and public: not in 0/8, 10/8,
     100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16 or 224/4 and above;
   - both answer and disagree → `sources-disagree`, no IPv4 this run;
   - neither answers → `address-unknown`, no IPv4 this run.
3. **Detect the IPv6 address** (when `ipv6`): run `ip -6 route show default` for the interface,
   then `ip -6 -o addr show dev <it> scope global`.
   - The stable address is the one with none of `temporary`, `deprecated`, `tentative` or
     `dadfailed`, and not in `fc00::/7`. Of several, the one with the longest `preferred_lft`
     (`forever` first) wins, then the lowest.
   - With no default route, or no such address: positively none.
   - When `ip` fails: unknown.
4. **Read the records:**
   `GET https://api.cloudflare.com/client/v4/zones/<zoneId>/dns_records?name=<name>&per_page=50`.
   - Its own records: type A or AAAA, comment exactly `Managed by OpsCrew (address updater)`.
   - Foreign ones: A or AAAA with another comment, or a CNAME at the name. A foreign record stops
     the run with `foreign-record` or `cname-at-name`, and nothing is written.
   - More than one record of its own of a type: it keeps the first and deletes the others.
5. **Write only what differs**, per family it keeps:
   - known address, own record missing → `POST …/dns_records` with
     `{type, name, content, ttl, proxied, comment}`;
   - known address, own record whose `content`, `ttl` or `proxied` differs →
     `PATCH …/dns_records/<id>` with `{content, ttl, proxied}`;
   - IPv6 positively none, or the config's `ipv6` false, and an own AAAA → `DELETE` it;
   - the config's `ipv4` false and an own A → `DELETE` it;
   - unknown address → nothing for that family.
   An A record is never deleted because detection failed.
   `ttl` is 1 when `proxied`, else 60. Every call is `curl -fsS --max-time 15 -K -`, with
   `header = "Authorization: Bearer <token>"` given on standard input, so the token is never on a
   command line. A 401 or 403 is `token-refused`, a 429 is `rate-limited`, any other error is
   `cloudflare-error` (with the HTTP status and Cloudflare's error code numbers), and no answer is
   `cloudflare-unreachable`. Each error stops the run's writes.
6. **Write the state** (data model 5) to `$STATE_DIRECTORY/state.json.tmp`, then `mv` it into
   place. `lastSuccess` is set only when steps 2 to 5 had no error.
7. **Journal:** one line per run, from a fixed set, for example "address updater: no change",
   "address updater: A record updated (the address changed)", "address updater: AAAA record
   removed (no IPv6 address)", "address updater: Cloudflare refused the token (HTTP 403)". There is
   never an address, a token or Cloudflare's message text.
8. **Exit:** 0 after a run that recorded its result, errors included (the next run retries, and
   `systemctl --failed` stays clean). 2 for `config-invalid`.

## The rules the script keeps

- It writes only the records named in its config, and only A and AAAA with its own comment.
- It writes only an address that this server detected and that is public. Nothing from the
  network decides which record or zone it writes.
- It sends no other request to Cloudflare than the four above.
- Each value it puts in a URL or a JSON body comes from the config (checked in step 1) or from a
  detected address (checked in steps 2 and 3), and is built with `jq -n --arg`, never by string
  concatenation.
- The endpoints are constants at the top of the script. `renderDnsUpdaterScript(options)` takes
  other endpoints only for the Docker-gated test. The step always renders the defaults, and its
  params have no endpoint.

## The `dns-updater` host step

Data model 6 has the params. The scripts follow `steps.ts`'s pattern (`check`, `preApply`,
`apply`, `verify`).

- **check** (read-only): it prints `state=in-place` when all of these hold:
  - the shared files' SHA-256 are this version's, or a newer version is there;
  - the config's SHA-256 is that of the config these params render;
  - with `tokenSha256` set, the token file's SHA-256 equals it; without it, the file exists;
  - the files' modes and owners are as above;
  - `opscrew-dns-updater@<app>.timer` is enabled and active.
  Otherwise it prints `state=change` and the `prev.*` values of what's there. A missing token file
  with no token given is `blocked`: "set `OPSCREW_DNS_UPDATER_TOKEN` (the guide's recipe) and run
  `opscrew provision` again".
- **preApply:** `apt_get install` of the missing `packages` (`curl`, `jq`).
- **apply:**
  1. Write the shared files when they are missing or older.
  2. Write the config, and the token read from standard input when `tokenSha256` is set. The token
     is checked against `tokenSha256` before it's written, with `umask 077` and a rename.
  3. `systemctl daemon-reload`, then `systemctl enable --now opscrew-dns-updater@<app>.timer`, and
     `systemctl start opscrew-dns-updater@<app>.service`.
- **verify:** waits up to 60 s for the state's `lastSuccess` to be later than the apply's start.
  Otherwise it fails with the state's `lastError.code` in words: `token-refused` says "the token
  can't change example.com's DNS: give it Zone → DNS → Edit on that zone".
- **teardown** (`planTeardown`):
  1. `systemctl disable --now opscrew-dns-updater@<app>.timer`.
  2. Remove the config, the token and `/var/lib/opscrew-dns-updater/<app>` (with
     `/var/lib/private/opscrew-dns-updater/<app>`).
  3. With no other config left, remove the script, the two units and the folder, then
     `daemon-reload`.
  The records are deleted by agents, not by the server (plan 14.).
- **undo** (`planUndo`): it finds nothing more to remove once every app is gone. A leftover script
  or units without configs are removed.
- **Recorded** in `/etc/opscrew/host.json` like every step, with the previous state for the undo:
  never the token, and never `tokenSha256`.
- **The step's text** in the host plan names its bounds: the records, the families, "this
  server's own address only", every 2 minutes. It also says what root on the server can do with
  the token (plan 6., research R14).

## Read by inspection (`dnsUpdaters`)

For each `/etc/opscrew/dns-updater/*.json`, inspection reads:
- the app's name;
- whether the config parses;
- the token file's mode, owner and SHA-256 (never its content);
- the timer's `is-enabled`/`is-active`;
- the state file's JSON, at most 4 KiB.
agents validates the state with the zod schema of data model 5 and shows only this app's.

## Tests

- **Unit**, with the scripted remote: the step's states (in place, change, blocked, a newer
  version kept); the teardown with and without other instances; the token never in a script or a
  plan (the plan's JSON scanned for the fake token); the rendered config.
- **Script fixtures** (as `scripts.test.ts`): `ip` outputs with temporary, deprecated and ULA
  addresses; trace and checkip answers (agreeing, disagreeing, private, garbage); Cloudflare
  answers (empty, own, foreign, CNAME, 401, 429, 500).
- **Docker-gated** (`OPSCREW_DOCKER_TESTS=1`): the script, rendered with test endpoints, runs in a
  Debian container against a small fake Cloudflare and fake sources. It creates the record,
  changes nothing on a second run, puts back a record changed by hand, deletes the AAAA when the
  IPv6 address goes, keeps the record on a 429, and never shows the token in `ps` output during a
  run.
