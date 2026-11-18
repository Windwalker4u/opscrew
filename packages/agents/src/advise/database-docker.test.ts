/**
 * Advise's database check against real PostgreSQL 14 and 17 in the local Docker (plan.md "20."):
 * each runs as a Compose project, as on a server; one session holds a lock in an open transaction
 * and another waits for it; the check, run through `docker compose -p <app> exec` exactly as on the
 * server, finds both, bounds its own session, and leaves the database, the two sessions and its
 * settings as they were. It pulls the two images, so it runs only with OPSCREW_DOCKER_TESTS=1, and
 * removes what it made (the images too, when they weren't there before).
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteExec } from "@opscrew/contracts";
import { NodeCommandRunner } from "@opscrew/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseCommand, readDatabase } from "./database";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  if (info.status !== 0 || info.stdout.trim() !== "linux") {
    return "no Docker engine for Linux containers is running";
  }
  const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return compose.status === 0 ? undefined : "Docker Compose is not installed";
}

const reason = skipReason();
if (reason) console.warn(`[agents] skipping advise's database check against Docker: ${reason}`);

/** Runs the docker CLI and returns its output; a failure fails the test with its error output. */
function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** This computer's shell as the server's: `sh -c` with the command's stdin. */
const runner = new NodeCommandRunner();
const shell: RemoteExec = {
  host: "localhost",
  run: (command, options) =>
    runner.run("sh", ["-c", command], {
      ...(options?.input === undefined ? {} : { input: options.input }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    }),
};

/** A psql session kept open in the project's `db`, fed `lines` (stdin stays open). */
function session(project: string, lines: string[]): ChildProcessWithoutNullStreams {
  const child = spawn("docker", [
    "compose",
    "-p",
    project,
    "exec",
    "-T",
    "db",
    "psql",
    "-X",
    "-q",
    "-At",
    "-U",
    "app",
    "-d",
    "app",
  ]);
  child.stdin.write(`${lines.join("\n")}\n`);
  return child;
}

/** Resolves once `child` printed `marker`, within a minute. */
function printed(child: ChildProcessWithoutNullStreams, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error(`psql did not print "${marker}" within a minute`)), 60_000);
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes(marker)) resolve();
    });
    child.on("exit", (code) => reject(new Error(`psql exited (${code}) before "${marker}"`)));
  });
}

/** Ends `child`'s session: its stdin closed, and waits for it to exit. */
function ended(child: ChildProcessWithoutNullStreams, last: string): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.on("exit", () => resolve());
    child.stdin.end(`${last}\n`);
  });
}

