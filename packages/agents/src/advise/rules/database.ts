/**
 * Advise's database rules (feature 029, plan.md "20.", research R22 and R23): what one reading of a
 * PostgreSQL service's statistics shows, as Reliability findings with their figures and the time of
 * the reading: a session waiting for a lock, a transaction left open, a long query, connections near
 * the limit, slow statements, the database's share of its disk, a query that timed out, and tables
 * read in full that may miss an index (named, never an index to apply).
 */
import { plural } from "@opscrew/core";
import { sizeText } from "../../retarget/texts";
import { databaseWords, STATEMENT_TIMEOUT_MS } from "../database";
import {
  type DatabaseReading,
  type Proposal,
  type Readings,
  THRESHOLDS,
  type Urgency,
} from "../types";
import { percent } from "./shared";

/** The findings of each PostgreSQL service read. */
export function databaseRules(readings: Readings): Proposal[] {
  return (readings.databases ?? []).flatMap((db) => [
    ...timeoutFinding(db, readings.flags),
    ...blockedFinding(db),
    ...idleFinding(db),
    ...longQueryFinding(db),
    ...connectionsFinding(db),
    ...slowFinding(db),
    ...sizeFinding(db, readings),
    ...indexProposals(db),
  ]);
}

/** `db.<server>.<what>`, with the service's name after `what` when it isn't `db`. */
function idOf(db: DatabaseReading, what: string): string {
  return `db.${db.server}.${what}${db.service === "db" ? "" : `-${db.service}`}`;
}

/** `read once, at 2026-11-05 10:00 UTC`. */
function readOnce(db: DatabaseReading): string {
  return `read once, at ${db.at.slice(0, 10)} ${db.at.slice(11, 16)} UTC`;
}

/** The fields every finding of `db` shares. */
function finding(db: DatabaseReading, what: string, urgency: Urgency) {
  return {
    id: idOf(db, what),
    category: "reliability" as const,
    urgency,
    server: db.server,
  };
}

/** A reason with `figure`, when it has one, and the time of the reading. */
function measured(db: DatabaseReading, text: string, figure?: string) {
  return {
    text,
    figure: figure === undefined ? readOnce(db) : `${figure}, ${readOnce(db)}`,
    basis: { kind: "one-reading" as const, at: db.at },
  };
}

/** `45 seconds`, `6 minutes`, `2 hours`: whole units, rounded down. */
function waitText(seconds: number): string {
  if (seconds < 60) return plural(seconds, "second");
  if (seconds < 3600) return plural(Math.floor(seconds / 60), "minute");
  return plural(Math.floor(seconds / 3600), "hour");
}

