import { describe, expect, it } from "vitest";
import {
  calculateUsageCostUsd,
  OPENAI_PRICING_DATE,
  resolveModelPrice,
  supportsReasoningEffort,
} from "./pricing";

describe("OpenAI pricing", () => {
  it("labels the static fallback table with its date", () => {
    expect(OPENAI_PRICING_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("resolves canonical models, snapshot dates and provider prefixes", () => {
    expect(resolveModelPrice("gpt-5")).toEqual({
      inputPerMillion: 1.25,
      cachedInputPerMillion: 0.125,
      outputPerMillion: 10,
    });
    expect(resolveModelPrice("gpt-5-mini-2026-03-01")).toEqual({
      inputPerMillion: 0.25,
      cachedInputPerMillion: 0.025,
      outputPerMillion: 2,
    });
    expect(resolveModelPrice("openai/gpt-4.1-mini")).toEqual({
      inputPerMillion: 0.4,
      cachedInputPerMillion: 0.1,
      outputPerMillion: 1.6,
    });
    expect(resolveModelPrice("custom/unknown-local-model")).toBeUndefined();
  });

  it("computes uncached input, cached input and output cost accurately", () => {
    // 1,000,000 input tokens of which 200,000 are cached -> 800k uncached + 200k cached
    // gpt-5: 0.8 * 1.25 + 0.2 * 0.125 + 0.5 * 10 = 1.0 + 0.025 + 5.0 = 6.025
    const cost = calculateUsageCostUsd("gpt-5", {
      input_tokens: 1_000_000,
      input_tokens_details: { cached_tokens: 200_000 },
      output_tokens: 500_000,
    });
    expect(cost).toBeCloseTo(6.025, 6);
  });

  it("clamps cached tokens to total input tokens and ignores negative counts", () => {
    const cost = calculateUsageCostUsd("gpt-5-mini", {
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 5000 },
      output_tokens: -10,
    });
    expect(cost).toBeCloseTo((1000 * 0.025) / 1_000_000, 9);
  });

  it("prefers a gateway-supplied usage.cost when finite and non-negative", () => {
    const cost = calculateUsageCostUsd("openrouter/custom-model", {
      input_tokens: 1000,
      output_tokens: 500,
      cost: 0.0042,
    });
    expect(cost).toBeCloseTo(0.0042, 6);
  });

  it("returns 0 for unknown models or missing usage", () => {
    expect(
      calculateUsageCostUsd("unknown-model", { input_tokens: 1000, output_tokens: 1000 }),
    ).toBe(0);
    expect(calculateUsageCostUsd("gpt-5", undefined)).toBe(0);
  });

  it("detects reasoning-capable models for reasoning.effort", () => {
    expect(supportsReasoningEffort("gpt-5")).toBe(true);
    expect(supportsReasoningEffort("gpt-5-mini")).toBe(true);
    expect(supportsReasoningEffort("openai/o3")).toBe(true);
    expect(supportsReasoningEffort("o4-mini")).toBe(true);
    expect(supportsReasoningEffort("gpt-4.1")).toBe(false);
    expect(supportsReasoningEffort("gpt-4o")).toBe(false);
  });
});
