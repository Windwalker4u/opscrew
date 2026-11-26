# Implementation Plan: Postgres extensions for an app's database

**Feature**: `045-postgres-extensions` | **Date**: 2026-11-26 | **Issue**: `#28`
**Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)
**Builds on**: Feature 047 (`specs/047-postgres-logins/`, ADR 0037) on `main`.

## Summary

Add declarative PostgreSQL extensions via optional `services[].options.extensions: string[]` on `postgres` services:

1. **Step 1 (`vector` + standard `contrib`):**
   - `vector` resolves to the pinned official multi-arch `pgvector/pgvector:0.8.7-pg17-trixie@sha256:...` image; standard PostgreSQL `contrib` extensions stay on `postgres:17-alpine@sha256:...`.
   - PostgreSQL's superuser setup step (`postgresInit` on servers/localhost and `<service>-init` on Portainer) checks collation version mismatch (`datcollversion IS DISTINCT FROM pg_database_collation_actual_version(oid)`), runs `REINDEX DATABASE app; ALTER DATABASE app REFRESH COLLATION VERSION;` outside a transaction when mismatched (e.g., Alpine musl → Debian glibc switch), and runs `CREATE EXTENSION IF NOT EXISTS "<name>" CASCADE;` for each configured extension before migrations, keeping `app_owner` and `app_runtime` non-superuser.
   - Switching an existing database's image in `opscrew provision` is detected from the environment's generated values and committed Compose file, shown as an explicit switch plan bound to its SHA-256 hash (naming the image change, restart, reindex/collation refresh on Alpine↔Debian switches, and snapshot-first step), takes a snapshot of the switching database first (skipping databases that never ran), and aborts cleanly with nothing changed if the snapshot fails.
2. **Step 2 (PostGIS on `amd64` servers):**
   - `postgis`, `postgis_topology`, `postgis_raster`, and `postgis_sfcgal` resolve to the pinned official `postgis/postgis:17-3.7-alpine@sha256:...` image (`amd64` only).
   - Combining `vector` and any PostGIS extension in the same database is refused at schema validation with a plain-English message.
   - Design and provision refuse running a PostGIS database on an `arm64` server (own server, extra server, Portainer host, or hand-edited arm cloud `serverType`).
   - Snapshots, restores, restore drills, and moves (`retarget` / `move`) use the service's resolved image and preserve PostGIS geometry data, `spatial_ref_sys`, and `topology` under 047's `loginsLoad` rules (including superuser-owned extension sequences in `pg_restore` if present), keeping `app_owner` non-superuser.

## Architecture & Module Boundaries

### 1. `@opscrew/plan-schema` (`packages/plan-schema/src/components.ts`, `src/index.ts`)
- Export exact extension constants and type:
  - `POSTGRES_VECTOR_EXTENSION = "vector"`
  - `POSTGRES_POSTGIS_EXTENSIONS = ["postgis", "postgis_topology", "postgis_raster", "postgis_sfcgal"] as const`
  - `POSTGRES_CONTRIB_EXTENSIONS = ["pgcrypto", "uuid-ossp", "pg_trgm", "citext", "hstore", "unaccent", "fuzzystrmatch", "btree_gin", "btree_gist", "ltree", "intarray", "cube", "earthdistance", "tablefunc", "isn", "lo", "bloom"] as const`
  - `POSTGRES_EXTENSIONS = [POSTGRES_VECTOR_EXTENSION, ...POSTGRES_POSTGIS_EXTENSIONS, ...POSTGRES_CONTRIB_EXTENSIONS] as const`
  - `PostgresExtension`
- Add optional `extensions` field to `postgres` service `options` (beside `logins`):
  - Validates every entry against `POSTGRES_EXTENSIONS` (unknown names fail with the supported list).
  - Rejects duplicates.
  - Rejects combining `vector` with any PostGIS extension in the same service.
  - Non-`postgres` services keep `z.strictObject`, so `options.extensions` is refused there.
- Export helpers: `postgresExtensions(service)`, `postgresUsesVector(service)`, `postgresUsesPostgis(service)`, `postgresImageVariant(service)` (`"postgres" | "pgvector" | "postgis"`).

