---
description: "Tasks for 029-home-hosting"
---

# Tasks: Hosting at home: your own IP address and dynamic DNS

**Status**: building since 2026-11-18 (the founder's go-ahead of 2026-11-17, with 0.2.10 staged).

**Input**: `specs/029-home-hosting/` (spec.md, plan.md, data-model.md, contracts/, quickstart.md,
research.md R1–R14, R15–R30 for the release's two additions) + features 011 (own server), 014 (origin
protection), 016 (runners), 022 (previews), 024 (snapshots), 021 (advise), 025 (rotation), 028
(the move); ADR 0011, 0026, 0033; constitution 1.12.0.

**Numbering**: T2901–T2999. Plan sections are written "plan N." (its Design sections), data-model
sections "data-model N".

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Decided by the lead /
Accept / Verify / Effort`. Implementers never edit `tasks.md`, specs, root configuration, a
`package.json`'s dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Approvals:** every change through the approval plan.md's Constitution Check (I) names for it.
  No `--yes` approves a plan. Deletions with `allowDestroy` and the typed app name.
- **Leaks:** no token (the updater's, Cloudflare's, GitHub's), key, or proxied home address in
  output, plans, `-var`s, TF state, logs, audit entries, `.opscrew/server.json`, saved plans, the
  host record, commits, pull request bodies or MCP answers (FR-2915). Public home addresses are
  re-detected each run and never persisted. Every agents task's tests include a leak check over
  everything its fakes saw, with a proxied app's detected address registered as a secret-shaped
  value.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to
  do next. User-facing text never names a feature or task number.
- **`agents/src/home/` has no `index.ts`:** callers import the file (`../home/network`), so
  parallel tasks never share one.
- **Text:** each task keeps the strings its files show in those files; T2921 gathers repeats.
- **No network in unit tests;** fakes for Cloudflare (`connectors/cloudflare/src/testing`), GitHub,
  the engine (or the real engines from `.tools/bin` where a test needs `init`, skipping without
  them), the scripted remote for servers. Docker-gated tests run only with `OPSCREW_DOCKER_TESTS=1`.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Examples:** neutral only: `example.com`, `example-app`, `192.168.1.30`, `203.0.113.0/24`,
  `2001:db8::/32`.

## Phase 1: Foundation (lead)

- [x] T2901 ADR 0033 and constitution 1.12.0 (lead)
  - Owns: `docs/adr/0033-home-hosting.md`, `.specify/memory/constitution.md`, `CLAUDE.md` (the
    standing approvals line)
  - Accept: ADR 0033 accepted; Principle I gains the bullet for a program a host plan installs
    (research R14); the version 1.12.0; CLAUDE.md names both standing approvals.
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [ ] T2902 [P] [US1] `target.home` in the plan
  - Owns: `packages/plan-schema/src/home.ts` (new), `packages/plan-schema/src/plan.ts`
    (`OwnTargetSchema.home`), `packages/plan-schema/src/index.ts`, `packages/plan-schema/schemas/**`,
    colocated tests
  - Reads: contracts/plan-schema.md; data-model 1; plan 1.; `checkRetarget` and the other refinements
    in `plan.ts` for their style
  - Depends: T2901
  - Accept:
    - `target.home: { ipv4: boolean }` (strict) on the own target, as contracts/plan-schema.md
      "Shape".
    - `checkHome(plan, ctx)` refuses each case of "Refusals" with its plain message: with
      `access: tunnel`; in a preview environment's plan; with `environment.runner: github`; with
      `servers` or `network`; without `dns.domain`. Unchanged rules stay as they are.
    - `ipv4: false` accepted both proxied and DNS-only.
    - The JSON schemas regenerated; every existing fixture parses as before.
  - Verify: `pnpm --filter @opscrew/plan-schema gen:schemas && pnpm turbo run typecheck --filter=@opscrew/plan-schema && npx vitest run --root packages/plan-schema && pnpm lint`
  - Effort: medium

- [ ] T2903 [P] [US1] [US3] [US5] Reading the home's network, and the board, storage and power facts
  - Owns: `packages/connectors/ssh-host/src/home-network.ts` (new),
    `packages/connectors/ssh-host/src/{inspect,facts,parse}.ts`,
    `packages/connectors/ssh-host/src/index.ts`, colocated tests and `__fixtures__`
  - Reads: data-model 3, 6 (the facts); research R3, R10, R11; plan 2., 12.; contracts/dns-updater.md
    "Read by inspection"; `isPublicAddress` and the existing inspection parsers
  - Depends: T2901
  - Accept:
    - `detectHomeNetwork(remote)` returns a zod-checked `HomeNetwork` (data-model 3): the LAN address
      and network (`ip -j`), the public IPv4 from both sources every time (Cloudflare's trace `ip=`
      and checkip) with the agreement rule of R3, the stable global IPv6 (no temporary or
      deprecated addresses), the first hops (`tracepath`, bounded). A read-only remote script, with
      a timeout per probe; a probe that fails gives its "unknown" value, never a throw.
    - Inspection gains `board`, `storage` (the devices of `/srv` or `/` and of Docker's root, with
      the mmc type, via `findmnt` and `/sys`), `power` (`vcgencmd get_throttled`, else the boot's
      kernel log) and `dnsUpdaters` (contracts/dns-updater.md "Read by inspection": each instance's
      config without the token, and its state file), all optional in the facts so older servers
      parse.
    - Fixtures for `ip`, the trace and checkip answers (agreeing, disagreeing, one missing),
      `tracepath` (a 100.64.0.0/10 hop, a private hop, none), `vcgencmd`, the kernel log, `findmnt`.
    - Exported from the package root.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: high

- [ ] T2909 [P] [US2] `verifyToken` returns the token's id
  - Owns: `packages/connectors/cloudflare/src/client.ts` (`verifyToken`), `packages/connectors/cloudflare/src/testing/**`, colocated tests
  - Reads: plan 6.; Cloudflare's `GET /user/tokens/verify` reference (official page only)
  - Depends: T2901
  - Accept: `verifyToken` answers `{ id, status }` as the API gives them (zod-checked); the fake gives
    each token its own id; every existing caller compiles and behaves as before.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-cloudflare --filter=@opscrew/agents && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: medium

- [ ] T2911 [P] [US1] The interview's home answers and the local record
  - Owns: `packages/agents/src/interview/own-server.ts`, `packages/agents/src/shared/server-record.ts`,
    colocated tests and snapshots
  - Reads: contracts/cli.md "Interview answers"; data-model 2; plan 1.; research R1; `suggestReachable`
  - Depends: T2901
  - Accept:
    - `server.home` (confirm, right after `server.host`; default yes when `suggestReachable` is
      false) and `server.sshFrom` (answers file only, up to 32 sources, each a canonical address or
      network) in `SERVER_FIELDS`.
    - With `server.home yes`, `server.reachable` isn't asked and an answers file's value is refused
      in plain words. `server.serve` offers `proxy` (default with a Cloudflare domain), `dns-only`
      (the only choice without one) and `tunnel`, labelled for home. `server.home`'s help gives the
      ISP's terms and the large-media note (FR-2914). The provider hint adds "also a computer at
      home".
    - `own.home` in `.opscrew/server.json` as data-model 2 (zod), with no public-address field:
      the answers, the LAN facts, the classification and its time, the last outside check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/interview src/shared && pnpm lint`
  - Effort: high

## Phase 3: Wave 2 (parallel)

- [ ] T2904 [P] [US2] The address updater: script, units and the `dns-updater` host step
  - Owns: `packages/connectors/ssh-host/src/dns-updater.ts` (new), `packages/connectors/ssh-host/src/{steps,types}.ts`,
    `packages/connectors/ssh-host/src/plan.ts` (only the step's registration and its params),
    `packages/connectors/ssh-host/src/index.ts`, `packages/connectors/ssh-host/src/apply.ts` (only the
    `SECRET_CHECKS` entry for `dnsUpdaterToken`), `packages/connectors/ssh-host/src/{inspect,parse,facts}.ts`
    (the `dnsUpdaters` facts gain each instance's parsed config with its mode and owner, and a shared
    `dnsUpdaterFiles` with the script's version and the units' SHA-256, so a plan can tell in-place
    from a change; lead, 2026-11-18), `packages/agents/src/drift/host.ts` (only the
    `AREA_TITLES` entry, M1), colocated tests, `packages/connectors/ssh-host/src/dns-updater-docker.test.ts` (new)
  - Reads: contracts/dns-updater.md (all of it); data-model 4, 5, 6; research R2, R4, R5, R6; plan 5.;
    the `web-filter` and `ssh-firewall` steps as the pattern for scripts, verify and teardown
  - Depends: T2903
  - Decided by the lead (T2910c's finding): the updater's record comment has one owner, this
    task: `DNS_UPDATER_RECORD_COMMENT = "Managed by OpsCrew (address updater)"` exported from the
    package root and used by the script's render. At the merge the lead points
    `agents/src/home/records.ts`' `UPDATER_RECORD_COMMENT` at it.
  - Accept:
    - The shared script (POSIX `sh`, curl, jq) and the template units exactly as the contract's
      "Files", "The units", "A run, in order" and "The rules the script keeps": oneshot service with
      `DynamicUser=yes`, `LoadCredential=config:` and `token:`, sandboxed; timer every 2 minutes; the
      token to curl on standard input; no address in the journal; only records with the updater's
      comment; a foreign record or a CNAME at the name is an error; the AAAA deleted only when IPv6
      is positively gone; 60 s TTL DNS-only, automatic proxied; 429 and errors retry next run.
    - `dns-updater` in `HOST_STEP_IDS` after `app-record`, app scope, params as plan 5.
      (`app`, `zoneId`, `name`, `proxied`, `ipv4`, `ipv6`, `tokenSha256` when given, `version`,
      `packages`); its secret `ApplySecrets.dnsUpdaterToken` on standard input; the shared files
      written when missing or older; verify waits for a successful run; teardown removes the
      instance, and the shared files with the last one. The host record keeps no token or hash.
      Without a token, a later plan keeps the server's file; a missing file blocks the step.
    - `AREA_TITLES` gains `dns-updater` so agents typechecks.
    - The contract's "Tests", including the Docker-gated script test against a fake Cloudflare
      (`OPSCREW_DOCKER_TESTS=1`).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents && npx vitest run --root packages/connectors/ssh-host && npx vitest run --root packages/agents src/drift && pnpm lint`
  - Effort: xhigh

- [ ] T2907 [P] [US1] [US2] [US4] The records, the home root and the templates' home branches
  - Owns: `packages/iac-templates/modules/cloudflare-dns/**`, `packages/iac-templates/src/infra/{own,index}.ts`,
    `packages/iac-templates/src/tunnel/index.ts`, `packages/iac-templates/src/edge/index.ts`,
    `packages/iac-templates/src/workflow/index.ts` (`healthScript`), `packages/iac-templates/src/check/index.ts`
    (`checkDiskVia`), `packages/iac-templates/src/index.ts`, colocated tests and snapshots; the tests
    and test helpers in `packages/agents/src/**` and `packages/cli/src/**` that name
    `cloudflare_dns_record.a` as a rendered address (M2, found with
    `grep -rln 'cloudflare_dns_record\.a\b' packages/agents/src packages/cli`), those lines only
  - Reads: plan 4., 8., 9.; contracts/plan-schema.md "Predicates"; research R2, R5, R9
  - Depends: T2902
  - Accept:
    - `cloudflare-dns`: boolean `ipv4_record` (default true) beside `ipv6_record`; the A record with
      `count`; `ipv4` default null; no `moved` block. Validated under both engines.
    - `adoptingImports` imports to `module.dns.cloudflare_dns_record.a[0]`; the tests naming the old
      address say `a[0]`.
    - `homeMode(plan)` and `homeIpv6Proxied(plan)` exported. The home root passes `ipv4_record =
      false`, `ipv6_record = false`, declares no address variables, outputs `address_updater = true`
      only with DNS on Cloudflare, and no `server_ipv4`/`server_ipv6`/`servers` outputs.
    - `edgePorts` drops the `0.0.0.0:` prefix for `homeIpv6Proxied`.
    - `healthScript` for a DNS-only home app: `--resolve <domain>:443:127.0.0.1 --resolve
      <domain>:80:127.0.0.1` with `runner: server`, `--resolve <domain>:443:$HOST` with
      `runner: host`; behind the proxy unchanged.
    - `checkDiskVia` returns `undefined` at home after the in-place case.
    - Every non-home render unchanged except `a` → `a[0]` (snapshots show it).
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/agents && PATH="$PWD/.tools/bin:$PATH" npx vitest run --root packages/iac-templates && npx vitest run --root packages/agents src/provision src/destroy src/hosting src/retarget src/shared && npx vitest run --root packages/cli src/commands/hosting.test.ts && pnpm lint`
  - Effort: xhigh

- [ ] T2910a [P] [US1] [US3] [US4] The classification, the forwards and the home texts
  - Owns: `packages/agents/src/home/{network,forwards,texts}.ts` (new), `packages/agents/src/shared/host-plan.ts`
    (`HostAdapterApi.detectHomeNetwork`, `boundHostAdapter`), colocated tests
  - Reads: research R3; plan 2., 3. (the summary lines), 8.; data-model 2, 3; contracts/cli.md
    "Output lines"
  - Depends: T2903, T2911
  - Accept:
    - `classifyHomeNetwork(network)` (pure): IPv4 `seen`/`none`/`unknown`, `noNat`, the IPv6 state,
      an optional `warning` (`cgnat-hop`, `private-hop`, `cgnat-interface`), as research R3.
    - The host adapter exposes `detectHomeNetwork`, bound like the other calls.
    - `homeForwards(...)` gives the exact lines: "forward TCP 80 and TCP 443 to 192.168.1.30;
      reserve 192.168.1.30 for it in the router's DHCP settings; don't forward SSH"; none with
      `noNat`; the router's IPv6 firewall rule whenever an AAAA is published (M12).
    - `home/texts.ts`: the ISP's terms, the large-media note, the token's reach (plan 6., R14), the
      carrier-NAT warning with the tunnel and IPv6 offers, "DNS elsewhere: only a fixed address
      keeps working" (FR-2908).
    - A helper that registers a proxied app's detected addresses with the redactor as names
      ("your home's address") for the run.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/home src/shared && pnpm lint`
  - Effort: high

- [ ] T2910b [P] [US2] The updater token's checks
  - Owns: `packages/agents/src/home/token.ts` (new), colocated tests
  - Reads: research R6; plan 6.; data-model 8; `zonePermissions`, `accountPermissions` in
    `connectors/cloudflare/src/client.ts`
  - Depends: T2909
  - Decided by the lead (T2909's finding): an account-owned token gets no id or status from
    `verifyToken` (it falls back to the zone listing); `checkUpdaterToken` refuses a token without
    an id or status in plain words, naming the recipe's user token (My Profile → API Tokens). No
    account-token verify is added.
  - Accept: `checkUpdaterToken(...)`, before any change: set (`OPSCREW_DNS_UPDATER_TOKEN`); not
    `CLOUDFLARE_API_TOKEN`'s value nor the same token (by `verifyToken`'s id); active;
    `zonePermissions(zoneId, ["dns"])` passes; the inverse probes (the zone's other needs, the
    account's needs) all come back missing, else refused as wider than the zone's DNS. Each failure
    names the recipe (Zone → DNS → Edit, Include → Specific zone) and ends "Nothing was changed.".
    The token registered with the redactor; leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/home && pnpm lint`
  - Effort: high

## Phase 4: Wave 3 (parallel)

- [ ] T2905 [P] [US1] SSH only from the home network, and the app record's `home`
  - Owns: `packages/connectors/ssh-host/src/plan.ts`, `packages/connectors/ssh-host/src/types.ts`,
    `packages/connectors/ssh-host/src/ssh-firewall*.ts`, and (lead, 2026-11-18) `facts.ts` (`AppRecordSchema.home`),
    `steps.ts` (`appRecord`'s `home`, `SshFirewallParams.install`), `findings.ts` (`homeModeConflict`), colocated tests
  - Reads: plan 5. (the app record, M4), 7.; research R8; data-model 6; `sshFirewallStep` and
    `planRunnerHost`
  - Depends: T2904
  - Accept:
    - `DesiredHostSchema` gains `sshFrom` and `home: { ipv4 }`. `planHost` adds the unchanged
      `sshFirewallStep` when the desired host has `sshFrom`; a home server's step installs
      `nftables` instead of blocking on a missing `nft`.
    - A table in place stays while other home apps are there; `planUndo` still removes it.
    - The app record (`/etc/opscrew/apps/<app>.json`) gains `home: { ipv4 }`. Before any change, a
      home app beside a non-home app, and home apps with different `home.ipv4`, are refused (M4),
      as mixed access modes are.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: high

- [ ] T2908 [P] [US1] [US3] The outside-check workflow
  - Owns: `packages/iac-templates/src/workflow/outside-check.ts` (new), its export line in
    `packages/iac-templates/src/index.ts`, colocated tests and snapshots
  - Reads: contracts/outside-check-workflow.md "The file", "The rules", "Tests"; research R7
  - Depends: T2907
  - Also (lead, T2907's finding 6; `src/workflow/index.ts` in Owns for it): `healthScript`'s `--resolve <domain>:443:$HOST` puts an IPv6 `$HOST` in brackets.
  - Accept: `OUTSIDE_CHECK_WORKFLOW_FILE = "opscrew-outside-check.yml"` and its renderer exactly as
    the contract: `workflow_dispatch` with `host`, `path`, `mode`, validated in the job and used only
    through `env:`; jobs `http` and `https` on `ubuntu-24.04` with `permissions: {}`; the
    cache-busted request; failure on 000, 520–527, 530 or a `cf-mitigated` header; the log holds
    only codes. Actions pinned as the other workflows pin them. The contract's tests.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/workflow && pnpm lint`
  - Effort: medium

- [ ] T2910c [P] [US2] Deleting the updater's records through a hashed plan
  - Owns: `packages/agents/src/home/records.ts` (new), colocated tests
  - Reads: data-model 7, 11; research R12; plan 14. (H5); 028's `zoneDeletion` pattern in
    `agents/src/cloudflare-move/`
  - Depends: T2902
  - Accept: `planRecordDeletion(...)` lists the zone's records with the updater's comment at the
    app's name: a canonical JSON plan of the zone id and the records' ids, types and names (never
    content), SHA-256 hashed; a `cloudflare-apply` approval with `allowDestroy` and the app's name
    typed (`--approve <hash> --confirm <app>` in a script); the records read again after the
    approval, nothing deleted when the hash changed; deletion through the connector's
    `deleteRecord`; audit entries as data-model 10. No record found: nothing to approve.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/home && pnpm lint`
  - Effort: high

- [ ] T2912 [P] [US1] [US3] [US4] [US5] Design for a home server
  - Owns: `packages/agents/src/design/{own,own-servers,run}.ts` (`run.ts`: `ownServerAccess` reads a home record, which has no `reachable`), a new `packages/agents/src/design/home.ts`,
    colocated tests and `__fixtures__`
  - Reads: plan 3., 12.; research R1, R3, R5, R10; contracts/plan-schema.md "Kept by a later
    design"; `requireNoSharedPreviews` (`agents/src/previews/host.ts`)
  - Depends: T2910a, T2902
  - Also owns (lead, T2912's findings): `packages/agents/src/shared/own-server-design.ts` (`inspectOwnServerForDesign` reads the home network only at home, and the board and storage facts). Accepted deviations: `server.sshFrom` required whenever no IPv4 home network is found, and with a carrier-NAT address on the server's own interface (the carrier's network is shared); a user's `home.ipv4: false` with no IPv6 stops; large media said only behind the proxy; the Pi warning for any own server with a Pi board.
  - Also owns (lead, T2910a's findings): `packages/agents/src/testing/own.ts` (`FakeHostServer` gains a scripted `detectHomeNetwork`) and `packages/agents/src/home/token.ts` (only to export the token's recipe text for the summary). Design builds `own.home.network.lan` from `HomeNetwork.lan` (the network as `192.168.1.0/24`). The carrier-NAT warning names the kind of address, never the hop's.
  - Decided by the lead (T2911's notes): with `noNat` design leaves `network.lan` out (the record refuses a public LAN address); design and verify write `own.home.network` and `outsideCheck` again on each run (the interview keeps neither).
  - Accept:
    - After connecting and inspecting: the detection, then `requireNoSharedPreviews(paths, "serving
      it at home", again, true)` (M5).
    - The decision table of plan 3. row by row, each with a test: `home.ipv4` written; the stops in
      plain words; a user's `home.ipv4: false` kept by a later design; `noNat` without
      `server.sshFrom` stops.
    - Writes `target.access: public`, `target.home`, `dns.proxied` from the serve answer (with
      `httpAllowedFrom: cloudflare` when proxied), `environment.runner: server` unless the plan says
      `host`.
    - The summary: a public address found (a proxied app's never printed; DNS-only prints it), the
      forwards, the IPv6 router rule, the ISP's terms and large media, the token's recipe and reach
      (DNS on Cloudflare) or "only a fixed address" (DNS elsewhere), and the Raspberry Pi warning
      (a Pi, an SD card or unknown mmc, and a database service or storage on the server: recommend
      a USB or NVMe SSD, never refuse).
    - Leak test with a proxied app.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/design && pnpm lint`
  - Effort: xhigh

## Phase 5: Wave 4 (parallel)

- [ ] T2906 [P] [US4] The IPv6 web filter behind the proxy
  - Owns: `packages/connectors/ssh-host/src/web-filter.ts`, `packages/connectors/ssh-host/src/types.ts`
    (`webFilter.ipv6` only), `packages/connectors/ssh-host/src/{plan,findings}.ts` (the two items below), colocated tests, `packages/connectors/ssh-host/src/web-filter-docker.test.ts`
  - Reads: plan 8. (M11); research R5
  - Depends: T2905
  - Also (lead, T2905's findings; `plan.ts` in Owns for these): `planRunnerHost` keeps OpsCrew's SSH table while an app record on the machine has `home` (a runner machine that is also a home server keeps its SSH limit); a home app whose `sshFrom` differs from the shared table's sources gets a warning finding naming that the table keeps its sources (no address in it: "the networks you named for <app> differ from the ones SSH already allows").
  - Accept: `DesiredHost.webFilter.ipv6`; `webFilterScript` also loads `inet opscrew-web` with two
    base chains, policy accept: `input` lets `ip6 saddr` in the ranges reach TCP 80, TCP 443, UDP 443
    and drops other IPv6 packets to those ports, except on `lo`; `forward` does the same for
    `ct status dnat` connections whose `ct original proto-dst` is 80 or 443. The unit Docker requires
    loads it, so it fails closed. Teardown and `--undo-host` remove it. A Docker-gated test of the
    table (`OPSCREW_DOCKER_TESTS=1`); every IPv4-only render unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: xhigh

- [ ] T2910d [P] [US1] [US3] Running the outside check
  - Owns: `packages/agents/src/home/outside-check.ts` (new), colocated tests
  - Reads: contracts/outside-check-workflow.md "How agents run it", "What it proves"; research R7;
    the GitHub connector's `dispatchWorkflow`, `waitForWorkflowRun`, `runAttemptJobs`
  - Depends: T2908
  - Accept: `runOutsideCheck(...)` as the contract: dispatch (audited `dispatch workflow` with the
    hostname, path and mode), wait 10 minutes, read the jobs of attempt 1, the result into
    `own.home.outsideCheck`; `success` → ok, `failure` → failed naming the port, `cancelled`/
    `timed_out` → "the check didn't finish: run `opscrew verify` again"; 404/422 on dispatch → merge
    the deploy-setup pull request first. The failure text: the forwards, the fixed LAN address, the
    possible causes ("not forwarded, blocked by your provider, or no public IPv4 address; OpsCrew
    can't tell which"), the tunnel. Behind the proxy the `http` result reads "Cloudflare answered on
    port 80". Nothing changes; no request from this computer counts.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/home && pnpm lint`
  - Effort: high

- [ ] T2914d [P] [US1] The runbook's home section
  - Owns: `packages/iac-templates/src/runbook/own.ts`, colocated tests and snapshots
  - Reads: plan 13. (M10); research R8, R11
  - Depends: T2908
  - Accept: for a home app, a section with the forwards, the updater and its token's reach, SSH from
    the home network, the outside check, and console recovery after a renumbered network; other
    runbooks unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/runbook && pnpm lint`
  - Effort: medium

## Phase 6: Wave 5

- [ ] T2942 [P] [US4] The IPv6 web filter seen by the plan, kept through an nftables restart (lead, T2906's findings)
  - Owns: `packages/connectors/ssh-host/src/{inspect,parse,facts,plan,steps,web-filter}.ts`, colocated tests and snapshots
  - Reads: plan 8. (M11); T2906's `WEB_FILTER_TABLE`, `webFilterStep`, `webFilterScript`
  - Depends: T2906
  - Accept:
    - Inspection reads whether `inet opscrew-web` is there and a hash of its rules (no address printed beyond what the step already shows); `webFilterStep` compares it, so a flushed or edited table is a change, and drift (T2914c) can report it.
    - Proxied IPv6 → IPv4: when the fact shows the table and the desired filter has no `ipv6`, the plan removes the table (the IPv4-only render stays byte-identical otherwise).
    - An nftables restart keeps the filter: with IPv6 only, a drop-in for the web-filter unit (`PartOf=`/`ReloadPropagatedFrom=nftables.service` or the like, tested) loads the table again; the IPv4-only unit text stays identical.
    - With `ipv6` and no `nft` on the server, `webFilterStep` installs nftables (as the home `ssh-firewall` step does) or is blocked before any change; never a failure mid-apply.
    - A Docker-gated test (`OPSCREW_DOCKER_TESTS=1`): a flushed table seen by inspection, `systemctl restart nftables` followed by the table back.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: high

- [ ] T2913a [US1] [US2] [US4] Provision for a home server: the checks and the host plan
  - Owns: `packages/agents/src/provision/{own,run}.ts`, `packages/agents/src/check/provision.ts`,
    colocated tests
  - Reads: plan 9., 10. (steps 1, 3–5, 7); data-model 2, 6; research R5, R6, R9
  - Depends: T2904–T2907, T2910a, T2910b
  - Also (lead, T2907's finding 5): `ownEngineEnv` sets no `TF_VAR_server_ipv4`/`_ipv6` for the home root.
  - Accept:
    - Before any change, read-only: the detection (a plan with `home.ipv4: true` whose server now
      has no IPv4 stops: "run `opscrew design` again"; a warning is repeated); the token checks with
      DNS on Cloudflare; the mixing refusals; `requireNoSharedPreviews`; Cloudflare's IPv6 ranges for
      `homeIpv6Proxied`, or nothing changes. `run.address` isn't set.
    - `desiredHost`: `sshFrom`, `home`, `dnsUpdater` (the token on standard input, its hash in the
      plan), `webFilter.ipv6` for `homeIpv6Proxied`; `ownWebSources` returns Cloudflare's IPv6
      ranges too. The host plan's apply ends with the updater's first successful run.
    - `ownDeployTarget`'s home branch (H7): `server` gives no deploy target; `host` gives the LAN
      address with its pinned key; GitHub never holds a home address. `checkReachesOverSsh` false
      at home.
    - The output: the forwards with "set them before you merge: the first deploy fetches its
      certificate through them" (DNS-only) or "so Cloudflare reaches your server" (proxied); the
      IPv6 router rule; "merge, then run `npx opscrew verify`, which checks from outside your home".
    - No public address persisted (M7); leak test over every fake.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/provision src/check && pnpm lint`
  - Effort: xhigh

- [ ] T2941 [P] [US1] Bounded plans accept the one-time `a` → `a[0]` rename (lead, T2907's finding 4)
  - Owns: `packages/agents/src/retarget/**`, `packages/agents/src/cloudflare-move/shadow-plans.ts`, colocated tests
  - Reads: plan 4. (M2); `dnsSwitchChange` in `retarget/switch.ts`; `checkAdoption` in `cloudflare-move/shadow-plans.ts`; every other check that refuses a plan with state renames (`isMovesOnly`, `moves` in plan JSON: grep agents/src)
  - Depends: T2907
  - Accept: a plan whose only renames are `module.dns.cloudflare_dns_record.a` → `…a[0]` (and `aaaa` → `aaaa[0]`) passes every check that refuses renames, as a rename (nothing changes at Cloudflare); any other rename is still refused as today; a test per check, both with that rename alone and beside a refused one.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/retarget src/cloudflare-move && pnpm lint`
  - Effort: medium

- [ ] T2943 [P] [US4] The web filter on every supported OS, and after an nftables restart in both modes (lead, T2942's findings 3–5)
  - Owns: `packages/connectors/ssh-host/src/{web-filter,plan,steps,inspect,parse,facts}.ts`, colocated tests, snapshots and fixtures
  - Reads: T2906's and T2942's web-filter code and Docker-gated tests; plan 8. (M11); the target platforms (Ubuntu 22.04/24.04/26.04, Debian 12/13)
  - Depends: T2942
  - Accept:
    - The IPv6 table loads and filters on nft 1.0.2 (Ubuntu 22.04), 1.0.6 (Debian 12) and the newer ones: the forward chain's match of the original destination port written in a form each accepts (e.g. one rule per protocol and port with `meta l4proto`), listing stably so the inspection hash (T2942) stays meaningful. The Docker-gated test runs on `ubuntu:22.04`, `debian:12`, `ubuntu:24.04` and `debian:13` (the allowed range reaches 80/443, another is dropped, on both paths).
    - IPv4 mode gets the same nftables drop-in (`PartOf`/`ReloadPropagatedFrom`), so a restart of nftables restarts Docker and the filter together and the origin protection comes back (T2942's finding 4). Existing servers get one plan change at their next provision; the changelog says so (T2923).
    - Going from IPv6 back to IPv4 keeps the IPv6 table while inspection still shows a listener on IPv6 port 80 or 443 (T2942's finding 5); the next run after the deploy rebinds removes it.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents && npx vitest run --root packages/connectors/ssh-host && pnpm lint`, and the Docker-gated tests with `OPSCREW_DOCKER_TESTS=1`
  - Effort: xhigh

## Phase 7: Wave 6 (parallel)

- [ ] T2913b [P] [US1] Provision: mode switches, the check workflow and the pull request
  - Owns: `packages/agents/src/provision/**` except `own.ts` and `run.ts`'s home checks from T2913a
    (the mode switch code goes in a new `provision/home-switch.ts`, called from `run.ts` at one
    line; the pull request's files and body in `provision/publish.ts`), colocated tests
  - Reads: plan 10. (steps 2, 6), 14. (H4); research R12; `removeOldAccessMode`
  - Depends: T2913a, T2910c, T2908
  - Decided by the lead (T2904's finding): the dedicated host plan of a switch out of home is `planHost` with the app's `dnsUpdater` (and, with the server's last home app, `sshFrom`) left out of the desired host, which already removes the instance; no new plan function.
  - Accept:
    - `removeOldAccessMode` reads home as its own mode from `address_updater`.
    - public → home: no removal; the infrastructure plan deletes `a[0]`/`aaaa[0]`, then the updater
      writes its own. tunnel → home: today's removal, then as above. home → public or tunnel: first
      a dedicated host plan approved by its hash removes the app's updater (and the SSH table with
      the server's last home app), then the records deleted through `home/records.ts`, then for
      tunnel the home root's `www` in the removal, then the new mode's setup.
    - The deploy-setup pull request brings `.github/workflows/opscrew-outside-check.yml` (once per
      repository); its body says what the check does and the forwards to set (M10).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/provision && pnpm lint`
  - Effort: xhigh

- [ ] T2914a [P] [US1] [US2] [US3] [US5] verify for a home app
  - Owns: `packages/agents/src/verify/**`, colocated tests and snapshots
  - Reads: plan 13. (verify), 12.; research R7, R10, R11
  - Depends: T2910d, T2913a
  - Accept: checks `outside-check` (every verify of a home app whose domain has a record),
    `dns-updater` (failure when the last success is older than 10 minutes or the records differ;
    warning when an error happened since), `pi-power` (failure now, warning since boot, naming the
    supply). A DNS-only app's own site request is a warning while the outside check passes
    (hairpin). DNS elsewhere: resolve and compare with the detected address. Away from home the SSH
    checks are `skip` with "your server answers SSH only on your home network", and the outside
    check still runs. `token-refused` names the rotate step.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/verify && pnpm lint`
  - Effort: high

- [ ] T2914b [P] [US2] [US5] status and secure for a home app
  - Owns: `packages/agents/src/status/**`, `packages/agents/src/secure/**`, colocated tests and snapshots
  - Reads: plan 13. (status, secure); research R11; contracts/cli.md "Output lines"
  - Depends: T2913a
  - Accept:
    - status: the SSH sources; the updater from inspection's `dnsUpdaters`, this app's only (last
      run, "sees" as addresses for DNS-only and "hidden: behind Cloudflare's proxy" for proxied,
      records match, last write, last error with the next step); the last outside check. Away from
      home: "your server answers SSH only on your home network", and the last outside check from
      the local record (SC-2905).
    - secure: this computer's probes read "from inside your network (not proof)", never failures;
      server-side checks of the SSH table and its sources, the web filter's families, the token file
      (root, 0600), the timer, `pi-power`.
    - Leak test with a proxied app.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/status src/secure && pnpm lint`
  - Effort: high

- [ ] T2915a [P] [US2] rotate `dns-updater` and init's recipe
  - Also (lead, T2913a's finding): `rotate/infra.ts` builds its engine environments through `projectEngine` (`shared/engine.ts`, which drops the updater's tokens), not from `deps.env` directly; a test that neither updater token reaches the engine.
  - Also (lead, T2941's finding): `rotate/infra.ts`'s refusal of a plan with renames lets the one-time `a` → `a[0]` rename through, with `isDnsRecordCountMove` (`retarget/plans.ts`, moved to `shared/` if rotate shouldn't import from retarget), and a test.
  - Owns: `packages/agents/src/rotate/**`, `packages/agents/src/init/**`, colocated tests and snapshots
  - Reads: plan 6.; contracts/cli.md "`opscrew rotate`", "Variables"; data-model 8, 9
  - Depends: T2913a
  - Accept: `dns-updater` joins the user's tokens (`USER_TOKENS`, `OTHER_TOKEN_NAMES`,
    `rotate/tokens.ts`) per environment, `dns-updater` in `opscrew/credentials.yaml`; its copy (the
    server's file) is replaced through the host plan approved by its hash after `checkUpdaterToken`;
    the output names https://dash.cloudflare.com/profile/api-tokens. `opscrew init` gives the
    token's recipe for a home app with DNS on Cloudflare.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/rotate src/init && pnpm lint`
  - Effort: high

## Phase 8: Wave 7 (parallel)

- [ ] T2914c [P] [US2] drift for the updater and the IPv6 filter
  - Also (lead, T2913a's finding 2): `drift/host.ts` builds `run.home` (as provision's `prepareHome` does, read-only, the token left as the server has it) before calling `desiredHost` on a home plan, which otherwise stops at its internal guard.
  - Owns: `packages/agents/src/drift/**`, colocated tests
  - Reads: plan 13. (drift, M10)
  - Depends: T2906, T2913b
  - Accept: the `dns-updater` step and the IPv6 filter reported like the other steps: a changed
    config, unit, token file mode or table. No token or address in the report.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/drift && pnpm lint`
  - Effort: medium

- [ ] T2915b [P] [US2] destroy for a home app
  - Also (lead, T2913b's finding 2): when an app switches out of home (`provision/home-switch.ts`) and it was the repository's last home app, the same pull-request removal takes `.github/workflows/opscrew-outside-check.yml` out; a test for the switch and for destroy.
  - Owns: `packages/agents/src/destroy/**`, colocated tests
  - Reads: plan 14. (destroy); research R12
  - Depends: T2913b
  - Accept: the teardown host plan removes the app's updater instance, config, token and state (the
    shared files with the last instance); then the records deleted through `home/records.ts`; with
    the repository's last home app, destroy's pull request removes the check workflow;
    `--undo-host` also removes the IPv6 filter; the output names the token page.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/destroy && pnpm lint`
  - Effort: high

- [ ] T2916a [P] retarget refuses a home server
  - Owns: `packages/agents/src/retarget/**`, colocated tests
  - Reads: plan 14. (retarget)
  - Depends: T2902
  - Accept: from a home server and to one, both refused before any change: "retarget can't move an
    app to or from a server at home yet: destroy it there and provision the other target, or add an
    environment. Nothing was changed."
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/retarget && pnpm lint`
  - Effort: medium

- [ ] T2916b [P] [US2] A home app in a move to another Cloudflare account
  - Owns: `packages/agents/src/cloudflare-move/**`, colocated tests and fakes;
    `packages/agents/src/home/records.ts` (only an option for a deletion approved earlier, below)
  - Reads: plan 15. (M8); research R12; ADR 0032; `docs/guide/cloudflare-move.md`
  - Depends: T2910b, T2910c, T2913a
  - Decided by the lead (T2910c's finding): the abort's deletion stops with a pending hash as the
    move's other steps do (`pendingStop`); `deleteUpdaterRecords` gains an option to apply a
    deletion whose hash was approved earlier (`--approve`), still reading the records again and
    refusing on a changed hash. The comment comes from `UPDATER_RECORD_COMMENT` (`home/records.ts`).
  - Accept: `opscrewNamesInZone` counts the updater's comment; the zone plan copies those records
    with their content masked and the switch refreshes them from A; the finish asks for B's updater
    token (`OPSCREW_NEW_DNS_UPDATER_TOKEN`, else once in a terminal, hidden, never kept), checks it
    with `checkUpdaterToken`, then a host plan approved by its hash gives the updater B's zone id and
    token; abort deletes the copied records from B through `home/records.ts` when B's zone stays.
    Two-account fakes; leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: xhigh

## Phase 9: Wave 8 (parallel)

- [ ] T2917 [P] The CLI, the MCP server and the plugin
  - Owns: `packages/cli/src/**`, `packages/cli/test/e2e/home.test.ts` (new), `packages/mcp-server/src/**`,
    `plugin/skills/opscrew-deploy/**`, colocated tests and snapshots
  - Reads: contracts/cli.md (all); quickstart "A user hosts an app at home"
  - Depends: waves 1–7
  - Decided by the lead (T2911's notes): the terminal interview asks `server.home` with the address-based default for the host typed in the same run (a second round after `server.host` if needed); the MCP server's `SERVER_ANSWER_HELP` gains `server.home` and `server.sshFrom`; the move's services get `askUpdaterToken` (a hidden prompt for B's updater token, T2916b); and its `server.reachable` help no longer says "false for a home server".
  - Accept: the new answers, variables (`OPSCREW_DNS_UPDATER_TOKEN`, `OPSCREW_NEW_DNS_UPDATER_TOKEN`)
    registered with the redactor, `rotate dns-updater`, `--confirm <app>` for the records' deletion,
    and the output lines; the MCP server's status and verify pass the same data through the
    redactor; the deploy skill gains a home section. `home.test.ts` runs the quickstart's flow on
    fakes end to end (interview → design → provision → verify → destroy) with a leak scan.
  - Verify: `pnpm turbo run typecheck --filter=opscrew --filter=@opscrew/mcp-server && npx vitest run --root packages/cli test/e2e/home.test.ts && npx vitest run --root packages/mcp-server && pnpm lint`
  - Effort: high

- [ ] T2918 [P] The guide
  - Owns: `docs/guide/home-hosting.md` (new), `docs/guide/{own-server,runners,credential-rotation,cloudflare-move,origin-protection,index}.md`
  - Reads: spec.md; plan 3., 6., 7., 11., 13., 14.; quickstart "A user hosts an app at home"; the
    guide's other pages for tone
  - Depends: waves 1–7 (the real strings)
  - Also (lead, T2943's findings): a restart or reload of nftables on an iptables-nft host (Ubuntu 24.04's default) wipes every iptables table, ufw's included; OpsCrew's filter and Docker come back by themselves, ufw doesn't: the own-server page says to run `sudo ufw reload` after one.
  - Also (T2916b): `cloudflare-move.md` names `OPSCREW_NEW_DNS_UPDATER_TOKEN` and its recipe in the new account, and that an abort deletes the updater's copied records when the new zone stays.
  - Accept (FR-2916): when to host at home versus the tunnel; what to forward and the DHCP
    reservation; the IPv6 router rule; the updater (a script and two units, what it writes, how
    often, the 60 s TTL) and its token's recipe and reach (R14 plainly); the outside check and
    hairpin NAT; no public IPv4 (carrier NAT) and what to do; SSH only from the home network and
    console recovery; the ISP's terms; large media; a Raspberry Pi (SSD, power); DNS outside
    Cloudflare (fixed address only); rotate, destroy, leaving home; what each command shows away
    from home. The other pages link to it where they meet it.
  - Verify: `pnpm lint`
  - Effort: high

## Phase 10: Wave 9

- [ ] T2919 The live test files
  - Owns: `packages/cli/test/live/home.test.ts`, `packages/cli/test/live/home-support.ts` (new), `docs/e2e.md` (its home section)
  - Reads: plan 18.; quickstart "The lead's live pass"; `packages/cli/test/live/cloudflare-move*.ts`
    for the patterns (one leg per `-t`, the pass state file, cleanup, the leak scan)
  - Depends: T2917
  - Accept: legs H0–H8 as plan 18., gated on `OPSCREW_E2E_HOME=1`, each runnable alone with
    `-t "H<n>:"`; the stand-ins (a Hetzner `cax` server as home, a Hetzner Cloud firewall as the
    router, a second server as the scanner); every server and firewall deleted at the end or on
    failure, leftovers listed; the leak scan of H7 over every output, commit, pull request, audit
    entry, saved plan, state file, `server.json` and the check's run logs.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint` (the legs run in T2920)
  - Effort: high

## Phase 11: Also in 029's release (founder, 2026-11-15)

Restore drills and a read-only database check in `advise`, as tasks of their own (plan O11; US7,
US8; FR-2917–FR-2922; plan 19., 20.; research R15–R23). T2931 and T2932 run beside wave 1, T2933
beside wave 2; none shares a file with 029's other tasks of its wave.

- [x] T2930 (lead) Research R15–R23, US7 and US8, FR-2917–FR-2922, plan 19. and 20., these tasks
  - Effort: lead

- [ ] T2931 [P] [US7] The drill's copy and its part restores
  - Owns: `packages/iac-templates/src/drill/**` (new), `packages/iac-templates/src/workflow/snapshots.ts`
    (the part restores taking a project and volumes), its export line in
    `packages/iac-templates/src/index.ts`, colocated tests and snapshots
  - Reads: plan 19.; research R15–R17; `src/previews` (`previewTemplatePlan`, the recipe),
    `src/runtime/healthcheck.ts`, `src/workflow/snapshots.ts`
  - Depends: T2901
  - Accept:
    - `renderDrill(plan, snapshot, ...)`: the Compose project `<app>-drill` for `.drill/<snapshot
      id>/` from the preview recipe's rendering: the app (its pinned image digest) and the
      snapshot's services only, the services' limits, new generated service values, no workers or
      cron, one network with `internal: true`, no published port, no proxy site, the app's
      healthcheck kept.
    - The env: the app's plain settings and the drill's own service values; no `.env` value; the
      `.env.preview` file used when given.
    - `snapshot.sh`'s part restores target a given project's volumes (default: the app's, so every
      existing render is unchanged), reading the snapshot read-only.
    - Tests: the drill render for an app with PostgreSQL and Redis; no `ports:`, `internal: true`,
      no `.env`; existing snapshot renders unchanged (snapshots).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/drill src/workflow src/previews && pnpm lint`
  - Effort: high

- [ ] T2932 [P] [US8] The database check in `advise`
  - Owns: `packages/agents/src/advise/**`, `docs/guide/advise.md`, colocated tests and `__fixtures__`,
    a new Docker-gated `packages/agents/src/advise/database-docker.test.ts`
  - Reads: plan 20.; research R20–R23; `docs/guide/advise.md`; `serverShell` and
    `readServerResources` (`agents/src/status/`); `planGrant` in `connectors/ssh-host/src/plan.ts`
    for how the socket sign-in works
  - Depends: T2901
  - Accept:
    - For each PostgreSQL service on a server advise reaches over SSH: R21's six queries, each one
      `docker compose -p <app> exec -T <db> psql -X -q -At` with the SQL on standard input and
      `PGOPTIONS` as R21; a 20-second cap; the first timeout stops the check and is a finding.
    - A test asserts the SQL texts hold only `SELECT`s and never `pg_stat_activity.query`.
    - Findings with R22's thresholds (into `THRESHOLDS`) and plain texts, as **Reliability**,
      `now`/`soon`, each with its figures and "read once, at <time>"; R23's index proposals (table
      and statement, no column, never applied, never in `--apply`); `pg_stat_statements` missing:
      "slow queries are not read: turn `pg_stat_statements` on" with the two steps; below 13 the
      slow-query step skipped with the reason.
    - Portainer, this computer and hosting accounts: "not read" with the reason.
    - Statement text redacted; leak test.
    - The Docker-gated test (`OPSCREW_DOCKER_TESTS=1`) on `postgres:14-alpine` and
      `postgres:17-alpine` with a planted lock wait and an open transaction: both found, the
      database unchanged.
    - `docs/guide/advise.md` gains the database check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/advise && pnpm lint`
  - Effort: high

- [ ] T2933 [US7] `opscrew restore --drill` on servers and this computer, and the drill setting
  - Owns: `packages/iac-templates/src/workflow/{snapshot-script,snapshots}.ts` (the script's `drill`
    subcommand), `packages/plan-schema/src/**` and `packages/plan-schema/schemas/**` (the drill
    setting), `packages/agents/src/snapshot/**` except `schedule.ts` (with two stubs,
    `snapshot/drill-portainer.ts` and `snapshot/drill-hosting.ts`, each exporting its target's
    drill function that throws `INTERNAL` "not built yet", for T2934 and T2935),
    `packages/agents/src/status/drill.ts` (new) and its one call in `packages/agents/src/status/run.ts`,
    `packages/cli/src/commands/restore.ts`, `packages/iac-templates/src/drill/**` (T2931's render),
    `packages/iac-templates/src/previews/{index,script}.ts` (only to export the preview's fill of
    generated values for reuse), colocated tests and snapshots
  - Reads: plan 19.; research R15–R19, R26, R27, R29; `snapshot/{restore,restore-checks,disk,run,computer}.ts`;
    T2931's `src/drill/` render (`renderDrill`, `drillPlan`, `drillProject`, `restoreFunctions`)
  - Depends: T2931
  - Decided by the lead (T2931's findings):
    - The env files keep their `@SECRET:…@` placeholders (so the plan's hash is stable); the
      server fills them with the preview's own fill routine, exported from `previews/script.ts`
      and reused by `snapshot.sh drill`, never a second copy of it.
    - `.env.preview`'s values (`values.env`) reach the server on standard input with the host
      plan's secrets, never in the plan.
    - The drill's containers get `restart: "no"` (a kept copy never comes back after a reboot).
    - The snapshot's image is used by its digest; when it isn't on the server it is pulled with
      the server's existing credentials; when that fails, the drill fails in plain words ("that
      snapshot's version of the app is gone") and offers `--allow-other-version` (today's image).
    - Data folders under `/srv/data/<app>-drill/` are removed the way `opscrew-preview down`
      removes a preview's.
    - Services restored from a volume (stop-only kinds such as RabbitMQ) keep production's logins,
      so the copy can't sign in to them: the report names them and says so, under R19's second
      outcome.
  - Accept:
    - **The setting:** `snapshots.drills` in the plan (strict: `{ schedule?: "weekly" | "daily" }`;
      present means drills are on for the environment; the schedule needs `snapshots.schedule`),
      refused with plain messages where there are no snapshots; JSON schemas regenerated, every
      fixture parses as before.
    - **On the target:** `snapshot.sh drill [<id>] [--keep | --remove]` enforces the bounds itself
      (R29 1–4, 6–8): every name built from the app's name and the fixed word `drill`, the id
      checked against `SNAPSHOT_ID` and only the latest unless an id is given by hand, the part
      restores into the drill project's volumes (T2931), `internal: true` checked after start, no
      `.env`, the app folder's lock (held: "skipped"), the disk rule of `snapshot/disk.ts` with the
      snapshot's size added and the memory the plan gives (short: "skipped"), a 30-minute limit,
      a crashed run's leftovers removed at the next start; the health read (the container's
      healthcheck until healthy or 5 minutes; probe `none`: still running after 60 s; `pg_isready`
      and a table or key per SQL service); the copy removed unless `--keep`; one line per run in
      `.snapshots/drills.log` (no values).
    - **The command:** `opscrew restore --drill [<id>]` (latest by default; `--only` carries over;
      `--from offsite` refused for drills), `--keep`, `--drill --remove`, `--json`. Servers
      OpsCrew created and own servers (home included) through a host plan; this computer through
      the local executor (R26: the recorded image, `--allow-other-version` when it's gone).
      Portainer and hosting accounts call the stubs; SFTP-only hosts, Cloudflare's hosting and
      GitHub Pages are refused with `snapshotTarget`'s reasons, before any change.
    - **The approval:** the host plan names the snapshot, the project, the volumes it creates and
      removes, the memory, the network flags and the health check; approved by its hash through
      `approveRestore`'s kind with a drill hash (plan 19.), `allowDestroy` and `<app>-drill` typed
      (`--approve <hash> --confirm <app>-drill` in a script); its text says the copy runs with no
      internet and without the production `.env`.
    - **The report:** R19's outcomes in plain words, R27's row named; `opscrew status` shows the
      last drill of a server or this computer (`status/drill.ts`).
    - Production's containers, volumes and `.env` never named in any command it runs (a test over
      the scripted remote's commands); a leak test.
  - Verify: `pnpm --filter @opscrew/plan-schema gen:schemas && pnpm turbo run typecheck --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/plan-schema && npx vitest run --root packages/iac-templates src/workflow && npx vitest run --root packages/agents src/snapshot src/status && npx vitest run --root packages/cli src/commands/restore && pnpm lint`
  - Effort: xhigh

- [ ] T2934 [P] [US7] Drills in a Portainer
  - Owns: `packages/connectors/portainer/src/**` (a stack from a string), `packages/agents/src/snapshot/drill-portainer.ts`,
    `packages/iac-templates/src/drill/**` (only if the render needs a Portainer option: the
    snapshots volume external), colocated tests
  - Reads: plan 19.; research R24, R27, R29; ADR 0012; `snapshot/{portainer,restore-portainer}.ts`;
    `packages/connectors/portainer/src/{client,plan}.ts`; Portainer's official API reference for the
    string stack endpoint (one fetch)
  - Depends: T2933
  - Accept: the connector's `createStackFromString` (zod-checked, tested with `fetch` fakes); the drill
    as a second stack `opscrew-<app>-drill` from T2931's render, the snapshots volume external and
    mounted read-only in the restoring one-off containers, approved as a stack plan by its hash
    (`stack-apply`, `allowDestroy`, the typed name), the network read back as internal after deploy
    (else the stack removed at once and the drill failed in plain words), the app's
    `State.Health.Status` through the Docker proxy, then `removeStack` and `removeVolume` and a list
    proving they're gone; the record and R19's outcomes; nothing named `opscrew-<app>` touched (a
    test over the fake's calls); leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-portainer --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/connectors/portainer && npx vitest run --root packages/agents src/snapshot && pnpm lint`
  - Effort: high

- [ ] T2935 [P] [US7] Drills on a hosting account
  - Owns: `packages/iac-templates/src/hosting/**` (the agent's `drill` request and routine),
    `packages/agents/src/hosting/**`, `packages/agents/src/snapshot/drill-hosting.ts`, colocated tests
  - Reads: plan 19.; research R25, R27, R29; ADR 0030; `docs/guide/hosting-accounts.md`; the panel
    connectors' `addDatabase` and `removeDatabase`
  - Depends: T2933
  - Accept: with `snapshots.drills` on a panel account (cPanel, Plesk, DirectAdmin), the hosting
    plan makes the drill database and its login through `addDatabase` (approved by its hash; it
    says the database counts against the plan's limit, and refuses when there's no room), and
    removes it at destroy or when drills are turned off; the login kept in a mode-600 file on the
    account, never in output; `opscrew restore --drill` sends a hash-bound, expiring `drill` request
    with the snapshot's id; the agent, under its lock between releases: `gzip -t` and size, the
    import into the drill database only (every table and view dropped first), the table count
    against the dump's `CREATE TABLE` count (names and counts only), the drill database emptied, a
    `tar -tzf` of the shared files; the answer in R27's row ("the dump loaded with N tables; the
    app itself wasn't started"); SFTP-only hosts refused with the reason; the app's own database
    never named in the routine (a test over the rendered script); leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/iac-templates src/hosting && npx vitest run --root packages/agents src/hosting src/snapshot && pnpm lint`
  - Effort: xhigh

- [ ] T2936 [P] [US7] The scheduled drill on the target, the check's drill line and the command
  - Re-scoped by the lead (2026-11-18, T2936's report): the crontab line and the copy's files are installed by a host plan approved by its hash (T2944), as constitution I's clause asks, never by the deploy's start script.
  - Owns: `packages/iac-templates/src/drill/script.ts` (the scheduled mode), `packages/iac-templates/src/workflow/{snapshot-script,snapshots}.ts` (only what the scheduled mode needs; no crontab line there), `packages/iac-templates/src/check/index.ts` (`check.json` carries the drill schedule), the scheduled check's script (its source and `src/generated/check.ts`, regenerated), `packages/connectors/ssh-host/src/constants.ts` (`CHECK_KEY_COMMAND` and its line pattern only), `packages/agents/src/snapshot/{schedule,index}.ts`, `packages/cli/src/commands/snapshot.ts`, colocated tests and snapshots (`agents/src/check/host.test.ts` included)
  - Reads: plan 19.; research R28, R29; T2933's `snapshot_cmd_drill`, `drill_left`, `drill_remove_all`; `docs/guide/alerts.md`
  - Depends: T2933
  - Accept:
    - `snapshot.sh drill scheduled`: no one-time approval file (the standing approval is T2944's host plan); it drills only in its slot (three hours after the snapshot's, weekly or daily from the drill settings on the server), only the latest snapshot, never `--keep`; the copy's files read from `.drill-recipe/` (outside `.drill/`, which a run clears) with `values.env` there; every R29 bound kept in the script; one `scheduled` line in `drills.log`; a skip is `skipped` with its reason.
    - `opscrew snapshot drill schedule on|off`, `--every weekly` (default) or `daily`, changes only the plan; it needs the snapshot schedule (says so and offers both), and `snapshot schedule off` also removes the drill schedule, saying so.
    - The scheduled check: `check.json` carries the drill schedule; its read-only command reads the last `scheduled` line of `drills.log` (`CHECK_KEY_COMMAND` and `check.mjs`'s `CHECK_COMMAND` stay identical); a failed, not-restored or unhealthy drill, or none within twice the schedule, opens its issue with a fixed sentence; a skip never does; checks without a drill schedule are unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/iac-templates src/drill src/workflow src/check && npx vitest run --root packages/agents src/snapshot src/check && npx vitest run --root packages/cli src/commands/snapshot && pnpm lint`
  - Effort: high

- [ ] T2944 [US7] The drills host step: the schedule installed by a plan approved by its hash
  - Owns: `packages/connectors/ssh-host/src/{types,plan,steps,inspect,parse,facts}.ts` (a `drills` step, modelled on the previews step: `AddonEnableSchemas.previews`), `packages/connectors/ssh-host/src/__fixtures__/fake-host.ts`, `packages/agents/src/provision/own.ts` (`desiredHost`'s drills), colocated tests and snapshots
  - Reads: plan 19.; research R28, R29; constitution I's clause for a program a plan installs; the previews step and its `values.env` supplied at apply time
  - Depends: T2936, T2943, T2913a
  - From T2936 (merged): write `drillRecipe(plan, { repository, env, previewValues })` (paths already under `.drill-recipe/`, `@SECRET:…@` placeholders kept, the app image `<repository>@` + `DRILL_RECIPE_DIGEST`, `repository` as `drillImage` in `agents/src/snapshot/drill.ts` builds it), the `schedule` file, `values.env` (mode 600, at apply time; then `previewValues: true`), and the crontab line `sh /srv/apps/<app>/snapshot.sh drill scheduled > /dev/null 2>&1 # opscrew-drill <app>` hourly. Also owns the scheduled check's script (source and `src/generated/check.ts`) for one more case: a drill schedule on whose server holds scheduled snapshots older than twice the drill period, plus an hour, and no scheduled drill that ran, opens "no scheduled restore drill" (today it stays "not checked").
  - Accept: with `snapshots.drills.schedule`, the host plan has a `drills` step that writes `.drill-recipe/` (the copy's rendered files with their `@SECRET:…@` placeholders, filled on the server), `values.env` from `.env.preview` (mode 600, given on standard input at apply time, never in the plan or its hash beyond a SHA-256), the drill settings, and the tagged crontab line `# opscrew-drill <app>` running `snapshot.sh drill scheduled` hourly; approved by its hash with `allowDestroy` and `<app>-drill` typed, since the program removes what it makes; its text names every R29 bound and what root on the server can do (the clause's honesty); the schedule's removal and destroy's teardown remove the line, the recipe and `values.env` (and any `<app>-drill` leftovers); inspection reads them so a second plan is in place and drift can see a change.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host --filter=@opscrew/agents && npx vitest run --root packages/connectors/ssh-host && npx vitest run --root packages/agents src/provision && pnpm lint`
  - Effort: xhigh

- [ ] T2937 [P] [US7] Scheduled dump drills in a Portainer
  - Owns: `packages/iac-templates/src/portainer-target/{snapshots,stack}.ts`, colocated tests,
    snapshots and `snapshots.docker.test.ts`
  - Reads: plan 19.; research R28, R29; `docs/guide/portainer-target.md`
  - Depends: T2936
  - Accept: with `snapshots.drills.schedule`, the stack gains one loop service per database part
    (PostgreSQL, MySQL, MariaDB, MongoDB) from the part's image, `network_mode: none`, the snapshots
    volume `read_only: true` and a scratch volume: in its slot it starts a scratch server of its own,
    restores the latest dump, counts tables or collections, stops and clears the scratch, and logs
    one line (no values); a kind whose image can't run so is left out with a line saying so; the
    Docker-gated test runs each kind (`OPSCREW_DOCKER_TESTS=1`); stacks without the setting are
    byte-identical.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/portainer-target && pnpm lint`
  - Effort: high

- [ ] T2938 [P] [US7] Scheduled drills on a hosting account
  - Owns: `packages/iac-templates/src/hosting/agent/**`, `packages/iac-templates/src/hosting/agent.ts` (the settings renderer), `packages/agents/src/hosting/{provision-plans,plan}.ts`
    (the agent's settings), colocated tests
  - Also (lead, T2936's finding): `opscrew snapshot drill schedule on|off` works on a panel account (cPanel, Plesk, DirectAdmin): `packages/agents/src/snapshot/schedule.ts` is in Owns for that path only (today `snapshotTarget` refuses it); SFTP-only hosts still refuse.
  - Also (lead, T2935's findings): the scheduled run calls `drill_snapshot <id> scheduled` on the newest `snapshot-*` id, with a 30-minute limit and a skip (recorded, never a failure) when the account's quota leaves less free space than the dump's size; a cPanel `addDatabase` that fails after the database was made removes it again before reporting, so the next provision doesn't stop at "not OpsCrew's"
  - Reads: plan 19.; research R28, R29; T2935's drill routine
  - Depends: T2935, T2936
  - Accept: with `snapshots.drills.schedule`, the agent's settings carry it, and the agent starts a
    drill itself in the slot when the latest snapshot is newer than the last drill: T2935's routine,
    no panel call, under its lock between releases, recorded in its `state/`; turned off by the
    setting's removal.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/iac-templates src/hosting && npx vitest run --root packages/agents src/hosting && pnpm lint`
  - Effort: high

- [ ] T2939 [US7] Drills in status for every target, and the guide
  - Owns: `packages/agents/src/status/drill.ts`, `docs/guide/{snapshots,alerts,portainer-target,hosting-accounts}.md`,
    colocated tests
  - Reads: plan 19.; research R27, R29; the records T2934, T2935, T2937 and T2938 write
    (a Portainer's manual drills: `readPortainerDrills(paths)` in `snapshot/drill-portainer.ts`, `.opscrew/…/drills.json`; a hosting account's: `state/drills.log` on the account, `hostingDrillSummary`; a server's and this computer's: `.snapshots/drills.log`); on hosting a successful drill's outcome reads "the dump loaded with N tables", never "healthy"
  - Depends: T2934, T2935, T2937, T2938
  - Words for the scheduled drill's new reasons (T2936): `kept` (a kept copy is still there), `none` (no scheduled snapshot yet), `version` (the snapshot names no version).
  - And hosting's (T2938): `login` (no drill database login yet), `quota` (the account's quota leaves less room than the dump), `timeout`, `stopped`; hosting's `failed` lines carry `parts=-` and `tables=-`. The guide says the quota check reads the account's file quota, which on many hosts doesn't count the database's space.
  - The guide also says (T2933, accepted by the lead): on a split plan a drill runs on the app's server with its parts, and parts on other servers aren't drilled; the table check covers PostgreSQL, MySQL, MariaDB and MongoDB (a cache may be empty); the copy uses `.env.preview`'s values; `--allow-other-version` uses the image the app runs today; where the server has no `/proc/meminfo` the memory check is skipped.
  - Accept: `opscrew status` shows the last drill on each target (snapshot, time, duration, the
    outcome or "skipped" with the reason, R27's row), and with a schedule "no drill within two
    weeks" as a warning; the guide: what a drill proves on each target (R27's table), the command,
    the approval, the isolation and what the user may need in the preview values, the schedule and
    its bounds with what root (or the account's user) can do, the alerts and where there are none,
    the drill database on a hosting account and its limit.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/status && pnpm lint`
  - Effort: high

- [ ] T2940 [US7] The drill steps in the live tests
  - Owns: `packages/cli/test/live/{snapshots-checks,snapshots-support,portainer-support,portainer-target.test,cpanel-support,cpanel.test}.ts`,
    `docs/e2e.md` (their sections)
  - Reads: plan 18. (H8), 19.; the live files' patterns
  - Depends: T2939
  - Accept: a drill step and a scheduled-drill step (the script's `drill scheduled` run at its slot
    by the test) in the server snapshots live test, the Portainer live test (the manual drill and the
    dump loop) and the cPanel live test (the drill database made, the drill, removed at destroy);
    each step checks production unchanged and, on servers, that a request from the copy to the
    internet fails.
    On the cPanel account (T2935's notes): whether `my_print_defaults` exists, and that the snapshot, the restore and the drill connect (with a socket found in the account's option files and with the built-in default); that a dump whose views or triggers carry `DEFINER=` loads in the drill; the Portainer step confirms that `internal: true` reaches the deployed network and how a gone image is reported (T2934).
  - Verify: `pnpm turbo run typecheck --filter=opscrew && pnpm lint`
  - Effort: high

## Phase 12: Lead

- [ ] T2920 (lead) The live pass H0–H8 (plan 18., quickstart), results in `docs/e2e-coverage.md`
- [ ] T2921 (lead) /simplify over the feature, and the repeated strings gathered (noted: `dnsModule` in `infra/cloudflare.ts` takes an optional `ipv4Record` so `infra/own.ts`'s home `module "dns"` stops repeating five arguments; `token.ts`'s `reachText` beside `updaterTokenReach`; the token recipe's "run `opscrew provision` again" in design's summary; `detectHomeNetwork` made required on `HostAdapterApi` once the fakes have it; a test in agents that `runbook/own.ts`'s updater unit names and paths equal ssh-host's `dns-updater.ts` constants, as iac-templates doesn't depend on ssh-host; one `UpdaterStateSchema` in `home/` for status and verify; one pi-power text; one away-from-home helper for status, verify and secure; who owns the SSH table on a machine that is both a runner host with `harden.firewall` and an app server, so neither plan removes the other's, T2943's finding)
- [ ] T2922 (lead) CLAUDE.md and the roadmap (029 done)
- [ ] T2923 (lead) The release (`docs/releasing.md`); the CHANGELOG names the moves-only plan every
  app with DNS on Cloudflare gets at its next provision (`a` → `a[0]`), and the web filter's new nftables drop-in every server with origin protection gets (T2943)

## Dependencies

Wave 1 (T2902, T2903, T2909, T2911) → wave 2 (T2904, T2907, T2910a, T2910b) → wave 3 (T2905, T2908,
T2910c, T2912) → wave 4 (T2906, T2910d, T2914d) → wave 5 (T2913a) → wave 6 (T2913b, T2914a, T2914b,
T2915a) → wave 7 (T2914c, T2915b, T2916a, T2916b) → wave 8 (T2917, T2918) → wave 9 (T2919) → lead.
Drills: T2931 and T2932 beside wave 1; T2933 beside wave 2; T2934, T2935, T2936 beside wave 3; T2937, T2938 and T2944 beside wave 4 (T2944 after T2943); T2939 beside wave 5; T2940 beside wave 9. A wave's tasks share no file.

## User stories

US1 static home address (T2902, T2903, T2907, T2908, T2910a, T2910d, T2911, T2912, T2913a, T2913b,
T2914a, T2914d); US2 changing address (T2904, T2909, T2910b, T2910c, T2913a, T2914a–c, T2915a, T2915b,
T2916b); US3 no public IPv4 or blocked ports (T2903, T2910a, T2910d, T2912, T2914a); US4 IPv6
(T2906, T2907, T2910a, T2912, T2913a); US5 a Raspberry Pi (T2903, T2912, T2914a, T2914b). US6 cut.
MVP: US1 and US2 together (a home server is unusable without the updater on a dynamic line). US7 restore drills (T2931, T2933–T2940); US8 the database check (T2932).
