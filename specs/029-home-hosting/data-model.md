# Data model: Hosting at home

**Status**: DRAFT, revised after the lead's review. Addresses below are documentation ranges
(`192.0.2.0/24`, `198.51.100.0/24`, `2001:db8::/32`); ids are placeholders.

## 1. `target.home` in `opscrew/plan.yaml` (committed)

Owner: plan-schema (contracts/plan-schema.md). It's on the own-server target only.

```yaml
target:
  provider: own
  mode: vps-compose
  arch: arm64
  access: public
  home:
    ipv4: true          # false: served over IPv6 only (behind the proxy, or DNS only as the user's choice)
  edge: caddy
dns:
  provider: cloudflare
  domain: shop.example.com
  zone: example.com
  proxied: true
environment:
  runner: server        # design's default at home; host (a runner machine on the LAN) is the other way
```

- **Absent:** the server isn't at home, or is served through the tunnel.
- **Never in the plan:** an address, a LAN fact or an SSH source (2.).
- **A user's `ipv4: false`** is kept by later designs. In DNS-only mode, it's the acceptance that
  only IPv6 visitors reach the site (FR-2911).
- **Readers:**
  - the renderers: the home root, the edge's ports, the web filter, the updater's config, the
    check's workflow, the health check's `--resolve`, `checkDiskVia`, the runbook;
  - agents: design, provision, verify, status, secure, drift, destroy, retarget (to refuse), the
    028 move, init.

## 2. The home's local record: `.opscrew/server.json` → `own.home` (gitignored)

Owner: agents `shared/server-record.ts` (`OwnServerSchema`), beside the existing `own` fields.
For a home server, `reachable` isn't written. `publicIpv4` and `publicIpv6` are never written
either: the public addresses are re-detected on every run (M7).

```json
{
  "own": {
    "host": "192.168.1.30",
    "port": 22,
    "user": "ana",
    "agent": true,
    "hostKey": "SHA256:…",
    "serve": "proxy",
    "home": {
      "sshFrom": ["192.168.1.0/24", "fe80::/10"],
      "network": {
        "detectedAt": "2026-11-20T10:00:00Z",
        "lan": { "address": "192.168.1.30", "network": "192.168.1.0/24", "interface": "eth0", "gateway": "192.168.1.1" },
        "ipv4": "seen",
        "noNat": false,
        "warning": "cgnat-hop",
        "ipv6": "present"
      },
      "outsideCheck": {
        "at": "2026-11-20T10:30:00Z",
        "host": "shop.example.com",
        "mode": "proxied",
        "http": "ok",
        "https": "ok",
        "runUrl": "https://github.com/owner/repo/actions/runs/123"
      }
    }
  }
}
```

- **`home` present** = the interview's `server.home yes`.
- **`sshFrom`:** the answer, or design's default, written once and shown in the host plan.
- **`network`:** the last classification, with no public address and no hop:
  - `ipv4`: `seen` | `none` | `unknown`;
  - `noNat`: the public IPv4 is on the server's interface;
  - `warning`: `cgnat-hop` | `private-hop` | `cgnat-interface`, when present;
  - `ipv6`: `present` | `absent` | `unknown`.
- **`outsideCheck`:** `http` and `https` are each `ok`, `failed`, `unfinished` (cancelled or timed
  out: run verify again) or `skipped`.
- **Never** committed, never in the recovery copy beyond what `server.json` holds today, and never
  in an audit entry. The public addresses live only in the run's memory, registered with the
  redactor as names when the app is proxied.

## 3. `HomeNetwork`: what `detectHomeNetwork(remote)` returns

Owner: connector-ssh-host (`home-network.ts`), exposed on the host adapter
(`HostAdapterApi.detectHomeNetwork`, agents `shared/host-plan.ts`). The script prints `key=value`
lines. The parser keeps the known keys only and validates each value. The classification is agents'
(`home/network.ts`).

```text
lan.address=192.168.1.30
lan.prefix=24
lan.interface=eth0
lan.gateway=192.168.1.1
ipv4.route=yes                     # an IPv4 default route exists
ipv4.cloudflare=198.51.100.7       # absent when the trace didn't answer or gave no valid ip= line
ipv4.aws=198.51.100.7              # absent likewise; both sources are asked every time
ipv4.interface=                    # an IPv4 on the server's own interfaces equal to the outside view, or in 100.64.0.0/10
ipv6.stable=2001:db8:1:2::30       # absent when there is none
ipv6.state=present                 # present | absent | unknown (ip -6 failed)
hop.1=192.168.1.1
hop.2=198.51.100.1
tools=curl tracepath
```

```ts
interface HomeNetwork {
  lan: { address: string; prefix: number; interface: string; gateway?: string } | undefined;
  ipv4: { route: boolean; cloudflare?: string; aws?: string; interface?: string };
  ipv6: { state: "present" | "absent" | "unknown"; stable?: string };
  hops: string[];      // at most 3; empty without tracepath or traceroute
  tools: string[];
}
```

