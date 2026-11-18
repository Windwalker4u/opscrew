import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type DrillRecord, drillRecord } from "../../drill";
import { Account, agentSkipReason, CAN_LINK, phpRelease } from "../__fixtures__/account";
import { AGENT_SH, type AgentSettings, DRILL_LOGIN_FILE, renderAgentSettings } from "../agent";

/*
 * The hosting agent's scheduled restore drill (029 T2938, research R28, R29): the agent run by bash
 * with DRILL_SCHEDULE in its settings, the clock (date), the time limit (timeout) and the account's
 * quota (quota) played by shims this file adds to the account's PATH.
 */

const reason = agentSkipReason();
if (reason !== undefined) console.warn(`[iac-templates] skipping the scheduled drills: ${reason}`);

const LOGIN =
  "[client]\nuser=acct_notes_drill\npassword=x\nhost=localhost\n[mysql]\ndatabase=acct_notes_drill\n";
const DUMP = [
  "-- MariaDB dump 10.19",
  "CREATE TABLE `notes` (",
  "  `id` int NOT NULL",
  ");",
  "INSERT INTO `notes` VALUES (1);",
  "CREATE TABLE `users` (",
  "  `id` int NOT NULL",
  ");",
  "",
].join("\n");
const OLDER = "snapshot-20261101T100000Z";
const NEWER = "snapshot-20261110T100000Z";

/** The start of the slot (3 hours into the week, or the day, UTC) this week or day, in seconds. */
function slotStart(every: "weekly" | "daily"): number {
  const period = every === "weekly" ? 168 : 24;
  return (Math.floor(Date.now() / 3_600_000 / period) * period + 3) * 3600;
}

const SHIMS: Record<string, string> = {
  // The clock: $STUB/now's epoch seconds when it is there.
  date: [
    "#!/bin/bash",
    'real=/usr/bin/date; [ -x "$real" ] || real=/bin/date',
    'if [ -f "$STUB/now" ]; then exec "$real" -d "@$(cat "$STUB/now")" "$@"; fi',
    'exec "$real" "$@"',
  ].join("\n"),
  // The time limit: logs its seconds and command; with $STUB/expire, a limit of more than 60
  // seconds runs out before its command does anything.
  timeout: [
    "#!/bin/bash",
    'echo "timeout $1 $2" >> "$STUB/timeout.log"',
    'if [ -f "$STUB/expire" ] && [ "$1" -gt 60 ]; then exit 124; fi',
    "shift",
    'exec "$@"',
  ].join("\n"),
  // The account's quota: $STUB/quota's lines when it is there, else none.
  quota: [
    "#!/bin/bash",
    'echo "quota $*" >> "$STUB/quota.log"',
    'if [ -f "$STUB/quota" ]; then cat "$STUB/quota"; else echo "Disk quotas for user acct (uid 1001): none"; fi',
  ].join("\n"),
};

const accounts: Account[] = [];
afterEach(() => {
  for (const made of accounts.splice(0)) made.remove();
});

/**
 * An account after its first run (outside the slot), with the drill database's login unless
 * `login` is false, and `drillSchedule` in its settings unless it is null.
 */
function account(
  o: { login?: boolean; every?: AgentSettings["drillSchedule"] | null } = {},
): Account {
  const every = o.every === null ? undefined : (o.every ?? "weekly");
  const a = new Account(every === undefined ? {} : { drillSchedule: every });
  accounts.push(a);
  for (const [name, text] of Object.entries(SHIMS)) {
    writeFileSync(`${a.root}/bin/${name}`, `${text}\n`);
    chmodSync(`${a.root}/bin/${name}`, 0o755);
  }
  at(a, slotStart("weekly") - 7200);
  expect(a.run().status).toBe(0);
  if (o.login !== false) writeFileSync(`${a.dir}/${DRILL_LOGIN_FILE}`, LOGIN);
  return a;
}

/** Sets the account's clock to `seconds` since the epoch. */
function at(a: Account, seconds: number): void {
  writeFileSync(`${a.stub}/now`, String(seconds));
}