/** `450 ms`, `2.3 s`. */
function msText(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** ` (the app `web`)`, or nothing without an application name. */
function appWords(application: string | undefined): string {
  return application === undefined || application === "" ? "" : ` (the app \`${application}\`)`;
}

/** A query hit the session's time limit, which stopped the check: the database is under strain. */
function timeoutFinding(db: DatabaseReading, flags: string): Proposal[] {
  if (db.timedOut !== true) return [];
  const seconds = STATEMENT_TIMEOUT_MS / 1000;
  return [
    {
      ...finding(db, "timeout", "now"),
      title: `${databaseWords(db.server, db.service)} did not answer in time`,
      reasons: [
        measured(
          db,
          `The database did not answer a simple question in ${seconds} seconds, so advise stopped reading it. It is under strain now`,
        ),
      ],
      apply: { kind: "command", command: `opscrew status${flags}` },
    },
  ];
}

/** Sessions waiting for a lock `dbBlockedSec` or more (`now` from `dbBlockedSecNow`). */
function blockedFinding(db: DatabaseReading): Proposal[] {
  const blocked = (db.blocked ?? []).filter((s) => s.waitedSec >= THRESHOLDS.dbBlockedSec);
  const first = blocked[0];
  if (first === undefined) return [];
  const now = blocked.some((s) => s.waitedSec >= THRESHOLDS.dbBlockedSecNow);
  const blocker = first.blockers[0] ?? 0;
  return [
    {
      ...finding(db, "blocked", now ? "now" : "soon"),
      title: `Find what holds the lock sessions wait for in ${databaseWords(db.server, db.service)}`,
      reasons: blocked.map((s) =>
        measured(
          db,
          `Session ${s.pid} waits for a lock held by session ${s.blockers.join(", ")}${appWords(s.blockerApplication)}`,
          `waited ${waitText(s.waitedSec)}`,
        ),
      ),
      apply: {
        kind: "manual",
        text: `Find what the app does in a long transaction. Ending the blocking session is your decision (\`SELECT pg_terminate_backend(${blocker});\` as the database's owner)`,
      },
    },
  ];
}

/** Transactions left open, idle, `dbIdleSec` or more (`now` from `dbIdleSecNow`). */
function idleFinding(db: DatabaseReading): Proposal[] {
  const idle = (db.sessions ?? []).filter(
    (s) => s.state.startsWith("idle in transaction") && s.openSec >= THRESHOLDS.dbIdleSec,
  );
  if (idle.length === 0) return [];
  const now = idle.some((s) => s.openSec >= THRESHOLDS.dbIdleSecNow);
  return [
    {
      ...finding(db, "idle-transaction", now ? "now" : "soon"),
      title: `Close the transactions left open in ${databaseWords(db.server, db.service)}`,
      reasons: idle.map((s) =>
        measured(
          db,
          `Session ${s.pid}${appWords(s.application)} left a transaction open: it holds locks and keeps vacuum from cleaning`,
          `open ${waitText(s.openSec)}`,
        ),
      ),
      apply: {
        kind: "manual",
        text: "Look for code that opens a transaction and waits (for a web call, say). The database's `idle_in_transaction_session_timeout` setting ends them by itself",
      },
    },
  ];
}

/**
 * Queries active `dbQuerySec` or more (`now` from `dbQuerySecNow`), those waiting for a lock left
 * to {@link blockedFinding}.
 */
function longQueryFinding(db: DatabaseReading): Proposal[] {
  const waiting = new Set((db.blocked ?? []).map((s) => s.pid));
  const long = (db.sessions ?? []).filter(
    (s) => s.state === "active" && !waiting.has(s.pid) && s.querySec >= THRESHOLDS.dbQuerySec,
  );
  const first = long[0];
  if (first === undefined) return [];
  const now = long.some((s) => s.querySec >= THRESHOLDS.dbQuerySecNow);
  return [
    {
      ...finding(db, "long-query", now ? "now" : "soon"),
      title: `Find the long queries in ${databaseWords(db.server, db.service)}`,
      reasons: long.map((s) =>
        measured(
          db,
          `A query of session ${s.pid}${appWords(s.application)} is still running`,
          `for ${waitText(s.querySec)}`,
        ),
      ),
      apply: {
        kind: "manual",
        text: `Find the query in the app's code. Ending it is your decision (\`SELECT pg_cancel_backend(${first.pid});\` as the database's owner)`,
      },
    },
  ];
}

/** Client connections at `dbConnections` of the ones the app may open (`now` at `dbConnectionsNow`). */
function connectionsFinding(db: DatabaseReading): Proposal[] {
  const c = db.connections;
  if (c === undefined) return [];
  const allowed = c.max - c.reserved;
  const share = allowed > 0 ? c.count / allowed : 1;
  if (share < THRESHOLDS.dbConnections) return [];
  return [
    {
      ...finding(db, "connections", share >= THRESHOLDS.dbConnectionsNow ? "now" : "soon"),
      title: `Lower the connections the app opens to ${databaseWords(db.server, db.service)}`,
      reasons: [
        measured(
          db,
          "The app opens nearly all connections the database allows",
          `${c.count} of ${allowed} (${percent(share)})`,
        ),
      ],
      apply: {
        kind: "manual",
        text: "Lower the app's pool size, add a pooler (PgBouncer), or raise `max_connections` in the database's settings (it costs memory)",
      },
    },
  ];
}

/** True when `s` is slow: `dbSlowMs` on average with `dbSlowCalls` calls or more. */
function isSlow(s: { calls: number; meanMs: number }): boolean {
  return s.calls >= THRESHOLDS.dbSlowCalls && s.meanMs >= THRESHOLDS.dbSlowMs;
}

/** Statements of the top 5 by time that are slow (`now` at `dbSlowMsNow`). */
function slowFinding(db: DatabaseReading): Proposal[] {
  const slow = (db.statements ?? []).filter(isSlow);
  if (slow.length === 0) return [];
  const now = slow.some((s) => s.meanMs >= THRESHOLDS.dbSlowMsNow);
  return [
    {
      ...finding(db, "slow-queries", now ? "now" : "soon"),
      title: `Speed up the slow statements of ${databaseWords(db.server, db.service)}`,
      reasons: slow.map((s) =>
        measured(
          db,
          `The statement \`${s.text}\` is slow`,
          `${msText(s.meanMs)} on average over ${plural(s.calls, "call")}, ${percent(s.share)} of the database's time`,
        ),
      ),
      apply: { kind: "manual", text: "Look at each statement's filters for a missing index" },
    },
  ];
}

/**
 * The database `dbDiskShare` of its server's disk or more (`soon`), `now` with the disk itself
 * `diskHigh` full.
 */
function sizeFinding(db: DatabaseReading, readings: Readings): Proposal[] {
  const disk = readings.servers[db.server]?.now.server?.disk;
  if (db.sizeBytes === undefined || disk === undefined || disk.totalBytes === 0) return [];
  const share = db.sizeBytes / disk.totalBytes;
  if (share < THRESHOLDS.dbDiskShare) return [];
  const full = disk.usedBytes / (disk.usedBytes + disk.freeBytes) >= THRESHOLDS.diskHigh;
  return [
    {
      ...finding(db, "size", full ? "now" : "soon"),
      title: `Make room for ${databaseWords(db.server, db.service)}`,
      reasons: [
        measured(
          db,
          `The database takes a large part of server ${db.server}'s disk; one reading shows no growth`,
          `${sizeText(db.sizeBytes)} of ${sizeText(disk.totalBytes)} (${percent(share)})`,
        ),
      ],
      apply: {
        kind: "manual",
        text: "Delete data the app no longer needs, or give the database more disk: a larger server type, or a server of its own",
      },
    },
  ];
}

/** True when `table` is read in full often against few index scans (R23's rule). */
function missesIndex(t: NonNullable<DatabaseReading["tables"]>[number]): boolean {
  return (
    t.liveRows >= THRESHOLDS.dbIndexRows &&
    t.seqScan >= THRESHOLDS.dbIndexSeqScans &&
    t.seqRows / t.seqScan >= THRESHOLDS.dbIndexRowsPerScan &&
    t.idxScan < t.seqScan * THRESHOLDS.dbIndexScanShare
  );
}

/** `text` safe inside a regular expression. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Each table R23's rule flags: it names the table and the slowest statement that mentions it, never
 * a column (OpsCrew can't know which) and never an index to apply.
 */
function indexProposals(db: DatabaseReading): Proposal[] {
  return (db.tables ?? []).filter(missesIndex).map((t): Proposal => {
    const mention = new RegExp(`\\b${escaped(t.name)}\\b`, "i");
    const statement = (db.statements ?? []).find((s) => mention.test(s.text));
    return {
      ...finding(db, `index-${t.name}`, "when-convenient"),
      title: `Look for a missing index on the table \`${t.name}\` of ${databaseWords(db.server, db.service)}`,
      reasons: [
        measured(
          db,
          `\`${t.name}\` is often read in full: an index on the column its queries filter on may help`,
          `${plural(t.seqScan, "full read")} of ${Math.round(t.seqRows / t.seqScan)} rows each against ${plural(t.idxScan, "index scan")}`,
        ),
        ...(statement === undefined
          ? []
          : [
              {
                text: `The statement that mentions it and takes the most time: \`${statement.text}\``,
                basis: { kind: "one-reading" as const, at: db.at },
              },
            ]),
      ],
      apply: {
        kind: "manual",
        text: "Look at the query's plan (`EXPLAIN`) to find the column, then add the index yourself with `CREATE INDEX CONCURRENTLY`. OpsCrew never adds one",
      },
    };
  });
}
