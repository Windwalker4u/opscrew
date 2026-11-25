/**
 * A database with the app's two logins (047, ADR 0037) in a move against the local Docker, through
 * `sides/postgres.ts` as on a side reached over SSH: two PostgreSQL 17 containers of the catalog's
 * image, each made as the catalog's setup step makes it (`loginsSetup`), the old one with a table
 * its migration made as `app_owner`. The dump is copied with the carrier and loaded on the new
 * side, which refuses first while the new side lacks the logins. Afterwards the owners and grants
 * hold there, a narrowed grant stays narrowed, and `app_runtime` writes with the new side's own
 * password but can't change the schema. No password reaches a one-off container's Env or Cmd. It
 * pulls the pinned postgres and busybox images, so it runs only with OPSCREW_DOCKER_TESTS=1, and
 * removes what it made (the images too, when they weren't there before).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  type DockerClient,
  dialStdioTransport,
  dockerClient,
  volumeCarrier,
} from "@opscrew/connector-docker";
import type { DockerTransport } from "@opscrew/contracts";
import { NodeStreamRunner } from "@opscrew/core";
import {
  IMAGES,
  loginsCheck,
  loginsSetup,
  OWNER_PASSWORD_ENV,
  RUNTIME_PASSWORD_ENV,
} from "@opscrew/iac-templates";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkCopiedDump,
  dumpPostgres,
  ensureDumpVolume,
  type MovePostgres,
  moveDumpVolume,
  removeDumpVolume,
  restoreCheckedDump,
} from "./sides/postgres";
import type { SideDocker } from "./sides/types";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[agents] skipping PostgreSQL's two logins in a move: ${reason}`);

/** A pinned `name:tag@sha256:…` as `name@sha256:…`, the form `docker image inspect` finds. */
const byDigest = (ref: string) => ref.replace(/:[^:@/]+@/, "@");

/** Runs the docker CLI; a failure fails the test with its error output. */
function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

