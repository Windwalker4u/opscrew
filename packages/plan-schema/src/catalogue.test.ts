import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ProviderCatalogueSchema, SignupUrlSchema } from "./catalogue";
import { catalogueJsonSchema } from "./json-schema";

/** A catalogue with one provider of each kind. */
const credentials = {
  mode: "any",
  variables: [{ name: "EXAMPLE_TOKEN", label: "Example API token", secret: true }],
  createUrl: "https://example.com/tokens",
  steps: ["Create a token at https://example.com/tokens and set EXAMPLE_TOKEN."],
};
const entry = {
  name: "Example",
  consoleUrl: "https://example.com/",
  signupUrl: "https://example.com/signup",
  credentials,
  guideUrl: "https://docs.opscrew.dev/example/",
};
const asOf = "2026-11-11T00:00:00.000Z";
const catalogue = {
  catalogueVersion: 1,
  opscrewVersion: "1.2.3",
  providers: [
    {
      kind: "cloud-server",
      id: "example",
      ...entry,
      currency: "EUR",
      billing: { model: "monthly", setupFee: false },
      locations: [{ id: "eu1", name: "Frankfurt", region: "eu-central" }],
      sizes: [{ id: "small", vcpu: 2, memoryMb: 4096, diskGb: 40, monthly: 5, locations: ["eu1"] }],
      priceSource: { kind: "static", asOf },
    },
    { kind: "cloudflare", id: "cloudflare", ...entry },
    { kind: "registrar", id: "porkbun", ...entry },
  ],
  suggestions: {
    serverWithDatabase: [{ provider: "example", size: "small", location: "eu1" }],
    staticSite: {
      target: "cloudflare-workers",
      provider: "cloudflare",
      monthly: { amount: 0, currency: "USD" },
      priceSource: { kind: "static", asOf },
    },
  },
};

describe("ProviderCatalogueSchema", () => {
  it("accepts a catalogue with a provider of each kind", () => {
    expect(ProviderCatalogueSchema.parse(catalogue)).toEqual(catalogue);
  });

  it("refuses another version, a price read live and a registrar OpsCrew does not know", () => {
    expect(ProviderCatalogueSchema.safeParse({ ...catalogue, catalogueVersion: 2 }).success).toBe(
      false,
    );
    const [cloud, cloudflare] = catalogue.providers;
    const live = { ...cloud, priceSource: { kind: "live", asOf } };
    expect(ProviderCatalogueSchema.safeParse({ ...catalogue, providers: [live] }).success).toBe(
      false,
    );
    const unknown = { ...cloudflare, kind: "registrar", id: "linode" };
    expect(ProviderCatalogueSchema.safeParse({ ...catalogue, providers: [unknown] }).success).toBe(
      false,
    );
  });

  it("wants a plain https sign-up page, never one with a referral or affiliate id", () => {
    expect(SignupUrlSchema.safeParse("https://example.com/signup").success).toBe(true);
    for (const url of [
      "http://example.com/signup",
      "https://example.com/signup?ref=abc",
      "https://example.com/signup?aff=1",
      "https://example.com/signup#ref=abc",
    ]) {
      expect(SignupUrlSchema.safeParse(url).success, url).toBe(false);
    }
  });

  // The committed file is Biome-formatted (the generator runs `biome format`), so compare the
  // parsed content.
  it("schemas/provider-catalogue.schema.json matches the zod schema (regenerate with `pnpm --filter @opscrew/plan-schema gen:schemas`)", async () => {
    const committed = await readFile(
      new URL("../schemas/provider-catalogue.schema.json", import.meta.url),
      "utf8",
    );
    expect(JSON.parse(committed)).toEqual(catalogueJsonSchema());
  });
});
