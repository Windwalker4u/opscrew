/**
 * Advise's database check (plan.md "20.", research R20–R21): the fixed SQL texts only read, never
 * `pg_stat_activity.query`; one fixed command, one session's script on standard input; the
 * session's bounds; the parts parsed from psql's answers; the first timeout stops the check;
 * `pg_stat_statements` off or a version below 13 skips the slow statements with the reason; texts
 * redacted. Fakes only.
 */
import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  databaseShell,
  QUIET,
  row,
  rows,
  STATEMENT_TIMEOUT,
  TROUBLED,
} from "./__fixtures__/database";
import {
  CANCELLED_CHECK,
  DATABASE_CHECK_CAP_MS,
  DATABASE_QUERIES,
  type DatabaseCheck,
  databaseCommand,
  databaseScript,
  PGOPTIONS,
  readDatabase,
} from "./database";

const AT = new Date("2026-11-05T10:00:00.000Z");

function check(o: Partial<DatabaseCheck> = {}): DatabaseCheck {
  return {
    app: "shop",
    server: "app",
    service: "db",
    major: 17,
    now: () => AT,
    redact: (text) => text,
    ...o,
  };
}

/** `sql` without its string literals (`'…'`), so a literal's words don't count as SQL. */
const withoutLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''");

/** Every word that writes, changes the session, or ends a session. */
const WRITES =
  /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|set|reset|copy|do|call|vacuum|analyze|cluster|reindex|lock|comment|refresh|listen|notify|prepare|execute|begin|commit|rollback|pg_terminate_backend|pg_cancel_backend|pg_stat_statements_reset|pg_stat_reset\w*|nextval|setval|pg_reload_conf|lo_\w+|dblink\w*)\b/i;

describe("the database check's SQL", () => {
  const texts = Object.entries(DATABASE_QUERIES);

  it("holds only SELECTs, each one statement with its only `;` at the end", () => {
    expect(texts.map(([name]) => name)).toEqual([
      "blocked",
      "sessions",
      "connections",
      "extension",
      "statements",
      "size",
      "tables",
    ]);
    for (const [, sql] of texts) {
      expect(sql).toMatch(/^SELECT /);
      expect(sql.endsWith(";")).toBe(true);
      expect(withoutLiterals(sql).split(";")).toHaveLength(2);
      expect(withoutLiterals(sql)).not.toMatch(WRITES);
      expect(sql).not.toMatch(/\n/);
    }
  });

  it("never selects pg_stat_activity.query, nor any column it doesn't name", () => {
    for (const [, sql] of texts) {
      if (sql.includes("pg_stat_activity")) expect(sql).not.toMatch(/\bquery\b/);
      // `*` only in count(*) and the regular expression match `~*`: every column is named.
      expect(withoutLiterals(sql).replaceAll("count(*)", "").replaceAll(" ~* ", " ")).not.toContain(
        "*",
      );
    }
    // A statement's text comes only from pg_stat_statements, cut at 120 characters.
    const withText = texts.filter(([, sql]) => /\bquery\b/.test(sql)).map(([name]) => name);
    expect(withText).toEqual(["statements"]);
    expect(DATABASE_QUERIES.statements).toContain(
      "left(regexp_replace(s.query, '\\s+', ' ', 'g'), 120)",
    );
  });

  it("sends only those, and one SELECT of the statements' error code, in one psql script", () => {
    expect(CANCELLED_CHECK).toBe(
      "SELECT :'SQLSTATE' IN ('57014', '55P03') AS opscrew_cancelled \\gset",
    );
    expect(withoutLiterals(CANCELLED_CHECK)).not.toMatch(WRITES);
    const sql = new Set<string>([...Object.values(DATABASE_QUERIES), CANCELLED_CHECK]);
    for (const major of [12, 17]) {
      const lines = databaseScript(major).split("\n");
      for (const line of lines.filter((l) => l !== "" && !l.startsWith("\\"))) {
        expect(sql).toContain(line);
      }
      // psql's own commands: the marks, the statements' condition, quitting at their limit.
      for (const line of lines.filter((l) => l.startsWith("\\"))) {
        expect(line).toMatch(
          /^\\(echo ==opscrew-db:[a-z-]+|if :\w+|else|endif|set ON_ERROR_STOP [01]|q)$/,
        );
      }
    }
    expect(databaseScript(12)).not.toContain(DATABASE_QUERIES.extension);
    expect(databaseScript(12)).not.toContain(DATABASE_QUERIES.statements);
  });

  it("runs one fixed command, the session bounded, the SQL never in it", () => {
    expect(PGOPTIONS).toBe(
      "-c statement_timeout=3000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000 -c default_transaction_read_only=on",
    );
    expect(databaseCommand("shop", "db")).toBe(
      `docker compose -p 'shop' exec -T -e PGAPPNAME=opscrew-advise -e 'PGOPTIONS=${PGOPTIONS}' 'db' psql -X -q -At -z -v ON_ERROR_STOP=1 -U app -d app`,
    );
  });
});

