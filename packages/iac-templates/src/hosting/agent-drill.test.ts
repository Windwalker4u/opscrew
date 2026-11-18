import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { type DrillRecord, drillRecord } from "../drill";
import { Account, agentSkipReason } from "./__fixtures__/account";
import { AGENT_SH, DRILL_LOGIN_FILE } from "./agent";

/*
 * Restore drills on a hosting account (029 T2935, research R25): the agent run by bash on a `drill`
 * request, with the fake mysql playing the drill database (shims/mysql.sh).
 */

const reason = agentSkipReason();
if (reason !== undefined) console.warn(`[iac-templates] skipping the agent's drills: ${reason}`);

const HASH = "cd".repeat(32);
const ID = "snapshot-20261118T120000Z";
const LOGIN =
  "[client]\nuser=acct_notes_drill\npassword=x\nhost=localhost\n[mysql]\ndatabase=acct_notes_drill\n";
const DUMP = [
  "-- MariaDB dump 10.19",
  "DROP TABLE IF EXISTS `notes`;",
  "CREATE TABLE `notes` (",
  "  `id` int NOT NULL",
  ");",
  "INSERT INTO `notes` VALUES (1);",
  "CREATE TABLE `users` (",
  "  `id` int NOT NULL",
  ");",
  "/*!50001 CREATE TABLE `recent` (",
  "  `id` int",
  ") */;",
  "",
].join("\n");

const accounts: Account[] = [];
afterEach(() => {
  for (const made of accounts.splice(0)) made.remove();
});

/** An account after its first run, with the drill database's login unless `login` is false. */
function account(o: { login?: boolean; database?: boolean } = {}): Account {
  const a = new Account(o.database === false ? { database: undefined, snapshots: false } : {});
  accounts.push(a);
  a.run();
  if (o.login !== false) writeFileSync(`${a.dir}/${DRILL_LOGIN_FILE}`, LOGIN);
  return a;
}

/** The snapshot `id` in dumps/: its dump (bytes as given, gzipped text otherwise) and shared files. */
function snapshot(
  a: Account,
  o: { dump?: string | Buffer; shared?: string | false } = {},
  id = ID,
) {
  mkdirSync(`${a.dir}/dumps`, { recursive: true });
  if (o.dump !== undefined) {
    const bytes = typeof o.dump === "string" ? gzipSync(o.dump) : o.dump;
    writeFileSync(`${a.dir}/dumps/${id}.sql.gz`, bytes);
  }
  if (o.shared === false) return;
  if (o.shared !== undefined) {
    writeFileSync(`${a.dir}/dumps/${id}.shared.tar.gz`, o.shared);
    return;
  }
  const from = `${a.root}/shared-copy`;
  mkdirSync(`${from}/storage`, { recursive: true });
  writeFileSync(`${from}/storage/upload.txt`, "photo");
  // From inside dumps/: GNU tar takes a `D:` in an archive's name for a remote host.
  const made = spawnSync(
    "bash",
    [
      "-c",
      'cd "$2" && tar -czf "$3" -C "$1" ./storage',
      "_",
      from,
      `${a.dir}/dumps`,
      `${id}.shared.tar.gz`,
    ],
    { encoding: "utf8" },
  );
  expect(made.status, made.stderr).toBe(0);
}

let sent = 0;
/** A drill request for `id` (another expiry each time, so another name), carried out by one run. */
function drill(a: Account, id = ID): Record<string, string> {
  sent += 1;
  const expires = Math.floor(Date.now() / 1000) + 1800 + sent;
  const name = a.request(`kind=drill\nhash=${HASH}\nexpires=${expires}\nsnapshot=${id}\n`);
  expect(a.run().status).toBe(0);
  return a.keyValues(`state/${name}.result`);
}

/** The record an answer carries. */
function recordOf(answer: Record<string, string>): DrillRecord {
  const record = drillRecord(answer.record ?? "");
  expect(record, answer.record).toBeDefined();
  return record as DrillRecord;
}

