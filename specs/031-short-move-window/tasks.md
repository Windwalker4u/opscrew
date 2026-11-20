---
description: "Tasks for 031-short-move-window"
---

# Tasks: A move's maintenance window of about a minute

**Status**: building since 2026-11-20, for 0.2.11 (the founder's decision that day).

**Input**: `specs/031-short-move-window/` (spec.md, plan.md, research.md); features 023 (retarget
anywhere) and 030 (FR-3027, the move's marker).

**Numbering**: T3101–T3199.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile. No real secret in any test: `fakeSecret(kind)` and
`{{FAKE:<kind>}}` (`@opscrew/core/testing`).

**Rules for every task:**
- **Approvals:** every change goes through a plan or approval as today. The pre-copy needs none: it
  reads the old side and writes only the new side's mounts.
- **Leaks:** no address, key, token or file content in output, logs, audit entries or fixtures.
  Every agents task's tests end with a leak check.
- **Words:** user-facing text says "the maintenance window", "while your app serves", and never
  names a task or a feature number.
- **No network in unit tests;** the Docker client and the move fakes.
- **Temp files:** run tests with `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.
- **Scope:** build only what Accept asks. Report anything else.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Worktrees:** `D:/opscrew/.claude/worktrees/t31NN`, branched from `main`; `pnpm install` first.

## Phase 1: Foundation (lead)

- [x] T3100 (lead) Spec, research, plan, tasks; the roadmap's new 031

## Phase 2: Wave 1 (parallel)

- [x] T3101 [P] [US1] The carrier's delta operations
  - Owns: `packages/connectors/docker/src/**` (the carrier and its tests)
  - Reads: plan 1.; `carrier.ts` (`DIGEST_SCRIPT`, `readVolume`, `writeVolume`, `volumeDigest`),
    `one-off.ts`, `client.ts`
  - Accept:
    - `ManifestEntry`, `volumeManifest`, `readPaths` and `updateVolume`, exactly as plan 1.
      gives them, exported from the package root.
    - The manifest's facts are the ones `DIGEST_SCRIPT` hashes, and an unchanged source's
      manifest is identical on two reads.
    - Path lists go through a file in the carrier, never as arguments.
    - Names with spaces, leading dashes and newlines are handled. A newline in a name is refused
      with a plain message, which the move turns into a full copy of that mount.
    - `updateVolume` keeps owners and modes, removes deepest first, and never touches a path
      outside the mount.
    - Today's checks and the carrier cleanup apply to the new operations too.
    - Tests with the Docker client's fake, plus a Docker test (`OPSCREW_DOCKER_TESTS=1`): a
      volume changed, extended and trimmed after a full copy is brought to the same
      `volumeDigest` by `readPaths` and `updateVolume` of the delta.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/connector-docker && npx vitest run --root packages/connectors/docker && pnpm lint`
  - Effort: high

- [ ] T3102 [P] [US1] [US2] The pre-copy, the app checked before the window, and the window's
  delta
  - Owns: `packages/agents/src/retarget/**`, `packages/agents/src/testing/move.ts`, colocated
    tests; `packages/cli/src/ui/retarget.ts` and `packages/cli/src/commands/retarget.test.ts` for
    the texts
  - Reads: plan 2.–4.; spec; `retarget/window.ts`, `retarget/steps.ts`, `retarget/sides/ssh.ts`,
    `sides/portainer.ts`, `sides/types.ts`, `retarget/server-ops.ts`; 030's FR-3027 (the marker)
  - Depends: T3101's interface, as plan 1. gives it. Code against it with a fake carrier in
    `testing/move.ts`, and use the real carrier's methods once T3101 is merged.
  - Accept:
    - **Plan 3.'s flow:** the pre-copy, then the app started on the pre-copied data and checked
      over SSH before the window's approval, with a failure stopping before any downtime.
    - **The window:** the delta per mount through `mountDelta`, the digest check, Postgres as
      today, the release command on the final data, and the app restarted in place. No workflow
      run in the window.
    - **Rollback** as today. A rerun at the approval doesn't copy again.
    - **A Portainer new side** gains the pre-copy and the delta.
    - **Plan 4.'s texts and estimates**, with the CLI's question and summary to match.
    - **Tests with fakes:**
      - a move whose mounts change between the pre-copy and the window: only the delta is
        copied, removed paths go, and the digests match;
      - the old app stopped only from the window's start;
      - no workflow dispatched inside the window;
      - a health failure on the pre-copied data stops before the window;
      - the PHP app's case: a kept folder plus MySQL, with Railpack's PHP image and a release
        command needing data;
      - a Portainer new side;
      - a move with nothing to copy, unchanged;
      - a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/agents src/retarget && npx vitest run --root packages/cli src/commands/retarget.test.ts src/ui && pnpm lint`
  - Effort: xhigh

## Phase 3: Then

- [ ] T3103 [US1] [US2] The guide
  - Owns: `docs/guide/retarget.md`
  - Depends: T3102
  - Accept: plan 5., written for users.
  - Verify: `pnpm lint`
  - Effort: medium

- [x] T3105 (lead, after T3102's merge) Two findings from the PHP app's abort (CLI 82bd7c6a):
  - **The health check:** `reportAborted` checks the old side once, right after its restart, and
    warns "does not answer its health check" while the app is healthy. Give it the window's
    bounded wait.
  - **The cost item:** `oldCost` writes "Your own server (you already pay for it)" for a second
    app's old side. Write design's item, `"<first>"'s server (priced with "<first>")`, through one
    helper shared with `design/own.ts`.

  Tests for both.
## Phase 4: A new server whose first boot failed (US3, the founder's decision of 2026-11-20)

The contract (lead, before the wave): `ServerSnapshotApi` in `packages/contracts/src/connector.ts`
gains the optional `restart(serverId)` and `reinstall(serverId, { image, userData })`, and the repair is offered only where a connector has them:
- **`restart`:** reboots the server through the provider.
- **`reinstall`:** installs the server again from a provider image, keeping its id and addresses,
  with first-boot `userData`. It is destroy-grade, for a new server only. Hetzner and DigitalOcean
  keep the creation's user data and rebuild from the image; Contabo needs it passed.

- [ ] T3106 [P] [US3] The connectors' restart and reinstall
  - Owns: `packages/providers/{hetzner,digitalocean,contabo}/src/**`, their fakes and tests
  - Reads: the contract above; each connector's `powerOn`/`rebuild` code
  - Accept:
    - **Hetzner:** `restart` is `POST /servers/{id}/actions/reboot`; `reinstall` is
      `POST /servers/{id}/actions/rebuild` with the image name.
    - **DigitalOcean:** `restart` is the droplet action `reboot`; `reinstall` is the action
      `rebuild` with the image.
    - **Contabo:** `restart` is `POST /v1/compute/instances/{id}/actions/restart` (no body);
      `reinstall` is `PUT /v1/compute/instances/{id}` with `imageId`, the server's `sshKeys` as it
      has them, `userData` and `defaultUser: "root"`.
    - **For every provider:** both resolve once the provider has accepted the action, and wait for
      it where the provider reports actions. Any password the provider answers with is dropped.
      The tests check each request and that no credential is logged.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/provider-hetzner --filter=@opscrew/provider-digitalocean --filter=@opscrew/provider-contabo && pnpm lint`
  - Effort: high

- [ ] T3107 [P] [US3] The wait's diagnosis and its repair
  - Owns: `packages/agents/src/shared/wait.ts` and its callers' wiring, `packages/iac-templates/src/**`
    (a TypeScript renderer of `shared/cloud-init.yaml.tftpl`), `packages/cli/src/**` (the flag),
    `docs/guide/` (one paragraph where new servers are described), colocated tests
  - Reads: spec US3, FR-3108–FR-3110; `shared/wait.ts` (`waitForSsh`, `waitForCloudInit`,
    `pinHostKey`); the contract above
  - Accept:
    - FR-3108–FR-3110, as follows.
    - **The diagnosis:** read `/var/lib/cloud/data/result.json` as deploy, and name the failed
      steps in plain words (`package_update_upgrade_install` is "the package install", `runcmd`
      is "OpsCrew's setup script", and so on).
    - **The approval:** typed name, with a script's `--confirm <app>`. The approval names the
      server and that it holds nothing yet.
    - **The install's first-boot file:** rendered by a TypeScript function from the same template
      as the module's `templatefile`. A test checks it byte for byte against OpenTofu's rendering
      (with `.tools/bin` tofu, skipping without it).
    - **Callers:** provision's creation and a move's new side, before their first deploy.
    - **Tests with fakes** for each provider; a leak check.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents --filter=@opscrew/iac-templates --filter=opscrew && npx vitest run --root packages/agents src/shared src/provision src/retarget && npx vitest run --root packages/iac-templates src/infra && pnpm lint`
  - Effort: xhigh

## Phase 5: Every cost in the plan (US4, the founder's decision of 2026-11-20, in 0.2.11)

- [ ] T3108 [P] [US4] The cost schema and the providers' hourly prices
  - Owns: `packages/plan-schema/src/**` (and its generated JSON schemas),
    `packages/providers/*/src/**` (price data and catalogs), `packages/contracts/src/**` only for the
    catalog's price fields, colocated tests
  - Reads: spec US4, FR-3111; research R4; `plan-schema/src/design.ts` (`CostEstimateSchema`); each
    provider's catalog and static price list
  - Accept:
    - **The schema:** R4's fields, all optional. `ended` and `oneTime` currencies equal the
      monthly total's, and `breakdown` still sums to `monthly`. Old plans stay valid. Regenerate the
      JSON schemas.
    - **The providers' price data** gives each offer its hourly price:
      - Hetzner: the API's `price_hourly`, and a static list with hourly figures;
      - DigitalOcean: the API's `price_hourly`, and static hourly figures;
      - the IPv4 and backups items' hourly prices as each provider bills them;
      - snapshots per GB, hourly and monthly;
      - Contabo: `monthly` billing and its setup fee, already in its static list.
    - Tests.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/provider-hetzner --filter=@opscrew/provider-digitalocean --filter=@opscrew/provider-contabo --filter=@opscrew/contracts && pnpm lint`
  - Effort: high

- [ ] T3109 [US4] The phases write since, until, ended and oneTime
  - Owns: `packages/agents/src/**` (design's cost, provision, retarget's finish, destroy, the
    backups switch, snapshot deletion, the plan writer's pruning), colocated tests
  - Depends: T3108
  - Accept:
    - FR-3112.
    - **The pruning:** at every plan write, `ended` and `oneTime` older than the previous calendar
      month are pruned.
    - **A move:** the old side's items go to `ended` at `--finish`; the new side's start at their
      creation; a Contabo setup fee goes into `oneTime`.
    - **Tests** for each phase, with a fixed clock.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/design src/provision src/retarget src/destroy src/snapshot && pnpm lint`
  - Effort: high

- [ ] T3110 (lead) A real move's past items backfilled by hand into the live app's
  plan once T3109 is in, with the move's exact times

**Follow-up, after 0.2.11** (from a live provision of a second app):
- **The branch-rule refusal's text:** provision says "did not change anything" when the clone is on
  the wrong branch, after it has already set the GitHub environment's deployment-branch rule.
  Refuse before that step, or say what was set.
- **The PostgreSQL version:** design picks PostgreSQL 17 when the app's Compose file runs 18, and
  says only "The app uses PostgreSQL". It should say why (the version OpsCrew runs), as it does for
  Redis.

**Follow-up, after 0.2.11** (T3102's last review):
- **A window killed after the app started in place, before `migrated`:** `recoverInterruptedWindow`
  restarts the old app without holding the new one. Pass `!stepBefore(move.step, "deployed")` to
  `restartOldApp` at its call.
- **A run killed between the pre-copy's start of the app and its stop:** the new app keeps
  running until the next run. A `holdNewApp` at the start of a run at `deployed` without the
  pre-copy record closes it.
- **The one-off MySQL containers have no time limit.**
- [ ] T3104 (lead) The live runs (the founder's decision of 2026-11-20: three apps share one
  Contabo Cloud VPS 4, owned by the first of them):
  - **The first app** moves from its Hetzner CX23 to a new Contabo server of its own, run by the
    lead. This is 031's live run, and 0.2.11 waits for it. Its `--finish` deletes the Hetzner
    server.
  - **A second app** (a PHP app with MySQL and a kept folder) then moves onto that Contabo server:
    030's US6 between shared servers, at Contabo (030's T3020), recorded on the coverage page.
  - **A third app** joins it afterwards.
