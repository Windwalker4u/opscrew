# Tasks: An app's PostgreSQL never runs as the superuser

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [quickstart.md](quickstart.md).

Three build waves, then the lead's. Inside a wave, no two tasks share an Owns path. Docker tests
use `OPSCREW_TEST_TMP=D:/opscrew-test-tmp` and remove every container and volume they start.
Secret-shaped values in tests come from `fakeSecret`.

## Wave 1

- [x] T4701 [US1] [US2] The setting `options.logins` (the lead approves: `plan-schema` is shared)
  - **Owns:** `packages/plan-schema/src/**`.
  - **Reads:** plan.md 1., data-model.md "The plan's field", `components.ts` (`KINDS_WITH_OPTIONS`,
    `ServiceEntrySchema`), `components.test.ts`.
  - **Depends:** none.
  - **Accept:**
    - **The field:** a `postgres` service's `options.logins` takes `"separate"` and is optional.
      Any other value, and any other key in its options, is refused, with `must be "separate"` for
      the value.
    - **The helper:** `postgresLogins(service)` is exported from the root. It is true only for a
      PostgreSQL with `logins: "separate"`.
    - **Unchanged:** a plan without the field parses to the same object as before (`options: {}`).
      The JSON schema and its snapshot follow, if `json-schema.ts` derives them.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/plan-schema && pnpm lint`
  - **Effort:** medium

- [x] T4702 [US1] [US2] [US3] The logins' SQL, proven on real PostgreSQL 16 and 17
  - **Owns:** `packages/iac-templates/src/catalog/postgres-logins.ts` (new),
    `postgres-logins.test.ts` (new), `postgres-logins.docker.test.ts` (new), and the export lines
    in `packages/iac-templates/src/catalog/index.ts` and `packages/iac-templates/src/index.ts`.
  - **Reads:**
    - ADR 0037, plan.md 2., data-model.md "The logins", "The setup step's grants", "Rotation", "The load of
      a dump", and research R1 and R3 to R8;
    - from the contribution's checkout `D:/opscrew-test-tmp/wt-review-69b2c105`:
      `iac-templates/src/catalog/postgres-access.ts` and `agents/src/rotate/scoped-postgres.ts`
      (the attributes, the check query, `\getenv`);
    - an existing `*.docker.test.ts` in `iac-templates`, for the gate and the cleanup.
  - **Depends:** none (pure texts; no plan input).
  - **Accept:**
    - **Unit tests first:** every script is `sh`. No password is in any argument: each is bound
      with `\getenv` or reaches psql through the environment, and `env -i … PGPASSWORD=` never
      appears. Identifiers are fixed constants. The setup is one transaction (`-1` or
      `BEGIN`/`COMMIT` with `ON_ERROR_STOP`).
    - **Docker tests,** gated by `OPSCREW_DOCKER_TESTS` and skipping with a clear message
      otherwise. Each case runs on `postgres:16-alpine` and the catalog's pinned 17 image, started
      with `POSTGRES_USER=app`, `POSTGRES_DB=app` and the two `OPSCREW_*_PASSWORD` values. Scripts
      run through `docker exec`, as the deploy's setup step does.
      - **A new database:** `loginsCheck` fails, `loginsSetup` passes, and `loginsCheck` then
        passes. Both roles have every attribute off and no memberships.
      - **Migrations as the owner, then the runtime login (the Laravel case):**
        - as `app_owner` over TCP, create `a (id bigint GENERATED ALWAYS AS IDENTITY, v text)`,
          `b (id serial, v text)` and `c (id bigint DEFAULT nextval('c_seq'), v text)` with its own
          sequence, after the setup ran;
        - as `app_runtime`, `INSERT` (with the id generated), `SELECT`, `UPDATE` and `DELETE`
          work on all three;
        - so do Laravel-shaped `cache`, `sessions`, `jobs` and `failed_jobs` tables created the
          same way.
      - **The runtime login's refusals:** `CREATE TABLE`, `ALTER TABLE a ADD COLUMN x int`,
        `DROP TABLE a`, `TRUNCATE a`, `CREATE ROLE x`, `CREATE SCHEMA x`, `CREATE TEMP TABLE t (i
        int)`, `SELECT rolpassword FROM pg_authid` and `ALTER ROLE app_runtime BYPASSRLS` are each
        refused.
      - **Row-level security:** with a policy on `a` that shows only `v = 'mine'` and `FORCE ROW
        LEVEL SECURITY`, `app_runtime` sees only those rows.
      - **The switch of a pre-047 database:**
        - as `app`, with no setup run, create two schemas, tables with both id kinds, a view, a
          materialized view, a function, an enum and a large object, plus 1,000 rows;
        - run the setup: every row stays, `app_owner` owns the database, the schemas and each of
          those objects, `pgcrypto` (created by `app`) is still the superuser's and works for
          `app_runtime`, and `app_runtime` reads and writes every table.
      - **A failed switch changes nothing:** before the setup, create a role `app_runtime` with
        `CREATEROLE`. The setup exits non-zero with data-model.md's message. Then `pg_roles`, every
        object's owner, every ACL and the default ACLs (`pg_default_acl`) are byte for byte as
        before, compared with snapshots of those catalog queries.
      - **Run again:** a second `loginsSetup` changes nothing (the same snapshots), and
        `loginsCheck` passes.
      - **Rotation without a restart:** `loginPassword("app_runtime")` and then
        `loginPassword("app_owner")` run, with `OPSCREW_NEW` passed by `docker exec -e
        OPSCREW_NEW` (name only). The container's ID and `State.StartedAt` don't change. The new
        password logs in over TCP, the old one doesn't, and a second run is skipped.
      - **The loads keep the logins:** a superuser `pg_dump -Fc` of the switched database is
        loaded with `loginsLoad`:
        - in place, with `setup: true`;
        - into a fresh container with other passwords (a drill), with `setup: true`;
        - into a fresh container whose setup already ran (a move), with `setup: false`.

        Each time, the owners, grants and default privileges are as in the source, `loginsCheck`
        passes, and a table `app_owner` creates afterwards works for `app_runtime`. A load into a
        container without the roles and `setup: false` refuses with a plain message and drops
        nothing.
  - **Verify:** `OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp pnpm --filter @opscrew/iac-templates exec vitest run src/catalog/postgres-logins && pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - **Effort:** xhigh

