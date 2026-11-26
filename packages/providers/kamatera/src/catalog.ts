import type {
  ComputeCatalog,
  ComputeOffer,
  FetchLike,
  Money,
  ProviderExtras,
} from "@opscrew/contracts";
import { fetchText, OpsCrewError, orText } from "@opscrew/core";
import { z } from "zod";
import {
  HOURS_A_MONTH,
  KAMATERA_LOCATIONS,
  type KamateraLocation,
  type KamateraPlan,
  type KamateraRates,
  STATIC_PLANS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
  STATIC_TRAFFIC_GB,
} from "./static-prices";

/**
 * Kamatera's public calculator data (no sign-in): a JavaScript file whose one line is
 * `var prd_prices = '<JSON>';`. Kamatera's Terraform provider reads the same file at plan time.
 */
export const KAMATERA_CALCULATOR_URL = "https://console.kamatera.com/info/calculator.js.php";
/** The file is about 150 KB; a slow answer never holds a design run longer than this. */
const CALCULATOR_TIMEOUT_MS = 15_000;
/**
 * The JSON between the quotes, taken as it is: the file is not valid JavaScript (a description
 * holds an apostrophe), and its escapes are JSON's.
 */
const FILE_PATTERN = /^\s*var prd_prices = '([\s\S]*)';\s*$/;

/** The rates and allowances besides a server's price, for one datacenter (all USD). */
export interface KamateraExtras extends ProviderExtras {
  /** Each IPv4 address beyond the one included in a server's price, a month. */
  extraIpv4Monthly: Money;
  /** The traffic included each month in this datacenter, GB (unverified for hourly servers). */
  trafficIncludedGb: number;
  /** Each GB of traffic over {@link trafficIncludedGb}. */
  trafficPerGbOver: Money;
  /** A powered-off hourly server's address, a month: a stopped server keeps billing. */
  stoppedIpv4Monthly: Money;
  /** A powered-off hourly server's disk per GB, a month (inferred, unverified). */
  stoppedDiskPerGbMonth: Money;
}

export interface KamateraCatalogOptions {
  /** For the public calculator file, which needs no sign-in. Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Injectable clock for a live read's `asOf`. */
  now?: () => Date;
}

/** One calculator line: its options, each a `value` and a USD `price`. */
const lineSchema = z.tuple([
  z.looseObject({
    options: z.array(z.looseObject({ value: z.string(), price: z.number() })),
  }),
]);

/** A datacenter's traffic: the allowance, GB a month, and each GB over it, USD. */
interface Traffic {
  includedGb: number;
  perGbOver: number;
}

/** What the catalogue read: the table's shape, from the table or from the file. */
interface Prices {
  plans: readonly KamateraPlan[];
  rates: Omit<KamateraRates, "trafficPerGbOver">;
  traffic: Readonly<Record<KamateraLocation, Traffic>>;
  source: "live" | "static";
  asOf: string;
}

/**
 * Kamatera's catalogue: the plans OpsCrew offers in every mapped datacenter, billed by the hour.
 * Their prices come from Kamatera's public calculator file, read at most once per catalogue
 * (`source: "live"`); when it can't be read, or no longer has a plan's lines, from the dated table
 * in `static-prices.ts` (`source: "static"`), with no warning, since it is the same data. Kamatera
 * publishes no availability per account, so every offer is `available`; an apply Kamatera refuses
 * takes the generic unavailable-size path.
 */
export class KamateraCatalog implements ComputeCatalog {
  readonly provider = "kamatera" as const;
  readonly #fetch: FetchLike | undefined;
  readonly #now: () => Date;
  #prices: Promise<Prices> | undefined;

  constructor(options: KamateraCatalogOptions = {}) {
    this.#fetch = options.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const { plans, source, asOf } = await this.#read();
    const out: ComputeOffer[] = [];
    for (const where of KAMATERA_LOCATIONS) {
      if (location !== undefined && where !== location) continue;
      for (const plan of plans) {
        out.push({
          provider: "kamatera",
          id: plan.id,
          vcpus: plan.vcpus,
          memoryGb: plan.memoryGb,
          diskGb: plan.diskGb,
          cpuType: plan.cpuType === "A" ? "shared" : "dedicated",
          architecture: "x86",
          location: where,
          billing: "hourly",
          hourly: usd(plan.monthly / HOURS_A_MONTH),
          monthly: usd(plan.monthly),
          pricesIncludeVat: false,
          deprecated: false,
          available: true,
          source,
          asOf,
        });
      }
    }
    return out;
  }

