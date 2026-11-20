import type { ComputeOffer, Currency, Money, ProviderExtras } from "@opscrew/contracts";
import { formatMoney, plural, taxLabel } from "@opscrew/core";
import {
  type CloudProvider,
  type CostEstimate,
  CostEstimateSchema,
  type CostItem,
  type EndedCost,
  isCloudProvider,
  type OneTimeCost,
} from "@opscrew/plan-schema";
import { cloudProvider } from "@opscrew/providers";
import type { PhaseDeps } from "../context";
import { vpsConnector } from "../providers";
import { backupsOnOrderPage } from "./backups";
import { designWording } from "./wording";

/** Fixed approximate exchange rate used for budget comparisons: 1 EUR = 1.10 USD. */
export const USD_PER_EUR = 1.1;

/**
 * Sentences stating the exchange rate, shown whenever a budget is compared across currencies. The
 * rate stays fixed so estimates are reproducible; the user can get an exact figure themselves.
 */
export const EXCHANGE_RATE_NOTE =
  "Converted at a fixed approximate rate of 1 EUR = 1.10 USD. For an exact figure, look up today's rate, or ask your AI assistant to search the web for it and convert.";

/** Automated backup surcharge when neither the catalogue nor the caller gives one (Hetzner's). */
const DEFAULT_BACKUP_PERCENT = 20;

/** An extra server's `priceSource` when its price was converted from another currency. */
export function convertedNote(monthly: Money): string {
  return `${formatMoney(monthly)} converted at 1 EUR = ${USD_PER_EUR.toFixed(2)} USD`;
}

/** Rounds to cents. */
export function roundCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/** Converts money between EUR and USD at {@link USD_PER_EUR}, rounded to cents. */
export function convertMoney(money: Money, to: Currency): Money {
  if (money.currency === to) return { amount: roundCents(money.amount), currency: to };
  const amount = to === "USD" ? money.amount * USD_PER_EUR : money.amount / USD_PER_EUR;
  return { amount: roundCents(amount), currency: to };
}

/** An hourly price converted as {@link convertMoney} does, rounded to a millionth, not to cents. */
export function convertRate(money: Money, to: Currency): Money {
  const amount =
    money.currency === to
      ? money.amount
      : to === "USD"
        ? money.amount * USD_PER_EUR
        : money.amount / USD_PER_EUR;
  return { amount: Math.round(amount * 1e6) / 1e6, currency: to };
}

/**
 * How `offer`'s lines are billed (research R4): the offer's billing, else its provider's (the
 * definition's `offering.billing.model`). The returned function gives a line's `billing` and, for
 * an hourly one, its `hourly` price in `currency`; a line of an hourly offer without its hourly
 * price gets neither (the plan's schema wants both).
 */
function billingOf(
  offer: Pick<ComputeOffer, "provider" | "billing">,
  currency: Currency,
): (hourly: Money | undefined) => Pick<CostItem, "billing" | "hourly"> {
  const billing =
    offer.billing ??
    (isCloudProvider(offer.provider)
      ? cloudProvider(offer.provider).offering.billing.model
      : undefined);
  return (hourly) => {
    if (billing === "monthly") return { billing };
    if (billing === "hourly" && hourly !== undefined) {
      return { billing, hourly: convertRate(hourly, currency) };
    }
    return {};
  };
}

/**
 * The one-time setup fee that creating a server of `target` charged at `at`, in `currency`: where
 * its provider's billing says creating one can charge a fee (`offering.billing.setupFee`, Contabo)
 * and the server's offer in the provider's published price list names it. Undefined otherwise.
 */
export async function setupFeeOf(
  deps: Pick<PhaseDeps, "fetch" | "redactor" | "version">,
  target: { provider: string; serverType: string; location: string },
  at: string,
  currency: Currency,
): Promise<OneTimeCost | undefined> {
  const { provider, serverType, location } = target;
  if (!isCloudProvider(provider) || !cloudProvider(provider).offering.billing.setupFee) {
    return undefined;
  }
  // The published price list: a connector without credentials reads only that.
  const catalog = vpsConnector(provider, {
    env: {},
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  }).catalog();
  const offer = (await catalog.listOffers(location)).find((o) => o.id === serverType);
  if (offer?.setupFee === undefined) return undefined;
  return {
    item: `Setup fee (${serverType})`,
    provider,
    price: convertMoney(offer.setupFee, currency),
    at,
  };
}

