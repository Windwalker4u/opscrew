/**
 * `psql -X -q -At -z` answers to advise's database queries (fields split by a zero byte, one row a
 * line), as a quiet PostgreSQL gives them and with a planted lock wait, an open transaction, a long
 * query, slow statements and a table read in full; and psql running the check's script with them.
 */
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import {
  DATABASE_MARK,
  DATABASE_QUERIES,
  type DatabaseQuery,
  STATEMENTS_FAILED,
} from "../database";

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

/** A query's mark, as psql prints it. */
const mark = (name: string) => `${DATABASE_MARK}${name}\n`;

/**
 * psql running advise's script `input` (as real psql does, in the database tests against Docker):
 * the queries in the script in order, each answered by `answers` (then {@link QUIET}) and followed
 * by its mark; the first failure or timeout stops it, except the slow statements' failure other
 * than a limit, marked; the statements only when the extension's query has a row. Also the
 * queries it ran.
 */
export function psqlSession(
  input: string,
  answers: Partial<Record<DatabaseQuery, DatabaseAnswer>> = {},
): { result: CommandResult; ran: DatabaseQuery[] } {
  const queries = (Object.keys(DATABASE_QUERIES) as DatabaseQuery[]).filter((query) =>
    input.split("\n").includes(DATABASE_QUERIES[query]),
  );
  const ran: DatabaseQuery[] = [];
  let stdout = "";
  let stderr = "";
  let extension = false;
  for (const query of queries) {
    if (query === "statements" && !extension) continue;
    ran.push(query);
    const answer = resultOf(answers[query] ?? QUIET[query]);
    stderr += answer.stderr;
    if (answer.timedOut === true) return { result: { ...answer, stdout, stderr }, ran };
    if (answer.exitCode !== 0) {
      if (query !== "statements") return { result: { ...answer, stdout, stderr }, ran };
      // The script quits (exit code 0) when the statements hit a limit.
      if (/canceling statement due to/.test(answer.stderr)) {
        return { result: { exitCode: 0, stdout, stderr }, ran };
      }
      stdout += mark(STATEMENTS_FAILED);
      continue;
    }
    stdout += answer.stdout + mark(query);
    if (query === "extension") extension = answer.stdout !== "";
  }
  return { result: { exitCode: 0, stdout, stderr }, ran };
}

/**
 * A shell that runs advise's database script on standard input as {@link psqlSession} with
 * `answers`; every call is recorded, with the queries each ran.
 */
export function databaseShell(answers: Partial<Record<DatabaseQuery, DatabaseAnswer>> = {}) {
  const calls: { command: string; options: RemoteRunOptions | undefined; ran: DatabaseQuery[] }[] =
    [];
  const remote: RemoteExec = {
    host: "192.168.1.30",
    async run(command, options) {
      const { result, ran } = psqlSession(options?.input ?? "", answers);
      calls.push({ command, options, ran });
      return result;
    },
  };
  return { remote, calls };
}