describe.skipIf(reason !== undefined)("PostgreSQL's two logins in a move against Docker", () => {
  const run = randomBytes(4).toString("hex");
  const runner = new NodeStreamRunner();
  const transports = [1, 2].map(() =>
    dialStdioTransport(() => runner.open("docker", ["system", "dial-stdio"])),
  );
  /** Every container the move created through the API: its image, Env and Cmd. */
  const created: { Image: string; Env?: string[]; Cmd?: string[] }[] = [];
  const recording = (transport: DockerTransport): DockerTransport => ({
    async request(request) {
      if (request.method === "POST" && request.path.startsWith("/containers/create")) {
        if (typeof request.body === "string") created.push(JSON.parse(request.body));
      }
      return transport.request(request);
    },
  });
  const [oldClient, newClient] = transports.map((transport) =>
    dockerClient(recording(transport)),
  ) as [DockerClient, DockerClient];
  const side = (client: DockerClient): SideDocker => ({
    client,
    carrier: volumeCarrier(client, IMAGES.busybox.ref),
    close: async () => {},
  });
  /** Each side's own passwords: the superuser's, the owner's and the runtime login's. */
  const secrets = (["a", "b"] as const).map(() => ({
    app: randomBytes(12).toString("hex"),
    owner: randomBytes(12).toString("hex"),
    runtime: randomBytes(12).toString("hex"),
  }));
  const [oldDb, newDb] = (["a", "b"] as const).map(
    (name, i): MovePostgres => ({
      app: `opscrew-test-${run}-${name}`,
      project: `opscrew-test-${run}-${name}`,
      service: "db",
      password: secrets[i]?.app ?? "",
      ownerPassword: secrets[i]?.owner ?? "",
    }),
  ) as [MovePostgres, MovePostgres];
  const container = (db: MovePostgres) => `${db.project}-db-1`;
  const secretsOf = (db: MovePostgres) =>
    secrets[db === oldDb ? 0 : 1] ?? { owner: "", runtime: "" };
  const hadImages = new Map<string, boolean>();

  /** Runs `script` with sh in the side's database container, as the catalog's steps run there. */
  const sh = (db: MovePostgres, script: string, env: Record<string, string> = {}) =>
    spawnSync(
      "docker",
      [
        "exec",
        ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
        container(db),
        "sh",
        "-c",
        script,
      ],
      { encoding: "utf8" },
    );
  /**
   * Runs `sql` as `login` with its password over the container's own address, which the image
   * checks passwords on (unlike its socket and 127.0.0.1).
   */
  const as = (db: MovePostgres, login: "app_owner" | "app_runtime", sql: string) => {
    const password = login === "app_owner" ? secretsOf(db).owner : secretsOf(db).runtime;
    return sh(
      db,
      `psql -X -q -w -v ON_ERROR_STOP=1 -h "$HOSTNAME" -U ${login} -d app -tAc "$OPSCREW_SQL"`,
      { PGPASSWORD: password, OPSCREW_SQL: sql },
    );
  };
  /** The superuser's answer to `sql`, over the socket. */
  const query = (db: MovePostgres, sql: string) =>
    docker("exec", container(db), "psql", "-X", "-U", "app", "-d", "app", "-tAc", sql);

  beforeAll(async () => {
    for (const ref of [IMAGES.postgres.ref, IMAGES.busybox.ref]) {
      hadImages.set(ref, spawnSync("docker", ["image", "inspect", byDigest(ref)]).status === 0);
    }
    // Each side's database as the catalog runs it with two logins: their passwords in its env.
    for (const db of [oldDb, newDb]) {
      const own = secretsOf(db);
      docker("network", "create", "--label", `opscrew.test=${run}`, `${db.project}_internal`);
      docker(
        "run",
        "-d",
        "--name",
        container(db),
        "--label",
        `opscrew.test=${run}`,
        "--network",
        `${db.project}_internal`,
        "--network-alias",
        db.service,
        "-e",
        "POSTGRES_USER=app",
        "-e",
        "POSTGRES_DB=app",
        "-e",
        `POSTGRES_PASSWORD=${db.password}`,
        "-e",
        `${OWNER_PASSWORD_ENV}=${own.owner}`,
        "-e",
        `${RUNTIME_PASSWORD_ENV}=${own.runtime}`,
        IMAGES.postgres.ref,
      );
    }
    // Ready once it listens on TCP: the image's first-start server listens on its socket only.
    for (const db of [oldDb, newDb]) {
      for (let attempt = 0; ; attempt++) {
        const ready = spawnSync("docker", [
          "exec",
          container(db),
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "app",
          "-d",
          "app",
        ]);
        if (ready.status === 0) break;
        if (attempt > 120) throw new Error(`${container(db)} did not become ready`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // The old side, switched by its deploy's setup step, then the app's migration as the owner,
    // which narrows one of the runtime login's rights.
    expect(sh(oldDb, loginsSetup("db")).status).toBe(0);
    const migrated = as(
      oldDb,
      "app_owner",
      "CREATE TABLE orders (id serial PRIMARY KEY, item text); INSERT INTO orders (item) VALUES ('tea'), ('cake'); CREATE TABLE audit (line text); REVOKE DELETE ON audit FROM app_runtime;",
    );
    expect(migrated.stderr).toBe("");
    expect(migrated.status).toBe(0);
    query(newDb, "CREATE TABLE stale (id int)");
  }, 300_000);

  afterAll(async () => {
    for (const [client, db] of [
      [oldClient, oldDb],
      [newClient, newDb],
    ] as const) {
      await removeDumpVolume(client, db.app).catch(() => {});
      spawnSync("docker", ["rm", "-fv", container(db)]);
      spawnSync("docker", ["network", "rm", `${db.project}_internal`]);
    }
    for (const transport of transports) await transport.close?.();
    for (const [ref, had] of hadImages) {
      if (!had) spawnSync("docker", ["image", "rm", byDigest(ref)]);
    }
  }, 120_000);

  it("moves the switched database, its owners and grants holding on the new side", async () => {
    const old = side(oldClient);
    const fresh = side(newClient);
    const digest = await dumpPostgres(old, oldDb);
    const from = { kind: "volume", name: moveDumpVolume(oldDb.app) } as const;
    const to = { kind: "volume", name: await ensureDumpVolume(newClient, newDb.app) } as const;
    await fresh.carrier.writeVolume(to, await old.carrier.readVolume(from));
    await checkCopiedDump(fresh, newDb, digest);

    // The new side's deploy hasn't made the logins: the load refuses, dropping nothing.
    await expect(restoreCheckedDump(fresh, newDb)).rejects.toThrow(
      "PostgreSQL db has no logins app_owner and app_runtime, so OpsCrew loaded nothing into it.",
    );
    expect(query(newDb, "SELECT to_regclass('stale') IS NOT NULL")).toBe("t");

    // Once its deploy's setup step made them, the dump loads.
    expect(sh(newDb, loginsSetup("db")).status).toBe(0);
    await restoreCheckedDump(fresh, newDb);
    expect(query(newDb, "SELECT string_agg(item, ',' ORDER BY id) FROM orders")).toBe("tea,cake");
    expect(query(newDb, "SELECT to_regclass('stale') IS NULL")).toBe("t");
    expect(sh(newDb, loginsCheck()).status).toBe(0);
    expect(
      query(
        newDb,
        "SELECT pg_get_userbyid(d.datdba) || ' ' || (SELECT string_agg(DISTINCT pg_get_userbyid(c.relowner), ',') FROM pg_class c WHERE c.relname IN ('orders', 'orders_id_seq', 'audit')) FROM pg_database d WHERE d.datname = 'app'",
      ),
    ).toBe("app_owner app_owner");

    // The runtime login writes with the new side's password, keeps its narrowed right, and can't
    // change the schema.
    const wrote = as(
      newDb,
      "app_runtime",
      "INSERT INTO orders (item) VALUES ('scone') RETURNING id",
    );
    expect(wrote.stdout.trim()).toBe("3");
    expect(as(newDb, "app_runtime", "INSERT INTO audit VALUES ('x')").status).toBe(0);
    expect(as(newDb, "app_runtime", "DELETE FROM audit").stderr).toContain("permission denied");
    expect(as(newDb, "app_runtime", "CREATE TABLE mine (id int)").stderr).toContain(
      "permission denied",
    );
    expect(as(newDb, "app_owner", "ALTER TABLE orders ADD COLUMN note text").status).toBe(0);

    // No password in a one-off container's Env or Cmd.
    for (const spec of created) {
      for (const own of secrets) {
        for (const password of Object.values(own)) {
          expect(JSON.stringify([spec.Env, spec.Cmd])).not.toContain(password);
        }
      }
    }
    for (const [client, db] of [
      [oldClient, oldDb],
      [newClient, newDb],
    ] as const) {
      await removeDumpVolume(client, db.app);
      expect(await client.volumeExists(moveDumpVolume(db.app))).toBe(false);
    }
  }, 300_000);
});
