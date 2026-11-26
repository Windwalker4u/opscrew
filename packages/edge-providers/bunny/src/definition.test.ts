import { describe, expect, it } from "vitest";
import { definition } from "./definition";
import { BUNNY_EDGE_MODULE_FILES } from "./module";

describe("@opscrew/edge-provider-bunny", () => {
  it("exposes Bunny.net capabilities, shared-header auth, dynamic-ips, and Terraform metadata", () => {
    expect(definition.id).toBe("bunny");
    expect(definition.displayName).toBe("Bunny.net");
    expect(definition.capabilities).toEqual({
      dns: true,
      originAuth: "shared-header",
      originAuthHeader: "X-OpsCrew-Origin-Token",
      originIpFiltering: "dynamic-ips",
      realIpHeader: "X-Real-IP",
    });
    expect(definition.credentials.envVars).toEqual(["BUNNYNET_API_KEY"]);
    expect(definition.terraform.provider).toEqual({
      name: "bunnynet",
      source: "BunnyWay/bunnynet",
      version: "~> 0.20.2",
    });
    expect(definition.terraform.dnsRecordResourceType).toBe("bunnynet_dns_record");
    expect(definition.terraform.module?.name).toBe("bunny-edge");
  });

  it("renders a safe bunny-edge Terraform module with BlockRequest probes, cache off, verified SSL, and no SetRequestHeader secret", () => {
    const main = BUNNY_EDGE_MODULE_FILES["main.tf"] ?? "";
    expect(main).toContain('resource "bunnynet_pullzone" "this"');
    expect(main).toContain("cache_enabled = false");
    expect(main).toContain("verify_ssl          = true");
    expect(main).toContain("forward_host_header = true");
    expect(main).toContain('type       = "BlockRequest"');
    for (const pattern of [
      "*/.env*",
      "*/.git/*",
      "*/wp-admin*",
      "*/wp-login.php*",
      "*/xmlrpc.php*",
      "*/phpmyadmin*",
    ]) {
      expect(main).toContain(pattern);
    }
    expect(main).toContain('type        = "PullZone"');
    // Security invariant (ADR 0038 D6): origin verification header NEVER lives in Terraform state.
    expect(main).not.toContain("SetRequestHeader");
    expect(main).not.toContain("X-OpsCrew-Origin-Token");
  });
});
