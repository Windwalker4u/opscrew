// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell syntax in scripts, not JavaScript templates.
/**
 * Portainer's scheduled snapshots and off-server copy on Docker (plan.md 4. and 7., research R7
 * S2), with the services as the stack renders them:
 * 1. PostgreSQL with a table, Valkey in queue mode with keys, and in the `sqlite` volume two SQLite
 *    databases (one in WAL mode, which a writer keeps writing to as the app's uid 1002) and an
 *    upload;
 * 2. the stamp names the running image, the per-part loops run with `every` at 20 seconds, and the
 *    `snapshots` service finishes the slot: `about.json` names each part with its size and the
 *    running image's digest, the folder is 700 and its files 600, root's, and no marker is left;
 * 3. the dump restores its table's list, the RDB is an RDB, and `sqlite.tar` restored into an empty
 *    volume gives exactly its files, the app's, with both databases whole in `delete` mode and the
 *    upload as it was;
 * 4. the `offsite` service, its remote turned into a local folder, fetches and checks age and
 *    uploads every file encrypted, `about.json` too; each decrypts with the test's age identity to
 *    exactly the snapshot's file. A snapshot before a release (named by its digest) stays here.
 * Neither the services' logs nor `about.json` hold a password.
 *
 * The scheduled drill (029 plan.md 19., research R28), for each of PostgreSQL, MySQL, MariaDB and
 * MongoDB as the stack renders it: the service with three tables or collections, a scheduled
 * snapshot taken by the stack's own part and finalizer, a crashed run's scratch left behind, then
 * the `drill-<service>` loop with its slot every 15 seconds: its one line says the latest dump
 * restored with three tables into a scratch server of its own, the scratch was cleared, and the
 * leftovers were removed; the container had no network, the service kept running untouched with its
 * data, and no log holds a password.
 *
 * It pulls the pinned images and fetches age from GitHub, so it runs only with
 * OPSCREW_DOCKER_TESTS=1. It removes its containers and volumes, and the images it pulled.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAgeIdentity } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { docker } from "../__fixtures__/docker";
import { testContext } from "../__fixtures__/plans";
import { withServices } from "../catalog/__fixtures__/plans";
import { drillRecord } from "../drill/record";
import { IMAGES } from "../pins";
import { withSqlite } from "../workflow/__fixtures__/plans";
import { skipReason } from "../workflow/__fixtures__/sh";
import { databaseCount } from "../workflow/snapshots";
import { portainerTestPlan } from "./__fixtures__/plans";
import { fillPortainerStack, portainerSecretVariables, renderPortainerStack } from "./index";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping Portainer's snapshots on Docker: ${reason}`);

const RUN = randomBytes(3).toString("hex");
const PROJECT = `opscrew-t2405-${RUN}`;
/** The stack's own `snapshots` volume, as Compose names it (D12). */
const SNAPSHOTS_VOLUME = `${PROJECT}_snapshots`;
/** Where the test restores `sqlite.tar`, outside the project (removed at the end). */
const RESTORED_VOLUME = `opscrew-snapshots-test-${RUN}-restored`;
const IMAGE = `ghcr.io/acme/shop@sha256:${randomBytes(32).toString("hex")}`;
const BUCKET = "shop-prod-backups";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `shop` on Portainer: PostgreSQL `db`, Valkey `queue` in queue mode, SQLite, both copies on. */
function plan(): DeployPlan {
  const base = withSqlite(portainerTestPlan({ postgres: true }), { dir: "data" });
  return DeployPlanSchema.parse({
    ...base,
    app: {
      ...base.app,
      build: {
        builder: "railpack",
        chosen: "auto",
        reason: "test",
        runtime: { language: "node", version: "24" },
        probe: "node",
      },
    },
    services: [
      ...base.services,
      {
        name: "queue",
        kind: "valkey",
        version: "8",
        memoryMb: 128,
        enabled: true,
        options: { mode: "queue" },
        reason: "Jobs.",
        licence: "BSD-3-Clause",
      },
    ],
    snapshots: {
      schedule: { every: "1h", keep: 2 },
      offsite: { provider: "r2", bucket: BUCKET },
    },
  });
}