describe.skipIf(reason !== undefined)(
  "the hosting agent's restore drill",
  { timeout: 180_000 },
  () => {
    it("loads the dump into the drill database only, counts its tables and empties it again", () => {
      const a = account();
      snapshot(a, { dump: DUMP });
      // What a run that stopped part-way left in the drill database: it goes first.
      writeFileSync(`${a.stub}/drill-db`, "CREATE TABLE `left` (\n");
      const before = readFileSync(`${a.dir}/dumps/${ID}.sql.gz`);
      writeFileSync(`${a.stub}/mysql.log`, "");

      const answer = drill(a);
      expect(answer).toEqual({ result: "done", record: expect.any(String), expected: "2" });
      const record = recordOf(answer);
      expect(record).toMatchObject({
        kind: "manual",
        result: "healthy",
        id: ID,
        parts: [
          { name: "database", size: before.length, seconds: expect.any(Number) },
          { name: "files", size: expect.any(Number), seconds: expect.any(Number) },
        ],
        tables: [{ service: "database", count: 2 }],
        removal: "removed",
        cleaned: false,
      });
      expect(record.reason).toBeUndefined();
      // The drill database is empty again; the app's database and the snapshot are as they were.
      expect(a.stubFile("drill-db")).toBe("");
      expect(a.stubFile("db")).toBe("state=initial\n");
      expect(readFileSync(`${a.dir}/dumps/${ID}.sql.gz`)).toEqual(before);
      // Every database call was the drill database's, signed in with its own login alone.
      const calls = a.stubFile("mysql.log").split("\n").filter(Boolean);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.startsWith(`mysql --defaults-file=${DRILL_LOGIN_FILE}`), call).toBe(true);
        expect(call).not.toContain("acct_notes");
        expect(call).not.toContain("mysql.cnf");
      }
      expect(a.file("state/drills.log")).toBe(`${answer.record}\n`);
      expect(a.file("state/agent.log")).toContain(`Restore drill of the snapshot ${ID}: healthy.`);
    });

    it("loads views and triggers without their DEFINER=, as the drill's own user, the dump unchanged", () => {
      const a = account();
      // The account's own login, which must never take the drill user's place, and the socket
      // its option files name, which is all the drill takes of them.
      writeFileSync(`${a.home}/.my.cnf`, "[client]\nuser=acct\npassword=other\n");
      writeFileSync(
        `${a.stub}/print-defaults`,
        "--user=acct\n--password=other\n--socket=/var/lib/mysql/mysql.sock\n",
      );
      const definer = "DEFINER=`acct_notes`@`localhost`";
      const dump = [
        DUMP,
        "INSERT INTO `notes` VALUES (2,'a note quoting DEFINER=`x`@`y`');",
        "/*!50001 CREATE ALGORITHM=UNDEFINED */",
        `/*!50013 ${definer} SQL SECURITY DEFINER */`,
        "/*!50001 VIEW `recent` AS select `notes`.`id` AS `id` from `notes` */;",
        `/*!50003 CREATE*/ /*!50017 ${definer}*/ /*!50003 TRIGGER \`notes_bi\` BEFORE INSERT ON \`notes\` FOR EACH ROW SET NEW.id = NEW.id */;;`,
        "",
      ].join("\n");
      snapshot(a, { dump, shared: false });
      const before = readFileSync(`${a.dir}/dumps/${ID}.sql.gz`);

      expect(recordOf(drill(a))).toMatchObject({
        result: "healthy",
        tables: [{ service: "database", count: 2 }],
      });
      const loaded = a.stubFile("drill-input");
      expect(loaded).not.toContain(definer);
      expect(loaded).toContain("/*!50013  SQL SECURITY DEFINER */");
      expect(loaded).toContain("/*!50017 */ /*!50003 TRIGGER `notes_bi` BEFORE INSERT ON `notes`");
      expect(loaded).toContain("VIEW `recent` AS select");
      // A row's text passes as it is.
      expect(loaded).toContain("'a note quoting DEFINER=`x`@`y`'");
      expect(readFileSync(`${a.dir}/dumps/${ID}.sql.gz`)).toEqual(before);
      // Every call signed in as the drill's user, never as the account's, on the account's socket.
      expect(new Set(a.stubFile("logins").split("\n").filter(Boolean))).toEqual(
        new Set(["mysql acct_notes_drill"]),
      );
      for (const call of a.stubFile("mysql.log").split("\n").filter(Boolean)) {
        expect(call).toMatch(
          /^mysql --defaults-file=keys\/drill\.cnf --socket=\/var\/lib\/mysql\/mysql\.sock( |$)/,
        );
        expect(call).not.toMatch(/--user|--password|other/);
      }
    });

    it("tells a dump that is no gzip file, one that doesn't load and tables that don't match apart", () => {
      const a = account();
      snapshot(a, { dump: Buffer.from("not a gzip file"), shared: false }, "snapshot-a");
      const broken = recordOf(drill(a, "snapshot-a"));
      expect(broken).toMatchObject({
        result: "not-restored",
        reason: "dump",
        parts: [],
        tables: [],
      });
      expect(broken.removal).toBeUndefined();
      expect(a.stubFile("mysql.log")).toBe("");

      snapshot(a, { dump: Buffer.alloc(0), shared: false }, "snapshot-b");
      expect(recordOf(drill(a, "snapshot-b"))).toMatchObject({
        result: "not-restored",
        reason: "dump",
      });

      // A load that stops part-way: the drill database is emptied all the same.
      snapshot(a, { dump: DUMP, shared: false }, "snapshot-c");
      writeFileSync(`${a.stub}/drill-refuse`, "");
      const refused = drill(a, "snapshot-c");
      expect(refused.expected).toBe("2");
      expect(recordOf(refused)).toMatchObject({
        result: "not-restored",
        reason: "database",
        parts: [],
        removal: "removed",
      });
      expect(a.stubFile("drill-db")).toBe("");

      // The load goes through this time, and the count says one table.
      rmSync(`${a.stub}/drill-refuse`);
      writeFileSync(`${a.stub}/drill-count`, "1\n");
      snapshot(a, { dump: DUMP, shared: false }, "snapshot-d");
      const short = drill(a, "snapshot-d");
      expect(recordOf(short)).toMatchObject({
        result: "not-restored",
        reason: "tables",
        tables: [{ service: "database", count: 1 }],
        removal: "removed",
      });

      // A dump with no table restores nothing worth calling a backup.
      rmSync(`${a.stub}/drill-count`);
      snapshot(a, { dump: "-- MariaDB dump 10.19\n", shared: false }, "snapshot-e");
      const empty = drill(a, "snapshot-e");
      expect(empty.expected).toBe("0");
      expect(recordOf(empty)).toMatchObject({
        result: "not-restored",
        reason: "tables",
        tables: [{ service: "database", count: 0 }],
      });

      snapshot(a, { dump: DUMP, shared: "not a tar" }, "snapshot-f");
      expect(recordOf(drill(a, "snapshot-f"))).toMatchObject({
        result: "not-restored",
        reason: "files",
        parts: [{ name: "database" }],
      });
      expect(a.stubFile("db")).toBe("state=initial\n");
      expect((a.file("state/drills.log") ?? "").trim().split("\n")).toHaveLength(6);
    });

    it("refuses a snapshot it doesn't keep, and a dump without the drill database's login", () => {
      const a = account({ login: false });
      expect(drill(a, "nope")).toEqual({
        result: "refused",
        reason: "the snapshot nope isn't in dumps/",
      });
      snapshot(a, { dump: DUMP });
      expect(drill(a)).toEqual({
        result: "refused",
        reason: `restore drills are off here: ${DRILL_LOGIN_FILE}, the drill database's login, isn't there`,
      });
      expect(a.file("state/drills.log")).toBeUndefined();
    });

    it("lists the shared files alone of an app without a database", () => {
      const a = account({ login: false, database: false });
      snapshot(a, {});
      const answer = drill(a);
      expect(answer.expected).toBeUndefined();
      expect(recordOf(answer)).toMatchObject({
        result: "healthy",
        parts: [{ name: "files" }],
        tables: [],
      });
      expect(a.stubFile("mysql.log")).toBe("");
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

describe("the hosting agent's drill routine", () => {
  it("never names the app's database, its login or its files", () => {
    for (const name of ["drill_mysql", "drill_snapshot", "do_drill"]) {
      const text = functionText(name);
      expect(text, name).not.toMatch(/\$\{?DATABASE\b/);
      for (const word of [
        "mysql.cnf",
        "app_mysql",
        "mysqldump",
        "take_snapshot",
        "shared/",
        "load ",
      ]) {
        expect(text, `${name}: ${word}`).not.toContain(word);
      }
    }
    // Its login alone: no other option file of the account's is read.
    expect(functionText("drill_mysql")).toMatch(
      /\n {2}mysql --defaults-file=keys\/drill\.cnf \$\{MYSQL_SOCKET:\+"--socket=\$MYSQL_SOCKET"\} "\$@"\n/,
    );
    expect(functionText("drill_snapshot")).toContain('replace_tables "$dump" drill_mysql');
    // The replace routine both share takes its database from its caller.
    expect(functionText("replace_tables")).not.toMatch(/\$\{?DATABASE\b|mysql\.cnf/);
  });
});
