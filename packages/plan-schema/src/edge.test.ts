import { describe, expect, it } from "vitest";
import { activeEdgeProvider, DeployPlanSchema } from "./plan";

function basePlan(dns: Record<string, unknown>, security: Record<string, unknown> = {}) {
  return {
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
    dns,
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security,
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
  };
}

describe("plan-schema DNS host and Bunny.net edge provider rules (036 PR 2)", () => {
  it("accepts Bunny DNS + Bunny edge (implicit) and external DNS + Bunny edge", () => {
    const plan = DeployPlanSchema.parse(
      basePlan({ provider: "bunny", domain: "shop.example.com", proxied: true }),
    );
    expect(plan.dns.provider).toBe("bunny");
    expect(plan.dns.edge).toBeUndefined();
    expect(plan.security.httpAllowedFrom).toBe("edge");
    expect(activeEdgeProvider(plan)).toBe("bunny");

    const extDns = DeployPlanSchema.parse(
      basePlan({ provider: "none", edge: "bunny", domain: "shop.example.com", proxied: true }),
    );
    expect(activeEdgeProvider(extDns)).toBe("bunny");
  });

  it("returns undefined for DNS-only plans and cloudflare for proxied Cloudflare plans", () => {
    const dnsOnly = DeployPlanSchema.parse(
      basePlan({ provider: "bunny", domain: "shop.example.com", proxied: false }),
    );
    expect(activeEdgeProvider(dnsOnly)).toBeUndefined();

    const cf = DeployPlanSchema.parse(
      basePlan({ provider: "cloudflare", domain: "shop.example.com", proxied: true }),
    );
    expect(activeEdgeProvider(cf)).toBe("cloudflare");
  });

  it("refuses dns.edge repeating dns.provider (S5) and dns.edge paired with dns.provider: cloudflare (B2)", () => {
    const duplicate = DeployPlanSchema.safeParse(
      basePlan({
        provider: "bunny",
        edge: "bunny",
        domain: "shop.example.com",
        proxied: true,
      }),
    );
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.issues[0]?.message).toContain('repeats dns.provider ("bunny")');

    const cfPlusBunny = DeployPlanSchema.safeParse(
      basePlan({
        provider: "cloudflare",
        edge: "bunny",
        domain: "shop.example.com",
        proxied: true,
      }),
    );
    expect(cfPlusBunny.success).toBe(false);
    expect(cfPlusBunny.error?.issues[0]?.message).toContain(
      'cannot be combined with dns.provider: "cloudflare"',
    );
  });

  it("refuses dns.edge: cloudflare, dns.edge without proxied: true, and bunny without domain", () => {
    const cfEdge = DeployPlanSchema.safeParse(
      basePlan({
        provider: "cloudflare",
        edge: "cloudflare",
        domain: "shop.example.com",
        proxied: true,
      }),
    );
    expect(cfEdge.success).toBe(false);
    expect(cfEdge.error?.issues[0]?.message).toContain('must not be "cloudflare"');

    const unproxied = DeployPlanSchema.safeParse(
      basePlan({
        provider: "none",
        edge: "bunny",
        domain: "shop.example.com",
        proxied: false,
      }),
    );
    expect(unproxied.success).toBe(false);
    expect(unproxied.error?.issues.map((i) => i.path.join("."))).toContain("dns.edge");

    const noDomain = DeployPlanSchema.safeParse(basePlan({ provider: "bunny", proxied: true }));
    expect(noDomain.success).toBe(false);
    expect(noDomain.error?.issues.map((i) => i.path.join("."))).toContain("dns.domain");
  });
});