  /**
   * The snapshot rate, the extra IPv4, the datacenter's traffic allowance and its overage rate,
   * and the powered-off rate. No `ipv4Monthly`: a server's one IPv4 is in its price.
   * @throws OpsCrewError `INVALID_INPUT` for a datacenter OpsCrew doesn't map.
   */
  async extras(location: string): Promise<KamateraExtras> {
    if (!isLocation(location)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew doesn't use the Kamatera datacenter ${location}.`,
        { hint: `Use one of ${orText(KAMATERA_LOCATIONS)}.` },
      );
    }
    const { rates, traffic, source, asOf } = await this.#read();
    return {
      snapshotPerGbMonth: usd(rates.snapshotPerGbMonth),
      snapshotPerGbHour: usd(rates.snapshotPerGbMonth / HOURS_A_MONTH),
      extraIpv4Monthly: usd(rates.extraIpv4Monthly),
      trafficIncludedGb: traffic[location].includedGb,
      trafficPerGbOver: usd(traffic[location].perGbOver),
      stoppedIpv4Monthly: usd(rates.stoppedIpv4Monthly),
      stoppedDiskPerGbMonth: usd(rates.stoppedDiskPerGbMonth),
      pricesIncludeVat: false,
      source,
      asOf,
    };
  }

  /** The file's prices, read once; the table's when the read fails. */
  #read(): Promise<Prices> {
    this.#prices ??= readCalculator(this.#fetch).then(
      (live): Prices => ({ ...live, source: "live", asOf: this.#now().toISOString() }),
      (): Prices => ({
        plans: STATIC_PLANS,
        rates: STATIC_RATES,
        traffic: perLocation((location) => ({
          includedGb: STATIC_TRAFFIC_GB[location],
          perGbOver: STATIC_RATES.trafficPerGbOver,
        })),
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      }),
    );
    return this.#prices;
  }
}

/**
 * The calculator file's prices for the table's plans and rates.
 * @throws when the file can't be read or lacks a line the table needs.
 */
async function readCalculator(
  fetch: FetchLike | undefined,
): Promise<Omit<Prices, "source" | "asOf">> {
  const answer = await fetchText(
    fetch,
    KAMATERA_CALCULATOR_URL,
    { method: "GET" },
    {
      service: "Kamatera",
      what: "read its public price list",
      write: false,
      timeoutMs: CALCULATOR_TIMEOUT_MS,
    },
  );
  if (!answer.ok) throw new Error(`HTTP ${answer.status}`);
  const json = FILE_PATTERN.exec(answer.text)?.[1];
  if (json === undefined) throw new Error("not the calculator file");
  const lines = z.record(z.string(), z.unknown()).parse(JSON.parse(json));
  /** The price of `value` on the line `key`. */
  const price = (key: string, value: string): number => {
    const option = lineSchema.parse(lines[key])[0].options.find((o) => o.value === value);
    if (option === undefined) throw new Error(`no ${key} ${value}`);
    return option.price;
  };
  /** The one price on the line `key`, whatever its value is named. */
  const rate = (key: string): number => {
    const [option] = lineSchema.parse(lines[key])[0].options;
    if (option === undefined) throw new Error(`no ${key}`);
    return option.price;
  };
  return {
    plans: STATIC_PLANS.map((plan) => ({
      ...plan,
      monthly:
        price("cpu", `${plan.vcpus}${plan.cpuType}`) +
        price(`ramMB.${plan.cpuType}`, String(plan.memoryGb * 1024)) +
        price("diskGB", String(plan.diskGb)) +
        price("wan", "1"),
    })),
    rates: {
      snapshotPerGbMonth: rate("snapshot"),
      extraIpv4Monthly: rate("wanEx"),
      stoppedIpv4Monthly: rate("wanPoweredOff"),
      stoppedDiskPerGbMonth: rate("diskExGB"),
    },
    traffic: perLocation((location) => {
      // The metered package (`t5000`); `b50` is the unmetered 50 Mbit/s one.
      const metered = lineSchema
        .parse(lines[`netPck.${location}`])[0]
        .options.map((o) => /^t(\d+)$/.exec(o.value)?.[1])
        .find((gb) => gb !== undefined);
      if (metered === undefined) throw new Error(`no traffic package in ${location}`);
      return { includedGb: Number(metered), perGbOver: rate(`netPckTrafficEx.${location}`) };
    }),
  };
}

/** `of(location)` for each mapped datacenter. */
function perLocation<T>(of: (location: KamateraLocation) => T): Record<KamateraLocation, T> {
  return Object.fromEntries(KAMATERA_LOCATIONS.map((l) => [l, of(l)])) as Record<
    KamateraLocation,
    T
  >;
}

function usd(amount: number): Money {
  return { amount, currency: "USD" };
}

function isLocation(location: string): location is KamateraLocation {
  return (KAMATERA_LOCATIONS as readonly string[]).includes(location);
}
