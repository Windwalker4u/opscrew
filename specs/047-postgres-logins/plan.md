# Implementation Plan: An app's PostgreSQL never runs as the superuser

**Branch**: `047-postgres-logins` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md), [research.md](research.md), [data-model.md](data-model.md).

## Summary

Every new PostgreSQL gets two logins: `app_owner` for the release command, which owns the
schema, and `app_runtime` for the web, the workers and cron, with data rights only. Default
privileges make whatever the owner creates usable by the runtime login. The superuser `app` stays
with OpsCrew's administration.

- **How the plan says it:** `options.logins: separate`, which design writes. An existing database
  switches in place when the user adds it, through provision's plan approved by its hash, with a
  snapshot first.
- **Where the logins are made:** the catalog's one-time setup step, in one transaction.
- **What follows:** the release gets its own env file, rotation runs over the container's socket
  without a restart, and every load of a dump keeps the owners and grants.

The design reuses the reviewed parts of the contribution at `69b2c105` and drops the rest
(research R13).

## Technical Context

- **Language:** TypeScript strict ESM (existing packages). **New dependencies:** none.
- **Packages touched:** `plan-schema`, `iac-templates` (catalog, runtime, workflow, Portainer
  stack, snapshots), `agents` (design, provision, destroy, snapshot, retarget, move).
- **Testing:** Vitest with fakes. Real PostgreSQL 16 and 17 in Docker only with
  `OPSCREW_DOCKER_TESTS=1`, in `*.docker.test.ts` files, which skip with a clear message without
  Docker.
- **Targets:** servers OpsCrew creates, the user's own server, Portainer, and the localhost target.
  Hosting accounts don't run OpsCrew's PostgreSQL.

## Constitution Check

- **I. Safety gate:**
  - the switch of an existing database is shown in provision's plan and approved by its hash
    before the snapshot or any write;
  - the setup step runs inside the deploy the user approved, as the catalog's MongoDB step does;
  - no destroy is added.
- **The ADR:** [ADR 0037](../../docs/adr/0037-postgres-logins.md) records the credential
  boundary.
- **IV. Secrets:**
  - the two passwords are generated service secrets, which the redactor already registers;
  - no password is in an argument: `\getenv`, exec's `-e NAME`, and assignments before the command;
  - the superuser's password reaches no app container, and the owner's only the release;
  - the deploy secret `OPSCREW_RELEASE_DB_ENV` is deleted by destroy;
  - tests use `fakeSecret`.
- **VII. Test-first:** every task starts with failing tests. The SQL is proven on real PostgreSQL
  16 and 17.
- **X. Simplicity:**
  - fixed names, one plan value, no grants file, no third login and no new image;
  - the setup step reuses `ServiceInitStep`, and the loads reuse their current commands with two
    changes;
  - no password file is added (research R7).

All pass.

## 1. The plan's field (T4701)

- **The schema:** `postgres` joins `KINDS_WITH_OPTIONS` in `components.ts`, with
  `z.strictObject({ logins: z.literal("separate").optional() }).prefault({})`.
- **A helper:** `postgresLogins(service): boolean` is true for a PostgreSQL with
  `logins: "separate"`.
- **Unchanged:** the JSON schema and its snapshot follow if they are derived, and a plan without
  the field parses to the same object as before.

## 2. The SQL and its proof (T4702)

`iac-templates/src/catalog/postgres-logins.ts` (new) holds the texts, as pure functions with no
plan input, so they can be tested alone on real PostgreSQL:

- **The names:** `POSTGRES_OWNER = "app_owner"`, `POSTGRES_RUNTIME = "app_runtime"`,
  `OWNER_PASSWORD_ENV`, `RUNTIME_PASSWORD_ENV`.
- **`loginsSetup()`:** the `sh` script the setup step runs in the container. It is
  `psql -X -1 -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"` with the SQL on a quoted
  heredoc, and does data-model.md's steps 1 to 5.
- **`loginsGrants()`:** steps 2 to 5 only, with no password, for the loads.
- **`loginsCheck()`:** the check query's script, which prints `t` and exits 0 only when every step
  holds.
- **`loginPassword(login)`:** the rotation's `begin` script (data-model.md "Rotation").
- **`loginsLoad(o: { host; file; setup: boolean })`:** the load's steps, as one `sh` script for
  the places that run inside a container.

The Docker tests run all of them against `postgres:16-alpine` and the catalog's pinned 17 image.
The test list is in tasks.md, T4702.

## 3. The catalog, runtime and workflow (T4703)

- **The catalog entry:** `POSTGRES` in `entries.ts`, with `postgresLogins(service)`:
  - `secrets`: `password`, `owner-password`, `runtime-password`;
  - `environment`: adds the two `OPSCREW_*_PASSWORD` values;
  - `address`, `databaseSettings`: the runtime login;
  - `init`: one step, with `loginsCheck` as its check and `loginsSetup` as its run;
  - `rotation`: a `swap` for each new secret, with `loginPassword`, `recreate: false` and
    `seconds: 1`.

  Without `logins`, the entry renders exactly as today.
