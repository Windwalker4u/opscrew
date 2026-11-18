/**
 * Advise's database rules (research R22, R23): each finding at its thresholds' edges, as a
 * Reliability finding with `now`/`soon`, its figures and the time of the one reading; the index
 * proposals name a table and a statement, never a column, and never apply anything.
 */
import { describe, expect, it } from "vitest";
import { testPlan } from "../../testing";
import type { DatabaseReading, Readings } from "../types";
import { THRESHOLDS } from "../types";
import { AT, GB, ids, reading, readingsOf, texts, validated } from "./__fixtures__/rule-readings";
import { databaseRules } from "./database";

const rules = validated(databaseRules);
const ONCE = "read once, at 2026-11-05 10:00 UTC";

/** A quiet database on the app's server, with `parts` instead. */
function db(parts: Partial<DatabaseReading> = {}): DatabaseReading {
  return {
    server: "app",
    service: "db",
    at: AT,
    blocked: [],
    sessions: [],
    connections: { count: 3, max: 100, reserved: 3 },
    statements: [],
    sizeBytes: 100 * 1024 ** 2,
    tables: [],
    ...parts,
  };
}

function readingsWith(databases: DatabaseReading[], more: Partial<Readings> = {}): Readings {
  return readingsOf(testPlan(), { databases, ...more });
}

const blocked = (waitedSec: number) => ({
  pid: 4321,
  user: "app",
  application: "worker",
  waitedSec,
  blockers: [4310],
  blockerApplication: "web",
});

const session = (state: string, openSec: number, querySec = openSec, pid = 4310) => ({
  pid,
  user: "app",
  application: "web",
  state,
  openSec,
  querySec,
});

