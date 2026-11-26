import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { definition, fetchCloudflareEdgeIpRanges } from "./index";

describe("@opscrew/edge-provider-cloudflare", () => {
  it("exposes Cloudflare's capabilities, real-IP header, and origin auth model", () => {
    expect(definition.id).toBe("cloudflare");
    expect(definition.capabilities).toEqual({
      dns: true,
      edge: true,
      apexCnameFlattening: true,
      originAuth: "cloudflare-aop",
      originIpFiltering: "compact-cidrs",
      realIpHeader: "CF-Connecting-IP",
      cloudflareOnlyFeatures: true,
    });
    expect(definition.credentials.envVars).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(definition.terraform.provider).toEqual({
      name: "cloudflare",
      source: "cloudflare/cloudflare",
      version: "~> 5.0",
    });
  });

  it("reports unconfigured without CLOUDFLARE_API_TOKEN and configured with one", async () => {
    const empty = definition.connector({ env: {} });
    expect(empty.configured).toBe(false);
    expect((await empty.verifyCredentials()).ok).toBe(false);

    const token = fakeSecret("cloudflare-token");
    const redacted: string[] = [];
    const configured = definition.connector({
      env: { CLOUDFLARE_API_TOKEN: token },
      redactor: {
        addLiteral: (v) => redacted.push(v),
        redact: (s) => s,
        redactDeep: <T>(v: T) => v,
      },
      fetch: (async () =>
        new Response(JSON.stringify({ success: true, result: { id: "tok-1", status: "active" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as FetchLike,
    });
    expect(configured.configured).toBe(true);
    expect(redacted).toContain(token);
    expect((await configured.verifyCredentials()).ok).toBe(true);
  });

  it("fetches Cloudflare IPv4 and IPv6 edge ranges from /client/v4/ips", async () => {
    const fetchMock = (async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: {
            ipv4_cidrs: ["173.245.48.0/20", "103.21.244.0/22"],
            ipv6_cidrs: ["2400:cb00::/32"],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as FetchLike;
    await expect(fetchCloudflareEdgeIpRanges(fetchMock)).resolves.toEqual({
      ipv4: ["173.245.48.0/20", "103.21.244.0/22"],
      ipv6: ["2400:cb00::/32"],
    });
  });
});
