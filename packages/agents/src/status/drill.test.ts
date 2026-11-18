// Feature 029, restore drills (T2933; plan.md 19., research R18, R29): `opscrew status` shows the
// last drill of a server or this computer.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DRILLS_LOG } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { type FakeSnapshotServer, SH_AVAILABLE } from "../snapshot/__fixtures__/server";
import {
  everythingShown,
  type SnapshotWorld,
  snapshotWorld,
  stagingPlan,
} from "../snapshot/__fixtures__/world";
import { SERVER_IPV4 } from "../testing";
import { drillStatusReport } from "./drill";
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
