import type { ComputeCatalog, ComputeOffer, FetchLike, ProviderExtras } from "@opscrew/contracts";
import {
  CONNECTION_HINT,
  changedApiHint,
  durationText,
  type JsonClient,
  jsonClient,
  OpsCrewError,
  orText,
  parseAnswer,
  type RequestFailure,
  requestJson,
} from "@opscrew/core";
import { z } from "zod";
import { OVHCLOUD_API_URL, type OvhcloudClient } from "./client";
import {
  HOURS_A_MONTH,
  OVHCLOUD_LOCATIONS,
  STATIC_FLAVORS,
  STATIC_PRICES_AS_OF,
  STATIC_SNAPSHOT_PER_GB_HOUR_EUR,
  STATIC_SNAPSHOT_PER_GB_MONTH_EUR,
  type StaticFlavor,
} from "./static-prices";

/**
 * OVHcloud's public catalogue of Public Cloud prices (no sign-in), read with
 * `ovhSubsidiary=IE` for EUR.
 */
export const OVHCLOUD_CATALOG_URL = `${OVHCLOUD_API_URL}/v1/order/catalog/public/cloud`;
/** The subsidiary whose catalogue is read: Ireland's, in EUR (research R1.7). */
const SUBSIDIARY = "IE";
/** The catalogue is about 8 MB. */
const CATALOG_TIMEOUT_MS = 60_000;
/** The catalogue's prices are integers in 1e-8 of the currency (`price: 1040000` is €0.0104). */
const PRICE_UNITS_PER_EUR = 100_000_000;
/** The catalogue's whole-server snapshot rows: per GB an hour, and per GB a month. */
const SNAPSHOT_HOUR = "snapshot.consumption";
const SNAPSHOT_MONTH = "snapshot.monthly.postpaid";

// --- Answer schemas (unknown fields are kept) -------------------------------------------------

/** The public catalogue: `locale` and its `addons`, each row parsed further when it is used. */
const publicCatalogSchema = z.looseObject({
  locale: z.looseObject({ currencyCode: z.literal("EUR") }),
  addons: z.array(z.looseObject({ planCode: z.string() })),
});

/** A row's price with the `consumption` capacity, in 1e-8 EUR. */
const consumptionPrice = z
  .array(z.looseObject({ capacities: z.array(z.string()), price: z.number().int().nonnegative() }))
  .transform((pricings) => pricings.find((p) => p.capacities.includes("consumption"))?.price)
  .pipe(z.number());

const disk = z.looseObject({ capacity: z.number().positive() });

/** A flavor's `<flavor>.consumption` row: its hourly price and `blobs.technical`. */
const flavorAddonSchema = z.looseObject({
  pricings: consumptionPrice,
  blobs: z.looseObject({
    technical: z.looseObject({
      cpu: z.looseObject({ cores: z.number().int().positive() }),
      /** GB. */
      memory: z.looseObject({ size: z.number().positive() }),
      /** GB. */
      storage: z.looseObject({
        disks: z.tuple([disk], disk),
      }),
    }),
  }),
});

const snapshotAddonSchema = z.looseObject({ pricings: consumptionPrice });

/**
 * `GET /v2/publicCloud/project/{projectId}/reference/productAvailability` (v2 `publicCloud.json`,
 * `publicCloud.reference.ProductAvailability[]`): one group per product type, its models, and per
 * model the locations it is sold to the project in.
 */
const availabilitySchema = z.array(
  z.looseObject({
    type: z.string(),
    models: z
      .array(
        z.looseObject({
          /** The flavor's name for an instance. */
          name: z.string(),
          locations: z
            .array(
              z.looseObject({
                name: z.string(),
                regionActivated: z.boolean(),
                /** `SUFFICIENT`, `INSUFFICIENT` or `UNKNOWN`. */
                quotaStatus: z.string(),
                /** `AVAILABLE`, `LOW` or `OUT_OF_STOCK` per availability zone. */
                stockStatus: z.record(z.string(), z.string()).nullish(),
              }),
            )
            .nullish(),
        }),
      )
      .nullish(),
  }),
);

// --- Catalogues ----------------------------------------------------------------------------------

/** What the live catalogue read from the public catalogue. */
interface LivePrices {
  /** The offered plans the catalogue sells, with its prices and sizes. */
  flavors: StaticFlavor[];
  snapshotPerGbMonth: number;
  snapshotPerGbHour: number;
}

