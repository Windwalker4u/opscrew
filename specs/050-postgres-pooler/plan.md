# Implementation Plan: A connection pooler for an app's PostgreSQL

**Branch**: `050-postgres-pooler` | **Date**: 2026-11-26 | **Spec**: [spec.md](spec.md)
**Input**: [research.md](research.md) (official sources: pgbouncer.org, its changelog, php.net).

## Summary

An opt-in `pooler: pgbouncer` on a PostgreSQL service with `logins: separate` adds one stateless
Compose service, `<db>-pooler`, beside the database. It runs PgBouncer 1.26.1 in session mode (research 9).
The app's runtime processes reach the database through it; the release command keeps its direct
address (047's `release.db.env`), so migrations, which may use session features, never go through
it. Design writes it for new PHP apps. Nothing changes for plans without it.

## Technical Context

TypeScript strict ESM, as in every package. Touches `@opscrew/plan-schema` (one option, the lead
approves: it is shared), `@opscrew/iac-templates` (the catalog, the runtime and the rotation),
`@opscrew/agents` (design, provision's notice, server-fit, status) and the guide. No new
dependency. Tests: Vitest with fakes, and one Docker test gated by `OPSCREW_DOCKER_TESTS=1`.

## Constitution Check

| Principle | How |
|---|---|
| I. Safety gate | No new mutation path: the pooler is one more rendered service, deployed by the existing deploy and its approvals. |
| IV. Secrets | The runtime password reaches the pooler through its env file (0600, as every service's), never the repository, a command line or a log. The start command writes `userlist.txt` inside the container from the environment. |
| V. Validation | The option is a zod literal; the refusal without `logins` happens in the plan's validation, before any change. |
| VII. Test first | Each task's tests come first; the Docker test proves PDO's native prepares through it. |
| X. Simplicity | One service, no config files mounted, no new approval, no pooler for other databases. |

## Design

### 1. The plan's field (`plan-schema`)

`options.pooler: z.literal("pgbouncer").optional()` on the `postgres` entry. A refinement refuses it
without `logins: separate`, with the message: "`pooler: pgbouncer` needs `logins: separate` under
the same options: migrations must reach PostgreSQL directly, and only separate logins give the
release its own address." `postgresPooler(service)` says whether a service has it.

### 2. The service (`iac-templates` catalog and runtime)

- **Name and place:** `<db>-pooler`, on the database's server and Compose network, `restart` as the
  database's, `depends_on` the database being healthy, no published port.
- **Image:** `IMAGES.pgbouncer`, `ghcr.io/cloudnative-pg/pgbouncer:1.26.1@sha256:9f648625e11f67f5171f1edd31648c7d02a1a4a5e1b8adf7d4a9db30dce8c22b`
  (amd64 and arm64, read with `docker buildx imagetools inspect` on 2026-11-26).
- **Its start command** (`entrypoint: ["/bin/sh", "-c", …]`) writes `/tmp/pgbouncer.ini` and
  `/tmp/userlist.txt` (mode 0600) from its environment, then `exec pgbouncer /tmp/pgbouncer.ini`.
  No file is mounted, so a Portainer stack works the same way. The settings:
  - `[databases] app = host=<db> port=5432 dbname=app`;
  - `pool_mode = session`, `listen_addr = 0.0.0.0`, `listen_port = 6432`;
  - `auth_type = scram-sha-256`, `auth_file = /tmp/userlist.txt` with the runtime login and its
    password in plain text (research 3: PgBouncer then does SCRAM with the client and with the
    server; pass-through is avoided);
  - `default_pool_size = 20`, `max_client_conn = 100`, `server_reset_query = DISCARD ALL`,
    `ignore_startup_parameters = extra_float_digits`;
  - `admin_users` empty, `stats_users` the runtime login (for `SHOW` checks only).
- **Its environment:** the runtime login's name and password, from the database's generated
  values, in the pooler's own env file, written like every service's.
- **Health check:** a TCP connect to 6432 from inside the container. The implementer checks what
  the image has (`pg_isready`, `bash`'s `/dev/tcp`, or another tool) and uses the simplest that
  works; it must not need a password.
- **Memory:** `mem_limit` 32 MB, measured in the Docker test, and counted by design and server-fit.
- **The app's variables:** every name the alias rule fills for this database (the URL names and the
  split `DB_*` parts) uses host `<db>-pooler` and port 6432 for the web process and cron. Workers read
  a small env file after `app.env` with the direct address and the runtime login, written and rotated
  like `release.db.env`, which keeps `<db>:5432`, host and port included, with the owner's login.

### 3. Rotation

The runtime password's rotation (047's `swap` for `runtime-password`) also recreates `<db>-pooler`
after the new password is set in PostgreSQL and written to the env files, and before the app's
processes restart. The window is a few seconds, the same as today's app restart. Rotating the owner's
or the superuser's password doesn't touch the pooler.

### 4. Agents

- **Design:** for a PHP app (detect's framework language) with PostgreSQL 15 or later it writes
  `pooler: pgbouncer` next to `logins: separate`, and its summary says one line on why.
- **Provision:** a deployed PHP plan with PostgreSQL and `logins` but no `pooler` gets one line:
  "Your PHP app opens a new database connection on every request. Add `pooler: pgbouncer` under
  db's options in opscrew/plan.yaml to keep them open." Nothing changes because of it.
- **Server-fit and status:** count the pooler's 32 MB; `status` lists it like any service.

### 5. Everything else

Snapshots, restores, drills and moves need no change: the pooler holds no data. The drill's copy
and a move render the same service. The guide's `databases.md` gets a section.

## Complexity Tracking

None.
