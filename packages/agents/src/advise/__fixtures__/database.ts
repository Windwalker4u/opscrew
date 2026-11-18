/**
 * `psql -X -q -At -z` answers to advise's database queries (fields split by a zero byte, one row a
 * line), as a quiet PostgreSQL gives them and with a planted lock wait, an open transaction, a long
 * query, slow statements and a table read in full; and a shell answering them by the SQL on its
 * standard input.
 */
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { DATABASE_QUERIES, type DatabaseQuery } from "../database";

/** One row of fields as psql prints it. */
export function row(...fields: (string | number)[]): string {
  return fields.map(String).join("\0");
}

/** Rows as psql's output. */
export function rows(...lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/** A quiet database: nothing waits, 3 of 100 connections, `pg_stat_statements` on, 8 MB. */
export const QUIET: Record<DatabaseQuery, string> = {
  blocked: "",
  sessions: "",
  connections: rows(row(3, 100, 3)),
  extension: rows(row(1)),
  statements: rows(
    row(120, 340.5, 2.8375, 1200.25, "SELECT id, total FROM orders WHERE customer_id = $1"),
  ),
  size: rows(row(8_000_000)),
  tables: rows(row("orders", 12, 3000, 400, 900)),
};

/**
 * A database under trouble: session 4321 has waited 6 minutes for a lock that session 4310 (the
 * app `web`) holds, idle in its transaction for 75 minutes; session 4400 has run a query for 7
 * minutes; 92 of 97 connections; a statement of 2.5 s on average; `orders` read in full.
 */
export const TROUBLED: Record<DatabaseQuery, string> = {
  blocked: rows(row(4321, "app", "worker", 360, "{4310}", "web")),
  sessions: rows(
    row(4310, "app", "web", "idle in transaction", 4500, 4490),
    row(4321, "app", "worker", "active", 400, 360),
    row(4400, "app", "reports", "active", 420, 420),
  ),
  connections: rows(row(92, 100, 3)),
  extension: rows(row(1)),
  statements: rows(
    row(800, 2_000_000, 2500, 2_500_000, "SELECT * FROM orders WHERE status = $1 ORDER BY created_at"),
    row(30, 300_000, 10_000, 2_500_000, "SELECT count(*) FROM order_items"),
  ),
  size: rows(row(30 * 1024 ** 3)),
  tables: rows(row("orders", 5000, 5000 * 80_000, 20, 90_000)),
};

/** What the shell answers one query: its output, or a whole result (a failure, a timeout). */
export type DatabaseAnswer = string | CommandResult;

/** The query whose SQL `input` is, or `undefined`. */
export function queryOf(input: string | undefined): DatabaseQuery | undefined {
  return (Object.keys(DATABASE_QUERIES) as DatabaseQuery[]).find(
    (query) => DATABASE_QUERIES[query] === input,
  );
}

/** A result: exit code 0 with `stdout`, or `answer` itself. */
export function resultOf(answer: DatabaseAnswer): CommandResult {
  return typeof answer === "string" ? { exitCode: 0, stdout: answer, stderr: "" } : answer;
}

/** psql cancelling a statement at the session's `statement_timeout`. */
export const STATEMENT_TIMEOUT: CommandResult = {
  exitCode: 3,
  stdout: "",
  stderr: "ERROR:  canceling statement due to statement timeout\n",
};

/**
 * A shell that answers advise's database queries by the SQL on standard input (`answers`, then
 * {@link QUIET}); every call is recorded.
 */
export function databaseShell(answers: Partial<Record<DatabaseQuery, DatabaseAnswer>> = {}) {
  const calls: { command: string; options: RemoteRunOptions | undefined }[] = [];
  const remote: RemoteExec = {
    host: "192.168.1.30",
    async run(command, options) {
      calls.push({ command, options });
      const query = queryOf(options?.input);
      if (query === undefined) return { exitCode: 1, stdout: "", stderr: "" };
      return resultOf(answers[query] ?? QUIET[query]);
    },
  };
  return { remote, calls };
}
