// Feature 029, restore drills (T2933, T2939; plan.md 19., research R18, R27, R29): `opscrew status`
// shows the last drill on each target, and a warning when a schedule has gone without one.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FakeContainer } from "@opscrew/connector-docker/testing";
import { DRILL_RECORD_PREFIX, DRILLS_LOG, drillRecord } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { folderOf, hostingTestPlan, MemoryFiles } from "../hosting/__fixtures__/account";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { PORTAINER_TOKEN, portainerWorld } from "../snapshot/__fixtures__/portainer";
import { type FakeSnapshotServer, SH_AVAILABLE } from "../snapshot/__fixtures__/server";
import {
  everythingShown,
  type SnapshotWorld,
  snapshotWorld,
  stagingPlan,
} from "../snapshot/__fixtures__/world";
import { portainerDrillsFile } from "../snapshot/drill-portainer";
import { createTestPhaseDeps, portainerPlan, SERVER_IPV4 } from "../testing";
import { drillStatusLine, drillStatusReport, hostingDrillStatusLines } from "./drill";
import { snapshotStatusReport } from "./snapshots";

const ID = "20261118T120000Z";

/** A drill's line of the log, as `snapshot.sh drill` writes it. */
function line(result: string, fields: string): string {
  return `2026-11-18T14:06:10Z manual ${result} id=${ID} version=aaaaaaaaaaaa start=2026-11-18T14:02:00Z ${fields}`;
}

const HEALTHY = line(
  "healthy",
  "parts=db:100:12 health=healthy:31 tables=db:42 removal=removed cleaned=no reason=-",
);

/** `shop` in staging with PostgreSQL `db`, with `fields`. */
const plan = (fields: Record<string, unknown> = {}) =>
  stagingPlan([{ kind: "postgres", name: "db" }], { fields });

/** The drill's report on `world`'s server, its log read with the snapshots, as `status` reads it. */
async function serverReport(world: SnapshotWorld) {
  const { drillLog } = await snapshotStatusReport(world.deps, world.plan, world.services);
  return drillStatusReport(world.deps, world.plan, drillLog);
}

