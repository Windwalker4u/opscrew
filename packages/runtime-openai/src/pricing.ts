/** Date the static OpenAI list-price table below was verified from openai.com/api/pricing. */
export const OPENAI_PRICING_DATE = "2026-11-25";

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly cachedInputPerMillion: number;
  readonly outputPerMillion: number;
}

/**
 * Standard OpenAI API token list prices in USD per 1,000,000 tokens (dated {@link OPENAI_PRICING_DATE}).
 * Ordered from more specific model ids to shorter prefixes so prefix lookup matches cleanly.
 */
export const OPENAI_MODEL_PRICES: ReadonlyArray<readonly [prefix: string, price: ModelPrice]> = [
  ["gpt-5-mini", { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0 }],
  ["gpt-5-nano", { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 }],
  ["gpt-5", { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 }],
  ["gpt-4.1-mini", { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 }],
  ["gpt-4.1-nano", { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 }],
  ["gpt-4.1", { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 }],
  ["gpt-4o-mini", { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 }],
  ["gpt-4o", { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10.0 }],
  ["o4-mini", { inputPerMillion: 1.1, cachedInputPerMillion: 0.275, outputPerMillion: 4.4 }],
  ["o3-mini", { inputPerMillion: 1.1, cachedInputPerMillion: 0.55, outputPerMillion: 4.4 }],
  ["o3", { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 }],
];

export interface UsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly input_tokens_details?: { readonly cached_tokens?: number | null } | null;
  /** Optional direct USD cost reported by compatible gateways such as OpenRouter. */
  readonly cost?: number | null;
}

/** Strips an optional gateway namespace (`openai/...`) and trailing snapshot date (`-YYYY-MM-DD`). */
function normalizeModelId(model: string): string {
  const lower = model.trim().toLowerCase();
  const slash = lower.lastIndexOf("/");
  const base = slash >= 0 ? lower.slice(slash + 1) : lower;
  return base.replace(/-\d{4}-\d{2}-\d{2}$/, "");
}

/** Resolves the static OpenAI list price for `model`, or `undefined` if unknown. */
export function resolveModelPrice(model: string): ModelPrice | undefined {
  const normalized = normalizeModelId(model);
  for (const [prefix, price] of OPENAI_MODEL_PRICES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      return price;
    }
  }
  return undefined;
}

/**
 * Computes USD cost for one Responses API turn from `usage`. Prefers a finite non-negative
 * `usage.cost` when supplied by a gateway; otherwise uses the dated OpenAI list-price table.
 */
export function calculateUsageCostUsd(model: string, usage: UsageLike | undefined | null): number {
  if (usage === undefined || usage === null) return 0;
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
    return usage.cost;
  }
  const price = resolveModelPrice(model);
  if (price === undefined) return 0;
  const totalInput =
    typeof usage.input_tokens === "number" && Number.isFinite(usage.input_tokens)
      ? Math.max(0, usage.input_tokens)
      : 0;
  const rawCached =
    typeof usage.input_tokens_details?.cached_tokens === "number" &&
    Number.isFinite(usage.input_tokens_details.cached_tokens)
      ? Math.max(0, usage.input_tokens_details.cached_tokens)
      : 0;
  const cachedInput = Math.min(totalInput, rawCached);
  const uncachedInput = totalInput - cachedInput;
  const output =
    typeof usage.output_tokens === "number" && Number.isFinite(usage.output_tokens)
      ? Math.max(0, usage.output_tokens)
      : 0;
  return (
    (uncachedInput * price.inputPerMillion +
      cachedInput * price.cachedInputPerMillion +
      output * price.outputPerMillion) /
    1_000_000
  );
}

/** True for OpenAI reasoning models that accept `reasoning.effort` on the Responses API. */
export function supportsReasoningEffort(model: string): boolean {
  const normalized = normalizeModelId(model);
  return /^(?:gpt-5|gpt-6|o1|o3|o4)(?:$|[.-])/.test(normalized);
}