describe("readDatabase", () => {
  it("reads the six queries in order, in one session within the cap", async () => {
    const shell = databaseShell();
    const { reading, notRead } = await readDatabase(shell.remote, check());
    expect(shell.calls).toHaveLength(1);
    expect(shell.calls[0]?.ran).toEqual([
      "blocked",
      "sessions",
      "connections",
      "extension",
      "statements",
      "size",
      "tables",
    ]);
    expect(shell.calls[0]).toMatchObject({
      command: databaseCommand("shop", "db"),
      options: { input: databaseScript(17), timeoutMs: DATABASE_CHECK_CAP_MS },
    });
    expect(notRead).toEqual([]);
    expect(reading).toEqual({
      server: "app",
      service: "db",
      at: AT.toISOString(),
      blocked: [],
      sessions: [],
      connections: { count: 3, max: 100, reserved: 3 },
      statements: [
        {
          text: "SELECT id, total FROM orders WHERE customer_id = $1",
          calls: 120,
          meanMs: 2.8375,
          share: 340.5 / 1200.25,
        },
      ],
      sizeBytes: 8_000_000,
      tables: [{ name: "orders", seqScan: 12, seqRows: 3000, idxScan: 400, liveRows: 900 }],
    });
  });

  it("parses a lock wait, an open transaction and a long query", async () => {
    const { reading } = await readDatabase(databaseShell(TROUBLED).remote, check());
    expect(reading.blocked).toEqual([
      {
        pid: 4321,
        user: "app",
        application: "worker",
        waitedSec: 360,
        blockers: [4310],
        blockerApplication: "web",
      },
    ]);
    expect(reading.sessions?.map((s) => [s.pid, s.state, s.openSec, s.querySec])).toEqual([
      [4310, "idle in transaction", 4500, 4490],
      [4321, "active", 400, 360],
      [4400, "active", 420, 420],
    ]);
    // Several blockers, none with an application name.
    const many = await readDatabase(
      databaseShell({ blocked: rows(row(77, "app", "", 40, "{70,71}", "")) }).remote,
      check(),
    );
    expect(many.reading.blocked).toEqual([
      { pid: 77, user: "app", application: "", waitedSec: 40, blockers: [70, 71] },
    ]);
  });

  it("stops at the first query that hits the session's limit, and says it timed out", async () => {
    const shell = databaseShell({ sessions: STATEMENT_TIMEOUT });
    const { reading, notRead } = await readDatabase(shell.remote, check());
    expect(shell.calls[0]?.ran).toEqual(["blocked", "sessions"]);
    expect(reading).toEqual({
      server: "app",
      service: "db",
      at: AT.toISOString(),
      blocked: [],
      timedOut: true,
    });
    expect(notRead).toEqual([]);
    // A lock wait past lock_timeout, and the shell's own time limit, the same.
    for (const answer of [
      { ...STATEMENT_TIMEOUT, stderr: "ERROR:  canceling statement due to lock timeout\n" },
      { exitCode: 124, stdout: "", stderr: "", timedOut: true },
    ]) {
      const again = await readDatabase(databaseShell({ connections: answer }).remote, check());
      expect(again.reading.timedOut).toBe(true);
      expect(again.reading.connections).toBeUndefined();
    }
  });

  it("keeps what it read before the 20 seconds ran out, and says it timed out", async () => {
    const shell = databaseShell({
      statements: { exitCode: 124, stdout: "", stderr: "", timedOut: true },
    });
    const { reading } = await readDatabase(shell.remote, check());
    expect(shell.calls[0]?.options?.timeoutMs).toBe(20_000);
    expect(reading.timedOut).toBe(true);
    expect(reading.connections).toEqual({ count: 3, max: 100, reserved: 3 });
    expect(reading.statements).toBeUndefined();
  });

  it("says slow queries are not read while pg_stat_statements is off, with the two steps", async () => {
    const off = databaseShell({ extension: "" });
    const { reading, notRead } = await readDatabase(off.remote, check());
    expect(off.calls[0]?.ran).not.toContain("statements");
    expect(reading.statements).toBeUndefined();
    expect(reading.tables).toBeDefined();
    const line =
      "PostgreSQL db on server app: slow queries are not read: turn `pg_stat_statements` on (add it to the database's `shared_preload_libraries` setting and restart the database, then run `CREATE EXTENSION pg_stat_statements;` in it)";
    expect(notRead).toEqual([line]);
    // Installed but not loaded when the server started: psql fails, the same line.
    const notLoaded = {
      exitCode: 3,
      stdout: "",
      stderr: 'ERROR:  pg_stat_statements must be loaded via "shared_preload_libraries"\n',
    };
    const failed = await readDatabase(databaseShell({ statements: notLoaded }).remote, check());
    expect(failed.notRead).toEqual([line]);
    expect(failed.reading.tables).toBeDefined();
    // Then the size past its limit: the line, and the check stopped there.
    const late = databaseShell({ statements: notLoaded, size: STATEMENT_TIMEOUT });
    const both = await readDatabase(late.remote, check());
    expect(both.notRead).toEqual([line]);
    expect(both.reading).toMatchObject({ timedOut: true });
    expect(both.reading.sizeBytes).toBeUndefined();
  });

  it("stops at the slow statements' limit, and says it timed out", async () => {
    const shell = databaseShell({ statements: STATEMENT_TIMEOUT });
    const { reading, notRead } = await readDatabase(shell.remote, check());
    expect(shell.calls[0]?.ran).toEqual([
      "blocked",
      "sessions",
      "connections",
      "extension",
      "statements",
    ]);
    expect(reading.timedOut).toBe(true);
    expect(reading.statements).toBeUndefined();
    expect(reading.sizeBytes).toBeUndefined();
    expect(notRead).toEqual([]);
  });

  it("skips the slow queries below PostgreSQL 13, with the reason", async () => {
    const shell = databaseShell();
    const { reading, notRead } = await readDatabase(shell.remote, check({ major: 12 }));
    expect(shell.calls[0]?.ran).toEqual(["blocked", "sessions", "connections", "size", "tables"]);
    expect(reading.statements).toBeUndefined();
    expect(notRead).toEqual([
      "PostgreSQL db on server app: slow queries are not read: they need PostgreSQL 13 or later, and this one is 12",
    ]);
  });

  it("says when psql fails in the container, and stops", async () => {
    const shell = databaseShell({
      blocked: { exitCode: 1, stdout: "", stderr: 'service "db" is not running' },
    });
    const { reading, notRead } = await readDatabase(shell.remote, check({ server: "data" }));
    expect(shell.calls[0]?.ran).toEqual(["blocked"]);
    expect(reading.blocked).toBeUndefined();
    expect(notRead).toEqual([
      "the statistics of PostgreSQL db on server data: psql in its container failed (exit code 1); check that it runs with `opscrew status`",
    ]);
  });

  it("redacts every text the database gives", async () => {
    const redactor = new Redactor();
    const secret = fakeSecret("generic-password");
    redactor.addLiteral(secret);
    const shell = databaseShell({
      blocked: rows(row(5, "app", `x${secret}`, 40, "{4}", secret)),
      statements: rows(row(60, 900, 600, 900, `SELECT 1 FROM users WHERE note = '${secret}'`)),
      tables: rows(row(`t${secret}`, 1, 1, 1, 1)),
    });
    const { reading } = await readDatabase(
      shell.remote,
      check({ redact: (text) => redactor.redact(text) }),
    );
    expect(JSON.stringify(reading)).not.toContain(secret);
    expect(reading.statements?.[0]?.text).toMatch(/^SELECT 1 FROM users WHERE note = '/);
  });
});

describe("the fixtures", () => {
  it("answer every query", () => {
    for (const query of Object.keys(DATABASE_QUERIES)) {
      expect(query in QUIET && query in TROUBLED).toBe(true);
    }
  });
});
