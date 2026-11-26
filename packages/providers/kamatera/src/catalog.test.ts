import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { type FakeReply, fakeFetch } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIALS } from "./__fixtures__/fixtures";
import { KAMATERA_CALCULATOR_URL, KamateraCatalog } from "./catalog";
import {
  HOURS_A_MONTH,
  KAMATERA_LOCATIONS,
  STATIC_PLANS,
  STATIC_PRICES_AS_OF,
} from "./static-prices";

const NOW = new Date("2026-11-26T12:00:00.000Z");
const CALCULATOR = "/info/calculator.js.php";
const BASE = new URL(KAMATERA_CALCULATOR_URL).origin;
const SECRETS = Object.values(CREDENTIALS);

/** The calculator file, trimmed to the lines the catalogue parses (read 2026-11-26). */
const FILE = await readFile(
  join(import.meta.dirname, "__fixtures__", "catalog-calculator.js.php"),
  "utf8",
);

/** Design's smallest disk for a new cloud server (`MIN_DISK_GB` in agents' sizing). */
const DESIGN_MIN_DISK_GB = 40;

function setup(reply: FakeReply | FakeReply[]) {
  const { fetch, calls } = fakeFetch({ [CALCULATOR]: reply }, { base: BASE });
  return { catalog: new KamateraCatalog({ fetch, now: () => NOW }), calls };
}

const offline: FakeReply = { error: new Error("offline") };

/** The table's offers in one datacenter, as `[id, monthly]`. */
const TABLE: [string, number][] = [
  ["A-1-2", 9],
  ["A-2-4", 19],
  ["A-4-8", 42],
  ["B-1-2", 18],
  ["B-2-4", 42],
  ["B-4-8", 90],
];

describe("KamateraCatalog without the calculator file", () => {
  it("offers the table's six plans in every mapped datacenter, billed by the hour", async () => {
    const { catalog } = setup(offline);
    const offers = await catalog.listOffers();

    expect(offers).toHaveLength(STATIC_PLANS.length * KAMATERA_LOCATIONS.length);
    for (const location of KAMATERA_LOCATIONS) {
      const here = offers.filter((o) => o.location === location);
      expect(here.map((o) => [o.id, o.monthly.amount])).toEqual(TABLE);
    }
    for (const offer of offers) {
      expect(offer).toMatchObject({
        provider: "kamatera",
        architecture: "x86",
        billing: "hourly",
        pricesIncludeVat: false,
        deprecated: false,
        available: true,
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      });
      expect(offer.monthly.currency).toBe("USD");
      expect(offer.hourly).toEqual({
        amount: offer.monthly.amount / HOURS_A_MONTH,
        currency: "USD",
      });
      expect(offer.setupFee).toBeUndefined();
      expect(offer.diskGb).toBeGreaterThanOrEqual(DESIGN_MIN_DISK_GB);
    }
  });

  it("gives each plan its sizes, type A shared and type B dedicated", async () => {
    const { catalog } = setup(offline);
    const offers = await catalog.listOffers("EU-FR");
    expect(offers.map((o) => [o.id, o.vcpus, o.memoryGb, o.diskGb, o.cpuType])).toEqual([
      ["A-1-2", 1, 2, 40, "shared"],
      ["A-2-4", 2, 4, 40, "shared"],
      ["A-4-8", 4, 8, 80, "shared"],
      ["B-1-2", 1, 2, 40, "dedicated"],
      ["B-2-4", 2, 4, 40, "dedicated"],
      ["B-4-8", 4, 8, 80, "dedicated"],
    ]);
  });

  it("lists one datacenter's offers, and none for a datacenter OpsCrew doesn't map", async () => {
    const { catalog } = setup(offline);
    const singapore = await catalog.listOffers("AS-SG");
    expect(singapore).toHaveLength(STATIC_PLANS.length);
    expect(new Set(singapore.map((o) => o.location))).toEqual(new Set(["AS-SG"]));
    expect(await catalog.listOffers("IL-TA")).toEqual([]);
  });

  it("keeps the table on any failed read, tries no second read and claims no availability", async () => {
    const replies: FakeReply[] = [
      offline,
      { status: 500, text: "<html>oops</html>" },
      { status: 404, text: "Not found" },
      { text: "var prices = 1;" },
      { text: "var prd_prices = '{not json';" },
      { text: "var prd_prices = '{\"cpu\":[]}';" },
      // A plan's line missing: the file no longer sells that configuration as the table has it.
      { text: FILE.replace(',{"value":"4B","description":"4 Cores","price":35}', "") },
    ];
    for (const reply of replies) {
      const { catalog, calls } = setup(reply);
      const offers = await catalog.listOffers();
      await catalog.listOffers("EU-FR");
      await catalog.extras("EU-FR");
      expect(calls).toHaveLength(1);
      expect(new Set(offers.map((o) => o.source))).toEqual(new Set(["static"]));
      expect(offers.every((o) => o.available)).toBe(true);
      expect(offers.map((o) => o.monthly.amount)).toEqual(
        KAMATERA_LOCATIONS.flatMap(() => TABLE.map(([, monthly]) => monthly)),
      );
    }
  });
});