type Service = Record<string, unknown> & {
  environment?: Record<string, string>;
  volumes?: string[];
  depends_on?: unknown;
};

/**
 * The writer: as root it gives the volume to uid 1002; as that uid it makes a second database with
 * 100 rows and an upload, then writes a row every 20 ms to the first, in WAL mode.
 */
const WRITER = [
  "import os, sqlite3, time",
  'os.chown("/data", 1002, 1002)',
  "os.setgroups([]); os.setgid(1002); os.setuid(1002)",
  'd = sqlite3.connect("/data/cache.sqlite3")',
  'd.execute("create table if not exists c (k integer)")',
  'd.executemany("insert into c values (?)", [(k,) for k in range(100)])',
  "d.commit(); d.close()",
  'os.makedirs("/data/uploads", exist_ok=True)',
  'open("/data/uploads/photo.txt", "w").write("photo bytes")',
  'c = sqlite3.connect("/data/app.sqlite3", isolation_level=None)',
  'c.execute("pragma journal_mode=wal")',
  'c.execute("create table if not exists t (id integer primary key, v text)")',
  "i = 0",
  "while True:",
  "    i += 1",
  '    c.execute("insert into t (v) values (?)", ("row-%d" % i,))',
  "    time.sleep(0.02)",
].join("\n");

/** The test's project: the rendered stack's snapshot services, the two services and the writer. */
function project(recipient: string): object {
  const filled = fillPortainerStack(renderPortainerStack(plan(), testContext()).content, IMAGE);
  const stack = parse(filled) as {
    services: Record<string, Service>;
    volumes: Record<string, unknown>;
  };
  const take = (name: string): Service => {
    const service = stack.services[name];
    if (service === undefined) throw new Error(`The stack has no service ${name}.`);
    return service;
  };
  const services: Record<string, Service> = {};
  for (const name of ["db", "queue", "snapshots-db", "snapshots-queue", "snapshots-sqlite"]) {
    services[name] = take(name);
  }
  for (const name of ["snapshots-db", "snapshots-queue", "snapshots-sqlite"]) {
    const service = services[name] as Service;
    service.environment = { ...service.environment, OPSCREW_SNAPSHOT_EVERY: "20" };
  }
  const snapshots = take("snapshots");
  services.snapshots = {
    ...snapshots,
    environment: { OPSCREW_SNAPSHOT_GIVE_UP: "600" },
  };
  // The stamp, which names the running image, without waiting for an app this test doesn't run.
  const { depends_on: _, ...stamp } = take("stamp");
  services.stamp = stamp;
  // The off-server copy, its remote a local folder: rclone's `offsite:<bucket>/…` is then the
  // folder `<bucket>/…` under its working directory.
  const offsite = take("offsite");
  services.offsite = {
    ...offsite,
    environment: {
      RCLONE_CONFIG_OFFSITE_TYPE: "local",
      OPSCREW_OFFSITE_RECIPIENT: recipient,
    },
    working_dir: "/remote",
    volumes: [...(offsite.volumes ?? []), "remote:/remote"],
  };
  services.writer = {
    image: IMAGES.python.ref,
    user: "0:0",
    network_mode: "none",
    entrypoint: ["python3", "-c", WRITER],
    volumes: ["sqlite:/data"],
  };
  return {
    name: PROJECT,
    services,
    networks: { internal: {} },
    volumes: {
      db_data: {},
      queue_data: {},
      sqlite: {},
      version: {},
      snapshot_tools: {},
      remote: {},
      snapshots: {},
    },
  };
}

/** `script` in a one-off container of `image` (`sh` as root), with `volumes`. */
function inside(image: string, volumes: string[], script: string, input?: string): string {
  return docker(
    [
      "run",
      "--rm",
      "-i",
      "--network",
      "none",
      "--user",
      "0:0",
      ...volumes.flatMap((volume) => ["-v", volume]),
      "--entrypoint",
      "sh",
      image,
      "-c",
      script,
    ],
    { input },
  );
}

