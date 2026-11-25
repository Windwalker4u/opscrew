/**
 * The two logins' SQL (feature 047) on real PostgreSQL 16 and the catalog's pinned 17, each
 * database started as the catalog starts it (`POSTGRES_USER=app`, `POSTGRES_DB=app` and the three
 * passwords, passed to `docker run -e NAME` by name only), and every script run through `docker
 * exec … sh -c`, as the deploy's setup step runs it. The apps' logins go over TCP to `db`, the
 * container's own name, where the image asks for a password:
 * - a new database: the check fails, the setup runs and the check passes; migrations as the owner,
 *   then the runtime login's data work (Laravel's tables too), its refusals and row-level security;
 * - a database made before the logins: a failed switch changes nothing, the switch keeps every row
 *   and moves every owner, and a second run changes nothing;
 * - the rotation of each password without a restart;
 * - the loads of a dump: in place, into a drill's copy, into a move's new side, and the refusal
 *   without the logins.
 *
 * It needs Docker, so it runs only with OPSCREW_DOCKER_TESTS=1. The run removes every container
 * it started with its volume, and the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fakeSecret } from "@opscrew/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docker, hasImage } from "../__fixtures__/docker";
import { IMAGES } from "../pins";
import { skipReason } from "../workflow/__fixtures__/sh";
import {
  loginPassword,
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
if (reason) console.warn(`[iac-templates] skipping the PostgreSQL logins on Docker: ${reason}`);

/** The run's id, in every container's name. */
const RUN = randomBytes(3).toString("hex");

const VERSIONS = [
  { version: "16", image: "postgres:16-alpine" },
  { version: "17", image: IMAGES.postgres.ref },
];

/** Every container the run started, and the images it pulled. */
const started: string[] = [];
/** How long starting or removing the containers may take. */
const HOOK_MS = 300_000;
const pulled: string[] = [];

afterAll(() => {
  for (const name of started) spawnSync("docker", ["rm", "-fv", name], { stdio: "ignore" });
  for (const image of pulled) spawnSync("docker", ["rmi", image], { stdio: "ignore" });
}, HOOK_MS);

/** Docker's environment: this process's without Git Bash's path conversion, plus `env`. */
function dockerEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*", ...env };
}

interface Result {
  status: number | null;
  stdout: string;
  output: string;
}