describe("databaseRules", () => {
  it("proposes nothing for a quiet database, or without one", () => {
    expect(rules(readingsWith([db()]))).toEqual([]);
    expect(rules(readingsOf(testPlan()))).toEqual([]);
  });

  it("flags a session waiting for a lock from 30 seconds, now from 5 minutes", () => {
    const at = (sec: number) => rules(readingsWith([db({ blocked: [blocked(sec)] })]));
    expect(at(THRESHOLDS.dbBlockedSec - 1)).toEqual([]);
    expect(at(THRESHOLDS.dbBlockedSec)).toEqual([
      {
        id: "db.app.blocked",
        category: "reliability",
        urgency: "soon",
        server: "app",
        title: "Find what holds the lock sessions wait for in PostgreSQL db on server app",
        reasons: [
          {
            text: "Session 4321 waits for a lock held by session 4310 (the app `web`)",
            figure: `waited 30 seconds, ${ONCE}`,
            basis: { kind: "one-reading", at: AT },
          },
        ],
        apply: {
          kind: "manual",
          text: "Find what the app does in a long transaction. Ending the blocking session is your decision (`SELECT pg_terminate_backend(4310);` as the database's owner)",
        },
      },
    ]);
    expect(at(THRESHOLDS.dbBlockedSecNow - 1)[0]?.urgency).toBe("soon");
    expect(at(THRESHOLDS.dbBlockedSecNow)[0]).toMatchObject({
      urgency: "now",
      reasons: [{ figure: `waited 5 minutes, ${ONCE}` }],
    });
  });

  it("flags a transaction left open from 5 minutes, now from an hour", () => {
    const at = (sec: number, state = "idle in transaction") =>
      rules(readingsWith([db({ sessions: [session(state, sec)] })]));
    expect(at(THRESHOLDS.dbIdleSec - 1)).toEqual([]);
    const soon = at(THRESHOLDS.dbIdleSec);
    expect(ids(soon)).toEqual(["db.app.idle-transaction"]);
    expect(soon[0]?.urgency).toBe("soon");
    expect(texts(soon[0])).toBe(
      `Session 4310 (the app \`web\`) left a transaction open: it holds locks and keeps vacuum from cleaning [open 5 minutes, ${ONCE}]`,
    );
    expect(soon[0]?.apply).toEqual({
      kind: "manual",
      text: "Look for code that opens a transaction and waits (for a web call, say). The database's `idle_in_transaction_session_timeout` setting ends them by itself",
    });
    expect(at(THRESHOLDS.dbIdleSecNow, "idle in transaction (aborted)")[0]?.urgency).toBe("now");
  });

  it("flags a query active from 5 minutes, now from 30, leaving a lock wait to its own finding", () => {
    const at = (sec: number) =>
      rules(readingsWith([db({ sessions: [session("active", sec, sec, 4400)] })]));
    expect(at(THRESHOLDS.dbQuerySec - 1)).toEqual([]);
    expect(at(THRESHOLDS.dbQuerySec)).toEqual([
      expect.objectContaining({
        id: "db.app.long-query",
        urgency: "soon",
        reasons: [
          {
            text: "A query of session 4400 (the app `web`) is still running",
            figure: `for 5 minutes, ${ONCE}`,
            basis: { kind: "one-reading", at: AT },
          },
        ],
        apply: {
          kind: "manual",
          text: "Find the query in the app's code. Ending it is your decision (`SELECT pg_cancel_backend(4400);` as the database's owner)",
        },
      }),
    ]);
    expect(at(THRESHOLDS.dbQuerySecNow)[0]?.urgency).toBe("now");
    const waiting = db({
      blocked: [blocked(400)],
      sessions: [session("active", 400, 400, 4321)],
    });
    expect(ids(rules(readingsWith([waiting])))).toEqual(["db.app.blocked"]);
  });

  it("flags connections from 80% of those the app may open, now from 95%", () => {
    // 100 allowed, 3 reserved for the superuser: 97 for the app.
    const at = (count: number) =>
      rules(readingsWith([db({ connections: { count, max: 100, reserved: 3 } })]));
    expect(at(77)).toEqual([]);
    const soon = at(78);
    expect(soon[0]).toMatchObject({ id: "db.app.connections", urgency: "soon" });
    expect(texts(soon[0])).toBe(
      `The app opens nearly all connections the database allows [78 of 97 (80%), ${ONCE}]`,
    );
    expect(at(92)[0]?.urgency).toBe("soon");
    expect(at(93)[0]?.urgency).toBe("now");
  });

  it("flags statements of 500 ms on average with 50 calls or more, now from 2 seconds", () => {
    const statement = (meanMs: number, calls = 50) => ({
      text: "SELECT * FROM orders WHERE status = $1",
      calls,
      meanMs,
      share: 0.62,
    });
    const at = (...statements: ReturnType<typeof statement>[]) =>
      rules(readingsWith([db({ statements })]));
    expect(at(statement(499), statement(5000, 49))).toEqual([]);
    const soon = at(statement(500));
    expect(soon[0]).toMatchObject({
      id: "db.app.slow-queries",
      urgency: "soon",
      apply: { kind: "manual", text: "Look at each statement's filters for a missing index" },
    });
    expect(texts(soon[0])).toBe(
      `The statement \`SELECT * FROM orders WHERE status = $1\` is slow [500 ms on average over 50 calls, 62% of the database's time, ${ONCE}]`,
    );
    expect(at(statement(2000))[0]?.urgency).toBe("now");
  });

  it("flags a database of half its disk, now with the disk itself 85% full", () => {
    const at = (sizeGb: number, diskShare: number) =>
      rules(
        readingsWith([db({ sizeBytes: sizeGb * GB })], {
          servers: { app: { now: reading({ disk: diskShare }) } },
        }),
      );
    // A 40 GB disk.
    expect(at(19.9, 0.6)).toEqual([]);
    const soon = at(20, 0.6);
    expect(soon[0]).toMatchObject({ id: "db.app.size", urgency: "soon" });
    expect(texts(soon[0])).toBe(
      `The database takes a large part of server app's disk; one reading shows no growth [20.0 GB of 40.0 GB (50%), ${ONCE}]`,
    );
    expect(at(20, 0.85)[0]?.urgency).toBe("now");
    // Without the server's figures there is no disk to compare with.
    expect(rules(readingsWith([db({ sizeBytes: 30 * GB })]))).toEqual([]);
  });

  it("says the database didn't answer in time, now, with what it read before", () => {
    const proposals = rules(
      readingsWith([db({ timedOut: true, blocked: [blocked(400)], sessions: undefined })], {
        flags: " --env staging",
      }),
    );
    expect(ids(proposals)).toEqual(["db.app.timeout", "db.app.blocked"]);
    expect(proposals[0]).toEqual({
      id: "db.app.timeout",
      category: "reliability",
      urgency: "now",
      server: "app",
      title: "PostgreSQL db on server app did not answer in time",
      reasons: [
        {
          text: "The database did not answer a simple question in 3 seconds, so advise stopped reading it. It is under strain now",
          figure: ONCE,
          basis: { kind: "one-reading", at: AT },
        },
      ],
      apply: { kind: "command", command: "opscrew status --env staging" },
    });
  });

  it("names a service other than db, and a database on an extra server", () => {
    const other = db({ server: "data", service: "pg", blocked: [blocked(60)] });
    expect(ids(rules(readingsWith([other])))).toEqual(["db.data.blocked-pg"]);
    expect(rules(readingsWith([other]))[0]?.title).toBe(
      "Find what holds the lock sessions wait for in PostgreSQL pg on server data",
    );
  });
});