/** The images this test pulled, removed at the end. */
const pulled: string[] = [];
let dir: string | undefined;

afterAll(() => {
  if (dir !== undefined) {
    spawnSync("docker", ["compose", "-p", PROJECT, "down", "-v", "--remove-orphans", "-t", "1"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
    });
    rmSync(dir, { recursive: true, force: true });
  }
  spawnSync("docker", ["volume", "rm", RESTORED_VOLUME]);
  for (const ref of pulled) spawnSync("docker", ["image", "rm", ref]);
}, 300_000);

describe.skipIf(reason !== undefined)(
  "Portainer's snapshots on Docker",
  { timeout: 900_000 },
  () => {
    it("takes a complete scheduled slot of PostgreSQL, Valkey and SQLite, and copies it off encrypted", async () => {
      const images = [
        IMAGES.postgres.ref,
        IMAGES.valkey.ref,
        IMAGES.python.ref,
        IMAGES.busybox.ref,
        IMAGES.rclone.ref,
        IMAGES.curl.ref,
      ];
      for (const ref of images) {
        if (spawnSync("docker", ["image", "inspect", ref]).status !== 0) pulled.push(ref);
      }
      const { identity, recipient } = generateAgeIdentity();
      const passwords = [randomBytes(16).toString("hex"), randomBytes(16).toString("hex")];
      dir = mkdtempSync(join(tmpdir(), "opscrew-portainer-snapshots-"));
      writeFileSync(join(dir, "compose.yaml"), stringify(project(recipient)));
      writeFileSync(
        join(dir, ".env"),
        [
          "OPSCREW_DB_USER=app",
          "OPSCREW_DB_NAME=app",
          `OPSCREW_DB_PASSWORD=${passwords[0]}`,
          `OPSCREW_SVC_QUEUE_PASSWORD=${passwords[1]}`,
          "",
        ].join("\n"),
      );
      const compose = (args: string[], timeoutMs?: number) =>
        docker(["compose", "-p", PROJECT, ...args], { cwd: dir, timeoutMs });

      compose(["up", "-d", "--wait", "--wait-timeout", "300", "db", "queue"], 900_000);
      compose([
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -c "CREATE TABLE t (id int PRIMARY KEY); INSERT INTO t SELECT generate_series(1, 100)"',
      ]);
      compose([
        "exec",
        "-T",
        "queue",
        "sh",
        "-c",
        'for i in $(seq 1 50); do echo "SET job:$i payload-$i"; done | REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli > /dev/null',
      ]);
      compose(["up", "-d", "writer"], 600_000);
      compose(["up", "--no-deps", "stamp"], 600_000);
      compose(
        ["up", "-d", "snapshots-db", "snapshots-queue", "snapshots-sqlite", "snapshots", "offsite"],
        900_000,
      );

      // Waits for a finished slot with its off-server copy.
      const volumes = [`${SNAPSHOTS_VOLUME}:/s`];
      // A snapshot before a release, named by its digest, which sorts before every slot: it stays.
      const release = "0".repeat(64);
      inside(
        IMAGES.busybox.ref,
        volumes,
        `mkdir -p /s/${release} && echo dump > /s/${release}/db.dump && echo '{"id":"${release}","kind":"release","services":[{"name":"db","kind":"postgres","file":"db.dump","size":5}]}' > /s/${release}/about.json`,
      );
      const started = Date.now();
      let id = "";
      while (id === "") {
        if (Date.now() - started > 420_000) {
          throw new Error(`No slot was copied off in 7 minutes:\n${compose(["logs"])}`);
        }
        await sleep(5000);
        id = inside(
          IMAGES.busybox.ref,
          volumes,
          "for d in /s/*T*Z; do if [ -f $d/offsite.done ]; then echo ${d##*/}; break; fi; done",
        );
      }
      expect(id).toMatch(/^\d{8}T\d{6}Z$/);
      // No later slot changes or prunes the folder while it is checked.
      compose([
        "stop",
        "-t",
        "1",
        "snapshots-db",
        "snapshots-queue",
        "snapshots-sqlite",
        "snapshots",
      ]);
      compose(["stop", "-t", "1", "offsite"]);

      const about = JSON.parse(inside(IMAGES.busybox.ref, volumes, `cat /s/${id}/about.json`));
      expect(about).toMatchObject({
        id,
        kind: "scheduled",
        version: IMAGE.slice(IMAGE.indexOf("@") + 1),
      });
      expect(about.taken).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(about.services).toEqual([
        {
          name: "db",
          kind: "postgres",
          file: "db.dump",
          size: expect.any(Number),
          image: IMAGES.postgres.ref,
        },
        {
          name: "queue",
          kind: "valkey",
          file: "queue.rdb",
          size: expect.any(Number),
          image: IMAGES.valkey.ref,
        },
        { name: "sqlite", kind: "sqlite", file: "sqlite.tar", size: expect.any(Number) },
      ]);
      for (const service of about.services) expect(service.size).toBeGreaterThan(0);

      // Modes and owner, and nothing but the files, about.json and offsite.done.
      const listing = inside(
        IMAGES.busybox.ref,
        volumes,
        `stat -c '%a %u:%g %n' /s/${id} /s/${id}/*`,
      ).split("\n");
      expect(listing).toEqual([
        `700 0:0 /s/${id}`,
        `600 0:0 /s/${id}/about.json`,
        `600 0:0 /s/${id}/db.dump`,
        `600 0:0 /s/${id}/offsite.done`,
        `600 0:0 /s/${id}/queue.rdb`,
        `600 0:0 /s/${id}/sqlite.tar`,
      ]);

      // Each file is what it should be.
      const tables = inside(IMAGES.postgres.ref, volumes, `pg_restore -l /s/${id}/db.dump`);
      expect(tables).toContain("TABLE DATA public t");
      expect(inside(IMAGES.busybox.ref, volumes, `head -c 5 /s/${id}/queue.rdb`)).toBe("REDIS");
      // sqlite.tar restored as a restore does, into an empty volume: exactly its files, the app's.
      const restored = [`${RESTORED_VOLUME}:/data`, ...volumes];
      const same = inside(
        IMAGES.busybox.ref,
        restored,
        [
          "set -e",
          `find /data -mindepth 1 -delete && tar -C /data -xpf - < /s/${id}/sqlite.tar`,
          `for f in $(tar -tf /s/${id}/sqlite.tar); do`,
          '  if [ ! -f /data/"$f" ]; then continue; fi',
          `  a=$(tar -xOf /s/${id}/sqlite.tar "$f" | sha256sum)`,
          '  b=$(sha256sum < /data/"$f")',
          '  if [ "$a" = "$b" ]; then echo "$f same"; else echo "$f differs"; fi',
          "done",
          "echo $(ls -A /data | sort)",
          "find /data ! -user 1002",
          "cat /data/uploads/photo.txt",
        ].join("\n"),
      ).split("\n");
      expect(same).toEqual([
        "app.sqlite3 same",
        "cache.sqlite3 same",
        "uploads/photo.txt same",
        "app.sqlite3 cache.sqlite3 uploads",
        "photo bytes",
      ]);
      const databases = inside(
        IMAGES.python.ref,
        restored,
        `python3 -c 'import sqlite3; a = sqlite3.connect("/data/app.sqlite3"); c = sqlite3.connect("/data/cache.sqlite3"); ids = [r[0] for r in a.execute("select id from t order by id")]; print(a.execute("pragma journal_mode").fetchone()[0], c.execute("pragma journal_mode").fetchone()[0], c.execute("select count(*) from c").fetchone()[0], len(ids), ids == list(range(1, len(ids) + 1)))'`,
      ).split(" ");
      expect(databases.slice(0, 3)).toEqual(["delete", "delete", "100"]);
      expect(Number(databases[3])).toBeGreaterThan(0);
      expect(databases[4]).toBe("True");

      // The snapshot before a release was never copied off.
      const copied = inside(
        IMAGES.busybox.ref,
        [`${PROJECT}_remote:/remote:ro`],
        `ls /remote/${BUCKET}/backups`,
      ).split("\n");
      expect(copied).toContain(id);
      expect(copied).not.toContain(release);
      expect(inside(IMAGES.busybox.ref, volumes, `ls /s/${release}`).split("\n")).toEqual([
        "about.json",
        "db.dump",
      ]);

      // The off-server copy decrypts with the identity to exactly the snapshot's files.
      const remote = `/remote/${BUCKET}/backups/${id}`;
      const decrypted = inside(
        IMAGES.rclone.ref,
        [...volumes, `${PROJECT}_snapshot_tools:/tools:ro`, `${PROJECT}_remote:/remote:ro`],
        [
          "set -e",
          "umask 077",
          "cat > /tmp/id",
          "tar -xzf /tools/age.tar.gz -C /tmp age/age",
          `ls ${remote}`,
          "for f in about.json db.dump queue.rdb sqlite.tar; do",
          `  a=$(/tmp/age/age -d -i /tmp/id ${remote}/$f.age | sha256sum | cut -d ' ' -f 1)`,
          `  b=$(sha256sum /s/${id}/$f | cut -d ' ' -f 1)`,
          '  if [ "$a" = "$b" ]; then echo "$f same"; else echo "$f differs"; fi',
          "done",
        ].join("\n"),
        `${identity}\n`,
      ).split("\n");
      expect(decrypted).toEqual([
        "about.json.age",
        "db.dump.age",
        "queue.rdb.age",
        "sqlite.tar.age",
        "about.json same",
        "db.dump same",
        "queue.rdb same",
        "sqlite.tar same",
      ]);

      const logs = compose(["logs", "--no-color"]);
      for (const secret of passwords) {
        expect(logs).not.toContain(secret);
        expect(JSON.stringify(about)).not.toContain(secret);
      }
    });

    it("skips an app's SQLite volume that holds no database yet, which never fails a snapshot", () => {
      if (spawnSync("docker", ["image", "inspect", IMAGES.python.ref]).status !== 0) {
        pulled.push(IMAGES.python.ref);
      }
      const stack = parse(renderPortainerStack(plan(), testContext()).content) as {
        services: Record<string, Service>;
      };
      const entrypoint = stack.services["snapshots-sqlite"]?.entrypoint as string[] | undefined;
      const text = entrypoint?.[2] ?? "";
      const lines = text.replaceAll("$$", "$").split("\n");
      const take = lines.slice(0, lines.indexOf("}") + 1).join("\n");
      // A fresh anonymous volume, removed with the container.
      const output = inside(
        IMAGES.python.ref,
        ["/sqlite"],
        `${take}\ntake /snapshots/slot.partial; echo "r=$?"; ls /snapshots/slot.partial`,
      );
      expect(output.split("\n")).toEqual(["r=0", "sqlite.skipped"]);
    });
  },
);

