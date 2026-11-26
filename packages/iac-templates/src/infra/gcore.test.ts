import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { renderInfra } from "./index";

function baseCtx() {
  return {
    opscrewVersion: "0.2.12",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@opscrew",
    cloudflareRanges: ["173.245.48.0/20"],
  };
}

function makeGcorePlan(opts: {
  dnsProvider?: "gcore" | "none";
  edge?: "gcore" | undefined;
  domain?: string;
  zone?: string;
  proxied?: boolean;
  www?: boolean;
}) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "fsn1",
      serverType: "cx23",
      backups: true,
    },
    dns: {
      provider: opts.dnsProvider ?? "gcore",
      ...(opts.edge === undefined ? {} : { edge: opts.edge }),
      domain: opts.domain ?? "app.example.com",
      zone: opts.zone ?? "example.com",
      proxied: opts.proxied ?? true,
      www: opts.www ?? true,
    },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: { httpAllowedFrom: "edge", wafCustomRules: true },
    services: [],
    externalServices: [],
    codeChanges: [],
    cost: {
      monthly: { amount: 4.5, currency: "EUR" },
      breakdown: [{ item: "Hetzner cx23", monthly: { amount: 4.5, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-26T00:00:00.000Z",
    },
  });
}

describe("Gcore infrastructure rendering (036 PR 3)", () => {
  it("renders gcore provider, gcore-edge vendored module, open dynamic-ips firewall, and zero static_request_headers", () => {
    const files = renderInfra(makeGcorePlan({ dnsProvider: "gcore" }), baseCtx());
    const byPath = (suffix: string) => files.find((f) => f.path.endsWith(suffix))?.content ?? "";

    const versions = byPath("/versions.tf");
    expect(versions).toContain('source  = "G-Core/gcore"');
    expect(versions).toContain('version = "~> 0.37.2"');
    expect(versions).not.toContain("cloudflare/cloudflare");

    const main = byPath("/main.tf");
    expect(main).toContain('provider "gcore" {}');
    expect(main).toContain('module "edge"');
    expect(main).toContain('source = "../modules/gcore-edge"');
    expect(main).toContain("manage_dns");
    expect(main).toContain("= true");

    const outputs = byPath("/outputs.tf");
    expect(outputs).toContain('output "gcore_cdn_resource_id"');
    expect(outputs).toContain("value = module.edge.url");

    const tfvars = JSON.parse(byPath("/terraform.tfvars.json")) as Record<string, unknown>;
    expect(tfvars.gcore_dns_zone).toBe("example.com");
    expect(tfvars.gcore_origin_group_name).toBe("opscrew-shop");
    expect(tfvars.gcore_waf_custom_rules).toBe(true);
    expect(tfvars.http_allowed_cidrs).toEqual(["0.0.0.0/0", "::/0"]);

    const moduleMain = byPath("modules/gcore-edge/main.tf");
    expect(moduleMain).toContain('resource "gcore_cdn_resource" "this"');
    expect(moduleMain).toContain('resource "gcore_cdn_resource_rule" "block_probes"');
    expect(moduleMain).toContain("force_return {");
    expect(moduleMain).not.toContain("static_request_headers");
    expect(moduleMain).not.toContain("X-OpsCrew-Origin-Token");
  });

  it("supports external DNS + Gcore edge (dns.provider: none, dns.edge: gcore) with manage_dns = false", () => {
    const files = renderInfra(
      makeGcorePlan({ dnsProvider: "none", edge: "gcore", domain: "example.com" }),
      baseCtx(),
    );
    const byPath = (suffix: string) => files.find((f) => f.path.endsWith(suffix))?.content ?? "";

    expect(byPath("/versions.tf")).not.toContain("cloudflare/cloudflare");
    expect(byPath("/versions.tf")).toContain("G-Core/gcore");
    expect(byPath("/main.tf")).toContain('module "edge"');
    expect(byPath("/main.tf")).toContain("manage_dns");
    expect(byPath("/main.tf")).toContain("= false");

    const tfvars = JSON.parse(byPath("/terraform.tfvars.json")) as Record<string, unknown>;
    expect(tfvars.gcore_proxied).toBe(true);
    expect(tfvars.gcore_dns_zone).toBeUndefined();
    expect(tfvars.http_allowed_cidrs).toEqual(["0.0.0.0/0", "::/0"]);
  });
});
