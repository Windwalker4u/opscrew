import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeFile } from "@opscrew/connector-docker/testing";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { OLD_IPV4, PORTAINER_TOKEN, PORTAINER_URL, TOKENS } from "../testing";
import { trail } from "./__fixtures__/assert";
import {
  DB_PASSWORD,
  NEW_IPV4,
  type PairHarness,
  PORTAINER,
  pairHarness,
} from "./__fixtures__/pairs";
import { moveSide } from "./sides";
import { maintenanceWindow } from "./window";

/** A file of the app's data (synthetic content, which nothing may print). */
const file = (text: string): FakeFile => ({
  type: "file",
  mode: 0o640,
  uid: 999,
  gid: 999,
  data: Buffer.from(text),
});
const folder = (): FakeFile => ({ type: "dir", mode: 0o750, uid: 999, gid: 999 });

/** A mount's files on a side: a folder on a server, a volume in Portainer. */
function files(h: PairHarness, host: string, mount: string): Map<string, FakeFile> {
  const docker = h.hosts.docker(host);
  const found =
    host === PORTAINER
      ? docker.volumes.get(`opscrew-shop_${mount}_data`)
      : docker.folders.get(`/srv/data/shop/${mount}`);
  if (found === undefined) throw new Error(`no ${mount} on ${host}`);
  return found.files;
}

/** A mount's files as `path content` lines, sorted. */
const listing = (h: PairHarness, host: string, mount: string) =>
  [...files(h, host, mount)]
    .map(([path, entry]) => `${path} ${entry.type} ${entry.data?.toString("utf8") ?? ""}`)
    .sort();

/** Everything a run showed, audited or asked for. */
function shown(h: PairHarness, error?: unknown): string {
  return [
    h.reporter.text(),
    JSON.stringify(h.audit.entries),
    JSON.stringify(h.handler.requests),
    error instanceof OpsCrewError ? `${error.message} ${error.hint ?? ""}` : "",
  ].join("\n");
}

/** The secrets, addresses and file contents no text may hold. */
async function expectNoLeak(h: PairHarness, contents: readonly string[], error?: unknown) {
  const key = (await readFile(h.session.deployKey.privateKeyFile, "utf8")).trim();
  const text = shown(h, error);
  for (const secret of [
    OLD_IPV4,
    NEW_IPV4,
    DB_PASSWORD,
    PORTAINER_TOKEN,
    new URL(PORTAINER_URL).hostname,
    key,
    ...Object.values(TOKENS),
    ...contents,
  ]) {
    expect(text).not.toContain(secret);
  }
}

/** While the old app serves, after the first copy: the cache rewrites, adds and removes files. */
function cacheWrites(h: PairHarness): void {
  const cache = files(h, h.oldHost, "cache");
  cache.set("dump.rdb", file("cached pages, rewritten"));
  cache.set("new", folder());
  cache.set("new/appendonly.aof", file("appended while serving"));
  cache.delete("PG_VERSION");
}

/**
 * Answers the window's approval after `change` ran, as writes while the old app still serves.
 * `at.deltas` is where the window's carrier path lists start in `h.hosts.deltas`.
 */
function changeBeforeWindow(h: PairHarness, change: () => void): { deltas: number } {
  const at = { deltas: -1 };
  h.handler.answer = (request) => {
    if (request.title.startsWith("Maintenance window")) {
      change();
      at.deltas = h.hosts.deltas.length;
    }
    return true;
  };
  return at;
}

/** The cache's paths the window read on the old side and removed on the new one. */
const cacheDelta = (old: string, fresh: string) => [
  { host: old, op: "readPaths", paths: [".", "./dump.rdb", "./new", "./new/appendonly.aof"] },
  { host: fresh, op: "updateVolume", paths: ["./PG_VERSION"] },
];