- [x] T4706 [US1] [US2] The guide
  - **Owns:** `docs/guide/databases.md`, `docs/guide/credential-rotation.md`.
  - **Reads:** plan.md 6., spec.md, data-model.md, research R5, R6 and R12, the rest of
    `databases.md`.
  - **Depends:** none in code. It is written from the spec and checked against T4703 and T4704 at
    review.
  - **Accept:**
    - **The tables:** "What your app receives" and "The split settings" show `app_runtime` for
      PostgreSQL. A note says that a database made before 0.2.12 shows `app` until it is switched.
    - **The section "Two logins"** says everything plan.md 6. lists, in plain English, each fact
      once. Its examples are the migration grant with the role guard, the pg-boss schema with
      `createSchema: false`, and `GRANT TEMPORARY ON DATABASE app TO app_runtime`. It says
      plainly that:
      - nothing at runtime may change the schema;
      - the switch takes a snapshot first and restarts the database once;
      - there is no going back.
    - **`credential-rotation.md`** lists `owner-password` and `runtime-password`, and says that
      neither restarts the database.
  - **Verify:** `pnpm lint`
  - **Effort:** medium

## Wave 2

- [x] T4703 [US1] [US2] [US3] The catalog, the release's env file, the workflow and snapshots
  - **Owns:**
    - `packages/iac-templates/src/catalog/entries.ts`, `catalog/index.ts` (not T4702's export
      lines), `catalog/*.test.ts` (not T4702's files) and `catalog/__fixtures__/**`;
    - `packages/iac-templates/src/runtime/**`, `portainer-target/**`, `drill/**`;
    - `packages/iac-templates/src/workflow/**`;
    - `packages/iac-templates/src/**/__snapshots__/**` (only if a snapshot of a plan with `logins`
      is added).
  - **Reads:** plan.md 3., data-model.md "The secrets and env" and "Rotation", research R3, R7, R9
    and R10, `switch.ts` (`serviceInit`), `rotate.ts` (`rotateEnvFiles`), `snapshots.ts`
    (`DATABASES`), `portainer-target/stack.ts` (`stackSetup`, `release`), the contribution's
    `catalog/sql-access.ts` and `runtime/index.ts` (`release.db.env`).
  - **Depends:** T4701, T4702.
  - **Accept:**
    - **Tests first.**
    - **No change without `logins`:** every golden and snapshot test of a plan without `logins`
      passes unedited: Compose, the Portainer stack, the workflow, rotation, the drill and the
      snapshots. No existing golden may be updated in this task.
    - **The entry:** with `logins`, it has data-model.md's secrets, env, address, split settings,
      `init` step (check `loginsCheck`, run `loginsSetup`) and rotation rows. Each rotation is
      `swap`, `recreate: false`, `seconds: 1`.
    - **The release:** `releaseVariables(plan)` gives the app's database variable names with
      `app_owner`. The cases with the app's own variable and with the split names both have tests.
      - **On a server and localhost,** Compose's `release` reads `env_file: [app.env,
        release.db.env]`, and no other service reads `release.db.env`.
      - **On Portainer,** the stack's `release` environment has the owner's values, and the app,
        workers, cron and seed have the runtime's. The setup runs in `<service>-init`, which the
        release waits for.
    - **No superuser in an app container:** for a plan with `logins`, the rendered `app.env`
      names hold no reference to the secret `password`, and only the release's env references
      `owner-password`. A test walks every service of the rendered Compose and Portainer stack.
    - **The deploy secret:** `OPSCREW_RELEASE_DB_ENV` is in `deploySecretNamesFor` for a plan with
      `logins` only. The workflow writes `release.db.env` owner-only, as it writes `app.env`, and
      the localhost deploy too.
    - **Rotation's files:** rotating `owner-password` rewrites `db.env` and `release.db.env`;
      rotating `runtime-password` rewrites `db.env` and `app.env`. No step recreates `db`.
    - **Snapshots:** with `logins`, the restore uses `loginsLoad` with `setup: true`, and the
      drill's count also requires `loginsCheck`. Without it, the commands are as today.
    - **The drill:** its copy's env holds placeholders for the two new secrets, never values from
      the app's env.
    - **The extra server:** a database on an extra server (ADR 0022) gets its setup step there
      (`initStepsFor`), and the release's URL names its private address.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - **Effort:** xhigh

## Wave 3

- [x] T4704 [US1] [US2] Design, provision's switch, destroy and rotate
  - **Owns:** `packages/agents/src/design/**`, `packages/agents/src/provision/**`,
    `packages/agents/src/destroy/**`, `packages/agents/src/rotate/**`,
    `packages/agents/src/shared/app-secrets.ts` and its test.
  - **Reads:** plan.md 4., data-model.md "The plan's field" and "Provision's texts", research R2,
    R9 and R11, `shared/app-secrets.ts` (the generated values), ADR 0037, `provision/secrets.ts`
    (`deploySecretNames`), `destroy/common.ts` (the by-hand list), the on-demand snapshot in
    `agents/src/snapshot`, and the review's findings 6 and 7.
  - **Depends:** T4701, T4703.
  - **Accept:**
    - **Tests first, with fakes.**
    - **Design:** every plan it writes with PostgreSQL 15 or later has `logins: separate`. On 14
      it has none, and design's summary gives data-model.md's notice below 15.
    - **The notice:** provision prints data-model.md's notice for a deployed environment whose
      PostgreSQL lacks `logins` (the one below 15 on an older version), and changes nothing
      because of it. A pinned older version is never refused.
    - **The switch:**
      - with `logins` new on a deployed environment whose generated values keep the superuser's
        password but no `owner-password`, the plan shown holds data-model.md's switch lines, and
        its hash covers them;
      - after approval, the snapshot is taken before any secret or file is written;
      - a failed snapshot stops provision with nothing written, saying what to do next;
      - `--approve <wrong hash>` changes nothing.
    - **The refusals:** the removal, and a hand-written `logins: separate` below 15, are refused
      before any change, with data-model.md's messages.
    - **Secrets:** the two new secrets are generated once and kept like `password`.
      `OPSCREW_RELEASE_DB_ENV` is written to GitHub. The values are registered with the redactor,
      and no test output, audit entry or plan text holds one.
    - **Destroy:** the server branch of `deploySecretNames` and the by-hand list include
      `OPSCREW_RELEASE_DB_ENV`, with a destroy test.
    - **Rotate:** `opscrew rotate db` offers `owner-password` and `runtime-password`. Its plan
      shows no restart for them.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - **Effort:** high

- [x] T4705 [US3] Moves, restores and the drill keep the two logins
  - **Owns:** `packages/agents/src/retarget/**`, `packages/agents/src/move/**`,
    `packages/agents/src/snapshot/**`, `packages/agents/src/testing/move.ts`.
  - **Reads:** plan.md 5., data-model.md "The load of a dump", research R10, `retarget/server-ops.ts`,
    `retarget/sides/postgres.ts`, `move/window.ts`, `retarget/catalog-copy.docker.test.ts`.
  - **Depends:** T4701, T4702, T4703.
  - **Accept:**
    - **Tests first.**
    - **The commands:** with `logins`, each of the three move paths creates `app` with `OWNER
      app_owner`, restores without `--no-owner` and runs the grants part after. The one-off
      containers check the roles first and refuse with a plain message. The moves no longer
      refuse an app with two logins. Without `logins`, every command and text is as today, and
      the existing tests pass unedited.
    - **The texts:** the window's plan lines (`move/window.ts`, `retarget/window.ts`) say the owner
      and the grants are kept.
    - **The fakes** accept the new commands.
    - **Docker:** `retarget/postgres-logins.docker.test.ts` (new, gated) moves a switched database
      through `sides/postgres.ts` between two PostgreSQL 17 containers. On the new side the owners
      and grants hold, and `app_runtime` writes.
    - **Snapshot runners:** where `agents/src/snapshot` spells out PostgreSQL commands itself
      (`restore-checks.ts`, `drill-core.ts`), they follow the catalog's load. Otherwise nothing
      changes there.
  - **Verify:** `OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp pnpm --filter @opscrew/agents exec vitest run src/retarget/postgres-logins && pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - **Effort:** high

## The lead's wave

- [x] T4790 (lead) A fresh review of the merged waves, by a reviewer that didn't build them:
  - the approval of the switch and what its hash covers;
  - that no app container gets the superuser's password, and only the release the owner's;
  - no password in an argument or a log;
  - unchanged files for plans without `logins`;
  - the guide against the code.
- [ ] T4791 (lead) `/simplify` over the feature's diff.
- [ ] T4792 (lead) The live pass of [quickstart.md](quickstart.md).
  - **Where:** the localhost target, or one of the founder's existing test servers. Nothing is
    bought.
  - **Nothing left behind:** proven by listing the containers, volumes, images and deploy secrets
    afterwards.
  - **The results** go into `docs/e2e-coverage.md`.
- [ ] T4793 (lead) The changelog line for 0.2.12: "An app's PostgreSQL has two logins: the release
  command migrates as the schema's owner, and the app, workers and cron run as a login that can
  only read and write data. New databases get them by default; an existing one switches with
  `logins: separate` and `opscrew provision`."