describe("KamateraCatalog with the calculator file", () => {
  it("reads the public file once, without credentials, and says the prices are live", async () => {
    const { catalog, calls } = setup({ text: FILE });
    const offers = await catalog.listOffers();
    await catalog.listOffers("US-SC");
    await catalog.extras("EU-FR");
    await catalog.extras("AS-SG");

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "GET", url: KAMATERA_CALCULATOR_URL });
    expect(Object.keys(calls[0]?.headers ?? {}).map((h) => h.toLowerCase())).not.toContain(
      "authclientid",
    );
    for (const offer of offers) {
      expect(offer).toMatchObject({ source: "live", asOf: NOW.toISOString(), billing: "hourly" });
      expect(offer.hourly?.amount).toBe(offer.monthly.amount / HOURS_A_MONTH);
      expect(offer.setupFee).toBeUndefined();
    }
    // The file read 2026-11-26 has the table's prices.
    expect(offers.filter((o) => o.location === "EU").map((o) => [o.id, o.monthly.amount])).toEqual(
      TABLE,
    );
  });

  it("prices each plan from the file's lines", async () => {
    const changed = FILE.replace(
      '{"value":"4B","description":"4 Cores","price":35}',
      '{"value":"4B","description":"4 Cores","price":40}',
    ).replace(
      '{"value":"40","description":"40GB","price":9}',
      '{"value":"40","description":"40GB","price":10}',
    );
    const { catalog } = setup({ text: changed });
    const offers = await catalog.listOffers("US-NY2");
    expect(offers.map((o) => [o.id, o.monthly.amount])).toEqual([
      ["A-1-2", 10],
      ["A-2-4", 20],
      ["A-4-8", 42],
      ["B-1-2", 19],
      ["B-2-4", 43],
      ["B-4-8", 95],
    ]);
    expect(offers.every((o) => o.available && o.source === "live")).toBe(true);
  });

  it("counts the first IPv4 address's line in each server's price", async () => {
    const changed = FILE.replace(
      '{"value":"1","description":"1","price":0}',
      '{"value":"1","description":"1","price":2}',
    );
    const { catalog } = setup({ text: changed });
    const [first] = await catalog.listOffers("EU-FR");
    expect(first).toMatchObject({ id: "A-1-2", monthly: { amount: 11, currency: "USD" } });
  });
});

describe("KamateraCatalog extras", () => {
  it("gives the table's rates, and the traffic of each datacenter", async () => {
    const { catalog } = setup(offline);
    expect(await catalog.extras("EU-FR")).toEqual({
      snapshotPerGbMonth: { amount: 0.05, currency: "USD" },
      snapshotPerGbHour: { amount: 0.05 / HOURS_A_MONTH, currency: "USD" },
      extraIpv4Monthly: { amount: 1, currency: "USD" },
      trafficIncludedGb: 5000,
      trafficPerGbOver: { amount: 0.01, currency: "USD" },
      stoppedIpv4Monthly: { amount: 5, currency: "USD" },
      stoppedDiskPerGbMonth: { amount: 0.05, currency: "USD" },
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    });
    for (const location of ["AS-SG", "AU-SY", "AS"]) {
      expect((await catalog.extras(location)).trafficIncludedGb).toBe(1000);
    }
  });

  it("names no primary IPv4 price and no backup rate", async () => {
    const { catalog } = setup(offline);
    const extras = await catalog.extras("US-SC");
    expect(extras.ipv4Monthly).toBeUndefined();
    expect(extras.ipv4Hourly).toBeUndefined();
    expect(extras.backupPercent).toBeUndefined();
  });

  it("reads the rates from the file when it is reachable", async () => {
    const changed = FILE.replace(
      '"snapshot":[{"description":"Snapshot Price","options":[{"value":"1","description":"Snapshot price per GB","price":0.05}]}]',
      '"snapshot":[{"description":"Snapshot Price","options":[{"value":"1","description":"Snapshot price per GB","price":0.07}]}]',
    ).replace(
      '"netPck.AS-SG":[{"description":"Network Package AS-SG","options":[{"value":"t1000"',
      '"netPck.AS-SG":[{"description":"Network Package AS-SG","options":[{"value":"t2000"',
    );
    expect(changed).not.toBe(FILE);
    const { catalog } = setup({ text: changed });
    const extras = await catalog.extras("AS-SG");
    expect(extras).toMatchObject({
      snapshotPerGbMonth: { amount: 0.07, currency: "USD" },
      snapshotPerGbHour: { amount: 0.07 / HOURS_A_MONTH, currency: "USD" },
      extraIpv4Monthly: { amount: 1, currency: "USD" },
      trafficIncludedGb: 2000,
      trafficPerGbOver: { amount: 0.01, currency: "USD" },
      stoppedIpv4Monthly: { amount: 5, currency: "USD" },
      stoppedDiskPerGbMonth: { amount: 0.05, currency: "USD" },
      source: "live",
      asOf: NOW.toISOString(),
    });
  });

  it("refuses a datacenter OpsCrew doesn't map, in plain English", async () => {
    const { catalog } = setup(offline);
    const error = await catalog.extras("IL-TA").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
    expect((error as OpsCrewError).message).toContain("Kamatera");
    expect((error as OpsCrewError).hint).toContain("EU-FR");
  });
});

describe("KamateraCatalog leaks", () => {
  it("sends no credential to the public file, and no fixture holds one", async () => {
    const { catalog, calls } = setup({ text: FILE });
    await catalog.listOffers();
    const sent = JSON.stringify(calls);
    for (const value of SECRETS) expect(sent).not.toContain(value);

    const fixtures = join(import.meta.dirname, "__fixtures__");
    for (const name of await readdir(fixtures)) {
      const text = await readFile(join(fixtures, name), "utf8");
      for (const value of SECRETS) expect(text).not.toContain(value);
    }
  });
});
