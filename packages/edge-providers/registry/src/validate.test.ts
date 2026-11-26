import { OpsCrewError } from "@opscrew/core";
import { definition as cloudflare } from "@opscrew/edge-provider-cloudflare";
import { describe, expect, it } from "vitest";
import { validateEdgeProvider } from "./validate";

describe("validateEdgeProvider", () => {
  it("accepts a valid built-in edge provider definition", () => {
    expect(validateEdgeProvider(cloudflare)).toBe(cloudflare);
  });

  it("refuses a wrong contract version", () => {
    expect(() => validateEdgeProvider({ ...cloudflare, contractVersion: 99 })).toThrow(
      OpsCrewError,
    );
  });

  it("refuses dynamic-ips paired with non-shared-header originAuth", () => {
    expect(() =>
      validateEdgeProvider({
        ...cloudflare,
        id: "bunny",
        capabilities: {
          ...cloudflare.capabilities,
          cloudflareOnlyFeatures: false,
          originIpFiltering: "dynamic-ips",
          originAuth: "mtls-client-cert",
        },
      }),
    ).toThrow(/shared-header/);
  });

  it("refuses dnsModuleName when capabilities.dns is false", () => {
    expect(() =>
      validateEdgeProvider({
        ...cloudflare,
        id: "fastly",
        capabilities: {
          ...cloudflare.capabilities,
          dns: false,
          cloudflareOnlyFeatures: false,
        },
      }),
    ).toThrow(/dnsModuleName/);
  });

  it("refuses cloudflareOnlyFeatures on non-cloudflare providers", () => {
    expect(() =>
      validateEdgeProvider({
        ...cloudflare,
        id: "gcore",
      }),
    ).toThrow(/cloudflareOnlyFeatures|only on the "cloudflare" definition/);
  });
});
