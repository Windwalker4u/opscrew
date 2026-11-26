# Research: An app's PostgreSQL never runs as the superuser

**Feature**: 047 | **Date**: 2026-11-25 | **Sources**: the PostgreSQL 16 and 17 manuals
(postgresql.org/docs: `CREATE ROLE`, `ALTER DEFAULT PRIVILEGES`, `GRANT`, `REASSIGN OWNED`,
`pg_dump`, `pg_restore`, psql's `\getenv`), the official `postgres` image's documentation
(hub.docker.com/_/postgres), pg-boss's constructor documentation (github.com/timgit/pg-boss,
`docs/api/constructor.md`), and the review of the outside contribution at `69b2c105`
(2026-11-25, findings 11, 12 and 14).

## What OpsCrew does today

- **The catalog's PostgreSQL** (`iac-templates/src/catalog/entries.ts`, `POSTGRES`) starts the image
  with `POSTGRES_USER=app`, `POSTGRES_DB=app` and `POSTGRES_PASSWORD` from the service's secret
  `password`. The image makes `app` its bootstrap superuser, and the app logs in as it:
  `DATABASE_URL=postgresql://app:<password>@db:5432/app`, and the split `DB_*` settings with user
  `app`.
- **The release, the workers, cron and a preview's seed** all read `app.env`
  (`runtime/index.ts`, `environment()`), so they log in as the superuser too.
- **The health check** is `pg_isready`, which needs no password. **Rotation** of `password` is a
  `swap` run inside the container over its socket (the image trusts local socket logins), with
  `recreate: false`.
- **Snapshots** (`workflow/snapshots.ts`, `DATABASES.postgres`) dump as `app` and restore with
  `CREATE DATABASE app OWNER app` and `pg_restore --no-owner`. The moves do the same in three
  places: `agents/src/retarget/server-ops.ts`, `retarget/sides/postgres.ts` and
  `move/window.ts`.

## Decisions

### R1 The two logins, and the superuser keeps its name

