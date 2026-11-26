/**
 * PostgreSQL extensions setup (feature 045): installs configured extensions as the bootstrap
 * superuser `app` before migrations run, so neither `app_owner` nor `app_runtime` (047, ADR 0037)
 * needs superuser rights. Also detects OS collation version mismatches (for example when an
 * existing `postgres:17-alpine` musl volume switches to `pgvector/pgvector:0.8.7-pg17-trixie`
 * Debian glibc) and runs `REINDEX DATABASE app` + `ALTER DATABASE app REFRESH COLLATION VERSION`
 * outside a transaction before creating extensions.
 *
 * Each script is POSIX sh for the database's own image; no secret is ever in an argument.
 */
import { POSTGRES_EXTENSIONS, type PostgresExtension } from "@opscrew/plan-schema";
import { shellQuote } from "../runtime/services";

const SUPERUSER = "app";
const DATABASE = "app";

const SUPPORTED: ReadonlySet<string> = new Set(POSTGRES_EXTENSIONS);

/** Validates every extension name against the supported list (defense in depth before SQL). */
function validatedExtensions(extensions: readonly PostgresExtension[]): PostgresExtension[] {
  const unique: PostgresExtension[] = [];
  const seen = new Set<string>();
  for (const name of extensions) {
    if (!SUPPORTED.has(name)) {
      throw new Error(`Unsupported PostgreSQL extension: ${JSON.stringify(name)}`);
    }
    if (!seen.has(name)) {
      seen.add(name);
      unique.push(name);
    }
  }
  return unique;
}

/** SQL string literal for a validated extension name (`'vector'`, `'uuid-ossp'`). */
function sqlString(name: PostgresExtension): string {
  return `'${name.replaceAll("'", "''")}'`;
}

/** SQL quoted identifier for a validated extension name (`"vector"`, `"uuid-ossp"`). */
function sqlIdent(name: PostgresExtension): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** psql as the superuser on `app`, stopping at the first error: over socket or TCP to `host`. */
function psql(host?: string, flags = ""): string {
  const to = host === undefined ? "" : ` -h ${host}`;
  return `psql -X -q -v ON_ERROR_STOP=1${flags}${to} -U ${SUPERUSER} -d ${DATABASE}`;
}

/** `sql` on psql's stdin via shell `printf`. */
function piped(sql: readonly string[], host?: string, flags = ""): string {
  return `printf '%s\\n' ${shellQuote(sql.join("\n"))} | ${psql(host, flags)}`;
}

/** Same refusal as 047 when event triggers exist on a database with separate logins. */
function eventTriggersGuard(service: string): string[] {
  const msg = `PostgreSQL ${service} has event triggers, and separate logins cannot run safely with them: OpsCrew changes the database as the superuser, which would run their code. Remove them with DROP EVENT TRIGGER, then try again.`;
  return [
    "DO $$",
    "BEGIN",
    `  IF EXISTS (SELECT FROM pg_catalog.pg_event_trigger) THEN RAISE EXCEPTION '${msg.replaceAll("'", "''")}'; END IF;`,
    "END $$;",
  ];
}

/**
 * Check script for PostgreSQL extensions: exits 0 only when every extension in `extensions` is
 * installed in `pg_extension` AND database `app`'s stored collation version matches the OS's
 * current collation version (catching an Alpine musl -> Debian glibc image switch or glibc update).
 * Over TCP to `host`, or the container's socket without it.
 */
export function extensionsCheck(extensions: readonly PostgresExtension[], host?: string): string {
  const names = validatedExtensions(extensions);
  if (names.length === 0) return "true";
  const list = names.map(sqlString).join(", ");
  const sql = [
    "SET search_path = pg_catalog;",
    "SELECT (",
    `  (SELECT count(*) FROM pg_extension WHERE extname IN (${list})) = ${names.length}`,
    `  AND (SELECT d.datcollversion IS NOT DISTINCT FROM pg_database_collation_actual_version(d.oid) FROM pg_database d WHERE d.datname = '${DATABASE}')`,
    ") IS TRUE;",
  ];
  return `[ "$(${piped(sql, host, " -At")})" = t ]`;
}

/** Options for {@link extensionsSetup}. */
export interface ExtensionsSetupOptions {
  /** Refuse a database with event triggers first (set when `logins: separate` is enabled). */
  guardEventTriggers?: boolean;
  /** Connect over TCP to `host` instead of the local socket. */
  host?: string;
}

/**
 * Setup script for PostgreSQL extensions (as superuser `app`):
 * 1. When `guardEventTriggers` is true, refuses a database with event triggers before any DDL.
 * 2. When `datcollversion` differs from `pg_database_collation_actual_version(oid)` (e.g. Alpine
 *    musl -> Debian glibc switch), runs `REINDEX DATABASE app;` and
 *    `ALTER DATABASE app REFRESH COLLATION VERSION;` outside a transaction block.
 * 3. Runs `CREATE EXTENSION IF NOT EXISTS "<name>" CASCADE;` for each configured extension (with
 *    `search_path = public, pg_catalog` so relocatable extensions install into `public` while
 *    non-relocatable extensions like `postgis_topology` use their control-file schema).
 *
 * Idempotent: running again changes nothing.
 */
export function extensionsSetup(
  service: string,
  extensions: readonly PostgresExtension[],
  options: ExtensionsSetupOptions = {},
): string {
  const names = validatedExtensions(extensions);
  if (names.length === 0) return "true";
  const sql = [
    ...(options.guardEventTriggers === true ? eventTriggersGuard(service) : []),
    `SELECT d.datcollversion IS DISTINCT FROM pg_catalog.pg_database_collation_actual_version(d.oid) AS reindex FROM pg_catalog.pg_database d WHERE d.datname = '${DATABASE}' \\gset`,
    "\\if :reindex",
    `REINDEX DATABASE ${DATABASE};`,
    `ALTER DATABASE ${DATABASE} REFRESH COLLATION VERSION;`,
    "\\endif",
    "SET search_path = public, pg_catalog;",
    ...names.map((name) => `CREATE EXTENSION IF NOT EXISTS ${sqlIdent(name)} CASCADE;`),
  ];
  return piped(sql, options.host);
}