export interface OvhcloudCatalogOptions {
  /** For the public catalogue, which needs no sign-in. Default: the global `fetch`. */
  fetch?: FetchLike;
  /** Injectable clock for `asOf`. */
  now?: () => Date;
}

/**
 * OVHcloud's live catalogue: the offered plans' prices and sizes from OVHcloud's public catalogue
 * (IE, EUR before VAT), in every mapped location, each `available` only where the Public Cloud
 * project's `productAvailability` says the region is activated, the stock isn't `OUT_OF_STOCK`
 * and the quota isn't `INSUFFICIENT`. Each is read once per catalogue object; a failed read throws
 * a plain error (never `INVALID_INPUT`), on which design falls back to the static table with a
 * warning, and is tried again on the next call.
 */
export class OvhcloudCatalog implements ComputeCatalog {
  readonly provider = "ovhcloud" as const;
  readonly #now: () => Date;
  readonly #prices: () => Promise<LivePrices>;
  readonly #availability: () => Promise<Set<string>>;

  constructor(client: OvhcloudClient, options: OvhcloudCatalogOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    const http = jsonClient(options.fetch === undefined ? {} : { fetch: options.fetch }, {
      timeoutMs: CATALOG_TIMEOUT_MS,
      retry: {
        serverErrors: 0,
        serverErrorDelayMs: () => 0,
        rateLimits: 0,
        rateLimitDelayMs: () => 0,
      },
    });
    this.#prices = once(() => readPrices(http));
    this.#availability = once(() => readAvailability(client));
  }

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    const [prices, available] = await Promise.all([this.#prices(), this.#availability()]);
    const asOf = this.#now().toISOString();
    return offers(prices.flavors, location, "live", asOf, (flavor, where) =>
      available.has(key(flavor, where)),
    );
  }

  /** The snapshot rate from the catalogue; the public IPv4 is free, so no IPv4 line. */
  async extras(location: string): Promise<ProviderExtras> {
    checkLocation(location);
    const prices = await this.#prices();
    return {
      snapshotPerGbMonth: { amount: prices.snapshotPerGbMonth, currency: "EUR" },
      snapshotPerGbHour: { amount: prices.snapshotPerGbHour, currency: "EUR" },
      pricesIncludeVat: false,
      source: "live",
      asOf: this.#now().toISOString(),
    };
  }
}

/**
 * OVHcloud's catalogue over the dated table in `static-prices.ts` (`source: "static"`), in every
 * mapped location. Every offer is marked available because availability is unknown offline.
 */
export class StaticOvhcloudCatalog implements ComputeCatalog {
  readonly provider = "ovhcloud" as const;
  /** Date of the price table this catalogue is built from. */
  readonly asOf = STATIC_PRICES_AS_OF;

  async listOffers(location?: string): Promise<ComputeOffer[]> {
    return offers(STATIC_FLAVORS, location, "static", STATIC_PRICES_AS_OF, () => true);
  }

  /** The table's snapshot rate; the public IPv4 is free, so no IPv4 line. */
  async extras(location: string): Promise<ProviderExtras> {
    checkLocation(location);
    return {
      snapshotPerGbMonth: { amount: STATIC_SNAPSHOT_PER_GB_MONTH_EUR, currency: "EUR" },
      snapshotPerGbHour: { amount: STATIC_SNAPSHOT_PER_GB_HOUR_EUR, currency: "EUR" },
      pricesIncludeVat: false,
      source: "static",
      asOf: STATIC_PRICES_AS_OF,
    };
  }
}

/** Each flavor in each mapped location (or in `location` alone), billed by the hour. */
function offers(
  flavors: readonly StaticFlavor[],
  location: string | undefined,
  source: "live" | "static",
  asOf: string,
  available: (flavor: string, location: string) => boolean,
): ComputeOffer[] {
  const out: ComputeOffer[] = [];
  for (const where of OVHCLOUD_LOCATIONS) {
    if (location !== undefined && where !== location) continue;
    for (const flavor of flavors) {
      out.push({
        provider: "ovhcloud",
        id: flavor.name,
        vcpus: flavor.vcpus,
        memoryGb: flavor.memoryGb,
        diskGb: flavor.diskGb,
        cpuType: flavor.cpuType,
        architecture: "x86",
        location: where,
        billing: "hourly",
        hourly: { amount: flavor.hourly, currency: "EUR" },
        monthly: { amount: flavor.hourly * HOURS_A_MONTH, currency: "EUR" },
        pricesIncludeVat: false,
        deprecated: false,
        available: available(flavor.name, where),
        source,
        asOf,
      });
    }
  }
  return out;
}

/** @throws OpsCrewError `INVALID_INPUT` for a location OpsCrew doesn't map. */
function checkLocation(location: string): void {
  if (!(OVHCLOUD_LOCATIONS as readonly string[]).includes(location)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew doesn't use the OVHcloud region ${location}.`,
      {
        hint: `Use one of ${orText(OVHCLOUD_LOCATIONS)}.`,
      },
    );
  }
}