/** A database the scheduled drill proves, and three tables (collections) made in its `app`. */
interface DrillKind {
  kind: "postgres" | "mysql" | "mariadb" | "mongodb";
  seed: string;
}

const THREE_TABLES =
  "CREATE TABLE a (id int); CREATE TABLE b (id int); CREATE TABLE c (id int); INSERT INTO a VALUES (1);";

const DRILL_KINDS: DrillKind[] = [
  {
    kind: "postgres",
    seed: `PGPASSWORD="$POSTGRES_PASSWORD" psql -X -q -h 127.0.0.1 -U app -d app -v ON_ERROR_STOP=1 -c "${THREE_TABLES}"`,
  },
  {
    kind: "mysql",
    seed: `MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -h 127.0.0.1 -u root app -e "${THREE_TABLES}"`,
  },
  {
    kind: "mariadb",
    seed: `MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb -h 127.0.0.1 -u root app -e "${THREE_TABLES}"`,
  },
  {
    kind: "mongodb",
    seed: `HOME=/tmp mongosh --quiet --nodb --eval 'const db = connect("mongodb://127.0.0.1:27017/admin"); db.auth("app", process.env.MONGO_INITDB_ROOT_PASSWORD); const app = db.getSiblingDB("app"); app.a.insertOne({ x: 1 }); app.b.insertOne({ x: 1 }); app.c.insertOne({ x: 1 })'`,
  },
];

