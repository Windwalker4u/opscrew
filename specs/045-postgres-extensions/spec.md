# Feature Specification: Postgres extensions for an app's database

**Feature Branch**: `045-postgres-extensions` (feature directory `specs/045-postgres-extensions`)
**Created**: 2026-11-25
**Status**: Ready (047 landed on `main`; implementing step 1 `vector` + `contrib` and step 2 PostGIS on `amd64` servers)
**Input**: Roadmap entry `045 Postgres extensions for an app's database`, issue `#28`, and [research.md](research.md) (R1–R6, including the core lead's decisions of 2026-11-25).

## Why

Apps that store embeddings or use PostgreSQL extensions (starting with a hosted dashboard module using `pgvector`) need extensions installed in their PostgreSQL database. Under 047 (ADR 0037), neither the migration login (`app_owner`) nor the app login (`app_runtime`) is a superuser, and untrusted extensions such as `vector` cannot be installed by a non-superuser (`vector.control` omits `trusted = true`). Furthermore, OpsCrew's default `postgres:17-alpine` image does not ship `pgvector`.

Adding `options.extensions` on a PostgreSQL service lets an app declare the extensions it needs, picks the pinned official image that carries them (`pgvector/pgvector` by digest for `vector`, staying on `postgres:*-alpine` for built-in `contrib` extensions), creates them as superuser before migrations, and preserves them safely across image switches, snapshots, restores, restore drills, and moves.

## User Scenarios & Testing

### User Story 1 - Declare PostgreSQL extensions on a new database (Priority: P1)

**Independent Test**: Against fakes and in a real Docker test (`OPSCREW_DOCKER_TESTS=1`), a PostgreSQL service with `options.extensions: ["vector"]` renders the pinned `pgvector/pgvector` image, runs `CREATE EXTENSION IF NOT EXISTS vector` as superuser before migrations, lets `app_owner` create a table with a `vector(3)` column and index, and lets `app_runtime` insert and query nearest neighbors.

**Acceptance Scenarios**:

1. **Given** a plan with a `postgres` service and `options: { logins: "separate", extensions: ["vector"] }`, **When** OpsCrew renders Compose / Portainer stack files, **Then** the database uses the pinned `pgvector/pgvector` digest for that PostgreSQL major version (default 17: `pgvector/pgvector:0.8.7-pg17-trixie@sha256:...`), and no unrelated service changes.
2. **Given** `options.extensions: ["pgcrypto", "pg_trgm"]` (standard `contrib` extensions only), **When** OpsCrew renders the database service, **Then** it stays on the pinned `postgres:*-alpine` image and creates each extension before migrations.
3. **Given** `options.extensions` omits `vector` and is unset/empty, **When** OpsCrew renders existing plans, **Then** every generated file is byte-for-byte identical to before.
4. **Given** an unsupported extension (or combining `vector` and `postgis` in one database, since no single official image carries both), **When** the plan is validated or provisioned, **Then** OpsCrew refuses before changing anything, naming the problem and listing the supported extensions.
5. **Given** `options.extensions` includes a PostGIS extension (`postgis`, `postgis_topology`, `postgis_raster`, `postgis_sfcgal`), **When** the user runs `opscrew design` or `opscrew provision`, **Then** OpsCrew selects the pinned official `postgis/postgis` image (`amd64` only), offers only `amd64` server types in design, and refuses an `arm64` server with a plain-English explanation.
6. **Given** `options.extensions` is set on a non-PostgreSQL service or contains duplicates/empty strings, **Then** `plan-schema` refuses it with a clear message.

---

### User Story 2 - Switch an existing database safely to an extension image (Priority: P1)

**Independent Test**: In a real Docker test (`OPSCREW_DOCKER_TESTS=1`), populate a `postgres:17-alpine` volume (with `logins: separate` and an indexed UTF-8 text column), switch the container to `pgvector/pgvector:0.8.7-pg17-trixie`, run the setup step (`REINDEX DATABASE app`, `ALTER DATABASE app REFRESH COLLATION VERSION`, `CREATE EXTENSION IF NOT EXISTS vector`), and verify both the existing indexed text rows and new `vector` columns work cleanly.

**Acceptance Scenarios**:

1. **Given** a deployed PostgreSQL service on `postgres:17-alpine` whose plan gains `extensions: ["vector"]` against `HEAD`, **When** the user runs `opscrew provision`, **Then** the plan shown (and covered by the approval hash) states plainly:
   - the image switches from `postgres:17-alpine` to `pgvector/pgvector:0.8.7-pg17-trixie`;
   - a snapshot is taken before any change;
   - the database container restarts once;
   - the setup step reindexes the database and refreshes its collation version (noting that reindexing can take a while on a large database), then creates the extension.
2. **Given** the snapshot fails before the switch, **Then** provision stops with nothing changed.
3. **Given** the user approves the plan by hash, **Then** the snapshot runs first, the new image starts, the setup step reindexes and refreshes collation version and creates `vector`, and migrations run afterwards.
4. **Given** an extension is later removed from `options.extensions`, **Then** OpsCrew never runs `DROP EXTENSION ... CASCADE` automatically (no silent data loss).

---

### User Story 3 - Snapshots, restores, restore drills, and moves preserve extensions (Priority: P1)

**Independent Test**: In real Docker tests (`OPSCREW_DOCKER_TESTS=1`), dump and restore (in place, into a throwaway drill container, and in a move): (a) a database with `vector` rows and an index, and (b) a database with PostGIS geometry data, `spatial_ref_sys` rows, and a `topology` schema — verifying extensions, data, `spatial_ref_sys`, and `topology` are preserved while `app_owner` remains non-superuser and `app_runtime` can query them.

**Acceptance Scenarios**:

1. **Snapshots & restores:** `pg_dump -Fc` and `pg_restore` run as superuser `app` on the extension-capable image, keeping `vector` and all extension objects intact.
2. **Restore drills:** the throwaway drill container uses the plan's resolved extension image (`pgvector/pgvector` when `vector` is requested), so `pg_restore` never fails with `extension "vector" is not available`.
3. **Moves (`retarget` / `move`):** the destination database uses the plan's resolved extension image, creates/restores extensions as superuser, and verifies `app_runtime` reads and writes.
4. **Pin carryover:** `pins-carry` never pins an older `postgres:17-alpine` digest over a newly requested `pgvector/pgvector` image (and vice versa).

---

### User Story 4 - Guide documentation (Priority: P2)

**Acceptance Scenarios**:

1. `docs/guide/databases.md` documents `options.extensions` with examples (`extensions: [vector]` and `extensions: [postgis]`), the supported extensions list, that `vector` switches to `pgvector/pgvector` (snapshot + restart + reindex on existing databases), and that `postgis` uses `postgis/postgis` on `amd64` servers only (and cannot be combined with `vector` in one service).

## Functional Requirements

- **FR-001**: `packages/plan-schema` adds optional `options.extensions: string[]` on `postgres` services (unique, validated against the supported extension set, refused on other service kinds or unknown extension names with the supported list).
- **FR-002**: `packages/iac-templates` pins official `pgvector/pgvector` multi-arch digests (`pg17-trixie`, `pg16-trixie`, `pg15-trixie`), selects `pgvector/pgvector` when `vector` is in `options.extensions` and keeps `postgres:*-alpine` otherwise, and updates `pins-carry` to match repository + major version.
- **FR-003**: PostgreSQL's superuser setup step (`serviceInit` and Portainer `<service>-init`) runs `CREATE EXTENSION IF NOT EXISTS "<name>";` for every configured extension before migrations, and runs `REINDEX DATABASE app; ALTER DATABASE app REFRESH COLLATION VERSION;` when switching from musl to glibc / on collation version mismatch.
- **FR-004**: `provision` detects an image switch against `HEAD`, includes the switch/restart/reindex/snapshot-first lines in the plan and its SHA-256 hash, takes a snapshot before writing on approval, and aborts cleanly if the snapshot fails.
- **FR-005**: Snapshots, restores, restore drills, and moves (`retarget` / `move`) use the service's resolved extension image and preserve extensions.
- **FR-006**: Unit tests with fakes plus real Docker tests (`OPSCREW_DOCKER_TESTS=1`) verifying `vector` creation/query/restore and Alpine-to-pgvector collation switch, removing all created containers/volumes/networks (`docker rm -fv`).
- **FR-007**: `docs/guide/databases.md` updated with extensions documentation.