describe.skipIf(!SH_AVAILABLE)("status's restore drill", () => {
  it("shows the last drill on the app's server: its snapshot, time, length and result", async () => {
    const world = await snapshotWorld(plan());
    await world.servers.app?.write(
      DRILLS_LOG,
      `${line("skipped", "parts=- health=- tables=- removal=- cleaned=no reason=locked")}\n${HEALTHY}\n`,
    );
    const { lines, drill } = await serverReport(world);
    expect(lines).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, healthy, db 42 tables.`,
    ]);
    expect(drill).toMatchObject({ result: "healthy", id: ID });
    expect(everythingShown(world)).not.toContain(SERVER_IPV4);
  });

  it("names a skip's reason, a failure, a kept copy and one that could not be removed", async () => {
    const world = await snapshotWorld(plan());
    const shown = async (text: string) => {
      await world.servers.app?.write(DRILLS_LOG, `${text}\n`);
      return (await serverReport(world)).lines;
    };
    expect(
      await shown(line("skipped", "parts=- health=- tables=- removal=- cleaned=no reason=disk")),
    ).toEqual([`Last restore drill: ${ID}, 2026-11-18 14:06 UTC, skipped: too little free disk.`]);
    expect(
      await shown(
        line(
          "unhealthy",
          "parts=db:100:12 health=unhealthy:300 tables=db:42 removal=failed cleaned=no reason=-",
        ),
      ),
    ).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, restored, but the app did not become healthy, db 42 tables; its copy could not be removed: run \`opscrew restore --drill --remove\`.`,
    ]);
    expect(
      await shown(
        line("not-restored", "parts=- health=- tables=- removal=kept cleaned=no reason=db"),
      ),
    ).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, the snapshot did not restore (db); its copy is kept: \`opscrew restore --drill --remove\` removes it.`,
    ]);
  });

  it("says none yet only with drills on, and nothing without them or data", async () => {
    const off = await snapshotWorld(plan());
    expect((await serverReport(off)).lines).toEqual([]);
    const on = await snapshotWorld(plan({ snapshots: { drills: {} } }));
    expect((await serverReport(on)).lines).toEqual([
      "Restore drills: none yet; `opscrew restore --drill` runs one.",
    ]);
    const empty = await snapshotWorld(stagingPlan([]));
    expect((await serverReport(empty)).lines).toEqual([]);
  });

  it("reads the drill in the snapshots' connection, and shows none when they were not read", async () => {
    const world = await snapshotWorld(plan());
    await world.servers.app?.write(
      DRILLS_LOG,
      `${HEALTHY}
`,
    );
    const hosts: string[] = [];
    const remote = world.services.remote;
    const services = {
      ...world.services,
      remote: (host: string) => {
        hosts.push(host);
        return (remote as NonNullable<typeof remote>)(host);
      },
    };
    const { drillLog } = await snapshotStatusReport(world.deps, world.plan, services);
    expect(hosts).toEqual([SERVER_IPV4]);
    expect((await drillStatusReport(world.deps, world.plan, drillLog)).lines).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, healthy, db 42 tables.`,
    ]);
    expect(hosts).toEqual([SERVER_IPV4]);
    // A server whose snapshots could not be read gets no drill line of its own.
    (world.servers.app as FakeSnapshotServer).answer = () => ({
      exitCode: 255,
      stdout: "",
      stderr: "refused",
    });
    expect((await serverReport(world)).lines).toEqual([]);
  });

  it("shows the last drill on this computer", async () => {
    const local = localPlan();
    const computer = new FakeComputer();
    const built = DeployPlanSchema.parse({
      ...local,
      deploy: { ...local.deploy, snapshots: true },
    });
    const { deps } = await localProject(built, computer);
    const log = join(appFolder(deps.paths, built), DRILLS_LOG);
    await mkdir(dirname(log), { recursive: true });
    await writeFile(
      log,
      `${line("skipped", "parts=- health=- tables=- removal=- cleaned=no reason=locked")}\n${HEALTHY}\n\n`,
    );
    const { lines } = await drillStatusReport(deps, built);
    expect(lines).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, healthy, db 42 tables.`,
    ]);
    // Read from the app's folder, with no shell.
    expect(computer.scripts).toEqual([]);
  });

  it("shows nothing on this computer without a drill or the setting, and none yet with it", async () => {
    const local = localPlan();
    const withSnapshots = (fields: Partial<DeployPlan> = {}) =>
      DeployPlanSchema.parse({ ...local, ...fields, deploy: { ...local.deploy, snapshots: true } });
    const computer = new FakeComputer();
    const off = withSnapshots();
    expect((await drillStatusReport((await localProject(off, computer)).deps, off)).lines).toEqual(
      [],
    );
    const on = withSnapshots({ snapshots: { drills: {} } } as Partial<DeployPlan>);
    expect((await drillStatusReport((await localProject(on, computer)).deps, on)).lines).toEqual([
      "Restore drills: none yet; `opscrew restore --drill` runs one.",
    ]);
    expect(computer.scripts).toEqual([]);
  });
});

/** The record `text` of a drills' log, as `drillRecord` reads it. */
function recordOf(text: string) {
  const record = drillRecord(text);
  if (record === undefined) throw new Error(`not a drill record: ${text}`);
  return record;
}

/** `shop` in staging with PostgreSQL `db`, snapshots and restore drills on a schedule. */
const scheduled = (every: "weekly" | "daily" = "weekly", base?: DeployPlan) =>
  stagingPlan([{ kind: "postgres", name: "db" }], {
    ...(base === undefined ? {} : { base }),
    fields: { snapshots: { schedule: {}, drills: { schedule: every } } },
  });

/** The end of the warning with a schedule, by target. */
const NO_DRILL = {
  server:
    "`opscrew restore --drill` runs one now; each drill's line is in .snapshots/drills.log in the app's folder.",
  portainer:
    "`opscrew restore --drill` runs one now; each scheduled one's line is in the log of its drill-<service> container in your Portainer.",
  hosting: "`opscrew restore --drill` runs one now; `opscrew logs` shows the agent's lines.",
};

