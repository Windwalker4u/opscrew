# Feature Specification: An app's PostgreSQL never runs as the superuser

**Feature Branch**: `047-postgres-logins`

**Created**: 2026-11-25

**Status**: Draft (ADR 0037; in 0.2.12, the founder's decision of 2026-11-25; the lead's decisions of
2026-11-25 on the two logins, the default, the switch, the variables, rotation, moves and tests)

**Input**: `specs/roadmap.md`, 047. Today the app connects as the image's `POSTGRES_USER`, a
superuser, so a bug or an injection in the app has every right, and row-level security doesn't
apply to it even when forced. Research: [research.md](research.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A new database with two logins (Priority: P1)

A user designs a new app on PostgreSQL and runs `npx opscrew provision`, then pushes. The plan
says `logins: separate`, without the user setting it. On the first deploy:

- the database gets `app_owner`, which owns the schema, and `app_runtime`, which can only read and
  write data;
- the release command (migrations) logs in as `app_owner`;
- the web, the workers and cron log in as `app_runtime`;
- the superuser `app` stays with OpsCrew's administration: snapshots, restores, moves and
  rotation.

Every table and sequence a later migration creates works for the runtime login at once.

**Why this priority**: it is the feature. Every new database is least-privilege by default.

**Independent Test**: In real PostgreSQL 16 and 17 containers, the setup step runs on a fresh
database:

- a migration as `app_owner` creates tables with an `IDENTITY` id and with a `serial` id;
- `app_runtime` inserts, reads, updates and deletes rows in both;
- `app_runtime` is refused `CREATE ROLE`, `CREATE TABLE`, `ALTER TABLE`, `CREATE TEMP TABLE` and
  reading `pg_authid`;
- `app_runtime` sees only the rows a forced row-level security policy allows.

The rendered files are checked by unit tests.

**Acceptance Scenarios**:

1. **Given** a new plan with PostgreSQL 15 or later, **When** design writes it, **Then** the
   service's options hold `logins: separate`. On an older version they don't, and design says that
   separate logins come with an upgrade.
2. **Given** that plan, **When** provision renders the files, **Then**:
   - `app.env` names `app_runtime` and its password;
   - `release.db.env` names `app_owner` with the same variable names;
   - neither holds the superuser's password, and `app.env` doesn't hold the owner's.
3. **Given** the first deploy, **When** the database is up, **Then** the setup step makes both
   logins before the release command runs, in one transaction.
4. **Given** a later migration that creates a table and a sequence, **When** the app runs, **Then**
   `app_runtime` can `SELECT`, `INSERT`, `UPDATE` and `DELETE` there, and use its sequences, with no
   grant written by the user.
5. **Given** the running app, **When** it tries DDL, creates a role, bypasses row-level security or
   reads a password hash, **Then** PostgreSQL refuses it.

---

### User Story 2 - Switching a database made before 047 (Priority: P1)

A user whose app was deployed before 047 upgrades OpsCrew. Nothing changes on the server, and each
`npx opscrew provision` says how to switch. The user adds `logins: separate` and runs provision.
It shows a plan, approved by its hash:

- a snapshot is taken first;
- the database restarts once;
- the next deploy makes the two logins and gives `app_owner` the app's schema, in one transaction;
- the app moves to `app_runtime` at its switch.

If anything fails, nothing changes, and the app keeps running on its old login.

**Why this priority**: existing apps need the same protection, without losing data or downtime
beyond a restart.

**Independent Test**: In real PostgreSQL 16 and 17 containers, a database made the pre-047 way
(superuser `app` owning tables, sequences, a view, a function and an enum) is switched:

- its data and its objects stay;
- the objects belong to `app_owner`;
- `app_runtime` reads and writes them;
- an injected failure leaves every owner, role and grant as before.

Unit tests check that an upgrade alone renders an existing plan's files byte for byte as before.

**Acceptance Scenarios**:

1. **Given** a deployed plan without `logins`, **When** OpsCrew is upgraded and provision runs,
   **Then**:
   - the database's container settings and every generated file are unchanged;
   - provision prints how to switch.
2. **Given** that plan with `logins: separate` added, **When** provision runs, **Then** it shows the
   switch's steps (snapshot, restart, logins, ownership, the app's new login) and asks for
   approval by hash before taking the snapshot.
3. **Given** the switch's deploy, **When** the setup step succeeds, **Then**:
   - the data is as before;
   - `app_owner` owns the database, its schemas and the app's objects;
   - the app's env has no superuser login.
4. **Given** the switch's deploy, **When** the setup step fails, **Then**:
   - the transaction leaves no new role, owner or grant;
   - the deploy stops before the release;
   - the running version keeps its old login and says how to go on.
5. **Given** a switched plan, **When** the user removes `logins`, **Then** provision refuses it and
   says why.

---

### User Story 3 - Rotation, restore, the drill and moves keep the two logins (Priority: P2)

A user rotates `owner-password` or `runtime-password` with `opscrew rotate db`. The database isn't
restarted. A snapshot's restore, a rollback's restore, the scheduled drill and a move each load the
data with the same owners and grants, so the runtime login works after them as before.

**Why this priority**: two logins as the default must not break any data path that exists.

**Independent Test**:

- **Rotation:** in a real PostgreSQL container, the rotation's command changes each login's
  password. The container's ID and start time don't change, the new password logs in and the old
  one doesn't.
- **Loads:** a dump is loaded in place and into a fresh container, as a restore, a drill or a move
  does. The owners, grants and default privileges hold, and a table a migration creates afterwards
  still works for `app_runtime`.
- **The rest:** unit tests with fakes check each command's text and order.

**Acceptance Scenarios**:

