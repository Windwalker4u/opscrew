# Feature Specification: A connection pooler for an app's PostgreSQL

**Feature Branch**: `050-postgres-pooler`

**Created**: 2026-11-26

**Status**: Draft (in 0.2.12, the founder's decision of 2026-11-26; the design is the lead's)

**Input**: `specs/roadmap.md`, 050. A profile of a deployed PHP app (2026-11-26) found every
signed-in request opening a new PostgreSQL connection: on a small VPS a fresh backend cost about
160 ms per page, against about 26 ms on a kept connection. PHP opens a connection per request;
most other runtimes keep a pool inside the app.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A PHP app gets kept connections without a code change (Priority: P1)

A user's Laravel app on a server uses PostgreSQL with separate logins. They add
`pooler: pgbouncer` under the database's options (design writes it for new PHP apps) and run
`npx opscrew provision`. The deploy starts a small PgBouncer next to the database, in transaction
mode. The app's web, worker and cron processes reach the database through it; the release command
(migrations) still connects to PostgreSQL directly. Pages that query the database get faster
because PgBouncer keeps the database's backends warm between requests.

**Why this priority**: it is the feature.

**Independent Test**: with Docker, a PHP container using PDO's native prepared statements runs a
few thousand requests' worth of queries through the rendered PgBouncer in transaction mode: every
query succeeds, PostgreSQL shows only a handful of backends for the runtime login, and the
migration connection goes straight to PostgreSQL.

**Acceptance Scenarios**:

1. **Given** a plan with `logins: separate` and `pooler: pgbouncer`, **When** provision renders the
   deploy files, **Then** the Compose project has a `<db>-pooler` service (pinned image, no
   published port, a memory limit, a health check), the app's database variables name
   `<db>-pooler:6432`, and the release's env (`release.db.env`) still names `<db>:5432`.
2. **Given** no `pooler`, **When** provision renders, **Then** every file is byte for byte as
   before.
3. **Given** `pooler: pgbouncer` without `logins: separate` (or on PostgreSQL below 15), **When**
   provision runs, **Then** it is refused before any change, saying to add `logins: separate`
   first, since migrations must not go through a transaction-mode pooler.
4. **Given** PDO with native prepared statements, **When** the app queries through the pooler,
   **Then** they work (PgBouncer 1.21+ with `max_prepared_statements`).

### User Story 2 - Rotation and every other flow keep working (Priority: P1)

**Acceptance Scenarios**:

1. **Given** the pooler, **When** the user rotates the runtime login's password
   (`opscrew rotate db`), **Then** the pooler gets the new password before the app uses it and the
   app keeps answering.
2. **Given** the pooler, **When** a snapshot, a restore, a restore drill or a move runs, **Then**
   it works as before: the pooler holds no data and connects to the database it sits beside.
3. **Given** a shared server with two apps, **When** one has the pooler, **Then** the other is
   unchanged.

### User Story 3 - Design suggests it where it helps (Priority: P2)

**Acceptance Scenarios**:

1. **Given** a new PHP app with PostgreSQL 15 or later, **When** design writes the plan, **Then**
   it has `pooler: pgbouncer`, and design's summary says why.
2. **Given** an existing PHP app's plan with PostgreSQL and no `pooler`, **When** provision runs,
   **Then** it prints one line on how to add it, and changes nothing because of it.
3. **Given** an app in another language, **When** design runs, **Then** no pooler is written; the
   user can add it.

### Edge Cases

- **Session features in the app:** transaction mode breaks session `SET`, `LISTEN`, session
  advisory locks, `WITH HOLD` cursors, SQL-level `PREPARE` and session temp tables. The guide says
  so, and that such an app should leave the pooler off.
- **The release command** never goes through the pooler.
- **A split plan** (the database on another server): the pooler runs on the database's server.
- **A Portainer stack** gets the same service: the pooler's settings are written by its own start
  command, so no config file has to be mounted.
- **Hosting accounts and serverless targets** have no PostgreSQL service, so no pooler.

## Requirements *(mandatory)*

- **FR-5001**: A PostgreSQL service MUST accept `options.pooler: "pgbouncer"`, valid only with
  `logins: separate` (so PostgreSQL 15 or later).
- **FR-5002**: With it, the rendered Compose project MUST have a `<db>-pooler` service: the pinned
  image, no published port (on a split plan, only on the database server's private address, as the
  database itself), on the database's server and network, a memory limit, a health check,
  restart like the database's, and settings written by its start command from its environment.
- **FR-5003**: The pooler MUST run in transaction mode, authenticate the runtime login with SCRAM
  against a password it reads from its environment (never a file in the repository), log in to
  PostgreSQL as that login, keep `max_prepared_statements` above zero and ignore
  `extra_float_digits`.
- **FR-5004**: The app's web, worker and cron processes MUST reach the database at
  `<db>-pooler:6432` (every variable name the alias rule fills), and the release command MUST keep
  the direct address with the owner's login.
- **FR-5005**: A rotation of the runtime login's password MUST give the pooler the new password
  before the app uses it.
- **FR-5006**: Without `pooler`, every rendered file MUST stay byte for byte as before.
- **FR-5007**: Design MUST write `pooler: pgbouncer` for new PHP apps with PostgreSQL 15 or later;
  provision MUST print a one-line suggestion for existing PHP plans without it.
- **FR-5008**: The guide MUST say what the pooler does, when to leave it off (session features),
  that migrations bypass it, and its memory.
- **FR-5009**: No password appears in logs, plans, audit entries, the repository or process
  arguments.

## Success Criteria *(mandatory)*

- **SC-5001**: On the localhost target, a PHP app's signed-in page with the pooler opens no new
  PostgreSQL backend per request (PostgreSQL's backend count for the runtime login stays flat over
  100 requests).
- **SC-5002**: A real PDO app runs through the pooler with native prepared statements.
- **SC-5003**: Existing plans without `pooler` render byte for byte as before.

## Assumptions

- PgBouncer 1.26.1 from CloudNativePG's image (`ghcr.io/cloudnative-pg/pgbouncer`), pinned by
  digest: the PgBouncer project publishes no image, Bitnami's is no longer free, and this one is
  built by a CNCF project for amd64 and arm64 with attestations (research 1, and the lead's check of
  its manifest on 2026-11-26).
