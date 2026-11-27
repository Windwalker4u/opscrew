import { describe, expect, it } from "vitest";
import { definition } from "./definition";
import { BUNNY_EDGE_MODULE_FILES } from "./module";
import { renderBunnyRoot } from "./root";

describe("@opscrew/edge-provider-bunny", () => {
  it("exposes Bunny.net capabilities, shared-header auth, dynamic-ips, and Terraform metadata", () => {
    expect(definition.id).toBe("bunny");
    expect(definition.displayName).toBe("Bunny.net");
    expect(definition.capabilities).toEqual({
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
    expect(definition.terraform.root?.resourceIdOutput).toBe("bunny_pullzone_id");
    expect(typeof definition.secops?.checkPlan).toBe("function");
    expect(typeof definition.connector?.verifyCredentials).toBe("function");
  });

  it("renders a safe bunny-edge Terraform module with tls_enabled, IPv6 bracketing, BlockRequest probes, cache off, verified SSL, and no SetRequestHeader secret", () => {
    const main = BUNNY_EDGE_MODULE_FILES["main.tf"] ?? "";
    expect(main).toContain('resource "bunnynet_pullzone" "this"');
    expect(main).toContain("cache_enabled = false");
    expect(main).toContain("verify_ssl          = true");
    expect(main).toContain("forward_host_header = true");
    expect(main).toContain("tls_enabled = true");
    expect(main).toContain("force_ssl   = true");
    expect(main).toContain('strcontains(var.origin_host, ":")');
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

  it("falls back to ipv6Expr for origin_host via coalesce() so IPv6-only servers work", () => {
    const root = renderBunnyRoot({
      appName: "shop",
      domain: "shop.example.com",
      zone: "example.com",
      www: false,
      proxied: true,
      manageDns: true,
      dnsZoneId: 12345,
      wafCustomRules: true,
      ipv4Expr: "module.server.ipv4_address",
      ipv6Expr: "module.server.ipv6_address",
      hasDomainVar: false,
    });
    expect(root.mainLines.join("\n")).toContain(
      "origin_host      = coalesce(module.server.ipv4_address, module.server.ipv6_address)",
    );
  });
});
