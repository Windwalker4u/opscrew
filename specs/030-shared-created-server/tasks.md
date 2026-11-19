---
description: "Tasks for 030-shared-created-server"
---

# Tasks: Apps from several repositories on a server OpsCrew created

**Status**: building since 2026-11-19 (the founder's choice that day: build sharing, then deploy his
second app beside his first).

**Input**: `specs/030-shared-created-server/` (spec.md, plan.md, research.md R1–R6) + features 011
(own servers, ADR 0011), 013 (several apps on one own server), 022 (previews on another
environment's server, ADR 0026 R7), 024 (snapshots), 025 (rotation); ADR 0035.

**Numbering**: T3001–T3099. Plan sections are written "plan N.".

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Words**: the *first app* owns the server; a *second app* shares it (spec). User-facing text
  says "another app" / names the app, never "guest", "host app", a feature or a task number.
- **Approvals**: every change through a plan approved by its hash (plan, Constitution Check I).
  `--yes` never approves a plan; `--skip-other-apps-check` never approves anything.
- **Leaks**: the first app's deploy key is read by path and never copied, logged or sent to
  GitHub; no server address, key or token in output, plans, `-var`s, state, logs, audit entries,
  saved plans, records, commits or MCP answers. Every agents task's tests end with a leak check
  over everything its fakes saw.
- **Refusals** come before any change, in plain words, ending "Nothing was changed." with what to
  do next.
- **`agents/src/shares/` has no `index.ts`**: callers import the file (`../shares/first-app`).
- **No network in unit tests**: the scripted remote and `FakeHostServer`
  (`agents/src/testing/own.ts`), the Cloudflare and GitHub fakes, the engines from `.tools/bin`
  where a test needs `init` (skipping without them).
- **Temp files**: run tests with `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.
- **Scope**: build only what Accept asks. Report anything else as a finding.
- **Writing files**: long files with the Write or Edit tool, not shell heredocs.
- **Examples**: neutral only: `example.com`, `example-app`, `203.0.113.10`, `2001:db8::10`,
  `github.com/example/inventory`.
- **Worktrees**: each task in its own `D:/opscrew/.claude/worktrees/t30NN`, branched from
  `030-shared-server`; `pnpm install` first; commit there with the Co-Authored-By trailer.

## Phase 1: Foundation (lead)

- [x] T3000 Research, spec, plan, ADR 0035, the roadmap's new 030 (lead)
  - Effort: lead

## Phase 2: Wave 1 (parallel)

- [ ] T3001 [P] [US1] `target.shares` in the plan
  - Owns: `packages/plan-schema/src/plan.ts` (`OwnTargetSchema.shares` and its refinement only),
    `packages/plan-schema/src/index.ts`, `packages/plan-schema/schemas/**` (regenerated),
    colocated tests
  - Reads: plan 1.; `OwnTargetSchema` and its refinements in `plan.ts`; how `home` was added
  - Accept: the key as plan 1. shows; `shares` with `access: "tunnel"` or with `home` is refused
    with the message "a server OpsCrew created is reached at its public address"; every existing
    fixture parses unchanged; the JSON schema regenerated; tests for both refusals and a valid
    second-app target.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema && pnpm lint`
  - Effort: medium

- [ ] T3002 [P] [US1] [US3] The host adapter's second-app mode
  - Owns: `packages/connectors/ssh-host/src/**` (types.ts `DesiredHost.shares`; facts.ts
    `AppRecordSchema.shares`/`.repository`; plan.ts, steps.ts, findings.ts, apply.ts, inspect.ts
    for plan 3. and 4.), colocated tests and `__fixtures__`
  - Reads: plan 2.–4.; research R3, R4; `planHost`, `deployKeyStep`, `planTeardown`,
    `claimFindings`, `privilegeFindings`, `planNetwork` (how it takes the `docker` privilege),
    `probePrivilege`, `rootCall` (`privilege.ts`), `applyHostPlan`, `runAsOf`/`LOGIN_STEPS`
  - Accept:
    - `DesiredHost.shares` and the record fields as plan 2.
    - `planHost` with `shares`: exactly plan 3.'s step list; a test lists the step ids of a
      second-app plan and asserts no shared root step appears. `docker` privilege accepted;
      `root`, `sudo`, `none`, `sudo-password` blocked with findings.
    - The second-app `deploy-key` form: a fixture `authorized_keys` with the first app's key,
      another repository's check-key line, a preview line and one unknown line keeps all four,
      in order, and adds the app's key; a rotation keeps the previous key; the removal drops only
      the app's lines. Its script refuses to write when the file changed since inspection.
    - Claims over the records plus `shares.host`: the first app's name, a hostname of its, a
      differing access, and `<first>-pr-3` each give a blocking finding naming the first app; a
      desired `sysctl` is a blocking finding naming the first app's server setup;
      `runtime-dirs` missing blocks.
    - `planTeardown(…, { shares: true })` keeps the edge, the check key and Portainer even with no
      other record; removes only the app's key lines; keeps the record as `data-kept` without
      `deleteData`.
    - `inspectHost` with `rootImage` reads the records as root through Docker; no
      `/etc/opscrew/apps` means no records.
    - `applyHostPlan`: in a second-app plan only `app-record` (and the teardown's record removal)
      runs through the Docker privilege; every other step as the login (a test over the scripted
      remote's calls).
    - Every existing own-server and created-server test passes unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - Effort: xhigh

**From T3002 (lead, 2026-11-19), for every caller of the second-app mode:**
- `planHost(…, { image })` and `planTeardown({ shares: true, image, … })` need the pinned image
  the deploy login removes data in: `IMAGES.busybox.ref` from `@opscrew/iac-templates`.
- A proxied second app passes `webFilter` (Cloudflare's ranges, as own servers do). It marks the
  app's way of serving for the claim against `shares.host.access`; no web-filter step is planned.
- The record keeps a rotation's old key (`previousDeployKey`) until the next plan removes it, so
  `rotate deploy-key` works unchanged.
- `planTeardown({ shares: true, … })` also takes the app's current deploy public key
  (`deployKey`) and the first app's name (`firstApp`). It removes the app's key line even when
  no record exists (a failed first provision), and it refuses to tear down the first app or a
  Compose project of that name with no record of this project's.
- Open, for later: the check-key, preview and rotation writers of `authorized_keys` don't take
  `~deploy/.ssh/.opscrew-keys.lock` yet. A line one of them adds between a second app's read and
  its rename would be lost. The window is short, since the rewrite verifies the other lines' hash
  first.

## Phase 3: Wave 2

- [ ] T3003 [US1] [US2] [US3] The reference, the first app and the logins
  - Owns: `packages/agents/src/shares/{reference,first-app,login,guard}.ts` (new), colocated
    tests, `packages/agents/src/shared/server-record.ts` (`own.shares`, `own.joined` only),
    `packages/agents/src/testing/own.ts` (a created server with records and `docker` privilege
    in `FakeHostServer`, only as the tests need)
  - Reads: plan 5., 9.; research R2; `agents/src/previews/host.ts` (`previewServer`,
    `hostDeployLogin`, `sharedServerReach`, `refusedBeforeChange`, `sharedPreviewsOn`),
    `environments/paths.ts`, `provision/origin-tls.ts` (`deployLogin`), `shared/own-server.ts`
    (`connectPinnedLogin`, `inspectOwnHost`), `design/sizing.ts` (`ownServerMemory`)
  - Depends: T3001, T3002
  - Accept:
    - `own.shares`/`own.joined` as plan 5.; with `shares` the record refuses `reachable`,
      `serve` and `home`, and `user` must be `deploy`.
    - `readShares`, `firstAppPaths`, `firstApp` with each refusal of plan 5. (one test each);
      `hostDescription(plan)` (hostnames from every hostname the plan serves, access, memory).
    - `secondAppLogin`: the first app's deploy login until `joined`, the app's own key after; the
      pinned host key is the first app's and is copied into the app's `known_hosts`; a different
      key offered by the server stops as a changed host key does today.
    - `otherAppsOnServer` and `requireNoOtherApps` as plan 9.: records found (active and
      `data-kept`), unreachable without and with `skip`, no deployment; the refusal names the app
      and its repository.
    - `otherAppsMemory(facts)`.
    - Leak test: the first app's key path's file content never appears in anything the fakes saw.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/shares src/shared && pnpm lint`
  - Effort: high

**From T3003 (lead, 2026-11-19), for T3004–T3008:**
- `firstAppPaths(paths, ref)` takes this computer's paths (the first app's key and known_hosts
  are in this computer's OpsCrew home). `firstApp(deps, ref)` returns `{ paths, plan, address,
  login, keyFile, hostKey }`.
- `secondAppLogin(deps, ref, own, options?)` returns an `OwnServerSession`. Before `joined` it
  records the first app's host, port and host key fingerprint in `own`.
- `otherAppsOnServer` reports "not reached" when the login's privilege isn't `docker`, not only
  when SSH fails. `requireNoOtherApps(deps, plan, what, again, { skip })` follows plan 9.
- `hostDescription(plan)` lists every hostname the plan serves, the add-ons' subdomains too.
- Test helpers in `agents/src/testing/own.ts`: `createdServerFacts(records)`,
  `secondAppRecord(o)`, `sharedServerProject(o)`. The last returns `firstKey` for the leak
  checks.

## Phase 4: Wave 3 (parallel)

- [ ] T3004 [P] [US1] [US4] Interview, design and a second app's environments
  - Owns: `packages/agents/src/interview/{own-server,run}.ts`, `packages/agents/src/design/{own,own-servers,run}.ts`,
    `packages/agents/src/shared/own-server-design.ts`, `packages/agents/src/environments/add.ts`,
    colocated tests and `__fixtures__`
  - Reads: plan 6., 7., 10.; spec US1, US4; `agents/src/shares/*` (T3003)
  - Depends: T3003
  - Accept:
    - The interview choice and the three answers as plan 6.; the answers file; a wrong folder
      stops at the end of the interview with `firstApp`'s refusal.
    - Design as plan 7., steps 1–7, each with a test: a differing proxy stops; a proxied first
      app with a second domain not on Cloudflare stops naming the alternatives; the memory
      refusal and the 15% warning count the first app and the other records; the target written;
      the option without a price; the warning in the summary; a taken hostname stops in design.
    - `env add` for a second app as plan 10.
    - Leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/interview src/design src/environments && pnpm lint`
  - Effort: xhigh

- [ ] T3005 [P] [US1] [US3] A second app's provision and its own commands
  - Owns: `packages/agents/src/provision/own.ts`, `packages/agents/src/provision/secrets.ts` (the
    second app's `HOST`/`KNOWN_HOSTS` only), `packages/agents/src/destroy/own.ts`,
    `packages/agents/src/secure/own.ts`, `packages/agents/src/previews/host.ts` (`hostProblem`:
    a second app's server), colocated tests
  - Reads: plan 8.; spec US3; `agents/src/shares/*` (T3003)
  - Depends: T3003
  - Accept:
    - Provision as plan 8.: the DNS-only infrastructure root with the first app's addresses, the
      host plan in the second-app mode through `secondAppLogin`, `own.joined` after a successful
      apply, the secrets, the warning in the approval; provision again shows no changes.
    - Destroy as plan 8., logged in with the app's own key, without the first app's folder.
    - Secure and the previews refusal as plan 8.; the unchanged commands each with a test
      (drift of a second app's own parts; `rotate deploy-key` keeps the other lines). The other
      refusals of plan 8. (whole-server snapshot, Beszel, Portainer, closing public SSH) are
      T3006's, in the same files as the first app's guards.
    - Leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/provision src/destroy src/secure src/previews && pnpm lint`
  - Effort: xhigh

- [ ] T3006 [P] [US2] The first app's guards
  - Owns: the call sites of plan 9.'s table in `packages/agents/src/{destroy/run.ts,retarget/run.ts,retarget/finish.ts,provision/run.ts,snapshot/server.ts,secure/public-ssh.ts,addons/run.ts,portainer/run.ts,vpn/devices.ts,vpn/grants.ts}`
    (the guard calls only), and in the same files the second app's refusals of plan 8.
    (whole-server snapshot and restore, Beszel, Portainer, closing public SSH, each naming the
    first app); `packages/agents/src/drift/{servers,host}.ts`, `packages/agents/src/status/**`
    (the "Also on this server" line), `packages/agents/src/advise/readings.ts`, colocated tests
  - Reads: plan 9.; spec US2; `agents/src/shares/guard.ts` (T3003); every `requireNoSharedPreviews`
    call site for the pattern
  - Depends: T3003
  - Accept:
    - Each row of plan 9.'s table refuses before any change with a record on the server, runs
      unchanged without one, and stops when unreachable unless `skipOtherAppsCheck` (one test
      per row).
    - The second app's refusals of plan 8. in these files, one test each.
    - The resize check as plan 9. (refuse when it doesn't fit; the restart line when it fits).
    - drift, status and advise as plan 9.
    - Commands that receive `skipOtherAppsCheck` take it as an option the CLI (T3007) passes;
      list them in the report.
    - Leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/destroy src/retarget src/provision src/snapshot src/secure src/addons src/portainer src/vpn src/drift src/status src/advise && pnpm lint`
  - Effort: xhigh

**From T3004 (lead, 2026-11-19):**
- A second app's first plan takes the proxy (`target.edge`) the first app's server runs. A plan
  that already names another proxy is refused, naming both.
- Design's dry claim check calls provision's `desiredHost` and adds `shares`. It creates this
  app's deploy key on this computer if it's missing (`ensureDeployKey`).
- The interview still asks the budget for a second app (`questions.ts`/`answers.ts`). Leave it
  for the simplify pass.
- The exported `serverKindQuestion` and `buildSharesQuestions`, and `InterviewResult.shares`.

**From T3004's and T3005's reviews and reports (lead, 2026-11-19):**
- The first app's folder may appear in error messages saved to the gitignored
  `.opscrew/state.json`. It helps the user and is never committed.
- A second app's design needs the repository's GitHub `origin` and reads Cloudflare's IP ranges,
  because its dry claim check uses provision's `desiredHost`. The guide (T3009) says so.
- `drift` and `rotate deploy-key` of a second app read the first app's plan from its folder, as
  provision does (FR-3009).
- For the simplify pass: `sharedAccessWarning` (provision/own.ts) and design's copy; the
  `shares.host` that design sets again over `desiredHost`'s; the budget question.
- Open: a second app's commands once the first app's server is gone (spec edge case). Its
  destroy should then remove its DNS and Cloudflare parts and record the deployment gone.

**From T3006 (lead, 2026-11-19), accepted:**
- `destroy` looks only when the plan deletes the server (`module.server.*`), after the preview
  plan; a rerun once the server is gone needs no flag.
- `retarget` start looks inside its phase, after the site refusals, and only when the deploy key
  is on this computer.
- `vpn grant` has no guard, since a server on a private network takes no second app. `vpn add`
  looks only when it creates the network.
- Beszel's guard sits after its input checks, so its hub secrets may be written locally first.
- The phases with `skipOtherAppsCheck`: `runDestroy`, `runRetarget`, `runProvision` (and
  `opscrew dns`), `restoreServerSnapshot`, `closePublicSsh`, `addonEnable` (Beszel),
  `portainerEnable`, `vpnAdd`. Tests inject `otherApps` (`OtherAppsServices`); the helpers
  `firstAppLook` and `noOtherApps` are in `agents/src/testing/other-apps.ts`.
- T3007: the CLI and MCP tests that now meet the guards need those fixtures: cli commands addon
  (8), destroy (5), vpn (5), rotate-dispatch (2), secure (1), and mcp-server tools/addons (1).
- For the simplify pass: `appWords` exists in both `shares/guard.ts` and `status/other-apps.ts`.

## Phase 5: Wave 4 (parallel)

- [ ] T3007 [P] [US1] [US2] CLI and MCP
  - Owns: `packages/cli/src/**`, `packages/mcp-server/src/**`, colocated tests
  - Reads: plan 11.; T3004's and T3006's reports (the options)
  - Depends: T3004, T3005, T3006
  - Accept: the answers keys (already in `SERVER_FIELDS`: check the interview's help and
    the MCP answers' descriptions name them), `--skip-other-apps-check` on every command T3006 lists, their help text, the MCP inputs;
    a CLI test per flag reaching its phase option.
  - Verify: `pnpm turbo run typecheck test --filter=opscrew --filter=@opscrew/mcp-server && pnpm lint`
  - Effort: high

- [ ] T3008 [P] [US5] A second app moves off
  - Owns: `packages/agents/src/retarget/sides/own.ts`, `packages/agents/src/retarget/finish.ts`
    (the second app's old side only), colocated tests
  - Reads: plan 12.; `retarget/sides/ssh.ts` (`sharedEdge`, `edgeShared`)
  - Depends: T3005, T3006
  - Accept: a second app's old side keeps the edge during the move and is removed by
    `planTeardown` with `shares: true` at `--finish`; moving onto a server as a second app is
    not offered; leak test.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/retarget && pnpm lint`
  - Effort: high

- [ ] T3009 [P] [US1] [US2] [US3] The guide
  - Owns: `docs/guide/shared-server.md` (new), and the links in `docs/guide/{index,hetzner,digitalocean,contabo,own-server,several-apps,public-ssh,snapshots,retarget}.md`
  - Reads: plan 13.; spec; T3007's flags
  - Depends: T3007
  - Accept: the page as plan 13., written for users (no task or feature numbers), each command
    and flag as T3007 ships them; the links.
  - Verify: `pnpm lint`
  - Effort: medium

- [ ] T3014 [P] [US1] [US2] [US3] The live test for L1
  - Owns: `packages/cli/test/live/shared-server.test.ts`, `packages/cli/test/live/shared-server-support.ts`
    (+ its `.test.ts` for the pure helpers), the section "A second app on a server OpsCrew
    created" in `docs/e2e.md`
  - Reads: plan 15. (L1); spec SC-3002–SC-3006; `packages/cli/test/live/previews-shared.test.ts`,
    `several-apps.test.ts`, `harness.ts`, `support.ts`, `cloud.ts`; docs/e2e.md "Setup"
  - Depends: none for writing it (it calls the CLI's planned flags: `--skip-other-apps-check`,
    the answers keys `server.shares`); it runs once T3007 is merged
  - Accept:
    - With `OPSCREW_E2E_SHARED_SERVER=1`, in `OPSCREW_E2E_GITHUB_REPO_C`, the first app
      `examples/koa-knex` (seeded, as previews-shared does) runs on a throwaway Hetzner CX23
      behind Cloudflare at the run's own hostname. A further app (`app add`) from
      `examples/express-api` joins its server at a second hostname. Both use names of the run's own
      that never start with `e2e-`, which 029's passes use.
    - The steps of plan 15. L1, each its own `it` with a clear title.
    - SC-3002: a request every second against the first app's site through the second app's
      provision, first deploy and destroy, with zero failures (status and count kept).
    - SC-3003: `deploy`'s `authorized_keys`, read through the first app's deploy login, is
      compared line by line, by SHA-256 of each line and never printed, before the join and after
      the destroy.
    - Each first-app guard refuses with exit ≠ 0, its refusal text, and nothing changed (the plan
      files and the server's facts unchanged).
    - Cleanup in `afterAll` deletes only the run's own resources, matched by the run's labels or
      ids; the Hetzner project also holds production servers.
    - A leak check over every output of the run.
    - The docs/e2e.md section: what it checks, variables, the command, its cost.
  - Verify: `pnpm turbo run typecheck --filter=opscrew && npx vitest run --root packages/cli test/live/shared-server-support.test.ts && pnpm lint`
  - Effort: high

## Phase 6: Live and finish (lead)

- [ ] T3010 (lead) Live L1, the throwaway pair (plan 15.), after the 029 lead's OK; results in
  `docs/e2e-coverage.md`
- [ ] T3011 (lead) Live L2, the founder's second app beside his first (plan 15.)
- [ ] T3012 (lead) The simplify pass over the feature's diff
- [ ] T3013 (lead) `CLAUDE.md` and the roadmap (030 done); the changelog entry to the release's
  lead
