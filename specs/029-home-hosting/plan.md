# Implementation Plan: Hosting at home: your own IP address and dynamic DNS

**Branch**: `main` | **Date**: 2026-11-15 | **Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)

**Status**: DRAFT, revised after the lead's review (2026-11-15). The decisions are R1 to R14 in
research.md. US6 (deploys through Cloudflare Access SSH) is cut (founder, 2026-11-15);
"If the founder keeps US6" says what it would need. The constitution amendment (R14) waits for the
founder too.

## Summary

A server the user already owns can now be **at home**, serving the app at the home's own public
address. Today such a server can only use the tunnel. A home server is still an own server
(`target.provider: own`, `access: public`), marked with one key, `target.home` (R1). What it adds:

1. **The home's network, read from the server** (R3). Before any change, and on every run, a
   read-only probe on the host adapter finds:
   - the LAN address and network;
   - the IPv4 address the internet sees, from two sources that must agree;
   - the stable global IPv6 address;
   - the first hops.
   A carrier-NAT or private hop warns that the connection looks like it has no public IPv4
   address, and offers the tunnel and IPv6 behind the proxy (FR-2901, FR-2911). The outside check
   decides. Public addresses are never persisted.
2. **Router forwards, said exactly** (FR-2902): TCP 80 and 443 to the server's LAN address, a DHCP
   reservation, and the router's IPv6 firewall rule whenever an AAAA record is published. OpsCrew
   never touches the router.
3. **An address updater on the server** (R2, R4, R5), every two minutes under a systemd timer,
   installed, updated and removed only by the host plan, approved by its hash.
   - It owns the app's A/AAAA records and writes only what differs: 60 s TTL for DNS-only records,
     automatic for proxied ones.
   - It uses the stable IPv6 address and removes the AAAA when there is none.
   - Its token is the user's, limited to the zone's DNS, kept only on the server (root only) and
     handed to an unprivileged process (R6). The plan says plainly what root on the server can do
     with it (R14).
4. **The outside check** (R7): `opscrew verify` dispatches a one-shot workflow on GitHub's hosted
   runners. It requests the app's cache-busted health path on 443 and the hostname on 80, and it
   never gets the home's address.
5. **SSH only from the home network** (R8): the existing `ssh-firewall` step in a home server's
   setup host plan.
6. **Deploys without inbound SSH from the internet** (R9): the server's runner by default, or a
   runner machine on the LAN. For a DNS-only app, the deploy's health check reaches the edge
   directly, so hairpin NAT can't fail it.
7. **Raspberry Pi advice** (R10): design warns about an SD card under a database. `verify` and
   `secure` report under-voltage.
8. **The updater's state in `status` and `verify`** (R11), over SSH, without showing a proxied
   app's address.
9. **Records deleted through a hashed plan of their own** (R12): in destroy, when leaving home
   mode, and in the 028 move's abort. Mode switches follow H4's order. Retarget to or from home is
   refused.

What exists is reused: the own-server target and its serve modes, the host plan and its safety
switch, origin protection, the web filter, the SSH firewall, the server's runner, user-token
rotation, destroy's teardown, `removeOldAccessMode`, 028's `zoneDeletion` pattern, and the GitHub
connector's dispatch and runs.

## Technical Context

- **Language/Version**: TypeScript strict ESM on Node.js >= 22. On the server: POSIX `sh` with
  curl, jq, iproute2 and nftables from the distribution, installed by the host plan when missing.
- **Primary Dependencies**: no new npm dependency and no new pinned image. Cloudflare's v4 API is
  reached through `@opscrew/connector-cloudflare` and from the updater's script. GitHub's Actions
  API is reached through `@opscrew/connector-github` (`dispatchWorkflow`, `waitForWorkflowRun`,
  `runAttemptJobs`, all existing).
- **Storage**:
  - **committed:** `target.home` in `opscrew/plan.yaml`, the outside-check workflow, and
    `dns-updater` in `opscrew/credentials.yaml`;
  - **local, in `.opscrew/server.json` → `own.home`:** the answers, the LAN facts, the
    classification and the last outside check. No public address;
  - **on the server:** `/etc/opscrew/dns-updater/`, the template units, and the state in
    `/var/lib/opscrew-dns-updater/<app>/`.
  No home address goes into a TF variable, state, saved plan, repository file or the recovery copy.
- **Testing**:
  - Vitest with the existing fakes: the scripted remote, the Cloudflare fake, the GitHub fake and
    the engine fake;
  - script fixtures for `ip`, the trace and checkip answers, `tracepath`, `vcgencmd`, the kernel
    log and `findmnt`;
  - two Docker-gated tests (`OPSCREW_DOCKER_TESTS=1`): the updater's script against a fake
    Cloudflare, and the IPv6 web filter's table;
  - the module change validated under both engines (`.tools/bin`);
  - the live pass on Hetzner (18.).
- **Target Platform**: Ubuntu 22.04/24.04/26.04 or Debian 12/13, amd64 or arm64 (a Raspberry Pi
  with the 64-bit OS), with systemd 249 or newer (`LoadCredential=` since 247).
- **Project Type**: the existing monorepo.
- **Performance Goals**: a new address is in DNS within 5 minutes (SC-2902): a run every 2 minutes,
  plus the 60 s TTL. 2 to 4 Cloudflare requests per run and app.
- **Constraints**:
  - no SSH from the internet;
  - no proxied home address in any output, log, audit entry, commit or report (FR-2915);
  - no change to the router.
- **Scale/Scope**: one home server, several apps on it, one updater instance and token per app.

## Constitution Check

- **I (gate):** every change is a plan that is checked, shown and approved before it applies.

  | Change | Adapter | Approval |
  |---|---|---|
  | On the server: the SSH firewall, the updater's files, token and timer, the IPv6 web filter, the packages they need | host adapter, the setup host plan | `host-apply`, by hash |
  | The app's A/AAAA records, kept current while the updater runs | the updater the host plan installed. The step names its bounds (the records, the families, "the server's own address only", the interval); the script keeps to them | that host plan's approval, under the amended clause (R14, O1). Each write is in the server's state and shown by `status` |
  | `www` CNAME, CAA | IaC engine | `iac-apply`, by hash |
  | The one moves-only plan (`a` → `a[0]`) for every app with DNS on Cloudflare | IaC engine | `iac-apply`, by hash; in the CHANGELOG |
  | Rules and origin TLS behind the proxy | Cloudflare shared-resources adapter, as today | `cloudflare-apply`, by hash |
  | Deleting the updater's records (destroy, leaving home, 028 abort) | Cloudflare connector (`deleteRecord`), through `home/records.ts` | `cloudflare-apply`, by the hash of a canonical plan of ids, types and names; `allowDestroy` and the app's name typed; re-read after the approval |
  | Leaving home: the updater (and the SSH table) removed first | host adapter, a dedicated host plan | `host-apply`, by hash |
  | The 028 finish: the updater gets B's zone and token | host adapter | `host-apply`, by hash |
  | `rotate dns-updater` | host adapter | `host-apply`, by hash |
  | The outside check's run | GitHub connector (`dispatchWorkflow`) | none: it probes a public hostname and changes nothing; the dispatch is audited as a provider call, and the workflow came through the deploy-setup pull request |

  No `--yes` approves a plan. Retarget to and from home is refused, so it changes nothing.