/** `shop` on Portainer with the database `db` of `drill.kind`, scheduled snapshots and drills. */
function drillPlan(drill: DrillKind): DeployPlan {
  const { services } = withServices([{ kind: drill.kind, name: "db", enabled: true }]);
  return DeployPlanSchema.parse({
    ...portainerTestPlan(),
    services,
    snapshots: { schedule: {}, drills: { schedule: "weekly" } },
  });
}

/** The shell functions of a service's loop: its script up to the loop, as the container sees it. */
function functionsOf(service: Service | undefined): string {
  const text = ((service?.entrypoint as string[] | undefined)?.[2] ?? "").replaceAll("$$", "$");
  const end = text.indexOf("while :; do");
  if (end < 0) throw new Error("The service runs no loop.");
  return text.slice(0, end);
}

/** The drills' projects, removed at the end with their volumes. */
const drillProjects: { project: string; folder: string }[] = [];

afterAll(() => {
  for (const { project, folder } of drillProjects) {
    spawnSync("docker", ["compose", "-p", project, "down", "-v", "--remove-orphans", "-t", "1"], {
      cwd: folder,
      encoding: "utf8",
      timeout: 120_000,
    });
    rmSync(folder, { recursive: true, force: true });
    // Made by the test before Compose, so Compose leaves it.
    spawnSync("docker", ["volume", "rm", `${project}_snapshots`]);
  }
}, 300_000);

