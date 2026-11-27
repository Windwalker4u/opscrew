import { describe, expect, it } from "vitest";
import { definition } from "./definition";
import { GCORE_EDGE_MODULE_FILES } from "./module";
import { renderGcoreRoot } from "./root";

describe("@opscrew/edge-provider-gcore", () => {
  it("exposes Gcore capabilities, shared-header auth, dynamic-ips, X-Forwarded-For, and Terraform metadata", () => {
    expect(definition.id).toBe("gcore");
    expect(definition.displayName).toBe("Gcore");
    expect(definition.capabilities).toEqual({
      originAuth: "shared-header",
      originAuthHeader: "X-OpsCrew-Origin-Token",
      originIpFiltering: "dynamic-ips",
      realIpHeader: "X-Forwarded-For",
    });
    expect(definition.credentials.envVars).toEqual(["GCORE_PERMANENT_API_TOKEN"]);
    expect(definition.terraform.provider).toEqual({
      name: "gcore",
      source: "G-Core/gcore",
      version: "~> 0.37.2",
    });
    expect(definition.terraform.dnsRecordResourceType).toBe("gcore_dns_zone_record");
    expect(definition.terraform.module?.name).toBe("gcore-edge");
    expect(definition.terraform.root?.resourceIdOutput).toBe("gcore_cdn_resource_id");
    expect(typeof definition.secops?.checkPlan).toBe("function");
    expect(typeof definition.connector?.verifyCredentials).toBe("function");
    expect(typeof definition.connector?.lookupDnsZone).toBe("function");
  });

  it("renders a safe gcore-edge Terraform module with automated LE SSL, gcore_cdn_client CNAME target, force_return 403 probes, cache off, HTTPS origin, and no static_request_headers", () => {
    const main = GCORE_EDGE_MODULE_FILES["main.tf"] ?? "";
    expect(main).toContain('data "gcore_cdn_client" "this"');
    expect(main).toContain('resource "gcore_cdn_origingroup" "this"');
    expect(main).toContain('resource "gcore_cdn_sslcert" "this"');
    expect(main).toContain("automated = true");
    expect(main).toContain('resource "gcore_cdn_resource" "this"');
    expect(main).toContain('origin_protocol     = "HTTPS"');
    expect(main).toContain("ssl_enabled         = true");
    expect(main).toContain("ssl_data            = gcore_cdn_sslcert.this[0].id");
    expect(main).toContain("edge_cache_settings {\n      enabled = false");
    expect(main).toContain("ignore_query_string {\n      enabled = true\n      value   = false");
    expect(main).toContain("redirect_http_to_https {\n      enabled = true\n      value   = true");
    expect(main).toContain('resource "gcore_cdn_rule" "block_probes"');
    expect(main).toContain("force_return {");
    expect(main).toContain("code    = 403");
    expect(main).toContain(`content = "\${data.gcore_cdn_client.this[0].cname}."`);
    expect(main).not.toContain(`content = "\${gcore_cdn_resource.this[0].cname}."`);
    for (const part of ["\\.env", "\\.git/", "wp-admin", "wp-login", "xmlrpc", "phpmyadmin"]) {
      expect(main).toContain(part);
    }
    // Security invariant (ADR 0038 D6): origin verification header NEVER lives in Terraform state,
    // and lifecycle.ignore_changes prevents later applies from wiping the API-managed header.
    expect(main).toContain("ignore_changes = [options[0].static_request_headers]");
    expect(main).not.toMatch(/static_request_headers\s*\{/);
    expect(main).not.toContain("X-OpsCrew-Origin-Token");
  });

  it("falls back to ipv6Expr for origin_host via coalesce() so IPv6-only servers work", () => {
    const root = renderGcoreRoot({
      appName: "shop",
      domain: "shop.example.com",
      zone: "example.com",
      www: false,
      proxied: true,
      manageDns: true,
      wafCustomRules: true,
      ipv4Expr: "module.server.ipv4_address",
      ipv6Expr: "module.server.ipv6_address",
      hasDomainVar: false,
    });
    expect(root.mainLines.join("\n")).toContain(
      "origin_host       = coalesce(module.server.ipv4_address, module.server.ipv6_address)",
    );
  });
});
