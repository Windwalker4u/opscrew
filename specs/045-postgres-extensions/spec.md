# Feature Specification: Postgres extensions for an app's database

**Feature Branch**: `045-postgres-extensions` (feature directory `specs/045-postgres-extensions`)
**Created**: 2026-11-25 | **Updated**: 2026-11-26 (PR #30 review decisions for 0.2.12)
**Status**: Ready (`0.2.12`)
**Input**: Roadmap entry `045 Postgres extensions for an app's database`, issue `#28`, PR `#30` review, and [research.md](research.md).

## Why

Apps that store embeddings (`pgvector`), geospatial data (`postgis`), or use PostgreSQL `contrib` extensions need them installed in their PostgreSQL database. Under 047 (ADR 0037), neither the migration login (`app_owner`) nor the app login (`app_runtime`) is a superuser, and untrusted extensions such as `vector` cannot be installed by a non-superuser (`vector.control` omits `trusted = true`). Furthermore, OpsCrew's default `postgres:17-alpine` image does not ship `pgvector` or PostGIS.

Adding `options.extensions` on a PostgreSQL service lets an app declare the extensions it needs when the database is created, picks the pinned official image that carries them (`pgvector/pgvector` by digest for `vector`, `postgis/postgis` on `amd64` for PostGIS, staying on `postgres:*-alpine` for built-in `contrib` extensions), creates them as superuser before `loginsSetup` moves schema ownership and before migrations run, and preserves them across snapshots, restores, restore drills, and moves.

## Scope for 0.2.12

In `0.2.12`, extensions are set up **at database creation only** (no in-place image switch):
- `CREATE EXTENSION` runs as superuser before `loginsSetup` transfers schema ownership to `app_owner`, avoiding running third-party extension DDL inside an `app_owner`-controlled schema (ADR 0037) and avoiding PostgreSQL's `ERROR: invalid collation version change` when changing from Alpine musl (`datcollversion IS NULL`) to Debian glibc.
- `provision` records each database's extension set in `generated_values.json`. Any attempt to add or remove extensions on a database that already has data (`neverRan`) is refused before anything changes.
- `postgis_topology` is deferred past `0.2.12` (until `topology.CreateTopology()` grants are designed). Supported PostGIS extensions in `0.2.12`: `postgis`, `postgis_raster`, `postgis_sfcgal`.
- Rebuilding an existing database via snapshot into a fresh volume on a new image is tracked as a follow-up task in `tasks.md`, outside `0.2.12`.

## User Scenarios & Testing

### User Story 1 - Declare PostgreSQL extensions on a new database (Priority: P1)

1. `options: { logins: "separate", extensions: ["vector"] }` renders the pinned `pgvector/pgvector:0.8.7-pg17-trixie@sha256:...` image, runs `CREATE EXTENSION IF NOT EXISTS "vector" CASCADE;` as superuser before `loginsSetup` and migrations, lets `app_owner` create tables with `vector(3)` columns and indexes, and lets `app_runtime` insert and query them.
2. `options.extensions: ["pgcrypto", "pg_trgm"]` (built-in `contrib` only) stays on `postgres:17-alpine@sha256:...`.
3. `options.extensions` unset/empty renders every Compose file and `.github/dependabot.yml` byte-for-byte identically to before.
4. Unknown extension names, duplicates, combining `vector` with PostGIS, or setting `extensions` on a non-PostgreSQL service are refused at schema validation with a plain-English message listing the supported extensions.
5. PostGIS (`postgis`, `postgis_raster`, `postgis_sfcgal`) selects the pinned `postgis/postgis:17-3.7-alpine@sha256:...` image (`amd64` only). Design and provision refuse PostGIS on any `arm64` host (own server, extra server, Portainer host, this computer, or a hand-edited ARM cloud `serverType` such as `cax11`) before anything changes.

### User Story 2 - Refuse changing extensions on an existing database with data (Priority: P1)

1. When `provision` creates a PostgreSQL database, it records its extension set in `generated_values.json`.
2. Re-provisioning an existing database whose `extensions` are unchanged passes cleanly.
3. Adding or removing extensions on a database that already has data (`neverRan` does not report it empty) is refused before anything is written and before 047's switch approval/snapshot.
4. A database that never ran yet (`neverRan` reports it empty) may still change its `extensions` before creation.

### User Story 3 - Snapshots, restores, restore drills, and moves preserve extensions (Priority: P1)

1. Snapshots, in-place restores, restore drills, and moves (`retarget` / `move`) use the service's resolved extension image and preserve `vector`, `contrib`, and PostGIS (`spatial_ref_sys`, geometry data) under 047's `loginsLoad` rules, keeping `app_owner` non-superuser.
2. Extension-created schemas (including `deptype = 'n'` dependencies other than `public`) stay superuser-owned under `loginsSetup`, and extension-owned `SEQUENCE SET` entries restore as superuser under `loginsLoad`.
3. Dependabot locks major updates for `pgvector/pgvector` / `postgis/postgis` only when a plan uses those images, and `pins-carry` keeps their committed major versions.

### User Story 4 - Guide documentation (Priority: P2)

`docs/guide/databases.md` documents `options.extensions`, the exact supported list, image/architecture rules (`amd64` only for PostGIS, no `vector` + PostGIS combined), and that extensions apply at database creation (refused on existing databases with data in `0.2.12`).