describe.skipIf(!findExecutable("git"))(
  "the copy while the app serves, and the window's delta",
  () => {
    it("copies only what changed since the first copy, removes what went, and checks the digests", async () => {
      const h = await pairHarness("hetzner", "own", { cache: true });
      const at = changeBeforeWindow(h, () => cacheWrites(h));
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");

      // The window gathered the changed and new paths on the old side (with the root and the
      // folders above them) and removed the gone on the new side, first.
      expect(h.hosts.deltas.slice(at.deltas)).toEqual(cacheDelta(OLD_IPV4, NEW_IPV4));
      // Both sides hold the same, which the digests checked.
      expect(listing(h, NEW_IPV4, "cache")).toEqual(listing(h, OLD_IPV4, "cache"));
      expect(listing(h, NEW_IPV4, "cache")).toContain(
        "new/appendonly.aof file appended while serving",
      );
      expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, db: "orders before the move" });

      // The old app stopped only from the window's start; nothing ran a workflow in the window.
      const lines = trail(h.events);
      const window = lines.indexOf("approve remote-exec");
      expect(lines.slice(0, window).filter((line) => line.startsWith(`${OLD_IPV4} stop`))).toEqual(
        [],
      );
      expect(lines.indexOf(`${OLD_IPV4} stop app`)).toBeGreaterThan(window);
      expect(lines.slice(window).filter((line) => line.startsWith("dispatch"))).toEqual([]);
      expect(lines.slice(0, window)).toContain(`dispatch main sha256:${"e".repeat(12)}`);
      expect(h.session.plan.retarget?.step).toBe("migrated");

      // The approval gives the first copy apart from the window's minutes: a minute, the 50 MB
      // database's dump and restore, and the cache's changes.
      const request = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
      expect(request?.title).toContain("copied while your app served");
      expect(request?.title).toContain("(about 3 minutes of downtime)");
      expect(request?.details).toContain(
        "While your app served, its data (50.0 MB) was copied to your new server, and the app started there on that copy and answered.",
      );
      expect(request?.details).toContain(
        "what changed in cache's data at /var/lib/postgresql/data",
      );
      expect(request?.details).not.toContain("deploy workflow");
      expect(h.reporter.text()).toContain("while your app serves (about 8 minutes)");
      // The record of the first copy goes with the window.
      expect(existsSync(join(h.paths.stateDir, "retarget-precopied.json"))).toBe(false);
      await expectNoLeak(h, ["cached pages, rewritten", "appended while serving"]);
    });

    it("a run stopped at the window's approval doesn't copy again", async () => {
      const h = await pairHarness("hetzner", "own", { cache: true });
      h.handler.answer = (request) => !request.title.startsWith("Maintenance window");
      const refused = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
        (e: unknown) => e,
      );
      expect(refused).toMatchObject({
        code: "APPROVAL_REFUSED",
        message:
          "The maintenance window was not approved. The app on the old server on Hetzner Cloud keeps running; the copy of its data on your new server stays for the next run.",
      });
      expect(h.hosts.host(OLD_IPV4).app).toBe(true);
      expect(h.session.plan.retarget?.oldAppStoppedAt).toBeUndefined();
      const dispatched = h.github.runs.length;

      h.handler.answer = () => true;
      const mark = h.events.length;
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      // Straight to the window: no copy while serving, no deploy run before it.
      expect(trail(h.events.slice(mark))[0]).toBe("approve remote-exec");
      expect(h.github.runs).toHaveLength(dispatched);
    });

    it("a Portainer new side gets the copy while the app serves and the delta; its app starts as before", async () => {
      const h = await pairHarness("own", "portainer", { cache: true });
      const at = changeBeforeWindow(h, () => {
        cacheWrites(h);
        // Before the window the app there stays stopped: it starts on the final data.
        const app = [...h.hosts.docker(PORTAINER).containers.values()].find(
          (c) => c.labels["com.docker.compose.service"] === "app",
        );
        expect(app?.state).toBe("exited");
      });
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      expect(h.hosts.deltas.slice(at.deltas)).toEqual(cacheDelta(OLD_IPV4, PORTAINER));
      expect(listing(h, PORTAINER, "cache")).toEqual(listing(h, OLD_IPV4, "cache"));
      expect(h.hosts.host(PORTAINER).db).toBe("orders before the move");
      // Portainer's app starts with its own start, no workflow and no marker.
      expect(h.github.runs).toEqual([]);
      expect(h.events.some((e) => e.type === "remote" && e.op.startsWith("mark"))).toBe(false);
      const app = [...h.hosts.docker(PORTAINER).containers.values()].find(
        (c) => c.labels["com.docker.compose.service"] === "app",
      );
      expect(app?.state).toBe("running");
      await expectNoLeak(h, ["cached pages, rewritten", "appended while serving"]);
    });

    it.each([
      {
        why: "a name the carrier can't list",
        refuse: (h: PairHarness) => {
          files(h, h.oldHost, "cache").set("line\nbreak.txt", file("odd name"));
        },
      },
      {
        why: "too little free disk on the old side to gather the changes",
        refuse: (h: PairHarness) => {
          cacheWrites(h);
          h.hosts.docker(h.oldHost).freeDisk = 0;
        },
      },
    ])("copies a mount whole when the carrier refuses its delta: $why", async ({ refuse }) => {
      const h = await pairHarness("hetzner", "own", { cache: true });
      const at = changeBeforeWindow(h, () => refuse(h));
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      expect(h.hosts.deltas.slice(at.deltas).some((call) => call.op === "updateVolume")).toBe(
        false,
      );
      expect(listing(h, NEW_IPV4, "cache")).toEqual(listing(h, OLD_IPV4, "cache"));
      expect(h.reporter.text()).toContain(
        "OpsCrew can't copy only what changed in cache's data at /var/lib/postgresql/data (a name in it can't be listed, or the old server on Hetzner Cloud has too little free disk to gather the changes), so it copies it whole",
      );
      await expectNoLeak(h, ["odd name", "line\nbreak"]);
    });

    it("a move with nothing to copy has no copy while the app serves and no window", async () => {
      const h = await pairHarness("hetzner", "portainer");
      const move = h.session.plan.retarget;
      if (move === undefined) throw new Error("no move");
      h.session.plan = { ...h.session.plan, retarget: { ...move, empty: ["db"] } };
      const mark = h.events.length;
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      expect(trail(h.events.slice(mark))).toEqual([]);
      expect(h.hosts.deltas).toEqual([]);
      expect(h.reporter.text()).not.toContain("while your app serves");
      expect(existsSync(join(h.paths.stateDir, "retarget-precopied.json"))).toBe(false);
    });
  },
);

