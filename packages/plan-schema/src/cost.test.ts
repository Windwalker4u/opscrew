import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CostEstimateSchema, costItemText } from "./design";
import { parseArtifact } from "./io";
import { DeployPlanSchema } from "./plan";

const eur = (amount: number) => ({ amount, currency: "EUR" as const });

/** The cost of research R4: running, one-time and ended items. */
const cost = {
  monthly: eur(6.09),
  breakdown: [
    {
      item: "Server cx23 (nbg1)",
      provider: "hetzner",
      monthly: eur(5.49),
      billing: "hourly",
      hourly: eur(0.0088),
      since: "2026-11-08T07:13:45Z",
    },
    {
      item: "Primary IPv4",
      priceSource: "Hetzner's published rate as of 2026-10-12",
      monthly: eur(0.5),
      billing: "hourly",
      hourly: eur(0.0008),
      since: "2026-11-08T07:13:45Z",
    },
    { item: "Snapshot storage", monthly: eur(0.1), billing: "monthly" },
    { item: "Second app on the server", monthly: eur(0), billing: "free" },
  ],
  oneTime: [
    { item: "Setup fee (V153)", provider: "contabo", price: eur(2), at: "2026-11-20T13:17:00Z" },
  ],
  ended: [
    {
      item: "Server cpx22 (nbg1)",
      provider: "hetzner",
      monthly: eur(19.49),
      billing: "hourly",
      hourly: eur(0.0312),
      since: "2026-10-01T09:00:00Z",
      until: "2026-11-08T07:13:45Z",
    },
    {
      item: "Server Cloud VPS 4",
      provider: "contabo",
      monthly: eur(5.5),
      billing: "monthly",
      since: "2026-10-01T09:00:00Z",
      until: "2026-10-01T09:00:00Z",
    },
  ],
  pricesIncludeVat: false,
  source: "live",
  asOf: "2026-11-20T13:17:00Z",
};

/** The dotted paths of a failed parse's issues. */
function pathsOf(value: unknown): string[] {
  const result = CostEstimateSchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join("."));
}

describe("CostEstimate's billing, times, one-time fees and ended items", () => {
  it("accepts every field research R4 names", () => {
    expect(CostEstimateSchema.parse(cost)).toEqual(cost);
  });

  it("keeps a plan without them valid", async () => {
    const plan = parseArtifact(
      "plan",
      await readFile(new URL("./__fixtures__/plan.yaml", import.meta.url), "utf8"),
      "plan.yaml",
    );
    expect(plan.cost.oneTime).toBeUndefined();
    expect(plan.cost.ended).toBeUndefined();
    const { oneTime: _oneTime, ended: _ended, ...old } = cost;
    const breakdown = old.breakdown.map(({ item, monthly }) => ({ item, monthly }));
    expect(pathsOf({ ...old, breakdown })).toEqual([]);
  });

  it("wants every amount in the monthly total's currency", () => {
    const usd = (amount: number) => ({ amount, currency: "USD" as const });
    const [server, ...rest] = cost.breakdown;
    const [ended, ...restEnded] = cost.ended;
    expect(
      pathsOf({
        ...cost,
        breakdown: [{ ...server, hourly: usd(0.0088) }, ...rest],
        oneTime: [{ ...cost.oneTime[0], price: usd(2) }],
        ended: [{ ...ended, monthly: usd(19.49), hourly: usd(0.0312) }, ...restEnded],
      }),
    ).toEqual([
      "breakdown.0.hourly.currency",
      "oneTime.0.price.currency",
      "ended.0.monthly.currency",
      "ended.0.hourly.currency",
    ]);
  });

  it("still wants the breakdown to sum to the monthly total, without ended and one-time items", () => {
    expect(pathsOf({ ...cost, monthly: eur(8.09) })).toEqual(["monthly.amount"]);
  });

  it("wants an hourly price for an hourly item", () => {
    const [server, ...rest] = cost.breakdown;
    const [ended, ...restEnded] = cost.ended;
    const { hourly: _hourly, ...unpriced } = server ?? {};
    const { hourly: _endedHourly, ...unpricedEnded } = ended ?? {};
    expect(
      pathsOf({ ...cost, breakdown: [unpriced, ...rest], ended: [unpricedEnded, ...restEnded] }),
    ).toEqual(["breakdown.0.hourly", "ended.0.hourly"]);
  });

  it("wants each entry's provider as a provider id", () => {
    const [server, ...rest] = cost.breakdown;
    const [ended, ...restEnded] = cost.ended;
    expect(
      pathsOf({
        ...cost,
        breakdown: [{ ...server, provider: "Hetzner Cloud" }, ...rest],
        oneTime: [{ ...cost.oneTime[0], provider: "" }],
        ended: [{ ...ended, provider: "cloudflare" }, ...restEnded],
      }),
    ).toEqual(["breakdown.0.provider", "oneTime.0.provider"]);
  });

  it("wants an ended item to end no earlier than it started", () => {
    const [ended, ...rest] = cost.ended;
    expect(
      pathsOf({ ...cost, ended: [{ ...ended, until: "2026-09-30T23:59:59Z" }, ...rest] }),
    ).toEqual(["ended.0.until"]);
  });

  it("wants an ended item's billing and times, a one-time fee's time, and a known billing", () => {
    const [ended] = cost.ended;
    const { billing: _billing, since: _since, until: _until, ...bare } = ended ?? {};
    const { at: _at, ...undated } = cost.oneTime[0] ?? {};
    const [server, ...rest] = cost.breakdown;
    expect(
      pathsOf({
        ...cost,
        breakdown: [{ ...server, billing: "daily" }, ...rest],
        oneTime: [undated],
        ended: [bare],
      }),
    ).toEqual([
      "breakdown.0.billing",
      "oneTime.0.at",
      "ended.0.billing",
      "ended.0.since",
      "ended.0.until",
    ]);
  });
});

