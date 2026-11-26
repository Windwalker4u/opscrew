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
          originIpFiltering: "dynamic-ips",
          originAuth: "mtls-client-cert",
        },
      }),
    ).toThrow(/shared-header/);
  });

  it("refuses an invalid realIpHeader name", () => {
    expect(() =>
      validateEdgeProvider({
        ...cloudflare,
        capabilities: {
          ...cloudflare.capabilities,
          realIpHeader: "bad header!",
        },
      }),
    ).toThrow(/HTTP header name/);
  });
});