/** The snapshot `id` in dumps/: a dump with two tables. */
function snapshot(a: Account, id: string, dump = DUMP): void {
  mkdirSync(`${a.dir}/dumps`, { recursive: true });
  writeFileSync(`${a.dir}/dumps/${id}.sql.gz`, gzipSync(dump));
}

/** The records of state/drills.log. */
function records(a: Account): DrillRecord[] {
  const lines = (a.file("state/drills.log") ?? "").split("\n").filter(Boolean);
  return lines.map((line) => {
    const record = drillRecord(line);
    expect(record, line).toBeDefined();
    return record as DrillRecord;
  });
}

/** One run of the agent, which must end well. */
function runAt(a: Account, seconds: number): void {
  at(a, seconds);
  const run = a.run();
  expect(run.status, run.output).toBe(0);
}

describe.skipIf(reason !== undefined)(
  "the hosting agent's scheduled restore drill",
  { timeout: 180_000 },
  () => {
    it("drills the newest snapshot once in its slot, into the drill database only", () => {
      const a = account();
      snapshot(a, OLDER);
      snapshot(a, NEWER);
      writeFileSync(`${a.dir}/dumps/1-1.sql.gz`, gzipSync(DUMP));
      const before = readFileSync(`${a.dir}/dumps/${NEWER}.sql.gz`);
      const slot = slotStart("weekly");

      runAt(a, slot - 60);
      expect(a.file("state/drills.log")).toBeUndefined();

      writeFileSync(`${a.stub}/mysql.log`, "");
      runAt(a, slot + 60);
      expect(records(a)).toEqual([
        expect.objectContaining({
          kind: "scheduled",
          result: "healthy",
          id: NEWER,
          tables: [{ service: "database", count: 2 }],
          removal: "removed",
        }),
      ]);
      expect(a.stubFile("timeout.log")).toContain("timeout 1800 bash");
      // The drill database is empty again; the app's database and the snapshot are as they were.
      expect(a.stubFile("drill-db")).toBe("");
      expect(a.stubFile("db")).toBe("state=initial\n");
      expect(readFileSync(`${a.dir}/dumps/${NEWER}.sql.gz`)).toEqual(before);
      for (const call of a.stubFile("mysql.log").split("\n").filter(Boolean)) {
        expect(call.startsWith(`mysql --defaults-file=${DRILL_LOGIN_FILE}`), call).toBe(true);
      }
      expect(a.file("state/agent.log")).toContain(
        `Scheduled restore drill of the snapshot ${NEWER}.`,
      );

      // Later in the slot, and in the next one with no newer snapshot: nothing more.
      runAt(a, slot + 1800);
      runAt(a, slot + 168 * 3600 + 60);
      expect(records(a)).toHaveLength(1);

      // A newer snapshot is drilled in the next slot.
      const newest = "snapshot-20261112T100000Z";
      snapshot(a, newest);
      runAt(a, slot + 2 * 168 * 3600 + 60);
      expect(records(a).map((r) => [r.kind, r.result, r.id])).toEqual([
        ["scheduled", "healthy", NEWER],
        ["scheduled", "healthy", newest],
      ]);
    });

    it("runs daily in the slot of each day", () => {
      const a = account({ every: "daily" });
      snapshot(a, OLDER);
      const slot = slotStart("daily");
      runAt(a, slot + 60);
      snapshot(a, NEWER);
      runAt(a, slot + 24 * 3600 + 60);
      expect(records(a).map((r) => r.id)).toEqual([OLDER, NEWER]);
    });

    it("drills nothing without the setting", () => {
      const a = account({ every: null });
      snapshot(a, NEWER);
      runAt(a, slotStart("weekly") + 60);
      runAt(a, slotStart("daily") + 60);
      expect(a.file("state/drills.log")).toBeUndefined();
      expect(a.stubFile("timeout.log")).not.toContain("timeout 1800");
    });

    it("records a skip once a slot, and drills the snapshot in a later slot", () => {
      const a = account();
      const slot = slotStart("weekly");
      // No snapshot yet.
      runAt(a, slot + 60);
      runAt(a, slot + 120);
      expect(records(a)).toEqual([
        expect.objectContaining({ kind: "scheduled", result: "skipped", reason: "none" }),
      ]);
      expect(records(a)[0]?.id).toBeUndefined();

      // The quota leaves 1 KiB, less than the dump: skipped, the drill database untouched.
      snapshot(a, NEWER, `${DUMP}-- ${"x".repeat(4000)}\n`.repeat(4));
      writeFileSync(
        `${a.stub}/quota`,
        [
          "Disk quotas for user acct (uid 1001):",
          "     Filesystem  blocks   quota   limit   grace   files   quota   limit   grace",
          "      /dev/sda1  102400* 102400  102400  6days     1234       0       0",
          "",
        ].join("\n"),
      );
      writeFileSync(`${a.stub}/mysql.log`, "");
      runAt(a, slot + 168 * 3600 + 60);
      runAt(a, slot + 168 * 3600 + 120);
      expect(records(a)[1]).toMatchObject({ result: "skipped", id: NEWER, reason: "quota" });
      expect(records(a)).toHaveLength(2);
      expect(a.stubFile("mysql.log")).toBe("");

      // Room again: the same snapshot is drilled in the next slot.
      writeFileSync(
        `${a.stub}/quota`,
        "      /dev/sda1  1000  0  1048576   1234       0       0\n",
      );
      runAt(a, slot + 2 * 168 * 3600 + 60);
      expect(records(a)[2]).toMatchObject({ result: "healthy", id: NEWER });
    });

    it("skips a dump without the drill database's login", () => {
      const a = account({ login: false });
      snapshot(a, NEWER);
      runAt(a, slotStart("weekly") + 60);
      expect(records(a)).toEqual([
        expect.objectContaining({ result: "skipped", id: NEWER, reason: "login" }),
      ]);
      expect(a.stubFile("timeout.log")).not.toContain("timeout 1800");
    });

    it("stops at its time limit, empties the drill database and records it failed", () => {
      const a = account();
      snapshot(a, NEWER);
      // What the load had made when the limit ran out.
      writeFileSync(`${a.stub}/drill-db`, "CREATE TABLE `notes` (\n");
      writeFileSync(`${a.stub}/expire`, "");
      runAt(a, slotStart("weekly") + 60);
      expect(records(a)).toEqual([
        expect.objectContaining({
          kind: "scheduled",
          result: "failed",
          id: NEWER,
          removal: "removed",
          reason: "timeout",
        }),
      ]);
      expect(a.stubFile("drill-db")).toBe("");
      expect(a.stubFile("db")).toBe("state=initial\n");

      // Its result stands for that snapshot: the next slot drills only a newer one.
      rmSync(`${a.stub}/expire`);
      runAt(a, slotStart("weekly") + 168 * 3600 + 60);
      expect(records(a)).toHaveLength(1);
    });

    it("stops a drill by hand at the same limit, answering its failed record", () => {
      const a = account();
      snapshot(a, NEWER);
      writeFileSync(`${a.stub}/drill-db`, "CREATE TABLE `notes` (\n");
      writeFileSync(`${a.stub}/expire`, "");
      at(a, slotStart("weekly") - 3600);
      const expires = slotStart("weekly");
      const request = (seconds: number) =>
        a.request(`kind=drill\nhash=${"cd".repeat(32)}\nexpires=${seconds}\nsnapshot=${NEWER}\n`);
      const name = request(expires);
      expect(a.run().status).toBe(0);
      const answer = a.keyValues(`state/${name}.result`);
      expect(answer).toEqual({ result: "done", record: expect.any(String) });
      expect(drillRecord(answer.record ?? "")).toMatchObject({
        kind: "manual",
        result: "failed",
        id: NEWER,
        removal: "removed",
        reason: "timeout",
      });
      expect(a.file("state/drills.log")).toBe(`${answer.record}\n`);
      expect(a.stubFile("drill-db")).toBe("");
      expect(a.stubFile("timeout.log")).toContain("timeout 1800 bash");
      expect(a.file("state/drill.out")).toBeUndefined();

      // Within the limit, the answer carries the drill's own record and the expected count.
      rmSync(`${a.stub}/expire`);
      const again = request(expires + 1);
      expect(a.run().status).toBe(0);
      const done = a.keyValues(`state/${again}.result`);
      expect(done).toMatchObject({ result: "done", expected: "2" });
      expect(drillRecord(done.record ?? "")).toMatchObject({ kind: "manual", result: "healthy" });
    });

    // A deploy switches a link (Git for Windows' ln copies a folder instead).
    it.skipIf(!CAN_LINK)("deploys a release first, in the same run under the agent's lock", () => {
      const a = account();
      snapshot(a, NEWER);
      a.publish(phpRelease("v1"), { run: 7 });
      runAt(a, slotStart("weekly") + 60);
      const log = a.file("state/agent.log") ?? "";
      expect(log.indexOf("Deploying release 7-1")).toBeGreaterThan(-1);
      expect(log.indexOf(`Scheduled restore drill of the snapshot ${NEWER}.`)).toBeGreaterThan(
        log.indexOf("Deploying release 7-1"),
      );
      expect(records(a)).toHaveLength(1);
    });
  },
);