describe("costItemText", () => {
  it("prints an item with where its price came from, in the words design wrote before", () => {
    const ipv4 = {
      item: "Primary IPv4 address",
      priceSource: "Hetzner's published rate as of 2026-10-12",
    };
    expect(costItemText(ipv4)).toBe(
      "Primary IPv4 address (Hetzner's published rate as of 2026-10-12)",
    );
    const backups = {
      item: "Automated backups (20% of the server price)",
      priceSource: "OpsCrew's default rate, not from Hetzner's API",
    };
    expect(costItemText(backups)).toBe(
      "Automated backups (20% of the server price, OpsCrew's default rate, not from Hetzner's API)",
    );
    expect(costItemText({ item: "Server cx23 (nbg1)" })).toBe("Server cx23 (nbg1)");
  });
});

describe("the plan's cost.renewals (a domain OpsCrew bought)", () => {
  const fixture = () =>
    readFile(new URL("./__fixtures__/plan.yaml", import.meta.url), "utf8").then((text) =>
      parseArtifact("plan", text, "plan.yaml"),
    );
  /** The renewal of research R4, priced as the registrar quoted it. */
  const renewal = {
    item: "example.com",
    provider: "cloudflare",
    price: { amount: 10.44, currency: "USD" as const },
    next: "2027-11-20T12:00:00Z",
    autoRenew: true,
  };

  /** The dotted paths of a failed plan parse's issues. */
  async function planPaths(cost: unknown): Promise<string[]> {
    const result = DeployPlanSchema.safeParse({ ...(await fixture()), cost });
    if (result.success) return [];
    return result.error.issues.map((issue) => issue.path.join("."));
  }

  it("accepts R4's renewal, in the registrar's currency, and keeps a plan without renewals valid", async () => {
    const plan = await fixture();
    expect(plan.cost.renewals).toBeUndefined();
    const parsed = DeployPlanSchema.parse({ ...plan, cost: { ...plan.cost, renewals: [renewal] } });
    expect(parsed.cost.renewals).toEqual([renewal]);
  });

  it("wants a registrar's id, a price, the next date and auto-renew", async () => {
    const { cost: base } = await fixture();
    const { next: _next, autoRenew: _autoRenew, ...bare } = renewal;
    expect(
      await planPaths({ ...base, renewals: [{ ...bare, provider: "hetzner", extra: 1 }] }),
    ).toEqual([
      "cost.renewals.0.provider",
      "cost.renewals.0.next",
      "cost.renewals.0.autoRenew",
      "cost.renewals.0",
    ]);
  });

  it("still checks the estimate's own rules", async () => {
    const { cost: base } = await fixture();
    expect(
      await planPaths({ ...base, monthly: { amount: 1, currency: "EUR" }, renewals: [renewal] }),
    ).toEqual(["cost.monthly.amount"]);
  });
});