### 2. `@opscrew/iac-templates`
- **`src/pins.ts`**: add `IMAGES.pgvector` (`pgvector/pgvector:0.8.7-pg17-trixie@sha256:89947206f52eac3a9df9b663df7e76987cbdc623be6576b3a524953d568700d7`) and `IMAGES.postgis` (`postgis/postgis:17-3.7-alpine@sha256:357cbb8c459016596cd49539037c099128ff5bb07e382df283c5acb026c63d5a`).
- **`src/catalog/index.ts`**: export `serviceImageKey(service)` and `serviceImageRef(service)`. Use `serviceImageRef(service)` in:
  - `src/runtime/components.ts` (`renderServices` — covers servers, localhost, previews, and server restore drills);
  - `src/portainer-target/stack.ts` (`initService`);
  - `src/workflow/snapshots.ts` (`snapshotParts`);
  - `src/portainer-target/snapshots.ts` (`portainerSnapshotParts`).
- **`src/dependabot/index.ts`**: keep `pgvector/pgvector` and `postgis/postgis` major-locked alongside `postgres` in `NO_MAJOR_UPDATES` (and verify `keepNewerPins` in `src/pins-carry.ts` never carries a `postgres` pin across to `pgvector/pgvector` or `postgis/postgis`, while keeping committed majors within the same repository).
- **`src/catalog/postgres-extensions.ts`** (new, exported from `catalog/index.ts` and package root):
  - `extensionsCheck(extensions, host?)`: single query checking every requested extension is present in `pg_extension` AND `d.datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(d.oid)` for database `app`.
  - `extensionsSetup(service, extensions, options?: { guardEventTriggers?: boolean })`:
    - When `guardEventTriggers` is true (`logins: separate`), refuses a database with event triggers first (matching 047's safety rule so the superuser never runs DDL under owner-controlled event triggers).
    - Checks `d.datcollversion IS DISTINCT FROM pg_database_collation_actual_version(d.oid)` and, when true, runs `REINDEX DATABASE app;` and `ALTER DATABASE app REFRESH COLLATION VERSION;` (outside a transaction block, since PostgreSQL forbids `REINDEX DATABASE` inside `BEGIN...COMMIT`).
    - Runs `CREATE EXTENSION IF NOT EXISTS "<name>" CASCADE;` for each extension (double-quoted identifier validated against `POSTGRES_EXTENSIONS`).
  - Wired into `postgresInit` in `src/catalog/entries.ts`:
    - Runs before `loginsSetup` when both `extensions` and `logins: separate` are present, or alone when only `extensions` is present.
    - Returns `[]` when neither is present (byte-for-byte identical for existing plans).
- **`src/catalog/postgres-logins.ts`**: verify `loginsLoad` against real PostGIS (`postgis` + `postgis_topology`) dumps in Docker; extend `EXTENSION_TABLES` if PostGIS emits extension-owned `SEQUENCE SET` entries (such as `topology.topology_id_seq`) so superuser restores them in `$d/last` (matched whole with owner) while `app_owner` restores all app objects/rows without superuser rights.

### 3. `@opscrew/agents`
- **`src/design/postgres-extensions.ts`** (new):
  - `requirePostgisArch(services, arch, where, planFile, command?)`: plain-English refusal when any enabled PostgreSQL service uses PostGIS on an `arm64` host.
  - Wired into `design/own.ts` (`buildOwnServerOption`), `design/own-servers.ts` (`designOwnServer`), `design/portainer.ts` (`buildPortainerOption`), and `design/servers.ts` (`designCloudServer` when user sets an explicit `arm` `serverType`).
- **`src/provision/postgres-extensions.ts`** (new, modeled on `src/provision/postgres-logins.ts`):
  - `requireExtensionsArch(plan, command)`: checks every enabled PostgreSQL service with PostGIS against its target server's architecture (`targetArch(plan.target)` or extra server's `arch`), refusing `arm64` before any change. Also checked in `provision/own.ts` and `provision/stack-plan.ts` against live inspected `facts.arch`.
  - `extensionsSwitch(plan, kept, committedImages, environment)`: compares each enabled PostgreSQL's resolved image repository (`postgres`, `pgvector/pgvector`, `postgis/postgis`) against the committed Compose file's image for that service (only when `kept.dbPassword !== undefined`, i.e. existing environment). Builds deterministic plan lines and SHA-256 hash (`canonicalJson({ switch: "postgres-extensions", ... })`):
    - Names snapshot first, image change, container restart once;
    - When crossing Alpine (musl) ↔ Debian (glibc), explicitly notes `REINDEX DATABASE` + collation version refresh and that reindexing can take a while on a large database;
    - When switching away from `pgvector/pgvector` or `postgis/postgis`, warns that OpsCrew never runs `DROP EXTENSION` automatically and existing columns/tables depending on removed extensions must be migrated first.
  - `postgresExtensionsStep(deps, plan, o)`: runs right beside `postgresLoginsStep` in `provision/run.ts` (`runPhaseFlow`), enforces approval by hash (respecting `--plan-only`), runs `neverRan` + snapshot-first (reusing already-snapshotted services if `postgresLoginsStep` just snapshotted them in the same run), and aborts cleanly with nothing changed if snapshot fails.
