import { describe, expect, it } from "vitest";
import { definition } from "./index";

describe("@opscrew/edge-provider-cloudflare", () => {
  it("exposes Cloudflare's capabilities, real-IP header, DNS record type, and SecOps texts", () => {
    expect(definition.id).toBe("cloudflare");
    expect(definition.displayName).toBe("Cloudflare");
    expect(definition.capabilities).toEqual({
      originAuth: "cloudflare-aop",
      originIpFiltering: "compact-cidrs",
      realIpHeader: "CF-Connecting-IP",
    });
    expect(definition.terraform.dnsRecordResourceType).toBe("cloudflare_dns_record");
    expect(definition.texts.secops.edgeLabel).toBe("Cloudflare's edge");
  });
});
