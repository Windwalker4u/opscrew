import type { RemoteExec } from "@opscrew/contracts";
import { APP_KAMAL_PROXY_SERVICE, EDGE_PROJECT } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { containerDifferences } from "../drift/host";
import { testPlan } from "../testing";
import {
  componentStatus,
  componentStatusLines,
  readAppContainers,
  serviceContainers,
} from "./components";

describe("feature 049 (Option B): status and drift for per-app kamal-proxy isolation", () => {
  const plan = testPlan();

  it("treats a running per-app kamal-proxy + app strictly on internal as clean (no unexpected services, no drift)", () => {
    const containers = [
      { name: "shop-app-1", running: true, networks: ["shop_internal"] },
      { name: "shop-db-1", running: true, networks: ["shop_internal"] },
      {
        name: `shop-${APP_KAMAL_PROXY_SERVICE}-1`,
        running: true,
        networks: ["shop_internal", EDGE_PROJECT],
      },
    ];
    const status = componentStatus(plan, serviceContainers("shop", containers));
    expect(status.others).toEqual([]);
    expect(status.onEdgeNetwork).toBeUndefined();
    expect(status.missingAppProxy).toBeUndefined();

    const lines = componentStatusLines(plan, status);
    expect(lines.join("\n")).not.toContain("Isolation:");
    expect(lines.join("\n")).not.toContain("Proxy (kamal-proxy):");
    expect(lines.join("\n")).not.toContain("no component in opscrew/plan.yaml");

    expect(containerDifferences(plan, containers, true)).toEqual([]);
  });

  it("reports legacy app containers still attached to opscrew-edge and missing per-app kamal-proxy in both status and drift", () => {
    const containers = [
      { name: "shop-app-1", running: true, networks: ["shop_internal", EDGE_PROJECT] },
      { name: "shop-db-1", running: true, networks: ["shop_internal"] },
    ];
    const status = componentStatus(plan, serviceContainers("shop", containers));
    expect(status.onEdgeNetwork).toEqual(["app"]);
    expect(status.missingAppProxy).toBe(true);

    const lines = componentStatusLines(plan, status).join("\n");
    expect(lines).toContain(`Isolation: app is still on the shared edge network (${EDGE_PROJECT})`);
    expect(lines).toContain(`Proxy (${APP_KAMAL_PROXY_SERVICE}): not running`);

    const drift = containerDifferences(plan, containers, true);
    expect(drift.some((d) => d.detail.includes(`shared edge network (${EDGE_PROJECT})`))).toBe(
      true,
    );
    expect(
      drift.some((d) =>
        d.detail.includes(`The app's proxy (${APP_KAMAL_PROXY_SERVICE}) is not running`),
      ),
    ).toBe(true);
  });

  it("reports a stopped per-app kamal-proxy in status and once in drift (without duplicating the stopped entry)", () => {
    const containers = [
      { name: "shop-app-1", running: true, networks: ["shop_internal"] },
      { name: "shop-db-1", running: true, networks: ["shop_internal"] },
      {
        name: `shop-${APP_KAMAL_PROXY_SERVICE}-1`,
        running: false,
        networks: ["shop_internal", EDGE_PROJECT],
      },
    ];
    const status = componentStatus(plan, serviceContainers("shop", containers));
    expect(status.onEdgeNetwork).toBeUndefined();
    expect(status.missingAppProxy).toBe(true);
    expect(componentStatusLines(plan, status).join("\n")).toContain(
      `Proxy (${APP_KAMAL_PROXY_SERVICE}): not running`,
    );

    const drift = containerDifferences(plan, containers, true);
    expect(drift.filter((d) => d.detail.includes(APP_KAMAL_PROXY_SERVICE))).toHaveLength(1);
    expect(drift[0]?.detail).toContain(`shop-${APP_KAMAL_PROXY_SERVICE}-1 is stopped`);
  });

  it("reads container networks from docker ps in readAppContainers", async () => {
    const seen: string[] = [];
    const remote: RemoteExec = {
      host: "203.0.113.10",
      run: async (command) => {
        seen.push(command);
        return {
          exitCode: 0,
          stdout: [
            "shop-app-1|running|shop_internal",
            "shop-kamal-proxy-1|running|shop_internal,opscrew-edge",
          ].join("\n"),
          stderr: "",
        };
      },
    };
    const containers = await readAppContainers(remote, "shop");
    expect(seen[0]).toContain("{{.Names}}|{{.State}}|{{.Networks}}");
    expect(containers).toEqual([
      { name: "shop-app-1", running: true, networks: ["shop_internal"] },
      {
        name: "shop-kamal-proxy-1",
        running: true,
        networks: ["shop_internal", "opscrew-edge"],
      },
    ]);
  });
});
