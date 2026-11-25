# ADR 0037: Two PostgreSQL logins, and the app never runs as the superuser

**Status**: Accepted (2026-11-25, feature 047). The founder put it in 0.2.12 the same day, at the
dashboard's lead's request. The core's lead decided its design after reviewing an outside
contribution. Details: `specs/047-postgres-logins/` (research R1–R13, plan).

## Context

The catalog's PostgreSQL starts the official image with `POSTGRES_USER=app`, which makes `app` its
bootstrap superuser. The app, its workers, cron and its release command all log in as `app`. A bug
or an injection in the app therefore has every right on the database server:

- creating roles;
- reading password hashes;
- changing the schema;
- running programs in the container through `COPY … FROM PROGRAM`.

Row-level security, which the dashboard's own app needs, doesn't apply to a superuser even when a
table forces it.

An outside contribution (reviewed at `69b2c105` on 2026-11-25) built separate logins behind a plan
object. Its PostgreSQL design reviewed as sound, but:

- its health check made every password rotation restart the database (the review's finding 12);
- it put a password in `env`'s arguments (finding 14);
- it refused moves;
- it came bundled with MySQL, Redis, recipients and private ingress.

## Decision

- **D1. Two fixed logins per app database:**
  - **Their names:** `app_owner` and `app_runtime`.
  - **Their attributes:** both `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
    NOBYPASSRLS`, with no role memberships.
  - **`app_owner`:** owns the database, its schemas and everything the migrations create. Only
    the release command uses it, through its own env file `release.db.env`.
  - **`app_runtime`:** the web, the workers, cron and a preview's seed use it through `app.env`.
    It gets `SELECT, INSERT, UPDATE, DELETE` on tables and `USAGE, SELECT` on sequences, now and,
    through `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner`, for everything the owner creates
    later.
  - **`PUBLIC`:** loses its rights on the schemas and `TEMPORARY` on the database. `CONNECT`
    stays, since without schema rights a login reads nothing, and the devices' and monitoring
    logins need it.
  - **The superuser:** keeps its name `app` and stays with OpsCrew's administration: setup,
    snapshots, restores, moves' loads and rotation. No app container gets its password, and only
    the release gets the owner's.
- **D2. The default for PostgreSQL 15 and later.**
  - **How:** design writes `options.logins: separate` on every new PostgreSQL 15 or later.
  - **Older versions:** they keep today's single login, with a plain note that separate logins
    come with an upgrade. The setup binds passwords with psql's `\getenv`, which needs 15, and
    refusing would break apps that pin an older version.
  - **Upgrades:** without the field, every generated file stays byte for byte as before, so
    upgrading OpsCrew alone never recreates a database or changes its data.
  - **No switch-off:** removing the field is refused.
- **D3. The logins are made in the catalog's one-time setup step,** which the deploy runs in the
  database's container (on Portainer, in the stack's init container) before the release. It is
  one transaction, and a failure stops the deploy with the running version on its current login.
  The passwords reach it in the container's env, read only when a role is created.
- **D4. A guided switch for an existing database:**
  - **How it starts:** the user adds `logins: separate`, and provision shows the switch in its
    plan, approved by hash: a snapshot first, one database restart (the env gains the two
    passwords), then the deploy's setup step.
  - **The setup step:** it makes the logins and moves ownership from `app` to `app_owner` object
    by object, since `REASSIGN OWNED` can't take objects from a bootstrap superuser.
  - **A failure:** it changes nothing.
- **D5. Loads run as the superuser and keep the dump's owners.**
  - **Which loads:** every restore, rollback, drill and move.
  - **How:** create `app` owned by `app_owner`, run `pg_restore` without `--no-owner`, then
    reapply the database-level grants, which a dump without `--create` doesn't carry.
  - **Why the superuser:** a snapshot is OpsCrew's own dump, loaded as the superuser today, and a
    load as the owner fails on objects only a superuser can own (extensions).
  - **The drill** uses placeholder passwords.
  - **Moves** work with both logins.
- **D6. Rotation restarts nothing.**
  - **Each password** rotates as a `swap` over the container's socket (`ALTER ROLE … PASSWORD`
    bound with `\getenv`, with statement logging off).
  - **Why no restart:** the health check stays `pg_isready`, so no script in the container reads
    a password, and the container is never recreated for a rotation.
  - **Arguments:** no command puts a password in an argument.

## Alternatives

- **A plan setting for names, a third login or a switch-off:** rejected. Fixed names are enough,
  default privileges remove the need for a grants file, and a switch-off would only hand the
  superuser back to the app.
- **The contribution's `access` object** (names, `operator`, `connection: split | url`, a grants
  file pinned by hash, a marker in `PGDATA`, a staged restore with a rename swap): rejected for
  the same reasons. Its staged restore needed PostgreSQL 17, and its health check logged in with
  each role's password from the env, so every rotation restarted the database.
- **A password file the rotation rewrites**, which the lead first asked for: unneeded, since
  nothing in the container reads a password after D6.
- **Calling the superuser `postgres` on new databases:** rejected. Two names would need the plan to
  record which one a database has, and an existing database can't rename its bootstrap superuser
  from its own session.
- **MySQL and Redis in the same change:** left out. No app that needs 047 uses them. They are
  their own features if users ask, with their own ADR.

## Consequences

- A compromised app can read and write the app's data, but can't change the schema, create roles,
  bypass row-level security, or reach the server through the database.
- **Runtime DDL now fails:** a library that changes the schema at runtime (pg-boss) needs its
  schema created by a migration and `CREATE` on it granted to `app_runtime`, which the guide
  shows. Anything beyond data rights is granted by the app's own migrations, which run as the
  owner.
- An existing database pays one restart of a few seconds when it switches, and keeps working
  unchanged until then.
- Every load of a dump depends on the roles existing. The setup step makes them wherever the
  database's container runs. A move's one-off containers refuse with a plain message without them.
