/**
 * Advise's database check (feature 029, plan.md "20.", research R20–R23): a PostgreSQL service's
 * statistics, read once with fixed `SELECT` texts through `docker compose -p <app> exec -T <db> psql`
 * over the server's shell, as the image's `app` login on the container's socket (no role made, no
 * password read). Each text goes on standard input, never in a command, and the session is bounded
 * by `PGOPTIONS`. `pg_stat_activity.query` is never selected: a statement's text comes only from
 * `pg_stat_statements`, normalized, cut at 120 characters and redacted.
 */
import type { CommandResult, RemoteExec } from "@opscrew/contracts";
import { shellQuote } from "@opscrew/iac-templates";
import { z } from "zod";
import type {
  BlockedSession,
  DatabaseReading,
  OpenSession,
  SlowStatement,
  TableScans,
} from "./types";

/** A statement's time limit, in ms (the session's `statement_timeout`). */
export const STATEMENT_TIMEOUT_MS = 3000;

/** The whole check's cap, in ms: the first query past it stops the check. */
export const DATABASE_CHECK_CAP_MS = 20_000;

/**
 * The session's bounds (R21): a statement stops at 3 seconds, a lock wait at half a second, an
 * idle transaction at 5, and every transaction is read-only.
 */
export const PGOPTIONS = [
  `statement_timeout=${STATEMENT_TIMEOUT_MS}`,
  "lock_timeout=500",
  "idle_in_transaction_session_timeout=5000",
  "default_transaction_read_only=on",
]
  .map((setting) => `-c ${setting}`)
  .join(" ");

/**
 * The fixed SQL texts (R21's six queries; the fourth in two steps), each one `SELECT` ending with
 * its only `;`. Durations are whole seconds, and a statement's text is on one line.
 */
export const DATABASE_QUERIES = Object.freeze({
  /** 1. Sessions waiting for a lock, with the sessions holding it and the first one's app. */
  blocked:
    "SELECT a.pid, a.usename, a.application_name, extract(epoch FROM now() - a.state_change)::bigint, a.blockers, b.application_name FROM (SELECT pid, usename, application_name, state_change, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity) a LEFT JOIN pg_stat_activity b ON b.pid = a.blockers[1] WHERE cardinality(a.blockers) > 0;",
  /** 2. Sessions with a transaction open and not idle, the oldest first; this one left out. */
  sessions:
    "SELECT pid, usename, application_name, state, extract(epoch FROM now() - xact_start)::bigint, extract(epoch FROM now() - query_start)::bigint FROM pg_stat_activity WHERE backend_type = 'client backend' AND xact_start IS NOT NULL AND state <> 'idle' AND pid <> pg_backend_pid() ORDER BY xact_start LIMIT 10;",
  /** 3. Client connections against the limit and the superuser's reserved ones. */
  connections:
    "SELECT (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend'), current_setting('max_connections')::int, current_setting('superuser_reserved_connections')::int;",
  /** 4a. Whether `pg_stat_statements` is installed. */
  extension: "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements';",
  /**
   * 4b. The database's 5 statements with the most time, with every statement's total: the
   * normalized text of the data statements only (a utility statement keeps its literals).
   */
  statements:
    "SELECT s.calls, s.total_exec_time, s.mean_exec_time, (SELECT sum(t.total_exec_time) FROM pg_stat_statements t WHERE t.dbid = s.dbid), left(regexp_replace(s.query, '\\s+', ' ', 'g'), 120) FROM pg_stat_statements s WHERE s.dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND s.query ~* '^\\s*(select|insert|update|delete|with)\\M' ORDER BY s.total_exec_time DESC LIMIT 5;",
  /** 5. The database's size. */
  size: "SELECT pg_database_size(current_database());",
  /** 6. The tables read in full the most (R23). */
  tables:
    "SELECT relname, seq_scan, seq_tup_read, coalesce(idx_scan, 0), n_live_tup FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 10;",
});

/** One of {@link DATABASE_QUERIES}. */
export type DatabaseQuery = keyof typeof DATABASE_QUERIES;

/** The first PostgreSQL version with `total_exec_time` and `mean_exec_time`. */
const STATEMENTS_FROM = 13;

/** The sessions' name in `pg_stat_activity` and the logs. */
export const APPLICATION_NAME = "opscrew-advise";

/**
 * The fixed command the check's one session runs through, its script on standard input: `psql` in
 * the service's container of the Compose project `app`, unaligned, tuples only, fields split by a
 * zero byte, stopping at the first error. The session is named through `PGAPPNAME`: psql's own
 * name would win over one in `PGOPTIONS`.
 */