/** The public catalogue's prices and sizes of the offered plans, and its snapshot rate. */
async function readPrices(http: JsonClient): Promise<LivePrices> {
  const catalogue = await requestJson(http, {
    url: OVHCLOUD_CATALOG_URL,
    query: { ovhSubsidiary: SUBSIDIARY },
    schema: z.unknown(),
    fail: catalogFailure,
  });
  const { addons } = parseAnswer(
    publicCatalogSchema,
    catalogue,
    "OVHcloud",
    "read its public price catalogue",
  );
  const row = <S extends z.ZodType>(planCode: string, schema: S) =>
    parseAnswer(
      schema,
      addons.find((a) => a.planCode === planCode),
      "OVHcloud",
      `read the price of ${planCode}`,
    );
  const flavors: StaticFlavor[] = [];
  for (const flavor of STATIC_FLAVORS) {
    const planCode = `${flavor.name}.consumption`;
    // A plan the catalogue no longer sells isn't offered.
    if (!addons.some((a) => a.planCode === planCode)) continue;
    const { pricings, blobs } = row(planCode, flavorAddonSchema);
    flavors.push({
      name: flavor.name,
      vcpus: blobs.technical.cpu.cores,
      memoryGb: blobs.technical.memory.size,
      diskGb: blobs.technical.storage.disks[0].capacity,
      cpuType: flavor.cpuType,
      hourly: pricings / PRICE_UNITS_PER_EUR,
    });
  }
  return {
    flavors,
    snapshotPerGbMonth: row(SNAPSHOT_MONTH, snapshotAddonSchema).pricings / PRICE_UNITS_PER_EUR,
    snapshotPerGbHour: row(SNAPSHOT_HOUR, snapshotAddonSchema).pricings / PRICE_UNITS_PER_EUR,
  };
}

/** The `flavor@location` pairs the project can create an instance of now. */
async function readAvailability(client: OvhcloudClient): Promise<Set<string>> {
  const groups = await client.get(
    `${client.projectPath("v2")}/reference/productAvailability`,
    availabilitySchema,
    { type: "INSTANCE" },
  );
  const available = new Set<string>();
  for (const group of groups) {
    if (group.type !== "INSTANCE") continue;
    for (const model of group.models ?? []) {
      for (const location of model.locations ?? []) {
        if (
          location.regionActivated &&
          location.quotaStatus !== "INSUFFICIENT" &&
          !Object.values(location.stockStatus ?? {}).includes("OUT_OF_STOCK")
        ) {
          available.add(key(model.name, location.name));
        }
      }
    }
  }
  return available;
}

function key(flavor: string, location: string): string {
  return `${flavor}@${location}`;
}

/** The public catalogue's failure in plain English, never `INVALID_INPUT`. */
function catalogFailure(failure: RequestFailure): OpsCrewError {
  const what = "OVHcloud's public price catalogue";
  switch (failure.kind) {
    case "unreachable":
      return new OpsCrewError(
        "PROVIDER_ERROR",
        failure.timedOut
          ? `${what} did not answer within ${durationText(CATALOG_TIMEOUT_MS)}.`
          : `Could not reach ${what} (${new URL(OVHCLOUD_CATALOG_URL).host}).`,
        { hint: CONNECTION_HINT },
      );
    case "status":
      return new OpsCrewError(
        "PROVIDER_ERROR",
        `${what} answered HTTP ${failure.response.status}.`,
        { hint: "Try again in a few minutes." },
      );
    case "invalid-json":
    case "unexpected": // The answer is parsed afterwards, with `parseAnswer`.
      return new OpsCrewError("PROVIDER_ERROR", `${what} returned invalid JSON.`, {
        hint: changedApiHint("OVHcloud"),
      });
  }
}

/** `read()` once, kept while it succeeds: a failed read is tried again on the next call. */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => {
    value ??= read().catch((error: unknown) => {
      value = undefined;
      throw error;
    });
    return value;
  };
}