describe.skipIf(reason !== undefined)(
  "Portainer's scheduled drills on Docker",
  { timeout: 1_200_000 },
  () => {
    it.each(DRILL_KINDS)(
      "restores $kind's latest scheduled dump into a scratch server of its own, counts its tables and clears it",
      async (drill) => {
        const plan = drillPlan(drill);
        for (const ref of [IMAGES[drill.kind].ref, IMAGES.busybox.ref]) {
          if (
            !pulled.includes(ref) &&
            spawnSync("docker", ["image", "inspect", ref]).status !== 0
          ) {
            pulled.push(ref);
          }
        }
        const project = `opscrew-t2937-${drill.kind}-${RUN}`;
        const folder = mkdtempSync(join(tmpdir(), "opscrew-portainer-drill-"));
        drillProjects.push({ project, folder });
        const stack = parse(
          fillPortainerStack(renderPortainerStack(plan, testContext()).content, IMAGE),
        ) as {
          services: Record<string, Service>;
          volumes: Record<string, unknown>;
          configs?: Record<string, unknown>;
        };
        const names = ["db", "snapshots-db", "snapshots", "drill-db"];
        const services = Object.fromEntries(names.map((name) => [name, stack.services[name]]));
        const loop = stack.services["drill-db"] as Service;
        services["drill-db"] = {
          ...loop,
          environment: { OPSCREW_DRILL_EVERY: "15", OPSCREW_DRILL_AFTER: "0" },
        };
        writeFileSync(
          join(folder, "compose.yaml"),
          stringify({
            name: project,
            services,
            networks: { internal: {} },
            volumes: stack.volumes,
            ...(stack.configs === undefined ? {} : { configs: stack.configs }),
          }),
        );
        const secrets = portainerSecretVariables(plan).map((entry) => ({
          ...entry,
          value: randomBytes(16).toString("hex"),
        }));
        writeFileSync(
          join(folder, ".env"),
          [
            "OPSCREW_DB_USER=app",
            "OPSCREW_DB_NAME=app",
            ...secrets.map(({ variable, value }) => `${variable}=${value}`),
            "",
          ].join("\n"),
        );
        const compose = (args: string[], timeoutMs?: number) =>
          docker(["compose", "-p", project, ...args], { cwd: folder, timeoutMs });

        compose(["up", "-d", "--wait", "--wait-timeout", "300", "db"], 900_000);
        compose(["exec", "-T", "db", "sh", "-c", drill.seed]);

        // A scheduled snapshot of the running version, taken by the stack's own part and finished
        // by its finalizer.
        const id = "20261101T000000Z";
        const snapshots = [`${project}_snapshots:/s`];
        inside(IMAGES.busybox.ref, snapshots, `echo ${IMAGE} > /s/.running`);
        const run = (service: string, script: string) =>
          compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", service, "-c", script]);
        run(
          "snapshots-db",
          `${functionsOf(services["snapshots-db"])}\ntake /snapshots/${id}.partial`,
        );
        run(
          "snapshots",
          `${functionsOf(services.snapshots)}\nfinish /snapshots/${id}.partial ${id} scheduled`,
        );
        expect(inside(IMAGES.busybox.ref, snapshots, `ls /s/${id}`).split("\n")).toEqual([
          "about.json",
          "db.dump",
        ]);

        // A crashed run's scratch, in the drill's own volume.
        compose(["create", "drill-db"]);
        const scratch = `${project}_db_drill`;
        inside(
          IMAGES.busybox.ref,
          [`${scratch}:/x`],
          "mkdir -p /x/drill && echo left > /x/drill/left",
        );
        const db = compose(["ps", "-q", "db"]);
        const before = docker([
          "inspect",
          "--format",
          "{{.State.StartedAt}} {{.RestartCount}}",
          db,
        ]);

        compose(["up", "-d", "--no-deps", "drill-db"]);
        const begun = Date.now();
        let line: string | undefined;
        while (line === undefined) {
          if (Date.now() - begun > 600_000) {
            throw new Error(`No drill ended in 10 minutes:\n${compose(["logs", "drill-db"])}`);
          }
          await sleep(5000);
          line = compose(["logs", "--no-color", "--no-log-prefix", "drill-db"])
            .split("\n")
            .find((each) => each.startsWith("drill-record "));
        }
        const container = compose(["ps", "-aq", "drill-db"]);
        compose(["stop", "-t", "1", "drill-db"]);

        const hex = IMAGE.slice(IMAGE.indexOf("@sha256:") + "@sha256:".length);
        const record = drillRecord(line.slice("drill-record ".length));
        expect(record, line).toMatchObject({
          kind: "scheduled",
          result: "healthy",
          id,
          version: hex.slice(0, 12),
          parts: [{ name: "db", size: expect.any(Number), seconds: expect.any(Number) }],
          tables: [{ service: "db", count: 3 }],
          removal: "removed",
          cleaned: true,
        });
        expect(record?.reason, line).toBeUndefined();
        expect(record?.parts[0]?.size).toBeGreaterThan(0);

        // The scratch is gone; the container had no network and read the snapshots read-only.
        expect(inside(IMAGES.busybox.ref, [`${scratch}:/x:ro`], "ls -A /x")).not.toContain("drill");
        expect(docker(["inspect", "--format", "{{.HostConfig.NetworkMode}}", container])).toBe(
          "none",
        );
        expect(
          docker([
            "inspect",
            "--format",
            "{{range .Mounts}}{{.Destination}}={{.RW}} {{end}}",
            container,
          ]),
        ).toContain("/snapshots=false");

        // The service ran on, untouched, with its three tables.
        expect(docker(["inspect", "--format", "{{.State.StartedAt}} {{.RestartCount}}", db])).toBe(
          before,
        );
        const part = { name: "127.0.0.1", kind: drill.kind, file: "db.dump", online: true };
        const count = databaseCount(part);
        expect(compose(["exec", "-T", "db", "sh", "-c", count ?? "false"])).toMatch(/(^|\n)3$/);

        const logs = compose(["logs", "--no-color"]);
        for (const { value } of secrets) expect(logs).not.toContain(value);
      },
    );
  },
);