describe("the words of a drill's reasons", () => {
  const at = (target: Parameters<typeof drillStatusLine>[2], text: string) =>
    drillStatusLine(recordOf(text), "", target);

  it("names the scheduled drill's skips and failures on a server", () => {
    const skipped = (reason: string) =>
      at(
        "server",
        `2026-11-18T03:00:05Z scheduled skipped id=- parts=- health=- tables=- removal=- cleaned=no reason=${reason}`,
      );
    expect(skipped("kept")).toBe(
      "Last restore drill: no snapshot, scheduled, 2026-11-18 03:00 UTC, skipped: a kept copy is still there.",
    );
    expect(skipped("none")).toBe(
      "Last restore drill: no snapshot, scheduled, 2026-11-18 03:00 UTC, skipped: no scheduled snapshot yet.",
    );
    expect(
      at(
        "server",
        `2026-11-18T03:00:09Z scheduled failed id=${ID} start=2026-11-18T03:00:05Z parts=- health=- tables=- removal=removed cleaned=no reason=version`,
      ),
    ).toBe(
      `Last restore drill: ${ID}, scheduled, 2026-11-18 03:00 UTC, took 4 s, failed: the snapshot names no version.`,
    );
  });

  it("says on a hosting account that the dump loaded with its tables, never that it is healthy", () => {
    const hosting = (fields: string) =>
      at(
        "hosting",
        `2026-11-18T03:00:40Z scheduled ${fields} start=2026-11-18T03:00:05Z cleaned=no`,
      );
    const loaded = hosting(
      "healthy id=snapshot-20261117T120000Z parts=database:2048:30,files:4:0 tables=database:42 removal=removed reason=-",
    );
    expect(loaded).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:00 UTC, took 35 s, the dump loaded with 42 tables, and the copy of the shared files is a valid archive.",
    );
    expect(loaded).not.toContain("healthy");
    expect(
      hosting("healthy id=snapshot-20261117T120000Z parts=files:4:0 tables=- removal=- reason=-"),
    ).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:00 UTC, took 35 s, the copy of the shared files is a valid archive.",
    );
    expect(
      hosting(
        "not-restored id=snapshot-20261117T120000Z parts=database:2048:30 tables=database:40 removal=failed reason=tables",
      ),
    ).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:00 UTC, took 35 s, the snapshot did not restore: the drill database held 40 tables once the dump loaded, not the dump's count; the drill database could not be emptied: the next drill empties it first.",
    );
    expect(
      hosting("not-restored id=snapshot-20261117T120000Z parts=- tables=- removal=- reason=dump"),
    ).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:00 UTC, took 35 s, the snapshot did not restore: its dump is empty or not a valid gzip file.",
    );
  });

  it("names a hosting account's skips and failures, whose lines carry no parts or tables", () => {
    const line = (result: string, reason: string, end = "2026-11-18T03:00:05Z") =>
      at(
        "hosting",
        `${end} scheduled ${result} id=${reason === "none" ? "-" : "snapshot-20261117T120000Z"} start=2026-11-18T03:00:05Z parts=- tables=- removal=${result === "failed" ? "removed" : "-"} cleaned=no reason=${reason}`,
      );
    expect(line("skipped", "login")).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:00 UTC, skipped: no drill database login yet.",
    );
    expect(line("skipped", "quota")).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:00 UTC, skipped: the account's quota leaves less room than the dump.",
    );
    expect(line("skipped", "none")).toBe(
      "Last restore drill: no snapshot, scheduled, 2026-11-18 03:00 UTC, skipped: no snapshot yet.",
    );
    expect(line("failed", "timeout", "2026-11-18T03:30:05Z")).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:30 UTC, took 30 min 0 s, failed: it ran past its 30-minute limit.",
    );
    expect(line("failed", "stopped", "2026-11-18T03:10:05Z")).toBe(
      "Last restore drill: snapshot-20261117T120000Z, scheduled, 2026-11-18 03:10 UTC, took 10 min 0 s, failed: it was stopped.",
    );
  });
});