- **The two-source rule:**
  - both answer and differ → unknown;
  - one answers → that one;
  - a non-IPv4 or non-public answer counts as no answer.
- **The stable IPv6 address:**
  - global scope, on the interface of the IPv6 default route;
  - not `temporary`, `deprecated`, `tentative` or `dadfailed`, and not in `fc00::/7`;
  - of several: the longest preferred lifetime, then the lowest.
- **Read-only:** nothing is written on the server. The addresses go no further than the run's
  memory: the classification is stored (2.), they aren't.

## 4. The updater's config on the server: `/etc/opscrew/dns-updater/<app>.json`

Owner: connector-ssh-host (`dns-updater.ts`), written by the `dns-updater` step. It's 0600 root, in
a 0700 root folder, and reaches the service through `LoadCredential=config:`. It holds no secret and
no address.

```json
{
  "schemaVersion": 1,
  "app": "shop",
  "zoneId": "0123456789abcdef0123456789abcdef",
  "name": "shop.example.com",
  "proxied": true,
  "ipv4": true,
  "ipv6": false
}
```

- **`ipv4`/`ipv6`:** the records it keeps (plan 8.). When one is `false`, a record of its own of
  that type is deleted.
- **TTL:** 1 when `proxied`, else 60.
- **Comment:** `Managed by OpsCrew (address updater)`, fixed in the script.

## 5. The updater's state on the server: `/var/lib/opscrew-dns-updater/<app>/state.json`

Written by the script after every run (a temporary file, then a rename). Read by inspection
(`dnsUpdaters`), then by `status`, `verify` and `secure`. Readable by root and the service's user
only.

```json
{
  "schemaVersion": 1,
  "version": 1,
  "lastRun": "2026-11-20T10:04:12Z",
  "lastSuccess": "2026-11-20T10:04:12Z",
  "seen": { "ipv4": "198.51.100.7", "ipv6": null },
  "records": { "ipv4": "198.51.100.7", "ipv6": null },
  "lastWrite": { "at": "2026-11-20T09:12:40Z", "changed": ["A"] },
  "lastError": { "at": "2026-11-19T22:00:02Z", "code": "rate-limited", "http": 429, "cloudflare": [10000] }
}
```

- **`seen`** is what this run detected; **`records`** is what the records hold after it. `null`
  means none, or a family the updater doesn't keep.
- **`lastWrite.changed`** holds some of `A`, `AAAA`, `A-deleted`, `AAAA-deleted` and `created`.
- **`lastError.code`:**

  | Code | Meaning | What `status`/`verify` say next |
  |---|---|---|
  | `address-unknown` | no source answered | check the server's outbound HTTPS |
  | `sources-disagree` | the two IPv4 sources differ | wait; a router with two connections can cause it |
  | `token-refused` | 401 or 403 | make a new token, `opscrew rotate dns-updater` |
  | `rate-limited` | 429 | none; it retries |
  | `cloudflare-unreachable` | no answer | check the server's internet connection |
  | `cloudflare-error` | any other error; the HTTP status and Cloudflare's error codes kept | run `opscrew verify` again; report it if it stays |
  | `foreign-record` | an A or AAAA without its comment holds the name | remove that record |
  | `cname-at-name` | a CNAME holds the name | finish the mode switch with `opscrew provision` |
  | `config-invalid` | the config failed the script's checks | `opscrew provision` |

  It never holds Cloudflare's message text, the token or an address. A later run that succeeds sets
  `lastSuccess` past it.
- **Masking:** `status` shows `seen` and `records` in full for a DNS-only app only.

## 6. The `dns-updater` step, `DesiredHost`, the app record and the facts (connector-ssh-host)

**The step.** `HOST_STEP_IDS` gains `dns-updater`, after `app-record`, with scope `app`.
`agents/src/drift/host.ts`'s `AREA_TITLES` gains its title. Its params, which the plan's hash
covers:

| Param | Example | Meaning |
|---|---|---|
| `app` | `shop` | the instance |
| `zoneId` | 32 hex | the zone's id |
| `name` | `shop.example.com` | `dns.domain` |
| `proxied` | `true` | |
| `ipv4`, `ipv6` | `true`, `false` | 4. |
| `version` | `1` | the script and units' version; a newer copy on the server stays |
| `packages` | `curl jq` | the missing ones |
| `tokenSha256` | 64 hex, or empty | the SHA-256 of the token on standard input; empty keeps the server's file |

The change record in `/etc/opscrew/host.json` keeps the previous state for the undo. It never
holds the token or `tokenSha256`.

**`DesiredHostSchema`** gains:
- `home: { ipv4: boolean }`, recorded in the app record (`/etc/opscrew/apps/<app>.json` →
  `home`). A home app beside a non-home app, or home apps with different `ipv4`, are a blocker;
