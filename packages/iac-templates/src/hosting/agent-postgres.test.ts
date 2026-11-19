import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { fakeSecret } from "@opscrew/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { type DrillRecord, drillRecord } from "../drill";
import { Account, agentSkipReason } from "./__fixtures__/account";
import { AGENT_SH, type AgentSettings, DRILL_PGPASS_FILE, renderAgentSettings } from "./agent";

/*
 * The hosting agent on a PostgreSQL database (029 T2949, US10, FR-2926): the agent run by bash, with
 * the fake pg_dump and psql (shims/pg_dump.sh, shims/psql.sh) playing the app's database and the
 * drill database, signed in through the pgpass files shared/pgpass and keys/drill.pgpass.
 */

const reason = agentSkipReason();
if (reason !== undefined) console.warn(`[iac-templates] skipping the PostgreSQL agent: ${reason}`);
/** Whether this machine has a psql of its own, which would answer where the fake one is removed. */
const BASH_PSQL = spawnSync("bash", ["-c", "command -v psql"], { encoding: "utf8" }).status === 0;

const HASH = "ef".repeat(32);
const ID = "snapshot-20261119T120000Z";
const PASSWORD = fakeSecret("generic-password", "pgpass");
const DRILL_PASSWORD = fakeSecret("generic-password", "drill-pgpass");
const DUMP = [
  "-- PostgreSQL database dump",
  "SET statement_timeout = 0;",
  "CREATE TABLE public.notes (",
  "    id integer NOT NULL",
  ");",
  "CREATE TABLE public.users (",
  "    id integer NOT NULL",
  ");",
  "CREATE VIEW public.recent AS",
  " SELECT id FROM public.notes;",
  "COPY public.notes (id) FROM stdin;",
  "1",
  "\\.",
  "",
].join("\n");

/** One pgpass line, `:` and `\` escaped as libpq requires. */
function pgpassLine(database: string, user: string, password: string): string {
  return `localhost:5432:${database}:${user}:${password.replace(/[\\:]/g, "\\$&")}\n`;
}

const accounts: Account[] = [];
afterEach(() => {
  for (const made of accounts.splice(0)) made.remove();
});

/**
 * An account whose app's database is PostgreSQL, its login shared/pgpass (no shared/mysql.cnf),
 * after its first run; with the drill database's login unless `drill` is false.
 */
function account(o: { drill?: boolean } = {}): Account {
  const a = new Account({ databaseEngine: "postgres" });
  accounts.push(a);
  rmSync(`${a.dir}/shared/mysql.cnf`);
  writeFileSync(`${a.dir}/shared/pgpass`, pgpassLine("acct_notes", "acct_notes", PASSWORD), {
    mode: 0o600,
  });
  expect(a.run().status).toBe(0);
  if (o.drill !== false) {
    writeFileSync(
      `${a.dir}/${DRILL_PGPASS_FILE}`,
      pgpassLine("acct_notes_drill", "acct_notes_drill", DRILL_PASSWORD),
      { mode: 0o600 },
    );
  }
  return a;
}

let sent = 0;
/** A request (another expiry each time, so another name) carried out by one run; its answer. */
function ask(
  a: Account,
  { kind, ...fields }: { kind: string; snapshot?: string },
): Record<string, string> {
  sent += 1;
  const expires = Math.floor(Date.now() / 1000) + 1800 + sent;
  const text = Object.entries({ kind, hash: HASH, expires: String(expires), ...fields })
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  const name = a.request(text);
  expect(a.run().status).toBe(0);
  return a.keyValues(`state/${name}.result`);
}

/** The fake clients' calls, one per line. */
function calls(a: Account): string[] {
  return a.stubFile("pg.log").split("\n").filter(Boolean);
}

/** Every file the agent wrote that a person or the CLI reads, which must never hold a password. */
function printed(a: Account): string {
  const answers = readdirSync(`${a.dir}/state`).map((f) => a.file(`state/${f}`) ?? "");
  return [...answers, a.stubFile("pg.log")].join("\n");
}

function recordOf(answer: Record<string, string>): DrillRecord {
  const record = drillRecord(answer.record ?? "");
  expect(record, answer.record).toBeDefined();
  return record as DrillRecord;
}

/** The snapshot `id` in dumps/ with the dump `text` (gzipped) alone. */
function snapshot(a: Account, text: string, id = ID): void {
  mkdirSync(`${a.dir}/dumps`, { recursive: true });
  writeFileSync(`${a.dir}/dumps/${id}.sql.gz`, gzipSync(text));
}

const LOGIN = "-w -h localhost -p 5432 -U acct_notes -d acct_notes";
const DRILL_LOGIN = "-w -h localhost -p 5432 -U acct_notes_drill -d acct_notes_drill";