/** MySQL's root password in OpsCrew's generated values (synthetic). */
const ROOT_PASSWORD = fakeSecret("generic-password", "mysql root");

/**
 * The PHP app's move (031): a PHP framework on Railpack's PHP image with its kept folder and MySQL, no
 * Postgres, a release command that needs the PHP app's settings table, onto a server.
 */
async function forumHarness(): Promise<PairHarness> {
  const h = await pairHarness("hetzner", "own", { release: true });
  const mysql = {
    kind: "mysql",
    version: "8.4",
    memoryMb: 512,
    reason: "mysql2",
    licence: "GPL-2.0",
  };
  const base = h.session.plan;
  const plan = DeployPlanSchema.parse({
    ...base,
    services: [mysql],
    storage: { files: { dir: "storage" } },
    app: {
      ...base.app,
      env: base.app.env.filter((v) => v.name !== "DATABASE_URL"),
      releaseCommand: "php bin/console migrate",
      build: {
        builder: "railpack",
        chosen: "auto",
        reason: "Railpack builds plain PHP apps.",
        runtime: { language: "php", version: "8.4" },
        probe: "php",
        webRoot: "public",
      },
    },
  });
  h.session.plan = plan;
  await writeArtifact("plan", h.paths.files.plan, plan);
  await writeFile(
    `${h.paths.projectHomeDir}/generated_values.json`,
    `${JSON.stringify({ dbPassword: DB_PASSWORD, services: { mysql: { "root-password": ROOT_PASSWORD } } })}\n`,
  );
  // Both sides as their deploys leave them: MySQL instead of Postgres, and the app's kept
  // folder bound into its container; the old side holds the PHP app's data.
  h.hosts.services = ["mysql"];
  for (const ip of [OLD_IPV4, NEW_IPV4]) {
    const docker = h.hosts.docker(ip);
    for (const [id, container] of docker.containers) {
      if (container.labels["com.docker.compose.service"] === "db") docker.containers.delete(id);
      if (container.labels["com.docker.compose.service"] === "app") {
        container.mounts.push({
          type: "bind",
          source: "/srv/data/shop/storage",
          target: "/app/storage",
        });
      }
    }
    docker.addFolder(
      "/srv/data/shop/storage",
      ip === OLD_IPV4
        ? {
            avatars: folder(),
            "avatars/one.png": file("an avatar"),
            cache: folder(),
            "cache/old.php": file("a compiled view"),
          }
        : {},
    );
  }
  h.hosts.seed(OLD_IPV4, {
    ibdata1: file("tables before the move"),
    shop: folder(),
    "shop/settings.ibd": file("the PHP app's settings"),
  });
  h.hosts.seed(NEW_IPV4);
  // the framework's migrate needs its settings table.
  h.hosts.releaseNeedsData = true;
  h.hosts.hasData = (ip) => files(h, ip, "mysql").has("shop/settings.ibd");
  return h;
}

