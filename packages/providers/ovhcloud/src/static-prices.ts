/**
 * OVHcloud Public Cloud prices, dated. The live catalogue reads the same public catalogue when
 * OVHcloud's credentials are set; this table is the fallback, checked against it before each
 * release.
 *
 * Source: OVHcloud's public catalogue for the IE subsidiary,
 * `GET https://eu.api.ovh.com/v1/order/catalog/public/cloud?ovhSubsidiary=IE`, read 2026-11-21:
 * the `<flavor>.consumption` addons (hourly, EUR, excluding VAT; prices in 1e-8 EUR) and their
 * `blobs.technical`, and the `snapshot.consumption` and `snapshot.monthly.postpaid` addons. The
 * catalogue is global: every plan has the same price in every region OpsCrew maps.
 */
export const STATIC_PRICES_AS_OF = "2026-11-21T00:00:00.000Z";

/**
 * The hours an hourly server is counted for a month: the 730-hour figure design shows, and the
 * offer's `monthly` cap (OVHcloud bills hourly servers per second with no monthly cap of its own).
 */
export const HOURS_A_MONTH = 730;

/**
 * The Public Cloud regions OpsCrew maps its regions to (research R2.7): Limburg, Strasbourg,
 * Gravelines, Warsaw, Beauharnois, Singapore and Sydney.
 */
export const OVHCLOUD_LOCATIONS = ["DE1", "SBG5", "GRA11", "WAW1", "BHS5", "SGP1", "SYD1"] as const;

/** One of {@link OVHCLOUD_LOCATIONS}. */
export type OvhcloudLocation = (typeof OVHCLOUD_LOCATIONS)[number];

/** A whole-server snapshot, EUR per GB a month, excluding VAT (`snapshot.monthly.postpaid`). */
export const STATIC_SNAPSHOT_PER_GB_MONTH_EUR = 0.011;
/** A whole-server snapshot, EUR per GB an hour, excluding VAT (`snapshot.consumption`). */
export const STATIC_SNAPSHOT_PER_GB_HOUR_EUR = 0.000015;

export interface StaticFlavor {
  /** OVHcloud's flavor name, for example `d2-4`. */
  name: string;
  vcpus: number;
  memoryGb: number;
  /** NVMe. */
  diskGb: number;
  /** Discovery (`d2`) shares its vCPUs; General Purpose Gen 3 (`b3`) guarantees them. */
  cpuType: "shared" | "dedicated";
  /** EUR an hour, excluding VAT. */
  hourly: number;
}

/** The plans OpsCrew offers (research R2.3). */
export const STATIC_FLAVORS: readonly StaticFlavor[] = [
  // No d2-2 (25 GB): design sizes every app at 40 GB of disk or more, so it could never be picked.
  { name: "d2-4", vcpus: 2, memoryGb: 4, diskGb: 50, cpuType: "shared", hourly: 0.0206 },
  { name: "d2-8", vcpus: 4, memoryGb: 8, diskGb: 50, cpuType: "shared", hourly: 0.0372 },
  { name: "b3-8", vcpus: 2, memoryGb: 8, diskGb: 50, cpuType: "dedicated", hourly: 0.0512 },
  { name: "b3-16", vcpus: 4, memoryGb: 16, diskGb: 100, cpuType: "dedicated", hourly: 0.1023 },
];