describe("renderAgentSettings with a database engine", () => {
  const settings: AgentSettings = {
    app: "notes",
    environment: "prod",
    hostname: "notes.example.com",
    repository: "acme/notes",
    releaseBranch: "opscrew/release/prod",
    webRoot: "public",
    healthPath: "/",
    appKind: "php",
    sharedPaths: [".env"],
    snapshots: true,
    database: "acct_notes",
  };

  it("renders DB_ENGINE after the database, and nothing without an engine", () => {
    const lines = (engine?: AgentSettings["databaseEngine"]) =>
      renderAgentSettings({ ...settings, databaseEngine: engine }).split("\n");
    const postgres = lines("postgres");
    expect(postgres[postgres.indexOf("DATABASE='acct_notes'") + 1]).toBe("DB_ENGINE='postgres'");
    expect(lines("mysql")).toContain("DB_ENGINE='mysql'");
    expect(lines().some((line) => line.startsWith("DB_ENGINE="))).toBe(false);
  });

  it("refuses another engine, naming the field", () => {
    expect(() =>
      renderAgentSettings({
        ...settings,
        databaseEngine: "sqlite" as AgentSettings["databaseEngine"],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_INPUT",
        message: expect.stringContaining(" databaseEngine "),
      }),
    );
  });
});