- **The release's variables:** a function `releaseVariables(plan)` in `catalog/index.ts` returns
  the same names `appVariables` and the split settings give, with `app_owner` and
  `owner-password`, or nothing without `logins`.
  - **On a server and the localhost target:** `renderCompose`'s `release` service reads
    `env_file: ["app.env", "release.db.env"]`.
  - **On Portainer:** the stack's `release` environment merges them over the app's.
- **The deploy secret:** `OPSCREW_RELEASE_DB_ENV` joins the deploy secrets (`workflow/shared.ts`,
  `deploySecretNamesFor`). The workflow writes it owner-only as `release.db.env` beside `app.env`,
  and the localhost deploy writes it the same way.
- **Rotation's env files:** `rotateEnvFiles` includes `release.db.env` when `owner-password`
  rotates.
- **Snapshots** (`workflow/snapshots.ts`): `DATABASES.postgres.restore` uses `loginsLoad` with
  `setup: true` for a plan with `logins`. The drill's count also runs `loginsCheck`. Both come
  from the snapshot's plan, so a restore of a snapshot made before the switch loads with the
  plan's current layout.
- **The drill** (`drill/script.ts`): the copy's env gets placeholder values for the two new
  secrets, as for `password`.
- **The guard:** a golden test proves that a plan without `logins` renders every file as before:
  Compose, the Portainer stack, the workflow, rotation, the drill and the snapshots.

## 4. Provision, design, destroy and rotate (T4704)

- **Design** (`design/sizing.ts` and wherever design adds a PostgreSQL) writes
  `options: { logins: "separate" }` for version 15 and later. For an older one it writes nothing,
  and its summary gives data-model.md's notice below 15.
- **Provision:**
  - **The notice:** for a deployed environment (`deployment.firstDeployAt`) whose PostgreSQL lacks
    `logins`, it prints data-model.md's notice, or the one below 15, every run.
  - **The switch:** when the plan has `logins: separate` and the plan at `HEAD` has the service
    without it on a deployed environment, it adds data-model.md's switch lines to the plan it shows.
    Once that is approved by hash, it takes the snapshot through the existing on-demand snapshot
    path before it writes any secret or file, and stops on a failure.
  - **The refusals:** data-model.md's two refusals, before any change. A pinned older version
    without the field is never refused.
  - **The secrets:** it generates the two new secrets like `password`, and writes
    `OPSCREW_RELEASE_DB_ENV`.
- **Destroy:** the server branch of `deploySecretNames` and the by-hand list include
  `OPSCREW_RELEASE_DB_ENV`.
- **Rotate:** `opscrew rotate db` offers the two new secrets, and its plan shows `recreate: false`.
  The rotation's own recipes come from the catalog (T4703).

## 5. Moves and the drill's runner (T4705)

- **The three move paths:** `retarget/server-ops.ts`, `retarget/sides/postgres.ts` (one-off
  containers) and `move/window.ts` (the commands and their text) use data-model.md's load for a
  plan with `logins`:
  - `CREATE DATABASE app OWNER app_owner`;
  - `pg_restore` without `--no-owner`;
  - the grants part after it;
  - in the one-off containers, a check first that both roles exist, with a plain refusal.
- **Without `logins`:** every command is as today.
- **The fakes:** `testing/move.ts` and `move/__fixtures__/world.ts` accept the new commands.
- **The drill's and restore's runners** in `agents/src/snapshot` need changes only where they
  spell out PostgreSQL commands themselves. The implementer checks `restore-checks.ts` and
  `drill-core.ts`, and changes nothing that only passes the catalog's commands on.

## 6. The guide (T4706)

`docs/guide/databases.md` gains "Two logins", and its tables show `app_runtime`. It says:

- which login does what (data-model.md's table);
- that tables, sequences and schemas the owner creates are covered by default privileges;
- how to grant anything else in a migration, guarded for a local database without the role
  (`DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN GRANT …; END
  IF; END $$;`);
- `TEMPORARY`, `TRUNCATE` and the pg-boss case (research R12);
- how to switch an existing database, and that it takes a snapshot and restarts the database once;
- that row-level security applies to `app_runtime`, which doesn't own the tables.

`docs/guide/credential-rotation.md` lists the two new secrets, which restart nothing.

## Project Structure

```text
packages/plan-schema/src/components.ts                 # T4701
packages/iac-templates/src/catalog/postgres-logins.ts  # T4702 (new), + .test.ts, .docker.test.ts
packages/iac-templates/src/catalog/{entries,index}.ts  # T4703
packages/iac-templates/src/runtime/index.ts            # T4703
packages/iac-templates/src/portainer-target/stack.ts   # T4703
packages/iac-templates/src/workflow/{shared,index,rotate,snapshots}.ts  # T4703
packages/iac-templates/src/drill/script.ts             # T4703
packages/agents/src/{design,provision,destroy,rotate}/**  # T4704
packages/agents/src/{retarget,move,snapshot}/**, testing/move.ts  # T4705
docs/guide/{databases,credential-rotation}.md          # T4706
```

## Complexity Tracking

None. The one cost is the database's single restart at the switch (research R3), which the
switch's plan states.