/** The PHP app's writes while it serves: a new avatar, a rewritten table file, a cleared cache. */
function forumWrites(h: PairHarness): void {
  const storage = files(h, OLD_IPV4, "storage");
  storage.set("avatars/two.png", file("a new avatar"));
  storage.delete("cache/old.php");
  files(h, OLD_IPV4, "mysql").set("ibdata1", file("tables with a new post"));
}

/** What the PHP app's tests must never show: its data, and MySQL's root password. */
const FORUM_DATA = [
  ROOT_PASSWORD,
  "an avatar",
  "a new avatar",
  "a compiled view",
  "tables with a new post",
  "the PHP app's settings",
];

describe.skipIf(!findExecutable("git"))("the PHP app's move: a kept folder and MySQL", () => {
  it("dumps MySQL consistently while the PHP app serves, then copies the folders' changes in the window", async () => {
    const h = await forumHarness();
    // What the new side runs on each server command (the services start waiting until they run).
    const commands: string[] = [];
    const run = h.hosts.run.bind(h.hosts);
    h.hosts.run = async (ip, command) => {
      if (ip === NEW_IPV4) commands.push(command);
      return run(ip, command);
    };
    let atWindow: { deltas: number; commands: number; app: boolean; marker?: string } | undefined;
    let restored: string[] = [];
    h.handler.answer = (request) => {
      if (request.title.startsWith("Maintenance window")) {
        restored = listing(h, NEW_IPV4, "mysql");
        const host = h.hosts.host(NEW_IPV4);
        atWindow = {
          deltas: h.hosts.deltas.length,
          commands: commands.length,
          app: host.app,
          ...(host.marker !== undefined ? { marker: host.marker } : {}),
        };
        forumWrites(h);
      }
      return true;
    };
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");

    // Before the window, while the PHP app serves: its kept folder copied whole, MySQL by a
    // consistent dump restored on the new side (never its live files), the deploy's release
    // command on that copy (it found the settings), the app checked, then stopped and held.
    const lines = trail(h.events);
    const window = lines.indexOf("approve remote-exec");
    expect(lines.slice(0, window)).toEqual([
      `${NEW_IPV4} stop app`,
      `${NEW_IPV4} stop mysql`,
      `${NEW_IPV4} start mysql`,
      `${OLD_IPV4} dump mysql`,
      `${NEW_IPV4} restore mysql`,
      `${NEW_IPV4} mark copied`,
      `dispatch main sha256:${"e".repeat(12)}`,
      `${NEW_IPV4} stop caddy`,
      `${NEW_IPV4} stop app`,
      `${NEW_IPV4} mark waiting`,
    ]);
    const copiedWhole = h.audit.entries
      .slice(
        0,
        h.audit.entries.findIndex((e) => e.action === "maintenance window"),
      )
      .filter((e) => e.action.startsWith("copy "))
      .map((e) => e.action);
    expect(copiedWhole).toEqual(["copy app /app/storage", "copy database dump"]);
    expect(restored).toContain("shop/settings.ibd file the PHP app's settings (restored)");
    // At the window's approval nothing of the app runs on the new server.
    expect(atWindow).toEqual(expect.objectContaining({ app: false, marker: "waiting" }));

    // The window: the old app and MySQL stop, then each folder's delta: the kept folder's
    // changes, MySQL's about whole (its files differ after the restore), with both MySQLs
    // stopped; MySQL starts waiting until it runs, then the release command on the final data,
    // the app started again in place, no workflow run.
    expect(lines.slice(window)).toEqual([
      "approve remote-exec",
      `${OLD_IPV4} stop app`,
      `${OLD_IPV4} stop mysql`,
      `${NEW_IPV4} stop app`,
      `${NEW_IPV4} stop mysql`,
      `${NEW_IPV4} start mysql`,
      `${NEW_IPV4} release`,
      `${NEW_IPV4} start app`,
      `${NEW_IPV4} remove marker`,
    ]);
    expect(h.hosts.deltas.slice(atWindow?.deltas)).toEqual([
      { host: OLD_IPV4, op: "readPaths", paths: [".", "./avatars", "./avatars/two.png"] },
      { host: NEW_IPV4, op: "updateVolume", paths: ["./cache/old.php"] },
      {
        host: OLD_IPV4,
        op: "readPaths",
        paths: [".", "./shop", "./shop/settings.ibd", "./ibdata1"],
      },
      { host: NEW_IPV4, op: "updateVolume", paths: [] },
    ]);
    for (const mount of ["storage", "mysql"]) {
      expect(listing(h, NEW_IPV4, mount)).toEqual(listing(h, OLD_IPV4, mount));
    }
    const windowCommands = commands.slice(atWindow?.commands);
    const started = windowCommands.findIndex((c) =>
      c.endsWith("docker compose up -d --wait mysql"),
    );
    expect(started).toBeGreaterThanOrEqual(0);
    expect(started).toBeLessThan(
      windowCommands.findIndex((c) => c.endsWith("docker compose run --rm --no-deps -T release")),
    );
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, marker: undefined });
    expect(h.session.plan.app.build).toMatchObject({ builder: "railpack", webRoot: "public" });
    for (const ip of [OLD_IPV4, NEW_IPV4]) {
      expect(h.hosts.docker(ip).volumes.has("opscrew-move-dump-shop-mysql")).toBe(false);
    }

    // The estimate: MySQL's folder about whole in the window, the kept folder at a twentieth.
    const request = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
    expect(request?.details).toContain("what changed in the app's data at /app/storage");
    expect(request?.details).toContain(
      "mysql's data at /var/lib/postgresql/data (42 bytes), about all of it: its files differ after its restore while your app served",
    );
    expect(request?.details).toContain(
      "run the release command (app.releaseCommand) on the final data",
    );
    expect(request?.title).toContain("(about 3 minutes of downtime)");
    await expectNoLeak(h, FORUM_DATA);
  });

  it("a MySQL dump that fails stops before the window, its dump volumes gone", async () => {
    const h = await forumHarness();
    h.hosts.fail = (ip, op) =>
      ip === OLD_IPV4 && op === "dump mysql"
        ? { exitCode: 2, stdout: "", stderr: `mysqldump: Got error: 1045 ${ROOT_PASSWORD}` }
        : undefined;
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "Copying the app's data to your new server while your app serves failed: Could not dump the databases of mysql (exit code 2). The app on the old server on Hetzner Cloud kept serving: nothing there was stopped.",
    );
    expect(h.handler.requests.some((r) => r.title.startsWith("Maintenance window"))).toBe(false);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: false, marker: "waiting" });
    for (const ip of [OLD_IPV4, NEW_IPV4]) {
      expect(h.hosts.docker(ip).volumes.has("opscrew-move-dump-shop-mysql")).toBe(false);
    }
    await expectNoLeak(h, FORUM_DATA, error);
  });

  it("needs MySQL's root password before anything is asked or changed", async () => {
    const h = await forumHarness();
    await writeFile(
      `${h.paths.projectHomeDir}/generated_values.json`,
      `${JSON.stringify({ dbPassword: DB_PASSWORD })}\n`,
    );
    const mark = h.events.length;
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "OpsCrew does not have mysql's root password on this computer, so it cannot copy its databases. Nothing was changed.",
    });
    expect(trail(h.events.slice(mark))).toEqual([]);
    expect(h.hosts.host(OLD_IPV4).app).toBe(true);
  });
  it("a rerun after a copy that failed once its release migrated the copy starts from an empty MySQL", async () => {
    const h = await forumHarness();
    // the framework's migration adds a table; it fails where the table is there already, as on a copy
    // whose migration ran while the dump's restore keeps every table it doesn't hold.
    h.hosts.hasData = (ip) => {
      const mysql = files(h, ip, "mysql");
      if (!mysql.has("shop/settings.ibd") || mysql.has("shop/posts_v2.ibd")) return false;
      mysql.set("shop/posts_v2.ibd", file("a migrated table"));
      return true;
    };
    // The app's check fails after the deploy's release command migrated the copy.
    h.hosts.fail = (ip, op) =>
      ip === NEW_IPV4 && op === "health" ? { exitCode: 1, stdout: "", stderr: "502" } : undefined;
    const error = await maintenanceWindow(h.session, { allowDowntime: true }).catch(
      (e: unknown) => e,
    );
    expect((error as OpsCrewError).message).toContain("while your app serves failed");
    expect(files(h, NEW_IPV4, "mysql").has("shop/posts_v2.ibd")).toBe(true);

    // The rerun empties MySQL's folder there before it starts, so the restore lands in an empty
    // server and the migration runs on the copy again.
    h.hosts.fail = undefined;
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
    expect(h.audit.entries).toContainEqual(
      expect.objectContaining({ action: "empty mysql /var/lib/postgresql/data" }),
    );
    expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, marker: undefined });
  });

  it("never puts root's password in a one-off container's request, only in its 0600 login file", async () => {
    const h = await forumHarness();
    const requests: string[] = [];
    const logins: FakeFile[] = [];
    for (const ip of [OLD_IPV4, NEW_IPV4]) {
      const docker = h.hosts.docker(ip);
      const previous = docker.onStart;
      docker.onStart = (container) => {
        const { image, cmd, env, labels, binds, mounts } = container;
        requests.push(JSON.stringify({ image, cmd, env, labels, binds, mounts }));
        const login = container.files?.get("tmp/opscrew.my.cnf");
        if (login !== undefined) logins.push(login);
        return previous?.(container);
      };
    }
    expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
    expect(requests.some((request) => request.includes('"mysql:8.4@'))).toBe(true);
    for (const request of requests) expect(request).not.toContain(ROOT_PASSWORD);
    // The dump, its check on each side, the ping and the restore each got the login file.
    expect(logins.length).toBeGreaterThanOrEqual(4);
    for (const login of logins) {
      expect(login.mode).toBe(0o600);
      expect(login.data?.toString("utf8")).toContain(ROOT_PASSWORD);
    }
  });
});

