# Quickstart: check the two PostgreSQL logins

## Offline (every change)

```bash
pnpm turbo run typecheck test --filter=@opscrew/plan-schema --filter=@opscrew/iac-templates \
  --filter=@opscrew/agents
pnpm lint
```

## Real PostgreSQL in Docker

```bash
OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp \
  pnpm --filter @opscrew/iac-templates exec vitest run src/catalog/postgres-logins.docker.test.ts
OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp \
  pnpm --filter @opscrew/agents exec vitest run src/retarget/postgres-logins.docker.test.ts
```

Each runs on PostgreSQL 16 and 17 and removes its containers and volumes.

## Live (once, before the release; the lead's, T4792)

On the localhost target with Docker Desktop: it costs nothing and changes no account. Use
`examples/laravel-app` (migrations in its release command; add a queue worker on the database
driver if it has none)
copied to a throwaway folder outside any Git checkout. In a second run, use one of the founder's
existing test servers only if the localhost target can't show a step, and say which step.

1. **A new database:** design and provision it.
   - The plan says `logins: separate` under `db`.
   - After the deploy, `docker compose exec db psql -U app -d app -c '\du'` lists `app_owner` and
     `app_runtime` with no superuser rights.
   - The app's container env names `app_runtime` and holds neither `POSTGRES_PASSWORD`'s value nor
     the owner's (compare each value's SHA-256, never print one).
2. **A migration later:** add a migration that creates a table with an `IDENTITY` id and one with a
   `serial` id, and deploy. A request that inserts into both works, as the runtime login.
3. **The runtime login's limits:** from the app's container, as its own `DATABASE_URL`, try
   `CREATE TABLE x (id int)`, `CREATE ROLE x` and `SELECT * FROM pg_authid`. Each is refused.
4. **An existing database:** deploy a second throwaway app with an OpsCrew 0.2.11 plan (no
   `logins`), add rows, then provision with this build.
   - Its generated files and the `db` container's ID are unchanged, and provision prints how to
     switch.
   - Add `logins: separate` and provision. The plan shows the snapshot, the restart, the logins and
     the new login. Approve it, then deploy.
   - The rows are all there, the app answers, and `app_owner` owns its tables.
5. **Rotation:** run `opscrew rotate db` for `runtime-password`, then for `owner-password`. The
   `db` container's ID and start time don't change. The app answers, and the next deploy's
   migration runs.
6. **Restore:** take a snapshot, delete a row, restore the snapshot. The row is back, `app_owner`
   owns the tables, and the app writes again.
7. **The drill:** run the restore drill once. It passes, and its copy's env holds placeholder
   passwords.
8. **Clean up:** destroy both apps. Where the target keeps deploy secrets in GitHub,
   `OPSCREW_RELEASE_DB_ENV` is gone with the others. No container, volume or image the pass made is left (list them).

The results go into `docs/e2e-coverage.md`.
