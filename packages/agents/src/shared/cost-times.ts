/**
 * When each cost item started and stopped being billed (031 US4, FR-3112, research R4): a running
 * item's `since`, the items removed in `cost.ended` with their `until`, and the one-time fees in
 * `cost.oneTime`. The hosted portal adds up what has run up from them.
 */
import type { Currency } from "@opscrew/contracts";
import type {
  CostEstimate,
  CostItem,
  DeployPlan,
  EndedCost,
  OneTimeCost,
} from "@opscrew/plan-schema";
import { convertMoney, convertRate } from "../design/cost";

/** Whether `line` is billed over time (hourly or monthly), not free nor of unknown billing. */
function billed(line: CostItem): boolean {
  return line.billing === "hourly" || line.billing === "monthly";
}

/** `entry` in `currency` (a move to a provider that prices in another), at the fixed rate. */
function endedIn(entry: EndedCost, currency: Currency): EndedCost {
  if (entry.monthly.currency === currency) return entry;
  const { hourly } = entry;
  return {
    ...entry,
    monthly: convertMoney(entry.monthly, currency),
    ...(hourly !== undefined ? { hourly: convertRate(hourly, currency) } : {}),
  };
}

/** `cost` with `oneTime` and `ended` as given, each left out when empty. */
function withRecords(
  cost: CostEstimate,
  records: { oneTime: readonly OneTimeCost[] | undefined; ended: readonly EndedCost[] | undefined },
): CostEstimate {
  const { oneTime: _oneTime, ended: _ended, ...rest } = cost;
  const { oneTime, ended } = records;
  return {
    ...rest,
    ...(oneTime !== undefined && oneTime.length > 0 ? { oneTime: [...oneTime] } : {}),
    ...(ended !== undefined && ended.length > 0 ? { ended: [...ended] } : {}),
  };
}

/**
 * `cost` with only the ended items (by `until`) and one-time fees (by `at`) of the current and the
 * previous calendar month (UTC) of `now`: every plan write keeps no older ones.
 */
export function prunedCost(cost: CostEstimate, now: Date): CostEstimate {
  if (cost.ended === undefined && cost.oneTime === undefined) return cost;
  const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return withRecords(cost, {
    oneTime: cost.oneTime?.filter((fee) => Date.parse(fee.at) >= from),
    ended: cost.ended?.filter((line) => Date.parse(line.until) >= from),
  });
}

/** `plan` with its cost pruned as {@link prunedCost} says. */
export function prunedPlan(plan: DeployPlan, now: Date): DeployPlan {
  const cost = prunedCost(plan.cost, now);
  return cost === plan.cost ? plan : { ...plan, cost };
}

/** `cost` with `since` set to `at` on each billed item that has none: it is billed from now. */
export function startBilling(cost: CostEstimate, at: string): CostEstimate {
  if (!cost.breakdown.some((line) => billed(line) && line.since === undefined)) return cost;
  return {
    ...cost,
    breakdown: cost.breakdown.map((line) =>
      billed(line) && line.since === undefined ? { ...line, since: at } : line,
    ),
  };
}

/**
 * `cost` with the running `lines` (those with `since` and a billing; its own or, at a move,
 * another cost's, so in its currency) ended at `until`.
 */
export function endBilling(
  cost: CostEstimate,
  lines: readonly CostItem[],
  until: string,
): CostEstimate {
  const ended = lines.flatMap((line): EndedCost[] => {
    const { item, provider, monthly, billing, hourly, since } = line;
    if (since === undefined || billing === undefined) return [];
    const entry = {
      item,
      ...(provider !== undefined ? { provider } : {}),
      monthly,
      billing,
      ...(hourly !== undefined ? { hourly } : {}),
      since,
      until,
    };
    return [endedIn(entry, cost.monthly.currency)];
  });
  return ended.length === 0 ? cost : { ...cost, ended: [...(cost.ended ?? []), ...ended] };
}

/**
 * `cost` after its deployment was removed at `until` (`opscrew destroy`): every running item ended
 * then, and the breakdown, still the plan's estimate, without `since`.
 */
export function stopBilling(cost: CostEstimate, until: string): CostEstimate {
  const ended = endBilling(cost, cost.breakdown, until);
  if (ended === cost) return cost;
  return { ...ended, breakdown: ended.breakdown.map(({ since: _since, ...line }) => line) };
}

/** `cost` with the one-time `fee`. */
export function withOneTime(cost: CostEstimate, fee: OneTimeCost): CostEstimate {
  return { ...cost, oneTime: [...(cost.oneTime ?? []), fee] };
}

/**
 * `next` (a cost priced anew, perhaps at another provider in another currency) with the one-time
 * fees and ended items `previous` recorded, in `next`'s currency.
 */
export function carryRecords(next: CostEstimate, previous: CostEstimate): CostEstimate {
  const { currency } = next.monthly;
  return withRecords(next, {
    oneTime: previous.oneTime?.map((fee) =>
      fee.price.currency === currency ? fee : { ...fee, price: convertMoney(fee.price, currency) },
    ),
    ended: previous.ended?.map((entry) => endedIn(entry, currency)),
  });
}

/**
 * An item's identity across designs: the provider that bills it and its words without what only
 * says where its price came from (the published rate or OpsCrew's default rate design names, and an
 * extra server's price converted from another currency), which can change while it runs on.
 */
function itemKey(line: CostItem): string {
  const { item } = line;
  const base = item.startsWith("Primary IPv4 address")
    ? "Primary IPv4 address"
    : item.startsWith("Automated backups (")
      ? "Automated backups"
      : item.replace(/, \S+ converted at 1 EUR = .*$/, "");
  return `${line.provider ?? ""}\n${base}`;
}

/**
 * `lines` with `since` from the running item of `before` with the same identity each, and the
 * running items of `before` none matched.
 */
function matchRunning(
  lines: readonly CostItem[],
  before: readonly CostItem[],
): { breakdown: CostItem[]; unmatched: CostItem[] } {
  const running = new Map(
    before.filter((line) => line.since !== undefined).map((line) => [itemKey(line), line]),
  );
  const breakdown = lines.map((line) => {
    const match = running.get(itemKey(line));
    if (match === undefined) return line;
    running.delete(itemKey(line));
    return line.since === undefined ? { ...line, since: match.since } : line;
  });
  return { breakdown, unmatched: [...running.values()] };
}

/**
 * A cost priced anew, `next` (by design, or after a change of the plan's servers), with the times
 * the plan's `previous` cost recorded: an item still planned keeps its `since`; a running item no
 * longer planned (backups turned off, another server type, a server removed) ends at `now`, the
 * change that removes it, which `opscrew provision` applies; the ended items and one-time fees stay.
 */
export function keepCostTimes(
  next: CostEstimate,
  previous: CostEstimate | undefined,
  now: string,
): CostEstimate {
  if (previous === undefined) return next;
  const { breakdown, unmatched } = matchRunning(next.breakdown, previous.breakdown);
  return endBilling(carryRecords({ ...next, breakdown }, previous), unmatched, now);
}

/**
 * The cost after an aborted move: the old side's cost `restored` (priced anew) with the `since` of
 * its running items when the move started (`old`, the move's `from.running`), and the records of
 * the move's cost `moving`, whose running items (the new side's) end at `until`, when the new side
 * was removed.
 */
export function abortedCost(
  restored: CostEstimate,
  old: readonly CostItem[],
  moving: CostEstimate,
  until: string,
): CostEstimate {
  const { breakdown } = matchRunning(restored.breakdown, old);
  return endBilling(carryRecords({ ...restored, breakdown }, moving), moving.breakdown, until);
}
