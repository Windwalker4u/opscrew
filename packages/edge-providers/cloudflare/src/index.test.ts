import { describe, expect, it } from "vitest";
import { definition } from "./index";

describe("@opscrew/edge-provider-cloudflare", () => {
  it("exposes Cloudflare's capabilities, real-IP header, credentials, Terraform metadata, and SecOps texts", () => {
    expect(definition.id).toBe("cloudflare");
    expect(definition.displayName).toBe("Cloudflare");
    expect(definition.capabilities).toEqual({
      dns: true,
      originAuth: "cloudflare-aop",
      originIpFiltering: "compact-cidrs",
      realIpHeader: "CF-Connecting-IP",
    });
    expect(definition.credentials.envVars).toEqual(["CLOUDFLARE_API_TOKEN"]);
    expect(definition.terraform).toEqual({
      provider: {
        name: "cloudflare",
        source: "cloudflare/cloudflare",
        version: "~> 5.27",
      },
      credentialsComment: "Token from the CLOUDFLARE_API_TOKEN environment variable.",
      dnsRecordResourceType: "cloudflare_dns_record",
    });
    expect(definition.texts.secops.edgeLabel).toBe("Cloudflare's edge");
  });
});
