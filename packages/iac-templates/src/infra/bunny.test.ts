import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { renderInfra } from "./index";

function baseCtx() {
  return {
    opscrewVersion: "0.2.12",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey test@opscrew",
    cloudflareRanges: ["173.245.48.0/20"],
    edge: { dnsZoneId: 12345 },
  };
}

function makeBunnyPlan(opts: {
  dnsProvider?: "bunny" | "none";
  edge?: "bunny" | undefined;
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
      provider: opts.dnsProvider ?? "bunny",
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

describe("Bunny.net infrastructure rendering (036 PR 2)", () => {
  it("renders bunnynet provider, bunny-edge vendored module, open dynamic-ips firewall, and zero SetRequestHeader secrets", () => {
    const files = renderInfra(makeBunnyPlan({ dnsProvider: "bunny" }), baseCtx());
    const byPath = (suffix: string) => files.find((f) => f.path.endsWith(suffix))?.content ?? "";

    const versions = byPath("/versions.tf");
    expect(versions).toContain('source  = "BunnyWay/bunnynet"');
    expect(versions).toContain('version = "~> 0.20.2"');
    expect(versions).not.toContain("cloudflare/cloudflare");

    const main = byPath("/main.tf");
    expect(main).toContain('provider "bunnynet" {}');
    expect(main).toContain('module "edge"');
    expect(main).toContain('source = "../modules/bunny-edge"');
    expect(main).toContain("manage_dns");
    expect(main).toContain("= true");

    const outputs = byPath("/outputs.tf");
    expect(outputs).toContain('output "bunny_pullzone_id"');
    expect(outputs).toContain('output "bunny_pullzone_hostname"');
    expect(outputs).toContain("value = module.edge.url");

    const tfvars = JSON.parse(byPath("/terraform.tfvars.json")) as Record<string, unknown>;
    expect(tfvars.bunny_dns_zone_id).toBe(12345);
    expect(tfvars.bunny_record_name).toBe("app");
    expect(tfvars.bunny_www_record_name).toBe("www.app");
    expect(tfvars.bunny_pullzone_name).toBe("opscrew-shop");
    expect(tfvars.bunny_waf_custom_rules).toBe(true);
    // dynamic-ips: cloud firewall leaves ports 80/443 open so the shared header is the gate.
    expect(tfvars.http_allowed_cidrs).toEqual(["0.0.0.0/0", "::/0"]);

    // Vendored bunny-edge module is emitted beside infra/ and holds no origin-token secret.
    const moduleMain = byPath("modules/bunny-edge/main.tf");
    expect(moduleMain).toContain('resource "bunnynet_pullzone" "this"');
    expect(moduleMain).toContain("tls_enabled = true");
    expect(moduleMain).toContain('type       = "BlockRequest"');
    expect(moduleMain).not.toContain("SetRequestHeader");
    expect(moduleMain).not.toContain("X-OpsCrew-Origin-Token");
  });

  it("refuses rendering Bunny DNS without a looked-up dnsZoneId (never renders 0)", () => {
    const ctx = baseCtx();
    ctx.edge = undefined as unknown as { dnsZoneId: number };
    expect(() => renderInfra(makeBunnyPlan({ dnsProvider: "bunny" }), ctx)).toThrow(
      /Bunny DNS zone id/,
    );
  });

  it("supports external DNS + Bunny.net edge (dns.provider: none, dns.edge: bunny) with manage_dns = false", () => {
    const files = renderInfra(
      makeBunnyPlan({ dnsProvider: "none", edge: "bunny", domain: "example.com" }),
      { ...baseCtx(), edge: undefined },
    );
    const byPath = (suffix: string) => files.find((f) => f.path.endsWith(suffix))?.content ?? "";

    const versions = byPath("/versions.tf");
    expect(versions).not.toContain("cloudflare/cloudflare");
    expect(versions).toContain("BunnyWay/bunnynet");

    const main = byPath("/main.tf");
    expect(main).toContain('module "edge"');
    expect(main).toContain("manage_dns");
    expect(main).toContain("= false");

    const tfvars = JSON.parse(byPath("/terraform.tfvars.json")) as Record<string, unknown>;
    expect(tfvars.bunny_proxied).toBe(true);
    expect(tfvars.bunny_dns_zone_id).toBeUndefined();
    expect(tfvars.http_allowed_cidrs).toEqual(["0.0.0.0/0", "::/0"]);
  });
});
