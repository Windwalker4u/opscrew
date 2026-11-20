/**
 * A domain OpsCrew bought, in the plan's cost (031 US4, FR-3113, research R4): the purchase in
 * `cost.oneTime`, its yearly renewal in `cost.renewals`, and each renewal the registrar charged on
 * its own in `cost.oneTime` once a registrar read shows the domain's expiry moved on.
 */
import type { RegisteredDomain } from "@opscrew/contracts";
import { plural } from "@opscrew/core";
import type { DeployPlan, Renewal } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { convertMoney } from "../design/cost";
import { writePlanIfChanged } from "../shared";
import { withOneTime } from "../shared/cost-times";
import { formatDate, formatMoney, toIsoDateTime } from "./common";
import type { PurchaseRecord } from "./record";
import { REGISTRAR_NAMES } from "./registrars";

type PlanCost = DeployPlan["cost"];

/** How long before a domain's expiry its registrar may charge the renewal (Cloudflare: 30 days). */
const RENEWAL_WINDOW_MS = 30 * 86_400_000;

/** True once `renewal`'s date is 30 days away or less, or past: the registrar may have charged it. */
export function renewalDue(renewal: Renewal, now: Date): boolean {
  return Date.parse(renewal.next) - now.getTime() <= RENEWAL_WINDOW_MS;
}

/** `cost` with `renewal` in place of the renewal of the same domain, or added. */
function withRenewal(cost: PlanCost, renewal: Renewal): PlanCost {
  const renewals = cost.renewals ?? [];
  const same = (entry: Renewal) => entry.item === renewal.item;
  return {
    ...cost,
    renewals: renewals.some(same)
      ? renewals.map((entry) => (same(entry) ? renewal : entry))
      : [...renewals, renewal],
  };
}

/** The renewal of `domain` that `info`'s registrar charges, if the cost has one. */
function renewalOf(cost: PlanCost, domain: string, info: RegisteredDomain): Renewal | undefined {
  return cost.renewals?.find((entry) => entry.item === domain && entry.provider === info.registrar);
}

/**
 * `cost` with the purchase OpsCrew's note `record` describes, once the registrar shows the domain
 * (`info`): the charge in `oneTime` at the time the purchase was sent, in the cost's currency (at
 * the fixed rate), unless a run that finished the purchase before recorded it there; and the
 * domain's renewal in `renewals`, at the price per year quoted then, with the expiry and auto-renew
 * `info` gives. A note without the charge, or no renewal price or expiry, leaves that part out.
 */
export function purchasedCost(
  cost: PlanCost,
  record: PurchaseRecord,
  info: RegisteredDomain,
): PlanCost {
  const { domain, registrar: provider, total, renewal } = record;
  let result: PlanCost = cost;
  if (total !== undefined) {
    const item = `${domain}, ${plural(record.years ?? 1, "year")}`;
    const at = record.requestedAt;
    const recorded = cost.oneTime?.some(
      (fee) => fee.item === item && fee.provider === provider && fee.at === at,
    );
    if (recorded !== true) {
      result = withOneTime(cost, {
        item,
        provider,
        price: convertMoney(total, cost.monthly.currency),
        at,
      });
    }
  }
  const next = toIsoDateTime(info.expiresAt);
  if (renewal === undefined || next === undefined) return result;
  return withRenewal(result, {
    item: domain,
    provider,
    price: renewal,
    next,
    autoRenew: info.autoRenew,
  });
}

/** `cost` with the renewal of `domain` (if any) following the registrar's auto-renew in `info`. */
export function renewalAutoRenew(cost: PlanCost, domain: string, info: RegisteredDomain): PlanCost {
  const renewal = renewalOf(cost, domain, info);
  if (renewal === undefined || renewal.autoRenew === info.autoRenew) return cost;
  return withRenewal(cost, { ...renewal, autoRenew: info.autoRenew });
}

/** What a registrar read changed in the plan ({@link renewedPlan}). */
export interface RenewalRead {
  plan: DeployPlan;
  /** The domain's renewal after the read; absent when the cost has none at that registrar. */
  renewal?: Renewal;
  /** True when the read showed a renewal the registrar charged, now recorded. */
  renewed: boolean;
}

/**
 * `plan` after the registrar's read `info` of `domain`, once the domain's renewal there is due
 * ({@link renewalDue}): the renewal follows the read's auto-renew, and an expiry past `next` means
 * the registrar charged the renewal, so its price goes into `oneTime` at the old `next` (no
 * registrar's answer gives the day it charged) and `next` and `dns.registration`'s expiry move to
 * the new one. The same plan before then, or when nothing changed.
 */
export function renewedPlan(
  plan: DeployPlan,
  domain: string,
  info: RegisteredDomain,
  now: Date,
): RenewalRead {
  const renewal = renewalOf(plan.cost, domain, info);
  if (renewal === undefined || !renewalDue(renewal, now)) return { plan, renewal, renewed: false };
  const expiry = toIsoDateTime(info.expiresAt);
  const next =
    expiry !== undefined && Date.parse(expiry) > Date.parse(renewal.next) ? expiry : undefined;
  if (next === undefined && renewal.autoRenew === info.autoRenew) {
    return { plan, renewal, renewed: false };
  }
  const updated: Renewal = { ...renewal, autoRenew: info.autoRenew, next: next ?? renewal.next };
  let cost = withRenewal(plan.cost, updated);
  if (next !== undefined) {
    cost = withOneTime(cost, {
      item: `${domain}, renewal (1 year)`,
      provider: renewal.provider,
      price: convertMoney(renewal.price, cost.monthly.currency),
      at: renewal.next,
    });
  }
  const registration = plan.dns.registration;
  const dns =
    registration !== undefined && plan.dns.zone === domain
      ? {
          ...plan.dns,
          registration: {
            ...registration,
            autoRenew: info.autoRenew,
            ...(next !== undefined ? { expiresAt: next } : {}),
          },
        }
      : plan.dns;
  return { plan: { ...plan, cost, dns }, renewal: updated, renewed: next !== undefined };
}

/** `example.com was renewed at Cloudflare until 2027-11-20: OpsCrew recorded …`. */
export function renewedLine(renewal: Renewal): string {
  return `${renewal.item} was renewed at ${REGISTRAR_NAMES[renewal.provider]} until ${formatDate(renewal.next)}: OpsCrew recorded the renewal (${formatMoney(renewal.price)}) in opscrew/plan.yaml.`;
}

/**
 * Records what `opscrew domain status`'s read `info` of the project's domain says of its renewal
 * ({@link renewedPlan}) and says when it recorded one. Returns the plan as it is now.
 */
export async function recordRenewal(
  deps: PhaseDeps,
  plan: DeployPlan | undefined,
  info: RegisteredDomain,
): Promise<DeployPlan | undefined> {
  if (plan === undefined) return undefined;
  const read = renewedPlan(plan, info.domain, info, deps.clock.now());
  if (read.plan === plan) return plan;
  await writePlanIfChanged(deps, read.plan);
  if (read.renewed && read.renewal !== undefined) deps.reporter.info(renewedLine(read.renewal));
  return read.plan;
}