- **II (ownership):**
  - The updater is a readable script and two units, documented in the guide; deleting OpsCrew
    leaves it working.
  - The repository holds the plan's `home` key and the check workflow.
  - No OpsCrew service is involved: the outside vantage is the user's own GitHub Actions.
- **III (dual engine):** `ipv4_record` is a known boolean, so `count` never depends on an unknown
  value. The implicit move from `a` to `a[0]` is common to Terraform (1.1+) and OpenTofu, and both
  engines validate it in CI.
- **IV (secrets):**
  - The token comes from `OPSCREW_DNS_UPDATER_TOKEN`, registered with the redactor. It reaches the
    server on the host adapter's standard input and is written 0600 root.
  - The host plan holds only its SHA-256, and the undo record holds neither the token nor the hash.
    The script hands it to curl on standard input.
  - Home public addresses are re-detected each run and never persisted. A proxied app's are
    registered as redactor names.
  - The record-deletion plans hold no content.
  - The workflow gets the hostname and the health path, and prints status codes.
  - Every agents task has a leak test; the live pass scans everything (18.).
- **V (deterministic):** detection, classification, the updater and the check are fixed code. The
  MCP server's `opscrew_verify` runs the same verify.
- **VI (contracts):** `@opscrew/contracts` doesn't change. ADR 0033 records the feature, and
  constitution 1.12.0 the standing behaviour (R14).
- **VII (tests):** test-first with fakes; the two Docker-gated tests; the live pass; the founder's
  optional manual check.
- **VIII (adapters):** every mutation from OpsCrew goes through the host adapter, the IaC engine,
  the Cloudflare connector or the GitHub connector. The updater's calls come from a fixed script
  that OpsCrew renders and the host plan installs.
- **IX (plain language):** the forwards, the fixed LAN address, the IPv6 router rule, the ISP's
  terms, large media, what root on the server can do with the token, and a failed check's causes.
- **X (simplicity):** no new dependency. The one new firewall piece, the IPv6 filter, is in
  Complexity Tracking (O3).

## Project Structure

### Documentation (this feature)

```text
specs/029-home-hosting/
├── spec.md (the lead's), research.md (R1–R14), plan.md, data-model.md, quickstart.md
├── contracts/plan-schema.md, cli.md, dns-updater.md, outside-check-workflow.md
├── checklists/
└── tasks.md (the lead's)
docs/adr/0033-home-hosting.md                  # the lead's
.specify/memory/constitution.md                # 1.12.0, the lead's (R14)
docs/guide/home-hosting.md                     # FR-2916
```

### Source code (what changes)

```text
packages/plan-schema/src/home.ts                       # new: checkHome
packages/plan-schema/src/plan.ts                       # OwnTargetSchema.home
packages/connectors/ssh-host/src/home-network.ts       # new: detectHomeNetwork
packages/connectors/ssh-host/src/dns-updater.ts        # new: script, units, config, step scripts
packages/connectors/ssh-host/src/{types,plan,steps,inspect,facts,parse,web-filter}.ts
packages/connectors/cloudflare/src/client.ts           # verifyToken's id (+ the fake)
packages/iac-templates/modules/cloudflare-dns/         # ipv4_record
packages/iac-templates/src/infra/{own,index}.ts        # the home root; adoptingImports a[0]
packages/iac-templates/src/tunnel/index.ts             # homeMode, homeIpv6Proxied
packages/iac-templates/src/edge/index.ts               # both families (proxied, no IPv4)
packages/iac-templates/src/workflow/index.ts           # healthScript's --resolve at home
packages/iac-templates/src/workflow/outside-check.ts   # new
packages/iac-templates/src/check/index.ts              # checkDiskVia at home
packages/iac-templates/src/runbook/own.ts              # the home section
packages/agents/src/home/                              # new, no index.ts: network, forwards, token,
                                                       #   records, outside-check, texts
packages/agents/src/shared/{server-record,host-plan}.ts
packages/agents/src/{interview,design,provision,check,verify,status,secure,drift,rotate,init,destroy}/…
packages/agents/src/{retarget,cloudflare-move}/…
packages/cli/src/…, packages/cli/test/e2e/home.test.ts
packages/mcp-server/src/tools/…, plugin/skills/opscrew-deploy/
packages/cli/test/live/home.test.ts, home-support.ts
```

**Structure decision**: the home logic shared by several commands lives in `agents/src/home/`,
one file per concern, with no `index.ts`: callers import the file, so parallel tasks never share
one. The server-side pieces sit in ssh-host beside the web filter and the SSH firewall, which are
of the same kind.

## Design

### 1. The plan and the interview (T2902, T2911)

- **`target.home: { ipv4: boolean }`** (contracts/plan-schema.md) is refused:
  - with `access: tunnel`;
  - in a preview environment's plan;
  - with `environment.runner: github` (US6 cut);
  - with `servers` or `network` in the plan;
  - without `dns.domain`.
  Unchanged rules apply as they are: `runner: local` only on localhost, `httpAllowedFrom:
  cloudflare` behind the proxy. `ipv4: false` is accepted both proxied and DNS-only: the plan
  saying it is the user's choice (R1).
- **The answers** (`interview/own-server.ts`, `SERVER_FIELDS`), stored in `.opscrew/server.json` →
  `own.home` (`shared/server-record.ts`):
  - `server.home`: confirm, right after `server.host`. The default is yes when `suggestReachable`
    returns false;
  - `server.sshFrom`: answers file only, up to 32 sources. The default is design's LAN network plus
    `fe80::/10`. It's required when the public IPv4 is on the server's own interface.
  With `server.home yes`, `server.reachable` isn't asked, and an answers file's value is refused.
  `server.serve` offers `proxy` (the default with a Cloudflare domain), `dns-only` (the only choice
  without one) and `tunnel`, labelled for home. The help of `server.home` gives the ISP's terms and
  the large-media note (FR-2914). The provider choice's hint adds "also a computer at home".
- **The interview's existing domain check** (`deepDomainProblem`, agents `shared`) applies
  unchanged.

### 2. Reading the home's network (T2903, T2910a)

- **`detectHomeNetwork(remote)`** (ssh-host `home-network.ts`), exposed on the host adapter
  (`HostAdapterApi.detectHomeNetwork` in `shared/host-plan.ts`; `boundHostAdapter` binds it),
  returns a zod-checked `HomeNetwork` (data model 3). Both IPv4 sources are asked every time.
- **The classification** (agents `home/network.ts`, pure; research R3):
  - IPv4 is `seen`, `none` (no IPv4 route) or `unknown` (IPv4 routes, no source answered);
  - `noNat` and the IPv6 state;
  - an optional `warning`: `cgnat-hop`, `private-hop` or `cgnat-interface`.
- **Who calls it:** design, provision before any change, and verify. Nothing public is persisted:
  `own.home.network` keeps only the LAN facts, the classification and its time. A proxied app's
  detected addresses are registered with the redactor as names (label "your home's address") for
  the run.

