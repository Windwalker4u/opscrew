import { describe, expect, it } from "vitest";
import { DeployPlanSchema } from "./plan";

function basePlan(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "nbg1",
      serverType: "cx23",
      backups: true,
    },
    services: [],
    externalServices: [],
    cost: {
      monthly: { amount: 5, currency: "EUR" },
      breakdown: [{ item: "server", monthly: { amount: 5, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-26T00:00:00.000Z",
    },
    codeChanges: [],
    infra: {},
    dns: { provider: "none", proxied: false },
    cicd: { provider: "github-actions", branch: "main" },
    security: {},
    ...overrides,
  };
}

describe("CI/CD provider and registry validation (042)", () => {
  it("defaults cicd.registry from cicd.provider when omitted", () => {
    const gh = DeployPlanSchema.parse(basePlan());
    expect(gh.cicd.registry).toBe("ghcr");

    const gl = DeployPlanSchema.parse(
      basePlan({ cicd: { provider: "gitlab-ci", branch: "main" } }),
    );
    expect(gl.cicd.registry).toBe("gitlab-registry");
    expect(gl.cicd.workflowPath).toBe(".gitlab-ci.yml");
  });

  it("refuses mismatched cicd.provider and cicd.registry pairs", () => {
    const badGitLab = DeployPlanSchema.safeParse(
      basePlan({ cicd: { provider: "gitlab-ci", registry: "ghcr", branch: "main" } }),
    );
    expect(badGitLab.success).toBe(false);
    expect(badGitLab.error?.issues[0]?.message).toContain(
      'must be "gitlab-registry" when cicd.provider is "gitlab-ci"',
    );

    const badGitHub = DeployPlanSchema.safeParse(
      basePlan({
        cicd: { provider: "github-actions", registry: "gitlab-registry", branch: "main" },
      }),
    );
    expect(badGitHub.success).toBe(false);
    expect(badGitHub.error?.issues[0]?.message).toContain(
      'must be "ghcr" when cicd.provider is "github-actions"',
    );
  });

  it("refuses non-VPS targets with gitlab-ci", () => {
    const cases: Array<Record<string, unknown>> = [
      {
        target: {
          provider: "portainer",
          mode: "portainer-stack",
          environmentId: 1,
          arch: "amd64",
          redeploy: "updater",
          web: { mode: "proxy", port: 8080 },
        },
      },
      {
        target: {
          provider: "github-pages",
          mode: "pages-workflow",
          site: { tool: "none", outputDir: "dist" },
        },
        dns: { provider: "cloudflare", domain: "shop.example.com", proxied: false },
        security: { wafCustomRules: false },
      },
      {
        target: {
          provider: "cloudflare-workers",
          mode: "workers-assets",
          worker: "shop",
          render: "static",
          notFound: "none",
          site: { tool: "none", outputDir: "dist" },
        },
        dns: { provider: "cloudflare", domain: "shop.example.com", proxied: true },
      },
      {
        target: {
          provider: "hosting",
          panel: "cpanel",
          app: "php",
          webRoot: "public",
        },
        dns: { provider: "cloudflare", domain: "shop.example.com", proxied: false },
        security: { wafCustomRules: false },
      },
      {
        target: {
          provider: "localhost",
          mode: "local-compose",
          arch: "amd64",
          ports: { https: 8443, http: 8080 },
          image: "registry",
          edge: "caddy",
        },
      },
    ];
    for (const overrides of cases) {
      // Valid under github-actions, refused specifically by checkCicd under gitlab-ci.
      const gh = DeployPlanSchema.safeParse(basePlan(overrides));
      expect(gh.success, JSON.stringify(gh.error?.issues)).toBe(true);
      const parsed = DeployPlanSchema.safeParse(
        basePlan({
          ...overrides,
          cicd: { provider: "gitlab-ci", registry: "gitlab-registry", branch: "main" },
        }),
      );
      expect(parsed.success).toBe(false);
      expect(
        parsed.error?.issues.some((i) =>
          i.message.includes("supported only for cloud server and own-server targets"),
        ),
      ).toBe(true);
    }
  });
});
