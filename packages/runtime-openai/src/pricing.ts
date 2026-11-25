/** Date the static OpenAI list-price table below was verified from developers.openai.com/api/docs/pricing. */
export const OPENAI_PRICING_DATE = "2026-11-25";

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly cachedInputPerMillion: number;
  readonly outputPerMillion: number;
}

/**
 * Standard OpenAI API token list prices in USD per 1,000,000 tokens (dated {@link OPENAI_PRICING_DATE}).
 * Looked up by exact normalized model id (after stripping optional provider prefix and trailing
 * `-YYYY-MM-DD` snapshot date) so higher-tier models such as `gpt-5-pro` never fall through to
 * cheaper siblings.
 */
export const OPENAI_MODEL_PRICES: ReadonlyMap<string, ModelPrice> = new Map<string, ModelPrice>([
  // GPT-6 family (current generation)
  ["gpt-6.2-astra", { inputPerMillion: 8.0, cachedInputPerMillion: 0.4, outputPerMillion: 40.0 }],
  ["gpt-6.2-sol", { inputPerMillion: 2.0, cachedInputPerMillion: 0.1, outputPerMillion: 10.0 }],
  ["gpt-6.1-sol", { inputPerMillion: 2.0, cachedInputPerMillion: 0.1, outputPerMillion: 10.0 }],
  ["gpt-6.1-terra", { inputPerMillion: 1.0, cachedInputPerMillion: 0.05, outputPerMillion: 5.0 }],
  ["gpt-6-astra", { inputPerMillion: 10.0, cachedInputPerMillion: 1.0, outputPerMillion: 50.0 }],
  ["gpt-6-sol", { inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 10.0 }],
  ["gpt-6-luna", { inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 }],
  // GPT-5.x family
  ["gpt-5.6-sol", { inputPerMillion: 4.0, cachedInputPerMillion: 0.4, outputPerMillion: 20.0 }],
  ["gpt-5.6-terra", { inputPerMillion: 2.0, cachedInputPerMillion: 0.2, outputPerMillion: 12.0 }],
  ["gpt-5.6-luna", { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.2 }],
  ["gpt-5.5-pro", { inputPerMillion: 30.0, cachedInputPerMillion: 30.0, outputPerMillion: 180.0 }],
  ["gpt-5.5", { inputPerMillion: 5.0, cachedInputPerMillion: 0.5, outputPerMillion: 30.0 }],
  ["gpt-5.4-pro", { inputPerMillion: 30.0, cachedInputPerMillion: 30.0, outputPerMillion: 180.0 }],
  ["gpt-5.4-mini", { inputPerMillion: 0.75, cachedInputPerMillion: 0.075, outputPerMillion: 4.5 }],
  ["gpt-5.4-nano", { inputPerMillion: 0.2, cachedInputPerMillion: 0.02, outputPerMillion: 1.25 }],
  ["gpt-5.4", { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15.0 }],
  [
    "gpt-5.3-chat-latest",
    { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14.0 },
  ],
  ["gpt-5.2-pro", { inputPerMillion: 21.0, cachedInputPerMillion: 21.0, outputPerMillion: 168.0 }],
  [
    "gpt-5.2-chat-latest",
    { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14.0 },
  ],
  ["gpt-5.2", { inputPerMillion: 1.75, cachedInputPerMillion: 0.175, outputPerMillion: 14.0 }],
  [
    "gpt-5.1-codex-max",
    { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 },
  ],
  [
    "gpt-5.1-codex",
    { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 },
  ],
  ["gpt-5.1-mini", { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0 }],
  [
    "gpt-5.1-chat-latest",
    { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 },
  ],
  ["gpt-5.1", { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 }],
  ["gpt-5-pro", { inputPerMillion: 15.0, cachedInputPerMillion: 15.0, outputPerMillion: 120.0 }],
  ["gpt-5-codex", { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 }],
  [
    "gpt-5-chat-latest",
    { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 },
  ],
  ["gpt-5-mini", { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0 }],
  ["gpt-5-nano", { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 }],
  ["gpt-5", { inputPerMillion: 1.25, cachedInputPerMillion: 0.125, outputPerMillion: 10.0 }],
  // GPT-4.1 / GPT-4o / o-series
  ["gpt-4.1-mini", { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 }],
  ["gpt-4.1-nano", { inputPerMillion: 0.1, cachedInputPerMillion: 0.025, outputPerMillion: 0.4 }],
  ["gpt-4.1", { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 }],
  ["gpt-4o-mini", { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 }],
  ["gpt-4o", { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10.0 }],
  ["o4-mini", { inputPerMillion: 1.1, cachedInputPerMillion: 0.275, outputPerMillion: 4.4 }],
  ["o3-pro", { inputPerMillion: 20.0, cachedInputPerMillion: 20.0, outputPerMillion: 80.0 }],
  ["o3-mini", { inputPerMillion: 1.1, cachedInputPerMillion: 0.55, outputPerMillion: 4.4 }],
  ["o3", { inputPerMillion: 2.0, cachedInputPerMillion: 0.5, outputPerMillion: 8.0 }],
  ["o1-pro", { inputPerMillion: 150.0, cachedInputPerMillion: 150.0, outputPerMillion: 600.0 }],
  ["o1-mini", { inputPerMillion: 1.1, cachedInputPerMillion: 0.55, outputPerMillion: 4.4 }],
  ["o1", { inputPerMillion: 15.0, cachedInputPerMillion: 7.5, outputPerMillion: 60.0 }],
]);

export interface UsageLike {
  readonly input_tokens?: number | null;
  readonly output_tokens?: number | null;
  readonly input_tokens_details?: { readonly cached_tokens?: number | null } | null;
  /** Optional direct USD cost reported by compatible gateways such as OpenRouter. */
  readonly cost?: number | null;
}

export interface UsageCostResult {
  readonly costUsd: number;
  /** True when the turn was priced from gateway `usage.cost` or the dated list-price table. */
  readonly priced: boolean;
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
  return OPENAI_MODEL_PRICES.get(normalizeModelId(model));
}

/**
 * Computes USD cost for one Responses API turn from `usage`. Prefers a finite non-negative
 * `usage.cost` when supplied by a gateway; otherwise uses the dated OpenAI list-price table.
 * Returns `priced: false` when neither is available so callers can fail closed under `maxBudgetUsd`.
 */
export function calculateUsageCost(
  model: string,
  usage: UsageLike | undefined | null,
  lookupPrice: (model: string) => ModelPrice | undefined = resolveModelPrice,
): UsageCostResult {
  if (usage !== undefined && usage !== null) {
    if (typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0) {
      return { costUsd: usage.cost, priced: true };
    }
  }
  const price = lookupPrice(model);
  if (price === undefined) return { costUsd: 0, priced: false };
  if (usage === undefined || usage === null) return { costUsd: 0, priced: true };
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
  return {
    costUsd:
      (uncachedInput * price.inputPerMillion +
        cachedInput * price.cachedInputPerMillion +
        output * price.outputPerMillion) /
      1_000_000,
    priced: true,
  };
}

/**
 * True for OpenAI reasoning models that accept `reasoning.effort` and
 * `include: ["reasoning.encrypted_content"]` on the Responses API. Chat-only snapshots
 * (`*-chat-latest`, `*-chat`) reject `reasoning` and return `false`.
 */
export function supportsReasoningEffort(model: string): boolean {
  const normalized = normalizeModelId(model);
  if (normalized.includes("-chat")) return false;
  return /^(?:gpt-5|gpt-6|o1|o3|o4)(?:$|[.-])/.test(normalized);
}