### 3. Design for a home server (T2912)

After connecting and inspecting, design runs the detection, then calls
`requireNoSharedPreviews(paths, "serving it at home", again, true)` (M5). It decides:

| IPv4 | IPv6 | Serve | Result |
|---|---|---|---|
| seen | any | any | `home.ipv4: true`. With a warning, design says the connection looks like it has no public IPv4 address, and offers the tunnel (`server.serve tunnel`) and, with IPv6, IPv6 behind the proxy (`target.home.ipv4: false` in plan.yaml); the outside check decides |
| none | yes | proxy | `home.ipv4: false`; served over IPv6 behind the proxy; says so, with the tunnel as the alternative |
| none | yes | dns-only | stops, unless the plan already says `home.ipv4: false` (the user's acceptance): visitors without IPv6 couldn't reach the site; recommends `proxy` or `tunnel` |
| none | no | any | stops: use the tunnel |
| unknown | any | any | stops: the server couldn't see its public address; check its outbound HTTPS |
| — | — | tunnel | today's tunnel mode, no `home` |

- **A user's `home.ipv4: false`** in the plan is kept by a later design.
- **`noNat` without `server.sshFrom`** stops: "your server has the public address itself, so name
  the networks that may reach SSH in `server.sshFrom`".
- **What design writes:**
  - `target.access: public` and `target.home`;
  - `dns.proxied` from the serve answer, with `httpAllowedFrom: cloudflare` when proxied;
  - `environment.runner: server` unless the plan says `host`.
- **The summary says:**
  - that it found a public address, never printing a proxied app's (DNS-only: the address);
  - **the forwards** (`home/forwards.ts`, FR-2902): "forward TCP 80 and TCP 443 to 192.168.1.30;
    reserve 192.168.1.30 for it in the router's DHCP settings; don't forward SSH". With `noNat`,
    no forwards are needed;
  - whenever an AAAA is published, "allow inbound TCP 80 and 443 to this server in your router's
    IPv6 firewall" (M12);
  - the ISP's terms and the large-media note;
  - with DNS on Cloudflare, the updater token's recipe, and what root on the server can do with
    the token (R6, R14); with DNS elsewhere, that only a fixed address keeps working (FR-2908);
  - the Raspberry Pi warning (12.).

### 4. The records: who writes them (T2907)

The updater owns a home app's A and AAAA records at `dns.domain` when the DNS is on Cloudflare
(research R2). The root keeps the rest.

- **`cloudflare-dns` module:** a boolean `ipv4_record` (default `true`) beside `ipv6_record`. The
  A record gets `count = var.ipv4_record ? 1 : 0`, and `ipv4` gets `default = null`. No `moved`
  block: both engines move `a` to `a[0]` by themselves.
  - **M2:** `adoptingImports` (`infra/index.ts`) imports to `module.dns.cloudflare_dns_record.a[0]`.
    The tests that name `cloudflare_dns_record.a` as a rendered address (in iac-templates and
    agents, found with `grep -rln 'cloudflare_dns_record\.a\b'`) say `a[0]`.
  - Every app with DNS on Cloudflare gets one moves-only plan to approve at its next provision.
    The release's CHANGELOG says so (T2923).
- **The home root** (`infra/own.ts`, `homeMode(plan)`):
  - it passes `ipv4_record = false` and `ipv6_record = false`, and declares no address variables;
  - it outputs `address_updater = true` only with an updater (DNS on Cloudflare), with no
    `server_ipv4`, `server_ipv6` or `servers` outputs;
  - `ownEngineEnv` sets no address for it. The readers of those outputs (`addressFromOutputs`,
    `removeOldAccessMode`) fall back to the local record, as in tunnel mode.
- **The `www` CNAME and the CAA records** stay in the root.
- **`dns.provider: none`:** no Cloudflare resources and no updater; the user adds the records.

### 5. The address updater (T2904)

contracts/dns-updater.md has every file, field and call. In short:

- **Files:** the shared script and template units; `/etc/opscrew/dns-updater/<app>.json` and
  `.token` (0600 root, in a 0700 folder); the state in `/var/lib/opscrew-dns-updater/<app>/`.
- **The service:** oneshot, `DynamicUser=yes`, `LoadCredential=config:` and `token:`, sandboxed.
- **The timer:** every 2 minutes.
- **A run:** detects; reads the name's records; PATCHes or POSTs its own records; DELETEs its AAAA
  only when IPv6 is positively gone. It touches no record without its comment, and a foreign record
  or a CNAME at the name is an error. Errors retry on the next run. The token goes to curl on
  standard input, and no address goes to the journal.
- **The `dns-updater` step** (`HOST_STEP_IDS`, after `app-record`; app scope, writing the shared
  files when they're missing or older):
  - params: `app`, `zoneId`, `name`, `proxied`, `ipv4`, `ipv6`, `tokenSha256` (when given),
    `version`, `packages`;
  - its secret, `ApplySecrets.dnsUpdaterToken`, arrives on standard input;
  - its verify waits for a successful run;
  - its teardown removes the instance, and the shared files with the last one.
  The record in `/etc/opscrew/host.json` keeps no token or hash.
- **`drift/host.ts`'s `AREA_TITLES`** (a `Record<HostStepId, string>`) gains `dns-updater` in the
  same task, so agents still typechecks (M1).
- **The app record** (`/etc/opscrew/apps/<app>.json`) gains `home: { ipv4 }`. Before any change,
  OpsCrew refuses a home app beside a non-home app, and home apps with different `home.ipv4`
  (M4), as mixed access modes are refused. The edge, the web filter and the SSH table are shared.

### 6. The updater's token (T2909, T2910b, T2913a, T2915a, T2916b)

- **The user makes it** (research R6): Zone → DNS → Edit, Include → Specific zone. It's read from
  `OPSCREW_DNS_UPDATER_TOKEN`; `opscrew init`, design's summary and the guide give the recipe.
- **The checks** (`home/token.ts`, before any change):
  - it's set;
  - it isn't `CLOUDFLARE_API_TOKEN`'s value or the same token (`verifyToken` returns the `id` from
    now on: T2909);
  - it's active;
  - `zonePermissions(zoneId, ["dns"])` passes;
  - the inverse probes: `zonePermissions` for the zone's other needs and `accountPermissions` for
    the account's must all come back missing, or the token is refused as wider than the zone's
    DNS.
  Each failure names the recipe, and nothing changes.
- **On the server only.** The host plan holds its SHA-256. Without the variable, a later plan keeps
  the server's file, and a missing file blocks the step.
- **rotate:** `dns-updater` joins the user's tokens (`rotate/inventory.ts` `USER_TOKENS`,
  `rotate/record.ts` `OTHER_TOKEN_NAMES`, `rotate/tokens.ts`), per environment. Its copy, the
  server's file, is replaced through the host plan, approved by its hash. The output names
  https://dash.cloudflare.com/profile/api-tokens.
- **status and verify:** `token-refused` says "make a new token as the guide says, set
  `OPSCREW_DNS_UPDATER_TOKEN`, and run `opscrew rotate dns-updater`".
- **What it can reach, said plainly** (design's summary, the host plan's step text, the guide):
  "The updater changes only this app's A/AAAA records, but the token can change any record in
  example.com. Anything with root on your server can use it, the deploy runner included: it runs
  your repository's code in the docker group, which is as good as root."

### 7. SSH only from the home network (T2905)

- `planHost` adds the existing `sshFirewallStep` (today in `planRunnerHost`) when the desired host
  has `sshFrom`. `DesiredHostSchema` gains `sshFrom` and `home: { ipv4 }`. The step is unchanged:
  the table `inet opscrew`, the revert timer and the address guard.
- A home server's step installs `nftables` instead of blocking on a missing `nft`.
- Shared: a table that's in place stays while other home apps are there. `planUndo` already
  removes it.
- The sources stay local: `own.home.sshFrom`, and the saved host plans in `.opscrew/plans/`.
- ufw keeps its SSH and web rules. With the router forwarding only 80 and 443, SC-2904 holds, and
  the table makes it hold even when a router forwards SSH by mistake (H4 in the live pass).

### 8. Serving over IPv4 or IPv6, proxied or DNS only (T2906, T2907)

| Mode | Updater keeps | Edge ports | Filter |
|---|---|---|---|
| DNS only, `home.ipv4: true` | A, and AAAA while there is IPv6 | both families (today) | ufw |
| DNS only, `home.ipv4: false` | AAAA | both families | ufw |
| proxied, `home.ipv4: true` | A | `0.0.0.0:` only (today) | IPv4 in `DOCKER-USER` (today) |
| proxied, `home.ipv4: false` | AAAA | both families | IPv4 (today) and IPv6 in `inet opscrew-web` |

- **The IPv6 web filter** (`web-filter.ts`, `webFilterStep`):
  - `DesiredHost.webFilter` gains `ipv6`. `ownWebSources` (`provision/own.ts`) returns Cloudflare's
    IPv6 ranges too; today it keeps only the IPv4 ones.
  - `webFilterScript` also loads `inet opscrew-web`, with two base chains whose policy is accept.
  - `input` lets `ip6 saddr` in the ranges reach TCP 80, TCP 443 and UDP 443, and drops other IPv6
    packets to those ports, except on `lo`. That covers docker-proxy's path.
  - `forward` does the same for `ct status dnat` connections whose `ct original proto-dst` is 80
    or 443. That covers an edge network Docker gives IPv6 (M11).
  - The unit Docker requires loads it, so it fails closed.
- **The edge:** `edgePorts` drops the `0.0.0.0:` prefix for `homeIpv6Proxied(plan)`. The trusted
  Cloudflare ranges already hold IPv6 (`siteContext`), so they don't change.
- **The router's IPv6 firewall** is named whenever an AAAA is published (3., M12).

### 9. Deploys and the scheduled check (T2907, T2913a)

- **The runners:** `runner: server` is design's default; `runner: host` is a LAN runner machine;
  `github` is refused at home (US6 cut).
- **`ownDeployTarget`** (`provision/own.ts`) gets a home branch (H7):
  - `server` gives no deploy target (`deploysInPlace` writes no address);
  - `host` gives `connection.host`, the LAN address, with its pinned key;
  - GitHub never holds a home address.
- **The scheduled check:** `checkReachesOverSsh` (`check/provision.ts`) is false at home, and
  `checkDiskVia` (`check/index.ts`) returns `undefined` at home after the in-place case, as in
  tunnel mode.
- **The deploy's health check** (`healthScript`, `workflow/index.ts`; H3), for a DNS-only home app:
  - curl gets `--resolve <domain>:443:127.0.0.1 --resolve <domain>:80:127.0.0.1` on the server's
    runner;
  - on a runner machine it gets `--resolve <domain>:443:$HOST`, where `$HOST` is the existing
    deploy secret holding the LAN address.
  This mirrors the local runner's `--resolve`, so hairpin NAT can't fail a deploy. Behind the proxy
  the check is unchanged: it goes out to Cloudflare, which comes back in from outside.

### 10. Provision, step by step (T2913a, T2913b)

1. **Before any change, read-only:**
   - the detection (2.). A plan with `home.ipv4: true` whose server now has no IPv4 stops ("run
     `opscrew design` again"), and a warning is repeated;
   - with DNS on Cloudflare, the token checks (6.);
   - the mixing refusals (5.);
   - `requireNoSharedPreviews`;
   - for `homeIpv6Proxied`, Cloudflare's IPv6 ranges are read, or nothing changes.
   `run.address` isn't set (no address variables).
2. **A mode switch's first steps** (14.).
3. **The Cloudflare plan:** rules and origin TLS, unchanged.
4. **The infrastructure plan:** `www` and CAA. From public mode it also deletes `a[0]`/`aaaa[0]`.
5. **The host plan:** today's steps, plus `ssh-firewall`, `web-filter` with IPv6 for
   `homeIpv6Proxied`, and `dns-updater` (with DNS on Cloudflare, the token on standard input). Its
   apply ends with the updater's first successful run, which creates or updates the records.
6. **Deploy secrets and the pull request:** the deploy secrets (no address with `server`; the LAN
   address with `host`). The pull request brings the deploy workflow and
   `.github/workflows/opscrew-outside-check.yml`. Its body says what the check does and the forwards
   to set (M10).
7. **The output:**
   - the forwards, with "set them before you merge: the first deploy fetches its certificate through
     them" (DNS-only), or "so Cloudflare reaches your server" (proxied);
   - the IPv6 router rule when it applies;
   - "merge, then run `npx opscrew verify`, which checks from outside your home".

### 11. The outside check (T2908, T2910d, T2914a)

- **The workflow** (contracts/outside-check-workflow.md, iac-templates `workflow/outside-check.ts`,
  `OUTSIDE_CHECK_WORKFLOW_FILE = "opscrew-outside-check.yml"`):
  - one file per repository;
  - `workflow_dispatch` with the inputs `host`, `path` and `mode`, validated in the job and used
    only through `env:`;
  - the jobs `http` and `https` on `ubuntu-24.04`, with `permissions: {}`;
  - `https` requests `https://$HOST$PATH?opscrew-outside-check=$GITHUB_RUN_ID`, and `http` requests
    `http://$HOST/`;
  - each fails on 000, on 520 to 527 or 530, or on a `cf-mitigated` header;
  - the log holds each try's code and curl's exit code (`-s`, no `-S`), plus the step's env and
    GitHub's own lines (M9).
- **The run** (agents `home/outside-check.ts`):
  1. `dispatchWorkflow` (audited `dispatch workflow`: the hostname, path and mode);
  2. `waitForWorkflowRun` (10 minutes);
  3. `runAttemptJobs(runId, 1)`;
  4. the result goes into `own.home.outsideCheck`.
  - `success` → ok, `failure` → failed, `cancelled` or `timed_out` → "the check didn't finish: run
    `opscrew verify` again".
  - A 404 or 422 from dispatch says to merge the deploy-setup pull request first.
- **When:** every `verify` of a home app whose domain has a record, at home or away.
- **On failure:** which port; the forwards; the fixed LAN address; the possible causes ("not
  forwarded, blocked by your provider, or no public IPv4 address; OpsCrew can't tell which"); and
  the tunnel. Nothing changes.
  - Behind the proxy, the `http` result reads "Cloudflare answered on port 80". It proves the
    forward on 80 only when the zone sends plain-HTTP requests to the origin.
- **Never from inside:** a request from this computer never counts as the check (FR-2903).

### 12. The Raspberry Pi (T2903, T2912, T2914a, T2914b)

- **Inspection** gains `board`, `storage` (the devices of `/srv` or `/` and of Docker's root, with
  the mmc `type`) and `power` (`vcgencmd`, else the boot's kernel log; research R10).
- **Design** warns when the board is a Raspberry Pi, a device is an SD card (or an unknown mmc),
  and the app has an enabled database service or storage on the server. It recommends a USB or NVMe
  SSD and never refuses.
- **verify and secure** report under-voltage: a failure when it's happening now, a warning when
  it happened since boot. They name the supply.

### 13. status, verify and secure (T2914a, T2914b)

- **`opscrew status`** (`status/run.ts`, `status/servers.ts`), for a home app:
  - the SSH sources;
  - the updater, from inspection's `dnsUpdaters`, this app's only: its last run, "sees" (addresses
    for DNS-only, "hidden: behind Cloudflare's proxy" for proxied), whether the records match, its
    last write and its last error with the next step;
  - the last outside check.
  Away from home (SSH doesn't answer), it says "your server answers SSH only on your home network",
  and shows the last outside check from the local record. SC-2905 is met over SSH (R11).
- **`opscrew verify`** adds:
  - `outside-check`;
  - `dns-updater`: a failure when the last success is older than 10 minutes or the records differ,
    a warning when an error happened since;
  - `pi-power`.
  For a DNS-only app, its own site request is a warning while the outside check passes, because
  hairpin NAT can fail a request from inside. With DNS elsewhere it resolves the hostname and
  compares it with the detected address. Away from home, the SSH checks are `skip` with that
  reason, and the outside check still runs.
- **`opscrew secure`** (`secure/own.ts`, `secure/probes.ts`):
  - this computer's probes read "from inside your network (not proof)", never as failures;
  - added server-side checks: the SSH table and its sources; the web filter's families; the token
    file (root, 0600); the timer; `pi-power`.
- **`opscrew drift`** (`drift/host.ts`, T2914c, M10) reports the `dns-updater` step and the IPv6
  filter like the other steps: a changed config, unit, token file mode or table.
- **The runbook** (`runbook/own.ts`, T2914d, M10) gains a home section: the forwards, the updater
  and its token's reach, SSH from the home network, the outside check, and console recovery.
- **The MCP server** passes the same data through the redactor.

### 14. destroy, mode switches and retarget (T2913b, T2915b, T2916a)

- **Deleting the updater's records** (`home/records.ts`, H5; research R12):
  1. A plan of the zone id and the records' ids, types and names (never content), canonical JSON
     hashed with SHA-256.
  2. A `cloudflare-apply` approval with `allowDestroy` and the app's name typed (`--approve <hash>
     --confirm <app>` in a script).
  3. The records are read again after the approval. Nothing is deleted when the hash changed.
- **destroy** (`destroy/own.ts`):
  1. The teardown host plan removes the app's updater instance, config, token and state, and the
     shared files with the last instance.
  2. The records are deleted as above.
  3. With the repository's last home app, destroy's pull request removes the check workflow.
  4. `--undo-host` also removes the IPv6 filter. The SSH table already goes.
  5. The output names the token page.
- **Mode switches on one server** (H4; `removeOldAccessMode` reads home as its own mode from
  `address_updater`):
  - **public → home:** no removal. The infrastructure plan deletes `a[0]`/`aaaa[0]`, then the host
    plan's updater writes its own records.
  - **tunnel → home:** today's removal, then as above.
  - **home → public or tunnel:** first a dedicated host plan, approved by its hash, removes the
    app's updater, and the SSH table when it's the server's last home app. Then the records are
    deleted (H5), and for tunnel the home root's `www` goes in `removeOldAccessMode`'s removal.
    Then the new mode's setup.
  The app is unreachable between the steps, as in today's switch.
- **retarget** (`retarget/start.ts`): from a home server and to one are both refused before any
  change: "retarget can't move an app to or from a server at home yet: destroy it there and
  provision the other target, or add an environment".

### 15. A move to another Cloudflare account (028) (T2916b)

- **`opscrewNamesInZone`** (`cloudflare-move/checks.ts`) also counts the updater's comment, so
  `otherAppHostnames` and the switch's coverage see a home app's names (M8).
- **The zone plan** still copies those records, since no shadow root makes them, with their content
  masked. The switch refreshes them from A (`zone.ts`).
- **The finish** asks for B's updater token: `OPSCREW_NEW_DNS_UPDATER_TOKEN`, else once in a
  terminal, hidden, never kept. It checks the token as in 6., then a host plan approved by its hash
  gives the updater B's zone id and token. Until then the updater writes to A's moved zone, which
  serves nothing.
- **abort** deletes the copied records from B through `home/records.ts` (H5) when B's zone stays.

### 16. What is reused and what is new, by package

| Package | Reused | New |
|---|---|---|
| contracts | everything | none |
| plan-schema | `OwnTargetSchema`, the existing refusals | `target.home`, `checkHome` |
| connector-ssh-host | the `ssh-firewall` step, the web filter, the host plan, the dead-man switch, inspection, `isPublicAddress`, `canonicalSshSource` | `detectHomeNetwork`, the `dns-updater` step and files, `DesiredHost.sshFrom`/`home`/`dnsUpdater`, `webFilter.ipv6` and `inet opscrew-web`, the app record's `home`, inspection's `board`/`storage`/`power`/`dnsUpdaters` |
| connector-cloudflare | `listDnsRecords`, `deleteRecord`, `zonePermissions`, `accountPermissions`, `getIpRanges`, the fake | `verifyToken`'s `id` |
| connector-github | dispatch, wait, jobs, the fake | none |
| iac-templates | the edge renderers, `siteContext`'s ranges, `healthScript`'s `--resolve`, the workflow writer | `ipv4_record`, the home root, `adoptingImports`' `a[0]`, `homeMode`/`homeIpv6Proxied`, edge ports, `checkDiskVia` at home, `outside-check.ts`, the runbook's home section |
| agents | `prepareOwnServer`, `desiredHost`, `ownWebSources`, `removeOldAccessMode`, user-token rotation, destroy's teardown, 028's `zoneDeletion` pattern | `home/` and each command's home branch |
| cli, mcp-server, plugin | answers, status and verify output | the new answers and lines, the deploy skill's home section |
| docs | the own-server, runners, credential-rotation, cloudflare-move and origin-protection pages | `home-hosting.md`, ADR 0033, constitution 1.12.0 |

### 17. Risks

- **The address sources** (O5): the trace's `ip=` field is undocumented, and checkip is AWS's. The
  agreement rule and "keep the last address" bound the damage; H0 and H1 confirm them.
- **Hop false positives** only warn.
- **Let's Encrypt in DNS-only mode:** without the forwards at the first deploy, failed validations
  count against Let's Encrypt's limit. Provision says to set them before merging.
- **Cloudflare's rate limit** is shared with the user's other use: a 429 retries.
- **Docker's IPv6 paths:** both are covered by the filter's two chains. The Docker-gated test and
  H6 check them.
- **The moves-only plan:** every app with DNS on Cloudflare gets one extra approval at its next
  provision. The CHANGELOG says so.
- **Root on the server can use the token** for the whole zone. It's said plainly (R14), and the
  recipe limits the token to one zone's DNS.
- **A renumbered home network locks SSH out:** the guide has the console recovery.
- **Hetzner isn't a home line:** the rest is the founder's optional check (18.).

### 18. The live pass (T2919, T2920)

**The stand-ins:**
- the "home" server is a Hetzner Arm server (the cheapest `cax` type);
- the "router" is a Hetzner Cloud firewall on it: TCP 80 and 443 from anywhere, SSH from this
  computer only;
- a new address is the A record set by hand to `192.0.2.<n>`;
- a second throwaway server is the outside scanner.

`server.sshFrom` is this computer's address /32. The file is
`packages/cli/test/live/home.test.ts`, gated on `OPSCREW_E2E_HOME=1`, and each leg runs on its own
with `-t`. quickstart.md has the steps and variables.

- **H0 preflight:** the tokens (the updater token's checks, inverse probes included), the zone, and
  no leftover records.
- **H1 proxied over IPv4:** interview, design, adapt, provision, the merges, the first deploy on the
  server's runner, and `verify` (the outside check and the updater). The minutes are recorded
  (SC-2901).
- **H2 address change, proxied:** the A record set to `192.0.2.<n>`; the time until the updater
  writes it back and the site answers through Cloudflare (SC-2902), and how soon Cloudflare's edge
  uses the restored origin (O10). `status` shows no address (SC-2905).
- **H3 a port not answering:** 443 removed from the firewall. `verify` names 443 and offers the
  tunnel, and the hashes of the host plan and the states don't change. 443 back: it passes.
- **H4 DNS only:** the switch from proxied (the app's name typed); 60 s TTL records; a Let's
  Encrypt certificate; the deploy's health check through `--resolve`; the outside check. Then the
  firewall lets SSH in from anywhere, as a router forwarding it by mistake would. The scanner, over
  IPv4 and IPv6, finds 80 and 443 open and 22 closed by OpsCrew's table, while this computer still
  logs in (SC-2904, FR-2909). Then the address change again (SC-2902).
- **H5 IPv6 records:** the server's IPv6 address removed, then the AAAA goes; the address back, then
  the AAAA comes back.
- **H6 IPv6 behind the proxy:** `target.home.ipv4: false` set in plan.yaml, then design and
  provision. AAAA only, the IPv6 filter on. The site answers through Cloudflare to GitHub's runner
  and this computer (O9), and the scanner over IPv6 sees 443 filtered.
- **H7 rotate, switch out, destroy, leaks:** `rotate dns-updater` with the second token. The switch
  home → tunnel: the dedicated host plan, the records deletion, the tunnel serving. `destroy` and
  `destroy --undo-host`. Then the leak scan over every output, commit, pull request, audit entry,
  saved plan, state file, `server.json` and the check's run logs: no token, and no address of the
  proxied legs (SC-2906). Servers and firewall deleted, leftovers listed.

**The founder's optional manual check on a real home line** (not part of the gate):
- a real router: forwards, a DHCP reservation, the IPv6 rule;
- hairpin NAT: `verify`'s own request, and a DNS-only deploy's health check, against the outside
  check;
- a carrier-NAT or double-NAT line: the warning;
- a real address change;
- IPv6 privacy addresses and a prefix change;
- a Raspberry Pi: the SD warning, and under-voltage from a weak supply;
- an ISP that blocks 80 or 443;
- a renumbered network and the console recovery.

**Cost:** two Hetzner servers for a few hours (cents). The firewall, the zone on Cloudflare's free
plan and the tokens cost nothing, plus a few Actions minutes.

- **H8 the release's two additions,** on the H1 server with an app that has PostgreSQL: a snapshot,
  `opscrew restore --drill` (the plan approved by hash; the parts restored, healthy, removed;
  production's containers and volumes unchanged; a request to the internet from the copy fails);
  `opscrew status` shows the drill; then a session holding a lock another waits for and an open
  transaction, and `opscrew advise` names both within 20 seconds and changes nothing.

### 19. Restore drills (T2931, T2933; research R15–R19)

- **Where and what approves it** (R15): on the server that holds the snapshot, as a throwaway
  Compose project `<app>-drill` in `.drill/<snapshot id>/` of the app's folder. Never the preview
  server and never under the preview standing approval (constitution I: a standing approval reaches
  no other environment's data). Its own host plan, run by `opscrew restore --drill` at a terminal,
  approved by its hash with `allowDestroy` and `<app>-drill` typed, since it removes the copy's own
  volumes. The approval reuses 024's one-time-file kind (`approveRestore`, `restoreHash` in
  `snapshot/restore-checks.ts`) with a drill hash over the environment, the snapshot's id and
  `about.json` bytes, and the drill's settings. No new approval kind.
- **What it reuses:** 024's `snapshot.sh` part restores (`iac-templates/src/workflow/snapshots.ts`),
  pointed at the drill project's own volumes, the snapshot read in place (read-only); 022's recipe
  rendering (`iac-templates/src/previews`) for the services, limits and the app's pinned image
  digest; the free-disk guard (`snapshot/disk.ts`) with the snapshot's size added; the app's
  Compose healthcheck (`runtime/healthcheck.ts`).
- **Isolation** (R16): the drill's network is `internal: true`; its env is the drill's own
  generated service values plus the app's plain settings, with `.env`'s values left out and
  `.env.preview`'s used when there is one; only the app and the snapshot's services start, no
  workers or cron. The approval says once: "The copy runs with no internet and without your
  production `.env`. The app may need some values to start; add them to `.env.preview` with test
  values."
- **No outside reach** (R17): no hostname, record, proxy site or published port. The check is the
  container's own healthcheck read with `docker inspect` until `healthy` or 5 minutes; with probe
  `none`, the container still running after 60 seconds. Then each SQL service answers `pg_isready`
  (or its kind's) and holds at least one table or key.
- **Targets** (founder, 2026-11-18: every target with snapshots; R24–R27):
  - servers OpsCrew created and a server the user owns, home included: as above;
  - this computer: the same project through the local executor; a gone image offers
    `--allow-other-version` as `restore` does (R26);
  - a Portainer: a second stack `opscrew-<app>-drill` from the same render, created from a string
    (the connector's one new call), the snapshots volume external and read-only, approved as a
    stack plan by its hash with `allowDestroy` and the typed name; the network read back as
    internal after deploy, or the stack removed at once (R24);
  - a hosting account (cPanel, Plesk, DirectAdmin): the dump imported into a standing drill
    database (made by the hosting plan at provision through `addDatabase`, counted against the
    plan's limit and said so, removed at destroy or when drills are turned off), its tables
    counted against the dump's, then emptied; a hash-bound `drill` request to the agent; the app
    isn't started (R25);
  - SFTP-only hosts, Cloudflare's hosting, GitHub Pages: no snapshots, refused with the reason.
  R27's table is what the report says each proves.
- **The schedule** (founder, 2026-11-18: built now; R28, R29; constitution 1.12.0's clause for a
  program a plan installs): `opscrew snapshot drill schedule on|off`, `--every weekly` (default)
  or `daily`, a plan setting beside the snapshot schedule, which it needs; `opscrew provision`
  installs it:
  - servers: a tagged line in the deploy user's crontab, `snapshot.sh drill scheduled`, three hours
    after the snapshot's slot, logging to `.snapshots/drills.log`;
  - a Portainer: one loop service per database part (PostgreSQL, MySQL, MariaDB, MongoDB) from the
    part's image, `network_mode: none`, the snapshots volume read-only and a scratch volume,
    restoring the latest dump into a scratch server of its own and counting its tables; the dumps
    proven, not the app; a kind whose image can't run so is left out with a line saying so;
  - a hosting account: the agent's own schedule, into the drill database, no panel call;
  - this computer: none (it isn't always on).
  The bounds (R29), enforced by the target's script: only its own names (built from the app's name
  and the fixed word `drill`, the snapshot id checked); only the latest snapshot; no outbound
  network, no port, `.env` never read; it removes what it made and a crashed run's leftovers; the
  app folder's lock (held: "skipped"); disk and memory checked (short: "skipped"); 30 minutes at
  most. Each run recorded on the target; `opscrew status` shows the last. On servers the scheduled
  check (017) reads the last drill with the last snapshot: a failed drill, or none within twice the
  schedule, opens its issue; a skip never does.
- **The command:** `opscrew restore --drill [<id>]` (latest by default; `--only` carries over),
  `--keep` leaves the copy's volumes for inspection, `opscrew restore --drill --remove` removes a
  kept copy. `--from offsite` is not offered for drills. One line per step; `--json` the same.
- **The report** (R18, R19): `.snapshots/drills.log` beside `scheduled.log`: the snapshot id and
  version, start and end, per part its size and seconds, the health result and seconds to healthy,
  the removal's result, the first lines of a failure redacted, no values. `opscrew status` shows
  the last drill. Three outcomes in plain words: the backup didn't restore (take a new snapshot
  now); restored but not healthy with no internet and no production values (add test values to
  `.env.preview`); restored and healthy. A failed removal is its own line with the command to run.

### 20. The database check in `advise` (T2932; research R20–R23)

- **The connection** (R20): `docker compose -p <app> exec -T <db service> psql -X -q -At` over the
  SSH shell advise already has (`serverShell`, `status/servers.ts`), one fixed SQL text per query on
  standard input, as the image's `app` login over the container's socket (as `planGrant` signs in).
  No role created, no password read. `pg_stat_activity.query` is never selected; a statement's text
  comes only from `pg_stat_statements`, normalized, cut at 120 characters and redacted. A database
  on another server (018) is read there. Portainer, this computer and hosting accounts: "not read",
  with the reason.
- **The bounds** (R21): `PGOPTIONS` with `statement_timeout=3000`, `lock_timeout=500`,
  `idle_in_transaction_session_timeout=5000`, `default_transaction_read_only=on`,
  `application_name=opscrew-advise`; a 20-second cap on the whole check; the first timeout stops it
  and is itself a finding. The six queries are R21's, fixed text with a test asserting only
  `SELECT`s. PostgreSQL 13 and later; below 13 the slow-query step is skipped with the reason.
- **Findings** (R22): R22's table of thresholds and texts, as advise's **Reliability** findings
  (`db.<app>.blocked` and the like) with `now`/`soon` urgency, each with its figures and "read once,
  at <time>". The thresholds go into `advise/types.ts`' `THRESHOLDS`.
- **Index proposals** (R23): from `pg_stat_user_tables` with R23's rule; the table and the top slow
  statement that mentions it, no column; never applied, never in `--apply`.
- **Tests:** fixtures of `psql -At` output for every query; a Docker-gated test
  (`OPSCREW_DOCKER_TESTS=1`) that runs the six queries on `postgres:14-alpine` and
  `postgres:17-alpine` with a planted lock wait and an open transaction.

## Requirements coverage

| FR | Where |
|---|---|
| 2901 the home's addresses from the server; CGNAT and private ranges reported | 1.–3. |
| 2902 the exact forwards, a fixed LAN address, no router change | 3., 10. |
| 2903 the outside check once the app serves; never an inside test; stop on what the server sees | 3., 10., 11. (Deviations) |
| 2904 proxied with origin protection, else DNS-only with a public certificate | 3., 8. |
| 2905 the updater through the host plan, write on change, every 2 minutes, 60 s TTL | 4., 5. |
| 2906 AAAA where it applies, at the stable address, removed when none | 5., 8. |
| 2907 the zone-limited token, root-only on the server, rotate, destroy's copy | 6., 14. |
| 2908 dynamic with Cloudflare DNS, fixed with any | 3., 4. |
| 2909 SSH only from the home network | 7. |
| 2910 the server's runner by default; no home address in GitHub | 9. (Access option cut: Deviations) |
| 2911 the tunnel or IPv6 behind the proxy without IPv4; DNS-only IPv6-only when accepted | 3., 8. |
| 2912 the updater's state in status and verify | 13. (masked: Deviations) |
| 2913 the SD warning; under-voltage | 12. |
| 2914 the ISP's terms and large media | 1., 3., T2918 |
| 2915 no token, key or proxied home address anywhere | Constitution IV, 2., 4., 14., 18. |
| 2916 the guide page | T2918 |
| 2917–2919, 2923 the restore drill: every target, its plan, isolation, report, the schedule | 19. |
| 2920–2922 the database check: what it reads, its bounds, index proposals | 20. |

## Order

Task ids are proposed for the lead's tasks.md. Each task is one implementer's. A wave's tasks
share no file. Dependencies point only to earlier waves.

1. **T2901 (lead):** ADR 0033; constitution 1.12.0 (R14, agreed by the founder); the empty
   `agents/src/home/` folder.
2. **Wave 1:**
   - **T2902** plan-schema: `target.home`, `checkHome` (`home.ts`), the JSON schema.
   - **T2903** ssh-host: `detectHomeNetwork` (`home-network.ts`); the inspection facts `board`,
     `storage`, `power` and `dnsUpdaters` (`inspect.ts`, `facts.ts`, `parse.ts`); exports in
     `index.ts`.
   - **T2909** connector-cloudflare: `verifyToken`'s `id`, the fake.
   - **T2911** agents: the interview answers (`interview/own-server.ts`) and `own.home`
     (`shared/server-record.ts`).
3. **Wave 2:**
   - **T2904** ssh-host: the `dns-updater` step (`dns-updater.ts`, `steps.ts`, `plan.ts`,
     `types.ts`, `HOST_STEP_IDS`), `ApplySecrets`, the Docker-gated script test. Also
     `agents/src/drift/host.ts`'s `AREA_TITLES` entry (M1). After T2903.
   - **T2907** iac-templates: `cloudflare-dns`'s `ipv4_record`, the home root, `adoptingImports`'
     `a[0]` and the tests naming `cloudflare_dns_record.a` (M2), `homeMode`/`homeIpv6Proxied`,
     `edgePorts`, `healthScript`'s home `--resolve` (H3), `checkDiskVia` at home (H7). Owns
     iac-templates `src/index.ts` in this wave. After T2902.
   - **T2910a** agents `home/network.ts`, `home/forwards.ts`, `home/texts.ts`, and
     `shared/host-plan.ts`'s `detectHomeNetwork`. After T2903 and T2911.
   - **T2910b** agents `home/token.ts`, the checks with the inverse probes. After T2909.
4. **Wave 3:**
   - **T2905** ssh-host: `ssh-firewall` in setup plans, installing `nftables`, `sshFrom`, the app
     record's `home`, the mixing refusals (M4). After T2904.
   - **T2908** iac-templates `workflow/outside-check.ts` and its export. After T2907.
   - **T2910c** agents `home/records.ts`, the hashed deletion plan (H5). After T2902.
   - **T2912** agents design: detection, the table, the warnings, `noNat` and `sshFrom`,
     `requireNoSharedPreviews`, the runner default, the Pi warning, the summary. After T2910a and
     T2902.
5. **Wave 4:**
   - **T2906** ssh-host: the IPv6 web filter (input and forward chains, M11), the Docker-gated
     table test. After T2905.
   - **T2910d** agents `home/outside-check.ts`: run and read back. After T2908.
   - **T2914d** iac-templates `runbook/own.ts`, the home section (M10). After T2908.
6. **Wave 5:**
   - **T2913a** agents provision: the checks before any change, `desiredHost` (`sshFrom`,
     `dnsUpdater`, `webFilter.ipv6`, `ownWebSources`' IPv6), `ownDeployTarget`'s home branch and
     `checkReachesOverSsh` (H7), no persisted address (M7). After T2904–T2907, T2910a and T2910b.
7. **Wave 6:**
   - **T2913b** agents provision: the mode switches (H4, `removeOldAccessMode`'s home mode), the
     check workflow in the pull request, and the pull request body's texts (M10). After T2913a,
     T2910c and T2908.
   - **T2914a** agents verify: the outside check, the updater, `pi-power`, hairpin and away from
     home. After T2910d and T2913a.
   - **T2914b** agents status and secure. After T2913a.
   - **T2915a** agents rotate (`dns-updater`) and init (the recipe). After T2913a.
8. **Wave 7:**
   - **T2914c** agents drift: the updater step and the IPv6 filter (M10). After T2906 and T2913b.
   - **T2915b** agents destroy: the teardown, the records deletion, the workflow's removal. After
     T2913b.
   - **T2916a** agents retarget: both refusals. After T2902.
   - **T2916b** agents cloudflare-move: `opscrewNamesInZone`, the copy and refresh, the finish's
     token and host plan, the abort's deletion (M8). After T2910b, T2910c and T2913a.
9. **Wave 8:**
   - **T2917** CLI, MCP server and plugin, with `packages/cli/test/e2e/home.test.ts`.
   - **T2918** the guide: `home-hosting.md` (the token's reach, hairpin, the ISP's terms, large
     media, console recovery); the own-server, runners, credential-rotation, cloudflare-move and
     origin-protection pages.
10. **Wave 9:** **T2919**, the live test files.
11. **Lead:** T2920, the live pass (H0–H7); T2921, simplify; T2922, CLAUDE.md and the roadmap;
    T2923, the release (CHANGELOG: the moves-only plan).

## Deviations from the spec (for the lead's alignment)

- **FR-2903:** the lead's new text says OpsCrew "stops" on a carrier-NAT hop. Simplification 4 makes
  the hop a warning (the outside check decides), and the plan follows it. Design stops only when the
  server has no IPv4 route and no IPv6, or can't see its address. Please align one of them.
- **FR-2910 and US6:** the Access-SSH option is cut (founder, 2026-11-15).
- **FR-2912:** a proxied app's seen and written addresses are shown as "hidden", with their times.
- **Retarget (an edge case):** both directions are refused in 029.
- **FR-2910 with `runner: host`:** the deploy secret holds the server's LAN address, a private one,
  as for any runner machine.

## If the founder keeps US6

Research R9 lists what it needs: H2 (an `iifname "lo" accept` rule in the SSH table, tested in
`ssh-firewall-docker.test.ts`); M3 (one `accessSshDeploy(plan)` predicate audited at every site that
keys on `tunnelMode` today, and `edgeServesTls`); and H7-github (a `github` branch in
`ownDeployTarget`, and the scheduled check over Access). Those would be a plan-schema change, an
ssh-host task, an iac-templates task and an agents task, plus a live leg.

## OPEN

- **O1:** constitution 1.12.0 (R14), agreed by the founder on 2026-11-15.
- **O2:** design never prints a proxied app's address (the spec is aligned).
- **O3:** the IPv6 filter. Recommendation: keep it (FR-2911); H6 proves it.
- **O4:** retarget to and from home, refused. A later feature can add both.
- **O5:** the address sources, confirmed in H0 and H1.
- **O7:** the Pi's facts, confirmed only by the founder's check.
- **O8:** GitHub's hosted runners and IPv6. If they have it, `direct` mode gains a third job,
  `https6`.
- **O9:** Cloudflare serving IPv4 visitors from an AAAA-only proxied origin, settled by H6. If it
  fails, O3 is cut.
- **O10:** how soon Cloudflare's edge uses a changed origin address, measured in H2.
- **O11:** restore drills and a read-only database check in `advise` ship in 029's release, as
  tasks of their own (founder, 2026-11-15). Written 2026-11-18: research R15–R23, US7, US8,
  FR-2917–FR-2923, plan 19. and 20., tasks T2931–T2938, ADR 0034. The founder decided on
  2026-11-18: scheduled drills now, and drills on every target with snapshots (research R24–R30);
  constitution 1.12.0's clause names the drill and the Portainer and hosting plans.

(O6, the token's narrowness through `GET /zones`, is gone: inverse probes replace it.)

## Complexity Tracking

| Choice | Why | Simpler rejected |
|---|---|---|
| The updater owns the home app's A/AAAA records, outside the root | One writer; no home address in TF; the AAAA can come and go | The root owns them: stale variables revert the updater, and the AAAA collides |
| The updater writes DNS unattended within bounds its host plan names (R14) | A dynamic address changes without the user | An approval per change |
| Template units with `DynamicUser` and `LoadCredential` | A root-only token used by an unprivileged process; one token per app | One root service for every app |
| Two IPv4 sources that must agree | In DNS-only mode a wrong answer hands out the domain and its certificate | One source |
| A hashed deletion plan for the updater's records | The root doesn't hold them, and a deletion must be bound to what was shown | Deleting them inside another approval |
| The IPv6 web filter with two chains | FR-2911 without IPv4; both of Docker's IPv6 paths | The tunnel only (O3); refusing IPv6 edge networks (a new inspection fact) |