- **Decision:** every database gets `app_owner` and `app_runtime`, both `LOGIN NOSUPERUSER
  NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, with no role memberships.
  `app_owner` owns the database `app`, its schema `public` and everything the migrations create.
  `app_runtime` gets data rights only (R5). The bootstrap superuser stays `app`, also for new
  databases, and only database administration uses it: the snapshots, the restores, the moves'
  loads, the rotation and the setup step.
- **Why the superuser stays `app`:** the database container's settings then never change on an
  upgrade (the lead's decision 3, the review's finding 11). A database created before 047 can't
  rename its bootstrap superuser from its own session, and keeping two names would need the plan to
  say which one a database has. A new database with the superuser called `postgres` would buy only
  a nicer name.
- **Fixed names, no plan setting:** the contribution's names, its third `operator` login and its
  `connection: split | url` choice are left out. OpsCrew already derives the split settings from
  what the app reads.

### R2 How the plan records it: `options.logins: separate`

- **Decision:** a PostgreSQL service gains the optional `options.logins`, whose only value is
  `separate`.
  - **Design** writes it on every PostgreSQL 15 or later it puts in a plan (`design/sizing.ts`
    and the catalog's choices), so every new database has it without the user setting anything.
    An older version keeps today's single login, and design and provision say that separate
    logins come with an upgrade to 15 or later (R8). Nothing refuses an app that pins an older
    version.
  - **Absent** means a database created before 047: the app keeps logging in as `app`, and nothing
    in its generated files changes.
  - **Provision** says on each run, for an environment without it, how to switch (R11).
- **Why a field:** the generated files must follow from the plan alone, and an upgrade must leave an
  existing database's files byte for byte as they were. A probe of the server can't decide what
  a file holds.
- **No switch-off:** the only value is `separate`. Removing it from a database that has it is
  refused by provision: going back would hand the superuser to the app again, and nothing needs
  that.

### R3 Where the roles are made: the catalog's one-time setup step

- **Decision:** the `POSTGRES` entry gains an `init` step (`ServiceInitStep`, as MongoDB's replica
  set), with `logins: separate` only.
  - **Where it runs:** the deploy runs it in the database's container after the services start and
    before the snapshot and the release command (`switch.ts`, `serviceInit`). On Portainer, the
    stack's `<service>-init` container runs it, and the release waits for it.
  - **The check:** one query as the superuser over the socket. It passes when both roles exist with
    R1's attributes and no memberships, `app_owner` owns the database and `public`, no object in the
    app's schemas is owned by the superuser, and R5's grants and default privileges are in place.
    Then the step is skipped, so a normal deploy costs one query.
  - **The run:** one `psql -1 -v ON_ERROR_STOP=1` transaction (R4 to R6). A failure undoes all of
    it. The deploy then stops before the release, and the running version keeps serving on its
    current login (`initFailed`'s message).
- **The passwords:** the database's env gains `OPSCREW_OWNER_PASSWORD` and
  `OPSCREW_RUNTIME_PASSWORD`. Like `POSTGRES_PASSWORD`, they are read only when a role is created:
  the step never resets an existing role's password, so a rotation stays the only thing that changes
  it. They are bound in psql with `\getenv`, never in an argument (finding 14).
- **The cost:** setting `logins: separate` on an existing database adds two values to its env, so
  the switch's deploy recreates the database container once (a few seconds), which the switch's
  plan says. An upgrade alone changes nothing (R2).

### R4 Moving ownership in an existing database

- `REASSIGN OWNED BY app TO app_owner` fails when `app` is the bootstrap superuser: it owns the
  system catalogs, which can't be reassigned (the manual, `REASSIGN OWNED`). So the step changes
  each owner one by one, in a `DO` block over the database `app`:
  - the database, then each schema other than `pg_catalog`, `information_schema`, `pg_toast*` and
    `pg_temp*` that `app` owns;
  - in them, the tables, partitioned tables, views, materialized views, standalone sequences
    (a sequence owned by a column moves with its table, and `ALTER SEQUENCE … OWNER` on it
    fails), functions, procedures, aggregates, types and domains (not a table's row type, nor an
    array type), collations, statistics objects, text search configurations and dictionaries,
    operators, operator classes and operator families that `app` owns.
  - **A range's multirange:** PostgreSQL 17 moves it with its range and refuses `ALTER TYPE` on
    it alone; 16 (16.10) moves only the range, so there the multirange gets its own statement.
- **Extensions** stay the superuser's, with every object of theirs and their own schemas
  (PostGIS's `topology`): only a superuser can own most of them, and their functions keep
  `EXECUTE` for `PUBLIC`.
- **Event triggers:** the setup refuses a database that has them, before anything changes. An
  event trigger's function runs as whoever changes the database, and the switch gives
  `app_owner` the functions the superuser made, so the superuser's setup would run code the
  owner may change.
- **Large objects** owned by `app` move too (`pg_largeobject_metadata`).

### R5 The runtime login's rights, now and for later migrations

The lead's list, which a real Laravel app on 047 needs:

- **On what exists**, in every schema `app_owner` owns: `SELECT, INSERT, UPDATE, DELETE` on all
  tables, `USAGE, SELECT` on all sequences, `USAGE` on the schema and `SELECT, UPDATE` on large
  objects. They are given once, while `app_owner` has no default privileges yet (a new database,
  the switch, or the load of a dump from before it), so a migration that narrows them stays
  narrowed (the lead, 2026-11-25).
- **On what the migrations create later:**
  - `ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO
    app_runtime`;
  - the same `GRANT USAGE, SELECT ON SEQUENCES`;
  - the same `GRANT USAGE ON SCHEMAS`.

  They are global (no `IN SCHEMA`), so a schema a migration adds later is covered too. Default
  privileges apply only to objects that role creates (the manual), which is why the release must
  log in as `app_owner` (R9).
- **Both kinds of id:** a `serial` or `DEFAULT nextval(…)` column calls `nextval` with the
  inserting user's rights, so it needs `USAGE` on the sequence. An `IDENTITY` column's sequence is
  the table's. The Docker tests insert into both, on a table a migration created after the first
  grant.
- **No `TRUNCATE`, `REFERENCES` or `TRIGGER`,** and no DDL: Laravel's cache, session, jobs and
  failed-jobs tables are written with `INSERT`, `UPDATE` and `DELETE`, and its seed command only
  inserts. An app that needs more grants it in a migration, which runs as the owner (the guide).

### R6 What `PUBLIC` loses

- **The schemas:** `REVOKE ALL ON SCHEMA public FROM PUBLIC`, then `USAGE` for `app_runtime` (R5).
  A schema the owner creates later gives `PUBLIC` nothing by default. So a login OpsCrew didn't
  grant sees no table.
- **The database:** `REVOKE TEMPORARY ON DATABASE app FROM PUBLIC`. `app_owner` owns `app` and keeps
  every right on it. `CONNECT` stays with `PUBLIC`, unlike in the contribution, which revoked it:
  - the devices' logins (018, `connectors/ssh-host/src/grant.ts`: `pg_read_all_data`,
    `pg_write_all_data`) and the monitoring login `opscrew_monitor` (020, `pg_monitor`) connect
    through it;
  - revoking it would need each of them granted again in the setup step, and in their own host
    plans;
  - a login that may connect but has no schema `USAGE` reads none of the app's data.
- **Left as they are:** functions' `EXECUTE` and types' `USAGE` for `PUBLIC`. They grant nothing a
  data login can misuse, and revoking them breaks extensions' functions. That is smaller than the
  contribution, which revoked them.
- **Temporary tables:** the runtime login gets no `TEMPORARY`. The guide says how to grant it.

### R7 Rotation without a restart

- **Decision:** `owner-password` and `runtime-password` rotate as `swap` with `recreate: false`, as
  `password` does today. `begin` runs `ALTER ROLE … PASSWORD :'pw'` as the superuser over the
  socket, with `\getenv pw OPSCREW_NEW` and `SET LOCAL log_statement = 'none'` in one transaction,
  so the value is neither in an argument nor in the server's log.
- **The lead's decision 5** asked that the health and start scripts read the current password from
  a file the rotation rewrites. With R3 none of them needs one: the health check is `pg_isready`, the
  start is the image's, and the setup step logs in over the socket. So the container is never
  recreated for a rotation, and no password file is added. The review's finding 12 came from the
  contribution's health check, which logged in as each role with the env's passwords.
- **The downtime** is the `swap`'s, the same as today: connections the old app opens between
  `begin` and its switch fail; open ones stay. The rotation's plan says `seconds: 1` for each.
- **The release env file** (R9) holds the owner's password, so a rotation of `owner-password`
  rewrites it as well as the database's env.

### R8 No password in an argument

- Every new command binds passwords with psql's `\getenv` (psql 15 and later) or passes them in the
  child's environment with the assignment before `env` (`PGPASSWORD="…" env -i …` is never used: it
  puts the assignment in `env`'s argv, finding 14). `docker compose exec -e NAME` passes the name
  only.
- **Versions:** the catalog pins PostgreSQL 17, and the tests run 16 and 17. psql's `\getenv`
  needs 15, so design writes `logins: separate` only for 15 and later (the lead, 2026-11-25). A
  plan on 14 or older keeps today's single login and works as before. Design's summary and
  provision's notice say that separate logins come with an upgrade to 15 or later. A refusal would
  break apps that pin an older version. Only a hand-written `logins: separate` on an older version
  is refused, since its setup step could not run.

### R9 The variables: the release gets its own env file

- **The app's env** (`app.env`, read by the web, the workers, cron and a preview's seed) gets
  `app_runtime`: the same names as today (`DATABASE_URL`, the app's own detected variable, and the
  split `DB_*` names it reads), with the runtime login and its password. The superuser's password
  and the owner's are not in it.
- **The release's own env file** is `release.db.env`, read after `app.env` by the `release`
  service only (Compose's later `env_file` wins). It holds the same database variables with
  `app_owner`. It reaches the server as the deploy secret `OPSCREW_RELEASE_DB_ENV`, written
  owner-only like `app.env`. On Portainer the release's inline environment gets the same overrides.
- **No new variable name** is needed: migrations read the variables they already read. A
  `DATABASE_OWNER_URL` would make every framework's migration step need its own settings.
- **Destroy** deletes `OPSCREW_RELEASE_DB_ENV` with the other deploy secrets, and its by-hand list
  names it (the review's finding 6). The two new passwords are service secrets, which the redactor
  already registers (finding 7).

### R10 Snapshots, restores, the drill and moves

- **The dump** stays the superuser's `pg_dump -Fc app`. It carries the objects' owners, their
  grants and the `ALTER DEFAULT PRIVILEGES` lines, but not database-level grants, which `pg_dump`
  writes only with `--create` (the manual), nor roles, which are the cluster's.
- **The load**, with `logins: separate`, in every place that loads a dump:
  1. the roles exist. Where the load runs in the database's container, which has the two
     passwords in its env (a snapshot's restore, a rollback's, the drill's copy), it runs the setup
     step's run first, which makes any role that is missing. Where it runs in a one-off container
     (a move's sides), the new side's deploy has made them, and the load refuses with a plain
     message when they are missing.
  2. a dump with event triggers is refused (R4), from `pg_restore -l`'s list, before step 1 changes
     anything;
  3. `DROP DATABASE IF EXISTS app WITH (FORCE)` and `CREATE DATABASE app`, the superuser's until the
     extensions are made, so `app_owner` can't add anything to it before them;
  4. as the superuser, with `--no-owner`, the dump's schemas and extensions (and the extensions'
     comments): extensions need a superuser, and they may live in the app's schemas. Then the
     setup's moves give the database and the schemas to `app_owner`;
  5. as `app_owner`, logged in with its own password, everything else with `--no-owner` and
     `--single-transaction`, but the rights and the rows of the extensions' own tables. Every
     object is then `app_owner`'s, also from a dump made before the switch;
  6. as the superuser, the rows of the extensions' own tables (`pg_extension_config_dump`, such
     as PostGIS's `spatial_ref_sys`), whose constraints are the extension's, and the dump's
     rights (`ACL`, `DEFAULT ACL`), which run no code;
  7. the grants part of the setup (R5, R6: database-level grants and `PUBLIC`'s revokes, and the
     runtime login's rights when the dump came from before the switch), which needs no password.
- **Why the owner loads the app's objects:** a CHECK constraint, a domain or a trigger can call a
  function `app_owner` owns while the rows are restored. Run by the superuser, such a function can
  `ALTER ROLE app_owner SUPERUSER` (the outside review of 2026-11-25 showed it). Under the
  superuser's login, `pg_restore --role=app_owner` only sets the role, which the function can
  `RESET` (checked on 17), so `app_owner` logs in itself.
- **What still needs the superuser:** extensions, their tables' rows and the rights, as above.
  Operator classes and families need one too, so a dump with them can't load as `app_owner` and
  fails with PostgreSQL's own error.
- **Without `logins`,** every load is exactly as today.
- **The drill:** its copy's env gets placeholder passwords (`previewSecretFill`), as for
  `password` today, so the drill never holds a real login's password. Its check also runs the
  setup's check query.
- **Moves** now work with two logins, where the contribution refused them. The new side's deploy
  makes the roles before the move waits (`moveWaiting` runs after `serviceInit`), and its load
  follows the steps above.

### R11 The switch of an existing database

- **How it starts:** the user adds `logins: separate` (provision's notice gives the exact line),
  then runs `npx opscrew provision`. Provision sees the switch when this environment's
  generated values keep the
  database's `dbPassword` but no `owner-password` for it. They decide, not the plan at git's
  `HEAD`: only provision writes them, so a hand-committed `logins: separate` still gets the
  approval and the snapshot, and a hand-committed removal is still refused.
- **The plan,** shown before anything changes and approved by its hash with provision's own
  approval, says:
  - a snapshot of the database is taken first;
  - the database restarts once;
  - the next deploy makes the two logins and moves ownership in one transaction;
  - the app, workers and cron move to `app_runtime` at their switch, and the release logs in as
    `app_owner`;
  - a failure changes nothing, and the running version keeps its current login;
  - a database with event triggers is refused: remove them with DROP EVENT TRIGGER first.
- **The snapshot first:** provision takes it through the existing on-demand snapshot path before it
  writes the new secrets and files. When it fails, provision stops.
- **Until the switch,** the database works unchanged.

### R12 A library that makes its own schema at runtime (pg-boss)

- pg-boss's constructor has `schema` (the schema "that contains all required storage objects"),
  `createSchema` ("If set to false, the `CREATE SCHEMA` statement will not be issued during
  installation… useful if this privilege is not granted to the role") and `migrate` ("this instance
  will skip attempts to run schema migrations during `start()`", for when "the configured user
  account does not have schema mutation privileges"). Its documentation doesn't list the rights
  it needs at runtime. Creating a queue can create objects in its schema, so the runtime login
  needs `CREATE` there.
- **What the guide says:** create the schema in a migration, which runs as the owner, and give the
  runtime login rights on it:

  ```sql
  CREATE SCHEMA IF NOT EXISTS pgboss;
  GRANT USAGE, CREATE ON SCHEMA pgboss TO app_runtime;
  ```

  Then start pg-boss with `createSchema: false`. The tables pg-boss makes are then the runtime
  login's own. The same holds for any library that creates its own schema or tables when the app
  starts.
- **Left for the live pass:** checking it on a real pg-boss is not needed for 047's Accept. The
  guide gives the rule, not a tested recipe.

### R13 What is taken from the contribution, and what is not

- **Taken:** the role attributes and their check query (`rotate/scoped-postgres.ts`,
  `catalog/postgres-access.ts`), the `\getenv` binding and the `SET LOCAL log_statement`, the
  release-only owner env file (`release.db.env`), the drill's placeholder passwords, and the rule
  that the bootstrap password never reaches an app container.
- **Not taken:**
  - the plan's `access` object (names, `operator`, `connection`, the grants file pinned by hash),
    the `PGDATA` marker file and its start wrapper;
  - the health check that logs in as each role (finding 12);
  - the restore into a staged database with a rename swap (`workflow/scoped-postgres.ts`), and its
    PostgreSQL 17 columns;
  - the refusal of moves;
  - MySQL, Redis, the recipients, private ingress, the release-log hardening and every
    compatibility export (finding 11).
- **Why:** default privileges make a grants file unneeded for 047's Accept, and fixed names need no
  plan object.
