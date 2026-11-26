# Implementation Plan: Postgres extensions for an app's database

**Feature**: `045-postgres-extensions` | **Date**: 2026-11-26 | **Issue**: `#28` | **PR**: `#30`
**Spec**: [spec.md](spec.md) | **Research**: [research.md](research.md)
**Builds on**: Feature 047 (`specs/047-postgres-logins/`, ADR 0037) on `main`.

## Summary (`0.2.12`)

Add declarative PostgreSQL extensions via optional `services[].options.extensions: string[]` on `postgres` services, created as superuser when the database is initialized (before `loginsSetup` moves ownership to `app_owner` and before migrations run):

1. **`@opscrew/plan-schema` (`src/components.ts`):**
   - `POSTGRES_VECTOR_EXTENSION = "vector"`
   - `POSTGRES_POSTGIS_EXTENSIONS = ["postgis", "postgis_raster", "postgis_sfcgal"] as const` (`postgis_topology` deferred past `0.2.12`)
   - `POSTGRES_CONTRIB_EXTENSIONS = ["pgcrypto", "uuid-ossp", "pg_trgm", "citext", "hstore", "unaccent", "fuzzystrmatch", "btree_gin", "btree_gist", "ltree", "intarray", "cube", "earthdistance", "tablefunc", "isn", "lo", "bloom"] as const`
   - Helpers: `postgresExtensions`, `postgresPostgisExtensions`, `postgresUsesVector`, `postgresUsesPostgis`, `postgresImageVariant`.
2. **`@opscrew/iac-templates`:**
   - Pin `IMAGES.pgvector` (`pgvector/pgvector:0.8.7-pg17-trixie@sha256:89947206f52eac3a9df9b663df7e76987cbdc623be6576b3a524953d568700d7`) and `IMAGES.postgis` (`postgis/postgis:17-3.7-alpine@sha256:357cbb8c459016596cd49539037c099128ff5bb07e382df283c5acb026c63d5a`).
   - `serviceImageKey(service)` / `serviceImageRef(service)` wired into Compose (`runtime/components.ts`), Portainer stack + `db-init` (`portainer-target/stack.ts`), server and Portainer snapshot parts (`workflow/snapshots.ts`, `portainer-target/snapshots.ts`), and restore drills.
   - `catalog/postgres-extensions.ts`: `extensionsCheck` (`pg_extension` count) and `extensionsSetup` (optional event-trigger guard + `CREATE EXTENSION IF NOT EXISTS "<name>" CASCADE;`), run before `loginsSetup` in `postgresInit`.
   - `catalog/postgres-logins.ts`: keep superuser ownership on extension-created schemas (`deptype = 'n'` as well as `'e'`, excluding `public`) and restore extension-owned `SEQUENCE SET` entries as superuser in `loginsLoad`.
   - `dependabot/index.ts` & `pins-carry.ts`: add `pgvector/pgvector` / `postgis/postgis` to `.github/dependabot.yml` `ignore` only when a plan uses those images, while keeping their committed majors in `pins-carry`.
3. **`@opscrew/agents`:**
   - `design/postgres-extensions.ts`: `requirePostgisArch` using `postgresPostgisExtensions` from `@opscrew/plan-schema`, wired into `design/own.ts`, `design/own-servers.ts`, `design/portainer.ts` (with `components` carrying `previous` edits), `design/servers.ts` (arm cloud offers), and `localhost/design.ts`.
   - `provision/postgres-extensions.ts`: `requireExtensionsArch` (checks own, Portainer, localhost, and cloud `serverType` architecture from provider catalogues) + `postgresExtensionsStep` (compares against `postgresExtensions` recorded in `generated_values.json`, checks `neverRan`, and refuses adding or removing extensions on any database that already has data before anything is written).
   - Wired into `provision/run.ts` **before** `postgresLoginsStep`, `provision/own.ts` (live inspected arch), `provision/portainer-flow.ts` (live inspected `facts.environment?.arch`), `provision/secrets.ts` (records `postgresExtensions` in `generated_values.json`), and `retarget/sides/postgres.ts` / `retarget/window.ts`.
4. **Documentation (`docs/guide/databases.md`):**
   - Document `options.extensions`, the exact supported list, image/architecture rules, and creation-only scope in `0.2.12`.
