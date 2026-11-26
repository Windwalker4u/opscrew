# Research 050: PgBouncer (transaction mode) between an app and its PostgreSQL

Date: 2026-11-26. Sources are official only. "NOT VERIFIED" marks claims I could not confirm from an official page.

## 1. The image

- The PgBouncer project publishes no image. Its GitHub page (https://github.com/pgbouncer/pgbouncer) lists no Dockerfile, no container registry and no releases, and its docs never mention Docker.
- Latest PgBouncer release: 1.26.1 (2026-10-14); 1.26.0 (2026-09-23), 1.25.2 (2026-05-08). Source: https://www.pgbouncer.org/changelog.html
- Bitnami: https://hub.docker.com/r/bitnami/pgbouncer says the image "is no longer available for free through Docker Hub". It now ships only as a commercial Bitnami Secure Images subscription, and the page shows no tags pushed. So it is NOT freely available. The page does not mention the "bitnamilegacy" namespace, so I could not confirm that.
- Best provenance found, option A: `edoburu/pgbouncer` (https://hub.docker.com/r/edoburu/pgbouncer, tags at https://hub.docker.com/r/edoburu/pgbouncer/tags).
  - Newest tag `v1.26.1-p0`, which tracks 1.26.1 and was pushed about a month ago. Older tags: v1.25.2-p0, v1.25.1-p0, v1.24.1-p1 and so on.
  - All 1.2x tags are linux/amd64 and linux/arm64. The image is about 9.7 MB.
  - It is a community publisher, not the PgBouncer project.
  - Config is by env vars: `DATABASE_URL`, or `DB_USER`/`DB_PASSWORD`/`DB_HOST`/`DB_NAME`, plus `POOL_MODE`, `SERVER_RESET_QUERY`, `MAX_CLIENT_CONN`, `AUTH_USER`. Most other `pgbouncer.ini` settings also map to env vars, except port, syslog and pid settings. The generated `pgbouncer.ini` can be replaced by mounting your own at /etc/pgbouncer (the page points to the entrypoint script for details; I did not read it, so mounting is NOT VERIFIED).
- Option B: CloudNativePG's `pgbouncer-containers` (https://github.com/cloudnative-pg/pgbouncer-containers). Images are on GHCR, built on Debian stable-slim. The page does not state architectures, tags or how config is passed (NOT VERIFIED), and it is built for Kubernetes.
- Recommendation: pin `edoburu/pgbouncer:v1.26.1-p0` (digest-pin if possible). Whether we mount `pgbouncer.ini` and `userlist.txt` or use env vars, generate the files ourselves for full control. A mounted `pgbouncer.ini` with an `auth_file` is the most explicit option.

## 2. Prepared statements in transaction mode

- `max_prepared_statements`: added in PgBouncer 1.21.0 (2023-10-16, https://www.pgbouncer.org/changelog.html). It was off by default then, and users had to set it non-zero.
- Since 1.24.0 (2025-01-10) it defaults to 200 ("Enable prepared statement support by default, `max_prepared_statements` is now set to 200"). Source: changelog. https://www.pgbouncer.org/config.html confirms default 200 and that 0 disables it.
- It tracks protocol-level named prepared statements in transaction and statement pooling. The value is the size of an LRU cache on each server connection.
- SQL-level `PREPARE`/`EXECUTE`/`DEALLOCATE` are not tracked. They pass straight to PostgreSQL. `DEALLOCATE ALL` and `DISCARD ALL` clear PgBouncer's tracked statements for that client. Source: config.html. The feature table at https://www.pgbouncer.org/features.html lists "PREPARE / DEALLOCATE" as never working in transaction mode, and protocol-level prepared plans as supported once `max_prepared_statements` is non-zero.
- PDO pgsql: php.net says PDO emulates prepares only for drivers that lack them (https://www.php.net/manual/en/pdo.prepared-statements.php). The pgsql manual page (https://www.php.net/manual/en/ref.pdo-pgsql.php) documents `PDO::PGSQL_ATTR_DISABLE_PREPARES` (use `Pdo\Pgsql::ATTR_DISABLE_PREPARES` on PHP 8.4 or later; the old name is deprecated in 8.5). The manual does not describe whether pdo_pgsql prepares are named or unnamed, and does not state the `ATTR_EMULATE_PREPARES` default for pgsql. NOT VERIFIED from official docs: pdo_pgsql uses native protocol-level prepares by default with generated statement names. If so, PgBouncer 1.21 or later with `max_prepared_statements` > 0 (default since 1.24) works without `ATTR_EMULATE_PREPARES`. Check php-src `ext/pdo_pgsql/pgsql_statement.c` before the spec commits to this. Safe fallback: set `ATTR_EMULATE_PREPARES=true` or `ATTR_DISABLE_PREPARES=true`.

## 3. Authentication

- `auth_type` (config.html): `md5` is the default and uses SCRAM automatically for users whose secret is SCRAM. `scram-sha-256` requires the auth file to hold SCRAM secrets or plain-text passwords. Others: `plain`, `trust`, `any`, `cert`, `hba`, `ldap`, `pam`.
- `userlist.txt` (`auth_file`): each line is `"user" "<password-or-hash>"`. The second field can be plain text, `md5<hash>` (md5 of password+username) or `SCRAM-SHA-256$<iter>:<salt>$<storedkey>:<serverkey>`. Source: config.html.
- Simplest safe setup: use `auth_type = scram-sha-256` and put the same plain-text password in `userlist.txt`.
  - It works against a PostgreSQL SCRAM secret, because PgBouncer then does its own SCRAM with the client and with the server.
  - It is the most robust option: no pass-through conditions and no copy of the stored secret.
  - Plain-text passwords work "more broadly" than secrets for server login (config.html).
  - The file lives on our server in a restricted-mode file (0600, or a Docker/Compose secret), never in the repo.
- SCRAM pass-through (server login using the stored secret from `userlist.txt`, added in 1.14.0 per the changelog): it needs a SCRAM secret in the file, client auth that also uses SCRAM, the database entry with no forced user, and an exact match with the server's secret (salt and iterations). We would have to extract the secret from `pg_authid`, so plaintext is simpler. Bugs in pass-through were still being fixed in 1.25.1 and 1.26.0 (changelog), which is another reason to avoid it.
- `auth_query` (config.html): it runs as `auth_user`, whose own password comes from `auth_file`. The default query reads `pg_authid`, which needs superuser rights. The page recommends a `SECURITY DEFINER` function instead, and that function must be created by a superuser. So yes, `auth_query` needs a superuser-made function or superuser access. Not needed for a single-app setup.

## 4. What breaks in transaction mode

PgBouncer's own list ("Never" in transaction pooling, https://www.pgbouncer.org/features.html): `SET`/`RESET`, `LISTEN`, `WITH HOLD` cursors, `PREPARE`/`DEALLOCATE` (SQL level), `PRESERVE`/`DELETE ROWS` temp tables, `LOAD`, session-level advisory locks. `NOTIFY` itself works but is useless without `LISTEN`. `server_reset_query_always=1` is documented for broken setups that rely on session state (config.html). Use `SET LOCAL` inside a transaction instead of `SET`.

Migration tools: I did not fetch these tools' docs (they are not on the allowed list), so which tools need session features is NOT VERIFIED here. From the PgBouncer list, anything that takes a session advisory lock or uses `SET`/`LISTEN`/temp tables breaks. Prisma Migrate (advisory lock) is the known case, and Laravel, Rails and Django migrations may also use session features. The safe design is that migrations and one-off admin tasks connect straight to PostgreSQL, on its own port or Compose service, and only the app's runtime connection goes through PgBouncer.

## 5. Changing a password at runtime

https://www.pgbouncer.org/usage.html: SIGHUP does the same as the `RELOAD` console command. `RELOAD` reloads the config files and the files named by `auth_file` and `auth_hba_file`. If the connection parameters of a database change, old server connections close when next released, and new ones use the new parameters at once. Clients are not dropped. `WAIT_CLOSE [db]` confirms the reload has taken effect. Order: change the password in PostgreSQL, update `userlist.txt`, then reload PgBouncer. Server connections already open keep working until released.

Related signals: SIGTERM waits for clients to disconnect (since 1.23.0; before it was immediate), SIGINT is a safe shutdown, SIGQUIT is immediate.

## 6. Settings for a small app (one web process with a few workers)

| Setting | Value | Why |
|---|---|---|
| `pool_mode` | `transaction` | The goal. Default is `session`. |
| `listen_port` | `6432` (default, TCP and Unix socket) | Keep the default. |
| `listen_addr` | the Compose network only, no published port | Not in my fetched pages; set it to 0.0.0.0 inside the container and do not publish the port. |
| `default_pool_size` | 10 | Default 20 per user/database pair. A few workers need only a handful of server connections, and it must stay below PostgreSQL `max_connections` (default 100), which leaves room for direct migration and admin connections. This is my recommendation, not a documented number. |
| `max_client_conn` | 100 (default) | Clients are cheap (about 2 kB each) and a small app stays far below it. Raise the file descriptor limit if you raise this a lot (config.html warns about it). |
| `server_reset_query` | leave `DISCARD ALL` (default) | It is not used in transaction mode unless `server_reset_query_always=1`. Do not set `server_reset_query_always`, because it makes clients lose state after each transaction. |
| `ignore_startup_parameters` | `extra_float_digits` | Default is empty, so a startup parameter PgBouncer cannot track is an error. Libpq/PDO drivers send `extra_float_digits`; add `options` only if a client sends it. |
| `max_prepared_statements` | 200 (default since 1.24) | Required for protocol-level prepares. Set it explicitly so older versions behave the same. |
| `auth_type` | `scram-sha-256` | See section 3. |
| `server_check_query` | leave the default | Optional. |

All defaults are from https://www.pgbouncer.org/config.html. Rows marked as my recommendation are not documented numbers.

## 7. Memory use

https://www.pgbouncer.org/features.html: about 2 kB per connection by default, since PgBouncer does not need to see full packets at once. The documents I fetched give no typical RSS for the whole process. A measurement on a real container (`docker stats`) would settle it before we state a number. NOT VERIFIED: any figure for process RSS.

## 8. Health check

The docs describe no dedicated health endpoint (https://www.pgbouncer.org/usage.html). Options:
- The admin console (`psql -p 6432 pgbouncer`, a user in `admin_users` or `stats_users`) supports `SHOW STATE` (active or paused), `SHOW POOLS` (`maxwait` grows when the pool is too small), `SHOW DATABASES` (paused or disabled flags) and `SHOW VERSION`. The console takes the simple query protocol only.
- A TCP check on port 6432 is a minimal liveness test. The minimal edoburu image may not contain `psql` or `pg_isready`, so that is NOT VERIFIED.
- `pg_isready -p 6432`: NOT VERIFIED against PgBouncer from an official source.
- Suggested check: a TCP connect to 6432 from inside the container (for example a shell `/dev/tcp` check or the `nc` that the image has), and a deeper check from the app side.

## 9. Session mode, not transaction mode (the lead, 2026-11-26)

The Docker test (T5004) answered section 2's open question against real PHP. In transaction mode,
PDO's native prepared statements work only when `pdo_pgsql` is built against libpq 17 or later.
Without libpq 17's `PQclosePrepared`, `pdo_pgsql` (`ext/pdo_pgsql/pgsql_statement.c`) frees a
statement with SQL `DEALLOCATE pdo_stmt_…`. PgBouncer doesn't track SQL `DEALLOCATE` and has
renamed the statement, so PostgreSQL knows no such name, the transaction aborts, and the next query
fails with `25P02`. With Debian 12's libpq 15, the base of common PHP images, every Laravel
transaction of two or more queries failed through the pooler (40 of 40), while the same requests
straight to PostgreSQL passed. No PgBouncer setting fixes it in transaction mode.

**Decision:** `pool_mode = session`. The cost the pooler removes is a fresh backend per PHP request.
In session mode a client keeps one server connection while it is connected; when it disconnects,
the connection returns to the pool after `server_reset_query` (`DISCARD ALL`), which resets the
session but keeps the backend and its caches warm, so the next request gets a warm backend.
Prepared statements, `DEALLOCATE`, `SET`, advisory locks, `LISTEN` and temporary tables all work as
on a direct connection, so section 4's list no longer applies. The price is that clients beyond
`default_pool_size` wait for a free connection. PHP holds one only for a request, so
`default_pool_size = 20` (FrankenPHP's threads and a few workers) with `max_client_conn = 100`.
`max_prepared_statements` isn't needed in session mode.