- `sshFrom`: 1 to 32 canonical sources, which add the `ssh-firewall` step;
- `dnsUpdater: { zoneId, name, proxied, ipv4, ipv6, tokenSha256? }`.

`webFilter` gains `ipv6?: string[]` (1 to 100 networks). `ApplySecrets` gains `dnsUpdaterToken`
(40 to 255 printable characters, no whitespace), required when `tokenSha256` is set.

**HostFacts** (inspection) gains:

```ts
board: string | null;                                    // "Raspberry Pi 5 Model B Rev 1.0", or null
storage: { srv: StorageDevice | null; docker: StorageDevice | null };
  // StorageDevice = { source: "/dev/mmcblk0p2", disk: "mmcblk0", kind: "sd" | "mmc" | "mmc-unknown" | "other" }
power: { underVoltageNow: boolean; underVoltageSinceBoot: boolean; source: "vcgencmd" | "kernel-log" } | null;
dnsUpdaters: { app: string; config: boolean; token: { present: boolean; mode: string; owner: string; sha256: string | null };
               timer: { enabled: boolean; active: boolean }; state: unknown | null }[];
  // agents parses `state` with 5.'s schema; the token's value is never read, only its SHA-256
```

## 7. The records at Cloudflare

| Record | Written by | Content | TTL | Proxied | Comment |
|---|---|---|---|---|---|
| A at `dns.domain` | the updater | the outside IPv4 | 1 proxied, 60 DNS-only | as the plan | `Managed by OpsCrew (address updater)` |
| AAAA at `dns.domain` | the updater | the stable IPv6 | as A | as the plan | the same |
| CNAME `www.<domain>` | the root (`cloudflare-dns`) | `dns.domain` | 1 | as the plan | `Managed by OpsCrew` |
| CAA at `dns.domain` (DNS-only) | the root | the edge's issuers | 1 | no | `Managed by OpsCrew` |

- **Deleted** through the hashed deletion plan (11.) by destroy, by a switch out of home and by a
  028 abort (in B). The updater deletes them itself when a family goes (4.).
- **Copied** by the 028 move (shown masked) and refreshed at its switch. The comment counts as
  OpsCrew's in `opscrewNamesInZone`.
- **The module address** of the root's A record becomes `module.dns.cloudflare_dns_record.a[0]`
  for every app with DNS on Cloudflare (one moves-only plan each).

## 8. Variables (this computer)

| Variable | Holds | Used by |
|---|---|---|
| `OPSCREW_DNS_UPDATER_TOKEN` | the updater's token for the app's zone (the user's) | provision, `rotate dns-updater` |
| `OPSCREW_NEW_DNS_UPDATER_TOKEN` | the token for B's zone during a 028 move | the move's finish (else asked once in a terminal, hidden) |
| `CLOUDFLARE_API_TOKEN` | OpsCrew's own token, as today; never the updater's | everything else |

Both new values are registered with the redactor when read, and never written to a file on this
computer.

## 9. `opscrew/credentials.yaml` (committed)

`dns-updater` joins the user's token names (`rotate/record.ts` `OTHER_TOKEN_NAMES`), with its
rotation dates per environment, as for `cloudflare-deploy`. It never holds a value or a
fingerprint.

## 10. Audit entries

The kinds are the existing `AuditKind`s (`packages/contracts/src/safety.ts`), and approvals are
recorded as today (`approval`, with the plan's hash). The target is the app, or "your home server",
never an address.

| Action | Kind |
|---|---|
| `home network read` | `remote-exec` (read-only) |
| `updater token checked` | `provider-call` (read-only) |
| the host plan's apply (`dns-updater`, `ssh-firewall`, `web-filter`) | `remote-exec`, as every host plan's |
| `dispatch workflow` (`opscrew-outside-check.yml`, host, path, mode) | `provider-call` |
| `outside check result` (each port's result) | `provider-call` |
| `updater records deleted` (the ids and types, no content) | `provider-call`, after the deletion plan's approval |

The updater's own writes are recorded on the server, in its state and the journal, and shown by
`status`.

## 11. The deletion plan of the updater's records (agents `home/records.ts`)

```ts
interface UpdaterRecordsDeletion {
  action: "delete-updater-records";
  app: string;
  zoneId: string;
  name: string;                                        // dns.domain
  records: { id: string; type: "A" | "AAAA"; name: string }[];   // sorted by id; never content
  planHash: string;                                    // sha256 of canonicalJson of the fields above
}
```

- **Read:** `listDnsRecords(zoneId, { name })` gives every record with the updater's comment.
- **Shown:** the plan lists them by type and name.
- **Approval:** `cloudflare-apply`, with `allowDestroy` and the app's name typed.
- **Apply:** the plan is built again from a fresh read. With another hash, nothing is deleted and
  the run says to go again. Otherwise each id goes through `deleteRecord`.
- **No records:** nothing to approve.
- **In B during a 028 abort:** the same, with B's client and zone.