export function databaseCommand(app: string, service: string): string {
  return `docker compose -p ${shellQuote(app)} exec -T -e PGAPPNAME=${APPLICATION_NAME} -e ${shellQuote(`PGOPTIONS=${PGOPTIONS}`)} ${shellQuote(service)} psql -X -q -At -z -v ON_ERROR_STOP=1 -U app -d app`;
}

/** What {@link readDatabase} reads. */
export interface DatabaseCheck {
  /** The Compose project. */
  app: string;
  /** The plan's name of the server. */
  server: string;
  /** The PostgreSQL service. */
  service: string;
  /** Its major version, from the plan. */
  major: number;
  /** The clock: the check starts at its first reading. */
  now: () => Date;
  /** The redactor's, for every text the database gives. */
  redact: (text: string) => string;
}

/** The service in words: `PostgreSQL db on server app`. */
export function databaseWords(server: string, service: string): string {
  return `PostgreSQL ${service} on server ${server}`;
}

/** What psql prints after a query's rows: the query read in full. */
export const DATABASE_MARK = "==opscrew-db:";

/** The mark's name when the slow statements' query failed for another reason than a limit. */
export const STATEMENTS_FAILED = "statements-failed";

/**
 * The one `SELECT` besides {@link DATABASE_QUERIES}: whether the slow statements' query failed on
 * the session's statement or lock limit (SQLSTATE `57014`, `55P03`), as psql's `opscrew_cancelled`.
 */
export const CANCELLED_CHECK =
  "SELECT :'SQLSTATE' IN ('57014', '55P03') AS opscrew_cancelled \\gset";

/**
 * The check's psql script for PostgreSQL `major`: the queries in order, each followed by its mark.
 * The slow statements run only when `pg_stat_statements` is installed (the extension's query has a
 * row) and from version 13; their failure doesn't stop the session (installed but not loaded, psql
 * says so), unless it hit the session's limit.
 */
export function databaseScript(major: number): string {
  const query = (name: DatabaseQuery) => [DATABASE_QUERIES[name], `\\echo ${DATABASE_MARK}${name}`];
  const statements =
    major < STATEMENTS_FROM
      ? []
      : [
          ...query("extension"),
          "\\if :ROW_COUNT",
          "\\set ON_ERROR_STOP 0",
          DATABASE_QUERIES.statements,
          "\\set ON_ERROR_STOP 1",
          "\\if :ERROR",
          CANCELLED_CHECK,
          "\\if :opscrew_cancelled",
          "\\q",
          "\\endif",
          `\\echo ${DATABASE_MARK}${STATEMENTS_FAILED}`,
          "\\else",
          `\\echo ${DATABASE_MARK}statements`,
          "\\endif",
          "\\endif",
        ];
  return [
    ...query("blocked"),
    ...query("sessions"),
    ...query("connections"),
    ...statements,
    ...query("size"),
    ...query("tables"),
    "",
  ].join("\n");
}

/** Each query's rows by the mark psql printed after them; a query cut short has none. */
function marked(stdout: string): Map<string, string[][]> {
  const found = new Map<string, string[][]>();
  let rows: string[][] = [];
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    if (line.startsWith(DATABASE_MARK) && !line.includes("\0")) {
      found.set(line.slice(DATABASE_MARK.length), rows);
      rows = [];
    } else {
      rows.push(line.split("\0"));
    }
  }
  return found;
}

/** True when psql says a statement was cancelled by the session's statement or lock limit. */
function cancelled(result: CommandResult): boolean {
  return /canceling statement due to (statement|lock) timeout/.test(result.stderr);
}

const Int = z.coerce.number().int();
const Num = z.coerce.number();

/** `{1,2}` (an `int[]` as psql prints it) as numbers. */
function pids(text: string): number[] {
  return text
    .replace(/^\{|\}$/g, "")
    .split(",")
    .filter((p) => p !== "")
    .map(Number);
}

/** Each row as `schema` parses it; a row it doesn't is a bug in OpsCrew's SQL and stops. */
function parsed<T extends z.ZodType>(rows: string[][], schema: T): z.output<T>[] {
  return rows.map((row) => schema.parse(row));
}

/**
 * The statistics of one PostgreSQL service over `remote` (a shell that reaches Docker), with what
 * could not be read in words. The queries run in one psql session ({@link databaseScript}) within
 * {@link DATABASE_CHECK_CAP_MS}; the first that times out stops the check (`timedOut`), and one
 * that fails stops it too, said in `notRead`. `pg_stat_statements` off, or a version below 13,
 * skips the slow statements with the reason.
 */
