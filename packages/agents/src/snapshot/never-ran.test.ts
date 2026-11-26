import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { recordOwnServer } from "../shared";
import { OWN_IPV4, ownPlan, portainerPlan, testPlan } from "../testing";
import { portainerWorld } from "./__fixtures__/portainer";
import { SH_AVAILABLE } from "./__fixtures__/server";
import { snapshotWorld, stagingPlan } from "./__fixtures__/world";
import { neverRan } from "./never-ran";

describe.skipIf(!SH_AVAILABLE)("which switching databases never ran (047)", () => {
  it("on a server: one with no container, volume or data folder never ran", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    // The fake server's Docker has no container and no volume of db.
    expect(await neverRan(world.deps, ["db"], world.services)).toEqual(["db"]);
    const [command] = world.servers.app?.commands ?? [];
    expect(command).toContain("docker volume ls -q");
    expect(command).toContain("[ -e /srv/data/");
    // Read wherever the app's folder is or not: no `cd` into it first.
    expect(command).not.toMatch(/^cd /);
  });

  it("on a cloud server whose infrastructure was never applied: never ran, with no server reached", async () => {
    // Generated values from a `--plan-only` run, and no apply recorded: no server exists yet.
    const world = await snapshotWorld(
      stagingPlan([{ kind: "postgres", name: "db" }], { base: testPlan({ deployed: false }) }),
    );
    const reached: string[] = [];
    const services = {
      ...world.services,
      remote: (host: string) => {
        reached.push(host);
        throw new Error("no server to reach");
      },
    };
    expect(await neverRan(world.deps, ["db"], services)).toEqual(["db"]);
    expect(reached).toEqual([]);
  });

  it("on a cloud server whose infrastructure was applied, or the user's own server: reached, and a failure stops", async () => {
    for (const base of [testPlan({ deployed: true }), { ...ownPlan(), services: [] }]) {
      const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }], { base }));
      await recordOwnServer(world.deps.paths, {
        host: OWN_IPV4,
        port: 22,
        user: "alice",
        agent: true,
        reachable: true,
      });
      const server = world.servers.app;
      if (server === undefined) throw new Error("no app server");
      server.answer = (command) =>
        command.includes("docker volume ls")
          ? { exitCode: 255, stdout: "", stderr: "" }
          : undefined;
      await expect(neverRan(world.deps, ["db"], world.services)).rejects.toMatchObject({
        code: "COMMAND_FAILED",
      });
      expect(server.commands.some((command) => command.includes("docker volume ls"))).toBe(true);
    }
  });

  it("on a server: one whose container, volume or data folder is there ran", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    const server = world.servers.app;
    if (server === undefined) throw new Error("no app server");
    server.answer = (command) =>
      command.includes("docker volume ls")
        ? { exitCode: 0, stdout: "data db\n", stderr: "" }
        : undefined;
    expect(await neverRan(world.deps, ["db"], world.services)).toEqual([]);
  });

  it("on a server: a failed read stops, as no answer is no proof of no data", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    const server = world.servers.app;
    if (server === undefined) throw new Error("no app server");
    server.answer = (command) =>
      command.includes("docker volume ls") ? { exitCode: 1, stdout: "", stderr: "" } : undefined;
    await expect(neverRan(world.deps, ["db"], world.services)).rejects.toMatchObject({
      code: "COMMAND_FAILED",
      message: "OpsCrew could not read which of db ran on the app's server (exit code 1).",
    });
  });

  it("on this computer: by the Compose project's containers and the volumes' names", async () => {
    const computer = new FakeComputer();
    const { deps } = await localProject(localPlan(), computer);
    const services = { localhost: computer.services() };
    expect(await neverRan(deps, ["db"], services)).toEqual(["db"]);
    computer.deployed();
    expect(await neverRan(deps, ["db"], services)).toEqual([]);
    // Its container removed, its volume keeps the data.
    computer.containers = computer.containers.filter((container) => container.service !== "db");
    expect(await neverRan(deps, ["db"], services)).toEqual([]);
    computer.info = "missing";
    await expect(neverRan(deps, ["db"], services)).rejects.toThrow("docker: not found");
  });

  it("in the user's Portainer: by the stack's containers and the volumes' names", async () => {
    const plan = stagingPlan([{ kind: "postgres", name: "db" }], {
      base: portainerPlan({ deployed: true }),
    });
    const world = await portainerWorld(plan);
    expect(await neverRan(world.deps, ["db"], world.services)).toEqual([]);
    for (const [id, container] of world.docker.containers) {
      if (container.labels["com.docker.compose.service"] === "db") {
        world.docker.containers.delete(id);
      }
    }
    expect(await neverRan(world.deps, ["db"], world.services)).toEqual([]);
    for (const name of [...world.docker.volumes.keys()]) {
      if (name.endsWith("_db_data")) world.docker.volumes.delete(name);
    }
    expect(await neverRan(world.deps, ["db"], world.services)).toEqual(["db"]);
  });

  it("asks nothing with no database to look for", async () => {
    const world = await snapshotWorld(stagingPlan([{ kind: "postgres", name: "db" }]));
    expect(await neverRan(world.deps, [], world.services)).toEqual([]);
    expect(world.servers.app?.commands).toEqual([]);
  });
});
