# Research: Postgres extensions for an app's database

**Feature**: 045 | **Date**: 2026-11-25 | **Issue**: `#28`
**Sources (official only)**:
- `pgvector/pgvector` repository (`Dockerfile`, `vector.control`, `LICENSE`) at `github.com/pgvector/pgvector` (master, checked 2026-11-25);
- Docker Hub v2 registry metadata for `pgvector/pgvector` and `postgis/postgis` (checked 2026-11-25);
- `docker-library/postgres` official `17/alpine3.23/Dockerfile` and `17/trixie/Dockerfile` (`github.com/docker-library/postgres`, checked 2026-11-25);
- PostgreSQL 17 manual (`CREATE EXTENSION`, Appendix F Additional Supplied Modules / `contrib`, `ALTER DATABASE ... REFRESH COLLATION VERSION`, `REINDEX`);
- OpsCrew ADR 0037 (`docs/adr/0037-postgres-logins.md`) and `specs/047-postgres-logins/research.md` (R1–R13).

## R1. Official `pgvector/pgvector` images

From `github.com/pgvector/pgvector/master/Dockerfile` and Docker Hub (`hub.docker.com/v2/repositories/pgvector/pgvector/tags`):

- **Base image:** `FROM postgres:$PG_MAJOR-$DEBIAN_CODENAME` (`trixie` or `bookworm`). No Alpine tags exist (`0` tags matching `alpine`).
- **Build:** compiles `pgvector` `v0.8.7` from source with `make OPTFLAGS=""` (portable CPU binaries, no host-specific AVX assumptions), runs `make install`, and removes `build-essential` and `postgresql-server-dev-$PG_MAJOR`.
- **Licence:** PostgreSQL License (permissive, identical to PostgreSQL itself; constitution X compliant).
- **Architectures:** multi-arch manifest list supporting both `linux/amd64` (~164 MB compressed) and `linux/arm64` (~162 MB compressed), so ARM servers (Hetzner CAX, Raspberry Pi home servers) work without emulation.
- **Data directory and locale:** on PostgreSQL 15–17, `ENV PGDATA /var/lib/postgresql/data` and `ENV LANG en_US.utf8` match OpsCrew's existing `POSTGRES.dataDir` (`/var/lib/postgresql/data`). Note: PostgreSQL 18 changes the official image's `PGDATA` volume layout (`/var/lib/postgresql`), which is out of scope while OpsCrew pins PostgreSQL 17.
- **Verified pinned manifest digests (2026-11-25, pgvector `0.8.7`):**

| PostgreSQL major | Image ref (Debian Trixie) | Image ref (Debian Bookworm) |
|---|---|---|
| **17 (OpsCrew default)** | `pgvector/pgvector:0.8.7-pg17-trixie@sha256:89947206f52eac3a9df9b663df7e76987cbdc623be6576b3a524953d568700d7` | `pgvector/pgvector:0.8.7-pg17-bookworm@sha256:b513c48566e4777cd3370451400000c78eda6a08131d68f4c31d4a76f27bd8fd` |
| **16** | `pgvector/pgvector:0.8.7-pg16-trixie@sha256:c28c0b700f3f1b5eec14082b31ad6e7c8a566d14386323609c615315e7c0ffc8` | `pgvector/pgvector:0.8.7-pg16-bookworm@sha256:484e838076e04939d27d3e176e91c86eea96236126023be8d3059761122e579f` |
| **15** | `pgvector/pgvector:0.8.7-pg15-trixie@sha256:becac1db6f17dc1570335730f92a0c7670cf5b039722527c5850b8cae7670a3d` | — |