- **`src/retarget/` & `src/move/`**: verify `MovePostgres` / `restoreDatabase` preserve `vector` and PostGIS extensions cleanly (the database server itself runs the resolved extension image; `pg_dump`/`pg_restore` 17 connects over TCP). Add optional `image?: string` to `MovePostgres` (passed from `serviceImageRef(service)` in `retarget/window.ts`) so even one-off containers match the service image consistently.

### 4. Documentation (`docs/guide/databases.md`)
- Add an **Extensions** section documenting `options.extensions`, YAML examples (`extensions: [vector]` and `extensions: [postgis]`), the supported extensions list, switching an existing database (snapshot, restart, Alpine→Debian reindex/collation refresh), `amd64`-only requirement for PostGIS, why `vector` and `postgis` cannot be combined in one service, and why removing an extension never runs `DROP EXTENSION`.

## Verification Plan

1. **Unit tests (fakes only):**
   - `@opscrew/plan-schema`: valid extensions, duplicates, unknowns (lists supported), `[vector, postgis]` refusal, non-postgres refusal, helpers.
   - `@opscrew/iac-templates`: `pins.ts`, `pins-carry.ts`, `catalog` (`serviceImageRef`, `postgresInit`, `extensionsCheck`, `extensionsSetup`), `runtime/components`, `portainer-target/stack` & `snapshots`, `workflow/snapshots`, `drill`, `dependabot`.
   - `@opscrew/agents`: `design` arm64 refusals (own server, extra own server, Portainer, arm cloud `serverType`), `provision/postgres-extensions.test.ts` (switch plan lines, hash binding, `--plan-only`, refusal without approval, snapshot-first, snapshot failure aborts, `neverRan` skip, contrib-only needs no switch, arm64 refusal).
2. **Real Docker tests (`OPSCREW_DOCKER_TESTS=1`):**
   - `packages/iac-templates/src/catalog/postgres-extensions.docker.test.ts`:
     - Fresh `pgvector/pgvector:0.8.7-pg17-trixie` with `logins: separate` + `extensions: ["vector", "pg_trgm"]`: setup runs as superuser, `app_owner` creates a table with `vector(3)` column + HNSW index, `app_runtime` inserts & runs `<=>` nearest-neighbor query, `pg_dump` + `loginsLoad` restores into fresh DB (and drill/move), preserving vector data & index while `app_owner` stays non-superuser.
     - Existing populated `postgres:17-alpine` volume (with `logins: separate` and indexed UTF-8 text rows including accented/non-ASCII strings) stopped and restarted on `pgvector/pgvector:0.8.7-pg17-trixie`: `extensionsCheck` returns false (collation mismatch + missing `vector`), `extensionsSetup` runs `REINDEX DATABASE app`, `ALTER DATABASE app REFRESH COLLATION VERSION`, and `CREATE EXTENSION IF NOT EXISTS "vector"`, `extensionsCheck` returns true, existing text index lookups and new vector queries both succeed.
     - Fresh `postgis/postgis:17-3.7-alpine` with `logins: separate` + `extensions: ["postgis", "postgis_topology"]`: setup runs, `app_owner` creates a geometry table + inserts points + creates a topology, `app_runtime` queries `ST_Distance` and reads `spatial_ref_sys`, then `pg_dump -Fc` + `loginsLoad` (in-place restore, drill copy, and move-style restore with `setup: false`) preserves geometry rows, `spatial_ref_sys`, and `topology` schema while `app_owner` remains non-superuser and `topology` remains superuser-owned.
   - Clean up all created containers, volumes, and networks (`docker rm -fv` / `docker volume rm -f`) in `afterAll` and verify `docker ps -a` / `docker volume ls` leave nothing behind.
3. **Full checks:** `pnpm lint`, `pnpm typecheck`, all affected test suites + `opscrew` CLI build.
