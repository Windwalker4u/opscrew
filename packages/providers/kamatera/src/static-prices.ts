/**
 * Kamatera prices, dated. The catalogue reads the same public calculator file when it is
 * reachable; this table is the fallback, checked against it before each release.
 *
 * Source: Kamatera's public calculator data, `GET https://console.kamatera.com/info/calculator.js.php`
 * (no sign-in), read 2026-11-22 and again 2026-11-26 with the same prices: US dollars a month,
 * excluding any tax (the file names none). A server's monthly price is the sum of its `cpu`
 * (`<cores><type>`), `ramMB.<type>`, `diskGB` (the system disk's size) and `wan` (`1`, the one
 * included IPv4, $0) lines; the hourly price is that divided by 730 (research R4 §3, §7).
 */
export const STATIC_PRICES_AS_OF = "2026-11-22T00:00:00.000Z";

/** Kamatera's hourly price is its monthly price divided by 730 (research R4 §3). */
export const HOURS_A_MONTH = 730;

/**
 * The datacenters OpsCrew maps its regions to, in the order of research R4 §6's mapping:
 * Frankfurt, Amsterdam, Stockholm, New York, Atlanta, Miami, Chicago, Santa Clara, Los Angeles,
 * Seattle, Singapore, Sydney and Hong Kong. Stockholm, Atlanta, Miami, Chicago, Los Angeles,
 * Seattle, Singapore and Sydney are read from the code against Kamatera's city list
 * (unverified until a live `datacenters` list says it); every code is in the calculator's
 * `datacenters` list.
 */
export const KAMATERA_LOCATIONS = [
  "EU-FR",
  "EU",
  "EU-ST",
  "US-NY2",
  "US-AT",
  "US-MI",
  "US-CH",
  "US-SC",
  "US-LA",
  "US-SE",
  "AS-SG",
  "AU-SY",
  "AS",
] as const;

/** One of {@link KAMATERA_LOCATIONS}. */
export type KamateraLocation = (typeof KAMATERA_LOCATIONS)[number];

/** One plan OpsCrew offers: a Kamatera configuration under OpsCrew's own id. */
export interface KamateraPlan {
  /** OpsCrew's id, `<cpu type>-<vCPUs>-<GB of memory>`, such as `A-2-4`. */
  id: string;
  /**
   * Kamatera's CPU type: `A` (Availability, threads shared with other servers) or `B` (General
   * Purpose, dedicated threads).
   */
  cpuType: "A" | "B";
  vcpus: number;
  memoryGb: number;
  /** The one (system) disk. */
  diskGb: number;
  /** USD a month. */
  monthly: number;
}

/**
 * The plans OpsCrew offers (plan 8.). `A-1-2` and `B-1-2` carry a 40 GB disk, not research R4
 * §7's 20 GB, because design never sizes a server below 40 GB of disk: 40 GB is the `diskGB`
 * line's $9 instead of $6.
 */
export const STATIC_PLANS: readonly KamateraPlan[] = [
  { id: "A-1-2", cpuType: "A", vcpus: 1, memoryGb: 2, diskGb: 40, monthly: 9 },
  { id: "A-2-4", cpuType: "A", vcpus: 2, memoryGb: 4, diskGb: 40, monthly: 19 },
  { id: "A-4-8", cpuType: "A", vcpus: 4, memoryGb: 8, diskGb: 80, monthly: 42 },
  { id: "B-1-2", cpuType: "B", vcpus: 1, memoryGb: 2, diskGb: 40, monthly: 18 },
  { id: "B-2-4", cpuType: "B", vcpus: 2, memoryGb: 4, diskGb: 40, monthly: 42 },
  { id: "B-4-8", cpuType: "B", vcpus: 4, memoryGb: 8, diskGb: 80, monthly: 90 },
];

/** The rates besides the server's own, USD; each names its calculator line. */
export interface KamateraRates {
  /** A snapshot per GB (`snapshot`). That it is a month's rate is unverified. */
  snapshotPerGbMonth: number;
  /** Each IPv4 address beyond the included one, a month (`wanEx`). */
  extraIpv4Monthly: number;
  /** Each GB of traffic over the datacenter's allowance (`netPckTrafficEx.<datacenter>`). */
  trafficPerGbOver: number;
  /** A powered-off hourly server's address, a month (`wanPoweredOff`). */
  stoppedIpv4Monthly: number;
  /**
   * A powered-off hourly server's disk per GB, a month (`diskExGB`). Inferred: Kamatera's FAQ
   * gives only an example ($0.0102 an hour for 50 GB), which `wanPoweredOff` plus 50 GB at this
   * rate matches (research R4 §3); unverified.
   */
  stoppedDiskPerGbMonth: number;
}

/** The table's rates. */
export const STATIC_RATES: KamateraRates = {
  snapshotPerGbMonth: 0.05,
  extraIpv4Monthly: 1,
  trafficPerGbOver: 0.01,
  stoppedIpv4Monthly: 5,
  stoppedDiskPerGbMonth: 0.05,
};

/**
 * The traffic included each month, GB, per datacenter: the metered `netPck.<datacenter>` package
 * (`t5000` or `t1000`). Whether an hourly server carries it is unverified (research R4 §3).
 */
export const STATIC_TRAFFIC_GB: Readonly<Record<KamateraLocation, number>> = {
  "EU-FR": 5000,
  EU: 5000,
  "EU-ST": 5000,
  "US-NY2": 5000,
  "US-AT": 5000,
  "US-MI": 5000,
  "US-CH": 5000,
  "US-SC": 5000,
  "US-LA": 5000,
  "US-SE": 5000,
  "AS-SG": 1000,
  "AU-SY": 1000,
  AS: 1000,
};