/** The body of the shell function `name` in the agent. */
function functionText(name: string): string {
  const start = AGENT_SH.indexOf(`\n${name}() {\n`);
  const end = AGENT_SH.indexOf("\n}\n", start);
  expect(start, name).toBeGreaterThan(-1);
  return AGENT_SH.slice(start, end + 2);
}

describe("the hosting agent's scheduled drill routine", () => {
  it("never names the app's database, its login or its files, nor a panel", () => {
    for (const name of [
      "newest_snapshot",
      "quota_room",
      "drill_line",
      "limited_drill",
      "scheduled_drill",
    ]) {
      const text = functionText(name);
      expect(text, name).not.toMatch(/\$\{?DATABASE\b/);
      for (const word of [
        "mysql.cnf",
        "app_mysql",
        "mysqldump",
        "take_snapshot",
        "shared/",
        "load ",
        "curl",
        "uapi",
        "token",
      ]) {
        expect(text, `${name}: ${word}`).not.toContain(word);
      }
    }
    // Both kinds of drill run for 30 minutes at most.
    expect(functionText("limited_drill")).toContain(
      'timeout 1800 bash -c \'set -eu -o pipefail; drill_snapshot "$1" "$2";',
    );
    expect(functionText("do_drill")).toContain('limited_drill "$id" manual');
    const scheduled = functionText("scheduled_drill");
    expect(scheduled).toContain('limited_drill "$id" scheduled');
    expect(scheduled).toContain("weekly) every=168 ;;");
    expect(scheduled).toContain("daily) every=24 ;;");
    expect(scheduled).toContain("% every)) -eq 3 ]");
    // After the releases, in the run that holds the lock.
    expect(AGENT_SH).toMatch(/\n {2}new_release\n[\s\S]*\n {2}scheduled_drill\n\}\n/);
  });
});

describe("renderAgentSettings' drill schedule", () => {
  const base: AgentSettings = {
    app: "notes",
    environment: "prod",
    hostname: "notes.example.com",
    repository: "acme/notes",
    releaseBranch: "opscrew/release/prod",
    webRoot: "public",
    healthPath: "/",
    appKind: "static",
    sharedPaths: [],
    snapshots: false,
  };

  it("carries the schedule, or none", () => {
    expect(renderAgentSettings({ ...base, drillSchedule: "daily" })).toContain(
      "\nDRILL_SCHEDULE='daily'\n",
    );
    expect(renderAgentSettings(base)).toContain("\nDRILL_SCHEDULE=''\n");
  });

  it("refuses another value", () => {
    expect(() =>
      renderAgentSettings({ ...base, drillSchedule: "hourly" as AgentSettings["drillSchedule"] }),
    ).toThrow("The hosting agent's setting drillSchedule must be weekly, daily or absent.");
  });
});
