/**
 * Provision's memory check on a server other OpsCrew apps share (feature 030, FR-3024, plan 18.):
 * a second app's limits, raised by hand in opscrew/plan.yaml, must still fit beside the first
 * app's limits, the edge and the system's reserve, checked before anything is planned. Found live
 * on 2026-11-19: a forum raised to 1536 MB (its cron follows the app) beside 512 MB of MySQL, on
 * a 3789 MB server whose first app holds 1664 MB.
 */
import { readdir } from "node:fs/promises";
import type { HostFacts } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { appMemoryMb } from "../shared/memory";
import { SERVER_IPV4 } from "../testing";
import {
  everythingSeen,
  inventoryPlan,
  type SecondAppProject,
  secondAppProject,
} from "./__fixtures__/second-app";
import { runProvision } from "./run";

/** The server's memory as inspection reports it: 3789 MB, as design rounds it. */
const SERVER_BYTES = 3789 * 1024 ** 2;

/**
 * The second app beside a first app with 1664 MB of limits on a 3789 MB server: the app at
 * `appMb`, a cron job that runs the app's image (its limit follows the app's) and 512 MB of MySQL.
 */
async function forum(appMb: number): Promise<SecondAppProject> {
  const s = await secondAppProject();
  const first = await readArtifact("plan", s.shared.first.files.plan);
  const others = appMemoryMb(first) - first.app.memoryMb;
  const shop = DeployPlanSchema.parse({ ...first, app: { ...first.app, memoryMb: 1664 - others } });
  expect(appMemoryMb(shop)).toBe(1664);
  await writeArtifact("plan", s.shared.first.files.plan, shop);
  const base = inventoryPlan();
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, memoryMb: appMb, env: [] },
    processes: {
      workers: [],
      cron: [{ name: "jobs", schedule: "* * * * *", command: "node jobs.js", enabled: true }],
    },
    services: [
      {
        name: "mysql",
        kind: "mysql",
        version: "8.4",
        memoryMb: 512,
        enabled: true,
        options: {},
        reason: "The app uses MySQL.",
        licence: "GPL-2.0",
      },
    ],
  });
  expect(appMemoryMb(plan)).toBe(appMb * 2 + 512);
  await writeArtifact("plan", s.deps.paths.files.plan, plan);
  const facts: HostFacts = structuredClone(s.host.facts);
  facts.memoryBytes = SERVER_BYTES;
  s.host.facts = facts;
  return s;
}

/** The warnings the run gave. */
const warnings = (s: SecondAppProject) =>
  s.deps.reporter.lines.filter((line) => line.level === "warn").map((line) => line.message);

/** Neither the first app's deploy key nor the server's address leaks, in a refusal too. */
async function expectNoLeak(s: SecondAppProject, error?: OpsCrewError): Promise<void> {
  const seen = await everythingSeen(s);
  expect(seen).not.toContain(s.shared.firstKey);
  const printed = [
    s.deps.reporter.text(),
    JSON.stringify(s.deps.audit.entries),
    error?.message ?? "",
    error?.hint ?? "",
  ].join("\n");
  expect(printed).not.toContain(SERVER_IPV4);
}

describe("provision's memory check on a server other apps share", () => {
  it("refuses a second app's hand-raised limits before anything is planned, in design's words", async () => {
    const s = await forum(1536);
    const error = await runProvision(s.deps, { services: s.services }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OpsCrewError);
    const refusal = error as OpsCrewError;
    expect(refusal.code).toBe("PHASE_PRECONDITION");
    expect(refusal.message).toBe(
      `Your server has 3789 MB of memory. After 384 MB for the system and 128 MB for OpsCrew's edge, the other OpsCrew app on it takes 1664 MB of memory limits ("shop" 1664 MB), which leaves 1613 MB, and this app's containers have 3584 MB of memory limits. Nothing was changed.`,
    );
    expect(refusal.hint).toBe(
      "Lower the memory limits in opscrew/plan.yaml (app.memoryMb, and those of the workers and services), add memory to the server, or remove an app from it, then run `opscrew design` and `opscrew provision` again.",
    );
    // Before any plan: no Cloudflare, infrastructure or host plan asked, made or saved.
    expect(s.handler.requests).toEqual([]);
    expect(s.engine.calls).toEqual([]);
    expect(s.host.applies).toEqual([]);
    expect(await readdir(s.deps.paths.files.plansDir).catch(() => [])).toEqual([]);
    await expectNoLeak(s, refusal);
  });

  it("lets a plan that fits through with no warning (the PHP app's limits as design made them)", async () => {
    const s = await forum(256);
    await runProvision(s.deps, { services: s.services, planOnly: true });

    expect(warnings(s).filter((line) => line.includes("of its memory free"))).toEqual([]);
    expect(s.engine.calls).toContain("plan");
    await expectNoLeak(s);
  });

  it("warns, and goes on, when less than 15% of the server's memory stays free", async () => {
    const s = await forum(512);
    await runProvision(s.deps, { services: s.services, planOnly: true });

    expect(warnings(s)).toContain(
      `Your server keeps only 2% of its memory free after the memory limits of this app (1536 MB) and of the other OpsCrew app on it (1664 MB: "shop" 1664 MB), OpsCrew's edge and the system, so a container that grows can make the server run out of memory. Lower a memory limit in opscrew/plan.yaml, or add memory to the server.`,
    );
    expect(s.engine.calls).toContain("plan");
    await expectNoLeak(s);
  });

  it("counts the other second apps' records beside the first app, never this app's own", async () => {
    const s = await forum(256);
    // Provisioned once: this app's own record on the server holds its limits.
    await runProvision(s.deps, { services: s.services });
    await s.git(s.root, "checkout", "-q", "main");
    await s.git(s.root, "merge", "-q", "opscrew/deploy-setup");
    const own = s.host.facts.apps.find((app) => app.name === "inventory");
    expect(own?.record?.memoryMb).toBe(1024);
    // Another second app takes 600 MB more: 1024 MB no longer fit beside 2264 MB.
    const facts = structuredClone(s.host.facts);
    const record = structuredClone(own?.record);
    if (record === undefined || record === null) throw new Error("no record");
    facts.apps.push({ name: "blog", record: { ...record, app: "blog", memoryMb: 600 } });
    s.host.facts = facts;
    s.handler.requests.length = 0;

    await expect(runProvision(s.deps, { services: s.services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        `the other OpsCrew apps on it take 2264 MB of memory limits ("shop" 1664 MB and "blog" 600 MB), which leaves 1013 MB, and this app's containers have 1024 MB of memory limits. Nothing was changed.`,
      ),
    });
    expect(s.handler.requests).toEqual([]);
    await expectNoLeak(s);
  });
});
