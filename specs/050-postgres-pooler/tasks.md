# Tasks: A connection pooler for an app's PostgreSQL

**Input**: [spec.md](spec.md), [plan.md](plan.md) (sections written "plan N."), [research.md](research.md).

**Numbering**: T5001–T5099. Ships in 0.2.12.

**Rules for every task:**
- **Test first.** Secret-shaped values in tests come from `fakeSecret`.
- **Unchanged without `pooler`:** every existing snapshot stays byte for byte. A task that changes
  one has a bug.
- **Scope:** build only what Accept asks; report anything else as a finding.
- **Temp files:** `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.
- **Worktrees:** each task in its own worktree from `050-postgres-pooler`; commit there with the
  Co-Authored-By trailer.

## Wave 1

- [x] T5001 [US1] The field and the pooler's service
  - **Owns:** `packages/plan-schema/src/components.ts` and its tests (the lead approves: shared);
    `packages/iac-templates/src/pins.ts` (`IMAGES.pgbouncer`); the catalog
    (`packages/iac-templates/src/catalog/**`) and the runtime's service rendering
    (`packages/iac-templates/src/runtime/**`) for the pooler, and their tests.
  - **Reads:** plan 1. and 2., research 1–3 and 6; 047's catalog code (`postgres-logins.ts`,
    `releaseVariables`, the alias rule in `catalog/index.ts`).
  - **Accept:**
    - `pooler: pgbouncer` parses on a PostgreSQL with `logins: separate`, and is refused without
      it with plan 1.'s message; `postgresPooler(service)` is exported.
    - The rendered Compose has `<db>-pooler` as plan 2. says, and the pooler's env file holds the
      runtime login's name and password; a leak check shows the password in no other rendered file.
    - The app's database variables name `<db>-pooler:6432` for web, workers and cron;
      `release.db.env` keeps `<db>:5432` with the owner's login. A split plan puts the pooler on
      the database's server.
    - A Portainer stack renders the same service.
    - Without `pooler`, every snapshot is unchanged.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates && pnpm lint`
  - **Effort:** high

## Wave 2 (after T5001, in parallel)

- [x] T5002 [US2] Rotation recreates the pooler
  - **Owns:** the catalog's rotation for PostgreSQL's `runtime-password`, and
    `packages/iac-templates/src/workflow/rotate.ts`, and their tests.
  - **Reads:** plan 3.; 047's rotation (`POSTGRES_LOGINS.rotation`, `swap`).
  - **Accept:** with the pooler, rotating `runtime-password` recreates `<db>-pooler` after the new
    password is in PostgreSQL and the env files, before the app restarts; the undo does the same
    with the old one. Other rotations don't touch it. Without the pooler, the rotation script is
    unchanged.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/catalog src/workflow && pnpm lint`
  - **Effort:** high

- [x] T5003 [US3] Design, provision's line, server-fit and status
  - **Owns:** `packages/agents/src/design/**`, provision's notice (beside 047's in
    `packages/agents/src/provision/postgres-logins.ts`), `packages/agents/src/provision/server-fit.ts`,
    and their tests.
  - **Reads:** plan 4.; how design writes `logins: separate`.
  - **Accept:** design writes `pooler: pgbouncer` for a new PHP app with PostgreSQL 15 or later and
    not for other languages; provision prints plan 4.'s line for a PHP plan without it; server-fit
    counts 32 MB. Plans of other languages are unchanged.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - **Effort:** medium

- [ ] T5004 [US1] [US2] The Docker test
  - **Owns:** `packages/iac-templates/src/catalog/pooler.docker.test.ts` (new).
  - **Reads:** plan 2.; 047's `postgres-logins.docker.test.ts` as the pattern.
  - **Accept:** gated by `OPSCREW_DOCKER_TESTS=1`. From the rendered files:
    - PostgreSQL 17 with separate logins, the pooler, and a PHP CLI container with `pdo_pgsql`
      (the official `php` image; install the extension in the test only if the image lacks it);
    - PDO with native prepared statements (no emulation) runs a few thousand queries through
      `<db>-pooler:6432`, all succeed, and `pg_stat_activity` shows at most `default_pool_size`
      backends for `app_runtime`;
    - the release's direct address migrates as `app_owner`;
    - a runtime-password rotation through the rendered steps, then queries again succeed;
    - the pooler's memory is measured and stays under its limit;
    - nothing is left behind (listed).
  - **Verify:** `OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp npx vitest run --root packages/iac-templates src/catalog/pooler.docker.test.ts && pnpm lint`
  - **Effort:** high

- [x] T5005 [US1] The guide
  - **Owns:** `docs/guide/databases.md` (a section).
  - **Accept:** what it does and why, how to turn it on, that migrations bypass it, the session
    features that break in transaction mode (research 4), its memory, and that it needs separate
    logins. Names match the code.
  - **Verify:** `pnpm lint`
  - **Effort:** medium

## The lead's wave

- [ ] T5090 (lead) A fresh review of the merged waves.
- [ ] T5091 (lead) `/simplify` over the feature's diff.
- [ ] T5092 (lead) The live pass on the localhost target with `examples/laravel-app`: SC-5001's flat
  backend count over 100 signed-in requests, and nothing left behind. The results go into
  `docs/e2e-coverage.md`.
- [ ] T5093 (lead) The changelog line for 0.2.12: "An optional PgBouncer in front of an app's
  PostgreSQL (`pooler: pgbouncer`), which design turns on for PHP apps."
