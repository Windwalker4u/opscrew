/**
 * PgBouncer beside a PostgreSQL with `pooler: pgbouncer` (050, plan 2.): the Compose service
 * `<db>-pooler` on the database's server and network, in transaction mode, which the app's web,
 * workers and cron reach the database through. The release keeps the direct address
 * (`releaseVariables`), so migrations, which may use session features, never go through it.
 *
 * It holds no data and mounts no file: its start command writes its settings and the runtime
 * login's password into `/tmp` from its environment, so a Portainer stack runs it the same way.
 */
import type { PlanService } from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";
import { OWNER_PASSWORD_ENV, POSTGRES_RUNTIME, RUNTIME_PASSWORD_ENV } from "./postgres-logins";
import type { ServiceHealthcheck } from "./types";

/** Where the app reaches the pooler: PgBouncer's own port. */
export const POOLER_PORT = 6432;

/** The pooler's memory limit, which design and server-fit count beside the database's. */
export const POOLER_MEMORY_MB = 32;

/** The pooler's settings and login file, in the container's `/tmp` (the image's user may write there). */
const INI = "/tmp/pgbouncer.ini";
const USERLIST = "/tmp/userlist.txt";

/** The Compose name of `service`'s pooler: `db-pooler` for `db`. */
export function poolerName(service: PlanService): string {
  return `${service.name}-pooler`;
}

/**
 * PgBouncer's settings (research 6): the database `app` of `service`, on its own Compose name,
 * in transaction mode; SCRAM with the client and the server from the runtime login's password in
 * {@link USERLIST} (research 3); protocol-level prepared statements tracked (PDO's); the
 * `extra_float_digits` drivers send ignored. No admin login, and the runtime login may read its
 * statistics (`SHOW POOLS`).
 */
function settings(service: PlanService): string[] {
  return [
    "[databases]",
    `app = host=${service.name} port=5432 dbname=app`,
    "[pgbouncer]",
    "listen_addr = 0.0.0.0",
    `listen_port = ${POOLER_PORT}`,
    "auth_type = scram-sha-256",
    `auth_file = ${USERLIST}`,
    "pool_mode = transaction",
    "default_pool_size = 10",
    "max_client_conn = 100",
    "max_prepared_statements = 200",
    "ignore_startup_parameters = extra_float_digits",
    "admin_users =",
    `stats_users = ${POSTGRES_RUNTIME}`,
  ];
}

/**
 * The pooler's entrypoint, `/bin/sh -c <script>`: the script writes its settings and
 * {@link USERLIST} (both 0600) and starts PgBouncer in their place, without the database's
 * passwords in its environment. The password is written by the shell's own `printf`, so it is in
 * no process's arguments. Its environment has {@link RUNTIME_PASSWORD_ENV}: on a server from the
 * database's env file, which also holds the other two passwords; in a Portainer stack alone.
 */
export function poolerStart(service: PlanService): string[] {
  const script = [
    "set -eu",
    "umask 077",
    `printf '%s\\n' ${settings(service).map(shellQuote).join(" ")} > ${INI}`,
    `printf '"%s" "%s"\\n' ${POSTGRES_RUNTIME} "$${RUNTIME_PASSWORD_ENV}" > ${USERLIST}`,
    `unset POSTGRES_PASSWORD ${OWNER_PASSWORD_ENV} ${RUNTIME_PASSWORD_ENV}`,
    `exec pgbouncer ${INI}`,
  ];
  return ["/bin/sh", "-c", script.join("; ")];
}

/**
 * Healthy once PgBouncer accepts a TCP connection, which needs no password: bash's `/dev/tcp`
 * opens one and closes it, which PgBouncer doesn't log (`pg_isready` would log a login attempt on
 * every check).
 */
export function poolerHealthcheck(): ServiceHealthcheck {
  return { test: ["CMD", "bash", "-c", `</dev/tcp/127.0.0.1/${POOLER_PORT}`] };
}
