import { readFileSync } from "node:fs";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  accessToken,
  apiError,
  CREDENTIALS,
  CREDENTIALS_ENV,
  fakeTime,
  ovhFetch,
  PROJECT,
} from "./__fixtures__/fixtures";
import { OVHCLOUD_CATALOG_URL, OvhcloudCatalog, StaticOvhcloudCatalog } from "./catalog";
import { OVHCLOUD_API_URL, OvhcloudClient, readOvhcloudCredentials } from "./client";
import {
  HOURS_A_MONTH,
  OVHCLOUD_LOCATIONS,
  STATIC_FLAVORS,
  STATIC_PRICES_AS_OF,
} from "./static-prices";

const NOW = new Date("2026-11-21T12:00:00.000Z");
const PUBLIC = "/v1/order/catalog/public/cloud?ovhSubsidiary=IE";
const AVAILABILITY = "/v2/publicCloud/project/";

/** A fixture of `src/__fixtures__`, parsed. */
function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"));
}

interface CatalogueFixture {
  locale: { currencyCode: string };
  addons: {
    planCode: string;
    pricings: { price: number }[];
    blobs: { technical?: { cpu: { cores: number } } };
  }[];
}

/** The trimmed public catalogue (its real shape, read 2026-11-21), with `change` applied. */
function publicCatalogue(change: (catalogue: CatalogueFixture) => void = () => {}): unknown {
  const catalogue = fixture("catalog-public.json") as CatalogueFixture;
  change(catalogue);
  return catalogue;
}

function addon(catalogue: CatalogueFixture, planCode: string) {
  const found = catalogue.addons.find((a) => a.planCode === planCode);
  if (found === undefined) throw new Error(`no ${planCode} in the fixture`);
  return found;
}

/** Sets the row's one price, in 1e-8 EUR. */
function setPrice(row: CatalogueFixture["addons"][number], price: number): void {
  const [pricing] = row.pricings;
  if (pricing === undefined) throw new Error(`no price for ${row.planCode} in the fixture`);
  pricing.price = price;
}

function setup(routes: Record<string, FakeReply | FakeReply[]> = {}) {
  const fake = ovhFetch({
    [PUBLIC]: { body: publicCatalogue() },
    [AVAILABILITY]: { body: fixture("catalog-availability.json") },
    ...routes,
  });
  const redactor = new Redactor();
  readOvhcloudCredentials(CREDENTIALS_ENV, redactor);
  const time = fakeTime();
  const client = new OvhcloudClient({
    credentials: CREDENTIALS,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
  });
  const catalog = new OvhcloudCatalog(client, { fetch: fake.fetch, now: () => NOW });
  return { catalog, calls: fake.calls };
}

const publicCalls = (calls: FakeCall[]) =>
  calls.filter((c) => c.url.startsWith(OVHCLOUD_CATALOG_URL));
const availabilityCalls = (calls: FakeCall[]) =>
  calls.filter((c) => c.path.startsWith(AVAILABILITY));

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("the price table", () => {
  it("holds the four plans with the 2026-11-21 prices, without d2-2, which design could never pick", () => {
    expect(STATIC_PRICES_AS_OF).toBe("2026-11-21T00:00:00.000Z");
    expect(
      STATIC_FLAVORS.map((f) => [f.name, f.vcpus, f.memoryGb, f.diskGb, f.cpuType, f.hourly]),
    ).toEqual([
      ["d2-4", 2, 4, 50, "shared", 0.0206],
      ["d2-8", 4, 8, 50, "shared", 0.0372],
      ["b3-8", 2, 8, 50, "dedicated", 0.0512],
      ["b3-16", 4, 16, 100, "dedicated", 0.1023],
    ]);
  });

  it("maps the seven locations of research R2.7", () => {
    expect(OVHCLOUD_LOCATIONS).toEqual(["DE1", "SBG5", "GRA11", "WAW1", "BHS5", "SGP1", "SYD1"]);
  });
});

