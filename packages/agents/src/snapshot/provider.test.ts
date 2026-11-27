import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import { kamateraAccount } from "./__fixtures__/kamatera";
import { providerSnapshots } from "./provider";

describe("providerSnapshots at a provider whose names alone mark the app's servers", () => {
  it("lists the plan's servers' snapshots, never those of an app or environment named shop-…", async () => {
    const base = testPlan({ provider: "kamatera" });
    const plan = { ...base, servers: [{ name: "data", target: base.target }] } as DeployPlan;
    // Staging's app is `shop-staging`, with a duplicate Kamatera left of it: neither is prod's.
    const deps = kamateraAccount(await createTestPhaseDeps(), [
      "shop",
      "shop-data",
      "shop-staging",
      "shop-staging(1)",
      "shop-staging-data",
    ]);
    const found = await providerSnapshots({
      deps,
      plan,
      environment: "prod",
      flags: "",
      services: {},
    });
    expect(found.map(({ entry }) => [entry.id, entry.server])).toEqual([
      ["shop:1", { provider: "kamatera", id: "shop", name: "shop" }],
      ["shop-data:2", { provider: "kamatera", id: "shop-data", name: "shop-data" }],
    ]);
  });
});
