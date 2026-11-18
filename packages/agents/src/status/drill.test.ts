// Feature 029, restore drills (T2933; plan.md 19., research R18, R29): `opscrew status` shows the
// last drill of a server or this computer.
import { DRILLS_LOG } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { appFolder } from "../localhost/services";
import { FakeSnapshotServer, SH_AVAILABLE } from "../snapshot/__fixtures__/server";
import { everythingShown, snapshotWorld, stagingPlan } from "../snapshot/__fixtures__/world";
import { SERVER_IPV4 } from "../testing";
import { drillStatusReport } from "./drill";

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

describe.skipIf(!SH_AVAILABLE)("status's restore drill", () => {
  it("shows the last drill on the app's server: its snapshot, time, length and result", async () => {
    const world = await snapshotWorld(plan());
    await world.servers.app?.write(
      DRILLS_LOG,
      `${line("skipped", "parts=- health=- tables=- removal=- cleaned=no reason=locked")}\n${HEALTHY}\n`,
    );
    const { lines, drill } = await drillStatusReport(world.deps, world.plan, world.services);
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
      return (await drillStatusReport(world.deps, world.plan, world.services)).lines;
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
    expect((await drillStatusReport(off.deps, off.plan, off.services)).lines).toEqual([]);
    const on = await snapshotWorld(plan({ snapshots: { drills: {} } }));
    expect((await drillStatusReport(on.deps, on.plan, on.services)).lines).toEqual([
      "Restore drills: none yet; `opscrew restore --drill` runs one.",
    ]);
    const empty = await snapshotWorld(stagingPlan([]));
    expect((await drillStatusReport(empty.deps, empty.plan, empty.services)).lines).toEqual([]);
  });

  it("notes a server it could not read", async () => {
    const world = await snapshotWorld(plan());
    (world.servers.app as FakeSnapshotServer).answer = () => ({
      exitCode: 255,
      stdout: "",
      stderr: "refused",
    });
    expect((await drillStatusReport(world.deps, world.plan, world.services)).lines).toEqual([
      "Restore drills: The app's server did not answer over SSH, so OpsCrew could not read the restore drills. Check that it is on and reachable (`opscrew status`), then try again.",
    ]);
  });

  it("shows the last drill on this computer", async () => {
    const local = localPlan();
    const computer = new FakeComputer();
    const built = DeployPlanSchema.parse({
      ...local,
      deploy: { ...local.deploy, snapshots: true },
    });
    const { deps } = await localProject(built, computer);
    const server = await FakeSnapshotServer.create(appFolder(deps.paths, built));
    await server.write(DRILLS_LOG, `${HEALTHY}\n`);
    computer.script = (text) => server.sh(text);
    const { lines } = await drillStatusReport(deps, built, { localhost: computer.services() });
    expect(lines).toEqual([
      `Last restore drill: ${ID}, 2026-11-18 14:06 UTC, took 4 min 10 s, healthy, db 42 tables.`,
    ]);
  });
});
