import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readUptimeScript, renderGeneratedUptime } from "../../scripts/gen-modules";
import { UPTIME_WORKER, UPTIME_WORKER_SCRIPT, UPTIME_WORKER_SHA256 } from "../index";

describe("the generated copy of the uptime Worker", () => {
  it("matches uptime/worker.mjs (run gen:modules after editing it), with its SHA-256", () => {
    expect(UPTIME_WORKER_SCRIPT).toBe(readUptimeScript());
    expect(UPTIME_WORKER_SHA256).toBe(
      createHash("sha256").update(UPTIME_WORKER_SCRIPT).digest("hex"),
    );
    expect(renderGeneratedUptime(UPTIME_WORKER_SCRIPT)).toContain(
      `export const UPTIME_WORKER_SHA256 = "${UPTIME_WORKER_SHA256}";`,
    );
  });
});

describe("UPTIME_WORKER", () => {
  it("holds the Worker's names, schedule and limits", () => {
    expect(UPTIME_WORKER).toEqual({
      name: "opscrew-uptime",
      namespace: "opscrew-uptime",
      binding: "UPTIME",
      cron: "*/5 * * * *",
      compatibilityDate: "2026-10-01",
      maxHostnames: 40,
      subrequests: 50,
    });
  });

  it("the script uses the same limits and binding", () => {
    const script = readUptimeScript();
    expect(script).toContain(`const SUBREQUESTS = ${UPTIME_WORKER.subrequests};`);
    expect(script).toContain(`const MAX_HOSTNAMES = ${UPTIME_WORKER.maxHostnames};`);
    expect(script).toContain(`env.${UPTIME_WORKER.binding}`);
  });
});