describe.skipIf(!SH_AVAILABLE)("status's restore drill with a schedule on a server", () => {
  it("warns when no drill ran within twice the schedule and an hour", async () => {
    const world = await snapshotWorld(scheduled());
    await world.servers.app?.write(DRILLS_LOG, `${HEALTHY}\n`);
    const shown = `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, healthy, db 42 tables.`;
    world.deps.clock = { now: () => new Date("2026-12-02T15:00:00Z") };
    expect((await serverReport(world)).lines).toEqual([shown]);
    world.deps.clock = { now: () => new Date("2026-12-02T15:10:00Z") };
    expect((await serverReport(world)).lines).toEqual([
      shown,
      `Warning: no restore drill within two weeks, though they are scheduled weekly: the last one ended 2026-11-18 14:06 UTC. ${NO_DRILL.server}`,
    ]);
  });

  it("counts two days for a daily schedule, and a skip is shown as the skip it is", async () => {
    const world = await snapshotWorld(scheduled("daily"));
    await world.servers.app?.write(
      DRILLS_LOG,
      `${line("skipped", "parts=- health=- tables=- removal=- cleaned=no reason=memory")}\n`,
    );
    world.deps.clock = { now: () => new Date("2026-11-20T15:10:00Z") };
    const { lines } = await serverReport(world);
    expect(lines).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, skipped: too little free memory.`,
      `Warning: no restore drill within two days, though they are scheduled daily: the last one ended 2026-11-18 14:06 UTC. ${NO_DRILL.server}`,
    ]);
    expect(lines.join("\n")).not.toMatch(/failed/);
  });
});

/** A Portainer's scheduled dump drill of `db`, as its loop prints it to the container's log. */
const LOOP_HEALTHY = `${DRILL_RECORD_PREFIX}2026-11-19T03:00:52Z scheduled healthy id=${ID} version=aaaaaaaaaaaa start=2026-11-19T03:00:00Z parts=db:100:40 health=- tables=db:42 removal=removed cleaned=no reason=-`;

type PortainerTestWorld = Awaited<ReturnType<typeof portainerWorld>>;

/** The loop service `drill-<service>` of `world`'s stack, its log holding `lines`. */
function loop(world: PortainerTestWorld, service: string, lines: string[]): void {
  const stack = `opscrew-${world.plan.app.name}`;
  const id = `${stack}-drill-${service}`.padEnd(64, "0");
  const container: FakeContainer = {
    id,
    name: `${stack}-drill-${service}-1`,
    image: "postgres",
    cmd: [],
    env: [],
    labels: {
      "com.docker.compose.project": stack,
      "com.docker.compose.service": `drill-${service}`,
    },
    binds: [],
    mounts: [],
    state: "running",
    exitCode: 0,
    stdout: lines.map((each) => `${each}\n`).join(""),
    stderr: "",
  };
  world.docker.containers.set(id, container);
}

/** This computer's record of the environment's Portainer drills by hand, `lines` as records. */
async function manualDrills(world: PortainerTestWorld, lines: string[]): Promise<void> {
  const file = portainerDrillsFile(world.deps.paths);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ drills: lines.map(recordOf) }));
}

describe("status's restore drills in a Portainer", () => {
  const world = () => portainerWorld(scheduled("weekly", portainerPlan({ deployed: true })));
  const report = (w: PortainerTestWorld) =>
    drillStatusReport(w.deps, w.plan, undefined, w.services);

  it("shows the last drill by hand from this computer's record, and each dump's scheduled drill from its loop's log", async () => {
    const w = await world();
    await manualDrills(w, [HEALTHY]);
    loop(w, "db", [
      `${DRILL_RECORD_PREFIX}2026-11-12T03:00:01Z scheduled skipped id=- version=- start=2026-11-12T03:00:00Z parts=- health=- tables=- removal=- cleaned=no reason=none`,
      "a line of the scratch server's own",
      LOOP_HEALTHY,
    ]);
    w.deps.clock = { now: () => new Date("2026-11-20T12:00:00Z") };
    const { lines } = await report(w);
    expect(lines).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, healthy, db 42 tables.`,
      `Last scheduled dump drill of db: ${ID}, 2026-11-19 03:00 UTC, took 52 s, the dump restored with 42 tables (the app isn't started by it).`,
    ]);
    expect(everythingShown(w)).not.toContain(PORTAINER_TOKEN);
  });

  it("names a loop's skip and a dump that did not restore, and says none yet with drills on", async () => {
    const w = await world();
    w.deps.clock = { now: () => new Date("2026-11-20T12:00:00Z") };
    expect((await report(w)).lines).toEqual([
      "Restore drills: none yet; `opscrew restore --drill` runs one.",
    ]);
    loop(w, "db", [
      `${DRILL_RECORD_PREFIX}2026-11-19T03:00:01Z scheduled skipped id=${ID} version=- start=2026-11-19T03:00:00Z parts=- health=- tables=- removal=- cleaned=no reason=disk`,
    ]);
    expect((await report(w)).lines).toEqual([
      `Last scheduled dump drill of db: ${ID}, 2026-11-19 03:00 UTC, skipped: too little free disk.`,
    ]);
    loop(w, "db", [
      `${DRILL_RECORD_PREFIX}2026-11-19T03:00:41Z scheduled not-restored id=${ID} version=- start=2026-11-19T03:00:00Z parts=db:100:40 health=- tables=db:0 removal=removed cleaned=no reason=db`,
    ]);
    expect((await report(w)).lines).toEqual([
      `Last scheduled dump drill of db: ${ID}, 2026-11-19 03:00 UTC, took 41 s, the dump did not restore: it held no table once restored.`,
    ]);
  });

  it("warns when no drill ran within twice the schedule, by the newest of them", async () => {
    const w = await world();
    await manualDrills(w, [HEALTHY]);
    loop(w, "db", [LOOP_HEALTHY]);
    w.deps.clock = { now: () => new Date("2026-12-03T04:30:00Z") };
    expect((await report(w)).lines.at(-1)).toBe(
      `Warning: no restore drill within two weeks, though they are scheduled weekly: the last one ended 2026-11-19 03:00 UTC. ${NO_DRILL.portainer}`,
    );
  });
});