describe.skipIf(reason !== undefined)(
  "the hosting agent on PostgreSQL",
  { timeout: 180_000 },
  () => {
    it("reports pg_dump and psql in the tools, not mysqldump", () => {
      const report = account().keyValues("state/report");
      expect(report["tool.pg_dump"]).toBe("yes");
      expect(report["tool.psql"]).toBe("yes");
      expect(report["tool.mysqldump"]).toBeUndefined();
      expect(Object.keys(report).filter((key) => key.startsWith("tool."))).toEqual([
        "tool.git",
        "tool.openssl",
        "tool.flock",
        "tool.pg_dump",
        "tool.psql",
        "tool.tar",
        "tool.curl",
        "tool.ssh",
        "tool.ssh-keygen",
      ]);
    });

    it.skipIf(BASH_PSQL)("reports a missing psql", () => {
      const a = new Account({ databaseEngine: "postgres" });
      accounts.push(a);
      rmSync(`${a.root}/bin/psql`);
      expect(a.run().status).toBe(0);
      expect(a.keyValues("state/report")).toMatchObject({
        "tool.pg_dump": "yes",
        "tool.psql": "no",
      });
    });

    it("dumps the database with pg_dump through shared/pgpass, and restores it with psql", () => {
      const a = account();
      writeFileSync(`${a.stub}/db`, "state=before\n");
      mkdirSync(`${a.dir}/shared/storage`);
      writeFileSync(`${a.dir}/shared/storage/upload.txt`, "before");
      const taken = ask(a, { kind: "snapshot" });
      const id = (taken.dump ?? "").replace(/\.sql\.gz$/, "");
      expect(taken).toEqual({
        result: "done",
        dump: `${id}.sql.gz`,
        shared: `${id}.shared.tar.gz`,
      });
      const dump = gunzipSync(readFileSync(`${a.dir}/dumps/${taken.dump}`)).toString("utf8");
      expect(dump).toContain("-- PostgreSQL database dump");
      expect(dump).toContain("state=before");
      expect(calls(a)).toEqual([
        `pg_dump ${LOGIN} --no-owner --no-privileges PGPASSFILE=shared/pgpass`,
      ]);
      if (process.platform !== "win32") {
        expect(statSync(`${a.dir}/dumps/${taken.dump}`).mode & 0o777).toBe(0o600);
      }
      // The login stays out of the shared files' copy, as the other settings files do.
      const listed = spawnSync(
        "bash",
        ["-c", 'cd "$1" && tar -tzf "$2"', "_", `${a.dir}/dumps`, taken.shared ?? ""],
        {
          encoding: "utf8",
        },
      );
      expect(listed.stdout.split("\n").filter(Boolean).sort()).toEqual([
        "./storage/",
        "./storage/upload.txt",
      ]);

      writeFileSync(`${a.stub}/db`, "state=after\n");
      writeFileSync(`${a.stub}/pg.log`, "");
      const restored = ask(a, { kind: "restore", snapshot: id });
      expect(restored).toEqual({ result: "done", saved: expect.stringMatching(/^snapshot-\S+$/) });
      expect(a.stubFile("db")).toBe("state=before\n");
      // The current database dumped first, then emptied and loaded, stopping at the first error.
      const made = calls(a);
      expect(made[0]).toBe(`pg_dump ${LOGIN} --no-owner --no-privileges PGPASSFILE=shared/pgpass`);
      expect(made.slice(1)).toEqual([
        expect.stringMatching(new RegExp(`^psql ${LOGIN} -X -q -A -t -c SELECT format\\('DROP `)),
        `psql ${LOGIN} -X -q -v ON_ERROR_STOP=1 PGPASSFILE=shared/pgpass`,
      ]);
      expect(made[1]).toMatch(/ PGPASSFILE=shared\/pgpass$/);
      expect(a.file("shared/pgpass")).toBe(pgpassLine("acct_notes", "acct_notes", PASSWORD));
      expect(new Set(a.stubFile("logins").split("\n").filter(Boolean))).toEqual(
        new Set(["pg_dump acct_notes", "psql acct_notes"]),
      );
      expect(a.stubFile("mysql.log")).toBe("");
      expect(printed(a)).not.toContain(PASSWORD);
    });

    it("puts the database back when the restore's load fails", () => {
      const a = account();
      writeFileSync(`${a.stub}/db`, "state=before\n");
      const taken = ask(a, { kind: "snapshot" });
      writeFileSync(`${a.stub}/db`, "state=after\n");
      writeFileSync(`${a.stub}/refuse`, "state=before");
      const id = (taken.dump ?? "").replace(/\.sql\.gz$/, "");
      expect(ask(a, { kind: "restore", snapshot: id })).toEqual({
        result: "failed",
        reason: "the restore failed: the database is back as it was",
        saved: expect.stringMatching(/^snapshot-\S+$/),
      });
      expect(a.stubFile("db")).toBe("state=after\n");
    });

    it("drills the snapshot in the drill database alone, counting its base tables", () => {
      const a = account();
      snapshot(a, DUMP);
      // What a run that stopped part-way left in the drill database: it goes first.
      writeFileSync(`${a.stub}/drill-db`, "CREATE TABLE public.left (\n");
      writeFileSync(`${a.stub}/pg.log`, "");
      const answer = ask(a, { kind: "drill", snapshot: ID });
      expect(answer).toEqual({ result: "done", record: expect.any(String), expected: "2" });
      expect(recordOf(answer)).toMatchObject({
        kind: "manual",
        result: "healthy",
        id: ID,
        tables: [{ service: "database", count: 2 }],
        removal: "removed",
      });
      // Emptied again, the app's database untouched; the load saw the drops, then the dump.
      expect(a.stubFile("drill-db")).toBe("");
      expect(a.stubFile("db")).toBe("state=initial\n");
      expect(a.stubFile("drill-input")).toContain(
        "DROP TABLE IF EXISTS public.left CASCADE;\n-- PostgreSQL database dump",
      );
      const made = calls(a);
      expect(made.length).toBeGreaterThan(0);
      for (const call of made) {
        expect(call, call).toMatch(new RegExp(`^psql ${DRILL_LOGIN} -X -q `));
        expect(call).toMatch(/ PGPASSFILE=keys\/drill\.pgpass$/);
      }
      expect(made.some((call) => call.includes("-v ON_ERROR_STOP=1"))).toBe(true);
      expect(made.some((call) => call.includes("table_schema = 'public'"))).toBe(true);
      expect(new Set(a.stubFile("logins").split("\n").filter(Boolean))).toEqual(
        new Set(["psql acct_notes_drill"]),
      );
      expect(a.file("state/drills.log")).toBe(`${answer.record}\n`);
      expect(printed(a)).not.toContain(DRILL_PASSWORD);
    });

    it("tells a drill whose table is missing, and one whose load fails, apart", () => {
      const a = account();
      snapshot(a, DUMP, "snapshot-a");
      writeFileSync(`${a.stub}/drill-count`, "1\n");
      expect(recordOf(ask(a, { kind: "drill", snapshot: "snapshot-a" }))).toMatchObject({
        result: "not-restored",
        reason: "tables",
        tables: [{ service: "database", count: 1 }],
        removal: "removed",
      });

      rmSync(`${a.stub}/drill-count`);
      writeFileSync(`${a.stub}/drill-refuse`, "");
      snapshot(a, DUMP, "snapshot-b");
      expect(recordOf(ask(a, { kind: "drill", snapshot: "snapshot-b" }))).toMatchObject({
        result: "not-restored",
        reason: "database",
        removal: "removed",
      });
      expect(a.stubFile("drill-db")).toBe("");
    });

    it("refuses a drill without the drill database's pgpass file", () => {
      const a = account({ drill: false });
      snapshot(a, DUMP);
      expect(ask(a, { kind: "drill", snapshot: ID })).toEqual({
        result: "refused",
        reason: `restore drills are off here: ${DRILL_PGPASS_FILE}, the drill database's login, isn't there`,
      });
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

describe("the hosting agent's PostgreSQL routines", () => {
  it("drill without naming the app's database, its login or its files", () => {
    for (const name of ["drill_psql", "pg_drill_database"]) {
      const text = functionText(name);
      expect(text, name).not.toMatch(/\$\{?DATABASE\b/);
      for (const word of ["shared/", "app_psql", "pg_dump", "load "]) {
        expect(text, `${name}: ${word}`).not.toContain(word);
      }
    }
  });

  it("empty schema public's tables, views and sequences, never the schema", () => {
    const text = functionText("pg_replace_tables");
    for (const word of ["n.nspname = 'public'", "'VIEW'", "'SEQUENCE'", "-v ON_ERROR_STOP=1"]) {
      expect(text).toContain(word);
    }
    expect(text).not.toMatch(/DROP SCHEMA|\$\{?DATABASE\b|shared\//);
  });
});