describe("databaseRules: index proposals (R23)", () => {
  const table = (o: Partial<NonNullable<DatabaseReading["tables"]>[number]> = {}) => ({
    name: "orders",
    seqScan: 100,
    seqRows: 100 * 5000,
    idxScan: 9,
    liveRows: 10_000,
    ...o,
  });

  it("flags a large table read in full often against few index scans, at each edge", () => {
    const at = (t: ReturnType<typeof table>) => ids(rules(readingsWith([db({ tables: [t] })])));
    expect(at(table())).toEqual(["db.app.index-orders"]);
    expect(at(table({ liveRows: 9999 }))).toEqual([]);
    expect(at(table({ seqScan: 99, seqRows: 99 * 5000 }))).toEqual([]);
    expect(at(table({ seqRows: 100 * 5000 - 1 }))).toEqual([]);
    expect(at(table({ idxScan: 10 }))).toEqual([]);
  });

  it("names the table and its slowest statement, never a column, and applies nothing", () => {
    const statements = [
      { text: "SELECT id FROM customers WHERE email = $1", calls: 10, meanMs: 3, share: 0.5 },
      { text: "SELECT * FROM Orders WHERE status = $1", calls: 10, meanMs: 3, share: 0.3 },
      { text: "SELECT * FROM orders_archive", calls: 10, meanMs: 3, share: 0.1 },
    ];
    const [proposal] = rules(readingsWith([db({ tables: [table()], statements })]));
    expect(proposal).toEqual({
      id: "db.app.index-orders",
      category: "reliability",
      urgency: "when-convenient",
      server: "app",
      title: "Look for a missing index on the table `orders` of PostgreSQL db on server app",
      reasons: [
        {
          text: "`orders` is often read in full: an index on the column its queries filter on may help",
          figure: `100 full reads of 5000 rows each against 9 index scans, ${ONCE}`,
          basis: { kind: "one-reading", at: AT },
        },
        {
          text: "The statement that mentions it and takes the most time: `SELECT * FROM Orders WHERE status = $1`",
          basis: { kind: "one-reading", at: AT },
        },
      ],
      apply: {
        kind: "manual",
        text: "Look at the query's plan (`EXPLAIN`) to find the column, then add the index yourself with `CREATE INDEX CONCURRENTLY`. OpsCrew never adds one",
      },
    });
    // No statement mentions it: the table alone.
    const [alone] = rules(readingsWith([db({ tables: [table()], statements: [] })]));
    expect(alone?.reasons).toHaveLength(1);
  });
});
