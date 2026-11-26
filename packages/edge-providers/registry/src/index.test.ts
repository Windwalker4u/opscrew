import { OpsCrewError } from "@opscrew/core";
import { FAKE_SECRET_KINDS, type FakeSecretKind, fakeSecret } from "@opscrew/core/testing";
import { definition as cloudflare } from "@opscrew/edge-provider-cloudflare";
import { describe, expect, it } from "vitest";
import {
  DNS_PROVIDERS,
  dnsProvider,
  EDGE_CREDENTIALS,
  EDGE_PROVIDERS,
  edgeProvider,
  validateEdgeProvider,
} from "./index";

describe("the edge provider registry", () => {
  it("lists the built-in definitions in order, as their packages export them", () => {
    expect(EDGE_PROVIDERS).toHaveLength(1);
    expect(EDGE_PROVIDERS[0]).toBe(cloudflare);
    expect(DNS_PROVIDERS).toEqual([cloudflare]);
  });

  it("returns a provider's definition by id for edgeProvider and dnsProvider", () => {
    expect(edgeProvider("cloudflare")).toBe(cloudflare);
    expect(dnsProvider("cloudflare")).toBe(cloudflare);
  });

  it("names each edge provider's credentials for help texts", () => {
    expect(EDGE_CREDENTIALS).toBe("CLOUDFLARE_API_TOKEN for Cloudflare");
  });

  it("refuses unknown edge and DNS provider ids naming the known ones", () => {
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

    let dnsErr: unknown;
    try {
      dnsProvider("fastly");
    } catch (err) {
      dnsErr = err;
    }
    expect(dnsErr).toBeInstanceOf(OpsCrewError);
    expect(dnsErr).toMatchObject({
      code: "INVALID_INPUT",
      message: 'OpsCrew does not manage DNS on "fastly".',
      hint: "Choose one of its DNS providers: cloudflare.",
    });
  });
});

describe.each(EDGE_PROVIDERS.map((provider) => [provider.id, provider] as const))(
  "%s conforms to the edge provider contract (ADR 0038)",
  (_id, provider) => {
    it("passes validation", () => {
      expect(validateEdgeProvider(provider)).toBe(provider);
    });

    it("has plain https sign-up, console, and pricing pages", () => {
      expect(provider.consoleUrl).toMatch(/^https:\/\/[^?#]+$/);
      expect(provider.signupUrl).toMatch(/^https:\/\/[^?#]+$/);
      expect(provider.pricingUrl).toMatch(/^https:\/\/[^?#]+$/);
    });

    it("reports unconfigured without credentials", () => {
      const connector = provider.connector({ env: {} });
      expect(connector.configured).toBe(false);
    });

    it("recognises a sample of every declared token rule", () => {
      for (const rule of provider.credentials.tokenRules) {
        expect(FAKE_SECRET_KINDS, rule.id).toContain(rule.id);
        const token = fakeSecret(rule.id as FakeSecretKind);
        const sample = `${provider.credentials.envVars[0]}=${token}\n`;
        const [match] = sample.matchAll(rule.pattern);
        expect(match?.[rule.group ?? 0], rule.id).toBe(token);
      }
    });
  },
);