**Recommendation:** pin `pgvector/pgvector:0.8.7-pg17-trixie@sha256:89947206f52eac3a9df9b663df7e76987cbdc623be6576b3a524953d568700d7` in `packages/iac-templates/src/pins.ts` (Debian 13 Trixie is pgvector's own default `DEBIAN_CODENAME` in its `Dockerfile` and the newest stable Debian base), alongside pinned refs for PG 16 / PG 15 if users pin `version: "16"` or `"15"`.

## R2. Extensions carried by each pinned image

### 1. Official `postgres:17-alpine` (current default in `pins.ts`)
From `docker-library/postgres` `17/alpine3.23/Dockerfile`:
- Built with `--with-uuid=e2fs`, `--with-icu` (+ `icu-data-full`), and `make -C contrib install`.
- Carries **all standard PostgreSQL 17 `contrib` extensions** out of the box, with **no image switch needed**.
- Common app-facing `contrib` extensions that require only `CREATE EXTENSION IF NOT EXISTS <name>` (no `shared_preload_libraries`):
  - **Trusted (`trusted = true`):** `pgcrypto`, `uuid-ossp`, `pg_trgm`, `citext`, `hstore`, `unaccent`, `fuzzystrmatch`, `btree_gin`, `btree_gist`, `ltree`, `intarray`, `cube`, `earthdistance`, `tablefunc`, `isn`, `lo`, `dict_int`, `tsm_system_rows`, `tsm_system_time`, `moddatetime`, `seg`, `bloom`.
  - **Untrusted (require superuser):** `xml2`, `pgrowlocks`, `pgstattuple`, `pg_buffercache`, `pg_prewarm`, `pageinspect`, `pg_freespacemap`, `pg_visibility`, `dblink`, `postgres_fdw`, `file_fdw`, `sslinfo`, `adminpack`.
- **Special note on `pg_stat_statements`:** bundled in `contrib`, but also requires `shared_preload_libraries = 'pg_stat_statements'` at server start (already noted in `packages/agents/src/advise/database.ts`). Should be treated distinctly (either excluded from plain `extensions` with a clear hint, or explicitly configured with `-c shared_preload_libraries=pg_stat_statements`).

### 2. Official `pgvector/pgvector:0.8.7-pg17-trixie`
- Built `FROM postgres:17-trixie`, so it carries **every standard PostgreSQL 17 `contrib` extension above** PLUS **`vector`** (`pgvector` `0.8.7`).
- Therefore, requesting `extensions: [vector, pgcrypto, pg_trgm]` is satisfied by one single pinned image (`pgvector/pgvector`).

### 3. Official `postgis/postgis` images (Step 2 of 045, founder & core lead 2026-11-25)

From `github.com/postgis/docker-postgis` (`initdb-postgis.sh`) and Docker Hub (`hub.docker.com/v2/repositories/postgis/postgis/tags`, checked 2026-11-25):

- **Verified pinned manifest digests (PostGIS 3.7, Alpine — same musl libc as `postgres:*-alpine`):**
  - PG 17 (default): `postgis/postgis:17-3.7-alpine@sha256:357cbb8c459016596cd49539037c099128ff5bb07e382df283c5acb026c63d5a` (~190 MB compressed)
  - PG 16: `postgis/postgis:16-3.7-alpine@sha256:5c640cecd236ab5e5755637818a55f8e55ceebd23370d667025bb97280a3d62a`
  - PG 15: `postgis/postgis:15-3.7-alpine@sha256:7f7b453e0bde9dd7aa874585e5cea15704ed6e4d9fd9a1f48976267be99710a5`
- **Architectures:** **`linux/amd64` only** (no `arm64` manifest). When any PostGIS extension (`postgis`, `postgis_topology`, `postgis_raster`, `postgis_sfcgal`) is requested, design offers only `amd64` server types and refuses `arm64` servers with a plain-English explanation.
- **Extensions carried:** all standard PostgreSQL `contrib` extensions PLUS `postgis`, `postgis_topology`, `postgis_raster`, and `postgis_sfcgal`. (Note: PostGIS 3.7 removed `postgis_tiger_geocoder`, confirmed in `initdb-postgis.sh`.)
- **First-start init script (`initdb-postgis.sh`):** on an empty `PGDATA`, the image creates `template_postgis` and automatically runs `CREATE EXTENSION IF NOT EXISTS postgis;` and `CREATE EXTENSION IF NOT EXISTS postgis_topology;` into `$POSTGRES_DB` (`app`), which creates the `topology` schema owned by superuser `app`. On an existing `PGDATA` volume (switching from `postgres:17-alpine`), `/docker-entrypoint-initdb.d/` does not run, so OpsCrew's superuser setup step runs `CREATE EXTENSION IF NOT EXISTS` explicitly.
- **Interaction with 047 (ADR 0037):**
  - Extension schemas (`topology`, linked to `postgis_topology` via `pg_depend` `deptype = 'e'`) stay owned by superuser `app` (never reassigned to `app_owner`).
  - Extension config tables (such as `spatial_ref_sys`) are restored by the superuser as matched whole entries with their owner (`047`'s load rules), keeping `app_owner` non-superuser afterwards.
  - Because `postgis/postgis:17-3.7-alpine` uses Alpine (musl), switching from `postgres:17-alpine` keeps the same libc (snapshot-first + restart still required and shown in the plan).
- **Licence:** PostGIS is GPL-2.0+. Because OpsCrew only pulls the official container image that the user's own server runs and never links GPL code into the CLI, GPL is no obstacle (constitution X).
- **Combining `vector` and `postgis`:** no single official image carries both `pgvector` and `postgis`, so requesting both in the same service is refused before anything changes with a plain-English message.
- Any extension not in the supported catalog is refused before any plan or change, listing the supported extensions cleanly.

## R3. Privileges and interaction with 047 (ADR 0037)

From `github.com/pgvector/pgvector/master/vector.control`:
```text
comment = 'vector data type and ivfflat and hnsw access methods'
default_version = '0.8.7'
module_pathname = '$libdir/vector'
relocatable = true
```
- **`vector` is NOT marked `trusted = true`.** Under PostgreSQL 17's `CREATE EXTENSION` rules, installing `vector` **requires superuser privileges**. Neither `app_owner` nor `app_runtime` (both `NOSUPERUSER` under ADR 0037) can run `CREATE EXTENSION vector;`.
- **How 045 fits 047 cleanly:**
  1. In 047, the catalog's PostgreSQL `init` step already runs as the bootstrap superuser `app` over the container's local socket before the release command (migrations) — on servers via `serviceInit`, and on Portainer via `<service>-init`.
  2. Running `CREATE EXTENSION IF NOT EXISTS "<name>";` in that superuser setup step (for both `logins: separate` and pre-047 databases) ensures every requested extension exists before migrations run, without granting `app_owner` or `app_runtime` any extra privileges.
  3. Under ADR 0037 R4 and R6, extensions remain owned by the superuser `app`, and `PUBLIC` keeps `EXECUTE` on functions and `USAGE` on types. That means `app_owner` can create tables with `vector(N)` columns and HNSW/IVFFlat indexes in migrations, and `app_runtime` can `INSERT` / `SELECT` / `ORDER BY embedding <=> ...` immediately. (Verified in 045's real Docker test under `OPSCREW_DOCKER_TESTS=1`.)
  4. **Extension removal:** removing an extension from `extensions: [...]` must not run `DROP EXTENSION ... CASCADE` automatically (that would drop user tables/columns and destroy data); OpsCrew leaves existing extensions installed and warns if the image itself would change away from an image that carries an installed extension.

## R4. Switching an existing database's image: Alpine (musl) -> Debian (glibc) collation risk

**Critical finding from comparing `17/alpine3.23/Dockerfile` and `17/trixie/Dockerfile`:**
- OpsCrew's default `postgres:17-alpine` uses **musl libc** with `LANG=en_US.utf8`.
- Official `pgvector/pgvector:0.8.7-pg17-trixie` uses **Debian glibc** with `LANG=en_US.utf8`.
- Under musl vs glibc, `en_US.utf8` collation sort order differs (musl uses codepoint order; glibc uses locale linguistic collation with versioned `datcollversion`). Starting a glibc PostgreSQL server directly on a `PGDATA` volume initialized by Alpine (musl) can leave existing text B-tree / unique indexes out of order (`WARNING: database "app" has a collation version mismatch` or silent lookup/uniqueness bugs on non-ASCII text).
- **Safe switch procedure (to confirm with the core lead before 045's spec):**
  1. When `extensions` switches an existing deployed database from `postgres:*-alpine` to `pgvector/pgvector:*-trixie`, `provision` detects the image change against `HEAD` (just as 047 detects `logins: separate`) and shows the image switch, the restart, and the snapshot-first step in the plan approved by hash.
  2. After approval, take a snapshot first before restarting/recreating the container with the new image.
  3. Once the new container starts, run `REINDEX DATABASE app;` and `ALTER DATABASE app REFRESH COLLATION VERSION;` (as superuser `app` in the setup step / switch check when collation version mismatches or on image switch) — OR restore from the fresh `pg_dump` into a clean volume. In-place restart + `REINDEX DATABASE app` + `ALTER DATABASE app REFRESH COLLATION VERSION` is fast and keeps downtime brief; 045's Docker test should explicitly prove switching a populated `postgres:17-alpine` volume (with indexed UTF-8 text rows + `logins: separate`) to `pgvector/pgvector:0.8.7-pg17-trixie`, creating `vector`, and verifying both text indexes and vector queries.

## R5. Lifecycle: snapshots, restores, restore drills, and moves

- **Snapshots (`pg_dump -Fc`):** dumps run as superuser `app` and automatically emit `CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;` along with vector columns and HNSW/IVFFlat index definitions.
- **Restores, rollbacks, and restore drills:** already run as superuser `app` (ADR 0037 D5). The drill container and restore path must use the service's resolved image (`pgvector/pgvector` when `extensions` includes `vector`) rather than hardcoding `IMAGES.postgres.ref`, otherwise `pg_restore` fails with `extension "vector" is not available`.
- **Moves (`retarget` / `move`):** the destination database container renders from the same plan (`extensions: [vector]`), so it starts with the `pgvector/pgvector` image; the move's one-off load step runs as superuser `app`, creating the extension cleanly during `pg_restore` (or before restore via the setup step).
- **Pin carryover (`pins-carry`):** when a plan switches from `postgres:17-alpine` to `pgvector/pgvector:0.8.7-pg17-trixie`, existing pin carryover logic must carry pins only when the image repository matches (not keep `postgres:17-alpine` over `pgvector/pgvector`).

## R6. Core lead decisions (2026-11-25, issue `#28`)

All three recommendations were approved by the core's lead (`softzer0`) on 2026-11-25:

1. **Plan field:** `service.options.extensions: string[]`, beside 047's `service.options.logins` (approved as an optional, additive field in `packages/plan-schema`).
2. **Supported list:**
   - **Step 1:** `vector` (switches the pinned image to `pgvector/pgvector` by digest) plus standard PostgreSQL `contrib` extensions needing no `shared_preload_libraries` (`pgcrypto`, `uuid-ossp`, `pg_trgm`, `citext`, `hstore`, `unaccent`, `fuzzystrmatch`, `btree_gin`, `btree_gist`, `ltree`, `intarray`, `cube`, `earthdistance`, `tablefunc`, `isn`, `lo`, `bloom`), staying on `postgres:*-alpine`.
   - **Step 2 (founder & core lead update, 2026-11-25):** PostGIS (`postgis`, `postgis_topology`, `postgis_raster`, `postgis_sfcgal`) on the pinned official `postgis/postgis:*-3.7-alpine` image (`amd64` only; design offers only `amd64` servers and refuses `arm64` with a plain message; `spatial_ref_sys` and `topology` schema follow 047's load rules; GPL image pulled on user's server is fine). Combining `vector` and `postgis` in one service, or naming any unknown extension, is refused before anything changes with the supported list.
3. **Switching an existing database's image (musl -> glibc):** a snapshot first, the image switch approved by its hash, then `REINDEX DATABASE` and `ALTER DATABASE ... REFRESH COLLATION VERSION` in the setup step. The plan states plainly that it restarts the database and that reindexing can take a while on a large database. Proven in the `OPSCREW_DOCKER_TESTS=1` Docker test starting from a populated `postgres:17-alpine` volume with a text index.
4. **Privileges:** `vector` is untrusted, so `CREATE EXTENSION IF NOT EXISTS` runs inside 047's superuser setup step before migrations, requiring no extra privileges on `app_owner` or `app_runtime`.


---

## R7 — PR #30 real-Docker findings and 0.2.12 decisions (core lead, 2026-11-26)

Running `OPSCREW_DOCKER_TESTS=1` on PR #30 surfaced two PostgreSQL realities and one security constraint:

1. **Alpine (musl) → Debian (glibc) `REFRESH COLLATION VERSION` fails from NULL:** `postgres:17-alpine` stores `pg_database.datcollversion` as `NULL` (musl has no collation versions), and PostgreSQL refuses `ALTER DATABASE app REFRESH COLLATION VERSION` from `NULL` with `ERROR: invalid collation version change`.
2. **Superuser `CREATE EXTENSION` on an existing `logins: separate` database:** once `loginsSetup` has transferred `public` to `app_owner`, running third-party extension DDL as superuser inside an `app_owner`-controlled schema carries the privilege-escalation risk ADR 0037 closes.
3. **Extension-created schemas (`deptype = 'n'`):** PostGIS's `topology` schema is recorded in `pg_depend` as a normal (`'n'`) dependency on the extension rather than a member (`'e'`), so 047's `OWNERS` query moved `topology` to `app_owner`. Fixed in `postgres-logins.ts` by excluding any non-`public` schema that depends on `pg_extension`.

**Decisions for `0.2.12`:**
- Extensions are set up **at database creation only** (`CREATE EXTENSION` runs as superuser before `loginsSetup` moves ownership to `app_owner`, with no in-place image switch and no `REINDEX`/`REFRESH COLLATION VERSION`).
- `provision` records each PostgreSQL service's extensions in `generated_values.json` next to `dbPassword` and refuses adding or removing extensions on any database that already has data (`neverRan`), before anything changes. Rebuilding an existing database via snapshot into a fresh volume is tracked as a post-`0.2.12` task (`T4508`).
- `postgis_topology` is removed from `0.2.12` (`postgis`, `postgis_raster`, `postgis_sfcgal` remain) until safe runtime grants for `topology.CreateTopology()` are designed (`T4509`).
- Dependabot locks `pgvector/pgvector` / `postgis/postgis` major versions only when a plan uses those images, keeping every other project's `.github/dependabot.yml` unchanged.
