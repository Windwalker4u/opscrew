import { describe, expect, it } from "vitest";
import {
  calculateUsageCost,
  OPENAI_PRICING_DATE,
  resolveModelPrice,
  supportsReasoningEffort,
} from "./pricing";

describe("OpenAI pricing", () => {
  it("labels the static fallback table with its date", () => {
    expect(OPENAI_PRICING_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolves exact current models (GPT-6.x, GPT-5.x, Pro tiers), snapshot dates and prefixes without cross-tier bleed", () => {
    expect(resolveModelPrice("gpt-6.2-sol")).toEqual({
      inputPerMillion: 2,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 10,
    });
    expect(resolveModelPrice("gpt-6-luna")).toEqual({
      inputPerMillion: 0.1,
      cachedInputPerMillion: 0.005,
      outputPerMillion: 0.5,
    });
    expect(resolveModelPrice("gpt-6.2-astra")).toEqual({
      inputPerMillion: 8,
      cachedInputPerMillion: 0.4,
      outputPerMillion: 40,
    });
    expect(resolveModelPrice("gpt-5.4")).toEqual({
      inputPerMillion: 2.5,
      cachedInputPerMillion: 0.25,
      outputPerMillion: 15,
    });
    expect(resolveModelPrice("gpt-5-pro-2025-10-06")).toEqual({
      inputPerMillion: 15,
      cachedInputPerMillion: 15,
      outputPerMillion: 120,
    });
    expect(resolveModelPrice("gpt-5-mini-2025-08-07")).toEqual({
      inputPerMillion: 0.25,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 2,
    });
    expect(resolveModelPrice("openai/gpt-4.1-mini")).toEqual({
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 1.6,
    });
    // Unknown variants never silently inherit a cheaper sibling's price
    expect(resolveModelPrice("gpt-5-ultra-future")).toBeUndefined();
    expect(resolveModelPrice("custom/unknown-local-model")).toBeUndefined();
  });

  it("computes uncached input, cached input and output cost accurately", () => {
    // 1,000,000 input tokens of which 200,000 are cached -> 800k uncached + 200k cached
    // gpt-6.2-sol: 0.8 * 2.0 + 0.2 * 0.1 + 0.5 * 10 = 1.6 + 0.02 + 5.0 = 6.62
    const result = calculateUsageCost("gpt-6.2-sol", {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 200_000 },
      output_tokens: 500_000,
    });
    expect(result.priced).toBe(true);
    expect(result.costUsd).toBeCloseTo(6.62, 6);
  });

  it("clamps cached tokens to total input tokens and ignores negative counts", () => {
    const result = calculateUsageCost("gpt-6-luna", {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 5000 },
      output_tokens: -10,
    });
    expect(result.priced).toBe(true);
    expect(result.costUsd).toBeCloseTo((1000 * 0.005) / 1_000_000, 9);
  });

  it("prefers a gateway-supplied usage.cost when finite and non-negative", () => {
    const result = calculateUsageCost("openrouter/custom-model", {
      input_tokens: 1000,
      output_tokens: 500,
      cost: 0.0042,
    });
    expect(result).toEqual({ costUsd: 0.0042, priced: true });
  });

  it("marks unknown models as unpriced so callers can fail closed under maxBudgetUsd", () => {
    expect(
      calculateUsageCost("unknown-model", { input_tokens: 1000, output_tokens: 1000 }),
    ).toEqual({ costUsd: 0, priced: false });
    expect(calculateUsageCost("gpt-6.2-sol", undefined)).toEqual({ costUsd: 0, priced: true });
  });

  it("detects reasoning-capable models and excludes chat-only models", () => {
    expect(supportsReasoningEffort("gpt-6.2-sol")).toBe(true);
    expect(supportsReasoningEffort("gpt-6-luna")).toBe(true);
    expect(supportsReasoningEffort("gpt-5.4")).toBe(true);
    expect(supportsReasoningEffort("openai/o3")).toBe(true);
    expect(supportsReasoningEffort("o4-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-5-chat-latest")).toBe(false);
    expect(supportsReasoningEffort("gpt-5.2-chat-latest")).toBe(false);
    expect(supportsReasoningEffort("gpt-5.3-chat-latest")).toBe(false);
    expect(supportsReasoningEffort("gpt-4.1")).toBe(false);
    expect(supportsReasoningEffort("gpt-4o")).toBe(false);
  });
});