export async function readDatabase(
  remote: RemoteExec,
  check: DatabaseCheck,
): Promise<{ reading: DatabaseReading; notRead: string[] }> {
  const start = check.now();
  const command = databaseCommand(check.app, check.service);
  const words = databaseWords(check.server, check.service);
  const reading: DatabaseReading = {
    server: check.server,
    service: check.service,
    at: start.toISOString(),
  };
  const notRead: string[] = [];
  const text = (value: string) => check.redact(value);

  const result = await remote.run(command, {
    input: databaseScript(check.major),
    timeoutMs: DATABASE_CHECK_CAP_MS,
  });
  const read = marked(result.stdout);

  /** Says why the session stopped before a query: its limit, or psql's failure. */
  const stopped = (): undefined => {
    if (result.timedOut === true || cancelled(result)) {
      reading.timedOut = true;
    } else {
      notRead.push(
        `the statistics of ${words}: psql in its container failed (exit code ${result.exitCode}); check that it runs with \`opscrew status\``,
      );
    }
    return undefined;
  };

  /** The rows of `query`, or `undefined` where the session stopped (`stopped` says why). */
  const rowsOf = (query: DatabaseQuery): string[][] | undefined => read.get(query) ?? stopped();

  const blocked = rowsOf("blocked");
  if (blocked === undefined) return { reading, notRead };
  reading.blocked = parsed(
    blocked,
    z.tuple([Int, z.string(), z.string(), Int, z.string(), z.string()]).transform(
      ([pid, user, application, waitedSec, blockers, blockerApp]): BlockedSession => ({
        pid,
        user: text(user),
        application: text(application),
        waitedSec,
        blockers: pids(blockers),
        ...(blockerApp === "" ? {} : { blockerApplication: text(blockerApp) }),
      }),
    ),
  );

  const sessions = rowsOf("sessions");
  if (sessions === undefined) return { reading, notRead };
  reading.sessions = parsed(
    sessions,
    z.tuple([Int, z.string(), z.string(), z.string(), Int, Int]).transform(
      ([pid, user, application, state, openSec, querySec]): OpenSession => ({
        pid,
        user: text(user),
        application: text(application),
        state,
        openSec,
        querySec,
      }),
    ),
  );

  const connections = rowsOf("connections");
  if (connections === undefined) return { reading, notRead };
  const [counts] = parsed(connections, z.tuple([Int, Int, Int]));
  if (counts !== undefined) {
    reading.connections = { count: counts[0], max: counts[1], reserved: counts[2] };
  }

  const slow = `${words}: slow queries are not read`;
  if (check.major < STATEMENTS_FROM) {
    notRead.push(
      `${slow}: they need PostgreSQL ${STATEMENTS_FROM} or later, and this one is ${check.major}`,
    );
  } else {
    const extension = rowsOf("extension");
    if (extension === undefined) return { reading, notRead };
    const statements = extension.length === 0 ? undefined : read.get("statements");
    if (extension.length > 0 && statements === undefined && !read.has(STATEMENTS_FAILED)) {
      stopped();
      return { reading, notRead };
    }
    if (statements === undefined) {
      // Installed but not loaded at the server's start, psql says so: the same two steps.
      notRead.push(
        `${slow}: turn \`pg_stat_statements\` on (add it to the database's \`shared_preload_libraries\` setting and restart the database, then run \`CREATE EXTENSION pg_stat_statements;\` in it)`,
      );
    } else {
      reading.statements = parsed(
        statements,
        z.tuple([Int, Num, Num, Num, z.string()]).transform(
          ([calls, totalMs, meanMs, allMs, statement]): SlowStatement => ({
            text: text(statement),
            calls,
            meanMs,
            share: allMs > 0 ? totalMs / allMs : 0,
          }),
        ),
      );
    }
  }

  const size = rowsOf("size");
  if (size === undefined) return { reading, notRead };
  const [bytes] = parsed(size, z.tuple([Int]));
  if (bytes !== undefined) reading.sizeBytes = bytes[0];

  const tables = rowsOf("tables");
  if (tables === undefined) return { reading, notRead };
  reading.tables = parsed(
    tables,
    z.tuple([z.string(), Int, Int, Int, Int]).transform(
      ([name, seqScan, seqRows, idxScan, liveRows]): TableScans => ({
        name: text(name),
        seqScan,
        seqRows,
        idxScan,
        liveRows,
      }),
    ),
  );
  return { reading, notRead };
}
