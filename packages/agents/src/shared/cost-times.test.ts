import { type CostEstimate, CostEstimateSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { convertedNote } from "../design/cost";
import { createTestPhaseDeps, testPlan } from "../testing";
import {
  abortedCost,
  keepCostTimes,
  prunedCost,
  startBilling,
  stopBilling,
  withOneTime,
} from "./cost-times";
import { writePlanIfChanged } from "./plan-file";

const eur = (amount: number) => ({ amount, currency: "EUR" as const });
const CREATED = "2026-11-08T07:13:45.000Z";
const NOW = "2026-11-20T13:17:00.000Z";

const server = {
  item: "Server cx23 (nbg1)",
  provider: "hetzner",
  monthly: eur(5.49),
  billing: "hourly" as const,
  hourly: eur(0.0088),
};
const ipv4 = {
  item: "Primary IPv4 address",
  provider: "hetzner",
  monthly: eur(0.5),
  billing: "hourly" as const,
  hourly: eur(0.0008),
};
const backups = {
  item: "Automated backups (20% of the server price)",
  provider: "hetzner",
  monthly: eur(1.1),
  billing: "hourly" as const,
  hourly: eur(0.00176),
};

/** A valid cost of `lines` (their total as the monthly price). */
function costOf(lines: CostEstimate["breakdown"], extra: Partial<CostEstimate> = {}): CostEstimate {
  const total = Math.round(lines.reduce((sum, line) => sum + line.monthly.amount, 0) * 100) / 100;
  return CostEstimateSchema.parse({
    monthly: eur(total),
    breakdown: lines,
    pricesIncludeVat: false,
    source: "live",
    asOf: CREATED,
    ...extra,
  });
}

describe("the cost's times (031 US4)", () => {
  it("starts billing each billed item without since, never a free one", () => {
    const free = {
      item: '"shop"\'s server (priced with "shop")',
      monthly: eur(0),
      billing: "free" as const,
    };
    const started = startBilling(
      costOf([server, { ...ipv4, since: "2026-10-01T00:00:00.000Z" }, free]),
      CREATED,
    );
    expect(started.breakdown).toEqual([
      { ...server, since: CREATED },
      { ...ipv4, since: "2026-10-01T00:00:00.000Z" },
      free,
    ]);
    expect(CostEstimateSchema.parse(started)).toEqual(started);
  });

  it("keeps design's items' since, and ends a running item no longer planned (backups off)", () => {
    const previous = costOf([
      { ...server, since: CREATED },
      { ...ipv4, since: CREATED },
      { ...backups, since: CREATED },
    ]);
    const next = keepCostTimes(costOf([server, ipv4]), previous, NOW);
    expect(next.breakdown).toEqual([
      { ...server, since: CREATED },
      { ...ipv4, since: CREATED },
    ]);
    expect(next.ended).toEqual([{ ...backups, since: CREATED, until: NOW }]);
    expect(CostEstimateSchema.parse(next)).toEqual(next);
  });

  it("adds backups turned on without since, which the next apply starts", () => {
    const previous = costOf([
      { ...server, since: CREATED },
      { ...ipv4, since: CREATED },
    ]);
    const next = keepCostTimes(costOf([server, ipv4, backups]), previous, NOW);
    expect(next.breakdown[2]).toEqual(backups);
    expect(next.ended).toBeUndefined();
    expect(startBilling(next, NOW).breakdown[2]).toEqual({ ...backups, since: NOW });
  });

  it("keeps an item whose price source alone changed, and ends nothing", () => {
    const note = "Hetzner's published rate as of 2026-10-12";
    const previous = costOf([
      { ...server, since: CREATED },
      { ...ipv4, item: `Primary IPv4 address (${note})`, since: CREATED },
      {
        ...backups,
        item: "Automated backups (20% of the server price, OpsCrew's default rate, not from Hetzner's API)",
        since: CREATED,
      },
    ]);
    const next = keepCostTimes(costOf([server, ipv4, backups]), previous, NOW);
    expect(next.breakdown).toEqual([
      { ...server, since: CREATED },
      { ...ipv4, since: CREATED },
      { ...backups, since: CREATED },
    ]);
    expect(next.ended).toBeUndefined();
  });

  it("keeps an extra server whose converted price alone changed, by design's own wording", () => {
    const usd = (amount: number) => ({ amount, currency: "USD" as const });
    const extra = { ...server, item: "Server worker (cx23 in nbg1)" };
    const previous = costOf([
      { ...extra, item: `${extra.item}${convertedNote(usd(6.04))}`, since: CREATED },
    ]);
    const next = keepCostTimes(
      costOf([{ ...extra, item: `${extra.item}${convertedNote(usd(6.1))}` }]),
      previous,
      NOW,
    );
    expect(next.breakdown[0]?.since).toBe(CREATED);
    expect(next.ended).toBeUndefined();
  });

  it("keeps a running item's billing when design priced it without one, so it can still end", () => {
    const { billing: _billing, hourly: _hourly, ...unpriced } = server;
    const kept = keepCostTimes(costOf([unpriced]), costOf([{ ...server, since: CREATED }]), NOW);
    expect(kept.breakdown).toEqual([{ ...server, since: CREATED }]);
    const ended = stopBilling(kept, NOW).ended;
    expect(ended).toEqual([
      expect.objectContaining({ item: server.item, since: CREATED, until: NOW }),
    ]);
  });

  it("keeps the one-time fees and ended items across designs", () => {
    const fee = { item: "Setup fee (V153)", provider: "contabo", price: eur(2), at: CREATED };
    const previous = withOneTime(costOf([{ ...server, since: CREATED }]), fee);
    const next = keepCostTimes(costOf([server]), previous, NOW);
    expect(next.oneTime).toEqual([fee]);
    expect(next.breakdown).toEqual([{ ...server, since: CREATED }]);
  });

  it("ends every running item at a teardown and keeps the breakdown as the estimate", () => {
    const stopped = stopBilling(costOf([{ ...server, since: CREATED }, ipv4]), NOW);
    expect(stopped.breakdown).toEqual([server, ipv4]);
    expect(stopped.ended).toEqual([{ ...server, since: CREATED, until: NOW }]);
  });

  it("gives an aborted move's old side its start back and ends the new side", () => {
    const fresh = {
      ...server,
      item: "Server cx33 (fsn1)",
      monthly: eur(8.49),
      hourly: eur(0.0136),
    };
    const moving = costOf([{ ...fresh, since: CREATED }]);
    const restored = abortedCost(
      costOf([server]),
      [{ ...server, since: "2026-10-01T09:00:00.000Z" }],
      moving,
      NOW,
    );
    expect(restored.breakdown).toEqual([{ ...server, since: "2026-10-01T09:00:00.000Z" }]);
    expect(restored.ended).toEqual([{ ...fresh, since: CREATED, until: NOW }]);
  });

  it("keeps only the ended items and one-time fees of this and the previous calendar month", () => {
    const ended = (until: string) => ({ ...server, since: "2026-09-01T00:00:00.000Z", until });
    const fee = (at: string) => ({
      item: "Setup fee (V153)",
      provider: "contabo",
      price: eur(2),
      at,
    });
    const cost = costOf([server], {
      oneTime: [fee("2026-09-30T23:59:59.000Z"), fee("2026-10-01T00:00:00.000Z")],
      ended: [ended("2026-09-30T23:59:59.000Z"), ended("2026-10-01T00:00:00.000Z"), ended(NOW)],
    });
    const pruned = prunedCost(cost, new Date(NOW));
    expect(pruned.oneTime).toEqual([fee("2026-10-01T00:00:00.000Z")]);
    expect(pruned.ended).toEqual([ended("2026-10-01T00:00:00.000Z"), ended(NOW)]);
    // In January, the previous month is December of the year before.
    const january = prunedCost(cost, new Date("2027-01-02T00:00:00.000Z"));
    expect(january.oneTime).toBeUndefined();
    expect(january.ended).toBeUndefined();
  });
});

describe("the plan's writer", () => {
  it("prunes the old ended items and one-time fees at every write", async () => {
    const deps = await createTestPhaseDeps({ clock: { now: () => new Date(NOW) } });
    const plan = testPlan();
    const old = { ...server, since: "2026-08-01T00:00:00.000Z", until: "2026-09-02T00:00:00.000Z" };
    const kept = { ...old, until: "2026-10-15T00:00:00.000Z" };
    await writePlanIfChanged(deps, { ...plan, cost: { ...plan.cost, ended: [old, kept] } });
    expect((await readArtifact("plan", deps.paths.files.plan)).cost.ended).toEqual([kept]);
  });
});