describe.skipIf(!findExecutable("git"))("a Portainer side's start", () => {
  /** The stack's container of `service` in the user's Portainer. */
  const container = (h: PairHarness, service: string) => {
    const found = [...h.hosts.docker(PORTAINER).containers.values()].find(
      (c) => c.labels["com.docker.compose.service"] === service,
    );
    if (found === undefined) throw new Error(`no ${service} container`);
    return found;
  };

  it("waits until each started container with a health check reports healthy, as --wait does", async () => {
    const h = await pairHarness("own", "portainer", { cache: true });
    const cache = container(h, "cache");
    cache.state = "exited";
    cache.health = "starting";
    let polls = 0;
    h.session.services.sleep = async () => {
      polls += 1;
      if (polls === 2) cache.health = "healthy";
    };
    await moveSide(h.session, "new").startServices(h.session, ["cache"]);
    expect(cache.state).toBe("running");
    expect(polls).toBe(2);

    // One that never gets there stops the start plainly, within its 5 minutes.
    cache.health = "starting";
    let now = 0;
    h.session.services.sleep = async (ms) => {
      now += ms;
    };
    h.session.services.now = () => now;
    const error = await moveSide(h.session, "new")
      .startServices(h.session, ["cache"])
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "COMMAND_FAILED",
      message: "cache did not report healthy in your Portainer within 5 minutes.",
    });
  });
});