/**
 * A deleted whole-server snapshot of `sizeBytes` at `provider` as an ended cost item in
 * `currency`, kept from `since` to `until`: priced at the provider's published per-GB rates
 * (`offering.snapshots`) and billed as its servers are. Undefined where its snapshots are included
 * in the server's price.
 */
export function endedSnapshot(
  snapshot: { id: string; provider: CloudProvider; sizeBytes: number },
  times: { since: string; until: string },
  currency: Currency,
): EndedCost | undefined {
  const { offering } = cloudProvider(snapshot.provider);
  const rates = offering.snapshots;
  if (rates.kind !== "per-gb") return undefined;
  const gb = snapshot.sizeBytes / 1024 ** 3;
  const price = (rate: number) => ({ amount: gb * rate, currency: offering.currency });
  const hourly = offering.billing.model === "hourly";
  return {
    item: `Snapshot ${snapshot.id} (${Math.round(gb * 100) / 100} GB)`,
    provider: snapshot.provider,
    monthly: convertMoney(price(rates.perGbMonth), currency),
    billing: offering.billing.model,
    ...(hourly ? { hourly: convertRate(price(rates.perGbHour), currency) } : {}),
    since: times.since,
    until: times.until,
  };
}

/** `estimate as of 2026-06-15` for static prices, `live price` for prices read from the API. */
export function priceLabel(cost: Pick<CostEstimate, "source" | "asOf">): string {
  return cost.source === "static" ? `estimate as of ${cost.asOf.slice(0, 10)}` : "live price";
}

/** Where a rate in an estimate with a live server price comes from, when not from the API. */
export interface RateSource {
  /** `DigitalOcean's published rate as of 2026-10-12` or `OpsCrew's default rate`. */
  rate: string;
  /** Why: `the API does not return it` or `Hetzner's API did not return one`. */
  reason: string;
  /** The cost item's `priceSource`. */
  priceSource: string;
  /** Date the rate is valid for, when it has one (a published price list). */
  asOf?: string;
}

/** The rates of an estimate that were not read from the provider's API, by line. */
export interface NonLiveRates {
  ipv4?: RateSource;
  backups?: RateSource;
}

/**
 * The rates in an estimate for a live `offer` that were not read from the provider's API in this
 * run: the IPv4 price and backup percentage from static extras (DigitalOcean's published price
 * page) and a backup percentage that is the provider profile's or OpsCrew's default because the
 * extras have none. Empty for a static offer: the whole estimate is then dated as one.
 */
function nonLiveRates(
  offer: Pick<ComputeOffer, "provider" | "source">,
  extras: ProviderExtras,
  options: { backups: boolean },
): NonLiveRates {
  if (offer.source !== "live") return {};
  const name = isCloudProvider(offer.provider)
    ? designWording(offer.provider).name
    : offer.provider;
  const date = extras.asOf.slice(0, 10);
  const published: RateSource = {
    rate: `${name}'s published rate as of ${date}`,
    reason: "the API does not return it",
    priceSource: `${name}'s published rate as of ${date}`,
    asOf: extras.asOf,
  };
  const out: NonLiveRates = {};
  if (extras.ipv4Monthly !== undefined && extras.source !== "live") out.ipv4 = published;
  if (options.backups) {
    if (extras.backupPercent === undefined) {
      out.backups = {
        rate: "OpsCrew's default rate",
        reason: `${name}'s API did not return one`,
        priceSource: `OpsCrew's default rate, not from ${name}'s API`,
      };
    } else if (extras.source !== "live") {
      out.backups = published;
    }
  }
  return out;
}

/**
 * What running `offer` means besides its monthly price, as sentences: its one-time setup fee
 * (never part of the monthly price), the minimum term of a provider whose removal ends the contract
 * only at the end of its term, and whole-server snapshots included in the price up to the offer's
 * count. Empty when none applies (Hetzner, DigitalOcean).
 */