describe("status's restore drill on a hosting account", () => {
  const folder = folderOf();
  const NEWEST = "snapshot-20261117T120000Z";
  const loaded = (id: string, end: string) =>
    `${end} scheduled healthy id=${id} start=${end} parts=database:2048:30 tables=database:42 removal=removed cleaned=no reason=-`;

  async function account(o: { schedule?: boolean; log?: string[]; dumps?: string[] } = {}) {
    const deps = await createTestPhaseDeps();
    const plan = DeployPlanSchema.parse({
      ...hostingTestPlan(),
      snapshots: { drills: o.schedule === false ? {} : { schedule: "weekly" } },
    });
    const files = new MemoryFiles();
    if (o.log !== undefined) {
      files.files.set(`${folder}/state/drills.log`, `${o.log.join("\n")}\n`);
    }
    for (const id of o.dumps ?? []) files.files.set(`${folder}/dumps/${id}.sql.gz`, "dump");
    files.files.set(`${folder}/dumps/812-1.sql.gz`, "a release's dump");
    return { deps, plan, files };
  }

  it("shows the last drill from the agent's log on the account, in a hosting account's words", async () => {
    const { deps, plan, files } = await account({
      log: [
        loaded("snapshot-20261110T120000Z", "2026-11-12T03:00:30Z"),
        loaded(NEWEST, "2026-11-19T03:00:30Z"),
      ],
      dumps: [NEWEST],
    });
    deps.clock = { now: () => new Date("2026-11-20T12:00:00Z") };
    expect(await hostingDrillStatusLines(deps, plan, files)).toEqual([
      `Last restore drill: ${NEWEST}, scheduled, 2026-11-19 03:00 UTC, took 0 s, the dump loaded with 42 tables.`,
    ]);
  });

  it("warns only when a snapshot the agent should have drilled has waited past twice the schedule", async () => {
    const old = loaded(NEWEST, "2026-11-19T03:00:30Z");
    // The last drill proved the newest snapshot: an old drill is no fault then.
    const proved = await account({ log: [old], dumps: [NEWEST] });
    proved.deps.clock = { now: () => new Date("2026-12-20T12:00:00Z") };
    expect(await hostingDrillStatusLines(proved.deps, proved.plan, proved.files)).toHaveLength(1);
    // A newer snapshot, taken more than two weeks and an hour ago, and only skips since.
    const newer = "snapshot-20261120T120000Z";
    const waiting = await account({
      log: [
        old,
        `2026-11-26T03:00:01Z scheduled skipped id=${newer} start=2026-11-26T03:00:01Z parts=- tables=- removal=- cleaned=no reason=quota`,
      ],
      dumps: [NEWEST, newer],
    });
    waiting.deps.clock = { now: () => new Date("2026-12-04T13:10:00Z") };
    expect(await hostingDrillStatusLines(waiting.deps, waiting.plan, waiting.files)).toEqual([
      `Last restore drill: ${newer}, scheduled, 2026-11-26 03:00 UTC, skipped: the account's quota leaves less room than the dump.`,
      `Warning: no restore drill within two weeks, though they are scheduled weekly: the snapshot ${newer} has waited for one since 2026-11-20 12:00 UTC. ${NO_DRILL.hosting}`,
    ]);
    waiting.deps.clock = { now: () => new Date("2026-12-04T12:50:00Z") };
    expect(await hostingDrillStatusLines(waiting.deps, waiting.plan, waiting.files)).toHaveLength(
      1,
    );
  });

  it("says none yet with drills on, and nothing with them off", async () => {
    const on = await account({ schedule: false });
    expect(await hostingDrillStatusLines(on.deps, on.plan, on.files)).toEqual([
      "Restore drills: none yet; `opscrew restore --drill` runs one.",
    ]);
    const off = await account();
    const { snapshots: _drills, ...plan } = off.plan;
    expect(await hostingDrillStatusLines(off.deps, plan as DeployPlan, off.files)).toEqual([]);
  });
});