1. **Given** a database with two logins, **When** either password rotates, **Then**:
   - the rotation's plan says `recreate: false`;
   - the container keeps running;
   - `release.db.env` or `app.env` gets the new value.
2. **Given** a snapshot, **When** it is restored in place, by a rollback or by a drill, **Then**
   `app_owner` owns the objects again and `app_runtime` has its grants.
3. **Given** a drill, **When** its copy runs, **Then** it uses placeholder passwords, never the
   app's.
4. **Given** a move of an app with two logins, **When** its window loads the dump on the new side,
   **Then** the roles, owners and grants are there, and the move isn't refused.

### Edge Cases

- **An existing role called `app_owner` or `app_runtime`** that is a superuser or a member of
  another role: the setup step refuses with a plain message and changes nothing.
- **Extensions** the app created as the superuser stay the superuser's. Their functions keep
  working for both logins.
- **A library that makes its own schema at runtime** (pg-boss): the guide says to create the schema
  in a migration and give the runtime login `USAGE, CREATE` on it.
- **PostgreSQL below 15:** design doesn't write `logins`, so the database keeps today's single
  login. Design and provision say plainly that separate logins come with an upgrade to 15 or later.
  Nothing refuses the pinned version. Only a hand-written `logins: separate` on it is refused,
  since the setup step needs psql 15.
- **A database on an extra server** (ADR 0022): the setup step runs there, and the release reaches
  it as `app_owner`.
- **Two apps on one server** (ADR 0035): each has its own database container and logins. Nothing is
  shared.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-4701**: A PostgreSQL service MUST accept `options.logins: "separate"`, and nothing else
  there. Without it, every generated file MUST be exactly as before 047.
- **FR-4702**: Design MUST write `logins: separate` on every PostgreSQL 15 or later it puts in a
  plan. For an older version it MUST write nothing and say that separate logins come with an
  upgrade to 15 or later.
- **FR-4703**: With `logins: separate`:
  - the service MUST get the generated secrets `owner-password` and `runtime-password`;
  - its container's env MUST get them as `OPSCREW_OWNER_PASSWORD` and `OPSCREW_RUNTIME_PASSWORD`;
  - its setup step MUST make `app_owner` and `app_runtime` (`LOGIN NOSUPERUSER NOCREATEDB
    NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, no memberships) in one transaction, with
    data-model.md's grants, default privileges and revokes, and refuse a conflicting existing role.
  - **What `PUBLIC` loses** is every right on the app's schemas and objects, and `TEMPORARY` on the
    database. `CONNECT` stays with `PUBLIC` on purpose (the lead, 2026-11-25): with no schema or
    object rights a login connects but reads nothing, and the devices' logins (018) and the
    monitoring login (020) need `CONNECT`.
- **FR-4704**: The setup step MUST move to `app_owner` every object in the app's schemas that the
  superuser owns (research R4), the database and the schemas included, in the same transaction.
- **FR-4705**: `app.env` MUST give the web, the workers, cron and the seed the runtime login, under
  the variable names OpsCrew already derives. `release.db.env` MUST give the release command the
  owner's login under the same names. No app container may receive the superuser's password, and
  only the release may receive the owner's.
- **FR-4706**: Rotating `owner-password` or `runtime-password` MUST NOT recreate or restart the
  database container. Every command MUST bind passwords without putting them in a process's
  arguments.
- **FR-4707**: Every load of a dump (a snapshot's restore, a rollback's, the drill's, each move's)
  MUST, with `logins: separate`, keep the dump's owners and grants and reapply the database-level
  grants. Without `logins`, it MUST be as before.
- **FR-4708**: For a deployed environment, provision MUST:
  - without `logins`, say how to switch on every run, or for PostgreSQL below 15 that separate
    logins come with an upgrade to 15 or later;
  - when `logins: separate` is new, show the switch's steps in a plan approved by its hash, and
    take a snapshot of the database before it writes anything;
  - refuse removing `logins` from a plan that has it;
  - refuse a hand-written `logins: separate` on PostgreSQL below 15, and nothing else about an
    older version.
- **FR-4709**: Destroy MUST delete the deploy secret `OPSCREW_RELEASE_DB_ENV` and name it in its
  by-hand list.
- **FR-4710**: The guide MUST say:
  - which login does what;
  - that tables and sequences the owner creates are covered by default privileges;
  - how to grant anything else in a migration;
  - the pg-boss case;
  - how to switch an existing database.

### Key Entities

- **The logins**: `app` (the superuser, administration only), `app_owner` (the release, owns the
  schema), `app_runtime` (the web, workers, cron and seed). See [data-model.md](data-model.md).
- **The release env file**: `release.db.env`, from the deploy secret `OPSCREW_RELEASE_DB_ENV`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-4701**: In the Docker tests on PostgreSQL 16 and 17, every refusal and every right of User
  Story 1's Independent Test holds.
- **SC-4702**: An existing plan without `logins` renders the same files before and after 047, which
  the existing golden and snapshot tests show unchanged.
- **SC-4703**: The switch keeps every row, and an injected failure leaves `pg_roles`, the owners
  and the grants exactly as before (Docker test).
- **SC-4704**: A rotation of each new password leaves the database container's ID and start time
  unchanged (Docker test).
- **SC-4705**: The live pass on the localhost target deploys a throwaway app with a migration and
  a worker, switches an existing one, rotates both passwords and restores a snapshot, with the app
  answering after each step.

## Assumptions

- The superuser keeps the name `app`, so no database container's settings change on an upgrade
  (research R1).
- Hosting accounts (cPanel, Plesk, DirectAdmin, SFTP) don't run OpsCrew's PostgreSQL, so they are
  untouched.
- Grafana Alloy's PostgreSQL figures keep using the superuser, as today.
- There is no plan setting to name the logins, add a third login or switch the feature off.
