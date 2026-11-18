---
description: "Tasks for 028-cloudflare-account-move"
---

# Tasks: Moving an app to another Cloudflare account

**Status**: DRAFT, revised after the lead's review and the founder's decisions of 2026-11-14.

**Input**: `specs/028-cloudflare-account-move/` (spec.md, plan.md, data-model.md, research.md R1–R9,
R10 after T2802) + features 007, 011, 013, 014, 015, 016, 023, 025; ADR 0014, 0017, 0027, 0032.

**Numbering**: T2801–T2899.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Decided by the lead /
Accept / Verify / Effort`. Implementers never edit `tasks.md`, specs, root configuration, a
`package.json`'s dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Two accounts in every agents test:** the two-account Cloudflare fake (T2805), one token per
  account, so a call made with the wrong token fails the test. Zones are always looked up with their
  account.
- **Approvals:** every change through the approval plan.md's Constitution Check (I) names; deletions
  with `allowDestroy` and the typed name; A's pieces never change before the finish, except the DS
  record and the nameservers in the switch.
- **Leaks:** no token, key, certificate, connector token, R2 key or server address in output, plans,
  `-var`s, logs, audit entries, the move's record, the marks or MCP answers. Every agents task's tests
  include a leak check over everything its fakes saw.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to do
  next. User-facing text never names a feature or task number.
- **`cloudflare-move/types.ts`** is T2810's; a later task that needs a field asks the lead.
- **Text:** each task keeps the strings its files show in those files; T2828 gathers repeats.
- **No network in unit tests;** fakes for Cloudflare, the registrars, GitHub, the engine (or the real
  engines from `.tools/bin` where a test needs `init`, skipping without them), servers, Portainer.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Examples:** neutral only, `example.com`, `example-app`, `203.0.113.0/24`.

## Phase 1: Foundation (lead)

- [x] T2801 The contract, ADR 0032 and the scaffold (lead)
  - Owns: `packages/contracts/src/runtime.ts`, `docs/adr/0032-*.md`, `packages/agents/src/cloudflare-move/{index,prepare,switch,finish,abort}.ts`, the export line in `packages/agents/src/index.ts`
  - Accept:
    - `PHASES` gains `cloudflare-move` after `retarget`.
    - ADR 0032 accepted.
    - `prepare.ts`, `switch.ts`, `finish.ts`, `abort.ts` export `prepareMove`, `switchMove`,
      `finishMove`, `abortMove` stubs (`(deps: PhaseDeps, options: unknown)`, throwing `INTERNAL` "not
      built yet"); `cloudflare-move/index.ts` exports them; `agents/src/index.ts` exports
      `./cloudflare-move`.
  - Verify: `pnpm check`
  - Effort: lead

- [x] T2802 Spike S1 on the two accounts, and research R10 (lead)
  - Owns: research R10 in `specs/028-cloudflare-account-move/research.md`; the plan and wave 3's blocks where an answer is "no"
  - Needs: the founder's account B (R2 and Zero Trust on). The zone is opscrew.dev itself, active in A:
    a pending zone for it in B serves nothing.
  - Accept: the API's own answers (ids masked); for each "no", plan 13.'s fallback taken into the plan
    and the blocks of wave 3 before it starts:
    1. `POST /zones` in B for the zone active in A: accepted as pending? B's nameserver pair differs?
    2. On the pending zone: a proxied A record; a proxied CNAME to a tunnel of B; a self-hosted
       Access application on a hostname of it; an Origin CA certificate for its hostnames; a hostname
       client certificate upload and per-hostname AOP: accepted? Which status (`pending_deployment`,
       `active`)?
    3. What B's nameservers answer for the pending zone (`node:dns` `Resolver` pointed at them).
    4. An R2 bucket in B with the name of one in A: accepted?
    5. The `meta` fields `GET /zones/{id}/dns_records` returns for a Worker's custom domain record and
       other Cloudflare-managed records.
    6. `GET /zones/{id}/hold`.
    7. O2: an Origin CA certificate issued in each account (for a hostname of a zone there), compared
       by issuer and chain; the same root is taken as "accepted across accounts", which the real move
       confirms.
    8. Where opscrew.dev is registered (`getRegistration` in A; else the public registrar).
    - Everything the spike made is removed, and both accounts are listed afterwards.
  - Effort: lead

## Phase 1b: Build arguments from the plan (founder, 2026-11-14; independent of the move)

Asked for through the first app's session: a non-secret build setting whatever its name (for example a list of plugins pinned to commits) reaches a Dockerfile build, as the browser-prefixed variables do. It can ship before the move.

- [x] T2831 A plan variable marked as a build argument
  - Owns: `packages/plan-schema/src/plan.ts` (the app's `env` entry) and `packages/plan-schema/schemas/**`; `packages/iac-templates/src/{workflow/build.ts,docker/**,portainer-target/stack.ts}`; `packages/agents/src/{shared/app-env.ts,localhost/apply.ts,design/builder.ts}`; `docs/guide/builders.md`; the colocated tests and snapshots
  - Reads: `docs/guide/builders.md` (the browser prefixes, secret mounts); `CLIENT_ENV_PREFIXES` and `isClientExposedEnvName` in `iac-templates/src/docker/stacks.ts`
  - Decided by the lead:
    - The mark is `buildArg: true` on an entry of `app.env` in `opscrew/plan.yaml` (`- name: PLUGINS`, `secret: false`, `source: user`, `buildArg: true`). `buildArg: true` with `secret: true` is refused by the schema, in plain words: a secret reaches the build only as a secret mount.
    - A marked variable goes to a Dockerfile build with `--build-arg` everywhere a browser-prefixed one does (the deploy workflow's build, Portainer's and this computer's builds), from the same values, and the provenance record lists it as it lists them. Unmarked variables behave exactly as today.
    - Buildpacks and Railpack builds: as the browser-prefixed variables reach them today, or not at all if they reach them not; the guide says which.
  - Accept: the schema field and its refusal; every build path passes marked variables as build arguments; tests for each path and the refusal; `docs/guide/builders.md` describes `buildArg: true` next to the browser prefixes, with a neutral example (a list of plugins pinned to commits).
  - Verify: `pnpm --filter @opscrew/plan-schema gen:schemas && pnpm turbo run typecheck --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/plan-schema && npx vitest run --root packages/iac-templates src/workflow src/docker src/portainer-target && npx vitest run --root packages/agents src/shared src/localhost src/design && pnpm lint`
  - Effort: high

- [x] T2834 A further app's analysis reads its own folder (bug in 0.2.8, reported through the first app's session)
  - Owns: `packages/detect/src/**`, `packages/agents/src/analyze/**`, `packages/agents/src/apps/**` (only if the app's folder is recorded wrongly), the colocated tests and fixtures
  - Reads: `docs/guide/several-apps.md`; `detectProjectDetails`, `normalizeAppDir`; `packages/detect/src/env.ts`
  - Found: in a pnpm workspace, `opscrew app add pay --dir apps/pay` then `opscrew analyze --app pay --no-ai` wrote `opscrew/apps/pay/architecture.json` with the whole repository's facts: `facts.envVars` held the 37 names of the root `.env.example` and none of the app's three `VITE_` settings (read through Vite's `loadEnv(mode, cwd, "VITE_")` in `vite.config.ts` and a file it imports, never `import.meta.env`); `facts.services` held PostgreSQL from `apps/server` (`dependency:pg`, `env:DATABASE_URL`); `facts.frameworks` held React from `apps/web`. Design for Cloudflare's hosting then refused it for PostgreSQL.
  - Accept:
    - For an app with an `appDir`, envVars, services and frameworks come from that folder only, plus its `sharedPaths`; a root `.env.example` counts only for the first app at the root.
    - Settings read through `loadEnv(…, "VITE_")` or `env.VITE_X` in `vite.config.*` and the files it imports are detected, as client-exposed.
    - A fixture shaped like the report (a workspace with a root `.env.example`, a server app with `pg`, a React app, and a Vite app reading three `VITE_` settings through `loadEnv`): the Vite app's facts hold only its own; the first app's analysis is unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/detect --filter=@opscrew/agents && npx vitest run --root packages/detect && npx vitest run --root packages/agents src/analyze src/apps && pnpm lint`
  - Effort: high

## Phase 2: Wave 1 (parallel)

- [x] T2803 [P] [US1] The move's record in the plan
  - Owns: `packages/plan-schema/src/**`, `packages/plan-schema/schemas/**`
  - Reads: data-model 1; `plan-schema/src/plan.ts` (`RetargetSchema`, `checkRetarget`)
  - Depends: T2801
  - Accept:
    - `CloudflareMoveSchema` (strict) as data-model 1, with `CloudflareIdSchema` (32 lower-case hex);
      `DeployPlan.cloudflareMove` optional; `type CloudflareMove`.
    - Refinements with plain messages: never beside `retarget`; never in a preview environment's
      plan; `to.accountId` differs from `from.accountId`; `abort` only with `started` or `prepared`;
      `zone` equals `dns.zone` when the plan names one.
    - The JSON schemas regenerated; every existing fixture parses as before.
  - Verify: `pnpm --filter @opscrew/plan-schema gen:schemas && pnpm turbo run typecheck --filter=@opscrew/plan-schema && npx vitest run --root packages/plan-schema && pnpm lint`
  - Effort: medium

- [x] T2804 [P] [US1] [US4] [US5] Cloudflare's client: zones, records, holds, Workers domains, probes
  - Owns: `packages/connectors/cloudflare/src/client.ts`, `packages/connectors/cloudflare/src/index.ts`, new `packages/connectors/cloudflare/src/client-move*.test.ts`
  - Reads: plan 3., 4., 5., 13.; research R1, R5, R8, R10; Cloudflare's API reference (official pages only) for each call
  - Depends: T2801
  - Decided by the lead: every new call is a `CloudflareClient` method (one file per task in this
    wave: T2805 owns the fake and the shared adapter).
  - Accept:
    - **Zones:** `findZone(domain, { accountId? })` sends `account.id` when given, reads every match
      (not `per_page=1`) and prefers `active` over any other status; `getZone(id)` (status,
      nameservers); `deleteZone(id)`; `zoneHold(id)` (`{ hold: boolean }`).
    - **Records with every field:** `listZoneRecords(zoneId)` (type, name, content, `data`, ttl,
      proxied, priority, comment, and the `meta` fields that mark a record as Cloudflare's own);
      `createZoneRecords(zoneId, records)` in batches of 200 keeping every field; `deleteRecord(zoneId,
      id)`.
    - **Workers custom domains:** `listZoneWorkerDomains(accountId, zoneId)`;
      `attachWorkerDomain(accountId, { hostname, zoneId, service })`, answering its id;
      `detachWorkerDomain(accountId, id)`.
    - **Permission probes** (read-only calls): `accountPermissions(accountId, needs)` for `tunnel`,
      `access-apps`, `access-service-tokens`, `access-organization`, `r2`, `workers`;
      `zonePermissions(zoneId, needs)` for DNS, each OpsCrew rule phase, SSL and certificates, zone
      settings; each answering the missing ones as the token builder names them.
    - Exported from the package root. Tests with `fetch` fakes for each call and its failures (403
      permission, 409 zone in another account, rate limits), a token that sees two accounts (the
      filter decides), a moved zone beside an active one, and no token in any error.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-cloudflare && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: high

- [x] T2805 [P] [US1] [US2] The two-account Cloudflare fake, and the shared adapter on a pending zone
  - Owns: `packages/connectors/cloudflare/src/testing/**`, `packages/connectors/cloudflare/src/shared.ts` (+ its tests)
  - Reads: plan 3., 4.4, 5., 6.; `testing/{index,fake-zone}.ts`; Cloudflare's API reference for each endpoint the fake answers
  - Depends: T2801
  - Accept:
    - **`fakeCloudflareAccounts(options)`** in `@opscrew/connector-cloudflare/testing`: a `fetch` that
      answers Cloudflare's HTTP API for several accounts, each reached by its own token: zones
      (create, delete, `account.id` filter, holds), each zone's status moving pending → active →
      moved with its nameservers and the activation check (rate-limited as on a free zone);
      records with `meta`; rulesets; certificate packs; Origin CA certificates; hostname client
      certificates and AOP settings; DNSSEC; tunnels with their connections; Access applications,
      policies, service tokens, organization and identity providers; R2 buckets; Workers scripts,
      subdomains and custom domains by zone; the permission probes' endpoints, with permissions
      withheld per token. A call with a token of another account is refused as Cloudflare does.
      `activate(zone)` and `move(zone)` let a test drive the zones; every call is recorded for leak
      checks.
    - **`applyShared(…, { waitForActive })`:** with `false`, the apply doesn't wait for AOP and
      certificate settings to be `active` (a pending zone); default `true`, so nothing else changes.
    - Tests of the fake through `CloudflareClient`'s existing methods and raw requests to the
      endpoints above; the shared adapter's suite unchanged plus the new option.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-cloudflare && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: xhigh

- [x] T2806 [P] [US1] The connector beside A's on a server
  - Owns: `packages/connectors/ssh-host/src/**`
  - Reads: plan 4.4, 7.4, 8.; `ssh-host/src/plan.ts` (`planTunnelToken`, `tunnelConnectorStep`, `tunnelDir`)
  - Depends: T2801
  - Accept:
    - `planNextTunnelConnector({ app, runAs, connector: { dir?, compose, tunnelId } })`: one step that
      writes the Compose file and a token file only its owner reads in `<tunnelDir>-next` (or `dir`),
      the token supplied at apply time on standard input and never part of the plan, and starts it;
      its title and reason say it runs the new account's connector beside the current one.
    - `planNextTunnelConnectorRemoval({ app, runAs, dir? })`: stops and removes that project and its
      folder, never the main connector's.
    - Both validated before any approval (`stepScripts`). Tests: the scripts (snapshots), the token
      absent from the plan and its hash, the removal leaving the main folder.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: medium

- [x] T2807 [P] [US1] [US2] [US4] Templates: Cloudflare's addresses, B's ids, record names, the beside connector
  - Owns: new files `packages/iac-templates/src/infra/cloudflare-move*.ts`, `packages/iac-templates/src/runtime/tunnel-next*.ts`, `packages/iac-templates/src/portainer-target/next-connector*.ts` (+ their snapshots), and their export lines in `packages/iac-templates/src/{index,infra/index,runtime/index,portainer-target/index}.ts`
  - Reads: plan 3., 9.; data-model 3, 4; `infra/{index,cloudflare,tunnel,own,portainer,serverless,storage}.ts`, `hosting/dns.ts`, `runtime/index.ts`, `portainer-target/stack.ts`, the vendored modules under `packages/iac-templates/modules/`
  - Depends: T2801
  - Accept:
    - **`cloudflareAddressScope(address)`** (data-model 3) and `CLOUDFLARE_MODULE_NAMES` (`dns`,
      `tunnel`, `access`, `portainer_tunnel`, `worker`). A test renders every target's roots (cloud,
      own public and tunnel, Portainer in each web mode, Workers, Pages and its verification root, a
      hosting account's DNS root, R2 storage and backups) and checks every resource address in them:
      servers, networks, firewalls and `random_*`/`terraform_data` outside those modules are not
      Cloudflare's; `cloudflare_dns_record` and `cloudflare_certificate_pack` are zone-scoped; the
      rest account-scoped.
    - **`accountVariables(root, ctx)`:** the root's id variables (`cloudflare_zone_id`,
      `cloudflare_account_id`, `one_time_pin_identity_provider_id`, those it declares) as strings. A
      test renders every root above with two `CloudflareSetup`s and proves the two
      `terraform.tfvars.json` differ only in these keys.
    - **`opscrewRecordNames(plan, zone)`:** every DNS name the plan's roots give an OpsCrew record or
      a Worker custom domain, sorted; checked against the rendered HCL of each target.
      `workerCustomDomainAddresses(plan)`: `module.worker.cloudflare_workers_custom_domain.domain[0]`
      and `.www[0]` with their hostnames.
    - **The beside connector:** `renderNextTunnelConnectorCompose(plan)` (`<app>-tunnel-next` in
      `cloudflared-next/`, the host network, `tunnel.env` beside it); `renderNextConnectorStacks(plan)`
      for Portainer: `opscrew-<app>-tunnel-next` (web mode `tunnel`: cloudflared on the app stack's
      network `<stack>_internal` as an external network, reaching `caddy:80`) and
      `opscrew-<app>-portainer-tunnel-next` (redeploy `cloudflare`), each with `TUNNEL_TOKEN` from the
      stack's environment.
    - **Docker-gated test** (`OPSCREW_DOCKER_TESTS=1`): the app stack's template and the beside stack
      (curl in cloudflared's place) under `docker compose`: the beside container reaches `caddy:80`.
    - Every existing snapshot unchanged.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/infra/cloudflare-move src/runtime src/portainer-target src/hosting && pnpm lint`
  - Effort: high

- [x] T2808 [P] [US1] [US4] Templates: the workflows' `_NEW` paths and the Workers root's `custom_domains`
  - Owns: `packages/iac-templates/src/workflow/{index,portainer,cloudflare-workers}.ts` (the parts below), `packages/iac-templates/src/infra/serverless.ts`, the snapshots and tests those change
  - Reads: plan 4.1, 10.; data-model 6; `workflow/index.ts` (the tunnel's `ProxyCommand`, `TUNNEL_DEPLOY_SECRETS`), `workflow/portainer.ts` (`WEBHOOK_CALL`, `PORTAINER_DEPLOY_SECRETS`), `workflow/cloudflare-workers.ts` (`CLOUDFLARE_DEPLOY_SECRETS`), `infra/serverless.ts` (`workerHost`)
  - Depends: T2801
  - Decided by the lead: the `_NEW` names are fields of the existing secret-name objects
    (`TUNNEL_DEPLOY_SECRETS.serviceTokenIdNew`…), so no new top-level export.
  - Accept:
    - **Tunnel SSH:** the job's env gains the `_NEW` service token; the generated `ProxyCommand` runs
      `cloudflared access ssh` with A's token and, when that fails and the `_NEW` token is set, once
      more with B's. A script test runs it with a stub `cloudflared` that refuses A's token.
    - **Portainer's webhook:** the call is made with A's Access headers and, when Access refuses
      them (403, or a redirect to its login) and the `_NEW` client is set, once more with B's (in a
      file only the runner user reads, as today). A script test with a stub `curl`.
    - **Workers:** while `CLOUDFLARE_API_TOKEN_NEW` is set, a second deploy step deploys the same
      build and secrets to `CLOUDFLARE_ACCOUNT_ID_NEW`; without it nothing runs.
    - **The Workers root:** `custom_domains` becomes a root variable (`true` in
      `terraform.tfvars.json`), passed to `module "worker"`; the move's shell is `-var
      custom_domains=false`. Both engines `validate`.
    - Without `_NEW` secrets every workflow behaves as before; the snapshots change only by these
      lines, for the targets named, and `isMoveReady(plan, committed)` tells T2810 whether committed
      files have them.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/workflow src/infra/serverless && pnpm lint`
  - Effort: high

- [x] T2809 [P] [US5] The domain commands' pieces, for the move
  - Owns: `packages/agents/src/domain/**`
  - Reads: plan 5.; data-model 2, 5; `domain/{connect,switch,connect-plan,connect-state,connect-dns,services,registrars}.ts`
  - Depends: T2801
  - Accept: exported from `domain/index.ts`, with `domain connect` built on them and its tests unchanged:
    - `findDomainRegistrar(deps, services, domain, cloudflareAccount)`: `{ kind: "api", registrarId,
      registrar }` for the one configured Porkbun, Namecheap or GoDaddy account that owns it,
      `{ kind: "cloudflare" }` when Cloudflare Registrar holds it in that account, else
      `{ kind: "other" }`; never throws for "not found".
    - `readDs(ctx)`, `removeDsAndWait(ctx, stateFile)` (the wait note written to the given file) and
      `dsWaitStatus(stateFile, now)`.
    - `domainZonesFrom(client)`: a `DomainZoneApi` over any `CloudflareClient` (B's).
    - `publicNameservers(fetch, domain)`: the delegation from a DNS-over-HTTPS lookup.
    - `recordsMissingFromZone(source, zone)` and `sameRecordContent(a, b)`: connect-plan's
      comparison (type, name, normalised content) for zone-to-zone records with every field.
    - Tests against the registrar fakes, a Cloudflare Registrar domain, an unknown registrar, and
      connect's suite unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/domain && pnpm lint`
  - Effort: high

## Phase 3: Wave 2 (parallel)

- [x] T2810 [P] [US1] [US2] The move's types, its session, the checks and the summary
  - Owns: `packages/agents/src/cloudflare-move/{types,session,checks,summary,texts}*.ts`, the type export line in `packages/agents/src/cloudflare-move/index.ts`
  - Lead note (after T2812): the checks refuse a recorded `plan.retarget` plainly before the move's record is written (today only the plan-schema rule stops it); the guard is `requireNoCloudflareMove` in `provision/guard.ts`, the record's steps in `cloudflare-move/record.ts`, the local files in `cloudflare-move/progress.ts`.
  - Reads: plan 4.1, 4.2, 11.; spec FR-2802 and the edge cases; `retarget/{session,start}.ts`, `domain/common.ts` (`resolveAccount`), `environments/{list,paths}.ts`, `serverless/cloudflare/checks.ts`
  - Depends: T2803, T2804, T2805, T2808, T2809
  - Decided by the lead: B's token is `OPSCREW_NEW_CLOUDFLARE_API_TOKEN`, A's `CLOUDFLARE_API_TOKEN`;
    both registered with the redactor before any call.
  - Accept:
    - **`types.ts`:** `MoveAccounts` (both `CloudflareClient`s, account and zone ids, B's
      `CloudflareSetup`), `MoveSession` (deps, services, the app's paths, the covered environments
      with their plans, both accounts, GitHub, `approve`, `command`), `MoveServices` (the fakes'
      seams: both Cloudflare APIs, engine, GitHub, remote, host, Portainer, Docker, registrars,
      `sleep`, `now`, `fetch`), `ShadowRoot` (`name`, `dir`, `statePath`, `dataDir`, `vars`),
      `StepStop`, `MoveResult`, and each step's options.
    - **`openMoveSession(deps, options)`:** the covered environments (the zone: `dns.zone`, else
      `findZone(dns.domain)` with A's token; those in another zone named as staying; a destroyed one
      skipped and named), A's account from A's zone, B's from `--to` (id or exact name), B's
      `CloudflareSetup` once B's zone exists, GitHub, the engine and the state passphrase as
      `existingStateEngine` reads them.
    - **Refusals before any change** (the spec's edge cases): a missing or wrong token, B equal to A,
      A's zone not active or held, a retarget or another move for the zone, a preview environment, the
      localhost target, B's missing account permissions (only those the app's pieces need), and
      committed files the move can't use yet (`isMoveReady`: "run `opscrew provision`, commit, then
      start the move").
    - **The other apps** found in A's zone, by hostname.
    - `moveSummary(session, sizes)` (plan 4.2); `confirmStart` refused → nothing changed.
    - Tests with the two-account fake: several environments (one in another zone), several apps,
      every refusal, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: high

- [x] T2811 [P] [US1] [US3] Provision's seams the move plans through
  - Owns: `packages/agents/src/provision/{plan-apply,credentials,shared-cloudflare,origin-tls,storage}.ts` (+ tests)
  - Lead note (after T2805): whenever B's zone is pending, pass `pendingZone: true` to `inspectShared` together with `waitForActive: false` to `applyShared`, so B's shared plan settles after its first apply.
  - Reads: plan 3., 4.4, 7.6, 11.; data-model 7; T2804's and T2805's blocks
  - Depends: T2804, T2805
  - Accept:
    - **`planAndApply`:** `vars` (passed to `plan` and kept by `planRunOptions` when a plan is made
      again); a `move` option that skips the server providers' follow-ups (`syncFirewalls`,
      `syncProviderBackups`, `markWantedBackups`), names its token variable in the hints
      (`OPSCREW_NEW_CLOUDFLARE_API_TOKEN` instead of `CLOUDFLARE_API_TOKEN`) and saves under
      `MOVE_PLAN_SUFFIX` (`-move.tfplan`), which provision, retarget, a Portainer change and
      rotation refuse to apply as they refuse `ROTATION_PLAN_SUFFIX`; callers pass `costDelta: null`.
      Every caller compiles unchanged.
    - **`setupCloudflare`:** `accountId?` passed to `findZone`; a zone whose status is `moved`
      refused: "<zone> moved to another Cloudflare account: set CLOUDFLARE_API_TOKEN to that account's
      token, then run the command again. Nothing was changed."
    - **The shared plan:** `planSharedCloudflare` and `applySharedCloudflare` take an optional record
      path and client (B's), and pass `waitForActive: false` on a pending zone; defaults unchanged.
    - **Origin TLS:** `originTlsNext` read, kept, promoted (`promoteNextOriginTls`) and forgotten;
      every key registered with the redactor.
    - **Bucket keys:** `requireStorageKey` and `requireOffsiteKey` take an R2 bucket's account; kept
      keys carry `account`; `NEW_OFFSITE_KEY_VARS` (`OPSCREW_NEW_OFFSITE_ACCESS_KEY_ID`,
      `OPSCREW_NEW_OFFSITE_SECRET_ACCESS_KEY`) for B's backups bucket; a kept key without `account`
      still matches.
    - Provision's tests pass unchanged; new tests for each seam, with a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/provision && pnpm lint`
  - Effort: high

- [x] T2812 [P] [US1] [US2] The record, the local files, and the guards
  - Owns: `packages/agents/src/cloudflare-move/{record,progress}*.ts`, `packages/agents/src/provision/guard*.ts`, the guard in `packages/agents/src/destroy/run.ts`, the refusal in `packages/agents/src/retarget/{run,start}.ts`, the guard lines in `packages/agents/src/rotate/**` entry points and `packages/agents/src/environments/{add,previews}.ts`, the opt-out in `packages/agents/src/design/run.ts` (+ tests)
  - Reads: plan 2., 11.; data-model 1, 2; `retarget/pending.ts`, `provision/guard.ts`, `destroy/run.ts`, `rotate/` (each exported rotation), `environments/{add,previews}.ts`
  - Depends: T2803
  - Accept:
    - `record.ts`: read and write `cloudflareMove` in each covered plan (atomic); step transitions.
    - `progress.ts`: data-model 2's two files (zod, atomic), the pending plan as retarget's
      (`writePending`, `pendingMatches`, `clearPending` by action, environment and root).
    - **`requireNoCloudflareMove(plan)`** ("A move of <zone> to another Cloudflare account is in
      progress." with its step's hint: continue, `--switch`, `--finish`, `--abort`), called by
      `requireNoMoveInProgress` unless `{ allowCloudflareMove: true }` (which design passes), by
      `destroy` and by `retarget` (whose start also refuses, and the move refuses during a retarget).
      Snapshot, rollback and advise don't call it; `moveInProgress`'s messages stay retarget's.
    - Every rotation refuses at its entry point; adding a preview environment refuses.
    - Tests: each guard per step, design and snapshot still allowed, the record's round trip, a
      damaged local file read as absent.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move src/provision/guard src/destroy src/retarget/run src/retarget/start src/rotate src/environments src/design && pnpm lint`
  - Effort: high

## Phase 4: Wave 3 (parallel; after T2802's results)

- [x] T2813 [P] [US1] [US3] [US4] Shadow states
  - Owns: `packages/agents/src/cloudflare-move/shadow*.ts`
  - Lead note (after the spike, plan 13b): B's shadow plans set `access_applications = false` and `protected_route_records = false` (the roots' variables from T2835) while B's zone is pending.
  - Lead note (after T2810): `checkMoveStart` (T2810) already refuses when a covered environment's infrastructure state is not on this computer; shadow states can rely on it.
  - Lead note (after T2807): `accountVariables(tfvars, ctx)` takes the root's parsed `terraform.tfvars.json` and `{ cloudflare: { zoneId, accountId, oneTimePinIdentityProviderId } }` from B's setup.
  - Reads: plan 3.; data-model 3; research R10; `shared/engine.ts`, `provision/plan-apply.ts`, `retarget/plans.ts` (`planBounded`, saved-plan approvals), `provision/storage.ts`, `destroy/deletion.ts`
  - Depends: T2802, T2807, T2808, T2810, T2811, T2812
  - Accept:
    - `shadowRoots(session, environment)`: the roots of plan 3., each a `ShadowRoot` (data-model 3,
      `vars` from `accountVariables` with B's setup, plus `custom_domains=false` for a site's root).
    - `seedShadow(root)`: the environment's state copied, every Cloudflare address removed
      (`stateRemove`) against the shadow backend; no environment state → empty; seeded → kept.
    - `planShadow(session, root)`: plan 3.'s planning through `planAndApply`'s `move` option;
      `planBounded` allowing only creates of Cloudflare addresses; scripts stop with the hash,
      `--approve` applies the saved plan.
    - `shadowOutputs(root)`; `importIntoShadow(root, address, id)` (`importResource`);
      `swapShadow(root)` (two renames, resumable from the files present); `patchTfvars(root)` (only
      `accountVariables`' keys); `checkAfterSwap(session, root)` (`planBounded`: no change, or
      in-place updates of Cloudflare addresses only, approved by hash); `prepareRemoval(root)`
      (non-Cloudflare and zone-scoped addresses removed); `planRemoval(session, root, side)` (destroy
      plan with that side's token, ids and data folder: A's account-scoped pieces, or all of B's;
      `allowDestroy`, the app's name typed); `dropShadow(root)`.
    - Tests with the real engines from `.tools/bin` (skipping without them) on a fixture root with a
      server-like resource and Cloudflare-like resources behind a mock provider: seed, plan, import,
      swap, patch, check, removal, resuming after each rename; both engines; OpenTofu encryption;
      `-var`s with ids only.
  - Verify: `PATH="$PWD/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/shadow && pnpm lint`
  - Effort: xhigh

- [x] T2814 [P] [US1] B's shared plan, A's Origin CA certificate, B's shared removal
  - Owns: `packages/agents/src/cloudflare-move/shared*.ts`
  - Lead note (after the spike, plan 13b): on a pending zone B's shared plan passes `originLater: true` in its `tls` (connector, commit d2329847): origin pulls set, no certificate; B's Origin CA certificate is issued at the finish.
  - Lead note (after T2805): whenever B's zone is pending, pass `pendingZone: true` to `inspectShared` together with `waitForActive: false` to `applyShared`, so B's shared plan settles after its first apply.
  - Reads: plan 4.4.1, 7.7, 8.; ADR 0014, ADR 0017; `provision/{shared-cloudflare,origin-tls}.ts`; research R10.2, R10.7
  - Depends: T2802, T2805, T2810, T2811
  - Accept:
    - `planBShared(session, environment)`: provision's shared plan for this environment in B's zone
      with B's client and record (plan 4.4.1), approved by hash, `waitForActive: false` on a pending
      zone (or O1's fallback, per R10).
    - `revokeAOrigin(session, environment)`: A's Origin CA certificate of the app revoked with A's
      client, `cloudflare-apply` with `allowDestroy` and the app's name typed; A's rules, client
      certificate and AOP settings left to A's moved zone; A's Zero Trust pieces never touched.
    - `removeBShared(session, environment)` (abort): the app's hostnames off B's rules, B's client
      certificate and AOP settings removed, B's Origin CA certificate revoked, `originTlsNext`
      forgotten.
    - Tests: a proxied cloud server, Portainer in Caddy mode, an own server in tunnel mode (no origin
      TLS), a Workers site with `www`; no private key in any plan, hash or output.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/shared && pnpm lint`
  - Effort: high

- [x] T2815 [P] [US1] B's connector beside A's
  - Owns: `packages/agents/src/cloudflare-move/connector*.ts`, additions to `packages/agents/src/provision/{portainer-flow,stack-plan}.ts` (+ tests)
  - Lead note (after T2806): `planNextTunnelConnector` and `planNextTunnelConnectorRemoval` take `facts` from `inspectHost(remote)` and refuse when another app is named `<app>-tunnel-next`; as root the folder is `/srv/opscrew/cloudflared-next/<app>`, on a cloud server as the login pass `dir: "/home/deploy/opscrew/cloudflared-next"`.
  - Reads: plan 4.4.3, 7.4, 8., 9.; `rotate/infra-connectors.ts`, `shared/host-plan.ts`, `vpn/servers.ts` (`networkServer`), `provision/portainer-flow.ts`; T2806's and T2807's blocks
  - Depends: T2802, T2806, T2807, T2810
  - Accept:
    - `besideConnector(session, environment, tunnels)`: on a server (an own server in tunnel mode as
      root, a cloud server's subdomain connector as the login), `planNextTunnelConnector` with B's
      token on standard input, through `approveAndApplyHostPlan`; in Portainer, the beside stacks
      through one stack plan approved by hash. Up to date → skipped.
    - `takeOverConnector(session, environment, tunnels)` (finish): the main connector restarts with
      B's tunnel token (`serverTunnelConnectors(…).restart`, `portainerTunnelConnectors(…).restart`),
      then the beside connector is removed.
    - `removeBesideConnector(session, environment)` (abort), then `waitForNoConnection(client,
      account, tunnelId)` (`tunnelConnections` until `closed`, bounded, a plain stop otherwise), also
      used before A's tunnel is destroyed.
    - Tests with the host and Portainer fakes for each target and web mode, a run after each step,
      the token never in a plan, its hash or an output.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/connector src/provision && pnpm lint`
  - Effort: xhigh

- [x] T2816 [P] [US3] R2: first copies, the finish's window, emptying buckets
  - Owns: `packages/agents/src/cloudflare-move/buckets*.ts`, `packages/agents/src/shared/rclone*.ts`, the rclone part of `packages/agents/src/retarget/bucket.ts` (+ tests)
  - Reads: plan 4.4.5, 7.1, 7.2, 7.3, 7.7, 8.; data-model 2, 7; `retarget/{bucket,window,server-ops}.ts`, `retarget/sides/postgres.ts` (the archive API's one-file write), `shared/deploy-pause.ts`, `provision/storage.ts`, `shared/app-env.ts` (`r2Endpoint`)
  - Depends: T2802, T2810, T2811, T2812
  - Accept:
    - **`shared/rclone.ts`:** retarget's rclone container (pinned image, keys on standard input, the
      redacted failure) extracted, with an R2 remote (`provider = Cloudflare`, the account's
      endpoint), an SSH runner and a Docker runner (Portainer: the configuration written through the
      archive API into the created container, removed afterwards); `retarget/bucket.ts` uses it and
      its tests pass unchanged.
    - `measureBuckets`; `firstCopies(session, environment)`: one `remote-exec` approval listing each
      bucket, its size, objects and minutes; `rclone copy --checksum --metadata`, resumable.
    - `bucketWindow(session, environment, pointAtB)` (plan 7.2): the approval with its length, the
      pause and the wait, `window.stoppedAt`, the stop, `rclone sync`, then `pointAtB()` (T2823's step
      1); on any failure the secrets and values back to A's and the app started on A; a run that finds
      `stoppedAt` starts the app on A first. `appSettingsForB(session, environment)` gives step 1 the
      bucket's part.
    - `lastBackupsCopy` (plan 7.3).
    - `emptyBuckets(session, environment, side)`: at the finish `rclone check --one-way` A → B, then
      `rclone delete`; at an abort B's without the check; each a `remote-exec` approval with
      `allowDestroy` and the bucket's name typed.
    - Tests: a cloud server and a Portainer app with both buckets, a window failing at each point
      (the app back on A), a resumed window, keys never in a command line, a container's `Env` or
      `Cmd`, an output or an audit entry.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/buckets src/shared/rclone src/retarget/bucket && pnpm lint`
  - Effort: xhigh

- [x] T2817 [P] [US1] [US2] The zone plan: B's zone, the copy, the marks, coverage
  - Owns: `packages/agents/src/cloudflare-move/{zone,marks}*.ts`
  - Lead note (after the spike, plan 13b): each mark also lists the app's Access-protected hostnames: `access: { hostname, kind: "service" | "portainer" | "beszel", environment }[]`, no e-mail or id.
  - Lead note (after T2810): coverage also needs the hostnames only OpsCrew's shared rules name; read them with `sharedRuleHostnames(facts)` from `@opscrew/connector-cloudflare` (facts from `inspectShared` on A's zone). `listZoneWorkerDomains` needs Workers permission on A's token: probe first and, without it, say the custom domains were not read rather than skip them silently.
  - Lead note (after T2807): `opscrewRecordNames(plan, zone)` leaves out GitHub's verification TXT record (`_github-pages-challenge-<owner>.<domain>`); coverage counts a `_github-pages-challenge-*` TXT record as the Pages app's by that prefix.
  - Reads: plan 4.3, 4.5, 5.1, 5.2, 7.8; data-model 4, 5; `provision/shared-cloudflare.ts` (how a `cloudflare-apply` plan is shown and approved); T2804's and T2809's blocks
  - Depends: T2804, T2805, T2807, T2809, T2810
  - Accept:
    - `planZone(session, { marks })`: data-model 5's `ZoneCopy` made in agents on
      `recordsMissingFromZone`: create-only; differences and records only in B listed, never changed;
      Cloudflare-managed records, OpsCrew's and the marks skipped; the app's servers' addresses
      masked in what is shown; its hash over canonical JSON.
    - `applyZone(session, plan)`: approved by hash (`cloudflare-apply`); makes the plan again and
      refuses another hash; creates B's zone when asked, then checks B's nameservers (equal to A's →
      plan 4.3's stop) and B's zone-level permissions (each missing one named) before any record;
      then the records and the marks.
    - `marks.ts`: the label, the content (data-model 4, split in parts), parsing with zod,
      `readMarks(session)`, `writeMark` and `deleteMark` through `planZone`/`applyZone`.
    - `coverage(session)`: A's OpsCrew names (records with the comment, the rules' hostnames, Workers
      custom domains) against every mark's `hosts`: the names not covered, and the marks read.
    - Tests with the two-account fake: a first prepare, a second app's prepare in the same zone, A's
      records changed between them (created, changed: listed only), coverage with one app missing,
      marks in parts, the same nameservers, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/zone src/cloudflare-move/marks && pnpm lint`
  - Effort: high

- [x] T2818 [P] [US1] [US4] The deploy's `_NEW` credentials
  - Owns: `packages/agents/src/cloudflare-move/deploy-secrets*.ts`
  - Reads: plan 4.4.4, 7.1, 7.5, 8., 10.; data-model 6; `rotate/infra.ts` (`accessSecrets`, `setSecretAt`), `serverless/cloudflare/{checks,provision}.ts` (`requireWorkersTokens`), `provision/origin-tls.ts` (`deployRenewedCertificate`), `retarget/types.ts` (`waitForWorkflowRun`)
  - Depends: T2808, T2810, T2812
  - Accept:
    - `addNewCredentials(session, environment, outputs)`: one `github-secrets` approval naming the
      `_NEW` secrets (never values): B's Access deploy credentials from the shadow outputs; for a
      Workers site B's account id and `OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN` (checked against B with
      `requireWorkersTokens`), then the deploy workflow dispatched and awaited so B's Worker runs the
      current code. Same values already set → skipped.
    - `promoteNewCredentials(session, environment)` (finish): the plain names take the `_NEW`
      values, the `_NEW` ones are deleted; `dropNewCredentials` (abort).
    - Tests with the GitHub fake for own-tunnel, Portainer webhook and Workers environments, with and
      without a GitHub environment, and a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/deploy-secrets && pnpm lint`
  - Effort: high

- [x] T2832 [P] [US1] Portainer: the new account's connector stacks beside the app's (found by T2815)
  - Owns: `packages/connectors/portainer/src/**`
  - Lead note (after T2815): match the seam T2815 wired in `agents/src/cloudflare-move/connector-stacks.ts` (`NextStacksApi { plan(facts, input), apply(client, plan, { approvedHash, secrets: { env, nextTunnelTokens }, valueKey, wait? }) }`), so wiring is `{ plan: planNextStacks, apply: applyStackPlan }`; `ApplySecrets` gains an optional `nextTunnelTokens`; inspection reads the `-next` stacks by name (T2815 saves no `CreatedRecord` for them).
  - Reads: T2815's block and its report (the seam's type); `renderNextConnectorStacks` in `@opscrew/iac-templates` (T2807); ADR 0012
  - Depends: T2807
  - Decided by the lead: the stack plan today knows three roles (`ROLES`, `STACK_CHANGE_IDS`, a record of at most 3 stacks) and one `tunnelToken`, so the move's stacks `opscrew-<app>-tunnel-next` and `opscrew-<app>-portainer-tunnel-next` get a plan of their own rather than widening the app's.
  - Accept:
    - `planNextStacks(facts, { app, environmentId, stacks: { name, compose }[] | "remove", fingerprints })`: a StackPlan of its own (the stacks' text, `TUNNEL_TOKEN` as their only value, its `valuesDigest`), approved by hash; `"remove"` plans the removal of those stacks only.
    - `applyStackPlan` applies it with `secrets.nextTunnelTokens` keyed by stack name; a token never in the plan, its hash or an output.
    - `inspectPortainer` reads the `-next` stacks too; the app's own stacks, roles and record are unchanged.
    - Tests with the Portainer fake: create, re-run (nothing to do), remove; the app's stacks untouched; no token in any plan or call log.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-portainer && npx vitest run --root packages/connectors/portainer && pnpm lint`
  - Effort: high

- [x] T2833 [P] [US1] A saved plan made with `-var`s applies with the same `-var`s (found by T2813)
  - Owns: `packages/iac-engine/src/engine.ts` and its tests; `packages/agents/src/provision/plan-apply.ts`, `packages/agents/src/shared/connector-removal.ts`, `packages/agents/src/testing/{state,deploy}.ts` and their tests
  - Reads: T2813's block; `IacRunOptions` in `@opscrew/contracts` (it already has `vars`)
  - Depends: T2811
  - Decided by the lead: OpenTofu 1.13 refuses to apply a saved plan when a variable saved in it differs from what the root's `terraform.tfvars.json` gives at apply ("Mismatch between input and plan variable value"); Terraform applies it; both apply it when the same `-var`s are passed to `apply <planfile>`. So the engine passes `options.vars` to `apply` as it does to `plan`, with no contract change.
  - Accept:
    - `IacEngine.apply` passes `options.vars` as `-var` arguments before the plan file (both engines); without `vars` the command is byte-identical to today's.
    - `planAndApply` passes its `vars` to the apply, through `applyWithConnectorRemoval` too.
    - The fake engine's `PlanVariables.mismatch` takes apply-time `vars` over `terraform.tfvars.json`, as OpenTofu does, so a test that drops the apply's `vars` fails.
    - Tests: the engine's argument list with and without `vars`; with the real engines from `.tools/bin` (skipping without them), a root planned with `-var` differing from its tfvars applies with OpenTofu and Terraform; `planAndApply` with `vars` reaches the apply.
  - Verify: `PATH="/d/opscrew/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-engine --filter=@opscrew/agents && npx vitest run --root packages/iac-engine && npx vitest run --root packages/agents src/provision/plan-apply src/shared/connector-removal && pnpm lint`
  - Effort: high

- [x] T2835 [P] [US1] Templates: Access applications and the records they protect, held back on a pending zone (after the spike)
  - Owns: `packages/iac-templates/modules/{cloudflare-access,cloudflare-tunnel}/**`, `packages/iac-templates/src/generated/modules.ts`, `packages/iac-templates/src/infra/{tunnel,portainer,cloudflare-move}.ts` and their tests and snapshots
  - Reads: plan 13b; research R10 (Access refused on a pending zone)
  - Depends: T2807
  - Accept:
    - The `cloudflare-access` module's applications (not its policies or service tokens) count on a new variable `applications` (default true); the `cloudflare-tunnel` module's route records for Access-protected hostnames (the SSH/webhook service hostname, Portainer's and Beszel's) count on a new variable `protected_records` (default true); the app's own public route record always stays.
    - The roots that call them pass root variables `access_applications` and `protected_route_records` (default true, written to `terraform.tfvars.json`), and `accountVariables`/`cloudflareAddressScope` know them.
    - With the defaults every rendered root is byte-identical to today's except the two variables (snapshots show only them); both engines validate a root with the variables false (no application, no protected record).
  - Verify: `PATH="/d/opscrew/.tools/bin:$PATH" pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/infra && pnpm lint`
  - Effort: high

- [x] T2836 [US1] The switch's registrar without a Registrar permission (after T2825's fact-check)
  - Owns: `packages/connectors/cloudflare/src/client.ts` (the zone's `originalRegistrar` only) and its tests, `packages/connectors/cloudflare/src/testing/**` (the same field), `packages/agents/src/cloudflare-move/switch-registrar*.ts`, the move's zone type and where the session reads B's zone
  - Reads: research R10.8; plan 5.3; `domain/registrar-lookup.ts` (`findDomainRegistrar`, `cloudflareHolds`)
  - Depends: T2819
  - Accept:
    - `CloudflareZone` gains `originalRegistrar?: string` from the zone's `original_registrar` (Cloudflare's record of the domain's registrar at the zone's creation; R10.8 read `cloudflare, inc. (id: 1910)` on B's pending zone).
    - `findSwitchRegistrar`: when Cloudflare Registrar's read with A's token is refused for want of a permission (HTTP 403), the switch and the abort don't stop: Cloudflare Registrar when B's zone's `originalRegistrar` names Cloudflare, else another registrar; an info line says OpsCrew told it from Cloudflare's record because the token can't read Cloudflare Registrar. `domain connect`'s lookup is unchanged.
    - Tests with the two-account fake: a 403 with `originalRegistrar` Cloudflare's (the dashboard steps), a 403 with another registrar (the nameservers to set), a 403 and no `originalRegistrar` (another registrar), and a readable registrar as today.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=@opscrew/connector-cloudflare && npx vitest run --root packages/connectors/cloudflare && npx vitest run --root packages/agents src/cloudflare-move/switch src/cloudflare-move/abort && pnpm lint`
  - Effort: medium

- [x] T2837 [US1] What stays behind: the owner told what OpsCrew doesn't move (FR-2819, founder's decision 2026-11-15)
  - Owns: `packages/agents/src/cloudflare-move/left-behind*.ts` (new), its lines in `summary.ts` and `switch-plan.ts` and their tests, read-only methods in `packages/connectors/cloudflare/src/client.ts` (+ tests, `testing/**`) for what the client can't read yet, the "What OpsCrew doesn't move" section of `docs/guide/cloudflare-move.md`
  - Reads: spec FR-2819 and its edge case; plan 14.; `packages/cli/test/live/cloudflare-move-pass.ts`'s inventory (what L0 reads, by which endpoint, and its 403 answers on the founder's token)
  - Depends: T2828
  - Accept:
    - `leftBehind(session)`: read only, with A's token: Email Routing (on or off, its rules and catch-all counted), the zone settings OpsCrew doesn't set (SSL mode, minimum TLS, Always Use HTTPS, security level, cache level), rules in the zone's rulesets and page rules that aren't OpsCrew's, Workers, Pages projects and R2 buckets OpsCrew didn't make, Turnstile widgets, Web Analytics sites; each item with where to redo it in B; a kind the token can't read (HTTP 403) listed as "couldn't read: check in the dashboard"; values never shown beyond names and counts; every answer validated with zod.
    - Prepare's summary (before its first approval) and the switch plan's details (before its approval, not in its hash) list them; nothing is moved, and a failed read never stops the move (the kind is listed as not read).
    - Tests with the two-account fake: each kind found, none found, a 403 per kind; the guide's section says the list appears there.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=@opscrew/connector-cloudflare && npx vitest run --root packages/agents src/cloudflare-move && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: high

- [x] T2838 [US1] The DS wait from the registry's own TTL (founder, 2026-11-15)
  - Why: the wait after old DS records are gone has a 24-hour floor (007, T1025), set because a resolver's lookup shows only the TTL left on its copy; the .dev registry's own nameservers give opscrew.dev's DS record a TTL of 1,800 s, so 24 hours is about 48 times what is needed.
  - Owns: `packages/agents/src/domain/{connect-ds,connect-state}*.ts` and a new `packages/agents/src/domain/registry-ds*.ts`, `packages/agents/src/cloudflare-move/switch-ds*.ts`, the texts that name the wait (CLI and agents messages, `docs/guide/{domains,cloudflare-move}.md`), `packages/cli/test/live/cloudflare-move*.ts` if they name it
  - Accept:
    - The DS record's TTL read from the parent zone's own nameservers (the TLD's NS, asked directly over DNS for type DS; every answer validated; injected so tests never touch the network): the full TTL, not a resolver's remaining time.
    - The wait once the old DS records are gone: twice that TTL plus an hour, at least one hour, at most 48 hours; when the registry's TTL can't be read (UDP 53 blocked, no answer), the 24-hour floor stays. A note's longer recorded wait still holds ("never shorter than noted").
    - `opscrew domain connect` and the move's switch both use it; every text and guide line that says "24 to 48 hours" says what the wait is now.
    - Tests: TTL 1800 → 2 hours; TTL 86400 → 48 hours; unreadable → 24 hours; a noted longer wait kept.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/agents src/domain src/cloudflare-move/switch && pnpm lint`
  - Effort: high

- [x] T2839 Each app's recovery copy follows its own `.sops.yaml` rule (a bug found by another session, 2026-11-15, for 0.2.10)
  - Why: in a repository with several apps, `opscrew rotate recovery-key --app <key>` rewrites the one rule (`path_regex: secrets.sops.json$`) that every app's copy follows; rotating a second app points the first app's copy at the second app's key, and the next refresh of the first app's copy encrypts it to that key, so the key the user was told to keep for it stops opening it.
  - Owns: `packages/agents/src/secrets/{store,copy}*.ts`, `packages/agents/src/rotate/recovery*.ts` (or wherever `rotateRecoveryKey` and the rotation's publish step live), their tests, the guide's recovery-key lines if they describe one rule
  - Accept:
    - A creation rule per app's copy, by its path (a further app's rule before the first app's general one); `readRecipients` and `sopsConfigFile` read and write per app; a rotation rewrites only its own app's rule; a repository with one rule keeps working, its further apps getting their own rule at their first rotation or refresh.
    - Test: two apps, rotate the first, then the second: each copy stays encrypted to its own new key and the backup; a refresh of the first app's copy keeps the first app's key.
    - If small: a second app's rotation may run on OpsCrew's own unmerged `opscrew/deploy-setup` branch (adding to it) instead of refusing; otherwise leave that refusal and say so.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/secrets src/rotate && pnpm lint`
  - Effort: high

- [x] T2840 `config/client-exposed-secret` skips test code and test fixtures (a bug found by another session, 2026-11-15, for 0.2.10; done by the lead)
  - Why: `scanClientExposed` checked only `isClientNameFile`, so a browser-exposed name in a `*.test.ts` file or a `test/fixtures/**` file was a critical finding; the other config rules skip `isTestFile`.
  - Done: `packages/secops/src/rules/config.ts` skips `isTestFile`; a test with a test file, a fixture and real code (only the real code is flagged).

- [x] T2841 Ignore rules for `opscrew scan`, kept in the repository (founder, 2026-11-15, asked through another session; for 0.2.10)
  - Why: test code, mocks and fixtures raise findings that only matter for shipped code; the founder wants "some rules for the scans to ignore those test/mock files".
  - Owns: `packages/secops/src/**` (the default skips, the ignore file's reading and the report), a schema for the file in `packages/plan-schema/src/` (new file, its export line), the scan's report in the CLI (`packages/cli/src/commands/scan*.ts`, `ui` if it prints there) and the MCP server's scan tool, `docs/guide/security.md`'s scan section
  - Accept:
    - **Default skips:** test code is `test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*` as today, plus `__mocks__/`, `mocks/`, `*.mock.*`, `__fixtures__/` and `testdata/` (and `fixtures/` only under a test folder: an app's own `fixtures/`, such as Django's, is loaded into real databases). Every non-secret rule skips test code alike.
    - **`opscrew/scan.yaml`** (the user's, committed): `ignore: [{ paths: [globs], rules?: [rule ids], reason }]`, validated with zod (a reason required, an unknown rule id refused plainly); read by `scan` and so by `drift`, `secure`, the MCP server and the plugin.
    - **Secrets are never dropped:** a secret finding in test code or an ignored path is reported as info with why (as `rules/secrets.ts` does for test files today), not removed.
    - **Nothing ignored silently:** the report gives the count of ignored findings per rule (and per `scan.yaml` entry), in the text and in `--json`.
    - Tests for each default path, a `scan.yaml` with and without `rules`, a secret in an ignored path, the counts in text and JSON, and an invalid file.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/secops --filter=@opscrew/plan-schema --filter=opscrew --filter=@opscrew/mcp-server && npx vitest run --root packages/secops && npx vitest run --root packages/plan-schema && npx vitest run --root packages/cli src/commands && npx vitest run --root packages/mcp-server && pnpm lint`
  - Effort: high

- [x] T2842 An app on Cloudflare Workers redirects plain HTTP to HTTPS (a bug found by another session, 2026-11-15, for 0.2.10)
  - Why: an app OpsCrew deploys to `cloudflare-workers` (Workers SSR or `workers-assets`, static or not) answers `http://<host>/` with 200, no redirect; OpsCrew's own server edges redirect, Cloudflare targets never do, and a first visit or a checker (a payment provider's domain review) sees the site over plain HTTP.
  - Owns: `packages/connectors/cloudflare/src/shared.ts` (+ tests, `testing/**`), the agents' code that builds the shared plan's desired rules for a Cloudflare-hosted app (`packages/agents/src/provision/shared-cloudflare*.ts`, `packages/agents/src/serverless/cloudflare/**` as needed), `docs/guide/cloudflare-hosting.md`
  - Accept:
    - A Single Redirect among OpsCrew's shared rules (`http_request_dynamic_redirect`, its own ref, e.g. `opscrew-https-redirect`): `http.request.scheme eq "http"` and the host in the Cloudflare-hosted apps' hostnames → `https://` + the same host and path, query kept, 301; only the hostnames of apps on a Cloudflare target (a server's hostnames keep their edge's own redirect; GitHub Pages enforces HTTPS itself); the zone's Always Use HTTPS untouched.
    - Planned and approved by hash with the rest of the shared plan; an app's destroy removes its hostnames from it (the rule goes with the last one); drift and the 028 move see it like OpsCrew's other shared rules.
    - Tests: the rule's expression and target for one and two hosted apps, a server app not in it, destroy removing it, the plan unchanged for a zone without hosted apps.
    - Also (found live by another session): the existing `opscrew-www-redirect` loops on plain HTTP (`wildcard_replace(http.request.full_uri, "https://www.*", "https://${1}")` leaves `http://www.…` unchanged, so it redirects to itself); it becomes `"*://www.*"` → `"https://${2}"`, both schemes to the https apex in one hop; a test with an http and an https URL; every zone with the www redirect gets one in-place update in its next shared plan (changelog).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-cloudflare --filter=@opscrew/agents && npx vitest run --root packages/connectors/cloudflare && npx vitest run --root packages/agents src/provision/shared-cloudflare src/serverless src/destroy src/cloudflare-move && pnpm lint`
  - Effort: high

- [x] T2843 The registry's own answer decides whether old DS records are gone (founder, 2026-11-15; a follow-up to T2838)
  - Why: since T2838 OpsCrew asks the registry's nameservers for the DS record's TTL, but still decides that the record is gone from a resolver's cached copy (DNS over HTTPS), up to one TTL behind the registry.
  - Owns: `packages/agents/src/domain/{connect-ds,registry-ds}*.ts`, `packages/agents/src/cloudflare-move/switch-ds*.ts` and their tests
  - Accept:
    - When the registry answers readably, its answer decides: `none` means the old DS records are gone (the wait counts from that reading, twice the registry's TTL plus an hour, which covers every cached copy), `published` means they are not, whatever a resolver shows; the registry is asked whenever old DS records were seen before (a note, `dsAtStart`) or are listed or shown now.
    - When the registry can't be read, today's rule stays (the API listing and the public copies, the 24-hour floor).
    - A longer noted wait still holds; the TTL for "none" is the one noted or last read (never a guess shorter than it).
    - Tests: the registry says none while a resolver still shows the record → gone, the wait from that reading; the registry says published while a resolver shows none → not gone; unreadable → today's rule.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/domain src/cloudflare-move/switch && pnpm lint`
  - Effort: high

- [x] T2844 The zone copy creates only what isn't in a zone Cloudflare brings back with its records (found by L3, 2026-11-15; done by the lead)
  - Why: L3's prepare added B's zone again after L2's abort had deleted it; Cloudflare restored the 15 records the zone held (their `created_on` was L2's copy time), and the copy, planned against a zone that didn't exist yet, failed with "An identical record already exists".
  - Done: `applyZone` lists B's records right after creating the zone and creates only `recordsMissingFromZone(plan.create, present)`; a test where the new zone comes back with one of A's records (it failed with the live error before the fix).

- [x] T2845 The engine's local backend path doesn't depend on the drive letter's case (found preparing the real move, 2026-11-15)
  - Why: a further app provisioned from a terminal that opened the checkout as `d:\…` (VS Code) recorded its local backend path with a lower-case drive in `.terraform/terraform.tfstate`; a later run from a `D:\…` terminal passed the same path upper-case, and `tofu init` stopped with "Backend configuration changed" though it is the same file.
  - Owns: `packages/iac-engine/src/**` and `packages/agents/src/**` where the local backend's state path and `TF_DATA_DIR` are built (find them), their tests
  - Accept:
    - On Windows, every path OpsCrew gives the engine for a state file or a data folder has its drive letter upper-case (one helper, used wherever such a path is built), so the case of the terminal's working folder never changes a backend's configuration.
    - A data folder that recorded the same path with a lower-case drive (written by an earlier run) is accepted: when `init` reports the backend changed and the recorded and wanted paths are the same file (case-insensitively on Windows), OpsCrew reinitialises it without migrating the state (`-reconfigure`); any other backend change still stops plainly as today.
    - Tests: a path built from a lower-case and an upper-case drive gives the same string; a recorded lower-case path is reconfigured; a different path still stops.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/iac-engine --filter=@opscrew/agents && npx vitest run --root packages/iac-engine && npx vitest run --root packages/agents src/provision src/shared && pnpm lint`
  - Effort: high

- [x] T2847 The DNSSEC wait counts from the registry's own change time (founder, 2026-11-17; the lead's change, its tests owed)
  - Why: the wait started at the first run that saw the DS record gone. At the real move the .dev registry had dropped it about 19 hours before OpsCrew's next run (RDAP `last changed` 2026-11-17 01:21 UTC), and the switch still waited 2 hours.
  - Done by the lead (a91aa187, committed without new tests on the founder's call, to switch that night): `RegistryNetwork.rdapRecord` (the TLD's RDAP server from IANA's bootstrap file, RFC 9224), `rdapUnsignedSince`, `RegistryDsTtl`'s `none` with `changedAt`, and `dsGoneAt`, used where a wait starts: `dsWaitStatus`, `domain connect`'s `waitForOldDs` and the move's own gate (`ownGate`).
  - Owns: `packages/agents/src/domain/{registry-ds,connect-ds}*.ts`, `packages/agents/src/domain/connect.ts` (only the wait's start), `packages/agents/src/cloudflare-move/switch-ds*.ts`, their tests
  - Accept:
    - Review the lead's change against this task; keep its behaviour, simplify where it is clearer.
    - Tests: `rdapUnsignedSince` (unsigned with a `last changed` event → that time; signed, no `secureDNS`, no such event, an unparsable date, not an object → undefined); `registryDsLookup` when the registry publishes none: with an RDAP record (→ `changedAt`), without `rdapRecord`, with a rejecting one (→ plain `none`); `dsGoneAt` (a change before `dsSeen` → now; in the future → now; otherwise the change); `dsWaitStatus`, `waitForOldDs` and `ownGate` count the wait from `changedAt`, so a switch whose `changedAt` plus the wait has passed goes on at once; nothing changes without `changedAt`.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/domain src/cloudflare-move/switch && pnpm lint`
  - Effort: high

- [x] T2848 The switch at Cloudflare Registrar sees the change at the registry and finishes the new account's side as soon as its zone is active (found at the real move, 2026-11-17)
  - Why: at L4b the registry named the new account's nameservers at 21:30 UTC, but `currentNameservers` (`switch-registrar.ts`) asked the public DNS (`publicNameservers`, DNS over HTTPS at Cloudflare's resolver), which held the old answer for about 3 hours (the `.dev` delegation's TTL is a day). Cloudflare activated B's zone at 22:13 (right after the lead asked for an activation check; its own checks would have done it too). Until the switch attached the Workers custom domains (around 00:15) and resolvers' negative caching ran out, the Workers sites (the landing, `www`, the docs, pay) answered HTTP 530 or "no such host" to most visitors: about 65% of L4b's requests to them failed over about 2.5 hours. The server apps, whose records the prepare had copied, kept answering.
  - Owns: `packages/agents/src/cloudflare-move/switch*.ts` except `switch-ds*.ts`, `packages/agents/src/domain/registry-ns.ts` (new) and its test, `packages/agents/src/domain/index.ts` (its export), `packages/agents/src/context.ts` (the dependency), `packages/cli/src/deps.ts` (its wiring, as `registryDs`'s), `packages/connectors/cloudflare/src/**` (only what the switch calls newly), `docs/guide/cloudflare-move.md`, their tests
  - Accept:
    - The zone's nameservers come from the registry's RDAP record (`nameservers[].ldhName`, lower case, sorted) when it can be read, through a lookup in `PhaseDeps` wired like `registryDs` (reuse `nodeRegistryNetwork().rdapRecord`); else the registrar's API; else the public DNS as today.
    - Once the registry names B's nameservers, the run asks Cloudflare for B's zone's activation check and waits for B's zone to become active (bounded, about 15 minutes, with a plain stop to run again after), then does B's side at once: the Workers custom domains attached and the rest of the switch's steps.
    - Research, checked against Cloudflare's documentation, then implement what works: keeping B's nameservers from answering "no such host" for a Workers hostname before its custom domain is attached (B's SOA negative-caching TTL lowered for the move through the zone's DNS settings, a placeholder record, or attaching the custom domain while the zone is pending, if Cloudflare allows it). Report what you checked and why the choice works; if none works, say so and keep the wait for activation short.
    - Tests for each path; `docs/guide/cloudflare-move.md` says what visitors see during the switch and for how long.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/agents src/cloudflare-move src/domain && npx vitest run --root packages/connectors/cloudflare && pnpm lint`
  - Effort: xhigh

- [x] T2849 The old account's origin certificate once its zone has moved (found at the real move, 2026-11-18; the lead's change, its tests owed)
  - Why: the first app's finish stopped on revoking the old account's Origin CA certificate. Once a zone has moved, Cloudflare neither reads nor revokes its origin certificates ("Failed to read certificate from Database", "User is not authorized to perform this action", with either account's token, even with SSL and Certificates Edit on all zones). After the switch the old zone has always moved, so the revocation could never run.
  - Done by the lead: `revokeAOrigin` (`cloudflare-move/shared.ts`) reads A's zone; when it isn't active (or can't be read) it says why the certificate stays and returns, so the finish removes A's record and ends. Three tests still expect a revocation after the switch.
  - Owns: `packages/agents/src/cloudflare-move/{shared,finish-removal}*.ts` and the fakes they use
  - Accept: those tests follow the real behaviour (A's zone moved → the note, no revocation, A's record gone, the finish ends; A's zone still active → revoked as before; A's zone unreadable → left, with the note); report one line for the guide's "what stays behind" list (the lead adds it).
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: medium

- [x] T2850 The move's live pass: slips found at the real move
  - Owns: `packages/cli/test/live/cloudflare-move*.ts`, `docs/e2e.md` (the move's section)
  - Accept:
    - L3's coverage step tells a DNSSEC wait from coverage that names hostnames: a refusal for the wait says so, with its time, and doesn't name coverage.
    - A leg filter matches only that leg: L0's step "the registrar, and so the switch's leg (L4a or L4b)" no longer contains a leg's name, so `-t "L4b"` doesn't also select L0 (it did, and the pass refused two legs in one run).
    - `delegatedToB` reads the registry's RDAP nameservers first (T2848's lookup, or the RDAP record directly), then the public DNS.
    - L6 empties P's bucket before `opscrew destroy` (the destroy refuses a bucket that holds files, as OpsCrew never deletes them), so the destroy goes through and updates the zone's shared rules; L6 stopped there and left the test hostnames in OpsCrew's shared rules, which the lead removed by hand.
    - The leak search leaves out the kept versions of a plan made outside the pass's own runs (the lead kept one to diagnose L5), or the step names how to remove one.
    - The pass's support tests cover each.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli test/live/cloudflare-move-support.test.ts && pnpm lint`
  - Effort: medium

- [x] T2851 The finish's check after importing what the switch made accepts in-place updates, approved by hash (found by L5, 2026-11-18; done by the lead)
  - Why: Q's finish stopped: once the switch's Access application was imported into the main shadow state, the check plan would update it in place, setting `auto_redirect_to_identity`, `enable_binding_cookie` and `options_preflight_bypass` from `false` (Cloudflare's defaults, which the import brings along) to unset, as the module leaves them. The check had to be empty.
  - Done: `checkAdoption` takes in-place updates of Cloudflare resources, shown and approved by hash, as `checkAfterSwap` does; anything else still stops before an approval; `adoptSite` returns the approval's stop. Tests: a create still stops; an in-place update waits for its hash as a script and, approved, is applied before the credentials are promoted.

- [x] T2852 A saved plan's JSON masks an Access service token's client ID (found by L6's leak search, 2026-11-18; done by the lead)
  - Why: L6's leak search found Q's deploy service token's client ID in `.opscrew/plans/*.tfplan.json`: the provider marks only the client secret sensitive, so the masking (`plan-json.ts`) left the client ID, the credential's other half, in the resource's values.
  - Done: `cloudflare_zero_trust_access_service_token`'s `client_id` joins the attributes masked whatever the plan marks; a test.

## Phase 5: Wave 4 (parallel)

- [x] T2819 [US2] [US4] [US5] The switch and the HTTPS gap
  - Owns: `packages/agents/src/cloudflare-move/{switch,gap}*.ts`
  - Lead note (after the spike, plan 13b): right after activation, for every prepared app's mark: make its Access applications with B's token exactly as the `cloudflare-access` module would (names and settings from the module, policies found in B by name), then the protected hostnames' proxied CNAMEs to the app's tunnel in B (found by name), before attaching the Workers custom domains; the approval names them.
  - Lead note (after T2817's review): `coverage(session)` returns `{ uncovered, marks, unread }`; the switch refuses on a non-empty `unread` as on a non-empty `uncovered` (an empty `uncovered` alone does not mean every app is prepared).
  - Lead note (after T2805): the two-account fake models no Cloudflare Registrar registration; tests stub `getDomain`/`getRegistration` for the registrar decision.
  - Lead note (after T2809): read the DS wait as `dsWaitStatus(stateFile, now, ds)` with a fresh `readDs` reading, in a note file of the switch's own (not the switch file).
  - Reads: plan 5., 6.; data-model 2; spec FR-2806 to FR-2809; `domain/{switch,connect}.ts`; T2809's and T2817's blocks
  - Depends: T2804, T2809, T2810, T2812, T2817
  - Accept:
    - `switchMove` replaces T2801's stub: plan 5.'s steps in order, each checked before it acts; the
      switch plan's hash covering everything 5.5 lists; with DNSSEC on, the DS run and stop, then a new
      plan and a new approval after the wait; the approval's text as 5.5; the nameserver change, or
      Cloudflare Registrar's steps, or another registrar's; the custom domains attached right after
      activation (and A's detached first when Cloudflare refuses, per plan 13.); DNSSEC on in B when
      `dsAtStart`; the output with the times, then each finish (origin-protected apps first). The marks
      stay.
    - `measureGap` (plan 6.): the 30-second loop with injected `sleep`, `now` and `fetch`, the two-hour
      limit then a stop the next run continues with the same times.
    - Resumed at every point (before and after the DS removal and the nameserver change, pending,
      active without a certificate, all answered) with nothing done twice; a rerun from another
      repository after activation finds the marks and the attached domains.
    - Tests with the two-account fake and the registrar fakes: Porkbun with and without DNSSEC,
      Cloudflare Registrar, another registrar, an unprepared app, a Workers site, a slow certificate, a
      hostname answering 526, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/switch src/cloudflare-move/gap && pnpm lint`
  - Effort: xhigh

- [x] T2820 [US1] [US2] [US3] [US4] Prepare
  - Owns: `packages/agents/src/cloudflare-move/prepare*.ts`
  - Lead note (after T2833's review): `testing/move.ts`'s engine fake drops `apply` options; the move's step tests should run on an engine fake that compares apply-time `vars` (as `testing/state.ts`'s `PlanVariables` does) so a lost `vars` fails a test.
  - Lead note (after T2813): when the zone plan creates B's zone in the same run, refresh `session.accounts.b.setup` before `shadowRoots`.
  - Lead note (after T2814's review): one approval pattern for every step of the move: retarget's `appliesNow`/`approveCommand`, a non-interactive run recording its waiting plan (`writePending`) and stopping with the exact `--approve` command; `planBShared` returns B's one-time PIN login id for the shadow plan's `oneTimePinIdentityProviderId`.
  - Reads: plan 4., 9., 10.; data-model 1, 2
  - Depends: T2812, T2813, T2814, T2815, T2816, T2817, T2818
  - Accept:
    - `prepareMove` replaces T2801's stub: plan 4.'s steps for every covered environment and every
      target of plan 9.; the record's steps and `dsAtStart`; pending plans; the mark last; a recorded
      move continued without `--to`; a different `--to` refused.
    - Interrupted after every sub-step and run again (interactively and with `--approve`): nothing done
      twice, and A's fake saw no write.
    - Tests per target, two environments, two apps in one repository, a leak check over every fake.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: xhigh

- [x] T2821 [US1] Abort
  - Owns: `packages/agents/src/cloudflare-move/abort*.ts`
  - Lead note (after T2818): drop the `_NEW` deploy credentials with `dropNewCredentials`; give it a pending action of its own (`abort-secrets` in `progress.ts`'s `MOVE_PLAN_ACTIONS`) rather than reusing `secrets`.
  - Lead note (after T2813): the same `prevent_destroy` copy for B's storage and backups roots on abort.
  - Lead note (after T2811): forget only B's kept bucket keys with `forgetStorageKey(deps, bucket, { account: B, moveTo: B })`, so A's (kept before the move without an account) stay.
  - Reads: plan 8.; data-model 1, 2, 3
  - Depends: T2809, T2812, T2813, T2814, T2815, T2816, T2817, T2818
  - Accept:
    - `abortMove` replaces T2801's stub: refused once the switch changed anything, judged as plan 8.
      says from the delegation, `dsAtStart` and the registry's DS records, B's zone status and the
      records' steps (no switch file needed); otherwise plan 8.'s order, each removal approved with its
      kind and typed name; B's zone deleted only with its name typed and no other mark or OpsCrew
      record in it.
    - Resumed after every step; A's fake saw no write in the whole abort.
    - Tests per target, an abort with another app prepared in B (the zone stays), an abort refused
      after the nameservers changed and after a DS removal, a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: high

- [x] T2822 [US1] [US4] Finish, part 1: A's removal, the site's adoption, the mark
  - Owns: `packages/agents/src/cloudflare-move/{finish-removal,finish-site}*.ts`
  - Lead note (after T2813): the storage and backups roots carry `prevent_destroy`, so A's removal of them plans from a copy rendered without the guard (as `destroy --delete-data` does), passed as `{ ...root, dir }` to `planRemoval`; with `TF_DATA_DIR` set, `state list` from a scratch folder needs it unset (as `shadow.ts` does).
  - Lead note (after the spike, plan 13b): the finish also imports the Access applications and the protected hostnames' records the switch made into the app's state, sets `access_applications`/`protected_route_records` back to true, and its check plan must then be empty.
  - Reads: plan 7.5, 7.7, 7.8; data-model 3, 4
  - Depends: T2813, T2814, T2815, T2816, T2817, T2818
  - Accept:
    - `adoptSite(session, environment)`: the custom domains the switch attached imported into the
      site's shadow state (`workerCustomDomainAddresses`), the check plan with `custom_domains = true`
      (no change), then `promoteNewCredentials`.
    - `removeA(session, environment)`: A's tunnels waited on until they have no connection; the
      A-removal destroy plans (account-scoped only); A's buckets checked, emptied and deleted;
      `revokeAOrigin`; nothing zone-scoped in A touched.
    - `endFinish(session)`: the app's mark deleted; `cloudflareMove` removed from every covered
      plan; the local files deleted; the output's variables to change.
    - Each resumable; a refused typed name leaves the app on B and the step repeatable.
    - Tests per target with the two-account fake (A's zone moved), a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move/finish-removal src/cloudflare-move/finish-site && pnpm lint`
  - Effort: high

## Phase 6: Wave 5

- [x] T2823 [US1] [US3] Finish, part 2: the steps in order
  - Owns: `packages/agents/src/cloudflare-move/finish*.ts` except T2822's files
  - Lead note (after T2822): call `adoptSite` for every environment, not only a Workers site (it imports the Access applications and the records they protect too); `removeA` and `endFinish` read `plan.cloudflareMove.step`, so pass environments whose plans are read again after the swap; forget A's kept bucket keys only after `removeA`, since `emptyBuckets` needs them.
  - Lead note (after T2816's fixes): the app keeps one window record, so the finish handles one environment at a time and never calls `bucketWindow` for an environment that is `adopted`; `pointAtB.secrets()` and `deploy()` must be idempotent (a rerun after an ended window runs them again); once the window is pointing at B it only goes forward.
  - Lead note (after T2816): `bucketWindow(session, environment, { allowDowntime?, backToA, pointAtB: { secrets(), deploy() } })` measures the buckets itself; B's secrets are written while deploys are paused; the window's record `{ stoppedAt, pointingAt?, endedAt? }` makes a rerun go forward (after `pointingAt`) or skip the window (after `endedAt`), so calling it again is safe; `backToA` is idempotent and redeploys when a failed deploy may already have written B's values; `emptyBuckets` removes only the files, the bucket itself goes with its root's destroy plan (T2822).
  - Lead note (after T2818): `promoteNewCredentials` is its own approval (a second one beside the finish's other secrets; accepted) and reads B's Access values from the shadow state, so it runs before the swap and never once an environment is `adopted`.
  - Lead note (after T2814's fixes): the finish's origin TLS order is: `planBShared` on B's now-active zone (issues B's Origin CA certificate into `originTlsNext`), `promoteNextOriginTls`, the deploy that places it, then `revokeAOrigin` (which revokes only once it reads that the server serves B's certificate, else stops asking to run again after the deploy).
  - Lead note (after the spike, plan 13b): the finish issues B's Origin CA certificate (now that B is active) and places it with the deploy before `revokeAOrigin`.
  - Lead note (after T2814): before the swap replaces `.opscrew/cloudflare.json` with B's record, move A's record to `aSharedRecordPath(env)` (exported from `cloudflare-move/shared.ts`); `revokeAOrigin` reads it there and asks nothing when it is missing. One helper for the `cloudflare-move/` folder paths, shared with T2813's, is T2828's to gather.
  - Lead note (after T2812, T2811): a damaged app progress file reads as absent and loses `window.stoppedAt`, so the finish also tells from the app itself (or its state) that it is stopped; forget A's kept bucket keys with `forgetStorageKey(deps, bucket, { account: A, moveTo: B })` so B's stay.
  - Reads: plan 7., 9.; data-model 1, 2, 3, 7
  - Depends: T2813, T2815, T2816, T2818, T2822
  - Accept:
    - `finishMove` replaces T2801's stub: refused unless every covered environment is `prepared` and
      B's zone is active; then plan 7.'s steps per environment and target: step 1's one approval and
      one deploy (or stack plan), wrapped by the window when there is an app bucket; the last backups
      copy; the connector; the site's adoption; the swap with the tfvars patch and the check plan
      (`adopted`); A's removal; the end.
    - Resumed after every step (the window's recovery first).
    - Tests per target, a leak check, and that after the finish `setupCloudflare` with A's token
      refuses the moved zone.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/cloudflare-move && pnpm lint`
  - Effort: xhigh

## Phase 7: Wave 6 (parallel)

- [x] T2824 [US1] [US2] The CLI, status, MCP and the plugin
  - Owns: `packages/cli/src/commands/cloudflare*.ts`, `packages/cli/src/ui/cloudflare-move*.ts`, the command's registration in `packages/cli/src/commands/index.ts`, the move's line in `packages/cli/src/commands/status.ts`, `packages/cli/test/e2e/cloudflare-move.test.ts`, `packages/mcp-server/src/{server,tools/status}.ts` (+ tests), `plugin/skills/opscrew-deploy/SKILL.md`
  - Lead note (after T2819): scripted switches need the non-interactive handler to accept `domain-settings` with `--confirm <zone> --approve <hash>` (today it refuses any `confirmPhrase` that isn't a destroy).
  - Lead note (after T2816): the move's command grants `remote-exec` by `--approve <hash>` (first copies, last backups copy) and by `--confirm <bucket>` plus hash (emptying), as `opscrew rotate` does; `--allow-downtime` answers the window's `MaintenanceWindowApproval` (title "Maintenance window: …").
  - Lead note (after T2813): add `opscrew cloudflare move` to `approveLaterHint`'s CONFIRM_COMMANDS so a refused destroy approval in the move names `--confirm`.
  - Reads: plan 1., 11.; `cli/src/commands/retarget.ts`, `cli/src/ui/retarget.ts`, `cli/src/approval.ts`, `mcp-server/src/tools/status.ts`
  - Depends: T2819, T2820, T2821, T2823
  - Accept:
    - `opscrew cloudflare move` with plan 1.'s flags; `--env` refused plainly; typed names asked in a
      terminal, `--confirm` (repeatable) in a script; `--approve` and `--allow-downtime` as in
      retarget; `--help` explains each step.
    - `opscrew status`: the move's step per environment always, and the apps prepared (B's marks) only
      when `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` is set; `opscrew_status` the same in its data and text,
      naming the terminal command; the server's terminal-only list gains the move.
    - The deploy skill: when to move, the steps, every approval in the user's terminal.
    - The e2e with fakes runs prepare, switch, finish and abort for a cloud server, an own server in
      tunnel mode and a Workers site through the CLI.
  - Verify: `pnpm turbo run typecheck --filter=opscrew --filter=@opscrew/mcp-server && npx vitest run --root packages/cli test/e2e/cloudflare-move.test.ts src/commands && npx vitest run --root packages/mcp-server && node plugin/validate.mjs && pnpm lint`
  - Effort: high

- [x] T2825 [P] [US1] [US2] [US3] [US4] [US5] The guide
  - Owns: `docs/guide/cloudflare-move.md`, its links in `docs/guide/{index,cloudflare,several-apps,environments,origin-protection,domains,retarget,object-storage,snapshots,previews,cloudflare-hosting}.md`, one line in `README.md`
  - Reads: spec FR-2817; plan 4. to 14.; quickstart; `docs/guide/retarget.md` (the style)
  - Depends: T2819, T2820, T2821, T2823
  - Accept: FR-2817's topics, true facts only, written for users: when to use it; B's token and its
    permissions; files brought up to date first; the steps; each registrar (Porkbun, Namecheap,
    GoDaddy, Cloudflare Registrar, another) and DNSSEC's wait with its second approval; the HTTPS gap
    and why (Universal SSL; paid certificates named; an HSTS-preloaded name makes it an outage); a
    site on Cloudflare's hosting answering once the switch attaches its custom domains; deploys on
    both sides of the switch; possible 526 answers until each finish while unconfirmed; R2's window
    and copies (and the lifecycle counting from the copy); several apps and repositories;
    environments; previews; what OpsCrew doesn't move (plan 14., a user's own R2 bucket used as
    `snapshots.offsite.provider: s3` among them); what stays in A; the variables after the finish;
    when an abort is refused; moving back.
  - Verify: `node -e "const fs=require('fs'),p=require('path');const d='docs/guide';const bad=[];for(const f of fs.readdirSync(d)){const t=fs.readFileSync(p.join(d,f),'utf8');for(const m of t.matchAll(/\]\(([^)#:]+\.md)(#[^)]*)?\)/g)){if(!fs.existsSync(p.join(d,m[1])))bad.push(f+' -> '+m[1])}}if(bad.length){console.error(bad.join('\n'));process.exit(1)}" && pnpm lint`
  - Effort: medium

## Phase 8: Wave 7

- [x] T2826 The live test files for the rehearsal and the real move, and `docs/e2e.md`
  - Lead note (after T2824): the CLI e2e runs each step against its own world (cloud and site through the finish and abort, own-tunnel through prepare only, no `--allow-downtime` window); the rehearsal's legs run the whole move continuously, so they cover the own-tunnel finish and abort and the window through the CLI.
  - Lead note (after T2819's review): record Cloudflare's real status, code and text when a Workers custom domain is refused because another Worker holds the hostname, before anything matches on it.
  - Lead note (after T2817): check whether Cloudflare fills `content` for TLSA, HTTPS and similar records created from `data` (the fake leaves it empty); if not, a re-plan would list them as differences.
  - Lead note (after T2814's review): record how Cloudflare answers `listOriginCertificates` for A's zone once it is moved, and once deleted (about 7 days after activation).
  - Lead note (2026-11-14): B's account id is read from `OPSCREW_E2E_MOVE_TOKEN_B` (`GET /accounts`) when the token sees exactly one account; `OPSCREW_E2E_MOVE_ACCOUNT_B` is required only otherwise. The same holds for A's.
  - Lead note (after T2808): record the SSH probe's status code and duration for an accepted service token (a quick 502, or a held stream until `--max-time 5`); if Access holds the stream, the probe moves to `-I`. Confirm `wrangler deploy --secrets-file` to B and cloudflared's behaviour on a refused token.
  - Owns: `packages/cli/test/live/cloudflare-move*.ts`, the move's section of `docs/e2e.md`
  - Reads: plan 15.; quickstart's live part; `packages/cli/test/live/{harness,retarget-anywhere,own-server,live,snapshots-support,tls-support}.ts`
  - Depends: T2824
  - Accept:
    - Legs L0 to L6 of plan 15., gated on `OPSCREW_E2E_CLOUDFLARE_MOVE=1`, each run on its own with
      vitest `-t`, each skipping with a message without its variables; L4a and L4b chosen by L0's
      registrar; a leg that stops on a wait says when to run it again.
    - L0's inventories of both accounts, including what OpsCrew didn't make (plan 14.), written for
      the lead's checklist; the cleanup removes only P's and Q's pieces and never touches the real
      apps or A's moved zone.
    - The zone, both account ids and every address masked in every output under labels of their own;
      the leak search runs whole.
    - Pure helpers tested in `cloudflare-move-support.test.ts`; `docs/e2e.md` says how to run each
      leg, in which order, and what it costs.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli test/live/cloudflare-move-support.test.ts && pnpm lint`
  - Effort: high

## Phase 8b: OpsCrew's MCP server in other AI apps, in one command (founder, 2026-11-16; independent of the move)

Asked for directly: one command that adds OpsCrew's MCP server to Claude Code, Claude Desktop,
Codex, Cursor and VS Code. Research: R11. It ships in 0.2.10 beside the move.

- [x] T2846 `opscrew mcp install` and `opscrew mcp uninstall`
  - Owns: `packages/cli/src/commands/mcp.ts`, `packages/cli/src/commands/mcp.test.ts`, `packages/cli/src/mcp-clients/**` (new), `packages/cli/src/program.test.ts` (only if it lists commands), `docs/guide/mcp-clients.md` (new), the "Using OpsCrew" list in `docs/guide/index.md`, one line in `docs/guide/claude-code-plugin.md`
  - Reads: research R11; `packages/cli/src/{context,deps}.ts`, `ui/prompts.ts`; `CLOUD_PROVIDERS` (`@opscrew/providers`); `docs/guide/claude-code-plugin.md`; `plugin/.mcp.json`
  - Decided by the lead:
    - **Commands:** `opscrew mcp install` and `opscrew mcp uninstall`, each with `--client <id...>` (ids `claude-code`, `claude-desktop`, `codex`, `cursor`, `vscode`) and `--yes`. `opscrew mcp` alone still starts the server, unchanged.
    - **Finding the apps:** Claude Code when `claude --version` succeeds (through the runner); Claude Desktop when its folder exists (Windows `%APPDATA%\Claude` and each `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`, every one found; macOS `~/Library/Application Support/Claude`; Linux `$XDG_CONFIG_HOME/Claude`, else `~/.config/Claude`); Codex when `$CODEX_HOME` or `~/.codex` exists; Cursor when `~/.cursor` exists; VS Code when `$COPILOT_HOME` or `~/.copilot` exists, or VS Code's user folder (Windows `%APPDATA%\Code\User`, macOS `~/Library/Application Support/Code/User`, Linux `~/.config/Code/User`). `--client` sets an app up even when it isn't found (creating its folder and file); an unknown id is refused, listing the ids. Nothing found and no `--client`: say which apps were looked for and how to name one; nothing changes.
    - **The entry**, named `opscrew` in every app: command `npx`, args `["-y", "opscrew@<this CLI's version>", "mcp"]` on every OS (R11 2.). Claude Desktop and Cursor: `{command, args}`. VS Code: `{type: "stdio", command, args, tools: ["*"]}` in `mcp-config.json`. Codex: `command`, `args`, `startup_timeout_sec = 120` and `env_vars` = OpsCrew's credential variable names. No `env` block and no value, ever (R11 7.).
    - **Credential names for Codex:** `CLOUD_PROVIDERS`' credential variables, plus a list kept in `mcp-clients`: `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `PORTAINER_API_KEY`, `GODADDY_API_TOKEN`, `NAMECHEAP_API_USER`, `NAMECHEAP_API_KEY`, `NAMECHEAP_USERNAME`, `NAMECHEAP_CLIENT_IP`, `PORKBUN_API_KEY`, `PORKBUN_SECRET_API_KEY`, `OPSCREW_HOSTING_TOKEN`, `OPSCREW_HOSTING_USER`, `OPSCREW_SFTP_USER`, `OPSCREW_SFTP_KEY`, `OPSCREW_BESZEL_TOKEN`, `OPSCREW_GRAFANA_CLOUD_TOKEN`, `OPSCREW_APP_ENV_FILE`, `OPSCREW_STORAGE_ACCESS_KEY_ID`, `OPSCREW_STORAGE_SECRET_ACCESS_KEY`, `OPSCREW_OFFSITE_ACCESS_KEY_ID`, `OPSCREW_OFFSITE_SECRET_ACCESS_KEY`, `OPSCREW_OFFSITE_SFTP_KEY`, `OPSCREW_HOME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`. Check each against the code that reads it from the user's environment: drop a name nothing reads, add a credential the MCP tools' phases read that the list misses, and report the final list. An app's own runtime settings and GitHub Actions secrets are not in it.
    - **Showing before writing:** per app, the file and the entry, or "already set up with this version". One question for all of them when interactive; `--yes` writes without asking; non-interactive without `--yes` shows the changes, changes nothing and names the rerun with `--yes`. These are local files, not infrastructure, so there is no plan hash (constitution I covers infrastructure, DNS, provider resources and remote hosts).
    - **JSON files:** parsed; every other key and server kept; an existing `opscrew` entry replaced; written with 2-space indentation and a final newline. A file that isn't valid JSON (comments included), or whose key isn't an object, is left untouched: the output says why and prints the entry to add by hand. A missing file is created with OpsCrew's entry only.
    - **Codex's TOML:** the text outside OpsCrew's tables is kept byte for byte, comments included. The `[mcp_servers.opscrew]` table and its sub-tables are removed and the new block appended. The result, parsed with `smol-toml`, must equal the original's data with only `mcp_servers.opscrew` changed; otherwise (an inline table or dotted keys, say) nothing is written and the entry is printed to add by hand.
    - **Backups and writes:** before changing an existing file, copy it to `<file>.opscrew-backup` (replacing an older one) and name it in the output; write through a temporary file and a rename.
    - **Claude Code:** the plugin (R11 8.). `claude plugin marketplace add opscrew-hub/opscrew` (an "already added" refusal is fine), then `claude plugin install opscrew@opscrew`, or `claude plugin update opscrew@opscrew` when it is already installed. Uninstall: `claude plugin uninstall opscrew@opscrew`. Through the injected runner, never a shell. You may read `claude plugin --help` and its subcommands' help; never run add, install, update or uninstall for real.
    - **Uninstall** removes only OpsCrew's entry (Codex: its tables) and leaves the rest of the file as it was; for an app without it, "not set up".
    - **After writing:** per app, "Restart <app> to load OpsCrew"; then once: no token was written, OpsCrew reads tokens from the environment the app starts in, and the guide page's link.
    - **Side effects:** home folder, environment and platform injected (tests run the Windows, macOS and Linux layouts in a temporary folder); the runner and the prompts through `CliServices`; output through `ctx.stdout`.
  - Accept:
    - Install and uninstall for each of the five apps on each OS layout, including the Microsoft Store Claude Desktop folder, with `--client`, `--yes`, non-interactive and "nothing found".
    - Other servers and keys kept in every JSON file; Codex's comments and other tables kept byte for byte; a second install with the same version changes nothing; a different version replaces the entry.
    - The refusals: a JSON file with comments, a non-object key, Codex's inline-table form, an unknown id. Each leaves the file as it was and prints the entry.
    - Claude Code's runner calls for a fresh install, an already-added marketplace, an already-installed plugin, and uninstall; no `claude` found.
    - A leak check: no value of a variable from the test's environment appears in any file written or any output.
    - `opscrew mcp` with no subcommand still starts the server (its existing tests pass unchanged).
    - `docs/guide/mcp-clients.md`, "OpsCrew in other AI apps": the command; per app, the file it writes and whether approvals appear in the chat (Claude Code, Codex, Cursor and VS Code: yes; Claude Desktop: not documented, so where no dialog appears the tool names the command to run in your terminal); tokens: none written; Codex forwards the names it lists from the environment it starts in; for apps started from the desktop on Windows, user environment variables (set in Windows' settings, then restart the app); elsewhere the vendors don't document it, so run the steps that need tokens in the terminal (`npx opscrew ...`) or start the app from a terminal where they're set; never paste a token into the chat; the first start downloads OpsCrew (about 37 MB); uninstall; the entry per app for adding by hand. Linked from the guide's index ("Using OpsCrew") and from `claude-code-plugin.md`. Facts only from R11.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli src/commands/mcp.test.ts src/mcp-clients src/program.test.ts && node -e "const fs=require('fs'),p=require('path');const d='docs/guide';const bad=[];for(const f of fs.readdirSync(d)){const t=fs.readFileSync(p.join(d,f),'utf8');for(const m of t.matchAll(/\]\(([^)#:]+\.md)(#[^)]*)?\)/g)){if(!fs.existsSync(p.join(d,m[1])))bad.push(f+' -> '+m[1])}}if(bad.length){console.error(bad.join('\n'));process.exit(1)}" && pnpm lint`
  - Effort: high

## Phase 9: The real move and the release (lead)

- [x] T2827 The rehearsal and the real move of opscrew.dev (lead): T2826's legs on the final code,
  with the checklist of plan 15.; `docs/e2e-coverage.md`'s row and results (the gap's figures,
  SC-2801 to SC-2807); then `.env.e2e`'s tokens for the zone become B's.
  - Lead note (after T2825): opscrew.dev's mail goes through Cloudflare Email Routing (its MX records are Cloudflare's, skipped by the zone copy as made by Cloudflare): in the rehearsal, record whether Email Routing can be set up in B while B's zone is pending; tell the founder before the real switch that mail stops until it is set up in B, and set it up right after the activation; check that the switch plan's skipped lines name Email Routing plainly (T2828 otherwise). opscrew.dev is at Cloudflare Registrar and the old account's token can't read it (R10.8's 403): after T2836 the switch tells it from B's zone's `original_registrar`; check that line in the rehearsal.
  - Lead note (founder, 2026-11-15): the lead also redoes in B, by hand through Cloudflare's API with B's token, what OpsCrew doesn't move for the zone: the zone settings A has (SSL mode, minimum TLS, security level, cache level) before the switch; Email Routing (its rules and catch-all; the founder confirms each destination address in B) before the switch if B's pending zone accepts it, else right after the activation; DMARC Management if A has it on; each checked by listing B again. The DNS records (DMARC, Resend, SES, verification records) come with the zone copy. A's token can't read Email Routing's rules: the founder adds the permission or names the rules. He uses no Pages project, Turnstile widget or Web Analytics site (2026-11-15). Email Routing in A (read 2026-11-15 after he added the permissions): one rule (the zone's `hello@` address forwarded to one of his addresses), catch-all off; that destination added to B's account and already verified there; left for B's zone: turn Email Routing on and recreate the rule. B's token expires 2026-11-21 23:59 UTC. Stopgaps on the zone (2026-11-15, the founder's request through another session): Always Use HTTPS on (copy it to B with the other settings), and OpsCrew's www redirect patched in place to T2842's value; so L3 runs only once T2842 is merged (else B's shared plan makes the looping value), and the website's repository is never provisioned with 0.2.9. Done in B (2026-11-15, after L3 made B's pending zone): Always Use HTTPS on (the other four settings already matched A's); Email Routing's rule and catch-all copied; turning Email Routing on is refused on a pending zone (403, code 2009 "Active zone required"), so the lead turns it on right at the activation (mail in between is deferred by senders, not lost).
- [x] T2828 Simplify across the feature's code (lead): the reviews' simplify findings, gathered below by area; one implementer per area so no two edit the same file, each reviewed; then one `/simplify` pass over the feature's diff. Before the real switch (T2827's L3 to L5), so the move runs on the final code; the rehearsal (L0 to L2) may run before it.
  - Wave S1, area switch and domain. Owns: `packages/agents/src/cloudflare-move/{switch,switch-ds,switch-registrar,switch-plan,switch-access,gap,zone,checks}*.ts`, `packages/agents/src/domain/{switch,connect-ds,registrar-lookup}*.ts`, `packages/agents/src/provision/guard*.ts`, `REGISTRAR_HINTS` in `packages/connectors/cloudflare/src/client.ts`.
    - From T2819: `pointToZone` writes its own audit entry, so the switch's "set nameservers" appears twice (give it the phase instead); `dsWaitStatus` starts the wait from the API listing alone (callers check the public DNS first; say so in its doc or check it there); the switch keeps a DS wait note of its own (`switch-ds.ts`) for Cloudflare Registrar and other registrars beside `domain connect`'s `ConnectState`: one note shape if both can share it.
    - From T2825's fact-check: a Cloudflare Registrar refusal during the move's registrar lookup shows `REGISTRAR_HINTS` ("Buying domains is optional…"), wrong for the move (since T2836 only the new account's read after the switch and other callers can still show it): name the Registrar permission there.
    - From T2817's review: coverage repeats part of `checks.ts`'s `opscrewNamesInZone`; one shared reader of the zone's OpsCrew names (with record types and the Workers gap).
    - From T2812's review: the guard's hints name no `--app <key>`/`--env` (as retarget's); pass the command's flags to `requireNoCloudflareMove`.
  - Wave S1, area templates. Owns: `packages/iac-templates/src/**` and its tests and snapshots.
    - From T2835's review: `tunnel.test.ts` ~317 checks the hostname anywhere in the plan (outputs show it too): assert inside the tunnel config's block; `accessArguments` always appends `applications` (drop `ACCESS_APPLICATIONS_ARGUMENT`); `ACCESS_HOLD_TFVARS` built from `ACCESS_HOLD_VARIABLES`.
    - From T2807's review: `runtime/tunnel-next.ts` and `portainer-target/next-connector.ts` copy the main connector's renderers; give those a "next" variant (name suffix and folder) and drop the copies.
    - From T2810 and T2818: export `deploysInPlace` from the package root (the move's summary and deploy secrets repeat it; wave S2 uses it).
  - Wave S2, area secrets and deploys. Owns: `packages/agents/src/cloudflare-move/{deploy-secrets,summary}*.ts`, `packages/agents/src/provision/secrets*.ts`, `packages/agents/src/serverless/cloudflare/checks*.ts`, `packages/agents/src/retarget/site-steps*.ts`.
    - From T2818's review: export `placeText` from `provision/secrets.ts` (copied in `deploy-secrets.ts` and `finish-point.ts`; wave S3 drops the latter); a `deleteSecretAt` beside `setSecretAt` for the three delete-and-audit loops; one helper for `deployToBoth` and retarget's `runSiteWorkflow` (wave S3 makes `finish-point.ts`'s `runDeploy` use it).
    - From T2818: `requireWorkersTokens` takes the token variables' names as parameters, so `deploy-secrets.ts` drops its regex rename; the summary and deploy secrets use `deploysInPlace` from `@opscrew/iac-templates`.
    - From T2821: `dropNewCredentials` asks a `github-secrets` approval even when no `_NEW` secret was ever set: skip what GitHub doesn't have.
  - Wave S2, area shadow states and removals. Owns: `packages/agents/src/cloudflare-move/{shadow,shadow-plans,abort,finish-removal,finish-site,shared,paths}*.ts`, `packages/agents/src/destroy/shared-rules*.ts`, `packages/agents/src/shared/engine*.ts`, `TUNNEL_ID_OUTPUTS`'s export in `packages/agents/src/rotate/infra.ts`.
    - From T2813's review: `approvedPending` repeats `planAndApply`'s approve-path checks (and mirrors retarget's `approvedSavedPlan`; one pending-plan helper for the move and retarget if they can share it); `hasContent` is `shared/engine.ts`'s `hasState` taking a path.
    - From T2821 and T2822: both copy a bucket root without its `prevent_destroy` block (`cloudflare-move/delete/` and `cloudflare-move/a-removal/root/`): one helper; both copy `tunnel_id`/`portainer_tunnel_id`: export `TUNNEL_ID_OUTPUTS` from `rotate/infra.ts` and use it here (wave S3 uses it in prepare and the finish). From T2822's review: `finish-site.ts`'s `shadowAddresses` repeats shadow.ts's `state list` without `TF_DATA_DIR` (one `shadowStateAddresses`).
    - From T2814's review: `removeBShared` repeats `destroy/shared-rules.ts`'s `planSharedRemoval`; give that `client`/`recordPath`/`pendingZone` and call it; fold the `cloudflare-move/` path helpers (`moveDir`, `aSharedRecordPath`, T2813's) into one.
    - From T2820: `SharedStep.oneTimePinId` is unused (`accountIds` reads B's PIN login): drop it.
  - Wave S3, area connectors, prepare and the finish's steps. Owns: `packages/agents/src/cloudflare-move/{connector,connector-stacks,prepare,finish,finish-point,buckets}*.ts`, `packages/agents/src/rotate/{infra-connectors,portainer}*.ts`, `packages/agents/src/provision/{stack-plan,portainer-flow}*.ts`, `packages/iac-templates/src/runtime/index.ts` (the wrapper only).
    - From T2815's review: rotate's connector factories audit under rotate's phases during a move (give them a `phase` input), and a check before the Portainer takeover's restart would need them to plan with B's tokens; `waitForTunnelToClose` taking an optional client instead of the move's own wait; `TunnelConnectors.restart` returning the hashes it applied so `restartHash` can go; `nextStacksStep` calls `applyStackPlanAudited` (T2832's `nextTunnelTokens` landed). From T2815: one shared move phase constant (`MOVE_PHASE`); `applyStackPlanAudited` taking an injected apply instead of repeating its audit lines; the cloud server's beside-connector folder named once.
    - From T2820: the beside connector's host and stack plans stop a script with APPROVAL_REFUSED and an `--approve` hint: give them the move's one pattern (`appliesNow`, `writePending`, a stop with the exact command); prepare's B setup refresh repeats `session.ts`'s `setupCloudflare` call; `TUNNEL_OUTPUTS`/`tunnelsOf` and `finish-point.ts`'s `bTunnels` use `TUNNEL_ID_OUTPUTS` and one reader. From T2820's review: an interruption between `firstCopies` and the `prepared` write asks the copy's approval again and lists both buckets: `copyBuckets` records that the first copies ended.
    - From T2823: `provisionServices` is in both `connector.ts` and `finish-point.ts`; `runDeploy` uses wave S2's deploy helper; `finish-point.ts`'s `placeText` uses wave S2's export; `serverAppEnv` repeats `move/app-env.ts`'s read of `app.env` over SSH.
    - From wave S2's shadow area: `finish-point.ts` (~111) builds its `cloudflare-move/` path by hand: use `moveFolder` from `cloudflare-move/paths.ts` (and `deploy-secrets.ts` ~199, if wave S2's secrets area didn't); the abort's `TUNNEL_ID_OUTPUTS` is exported from `rotate/infra.ts`.
    - From wave S1's templates: `connector.ts` calls `renderTunnelConnectorCompose(plan, { next: true })`, and `runtime/index.ts`'s `renderNextTunnelConnectorCompose` wrapper goes (the templates file is then this area's too).
    - From wave S2's secrets area: `finish-point.ts`'s `runDeploy` uses `runDeployWorkflow(deps, { api, owner, repo }, plan, phase, texts)` from `retarget/site-steps.ts` (`unchanged` omitted, hints naming the command, `environment: environment.environment`); its `placeText` uses `provision/secrets.ts`'s export.
  - Wave S4, area texts, types and the session. Owns: `packages/agents/src/cloudflare-move/{texts,types,session,index}*.ts` and the texts' callers across `packages/agents/src/cloudflare-move/**`, `packages/connectors/cloudflare/src/testing/**`.
    - From T2822's and T2823's reviews: `appWords`/`accountWords`/`environmentDeps` are repeated in `finish.ts`, `finish-point.ts`, `buckets.ts`, `finish-removal.ts`, `shared.ts` and shadow-plans.ts (`accountName`): one set in `texts.ts`; the texts kept per file.
    - From T2821 and T2824: `TypedNameOptions.confirm`/`typeName` is unused in the move (typed names go through `confirmPhrase`): drop it.
    - From T2825's fact-check: a move back while the old account still holds the moved zone stops in `setupCloudflare` ("moved to another Cloudflare account"): the target's zone lookup skips a `moved` zone.
    - From T2810: let the two-account fake answer `GET /ips` so tests drop their fetch wrapper.
    - From wave S3: `MOVE_PHASE` (in `connector-stacks.ts`) moves to `texts.ts`, and the `"cloudflare-move"` phase literals elsewhere use it; prepare's B setup refresh shares `session.ts`'s `setupCloudflare` call (a helper there).
  - Left for T2827: from T2819's fixes, `attachWorkerDomain` throws a typed refusal for "the hostname already has an assigned Worker", typed by the status, code and text the rehearsal records (not 100117, which the fake uses for externally managed DNS records), so the switch stops matching the message text.
  - Accepted, not changed: from wave S4: a move back while the old account still holds the moved zone gets past the session (a `moved` zone counts as none) but stops at the zone step (adding the zone again, then `setupCloudflare` on the moved one); the guide says a move back waits until Cloudflare deletes the moved zone; whether Cloudflare lets an account add a zone it holds as moved is unknown; from wave S3's review: `finish-point.ts`'s `provisionServices` beside `connector.ts`'s `serverServices` (different inputs); from wave S3: the check before the Portainer takeover's restart (optional), `waitForTunnelToClose` taking a client and `nextStacksStep` through `applyStackPlanAudited` (both in shared files with other callers), `serverAppEnv` (no reader of `app.env` alone to share), and the Portainer takeover's restart stopping a script with APPROVAL_REFUSED and its `--approve` hint (a rerun with it goes on: the stacks already hold B's tokens); `approvedPending` beside `planAndApply` and retarget's `approvedSavedPlan` (its checks run before `planAndApply`'s, whose hints name `--plan-only`, which the move has no use for); `deleteSecretAt` for `destroy/common.ts`'s and `rotate/app-site.ts`'s delete loops, and an `environmentSecretExists` in the GitHub connector so `dropNewCredentials` also skips environment secrets GitHub doesn't have (later, outside the move); one DS wait note shape for the switch and `domain connect` (it needs `connect-state.ts`'s `registrar` optional; about 35 lines saved, left as is); a Portainer rerun after a failed stack apply in step 1 asks the stack's approval again while the app is stopped (after an error only); the two rclone call sites already share `shared/rclone.ts`.
- [x] T2829 `CLAUDE.md`'s package notes (the move's folder), and the roadmap: 028 done (lead).
- [x] T2830 The release 0.2.10, following `docs/releasing.md` (lead).

## Dependencies and waves

| Wave | Tasks | Depends on |
|---|---|---|
| Lead | T2801, T2802 | — |
| 1 | T2803, T2804, T2805, T2806, T2807, T2808, T2809 | T2801 |
| 2 | T2810, T2811, T2812 | each its own of wave 1 |
| 3 | T2813, T2814, T2815, T2816, T2817, T2818 | wave 2, T2802 |
| 4 | T2819, T2820, T2821, T2822 | wave 3 |
| 5 | T2823, T2836 | T2822 and wave 3; T2836 after T2819 |
| 6 | T2824, T2825 | waves 4 and 5 |
| 7 | T2826 | T2824 |
| 8b | T2846 | — (independent of the move) |
| 9 | T2847, T2848, T2849, T2850 | found at the real move; T2850 after T2848 for the RDAP lookup |
| Lead | T2827, T2828, T2829, T2830 | T2826; T2830 also T2846 to T2850 |

No two tasks of a wave share an `Owns` path. Wave 1's connector files are T2804's (`client.ts`,
`index.ts`) and T2805's (`testing/**`, `shared.ts`); its template files are T2807's (new files and
the index export lines) and T2808's (`workflow/{index,portainer,cloudflare-workers}.ts`,
`infra/serverless.ts`). Wave 2's provision files are T2811's (`plan-apply`, `credentials`,
`shared-cloudflare`, `origin-tls`, `storage`) and T2812's (`guard`). Wave 3's are T2815's
(`portainer-flow`, `stack-plan`) only. Wave 4's finish files are T2822's (`finish-removal`,
`finish-site`); T2823 owns the rest of `finish*` in wave 5.