export function offerTerms(offer: ComputeOffer, extras: ProviderExtras): string[] {
  const terms: string[] = [];
  if (offer.setupFee !== undefined) {
    terms.push(
      `Plus a one-time setup fee of ${formatMoney(offer.setupFee)} (${taxLabel(offer.setupFee.currency, offer.pricesIncludeVat)}) when the server is created, not part of the monthly price.`,
    );
  }
  const removal = isCloudProvider(offer.provider)
    ? cloudProvider(offer.provider).offering.removal
    : undefined;
  if (removal?.kind === "cancel-at-term-end") {
    terms.push(
      `The contract runs at least ${plural(removal.minimumTermMonths, "month")}; a removal ends it at the end of the term.`,
    );
  }
  if (extras.snapshotsIncluded === true && offer.includedSnapshots !== undefined) {
    terms.push(
      `Whole-server snapshots are included in the price, up to ${offer.includedSnapshots}.`,
    );
  }
  return terms;
}

/**
 * Monthly cost of running `offer`: server + primary IPv4 (only when the provider prices it
 * separately) + automated backups (percentage of the server price) when `backups` is on, never at
 * a provider that offers none through OpsCrew (`offering.providerBackups` false), nor at one that
 * prices them only on its order page (`offering.backupsPrice` `order-page`, Contabo): design says
 * so beside the price instead of counting them at any figure. The
 * backup percentage comes from `extras`, else `options.backupPercent` (the provider profile's),
 * else 20. Each line is rounded to cents and the total is their sum, in the offer's currency.
 *
 * The estimate is `live` only when every number in it was read from the provider's API in this
 * run. With a live offer, a line whose rate was not (see {@link nonLiveRates}) names where it comes
 * from in its `priceSource`, and the estimate is `static`, dated by the published price list when
 * one is used, else by the offer. Validated with `CostEstimateSchema`.
 */
export function costFor(
  offer: ComputeOffer,
  extras: ProviderExtras,
  options: { backups: boolean; backupPercent?: number },
): CostEstimate {
  return pricedOffer(offer, extras, options).cost;
}

/** {@link costFor}, with the rates in it that were not read from the provider's API. */
export function pricedOffer(
  offer: ComputeOffer,
  extras: ProviderExtras,
  priced: { backups: boolean; backupPercent?: number },
): { cost: CostEstimate; rates: NonLiveRates } {
  const offered =
    !isCloudProvider(offer.provider) ||
    (cloudProvider(offer.provider).offering.providerBackups && !backupsOnOrderPage(offer.provider));
  const options = { ...priced, backups: priced.backups && offered };
  const currency = offer.monthly.currency;
  const server = roundCents(offer.monthly.amount);
  const billed = billingOf(offer, currency);
  const percent = extras.backupPercent ?? options.backupPercent ?? DEFAULT_BACKUP_PERCENT;
  const breakdown: CostEstimate["breakdown"] = [
    {
      item: `Server ${offer.id} (${offer.location})`,
      provider: offer.provider,
      monthly: { amount: server, currency },
      ...billed(offer.hourly),
    },
  ];
  const rates = nonLiveRates(offer, extras, options);
  if (extras.ipv4Monthly !== undefined) {
    breakdown.push({
      item: "Primary IPv4 address",
      ...(rates.ipv4 ? { priceSource: rates.ipv4.priceSource } : {}),
      provider: offer.provider,
      monthly: convertMoney(extras.ipv4Monthly, currency),
      ...billed(extras.ipv4Hourly),
    });
  }
  if (options.backups) {
    breakdown.push({
      item: `Automated backups (${percent}% of the server price)`,
      ...(rates.backups ? { priceSource: rates.backups.priceSource } : {}),
      provider: offer.provider,
      monthly: { amount: roundCents((server * percent) / 100), currency },
      // Billed as the server is: the percentage of its hourly price too.
      ...billed(offer.hourly && { ...offer.hourly, amount: (offer.hourly.amount * percent) / 100 }),
    });
  }
  const total = roundCents(breakdown.reduce((sum, line) => sum + line.monthly.amount, 0));
  const live = offer.source === "live" && rates.ipv4 === undefined && rates.backups === undefined;
  // A mixed estimate is only as fresh as its published price list; without one, as the offer.
  const asOf = rates.ipv4?.asOf ?? rates.backups?.asOf ?? offer.asOf;
  const cost = CostEstimateSchema.parse({
    monthly: { amount: total, currency },
    breakdown,
    pricesIncludeVat: offer.pricesIncludeVat,
    source: live ? "live" : "static",
    asOf,
  });
  return { cost, rates };
}
