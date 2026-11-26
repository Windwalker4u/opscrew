import { OpsCrewError } from "@opscrew/core";
import { definition as cloudflare } from "@opscrew/edge-provider-cloudflare";
import { describe, expect, it } from "vitest";
import { EDGE_PROVIDERS, edgeProvider, validateEdgeProvider } from "./index";

describe("the edge provider registry", () => {
  it("lists the built-in definitions in order, as their packages export them", () => {
    expect(EDGE_PROVIDERS).toHaveLength(1);
    expect(EDGE_PROVIDERS[0]).toBe(cloudflare);
  });

  it("returns a provider's definition by id for edgeProvider", () => {
    expect(edgeProvider("cloudflare")).toBe(cloudflare);
  });

  it("refuses unknown edge provider ids naming the known ones", () => {
    let edgeErr: unknown;
    try {
      edgeProvider("akamai");
    } catch (err) {
      edgeErr = err;
    }
    expect(edgeErr).toBeInstanceOf(OpsCrewError);
    expect(edgeErr).toMatchObject({
      code: "INVALID_INPUT",
      message: 'OpsCrew does not support edge provider "akamai".',
      hint: "Choose one of its edge providers: cloudflare.",
    });
  });
});

describe.each(EDGE_PROVIDERS.map((provider) => [provider.id, provider] as const))(
  "%s conforms to the edge provider contract (ADR 0038)",
  (_id, provider) => {
    it("passes validation", () => {
      expect(validateEdgeProvider(provider)).toBe(provider);
    });
  },
);