/** `docker args`, its values from `env` (names only in `args`), not throwing. */
function attempt(args: string[], env: Record<string, string> = {}, input = ""): Result {
  const result = spawnSync("docker", args, { env: dockerEnv(env), input, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    output: `${result.stdout}${result.stderr}`,
  };
}

/** The names of `env` as `docker exec`'s or `docker run`'s `-e NAME` options. */
const names = (env: Record<string, string>) => Object.keys(env).flatMap((name) => ["-e", name]);

/**
 * An extension like PostGIS's topology, installed in every container: its own schema, and a table
 * whose rows a dump keeps (`pg_extension_config_dump`).
 */
const TEST_EXTENSION = {
  "opscrew_test.control": "default_version = '1.0'\nrelocatable = false\nsuperuser = true\n",
  "opscrew_test--1.0.sql": [
    "CREATE SCHEMA opscrew_test;",
    "CREATE TABLE opscrew_test.settings (k text PRIMARY KEY, v text);",
    "SELECT pg_catalog.pg_extension_config_dump('opscrew_test.settings', '');",
    "",
  ].join("\n"),
};

/** One database container, as the catalog starts PostgreSQL. */
class Database {
  readonly name: string;
  readonly passwords: { superuser: string; owner: string; runtime: string };

  constructor(
    readonly image: string,
    label: string,
  ) {
    this.name = `opscrew-logins-${RUN}-${label}`;
    this.passwords = {
      superuser: fakeSecret("generic-password", `${this.name}-superuser`),
      owner: fakeSecret("generic-password", `${this.name}-owner`),
      runtime: fakeSecret("generic-password", `${this.name}-runtime`),
    };
  }

  /** Starts it and waits until it answers over TCP (the image's first start ends there). */
  async start(): Promise<void> {
    const env = {
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: this.passwords.superuser,
      [OWNER_PASSWORD_ENV]: this.passwords.owner,
      [RUNTIME_PASSWORD_ENV]: this.passwords.runtime,
    };
    started.push(this.name);
    docker(["run", "-d", "--name", this.name, "--hostname", "db", ...names(env), this.image], {
      env: dockerEnv(env),
    });
    const deadline = Date.now() + 120_000;
    const ready = ["exec", this.name, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "app"];
    while (attempt(ready).status !== 0) {
      if (Date.now() > deadline) throw new Error(`${this.name} did not start.`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    for (const [file, content] of Object.entries(TEST_EXTENSION)) {
      const write = `cat > "$(pg_config --sharedir)/extension/${file}"`;
      docker(["exec", "-i", this.name, "sh", "-c", write], { input: content });
    }
  }

  /** `script` through the container's sh, with `env`'s names passed to `docker exec`. */
  sh(script: string, env: Record<string, string> = {}): Result {
    return attempt(["exec", ...names(env), this.name, "sh", "-c", script], env);
  }

  /** `script` with the superuser's password exported, as the snapshots' loads run. */
  load(script: string): Result {
    return this.sh(`export PGPASSWORD="$POSTGRES_PASSWORD" && ${script}`);
  }

  /** `sql` as the superuser over the socket, its rows unaligned; throws on an error. */
  sql(sql: string, database = "app"): string {
    const args = ["exec", "-i", this.name, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1"];
    return docker([...args, "-U", "app", "-d", database], { input: sql });
  }

  /** `sql` as `login` with `password` over TCP. */
  as(login: string, password: string, sql: string): Result {
    const psql = ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-h", "db", "-U", login];
    return attempt(
      ["exec", "-i", "-e", "PGPASSWORD", this.name, ...psql, "-d", "app"],
      { PGPASSWORD: password },
      sql,
    );
  }

  owner(sql: string): Result {
    return this.as(POSTGRES_OWNER, this.passwords.owner, sql);
  }

  runtime(sql: string): Result {
    return this.as(POSTGRES_RUNTIME, this.passwords.runtime, sql);
  }

  /** Whether the setup step's check passes. */
  checks(): boolean {
    return this.sh(loginsCheck()).status === 0;
  }

  /** The container's ID and start time. */
  identity(): string {
    return docker(["inspect", "-f", "{{.Id}} {{.State.StartedAt}}", this.name]);
  }
}

/** The app's schemas, in the catalog queries below. */
const APP = "n.nspname <> 'information_schema' AND n.nspname !~ '^pg_'";

/**
 * The owners and ACLs of the database, the app's schemas and objects, the large objects and the
 * default privileges, by name (the same in a copy of the database).
 */
function objects(db: Database): string {
  return db.sql(
    [
      "SELECT datname, datdba::regrole, datacl FROM pg_database ORDER BY 1;",
      `SELECT nspname, nspowner::regrole, nspacl FROM pg_namespace n WHERE ${APP} ORDER BY 1;`,
      `SELECT nspname, relname, relkind, relowner::regrole, relacl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE ${APP} ORDER BY 1, 2;`,
      `SELECT p.oid::regprocedure, proowner::regrole, proacl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${APP} ORDER BY p.oid::regprocedure::text;`,
      `SELECT nspname, typname, typowner::regrole, typacl FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE ${APP} ORDER BY 1, 2;`,
      "SELECT extname, extowner::regrole FROM pg_extension ORDER BY 1;",
      "SELECT oid, lomowner::regrole, lomacl FROM pg_largeobject_metadata ORDER BY 1;",
      "SELECT defaclrole::regrole, defaclnamespace, defaclobjtype, defaclacl FROM pg_default_acl ORDER BY 1, 2, 3;",
    ].join("\n"),
  );
}

/** The cluster's roles and the database's objects, owners and ACLs, with their OIDs. */
function everything(db: Database): string {
  return [
    db.sql("SELECT * FROM pg_roles ORDER BY rolname;"),
    db.sql(
      "SELECT oid, relname, relowner, relacl FROM pg_class ORDER BY oid; SELECT oid, nspname, nspowner, nspacl FROM pg_namespace ORDER BY oid; SELECT oid, proowner, proacl FROM pg_proc ORDER BY oid; SELECT oid, typowner, typacl FROM pg_type ORDER BY oid;",
    ),
    objects(db),
  ].join("\n");
}

/**
 * As `db`'s runtime login: rows inserted with generated ids, read, updated and deleted, which
 * leaves the table's rows as they were.
 */
function dataWork(db: Database, table: string): void {
  const work = db.runtime(
    [
      `INSERT INTO ${table} (v) VALUES ('one'), ('two') RETURNING id IS NOT NULL;`,
      `SELECT count(*) >= 2 FROM ${table};`,
      `UPDATE ${table} SET v = 'three' WHERE v = 'two';`,
      `DELETE FROM ${table} WHERE v IN ('one', 'three');`,
      `SELECT count(*) FROM ${table} WHERE v IN ('one', 'two', 'three');`,
    ].join("\n"),
  );
  expect(work.output).toBe("t\nt\nt\n0\n");
}

/**
 * The traps an outside review found: a function the owner login owns, which a table's CHECK, a
 * domain's CHECK and a trigger call, and which tries to make that login a superuser (first giving
 * up a `SET ROLE`), logging as which login it runs. A load that ran it as the superuser would let it
 * succeed.
 */
const TRAPS = [
  "CREATE FUNCTION public.ok(i int) RETURNS boolean LANGUAGE plpgsql AS $f$",
  "BEGIN",
  "  RAISE LOG 'opscrew-trap % %', current_user, session_user;",
  "  BEGIN",
  "    EXECUTE 'RESET ROLE';",
  "    EXECUTE 'ALTER ROLE app_owner SUPERUSER';",
  "  EXCEPTION WHEN OTHERS THEN NULL;",
  "  END;",
  "  RETURN true;",
  "END $f$;",
  "CREATE TABLE shop.trap_check (i int CHECK (public.ok(i)));",
  "CREATE DOMAIN shop.trap_int AS int CHECK (public.ok(VALUE));",
  "CREATE TABLE shop.trap_domain (i shop.trap_int);",
  "CREATE FUNCTION shop.trap_fire() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN PERFORM public.ok(1); RETURN NEW; END $f$;",
  "CREATE TABLE shop.trap_trigger (i int);",
  "CREATE TRIGGER trap BEFORE INSERT ON shop.trap_trigger FOR EACH ROW EXECUTE FUNCTION shop.trap_fire();",
  ...["trap_check", "trap_domain", "trap_trigger"].map((t) => `INSERT INTO shop.${t} VALUES (1);`),
];

/** The trap's runs in `db`'s server log: as which login, in which session. */
function trapRuns(db: Database): string[] {
  return attempt(["logs", db.name])
    .output.split("\n")
    .flatMap((line) => {
      const at = line.indexOf("opscrew-trap ");
      return at < 0 ? [] : [line.slice(at).trim()];
    });
}

/**
 * The tables of a pre-047 app, made by the superuser: two schemas, every kind the switch moves,
 * an extension with its own schema and a table whose rows a dump keeps, and the traps.
 */
const PRE_047 = [
  "CREATE EXTENSION pgcrypto;",
  "CREATE EXTENSION opscrew_test;",
  "INSERT INTO opscrew_test.settings VALUES ('k', 'v');",
  "CREATE SCHEMA shop;",
  "CREATE TABLE items (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);",
  "CREATE TABLE shop.orders (id serial PRIMARY KEY, v text);",
  "CREATE SEQUENCE shop.lines_seq;",
  "CREATE TABLE shop.lines (id bigint DEFAULT nextval('shop.lines_seq') PRIMARY KEY, v text);",
  ...["items", "shop.orders", "shop.lines"].map(
    (table) => `INSERT INTO ${table} (v) SELECT 'row ' || i FROM generate_series(1, 1000) i;`,
  ),
  "CREATE VIEW shop.order_view AS SELECT id, v FROM shop.orders;",
  "CREATE MATERIALIZED VIEW item_counts AS SELECT count(*) AS n FROM items;",
  "CREATE FUNCTION shop.total(i int) RETURNS int LANGUAGE sql AS 'SELECT i * 2';",
  "CREATE TYPE shop.status AS ENUM ('open', 'paid');",
  "CREATE TYPE shop.span AS RANGE (subtype = int4);",
  "CREATE DOMAIN shop.qty AS int CHECK (VALUE > 0);",
  "CREATE TABLE shop.slots (id serial PRIMARY KEY, during shop.span, n shop.qty);",
  "INSERT INTO shop.slots (during, n) VALUES ('[1,5)', 2);",
  'CREATE COLLATION shop.c1 FROM "C";',
  "CREATE STATISTICS shop.s1 ON id, v FROM shop.orders;",
  "CREATE TEXT SEARCH DICTIONARY shop.d1 (TEMPLATE = simple);",
  "CREATE TEXT SEARCH CONFIGURATION shop.t1 (COPY = pg_catalog.simple);",
  "CREATE OPERATOR shop.=== (LEFTARG = int, RIGHTARG = int, FUNCTION = int4eq);",
  ...TRAPS,
  "SELECT lo_from_bytea(0, 'a large object') > 0;",
].join("\n");

/** The large object `PRE_047` makes. */
const LARGE_OBJECT = "(SELECT oid FROM pg_largeobject_metadata)";

/** The start of the refusal of a database with event triggers. */
const EVENT_TRIGGERS =
  "PostgreSQL db has event triggers, and separate logins cannot run safely with them";

const ROW_COUNTS =
  "SELECT (SELECT count(*) FROM items), (SELECT count(*) FROM shop.orders), (SELECT count(*) FROM shop.lines);";

describe.skipIf(reason !== undefined).each(VERSIONS)(
  "PostgreSQL $version",
  ({ version, image }) => {
    beforeAll(() => {
      if (!hasImage(image)) {
        docker(["pull", image]);
        pulled.push(image);
      }
    }, 600_000);

    describe("a new database", () => {
      const db = new Database(image, `${version}-new`);
      beforeAll(() => db.start(), HOOK_MS);

      it("fails the check, gets the logins from the setup, then passes it", () => {
        expect(db.checks()).toBe(false);
        const setup = db.sh(loginsSetup("db"));
        expect(setup.output).toBe("");
        expect(setup.status).toBe(0);
        expect(db.checks()).toBe(true);
        expect(
          db.sql(
            "SELECT rolname, rolcanlogin, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls FROM pg_roles WHERE rolname LIKE 'app\\_%' ORDER BY 1;",
          ),
        ).toBe("app_owner|t|f|f|f|f|f|f\napp_runtime|t|f|f|f|f|f|f");
        expect(
          db.sql(
            "SELECT count(*) FROM pg_auth_members WHERE member IN ('app_owner'::regrole, 'app_runtime'::regrole) OR roleid IN ('app_owner'::regrole, 'app_runtime'::regrole);",
          ),
        ).toBe("0");
      });

      it("lets the runtime login work on whatever the owner's migrations create afterwards", () => {
        const migrations = db.owner(
          [
            "CREATE TABLE a (id bigint GENERATED ALWAYS AS IDENTITY, v text);",
            "CREATE TABLE b (id serial, v text);",
            "CREATE SEQUENCE c_seq;",
            "CREATE TABLE c (id bigint DEFAULT nextval('c_seq'), v text);",
            // Laravel's cache, sessions and queue tables, as its PostgreSQL migrations make them.
            "CREATE TABLE cache (key varchar(255) PRIMARY KEY, value text NOT NULL, expiration integer NOT NULL);",
            "CREATE TABLE sessions (id varchar(255) PRIMARY KEY, user_id bigint, ip_address varchar(45), user_agent text, payload text NOT NULL, last_activity integer NOT NULL);",
            "CREATE TABLE jobs (id bigserial PRIMARY KEY, queue varchar(255) NOT NULL, payload text NOT NULL, attempts smallint NOT NULL, reserved_at integer, available_at integer NOT NULL, created_at integer NOT NULL);",
            "CREATE TABLE failed_jobs (id bigserial PRIMARY KEY, uuid varchar(255) NOT NULL UNIQUE, connection text NOT NULL, queue text NOT NULL, payload text NOT NULL, exception text NOT NULL, failed_at timestamp(0) NOT NULL DEFAULT CURRENT_TIMESTAMP);",
            "CREATE SCHEMA later;",
            "CREATE TABLE later.t (id serial, v text);",
          ].join("\n"),
        );
        expect(migrations.output).toBe("");
        for (const table of ["a", "b", "c", "later.t"]) dataWork(db, table);
        const laravel = db.runtime(
          [
            "INSERT INTO cache (key, value, expiration) VALUES ('k', 'v', 1) ON CONFLICT (key) DO UPDATE SET value = excluded.value;",
            "INSERT INTO cache (key, value, expiration) VALUES ('k', 'w', 2) ON CONFLICT (key) DO UPDATE SET value = excluded.value;",
            "DELETE FROM cache WHERE expiration < 1;",
            "INSERT INTO sessions (id, payload, last_activity) VALUES ('s', 'p', 1);",
            "UPDATE sessions SET payload = 'q', last_activity = 2 WHERE id = 's';",
            "INSERT INTO jobs (queue, payload, attempts, available_at, created_at) VALUES ('default', '{}', 0, 1, 1) RETURNING id;",
            "BEGIN;",
            "SELECT id FROM jobs WHERE queue = 'default' AND reserved_at IS NULL ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED;",
            "UPDATE jobs SET reserved_at = 2, attempts = attempts + 1 WHERE id = 1;",
            "COMMIT;",
            "DELETE FROM jobs WHERE id = 1;",
            "INSERT INTO failed_jobs (uuid, connection, queue, payload, exception) VALUES ('u', 'database', 'default', '{}', 'e') RETURNING id;",
            "DELETE FROM failed_jobs WHERE uuid = 'u';",
            "SELECT value FROM cache WHERE key = 'k';",
            "SELECT payload FROM sessions WHERE id = 's';",
            "SELECT count(*) FROM jobs;",
          ].join("\n"),
        );
        expect(laravel.output).toBe("1\n1\n1\nw\nq\n0\n");
        expect(db.checks()).toBe(true);
      });

      it.each([
        ["CREATE TABLE z (i int)", "permission denied for schema public"],
        ["ALTER TABLE a ADD COLUMN x int", "must be owner of table a"],
        ["DROP TABLE a", "must be owner of table a"],
        ["TRUNCATE a", "permission denied for table a"],
        ["CREATE ROLE x", "permission denied to create role"],
        ["CREATE SCHEMA x", "permission denied for database app"],
        ["CREATE TEMP TABLE t (i int)", "permission denied to create temporary tables"],
        ["SELECT rolpassword FROM pg_authid", "permission denied for table pg_authid"],
        ["ALTER ROLE app_runtime BYPASSRLS", "permission denied to alter role"],
      ])("refuses the runtime login %s", (sql, error) => {
        const refused = db.runtime(sql);
        expect(refused.status).not.toBe(0);
        expect(refused.output).toContain(error);
      });

      it("moves an operator class and family the superuser makes later", () => {
        // Only a superuser may create them, so no load can restore them as the owner login.
        db.sql(
          "CREATE OPERATOR FAMILY f1 USING btree; CREATE OPERATOR CLASS c1 FOR TYPE int USING btree FAMILY f1 AS OPERATOR 1 <, OPERATOR 2 <=, OPERATOR 3 =, OPERATOR 4 >=, OPERATOR 5 >, FUNCTION 1 btint4cmp(int, int);",
        );
        expect(db.checks()).toBe(false);
        const setup = db.sh(loginsSetup("db"));
        expect(setup.output).toBe("");
        expect(setup.status).toBe(0);
        expect(db.checks()).toBe(true);
        expect(
          db.sql(
            "SELECT opcowner::regrole FROM pg_opclass WHERE opcname = 'c1'; SELECT opfowner::regrole FROM pg_opfamily WHERE opfname = 'f1';",
          ),
        ).toBe("app_owner\napp_owner");
      });

      it("applies row-level security to the runtime login", () => {
        db.sql("INSERT INTO a (v) VALUES ('mine'), ('mine'), ('theirs');");
        const policy = db.owner(
          [
            "ALTER TABLE a ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE a FORCE ROW LEVEL SECURITY;",
            "CREATE POLICY mine ON a USING (v = 'mine');",
          ].join("\n"),
        );
        expect(policy.output).toBe("");
        expect(db.runtime("SELECT DISTINCT v FROM a;").output).toBe("mine\n");
        expect(db.runtime("SELECT count(*) FROM a;").output).toBe("2\n");
        expect(db.sql("SELECT count(*) FROM a WHERE v = 'theirs';")).toBe("1");
      });

      it.each([POSTGRES_RUNTIME, POSTGRES_OWNER] as PostgresLogin[])(
        "rotates %s's password without a restart",
        (login) => {
          const before = db.identity();
          const old = login === POSTGRES_OWNER ? db.passwords.owner : db.passwords.runtime;
          const next = fakeSecret("generic-password", `${db.name}-${login}-next`);
          const stored = () =>
            db.sql(`SELECT rolpassword FROM pg_authid WHERE rolname = '${login}';`);
          const first = stored();
          const rotation = db.sh(loginPassword(login), { OPSCREW_NEW: next });
          expect(rotation.output).toBe("");
          expect(rotation.status).toBe(0);
          const second = stored();
          expect(second).not.toBe(first);
          expect(db.as(login, next, "SELECT 1;").output).toBe("1\n");
          const refused = db.as(login, old, "SELECT 1;");
          expect(refused.status).not.toBe(0);
          expect(refused.output).toContain("password authentication failed");
          // Run again, it sets nothing: the stored verifier (salted anew by each change) stays.
          expect(db.sh(loginPassword(login), { OPSCREW_NEW: next }).status).toBe(0);
          expect(stored()).toBe(second);
          expect(db.identity()).toBe(before);
          expect(attempt(["logs", db.name]).output).not.toContain(next);
        },
      );
    });

    // Its loads take minutes each on a busy machine.
    describe("a database made before the logins", { timeout: HOOK_MS }, () => {
      const db = new Database(image, `${version}-switch`);
      const drill = new Database(image, `${version}-drill`);
      const move = new Database(image, `${version}-move`);
      const pre = new Database(image, `${version}-pre`);
      beforeAll(() => Promise.all([db.start(), drill.start(), move.start(), pre.start()]), HOOK_MS);
      /** The switched database's objects, which every load must give back. */
      let switched = "";

      /** `file` in `target`'s container, copied from the switched database's. */
      function copyDump(target: Database, file: string): void {
        const dump = spawnSync("docker", ["exec", db.name, "cat", file], { env: dockerEnv() });
        expect(dump.status).toBe(0);
        const put = spawnSync("docker", ["exec", "-i", target.name, "sh", "-c", `cat > ${file}`], {
          env: dockerEnv(),
          input: dump.stdout,
        });
        expect(put.status).toBe(0);
      }

      it("changes nothing when the setup fails", () => {
        expect(db.sql(PRE_047)).toBe("t");
        db.sql("CREATE ROLE app_runtime LOGIN CREATEROLE;");
        const before = everything(db);
        const setup = db.sh(loginsSetup("db"));
        expect(setup.status).not.toBe(0);
        expect(setup.output).toContain(
          "The role app_runtime already exists in db with other rights than OpsCrew gives it. Drop or rename it, then deploy again.",
        );
        expect(everything(db)).toBe(before);
        db.sql("DROP ROLE app_runtime;");
      });

      it("refuses a database with event triggers, and a dump of it, before anything changes", () => {
        db.sql(
          "CREATE FUNCTION public.on_ddl() RETURNS event_trigger LANGUAGE plpgsql AS 'BEGIN END'; CREATE EVENT TRIGGER on_ddl ON ddl_command_start EXECUTE FUNCTION public.on_ddl();",
        );
        const before = everything(db);
        const setup = db.sh(loginsSetup("db"));
        expect(setup.status).not.toBe(0);
        expect(setup.output).toContain(EVENT_TRIGGERS);
        expect(everything(db)).toBe(before);
        expect(db.sh("pg_dump -U app -Fc -f /tmp/events.dump app").status).toBe(0);
        copyDump(drill, "/tmp/events.dump");
        drill.sql("CREATE TABLE kept (i int); INSERT INTO kept VALUES (1);");
        const load = drill.load(loginsLoad({ host: "db", file: "/tmp/events.dump", setup: true }));
        expect(load.status).not.toBe(0);
        expect(load.output).toContain(EVENT_TRIGGERS);
        expect(drill.sql("SELECT count(*) FROM kept;")).toBe("1");
        expect(drill.sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'app\\_%';")).toBe("0");
        db.sql("DROP EVENT TRIGGER on_ddl; DROP FUNCTION public.on_ddl();");
      });

      it("changes nothing when the switch fails part way through the moves", async () => {
        const before = everything(db);
        // Another session holds shop.slots, which the moves reach after the database, the
        // schemas and the earlier tables: the setup's wait for it times out there.
        const holder = "BEGIN; LOCK TABLE shop.slots IN ACCESS SHARE MODE; SELECT pg_sleep(300);";
        docker(["exec", "-d", db.name, "psql", "-X", "-U", "app", "-d", "app", "-c", holder]);
        const held =
          "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'slots' AND l.granted AND l.pid <> pg_backend_pid();";
        const deadline = Date.now() + 60_000;
        while (db.sql(held) !== "1") {
          if (Date.now() > deadline) throw new Error("The lock was not taken.");
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const setup = db.sh(loginsSetup("db"), { PGOPTIONS: "-c lock_timeout=2s" });
        db.sql(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(300)%' AND pid <> pg_backend_pid();",
        );
        expect(setup.status).not.toBe(0);
        expect(setup.output).toContain("canceling statement due to lock timeout");
        expect(everything(db)).toBe(before);
      });

      it("moves every owner to the owner login and keeps every row", () => {
        // A dump from before the switch, which a later test loads.
        expect(db.sh("pg_dump -U app -Fc -f /tmp/pre.dump app").status).toBe(0);
        const rows = db.sql(ROW_COUNTS);
        expect(rows).toBe("1000|1000|1000");
        expect(db.checks()).toBe(false);
        const setup = db.sh(loginsSetup("db"));
        expect(setup.output).toBe("");
        expect(setup.status).toBe(0);
        expect(db.checks()).toBe(true);
        expect(db.sql(ROW_COUNTS)).toBe(rows);
        const owners = (list: string) =>
          `SELECT string_agg(DISTINCT owner::regrole::text, ',') FROM (${list}) AS o(owner);`;
        expect(
          db.sql(
            [
              "SELECT datdba::regrole FROM pg_database WHERE datname = 'app';",
              owners("SELECT nspowner FROM pg_namespace WHERE nspname IN ('public', 'shop')"),
              owners(
                "SELECT relowner FROM pg_class WHERE oid IN ('items'::regclass, 'items_id_seq'::regclass, 'shop.orders'::regclass, 'shop.orders_id_seq'::regclass, 'shop.lines'::regclass, 'shop.lines_seq'::regclass, 'shop.order_view'::regclass, 'item_counts'::regclass, 'shop.slots'::regclass)",
              ),
              owners(
                "SELECT proowner FROM pg_proc WHERE oid IN ('shop.total(int)'::regprocedure, 'public.ok(int)'::regprocedure)",
              ),
              owners(
                "SELECT typowner FROM pg_type WHERE oid IN ('shop.status'::regtype, 'shop.span'::regtype, 'shop.span_multirange'::regtype, 'shop.qty'::regtype)",
              ),
              owners(
                [
                  "SELECT collowner FROM pg_collation WHERE oid = 'shop.c1'::regcollation",
                  "SELECT stxowner FROM pg_statistic_ext WHERE stxname = 's1'",
                  "SELECT cfgowner FROM pg_ts_config WHERE oid = 'shop.t1'::regconfig",
                  "SELECT dictowner FROM pg_ts_dict WHERE oid = 'shop.d1'::regdictionary",
                  "SELECT oprowner FROM pg_operator WHERE oid = 'shop.===(int, int)'::regoperator",
                ].join(" UNION ALL "),
              ),
              owners("SELECT lomowner FROM pg_largeobject_metadata"),
              // The extensions' objects stay the superuser's, their own schemas too.
              "SELECT extowner::regrole FROM pg_extension WHERE extname = 'pgcrypto';",
              owners("SELECT proowner FROM pg_proc WHERE proname = 'digest'"),
              "SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'opscrew_test';",
            ].join("\n"),
          ),
        ).toBe([...Array(7).fill("app_owner"), "app", "app", "app"].join("\n"));
        expect(
          db.runtime(
            "SELECT encode(digest('x', 'sha256'), 'hex') = encode(sha256('x'), 'hex'), shop.total(2), (SELECT count(*) FROM shop.order_view), (SELECT n FROM item_counts);",
          ).output,
        ).toBe("t|4|1000|1000\n");
        for (const table of ["items", "shop.orders", "shop.lines"]) dataWork(db, table);
        // The large object made before the switch: the runtime login reads and writes it.
        expect(
          db.runtime(
            [
              `SELECT convert_from(lo_get(${LARGE_OBJECT}), 'UTF8');`,
              `SELECT count(*) FROM (SELECT lo_put(${LARGE_OBJECT}, 0, 'A')) AS put;`,
              `SELECT convert_from(lo_get(${LARGE_OBJECT}), 'UTF8');`,
            ].join("\n"),
          ).output,
        ).toBe("a large object\n1\nA large object\n");
        switched = objects(db);
      });

      it("changes nothing when it runs again", () => {
        const before = everything(db);
        const again = db.sh(loginsSetup("db"));
        expect(again.output).toBe("");
        expect(again.status).toBe(0);
        expect(everything(db)).toBe(before);
        expect(db.checks()).toBe(true);
      });

      const deleteOnLines = "SELECT has_table_privilege('app_runtime', 'shop.lines', 'DELETE');";

      it("keeps a migration's narrowing of the runtime login through the setup", () => {
        expect(db.owner("REVOKE DELETE ON shop.lines FROM app_runtime;").output).toBe("");
        expect(db.checks()).toBe(true);
        const again = db.sh(loginsSetup("db"));
        expect(again.status).toBe(0);
        expect(db.sql(deleteOnLines)).toBe("f");
        const refused = db.runtime("DELETE FROM shop.lines WHERE id < 0;");
        expect(refused.output).toContain("permission denied for table lines");
        // Every load below must keep it.
        switched = objects(db);
      });

      /**
       * `file` loaded into `target`: the load passes, and the traps ran during it as the owner
       * login only, which is still no superuser.
       */
      function load(target: Database, file: string, setup: boolean): void {
        const before = trapRuns(target).length;
        const result = target.load(loginsLoad({ host: "db", file, setup }));
        expect(result.output).toBe("");
        expect(result.status).toBe(0);
        expect(target.sql("SELECT rolsuper FROM pg_roles WHERE rolname = 'app_owner';")).toBe("f");
        const runs = trapRuns(target).slice(before);
        expect(runs.length).toBeGreaterThan(0);
        expect(new Set(runs)).toEqual(new Set(["opscrew-trap app_owner app_owner"]));
      }

      /** The checks after a load into `target`: the source's owners and grants, and a new table. */
      function loaded(target: Database): void {
        expect(target.sql(ROW_COUNTS)).toBe("1000|1000|1000");
        expect(objects(target)).toBe(switched);
        expect(target.sql(deleteOnLines)).toBe("f");
        expect(target.sql("SELECT v FROM opscrew_test.settings;")).toBe("v");
        expect(target.checks()).toBe(true);
        expect(target.owner("CREATE TABLE after_load (id serial, v text);").output).toBe("");
        dataWork(target, "after_load");
        expect(target.owner("DROP TABLE after_load;").output).toBe("");
      }

      it("keeps the owners and grants when a dump is loaded in place", () => {
        expect(db.sh("pg_dump -U app -Fc -f /tmp/app.dump app").status).toBe(0);
        load(db, "/tmp/app.dump", true);
        loaded(db);
      });

      it("refuses a load without the logins, and drops nothing", () => {
        copyDump(drill, "/tmp/app.dump");
        const result = drill.load(loginsLoad({ host: "db", file: "/tmp/app.dump", setup: false }));
        expect(result.status).not.toBe(0);
        expect(result.output).toContain(
          "PostgreSQL db has no logins app_owner and app_runtime, so OpsCrew loaded nothing into it.",
        );
        expect(drill.sql("SELECT count(*) FROM kept;")).toBe("1");
        expect(drill.sql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'app\\_%';")).toBe("0");
      });

      it("keeps them in a drill's copy with its own passwords", () => {
        load(drill, "/tmp/app.dump", true);
        loaded(drill);
      });

      it("keeps them on a move's new side, whose deploy made the logins", () => {
        expect(move.sh(loginsSetup("db")).status).toBe(0);
        copyDump(move, "/tmp/app.dump");
        load(move, "/tmp/app.dump", false);
        loaded(move);
      });

      it("loads a dump from before the switch with the logins", () => {
        copyDump(pre, "/tmp/pre.dump");
        load(pre, "/tmp/pre.dump", true);
        expect(pre.sql(ROW_COUNTS)).toBe("1000|1000|1000");
        expect(pre.checks()).toBe(true);
        const owner = (table: string) =>
          `SELECT relowner::regrole FROM pg_class WHERE oid = '${table}'::regclass;`;
        for (const table of ["items", "shop.orders", "shop.lines", "shop.slots"]) {
          expect(pre.sql(owner(table))).toBe("app_owner");
        }
        for (const table of ["items", "shop.orders", "shop.lines"]) dataWork(pre, table);
        expect(pre.runtime(`SELECT convert_from(lo_get(${LARGE_OBJECT}), 'UTF8');`).output).toBe(
          "a large object\n",
        );
        expect(
          pre.sql(
            "SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'opscrew_test'; SELECT v FROM opscrew_test.settings;",
          ),
        ).toBe("app\nv");
      });
    });
  },
);
