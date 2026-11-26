import { describe, expect, it } from "vitest";
import { definition } from "./definition";
import { FASTLY_EDGE_MODULE_FILES } from "./module";
import { renderFastlyRoot } from "./root";

describe("@opscrew/edge-provider-fastly", () => {
  it("exposes Fastly edge-only capabilities, mTLS client cert auth, compact-cidrs, Fastly-Client-IP, and Terraform metadata", () => {
    expect(definition.id).toBe("fastly");
    expect(definition.displayName).toBe("Fastly");
    expect(definition.capabilities).toEqual({
      originAuth: "mtls-client-cert",
      originIpFiltering: "compact-cidrs",
      realIpHeader: "Fastly-Client-IP",
    });
    expect(definition.credentials.envVars).toEqual(["FASTLY_API_KEY"]);
    expect(definition.terraform.provider).toEqual({
      name: "fastly",
      source: "fastly/fastly",
      version: "~> 10.4",
    });
    expect(definition.terraform.dnsRecordResourceType).toBeUndefined();
    expect(definition.terraform.module?.name).toBe("fastly-edge");
    expect(definition.terraform.root?.resourceIdOutput).toBe("fastly_service_id");
    expect(typeof definition.secops?.checkPlan).toBe("function");
    expect(typeof definition.connector?.verifyCredentials).toBe("function");
    expect(typeof definition.connector?.getIpRanges).toBe("function");
  });

  it("renders a safe fastly-edge Terraform module with dynamic pass, free VCL 403 probe blocking, managed TLS, and no ssl_client_key", () => {
    const main = FASTLY_EDGE_MODULE_FILES["main.tf"] ?? "";
    expect(main).toContain('resource "fastly_service_vcl" "this"');
    expect(main).toContain('action    = "pass"');
    expect(main).toContain("force_ssl = true");
    expect(main).toContain("use_ssl           = true");
    expect(main).toContain("ssl_check_cert    = true");
    expect(main).toContain('dynamic "condition"');
    expect(main).toContain('dynamic "response_object"');
    expect(main).toContain("status            = 403");
    for (const part of ["\\.env", "\\.git/", "wp-admin", "wp-login", "xmlrpc", "phpmyadmin"]) {
      expect(main).toContain(part);
    }
    expect(main).toContain('resource "fastly_tls_subscription" "this"');
    // Security invariant (ADR 0038 D6): mTLS private key NEVER enters Terraform state.
    expect(main).not.toContain("ssl_client_key");
  });

  it("falls back to ipv6Expr for origin_host via coalesce() so IPv6-only servers work", () => {
    const root = renderFastlyRoot({
      appName: "shop",
      domain: "shop.example.com",
      zone: "example.com",
      www: false,
      proxied: true,
      manageDns: false,
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
