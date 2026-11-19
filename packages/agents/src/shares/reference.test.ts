import { join } from "node:path";
import { resolveProjectPaths } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared/server-record";
import { createTestPhaseDeps, SERVER_IPV4, sharedServerProject } from "../testing";
import { firstAppPaths, readShares } from "./reference";

describe("readShares", () => {
  it("reads the first app's reference from this app's own server record", async () => {
    const { deps, ref } = await sharedServerProject();
    expect(await readShares(deps.paths)).toEqual(ref);
  });

  it("is undefined for an app on a server of its own", async () => {
    const deps = await createTestPhaseDeps();
    expect(await readShares(deps.paths)).toBeUndefined();
    await recordOwnServer(deps.paths, {
      host: SERVER_IPV4,
      user: "root",
      agent: true,
      reachable: true,
    });
    expect(await readShares(deps.paths)).toBeUndefined();
  });
});

describe("firstAppPaths", () => {
  it("lays out the first app's repository as every phase does, with this computer's OpsCrew home", async () => {
    const deps = await createTestPhaseDeps();
    const root = join(deps.paths.root, "elsewhere", "shop");
    const paths = firstAppPaths(deps.paths, { root, environment: "prod" });
    expect(paths).toEqual(resolveProjectPaths(root, { env: { OPSCREW_HOME: deps.paths.homeDir } }));
    expect(paths.files.deployKey.startsWith(deps.paths.homeDir)).toBe(true);
  });

  it("takes the first app's app key and environment", async () => {
    const deps = await createTestPhaseDeps();
    const root = join(deps.paths.root, "elsewhere", "shop");
    const paths = firstAppPaths(deps.paths, { root, app: "admin", environment: "staging" });
    expect(paths.app).toBe("admin");
    expect(paths.environment).toBe("staging");
    expect(paths.files.plan).toBe(
      join(root, "opscrew", "apps", "admin", "environments", "staging", "plan.yaml"),
    );
  });
});
