// How design writes each cost item's billing (031 US4, FR-3112, research R4): the provider, the
// billing model and the hourly price, from the chosen offer and its provider's definition.
import type { ComputeCatalog, ComputeOffer } from "@opscrew/contracts";
import { type CloudProvider, CostEstimateSchema } from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { costFor, endedSnapshot, setupFeeOf } from "./cost";
import { noServerCost, sharedServerCostItem } from "./own";
import { type DesignedServer, totalCost } from "./servers";

/** The provider's published price list, as design reads it without a token. */
const catalog = (provider: CloudProvider): ComputeCatalog =>
  cloudProvider(provider).connector({ env: {} }).catalog();

/** `provider`'s offer `id` in `location`, with that location's extras. */
async function offerOf(provider: CloudProvider, id: string, location: string) {
  const offers = await catalog(provider).listOffers(location);
  const offer = offers.find((o) => o.id === id) as ComputeOffer;
  return { offer, extras: await catalog(provider).extras(location) };
}

describe("design's billing of each cost item", () => {
  it("bills Hetzner's server, IPv4 and backups hourly, up to each one's monthly cap", async () => {
    const { offer, extras } = await offerOf("hetzner", "cx23", "nbg1");
    const cost = costFor(offer, extras, { backups: true });
    const hourly = offer.hourly?.amount as number;
    expect(cost.breakdown).toEqual([
      {
        item: "Server cx23 (nbg1)",
        provider: "hetzner",
        monthly: offer.monthly,
        billing: "hourly",
        hourly: offer.hourly,
      },
      {
        item: "Primary IPv4 address",
        provider: "hetzner",
        monthly: extras.ipv4Monthly,
        billing: "hourly",
        hourly: extras.ipv4Hourly,
      },
      {
        item: "Automated backups (20% of the server price)",
        provider: "hetzner",
        monthly: { amount: Math.round(offer.monthly.amount * 20) / 100, currency: "EUR" },
        billing: "hourly",
        hourly: { amount: Math.round(hourly * 0.2 * 1e6) / 1e6, currency: "EUR" },
      },
    ]);
    expect(CostEstimateSchema.parse(cost)).toEqual(cost);
  });

  it("bills DigitalOcean's Droplet and backups hourly, in dollars", async () => {
    const { offer, extras } = await offerOf("digitalocean", "s-1vcpu-2gb", "fra1");
    const cost = costFor(offer, extras, { backups: true });
    expect(cost.breakdown.map(({ provider, billing }) => ({ provider, billing }))).toEqual([
      { provider: "digitalocean", billing: "hourly" },
      { provider: "digitalocean", billing: "hourly" },
    ]);
    expect(cost.breakdown[0]?.hourly).toEqual(offer.hourly);
    expect(cost.breakdown[1]?.hourly?.currency).toBe("USD");
  });

  it("bills Contabo's server monthly, with no hourly price", async () => {
    const { offer, extras } = await offerOf("contabo", "V153", "EU");
    const cost = costFor(offer, extras, { backups: true });
    expect(cost.breakdown).toEqual([
      { item: "Server V153 (EU)", provider: "contabo", monthly: offer.monthly, billing: "monthly" },
    ]);
  });

  it("leaves an hourly offer's line without billing when its hourly price is unknown", async () => {
    const { offer, extras } = await offerOf("hetzner", "cx23", "nbg1");
    const { hourly: _hourly, ...unpriced } = offer;
    const { ipv4Hourly: _ipv4, ...rest } = extras;
    const [server, ipv4] = costFor(unpriced, rest, { backups: false }).breakdown;
    expect(server).toEqual({
      item: "Server cx23 (nbg1)",
      provider: "hetzner",
      monthly: offer.monthly,
    });
    expect(ipv4?.billing).toBeUndefined();
  });

  it("marks a second app's item, on the first app's server, free", () => {
    const cost = noServerCost(sharedServerCostItem("shop"), "EUR", "2026-11-20T13:17:00.000Z");
    expect(cost.breakdown).toEqual([
      {
        item: '"shop"\'s server (priced with "shop")',
        monthly: { amount: 0, currency: "EUR" },
        billing: "free",
      },
    ]);
  });

  it("bills an extra server's line as its server is, its hourly prices added up", async () => {
    const { offer, extras } = await offerOf("hetzner", "cx23", "nbg1");
    const app = costFor(offer, extras, { backups: false });
    const db = costFor(offer, extras, { backups: true });
    const server = {
      server: {
        name: "db",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cx23",
          backups: true,
        },
      },
      cost: db,
    } as unknown as DesignedServer;
    const line = totalCost(app, [server]).breakdown.at(-1);
    const sum = db.breakdown.reduce((total, l) => total + (l.hourly?.amount ?? 0), 0);
    expect(line).toMatchObject({
      item: "Server db (cx23 in nbg1), with its IPv4 address and backups",
      provider: "hetzner",
      monthly: db.monthly,
      billing: "hourly",
      hourly: { amount: Math.round(sum * 1e6) / 1e6, currency: "EUR" },
    });
  });
});

describe("the one-time and ended items design prices", () => {
  it("finds Contabo's setup fee in its price list, and none at Hetzner", async () => {
    const deps = await createTestPhaseDeps();
    const at = "2026-11-20T13:17:00.000Z";
    const target = { provider: "contabo", serverType: "V153", location: "EU" };
    expect(await setupFeeOf(deps, target, at, "EUR")).toEqual({
      item: "Setup fee (V153)",
      provider: "contabo",
      price: { amount: 2, currency: "EUR" },
      at,
    });
    const hetzner = { provider: "hetzner", serverType: "cx23", location: "nbg1" };
    expect(await setupFeeOf(deps, hetzner, at, "EUR")).toBeUndefined();
  });

  it("prices a deleted snapshot by its size at the provider's published rates", () => {
    const { snapshots } = cloudProvider("hetzner").offering;
    if (snapshots.kind !== "per-gb") throw new Error("Hetzner bills snapshots per GB");
    const times = { since: "2026-11-05T08:00:00.000Z", until: "2026-11-20T13:17:00.000Z" };
    const ended = endedSnapshot(
      { id: "770011", provider: "hetzner", sizeBytes: 2 * 1024 ** 3 },
      times,
      "EUR",
    );
    expect(ended).toEqual({
      item: "Snapshot 770011 (2 GB)",
      provider: "hetzner",
      monthly: { amount: Math.round(2 * snapshots.perGbMonth * 100) / 100, currency: "EUR" },
      billing: "hourly",
      hourly: { amount: Math.round(2 * snapshots.perGbHour * 1e6) / 1e6, currency: "EUR" },
      ...times,
    });
    // Contabo includes snapshots in the server's price.
    expect(
      endedSnapshot({ id: "s1", provider: "contabo", sizeBytes: 1024 ** 3 }, times, "EUR"),
    ).toBeUndefined();
  });
});