describe.skipIf(reason !== undefined).each([
  ["postgres:14-alpine", 14],
  ["postgres:17-alpine", 17],
])("advise's database check on %s", (image, major) => {
  const run = randomBytes(4).toString("hex");
  const project = `opscrew-test-${run}-pg${major}`;
  let dir = "";
  let file = "";
  let hadImage = false;

  /** `sql`'s rows in the project's database, read by the test itself (not the check). */
  const psql = (sql: string) =>
    docker(
      "compose",
      "-p",
      project,
      "exec",
      "-T",
      "db",
      "psql",
      "-X",
      "-At",
      "-U",
      "app",
      "-d",
      "app",
      "-c",
      sql,
    );

  /** What the check must leave as it was: the data, the objects, the roles, the extensions. */
  const state = () =>
    [
      "SELECT count(*), sum(id) FROM t",
      "SELECT count(*) FROM pg_class",
      "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles",
      "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension",
      "SELECT string_agg(name || '=' || setting, ',' ORDER BY name) FROM pg_settings WHERE source NOT IN ('default', 'override', 'client', 'session')",
    ].map(psql);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "opscrew-advise-db-"));
    file = join(dir, "compose.yaml");
    hadImage = spawnSync("docker", ["image", "inspect", image]).status === 0;
    // Generated here, never written down.
    const password = randomBytes(12).toString("hex");
    writeFileSync(
      file,
      [
        "services:",
        "  db:",
        `    image: ${image}`,
        "    environment:",
        "      POSTGRES_USER: app",
        "      POSTGRES_DB: app",
        `      POSTGRES_PASSWORD: ${password}`,
        "    healthcheck:",
        // Over TCP: the image's first-start server listens only on its socket.
        '      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U app -d app"]',
        "      interval: 1s",
        "      retries: 60",
        "",
      ].join("\n"),
    );
    docker("compose", "-p", project, "-f", file, "up", "-d", "--wait");
    psql(
      "CREATE TABLE t (id int PRIMARY KEY, v text); INSERT INTO t SELECT g, 'v' FROM generate_series(1, 100) g;",
    );
  }, 300_000);

  afterAll(() => {
    spawnSync("docker", ["compose", "-p", project, "-f", file, "down", "-v", "--remove-orphans"]);
    if (!hadImage) spawnSync("docker", ["image", "rm", image]);
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("finds a lock wait and an open transaction, and changes nothing", async () => {
    const before = state();
    const holder = session(project, [
      "SET application_name = 'holder';",
      "BEGIN;",
      "LOCK TABLE t IN ACCESS EXCLUSIVE MODE;",
      "SELECT 'locked';",
    ]);
    await printed(holder, "locked");
    const waiter = session(project, [
      "SET application_name = 'waiter';",
      "SELECT 'counted ' || count(*) FROM t;",
    ]);
    // Until the waiter waits for the lock.
    for (let i = 0; i < 20; i++) {
      if (
        psql(
          "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'waiter' AND wait_event_type = 'Lock'",
        ) === "1"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // This computer's Docker can take seconds per `docker compose exec`, a server's well under
    // one: the check's clock runs at a tenth of the real one, so its 20 seconds hold 7 queries here.
    const start = Date.now();
    const { reading, notRead } = await readDatabase(shell, {
      app: project,
      server: "app",
      service: "db",
      major,
      now: () => new Date(start + (Date.now() - start) / 10),
      redact: (text) => text,
    });

    expect(reading.timedOut).toBeUndefined();
    const holderPid = reading.sessions?.find((s) => s.application === "holder")?.pid;
    expect(reading.sessions).toContainEqual(
      expect.objectContaining({ application: "holder", state: "idle in transaction" }),
    );
    expect(reading.blocked).toEqual([
      expect.objectContaining({
        application: "waiter",
        blockers: [holderPid],
        blockerApplication: "holder",
      }),
    ]);
    expect(reading.connections?.max).toBeGreaterThan(0);
    expect(reading.sizeBytes).toBeGreaterThan(0);
    expect(reading.tables).toContainEqual(expect.objectContaining({ name: "t" }));
    // The plain image has no pg_stat_statements: the slow queries are not read, with the steps.
    expect(notRead).toEqual([
      expect.stringMatching(
        /^PostgreSQL db on server app: slow queries are not read: turn `pg_stat_statements` on/,
      ),
    ]);

    // Its own sessions ended, and both planted ones still run: the check ended nothing.
    expect(
      psql(
        "SELECT string_agg(application_name, ',' ORDER BY application_name) FROM pg_stat_activity WHERE application_name IN ('holder', 'waiter', 'opscrew-advise')",
      ),
    ).toBe("holder,waiter");
    // The session the check runs in is read-only and bounded.
    const bounds = await shell.run(databaseCommand(project, "db"), {
      input:
        "SELECT current_setting('default_transaction_read_only'), current_setting('statement_timeout'), current_setting('lock_timeout'), current_setting('application_name');",
      timeoutMs: 20_000,
    });
    expect(bounds.stdout.trim().split("\0")).toEqual(["on", "3s", "500ms", "opscrew-advise"]);

    await ended(holder, "ROLLBACK;");
    await ended(waiter, "");
    expect(state()).toEqual(before);
  }, 400_000);
});
