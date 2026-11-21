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

- [x] T3102 [P] [US1] [US2] The pre-copy, the app checked before the window, and the window's
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

- [x] T3103 [US1] [US2] The guide
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

- [x] T3106 [P] [US3] The connectors' restart and reinstall
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

- [x] T3107 [P] [US3] The wait's diagnosis and its repair
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

- [x] T3108 [P] [US4] The cost schema and the providers' hourly prices
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

- [x] T3109 [US4] The phases write since, until, ended and oneTime
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

- [x] T3110 (lead) A real move's past items backfilled by hand into the live app's
  plan once T3109 is in, with the move's exact times

- [x] T3111 [US4] A bought domain's purchase and renewals in the cost
  - Owns: `packages/plan-schema/src/plan.ts` and `schemas/plan.schema.json` (`cost.renewals`
    only), `packages/agents/src/domain/**`, `packages/agents/src/status/**`, colocated tests
  - Reads: research.md R4 (a domain OpsCrew bought), `packages/agents/src/shared/cost-times.ts`
  - Depends: T3109
  - Accept:
    - FR-3113.
    - **The purchase:** `opscrew domain buy` adds `{item: "<domain>, <n> year(s)", provider:
      <registrar>, price: <the charge>, at}` to `cost.oneTime`, and `{item: <domain>, provider,
      price: <renewal per year>, next: <expiry>, autoRenew}` to `cost.renewals`. A rerun that
      finishes a recorded purchase adds neither twice.
    - **A renewal seen later:** `opscrew status` and `opscrew domain status` read the registrar
      only once `next` is within 30 days or past. An expiry that moved on adds the renewal to
      `oneTime` (with `price`, at the earlier of the old `next` and the read's time: no
      registrar's API gives the day it charged) and moves `next` and the plan's
      `domain.registration.expiresAt`. `opscrew status` calls it (`packages/cli/src/commands/status.ts`),
      and a redesign keeps `renewals` (`carryRecords`).
      `provider` is always the registrar's id from `RegistrarSchema`; a new registrar is announced
      to the portal's lead. Auto-renew off with `next` within 30 days: a warning that
      names the date and how to turn it on (`opscrew domain auto-renew on` at Cloudflare and
      Porkbun, the registrar's dashboard at Namecheap and GoDaddy).
    - **No entry** for a domain bought elsewhere; old plans without `renewals` stay valid; the
      plan's pruning keeps `renewals` whole.
    - **Tests** with a fixed clock and fake registrars: each registrar, a renewal seen, auto-renew
      off, no registrar call before the 30 days.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/plan-schema --filter=@opscrew/agents && npx vitest run --root packages/agents src/domain src/status && npx vitest run --root packages/plan-schema && pnpm lint`
  - Effort: high

- [x] T3113 [US4] A cost item's name stays the same while it bills
  - Why: the IPv4 and backups items carry where their price came from (`(Hetzner's published rate
    as of <date>)`, `OpsCrew's default rate…`), and an extra server's item its currency conversion,
    so a new price list renames a running item and the portal, which keeps a monthly record by
    name, counts it twice.
  - Owns: `packages/plan-schema/src/plan.ts` and `schemas/plan.schema.json` (`priceSource` on the
    cost item only), `packages/agents/src/design/cost.ts`, `design/servers.ts`,
    `shared/cost-times.ts`, the places that print a cost line (not `src/status/**` or
    `src/domain/**`, which T3111 owns: report it if they need a change), colocated tests and
    snapshots
  - Depends: T3109
  - Accept:
    - **The name:** `item` holds only what is billed ("Primary IPv4 address", "Automated backups
      (20% of the server price)", "Server worker (cx23 in nbg1), with its IPv4 address"). Where
      its price came from, and a conversion from another currency, go in a new optional
      `priceSource` string.
    - **Shown as before:** every place that prints a cost line adds `priceSource` after it, in the
      same words, so the user sees no change.
    - **The identity:** `keepCostTimes` matches items by `provider` and `item` alone; the wording
      constants and the note's regex from T3109's re-review go.
    - **Tests:** a price list's new date keeps the name and `since`; the printed lines are
      unchanged.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/plan-schema --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/plan-schema && npx vitest run --root packages/agents src/design src/shared src/monitoring src/retarget/start && pnpm lint`
  - Effort: medium

**Also in 0.2.11** (a bug found in a live provision of a second app, 2026-11-20):

- [x] T3114 A redesign keeps the variables the user added to `app.env` by hand
  - Why: design rebuilds `app.env` from detection and keeps only the settings of the variables
    detection still finds (`keepPlanSettings` in `packages/agents/src/design/run.ts`), so a
    variable the user added because detection misses it (a switch the code reads with a default,
    mentioned only in a comment of `.env.example`) disappears without a word, and the next deploy
    never passes its value.
  - Owns: `packages/agents/src/design/run.ts`, `packages/agents/src/design/**` tests,
    `docs/guide/` (the page that describes `app.env`)
  - Accept:
    - **Kept:** a previous `source: user` variable that the fresh design doesn't have, and no
      service fills now, stays in `app.env` as it was. A `generated` or `derived` one goes, as
      today.
    - **Said:** design's "Kept your changes in opscrew/plan.yaml" line names each such variable,
      with a short note to remove it from `app.env` when the app no longer reads it.
    - **The guide** says how to add a variable detection misses: add it to `app.env` in
      `opscrew/plan.yaml` with `source: user`, and design keeps it.
    - **Tests:** a hand-added variable survives a redesign and is named; a derived one that no
      service fills is dropped; a detected variable keeps today's handling.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/agents && npx vitest run --root packages/agents src/design && pnpm lint`
  - Effort: medium

- [x] T3115 A Laravel image built by Railpack reads the deployment's settings, not the build's
  - Why: Railpack's Laravel build runs `php artisan optimize` without the app's settings, so the
    image carries `bootstrap/cache/config.php` (and the routes and events caches) with the
    defaults: SQLite, `APP_ENV=production`. Only a container started by the image's start script
    clears it, so the release step migrated SQLite instead of the app's Postgres, and the workers
    and the scheduler would run with every setting at its default. The web's start script also
    migrates on each start, beside OpsCrew's release step.
  - Owns: `packages/iac-templates/src/workflow/build.ts` (the seal), the compose rendering of the
    processes' environment, `packages/cli/test/e2e/**` (the Docker pass), colocated tests
  - Accept:
    - **The seal:** for a Laravel app Railpack builds, the image keeps no `config.php`,
      `routes-*.php` or `events.php` in `bootstrap/cache` (`packages.php` and `services.php`
      stay), and the web still starts.
    - **One migration:** with `app.releaseCommand`, every process of that image gets
      `RAILPACK_SKIP_MIGRATIONS=true`.
    - **Tests:** the seal's lines and the processes' environment offline; the Docker pass's
      Laravel app on Postgres migrates Postgres in the release, and a worker reads `pgsql`.
  - Effort: high

- [ ] T3119 A Laravel Horizon worker gets the memory it needs
  - Why: design sizes every worker at 256 MB (`design/components.ts`). Horizon is a process
    manager: a master, a supervisor per `config/horizon.php` entry and their workers, each a full
    PHP process. It measured 594 MB at rest on a live deploy, so the deploy's worker check fails at
    every deploy.
  - Owns: `packages/agents/src/design/components.ts` (a worker's default memory), detect's worker
    detection if it must say which worker is Horizon, colocated tests
  - Accept:
    - **The default:** a worker that runs `php artisan horizon` gets 768 MB by default, and
      design's line says why (Horizon runs several PHP processes). A plan's own `memoryMb` stays.
    - **The fit:** design's memory checks (the server's size, another app's server) count it.
    - **Tests:** a Horizon worker's default and its line; another worker keeps 256 MB.
  - Effort: medium

- [ ] T3120 Migration status and down migrations run in Railpack and Buildpacks images
  - Why: `app.migrations`' status (`packages/iac-templates/src/workflow/migrations.ts`, around
    line 119) and its down migrations (around 305) run `docker compose run … release sh -c
    "<script>"`. Under Railpack's and Buildpacks' entrypoint, which wraps the command in its own
    shell, that becomes `bash -c sh -c '…'`: a bare `sh` that reads an empty stdin and exits 0. So
    no migration record is ever written, every deploy warns that it couldn't record them, and a
    rollback's down migrations would say they ran without running anything.
  - Owns: `packages/iac-templates/src/workflow/migrations.ts`, the one-off start helper it should
    use (`oneOffStart`), `packages/cli/test/e2e/**` (the Docker pass), colocated tests
  - Accept:
    - **The command:** the status and the down migrations go through `oneOffStart`'s per-builder
      form: one string for Railpack and Buildpacks, `sh -c` otherwise, as the workers and cron
      already do.
    - **A down migration that did nothing is never reported as run:** the script checks its own
      result.
    - **Tests:** the rendered commands per builder offline, and the Docker pass's Railpack Laravel
      app records its migration count after a deploy.
  - Effort: high

**Also in 0.2.11** (the hosted portal's ask, the founder's yes of 2026-11-20; not part of the move):

- [x] T3116 `opscrew providers --json`: the providers' facts as a machine-readable catalogue
  - Why: a guided start for new users suggests a provider and a size with an approximate price,
    and walks the user through creating each token. Every fact must come from the core: a
    provider added to the core then appears there with no code of its own.
  - Owns:
    - `packages/plan-schema/src/catalogue.ts`, its export, and a generated
      `schemas/provider-catalogue.schema.json`;
    - `packages/agents/src/providers/catalogue.ts`, which assembles the catalogue from the
      definitions;
    - `packages/cli/src/commands/providers.ts`, and its registration;
    - the provider contract's new optional `signupUrl` only: `packages/contracts/src/provider.ts`,
      each `packages/providers/*/src/definition.ts`, and the registry's check of it;
    - `docs/guide/` (a short reference section);
    - colocated tests.
  - Accept:
    - **The command:** `npx opscrew providers --json` prints the catalogue. Without `--json` it
      prints one line per provider. It reads no network, no credential and no project, and the
      same version always prints the same catalogue.
    - **The shape** (`ProviderCatalogueSchema`, `catalogueVersion: 1`):
      - `{catalogueVersion, opscrewVersion, providers[], suggestions}`.
      - Each provider has `{id, name, kind: "cloud-server" | "cloudflare" | "registrar",
        consoleUrl, signupUrl, pricingUrl?, currency?, credentials, guideUrl}`. `signupUrl` is
        the provider's plain sign-up page, never with a referral or affiliate ID. The CLI prints
        no sign-up links.
      - `credentials` is `{mode: "any" | "all", variables[], createUrl, steps[]}`. Each variable
        is `{name, label, secret, pattern?}`, with `pattern` the core's scan pattern as a regex
        string.
      - A cloud server provider also has `billing` and `locations[]` (`{id, name, region}`), and
        `sizes[]` (`{id, vcpu, memoryMb, diskGb, monthly, hourly?, locations[]}`).
      - The prices carry a `priceSource` `{kind: "static", asOf}`: the built-in price list, never
        read live.
    - **The sources:**
      - The cloud server providers come from their definitions (ADR 0029) and built-in price
        lists.
      - Cloudflare's token (DNS, the HTTPS rules, Workers for static sites) comes from the
        connector's and init's texts. The registrars come from the domain connectors.
      - `steps` are the same words `opscrew init` and the guide give for creating each token.
      - A fact the core doesn't hold is left out and reported, never invented.
    - **`suggestions`:** what design would pick for a small app:
      - `serverWithDatabase`: per cloud server provider, the default size for a web app with
        PostgreSQL, from design's own choice;
      - `staticSite`: where design sends a static site.
    - **Tests:** the catalogue parses with its schema; each provider of `CLOUD_PROVIDERS` is in
      it; the output holds no secret; a provider added to the registry appears without other
      code.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/plan-schema --filter=@opscrew/agents --filter=opscrew && npx vitest run --root packages/plan-schema && npx vitest run --root packages/agents src/providers && npx vitest run --root packages/cli src/commands/providers && pnpm lint`
  - Effort: high

- [x] T3118 The catalogue's pricing pages and Cloudflare hosting's tokens
  - Why: the portal links each approximate price to the provider's own pricing page, and its
    static-site path to Cloudflare needs the second token Cloudflare hosting uses.
  - Owns:
    - the provider contract's new optional `pricingUrl` only: `packages/contracts/src/provider.ts`,
      each `packages/providers/*/src/definition.ts`, and the registry's check;
    - `packages/plan-schema/src/catalogue.ts` and its generated schema;
    - `packages/agents/src/providers/catalogue.ts`;
    - colocated tests.
  - Accept:
    - **`pricingUrl`** on every catalogue entry: the provider's plain public pricing page, from
      its definition (cloud server providers) or the catalogue's constants (Cloudflare, Workers,
      the registrars). It is checked the way `signupUrl` is: https, no query string.
    - **Cloudflare hosting:** an entry `{kind: "cloudflare", id: "cloudflare-workers"}`, the id
      that `suggestions.staticSite.target` names. Its credentials list the tokens that hosting
      needs (`CLOUDFLARE_API_TOKEN` and `OPSCREW_CLOUDFLARE_DEPLOY_TOKEN`, `mode: "all"`), with
      `opscrew init`'s own steps and permissions for them.
    - **Tests:** every entry has a `pricingUrl`; the hosting entry lists both tokens; the schema
      file is up to date.
  - Verify: `pnpm turbo run typecheck test --filter=@opscrew/contracts --filter=@opscrew/providers --filter=@opscrew/provider-hetzner --filter=@opscrew/provider-digitalocean --filter=@opscrew/provider-contabo && npx vitest run --root packages/plan-schema && npx vitest run --root packages/agents src/providers && pnpm lint`
  - Effort: medium

- [x] T3121 (lead) The catalogue's credential labels in words a person reads ("Contabo API
  password", not "Contabo oauth2 pass"): each provider's definition carries `credentials.labels`, the
  registry refuses one without a label, and Cloudflare's and the registrars' are in the catalogue

- [x] T3117 The secrets recovery copy's recipient in a script: `--recipient <age public key>`
  - Why: in a script, provision makes the encrypted recovery copy of the app's secrets only with
    `--key-out`, which writes a new age key where the script runs (a CI runner keeps nothing). A
    first setup applied from GitHub Actions then has no copy anyone can open. The agents already
    take a recipient (`RefreshRecoveryOptions.recipient`); only the CLI lacks the flag.
  - Owns: `packages/cli/src/commands/provision.ts`, the CLI command that refreshes the copy
    (`secrets`, if it exists), `docs/guide/` (where the recovery copy and `--key-out` are
    described), colocated tests
  - Accept:
    - **The flag:** `--recipient <age1…>`, repeatable, on `opscrew provision` and on the command
      that refreshes the copy. The copy is encrypted to each recipient, no key is written anywhere,
      and `opscrew/secrets.sops.json` goes into the deploy-setup pull request exactly as it does
      from a terminal (a public repository included or left out the same way).
    - **Checked:** a value that isn't an age public key (`age1` and its Bech32 form, as the core
      already parses it) is refused with a plain message, before anything changes. With both
      `--recipient` and `--key-out`, the copy is encrypted to all of them.
    - **No secret:** the recipients are public keys; no private key or secret is printed, logged
      or written.
    - **Tests:** a script run with `--recipient` makes the copy for that key and writes no key
      file; two recipients; a bad value refused; the terminal's behaviour unchanged.
  - Verify: `pnpm turbo run typecheck --filter=opscrew --filter=@opscrew/agents && npx vitest run --root packages/cli src/commands/provision src/commands/secrets && pnpm lint`
  - Effort: medium

**Also in 0.2.11** (a user's ask, the founder's yes of 2026-11-20; not part of the move):

- [x] T3112 The workflow's GitHub token for an own Dockerfile's build, as a secret mount
  - Why: a Dockerfile that checks a pinned module's commit through GitHub's API calls it anonymously
    from the build, 60 calls an hour per address shared by every job on GitHub's runners, and the
    build fails on the limit.
  - Owns: `packages/plan-schema/src/plan.ts` and `schemas/plan.schema.json` (`app.build.githubToken`
    only), `packages/iac-templates/src/workflow/build.ts`, `packages/agents/src/design/builder.ts`
    (a redesign keeps the field), `docs/guide/builders.md`, colocated tests and snapshots
  - Accept:
    - **The opt-in:** `app.build.githubToken: true` (optional; only with `builder: own-dockerfile`,
      refused with any other builder as `webRoot` is). Set by hand in `opscrew/plan.yaml`; a later
      design keeps it.
    - **The workflow:** with it, the build step that runs the user's Dockerfile adds
      `GITHUB_TOKEN=${{ github.token }}` to its `secrets:` (id `GITHUB_TOKEN`), never to
      `build-args`. The seal build doesn't get it. Without it the workflow is unchanged, byte for
      byte. The job's permissions don't change.
    - **The guide** (builders.md, the own Dockerfile's secrets): how to read it,
      `RUN --mount=type=secret,id=GITHUB_TOKEN,env=GITHUB_TOKEN …`. It never reaches the image, its
      layers or the provenance, and GitHub revokes it when the job ends. The build job has
      `packages: write`, so the token can also push to the repository's packages until then:
      mount it only in the `RUN` that needs it, never in one that installs dependencies.
    - **Tests:** the secret line present only with the opt-in and only on the Dockerfile's build
      step; the schema's refusal with another builder; a redesign keeps it.
  - Verify: `pnpm turbo run typecheck --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates --filter=@opscrew/agents && npx vitest run --root packages/plan-schema && npx vitest run --root packages/iac-templates src/workflow && npx vitest run --root packages/agents src/design && pnpm lint`
  - Effort: medium

**Follow-up, after 0.2.11** (from the live moves):
- **A slow DNS switch apply:** the switch's apply of two in-place record updates took 5 m 26 s once
  (about 30 s in another move), inside the downtime. Capture OpenTofu's log next time. Consider
  switching the records through Cloudflare's API directly, with the plan still approved by its
  hash.

- **The move's host-apply approvals:** a move records its iac-apply approvals in plan.yaml's
  `approvals`, but not its host-apply ones (the new side's host plan, the finish's removal), which
  a plain provision records.

**Follow-up, after 0.2.11** (from a live provision of a second app):
- **The branch-rule refusal's text:** provision says "did not change anything" when the clone is on
  the wrong branch, after it has already set the GitHub environment's deployment-branch rule.
  Refuse before that step, or say what was set.
- **The PostgreSQL version:** design picks PostgreSQL 17 when the app's Compose file runs 18, and
  says only "The app uses PostgreSQL". It should say why (the version OpsCrew runs), as it does for
  Redis.
- **Dependabot's file:** there is no plan setting to leave out `.github/dependabot.yml`, which
  provision writes on every run. A repository that allows Actions only for the deploy removes it
  by hand from each pull request.
- **The `.terraform/` folder:** `opscrew/infra/<env>/.terraform/` shows up untracked after
  provision. The generated `.gitignore` should cover it.
- **A PECL outage fails a Railpack PHP build:** `install-php-extensions` fetches PECL extensions
  (redis and the like) from pecl.php.net during the build. Retry the build step once, or name PECL
  in the failure.
- **Development packages in a Railpack PHP image:** Railpack's `composer install` keeps
  `require-dev`, so the image ships the development packages and, since the extensions fix, their
  extensions (xdebug, if a development package asks for it). Spike `COMPOSER_NO_DEV=1` through
  Railpack's `--env`.
- **The drill tests' fakes take 45 s on Windows:** make the fake `sleep` and time limit instant.
- **An extension another locked package provides:** a polyfill's `provide` of an `ext-*` still puts
  it on the list, and `install-php-extensions` may not be able to install it. Skip any `ext-*` a
  locked package lists in `provide`, in detect and in the workflow's script.
- **A Laravel image of the user's own Dockerfile can bake the same caches:** a `RUN php artisan
  config:cache` or `optimize` line saves the build's settings into the image. `opscrew adapt`'s
  Dockerfile findings could flag it.

**Follow-up, after 0.2.11** (T3102's last review):
- **A window killed after the app started in place, before `migrated`:** `recoverInterruptedWindow`
  restarts the old app without holding the new one. Pass `!stepBefore(move.step, "deployed")` to
  `restartOldApp` at its call.
- **A run killed between the pre-copy's start of the app and its stop:** the new app keeps
  running until the next run. A `holdNewApp` at the start of a run at `deployed` without the
  pre-copy record closes it.
- **The one-off MySQL containers have no time limit.**

**Follow-up, after 0.2.11** (T3109's reviews):
- **An item design drops ends at design time,** not at the apply that removes it (backups off,
  another server type): `until` is early by the time between design and provision.
- **After a failed first create**, a rerun records the server's `since` and a setup fee's `at` at
  the rerun's time, not the creation's.
- **An abort whose old server type is no longer listed** keeps no `since` for the old side until
  the next design.
- **Not timed yet:** the snapshot a move's `--finish` keeps, an extra server's line during a move,
  site moves, serverless provision, and the backups `opscrew advise --apply` turns on.
- [x] T3104 (lead) The live runs (the founder's decision of 2026-11-20: three apps share one
  Contabo Cloud VPS 4, owned by the first of them):
  - **The first app** moves from its Hetzner CX23 to a new Contabo server of its own, run by the
    lead. This is 031's live run, and 0.2.11 waits for it. Its `--finish` deletes the Hetzner
    server.
  - **A second app** (a PHP app with MySQL and a kept folder) then moves onto that Contabo server:
    030's US6 between shared servers, at Contabo (030's T3020), recorded on the coverage page.
  - **A third app** joins it afterwards.
