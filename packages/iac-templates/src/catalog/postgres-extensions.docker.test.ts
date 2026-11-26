/**
 * Real Docker tests for PostgreSQL extensions (feature 045):
 * 1. Fresh `pgvector/pgvector:0.8.7-pg17-trixie` with `logins: separate` + `vector` & `pg_trgm`:
 *    superuser setup before `loginsSetup` and migrations, `app_owner` creates vector(3) table +
 *    HNSW/trgm indexes, `app_runtime` inserts & queries `<->`, and `pg_dump` + `loginsLoad`
 *    restores cleanly while `app_owner` stays non-superuser.
 * 2. `postgis/postgis:17-3.7-alpine` with `logins: separate` + `postgis` & `postgis_raster`:
 *    geometry data and `spatial_ref_sys` are preserved across in-place restore, drill
 *    (`setup: true`), and move (`setup: false`), while `app_owner` remains non-superuser and
 *    `app_runtime` queries geometry & `spatial_ref_sys`. Also verifies that 047's `loginsSetup`
 *    keeps superuser ownership on an extension-created schema (e.g. `topology` from
 *    `postgis_topology`, whose `pg_depend` entry has `deptype = 'n'`).
 *
 * Runs only with OPSCREW_DOCKER_TESTS=1. Removes every container and volume it creates in afterAll.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { docker } from "../__fixtures__/docker";
import { IMAGES } from "../pins";
import { skipReason } from "../workflow/__fixtures__/sh";
import { extensionsCheck, extensionsSetup } from "./postgres-extensions";
import {
  loginsCheck,
  loginsLoad,
  loginsSetup,
  OWNER_PASSWORD_ENV,
  POSTGRES_OWNER,
  POSTGRES_RUNTIME,
  type PostgresLogin,
  RUNTIME_PASSWORD_ENV,
} from "./postgres-logins";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping PostgreSQL extensions on Docker: ${reason}`);

const RUN = randomBytes(3).toString("hex");
const started: string[] = [];
const HOOK_MS = 300_000;

afterAll(() => {
  for (const name of started) spawnSync("docker", ["rm", "-fv", name], { stdio: "ignore" });
}, HOOK_MS);

function dockerEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*", ...env };
}

interface Result {
  status: number | null;
  stdout: string;
  output: string;
}

function attempt(args: string[], env: Record<string, string> = {}, input = ""): Result {
  const result = spawnSync("docker", args, { env: dockerEnv(env), input, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    output: `${result.stdout}${result.stderr}`,
  };
}

const envFlags = (env: Record<string, string>) => Object.keys(env).flatMap((k) => ["-e", k]);

class ExtDatabase {
  readonly name: string;
  readonly passwords: { superuser: string; owner: string; runtime: string };

  constructor(
    readonly image: string,
    label: string,
    passwords?: { superuser: string; owner: string; runtime: string },
  ) {
    this.name = `opscrew-ext-${RUN}-${label}`;
    this.passwords = passwords ?? {
      superuser: fakeSecret("generic-password", `${this.name}-superuser`),
      owner: fakeSecret("generic-password", `${this.name}-owner`),
      runtime: fakeSecret("generic-password", `${this.name}-runtime`),
    };
  }

  async start(): Promise<void> {
    const env = {
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: this.passwords.superuser,
      [OWNER_PASSWORD_ENV]: this.passwords.owner,
      [RUNTIME_PASSWORD_ENV]: this.passwords.runtime,
    };
    started.push(this.name);
    docker(["run", "-d", "--name", this.name, "--hostname", "db", ...envFlags(env), this.image], {
      env: dockerEnv(env),
    });
    const deadline = Date.now() + 180_000;
    const ready = [
      "exec",
      this.name,
      "pg_isready",
      "-q",
      "-h",
      "127.0.0.1",
      "-U",
      "app",
      "-d",
      "app",
    ];
    while (attempt(ready).status !== 0) {
      if (Date.now() > deadline) throw new Error(`${this.name} (${this.image}) did not start.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  sh(script: string, env: Record<string, string> = {}): Result {
    return attempt(["exec", ...envFlags(env), this.name, "sh", "-c", script], env);
  }

  load(script: string): Result {
    return this.sh(`export PGPASSWORD="$POSTGRES_PASSWORD" && ${script}`);
  }

  sql(sql: string, database = "app"): string {
    const args = ["exec", "-i", this.name, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
    return docker([...args, "-U", "app", "-d", database], { input: sql }).trim();
  }

  as(login: PostgresLogin, sql: string): Result {
    const pw = login === POSTGRES_OWNER ? this.passwords.owner : this.passwords.runtime;
    return attempt(
      [
        "exec",
        "-i",
        "-e",
        "PGPASSWORD",
        this.name,
        "psql",
        "-X",
        "-q",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-h",
        "db",
        "-U",
        login,
        "-d",
        "app",
      ],
      { PGPASSWORD: pw },
      sql,
    );
  }

  dumpBase64(): string {
    const res = this.sh("pg_dump -U app -Fc app | base64 | tr -d '\\n'");
    expect(res.status, res.output).toBe(0);
    return res.stdout;
  }

  writeDumpFromBase64(b64: string, path: string): void {
    const res = attempt(["exec", "-i", this.name, "sh", "-c", `base64 -d > ${path}`], {}, b64);
    expect(res.status, res.output).toBe(0);
  }
}

describe.skipIf(reason !== undefined)("PostgreSQL extensions on Docker (045)", () => {
  it(
    "sets up pgvector + pg_trgm as superuser with separate logins, queries vectors as app_runtime, and restores dumps",
    async () => {
      const db = new ExtDatabase(IMAGES.pgvector.ref, "pgvector");
      await db.start();

      // Before setup, check fails
      expect(db.sh(extensionsCheck(["vector", "pg_trgm"])).status).not.toBe(0);

      // Run setup steps in catalog order: extensions, then logins
      const extRes = db.sh(
        extensionsSetup("db", ["vector", "pg_trgm"], { guardEventTriggers: true }),
      );
      expect(extRes.status, extRes.output).toBe(0);
      const loginRes = db.sh(loginsSetup("db"));
      expect(loginRes.status, loginRes.output).toBe(0);

      // Checks pass & setup is idempotent
      expect(db.sh(extensionsCheck(["vector", "pg_trgm"])).status).toBe(0);
      expect(db.sh(loginsCheck()).status).toBe(0);
      expect(
        db.sh(extensionsSetup("db", ["vector", "pg_trgm"], { guardEventTriggers: true })).status,
      ).toBe(0);

      // Neither app login is superuser; vector belongs to superuser app
      expect(db.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_owner'")).toBe("f");
      expect(db.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_runtime'")).toBe("f");
      expect(
        db.sql("SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname = 'vector'"),
      ).toBe("app");

      // app_owner runs migrations creating vector(3) column + HNSW & pg_trgm indexes
      const migrate = db.as(
        POSTGRES_OWNER,
        [
          "CREATE TABLE items (id serial PRIMARY KEY, label text NOT NULL, embedding vector(3) NOT NULL);",
          "CREATE INDEX items_emb_idx ON items USING hnsw (embedding vector_l2_ops);",
          "CREATE INDEX items_label_trgm ON items USING gin (label gin_trgm_ops);",
        ].join("\n"),
      );
      expect(migrate.status, migrate.output).toBe(0);

      // app_runtime inserts and queries nearest neighbor
      const insert = db.as(
        POSTGRES_RUNTIME,
        "INSERT INTO items (label, embedding) VALUES ('alpha', '[1,0,0]'), ('beta', '[0,1,0]');",
      );
      expect(insert.status, insert.output).toBe(0);
      const query = db.as(
        POSTGRES_RUNTIME,
        "SELECT label FROM items ORDER BY embedding <-> '[0.9,0.1,0]' LIMIT 1;",
      );
      expect(query.status, query.output).toBe(0);
      expect(query.stdout).toBe("alpha");

      // Dump & restore in place + into a fresh drill container
      const dump = db.dumpBase64();
      db.writeDumpFromBase64(dump, "/tmp/vec.dump");
      const restored = db.load(loginsLoad({ host: "db", file: "/tmp/vec.dump", setup: true }));
      expect(restored.status, restored.output).toBe(0);
      expect(
        db.as(
          POSTGRES_RUNTIME,
          "SELECT label FROM items ORDER BY embedding <-> '[0.1,0.9,0]' LIMIT 1;",
        ).stdout,
      ).toBe("beta");
      expect(db.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_owner'")).toBe("f");

      const drill = new ExtDatabase(IMAGES.pgvector.ref, "pgvector-drill");
      await drill.start();
      drill.writeDumpFromBase64(dump, "/tmp/vec.dump");
      const drillRestored = drill.load(
        loginsLoad({ host: "db", file: "/tmp/vec.dump", setup: true }),
      );
      expect(drillRestored.status, drillRestored.output).toBe(0);
      expect(drill.sh(extensionsCheck(["vector", "pg_trgm"])).status).toBe(0);
      expect(drill.sh(loginsCheck()).status).toBe(0);
      expect(
        drill.as(
          POSTGRES_RUNTIME,
          "SELECT label FROM items ORDER BY embedding <-> '[0.9,0.1,0]' LIMIT 1;",
        ).stdout,
      ).toBe("alpha");
    },
    HOOK_MS,
  );

  it(
    "preserves PostGIS geometry data and spatial_ref_sys across in-place restore, drill, and move while keeping app_owner non-superuser and extension schemas superuser-owned",
    async () => {
      const db = new ExtDatabase(IMAGES.postgis.ref, "postgis");
      await db.start();

      const extRes = db.sh(
        extensionsSetup("db", ["postgis", "postgis_raster"], { guardEventTriggers: true }),
      );
      expect(extRes.status, extRes.output).toBe(0);
      const loginRes = db.sh(loginsSetup("db"));
      expect(loginRes.status, loginRes.output).toBe(0);
      expect(db.sh(extensionsCheck(["postgis", "postgis_raster"])).status).toBe(0);
      expect(db.sh(loginsCheck()).status).toBe(0);

      // spatial_ref_sys stays owned by superuser app
      expect(
        db.sql("SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'spatial_ref_sys'"),
      ).toBe("app");
      const sridCountBefore = Number(db.sql("SELECT count(*) FROM spatial_ref_sys"));
      expect(sridCountBefore).toBeGreaterThan(1000);

      // app_owner creates geometry table; app_runtime inserts & queries PostGIS + spatial_ref_sys
      const migrate = db.as(
        POSTGRES_OWNER,
        "CREATE TABLE places (id serial PRIMARY KEY, name text NOT NULL, geom geometry(Point, 4326) NOT NULL);",
      );
      expect(migrate.status, migrate.output).toBe(0);
      const seed = db.as(
        POSTGRES_RUNTIME,
        "INSERT INTO places (name, geom) VALUES ('Berlin', ST_SetSRID(ST_MakePoint(13.4050, 52.5200), 4326)), ('Paris', ST_SetSRID(ST_MakePoint(2.3522, 48.8566), 4326));",
      );
      expect(seed.status, seed.output).toBe(0);
      expect(
        db.as(POSTGRES_RUNTIME, "SELECT count(*) FROM spatial_ref_sys WHERE srid = 4326;").stdout,
      ).toBe("1");

      const dump = db.dumpBase64();

      // 1. In-place restore (setup: true)
      db.writeDumpFromBase64(dump, "/tmp/geo.dump");
      const inPlace = db.load(loginsLoad({ host: "db", file: "/tmp/geo.dump", setup: true }));
      expect(inPlace.status, inPlace.output).toBe(0);
      expect(db.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_owner'")).toBe("f");
      expect(Number(db.sql("SELECT count(*) FROM spatial_ref_sys"))).toBe(sridCountBefore);
      expect(
        db.as(
          POSTGRES_RUNTIME,
          "SELECT name FROM places ORDER BY ST_Distance(geom, ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)) LIMIT 1;",
        ).stdout,
      ).toBe("Berlin");

      // 2. Drill copy (fresh container with fresh placeholder passwords, setup: true)
      const drill = new ExtDatabase(IMAGES.postgis.ref, "postgis-drill");
      await drill.start();
      drill.writeDumpFromBase64(dump, "/tmp/geo.dump");
      const drillRes = drill.load(loginsLoad({ host: "db", file: "/tmp/geo.dump", setup: true }));
      expect(drillRes.status, drillRes.output).toBe(0);
      expect(drill.sh(extensionsCheck(["postgis", "postgis_raster"])).status).toBe(0);
      expect(drill.sh(loginsCheck()).status).toBe(0);
      expect(drill.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_owner'")).toBe("f");
      expect(Number(drill.sql("SELECT count(*) FROM spatial_ref_sys"))).toBe(sridCountBefore);

      // 3. Move destination (fresh container where deploy already ran setup, then load with setup: false)
      const moved = new ExtDatabase(IMAGES.postgis.ref, "postgis-move");
      await moved.start();
      expect(
        moved.sh(extensionsSetup("db", ["postgis", "postgis_raster"], { guardEventTriggers: true }))
          .status,
      ).toBe(0);
      expect(moved.sh(loginsSetup("db")).status).toBe(0);
      moved.writeDumpFromBase64(dump, "/tmp/geo.dump");
      const moveRes = moved.load(loginsLoad({ host: "db", file: "/tmp/geo.dump", setup: false }));
      expect(moveRes.status, moveRes.output).toBe(0);
      expect(moved.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_owner'")).toBe("f");
      expect(Number(moved.sql("SELECT count(*) FROM spatial_ref_sys"))).toBe(sridCountBefore);
      expect(
        moved.as(
          POSTGRES_RUNTIME,
          "SELECT name FROM places ORDER BY ST_Distance(geom, ST_SetSRID(ST_MakePoint(2.35, 48.85), 4326)) LIMIT 1;",
        ).stdout,
      ).toBe("Paris");

      // 4. Verify S1 fix: an extension-created schema (deptype = 'n', e.g. postgis_topology's
      //    `topology` schema) stays owned by superuser `app` after loginsSetup.
      const extSchema = new ExtDatabase(IMAGES.postgis.ref, "postgis-ext-schema");
      await extSchema.start();
      extSchema.sql('CREATE EXTENSION "postgis_topology" CASCADE;');
      expect(extSchema.sh(loginsSetup("db")).status).toBe(0);
      expect(extSchema.sh(loginsCheck()).status).toBe(0);
      expect(
        extSchema.sql(
          "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'topology'",
        ),
      ).toBe("app");
      expect(
        extSchema.sql(
          "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public'",
        ),
      ).toBe("app_owner");
    },
    HOOK_MS,
  );
});
