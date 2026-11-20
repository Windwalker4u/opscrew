import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FakeFile } from "@opscrew/connector-docker/testing";
import { findExecutable, OpsCrewError } from "@opscrew/core";
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

/** The delta operations the window asked the carriers for (after its approval). */
const windowDeltas = (h: PairHarness, before: number) => h.hosts.deltas.slice(before);

/** Everything a run showed, audited, asked for or sent to the carriers. */
function shown(h: PairHarness, error?: unknown): string {
  return [
    h.reporter.text(),
    JSON.stringify(h.audit.entries),
    JSON.stringify(h.handler.requests),
    JSON.stringify(h.hosts.deltas),
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

/** Answers the window's approval after `change` ran, as writes while the old app still serves. */
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

describe.skipIf(!findExecutable("git"))(
  "the copy while the app serves, and the window's delta",
  () => {
    it("copies only what changed since the first copy, removes what went, and checks the digests", async () => {
      const h = await pairHarness("hetzner", "own", { cache: true });
      const at = changeBeforeWindow(h, () => cacheWrites(h));
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");

      // The window read both manifests, then copied the changed and new paths and removed the gone.
      expect(windowDeltas(h, at.deltas)).toEqual([
        { op: "volumeManifest" },
        { op: "volumeManifest" },
        { op: "readPaths", paths: ["./dump.rdb", "./new", "./new/appendonly.aof"] },
        {
          op: "updateVolume",
          paths: [".", "./dump.rdb", "./new", "./new/appendonly.aof"],
          remove: ["./PG_VERSION"],
        },
      ]);
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
      expect(windowDeltas(h, at.deltas).filter((call) => call.op !== "volumeManifest")).toEqual([
        { op: "readPaths", paths: ["./dump.rdb", "./new", "./new/appendonly.aof"] },
        {
          op: "updateVolume",
          paths: [".", "./dump.rdb", "./new", "./new/appendonly.aof"],
          remove: ["./PG_VERSION"],
        },
      ]);
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
          h.hosts.lowDisk = true;
        },
      },
    ])("copies a mount whole when the carrier refuses its delta: $why", async ({ refuse }) => {
      const h = await pairHarness("hetzner", "own", { cache: true });
      const at = changeBeforeWindow(h, () => refuse(h));
      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      expect(windowDeltas(h, at.deltas).some((call) => call.op === "updateVolume")).toBe(false);
      expect(listing(h, NEW_IPV4, "cache")).toEqual(listing(h, OLD_IPV4, "cache"));
      expect(h.reporter.text()).toContain(
        "OpsCrew can't copy only what changed in cache's data at /var/lib/postgresql/data (a name in it can't be listed, or the old server on Hetzner Cloud has too little free disk to gather the changes), so it copies it whole",
      );
      await expectNoLeak(h, ["odd name", "line\nbreak"]);
    });

    it("the PHP app: its kept folder and MySQL, Railpack's PHP image, and a release command that needs the data", async () => {
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
      h.hosts.hasData = (ip) =>
        h.hosts.docker(ip).folders.get("/srv/data/shop/mysql")?.files.has("shop/settings.ibd") ===
        true;
      const at = changeBeforeWindow(h, () => {
        // While the PHP app serves: a new avatar, a rewritten table file, a cleared view cache.
        const storage = h.hosts.docker(OLD_IPV4).folders.get("/srv/data/shop/storage")?.files;
        storage?.set("avatars/two.png", file("a new avatar"));
        storage?.delete("cache/old.php");
        files(h, OLD_IPV4, "mysql").set("ibdata1", file("tables with a new post"));
      });

      expect(await maintenanceWindow(h.session, { allowDowntime: true })).toBe("done");
      // The deploy before the window ran the release command on the data copied while the PHP app
      // served (it found the settings), and the app answered there.
      const lines = trail(h.events);
      const window = lines.indexOf("approve remote-exec");
      expect(lines.slice(0, window)).toEqual(
        expect.arrayContaining([
          `${NEW_IPV4} stop app`,
          `${NEW_IPV4} stop mysql`,
          `${NEW_IPV4} start mysql`,
          `${NEW_IPV4} mark copied`,
          `dispatch main sha256:${"e".repeat(12)}`,
        ]),
      );
      // The window: only the delta of each mount, the release command on the final data, the app
      // started again in place, no workflow run.
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
      const copied = windowDeltas(h, at.deltas).filter((call) => call.op !== "volumeManifest");
      expect(copied).toEqual([
        { op: "readPaths", paths: ["./avatars/two.png"] },
        {
          op: "updateVolume",
          paths: [".", "./avatars", "./avatars/two.png"],
          remove: ["./cache/old.php"],
        },
        { op: "readPaths", paths: ["./ibdata1"] },
        { op: "updateVolume", paths: [".", "./ibdata1"], remove: [] },
      ]);
      for (const mount of ["storage", "mysql"]) {
        expect(listing(h, NEW_IPV4, mount)).toEqual(listing(h, OLD_IPV4, mount));
      }
      expect(h.hosts.host(NEW_IPV4)).toMatchObject({ app: true, marker: undefined });
      expect(h.session.plan.app.build).toMatchObject({ builder: "railpack", webRoot: "public" });
      const request = h.handler.requests.find((r) => r.title.startsWith("Maintenance window"));
      expect(request?.details).toContain("what changed in the app's data at /app/storage");
      expect(request?.details).toContain(
        "what changed in mysql's data at /var/lib/postgresql/data",
      );
      expect(request?.details).toContain(
        "run the release command (app.releaseCommand) on the final data",
      );
      await expectNoLeak(h, [
        "an avatar",
        "a new avatar",
        "a compiled view",
        "tables with a new post",
        "the PHP app's settings",
      ]);
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