describe("StaticOvhcloudCatalog", () => {
  it("offers every plan in every mapped location, hourly, with 730 hours as the month", async () => {
    const catalog = new StaticOvhcloudCatalog();
    expect(catalog.provider).toBe("ovhcloud");
    expect(catalog.asOf).toBe(STATIC_PRICES_AS_OF);
    const offers = await catalog.listOffers();
    expect(offers).toHaveLength(28);
    expect([...new Set(offers.map((o) => o.location))]).toEqual([...OVHCLOUD_LOCATIONS]);
    for (const offer of offers) {
      const plan = STATIC_FLAVORS.find((f) => f.name === offer.id);
      expect(plan).toBeDefined();
      expect(offer).toEqual({
        provider: "ovhcloud",
        id: plan?.name,
        vcpus: plan?.vcpus,
        memoryGb: plan?.memoryGb,
        diskGb: plan?.diskGb,
        cpuType: plan?.cpuType,
        architecture: "x86",
        location: offer.location,
        billing: "hourly",
        hourly: { amount: plan?.hourly, currency: "EUR" },
        monthly: { amount: (plan?.hourly ?? 0) * HOURS_A_MONTH, currency: "EUR" },
        pricesIncludeVat: false,
        deprecated: false,
        available: true,
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      });
      expect(offer.setupFee).toBeUndefined();
    }
  });

  it("filters by location, and offers nothing in a location it doesn't map", async () => {
    const catalog = new StaticOvhcloudCatalog();
    const offers = await catalog.listOffers("GRA11");
    expect(offers.map((o) => o.id)).toEqual(["d2-4", "d2-8", "b3-8", "b3-16"]);
    expect(offers.find((o) => o.id === "d2-4")?.monthly.amount).toBeCloseTo(15.038, 10);
    expect(await catalog.listOffers("UK1")).toEqual([]);
  });

  it("prices a snapshot per GB a month and an hour, with no IPv4 line", async () => {
    const extras = await new StaticOvhcloudCatalog().extras("SBG5");
    expect(extras).toEqual({
      snapshotPerGbMonth: { amount: 0.011, currency: "EUR" },
      snapshotPerGbHour: { amount: 0.000015, currency: "EUR" },
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
  });

  it("refuses a location it doesn't map", async () => {
    const error = await failure(new StaticOvhcloudCatalog().extras("UK1"));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("OpsCrew doesn't use the OVHcloud region UK1.");
    expect(error.hint).toBe("Use one of DE1, SBG5, GRA11, WAW1, BHS5, SGP1 or SYD1.");
  });
});

describe("OvhcloudCatalog (live)", () => {
  it("prices the four plans from the public catalogue (1e-8 EUR, `<flavor>.consumption`)", async () => {
    const { catalog } = setup();
    expect(catalog.provider).toBe("ovhcloud");
    const offers = await catalog.listOffers("DE1");
    expect(offers.map((o) => [o.id, o.vcpus, o.memoryGb, o.diskGb, o.hourly?.amount])).toEqual([
      ["d2-4", 2, 4, 50, 0.0206],
      ["d2-8", 4, 8, 50, 0.0372],
      ["b3-8", 2, 8, 50, 0.0512],
      // Not `b3-16.consumption.LZ.AF`'s 0.186.
      ["b3-16", 4, 16, 100, 0.1023],
    ]);
    for (const offer of offers) {
      expect(offer).toMatchObject({
        provider: "ovhcloud",
        location: "DE1",
        architecture: "x86",
        billing: "hourly",
        pricesIncludeVat: false,
        deprecated: false,
        source: "live",
        asOf: NOW.toISOString(),
      });
      expect(offer.monthly).toEqual({
        amount: (offer.hourly?.amount ?? 0) * HOURS_A_MONTH,
        currency: "EUR",
      });
      expect(offer.cpuType).toBe(offer.id.startsWith("b3") ? "dedicated" : "shared");
      expect(offer.setupFee).toBeUndefined();
    }
  });

  it("takes the price, the vCPUs, the memory and the disk from the catalogue, not the table", async () => {
    const { catalog } = setup({
      [PUBLIC]: {
        body: publicCatalogue((c) => {
          const d2 = addon(c, "d2-4.consumption");
          setPrice(d2, 1234567);
          const technical = d2.blobs.technical as unknown as Record<string, unknown>;
          technical.cpu = { cores: 3 };
          technical.memory = { size: 6 };
          technical.storage = { disks: [{ capacity: 40 }] };
        }),
      },
    });
    const d2 = (await catalog.listOffers("GRA11")).find((o) => o.id === "d2-4");
    expect(d2).toMatchObject({
      vcpus: 3,
      memoryGb: 6,
      diskGb: 40,
      hourly: { amount: 0.01234567, currency: "EUR" },
    });
  });

  it("offers each plan in every mapped location and nowhere else", async () => {
    const { catalog } = setup();
    const offers = await catalog.listOffers();
    expect(offers).toHaveLength(28);
    expect([...new Set(offers.map((o) => o.location))]).toEqual([...OVHCLOUD_LOCATIONS]);
    // c3-4 and UK1 are in the availability answer, but OpsCrew offers neither.
    expect(offers.some((o) => o.id === "c3-4" || o.location === "UK1")).toBe(false);
    expect(await catalog.listOffers("UK1")).toEqual([]);
  });

  it("marks an offer unavailable where the region isn't activated, the stock is out or the quota is short", async () => {
    const { catalog } = setup();
    const offers = await catalog.listOffers();
    const unavailable = offers.filter((o) => !o.available).map((o) => `${o.id}@${o.location}`);
    expect(unavailable).toEqual([
      // Out of stock.
      "b3-8@SBG5",
      // The quota can't hold it.
      "d2-8@GRA11",
      // WAW1 isn't activated on the project.
      "d2-4@WAW1",
      "d2-8@WAW1",
      "b3-8@WAW1",
      "b3-16@WAW1",
      // Not sold to the project there.
      "b3-16@SYD1",
    ]);
    // A low stock is still stock.
    expect(offers.find((o) => o.id === "d2-4" && o.location === "SGP1")?.available).toBe(true);
  });

  it("leaves out a plan the catalogue no longer sells", async () => {
    const { catalog } = setup({
      [PUBLIC]: {
        body: publicCatalogue((c) => {
          c.addons = c.addons.filter((a) => a.planCode !== "d2-8.consumption");
        }),
      },
    });
    expect((await catalog.listOffers("GRA11")).map((o) => o.id)).toEqual(["d2-4", "b3-8", "b3-16"]);
  });

  it("reads the public catalogue without a token, and the availability with one", async () => {
    const { catalog, calls } = setup();
    await catalog.listOffers();
    const [pub] = publicCalls(calls);
    expect(pub?.url).toBe(`${OVHCLOUD_CATALOG_URL}?ovhSubsidiary=IE`);
    expect(pub?.url.startsWith(OVHCLOUD_API_URL)).toBe(true);
    expect(pub?.method).toBe("GET");
    expect(Object.keys(pub?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "authorization",
    );
    const [availability] = availabilityCalls(calls);
    expect(availability?.path).toBe(
      `/v2/publicCloud/project/${encodeURIComponent(PROJECT)}/reference/productAvailability?type=INSTANCE`,
    );
    expect(availability?.headers.Authorization).toBe(`Bearer ${accessToken("1")}`);
  });

  it("reads the catalogue once per catalogue object", async () => {
    const { catalog, calls } = setup();
    await catalog.listOffers();
    await catalog.listOffers("GRA11");
    await catalog.extras("GRA11");
    await catalog.extras("SYD1");
    expect(publicCalls(calls)).toHaveLength(1);
    expect(availabilityCalls(calls)).toHaveLength(1);
  });

  it("prices a snapshot from the catalogue, with no IPv4 line", async () => {
    const { catalog, calls } = setup({
      [PUBLIC]: {
        body: publicCatalogue((c) => {
          setPrice(addon(c, "snapshot.monthly.postpaid"), 1200000);
          setPrice(addon(c, "snapshot.consumption"), 1600);
        }),
      },
    });
    expect(await catalog.extras("BHS5")).toEqual({
      snapshotPerGbMonth: { amount: 0.012, currency: "EUR" },
      snapshotPerGbHour: { amount: 0.000016, currency: "EUR" },
      pricesIncludeVat: false,
      source: "live",
      asOf: NOW.toISOString(),
    });
    // The extras need no availability.
    expect(availabilityCalls(calls)).toHaveLength(0);
  });

  it("reads the fixture's snapshot rate as the table's", async () => {
    const extras = await setup().catalog.extras("BHS5");
    expect(extras.snapshotPerGbMonth?.amount).toBe(0.011);
    expect(extras.snapshotPerGbHour?.amount).toBe(0.000015);
  });

  it("refuses a location it doesn't map", async () => {
    const error = await failure(setup().catalog.extras("UK1"));
    expect(error.code).toBe("INVALID_INPUT");
  });
});

describe("OvhcloudCatalog when the live read fails", () => {
  // Design catches a live catalogue's error that isn't INVALID_INPUT, uses the static table and
  // warns with the table's date (`design/run.ts`), as for every provider.
  const cases: [string, Record<string, FakeReply>, RegExp][] = [
    [
      "the public catalogue is unreachable",
      { [PUBLIC]: { error: new Error("socket hang up") } },
      /^Could not reach OVHcloud's public price catalogue/,
    ],
    [
      "the public catalogue fails",
      { [PUBLIC]: { status: 503, text: "maintenance" } },
      /^OVHcloud's public price catalogue answered HTTP 503/,
    ],
    [
      "the public catalogue isn't in EUR",
      {
        [PUBLIC]: {
          body: publicCatalogue((c) => {
            c.locale.currencyCode = "GBP";
          }),
        },
      },
      /^OVHcloud returned an unexpected answer when trying to read its public price catalogue/,
    ],
    [
      "a plan's price is missing",
      {
        [PUBLIC]: {
          body: publicCatalogue((c) => {
            addon(c, "b3-8.consumption").pricings = [];
          }),
        },
      },
      /^OVHcloud returned an unexpected answer when trying to read the price of b3-8\.consumption/,
    ],
    [
      "the service account may not read the availability",
      {
        [AVAILABILITY]: apiError(403, {
          class: "Client::Forbidden",
          message: "This call has not been granted",
          details: {
            unauthorizedActionsByIAM: "publicCloudProject:apiovh:reference/productAvailability/get",
          },
        }),
      },
      /^OVHcloud's IAM doesn't allow the service account/,
    ],
  ];

  for (const [name, routes, message] of cases) {
    it(`rejects with a plain error the design phase falls back on when ${name}`, async () => {
      const { catalog } = setup(routes);
      const error = await failure(catalog.listOffers());
      expect(error.message).toMatch(message);
      expect(error.code).not.toBe("INVALID_INPUT");
      expect(error.hint).toBeTruthy();
    });
  }

  it("fails the extras too when the public catalogue can't be read", async () => {
    const { catalog } = setup({ [PUBLIC]: { status: 500, text: "oops" } });
    const error = await failure(catalog.extras("GRA11"));
    expect(error.code).toBe("PROVIDER_ERROR");
  });

  it("reads again after a failed read", async () => {
    const { catalog, calls } = setup({
      [PUBLIC]: [{ status: 502, text: "bad gateway" }, { body: publicCatalogue() }],
    });
    await failure(catalog.listOffers());
    expect(await catalog.listOffers("GRA11")).toHaveLength(4);
    expect(publicCalls(calls)).toHaveLength(2);
  });
});

describe("OvhcloudCatalog leaks", () => {
  it("puts no value in any error, and sends none to the public catalogue", async () => {
    const secrets = [...Object.values(CREDENTIALS), accessToken("1")];
    const echo = apiError(500, {
      class: "Server::Echo",
      message: `bad ${CREDENTIALS.clientId} ${CREDENTIALS.clientSecret} ${accessToken("1")} in ${PROJECT}`,
    });
    const failing: Record<string, FakeReply>[] = [
      { [AVAILABILITY]: echo },
      { [AVAILABILITY]: { body: [{ type: "INSTANCE", models: [{ name: PROJECT }], x: 1 }, 2] } },
      { [PUBLIC]: { status: 500, text: `oops ${PROJECT}` } },
      { [PUBLIC]: { body: { unexpected: PROJECT } } },
    ];
    const texts: string[] = [];
    const requests: FakeCall[] = [];
    for (const routes of failing) {
      const { catalog, calls } = setup(routes);
      const error = await failure(catalog.listOffers());
      texts.push(`${error.message} ${error.hint ?? ""} ${String(error.cause ?? "")}`);
      requests.push(...calls);
    }
    for (const text of texts) for (const value of secrets) expect(text).not.toContain(value);
    const pub = JSON.stringify(publicCalls(requests));
    for (const value of secrets) expect(pub).not.toContain(value);
  });
});
