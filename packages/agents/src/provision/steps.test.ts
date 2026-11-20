import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import { deploymentRecord, pausedMergeNote, reportPausedMerge } from "./steps";

const PINNED = {
  reason: "rollback",
  since: "2026-10-11T11:00:00.000Z",
  image: `sha256:${"ab".repeat(32)}`,
  commit: "c".repeat(40),
} as const;

describe("pausedMergeNote", () => {
  it("says nothing unless a rollback pins the environment", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    expect(await pausedMergeNote(deps, plan, undefined)).toBeUndefined();
    expect(
      await pausedMergeNote(deps, plan, { reason: "move", since: PINNED.since }),
    ).toBeUndefined();
  });

  it("names --resume --deploy for an environment that follows its branch", async () => {
    const deps = await createTestPhaseDeps();
    expect(await pausedMergeNote(deps, testPlan(), PINNED)).toBe(
      "The deploys of shop/prod are paused since 2026-10-11T11:00:00.000Z: `opscrew rollback` pinned it to ccccccc (sha256:abababababab). The merged files deploy only after `opscrew rollback --resume --deploy`.",
    );
  });

  it("says the merged files deploy only once a credential rotation's window ends", async () => {
    const deps = await createTestPhaseDeps();
    const rotation = { reason: "rotation", since: PINNED.since, hash: "a".repeat(64) } as const;
    expect(await pausedMergeNote(deps, testPlan(), rotation)).toBe(
      "The deploys of shop/prod are paused since 2026-10-11T11:00:00.000Z for a credential rotation's window, begun on another computer: `opscrew rotate` with its services, or with `--undo`, ends it there. The merged files deploy only once it ends.",
    );
  });

  it("names opscrew promote after resuming, for a promoted environment", async () => {
    const deps = await createTestPhaseDeps();
    const plan = DeployPlanSchema.parse({
      ...testPlan(),
      environment: { deploySource: { from: "promote", source: "staging" } },
    });
    expect(await pausedMergeNote(deps, plan, PINNED)).toBe(
      "The deploys of shop/prod are paused since 2026-10-11T11:00:00.000Z: `opscrew rollback` pinned it to ccccccc (sha256:abababababab). The merged files deploy only after `opscrew rollback --resume`, then `opscrew promote --to prod`.",
    );
  });
});

describe("reportPausedMerge", () => {
  const repo = (read: () => Promise<string | undefined>) => ({
    api: { getRepoVariable: read },
    owner: "acme",
    repo: "shop",
  });

  it("reports the note for the pause GitHub holds", async () => {
    const deps = await createTestPhaseDeps();
    await reportPausedMerge(
      deps,
      testPlan(),
      repo(async () => JSON.stringify({ "shop/prod": PINNED })),
    );
    expect(deps.reporter.lines).toEqual([
      { level: "info", message: await pausedMergeNote(deps, testPlan(), PINNED) },
    ]);
  });

  it("reports nothing when no rollback pins it, or the token cannot read the variable", async () => {
    const deps = await createTestPhaseDeps();
    await reportPausedMerge(
      deps,
      testPlan(),
      repo(async () => undefined),
    );
    await reportPausedMerge(
      deps,
      testPlan(),
      repo(async () => {
        throw new OpsCrewError("CREDENTIALS_INVALID", "no Variables: read");
      }),
    );
    expect(deps.reporter.lines).toEqual([]);
  });
});

describe("deploymentRecord's cost times (031 US4)", () => {
  const eur = (amount: number) => ({ amount, currency: "EUR" as const });
  const server = {
    item: "Server cx23 (nbg1)",
    provider: "hetzner",
    monthly: eur(5.49),
    billing: "hourly" as const,
    hourly: eur(0.0088),
  };
  const backups = {
    item: "Automated backups (20% of the server price)",
    provider: "hetzner",
    monthly: eur(1.1),
    billing: "hourly" as const,
    hourly: eur(0.00176),
  };
  const iac = { planHash: "a".repeat(64), applied: false };

  it("keeps a running item's since on a later run and starts a new one's (backups turned on)", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan({ deployed: true });
    const since = "2026-10-01T09:00:00.000Z";
    const plan = {
      ...base,
      cost: { ...base.cost, monthly: eur(6.59), breakdown: [{ ...server, since }, backups] },
    };
    const recorded = deploymentRecord(deps, { plan, url: undefined, iac, approvals: [] })(false);
    expect(recorded.cost.breakdown).toEqual([
      { ...server, since },
      { ...backups, since: deps.clock.now().toISOString() },
    ]);
    expect(recorded.cost.oneTime).toBeUndefined();
  });

  it("starts nothing before the deployment's first apply", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan();
    const plan = { ...base, cost: { ...base.cost, monthly: eur(5.49), breakdown: [server] } };
    const recorded = deploymentRecord(deps, { plan, url: undefined, iac, approvals: [] })(false);
    expect(recorded.cost.breakdown).toEqual([server]);
  });
});
