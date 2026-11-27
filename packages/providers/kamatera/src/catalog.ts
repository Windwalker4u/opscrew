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
  type KamateraPlan,
  STATIC_PLANS,
  STATIC_PRICES_AS_OF,
  STATIC_RATES,
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

/** What the catalogue read, from the file or from the table. */
interface Prices {
  plans: readonly KamateraPlan[];
  /** USD per GB a month (`snapshot`). */
  snapshotPerGbMonth: number;
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
   * The snapshot rate. No `ipv4Monthly`: a server's one IPv4 is in its price.
   * @throws OpsCrewError `INVALID_INPUT` for a datacenter OpsCrew doesn't map.
   */
  async extras(location: string): Promise<ProviderExtras> {
    if (!(KAMATERA_LOCATIONS as readonly string[]).includes(location)) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `OpsCrew doesn't use the Kamatera datacenter ${location}.`,
        { hint: `Use one of ${orText(KAMATERA_LOCATIONS)}.` },
      );
    }
    const { snapshotPerGbMonth, source, asOf } = await this.#read();
    return {
      snapshotPerGbMonth: usd(snapshotPerGbMonth),
      snapshotPerGbHour: usd(snapshotPerGbMonth / HOURS_A_MONTH),
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
        snapshotPerGbMonth: STATIC_RATES.snapshotPerGbMonth,
        source: "static",
        asOf: STATIC_PRICES_AS_OF,
      }),
    );
    return this.#prices;
  }
}

/**
 * The calculator file's prices for the table's plans, and its snapshot rate.
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
  return {
    plans: STATIC_PLANS.map((plan) => ({
      ...plan,
      monthly:
        price("cpu", `${plan.vcpus}${plan.cpuType}`) +
        price(`ramMB.${plan.cpuType}`, String(plan.memoryGb * 1024)) +
        price("diskGB", String(plan.diskGb)) +
        price("wan", "1"),
    })),
    snapshotPerGbMonth: price("snapshot", "1"),
  };
}

function usd(amount: number): Money {
  return { amount, currency: "USD" };
}
