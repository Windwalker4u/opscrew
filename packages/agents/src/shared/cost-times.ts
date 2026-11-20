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

/**
 * `cost` with `oneTime` and `ended` as given, in its currency (the schema wants one), each left out
 * when empty.
 */
function withRecords(
  cost: CostEstimate,
  records: { oneTime: readonly OneTimeCost[] | undefined; ended: readonly EndedCost[] | undefined },
): CostEstimate {
  const { oneTime: _oneTime, ended: _ended, ...rest } = cost;
  const { currency } = cost.monthly;
  const oneTime = records.oneTime?.map((fee) =>
    fee.price.currency === currency ? fee : { ...fee, price: convertMoney(fee.price, currency) },
  );
  const ended = records.ended?.map((entry) => endedIn(entry, currency));
  return {
    ...rest,
    ...(oneTime !== undefined && oneTime.length > 0 ? { oneTime } : {}),
    ...(ended !== undefined && ended.length > 0 ? { ended } : {}),
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

/** The ended entries of the running `lines` (with `since` and a billing), removed at `until`. */
function endedOf(lines: readonly CostItem[], until: string): EndedCost[] {
  return lines.flatMap((line) => {
    const { item, provider, monthly, billing, hourly, since } = line;
    if (since === undefined || billing === undefined) return [];
    return [
      {
        item,
        ...(provider !== undefined ? { provider } : {}),
        monthly,
        billing,
        ...(hourly !== undefined ? { hourly } : {}),
        since,
        until,
      },
    ];
  });
}

/** `cost` with `entries` added to its ended items. */
export function withEnded(cost: CostEstimate, entries: readonly EndedCost[]): CostEstimate {
  if (entries.length === 0) return cost;
  return withRecords(cost, { oneTime: cost.oneTime, ended: [...(cost.ended ?? []), ...entries] });
}

/** `cost` with the running `lines` (its own or another cost's) ended at `until`. */
export function endBilling(
  cost: CostEstimate,
  lines: readonly CostItem[],
  until: string,
): CostEstimate {
  return withEnded(cost, endedOf(lines, until));
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
  return withRecords(cost, { oneTime: [...(cost.oneTime ?? []), fee], ended: cost.ended });
}

/** `next` with the one-time fees and ended items `previous` recorded (a cost priced anew). */
export function carryRecords(next: CostEstimate, previous: CostEstimate): CostEstimate {
  return withRecords(next, { oneTime: previous.oneTime, ended: previous.ended });
}

/** An item's identity across designs: the provider that bills it and its words. */
function itemKey(line: CostItem): string {
  return `${line.provider ?? ""}\n${line.item}`;
}

/**
 * `lines` with `since` from the running item of `before` with the same words and provider each,
 * and the running items of `before` none matched.
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
    return billed(line) && line.since === undefined ? { ...line, since: match.since } : line;
  });
  return { breakdown, unmatched: [...running.values()] };
}

/**
 * Design's new cost `next` with the times the plan's `previous` cost recorded: an item still
 * planned (the same words from the same provider) keeps its `since`; a running item design no
 * longer plans (backups turned off, another server type) ends at `now`, the design that removes
 * it, which `opscrew provision` applies; the ended items and one-time fees stay.
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
 * its running items when the move started (`old`), and the records of the move's cost `moving`,
 * whose running items (the new side's) end at `until`, when the new side was removed.
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
