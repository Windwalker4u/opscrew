// biome-ignore-all lint/suspicious/noTemplateCurlyInString: asserting Forgejo/Gitea Actions expression syntax.
import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { deploySecretNamesFor, FORGE_REGISTRY_TOKEN_SECRET, renderWorkflow } from "./index";

function makePlan(overrides: {
  provider: "forgejo-actions" | "gitea-actions";
  registry: "forgejo-registry" | "gitea-registry";
  host?: string;
  registryHost?: string;
  branch?: string;
  runner?: "github" | "server";
  arch?: "amd64" | "arm64";
}) {
  const base = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    target: {
      ...base.target,
      ...(overrides.arch === "arm64" ? { serverType: "cax11" } : {}),
    },
    cicd: {
      ...base.cicd,
      provider: overrides.provider,
      registry: overrides.registry,
      workflowPath: undefined,
      ...(overrides.branch ? { branch: overrides.branch } : {}),
      ...(overrides.host ? { host: overrides.host } : {}),
      ...(overrides.registryHost ? { registryHost: overrides.registryHost } : {}),
    },
    ...(overrides.runner
      ? {
          environment: {
            runner: overrides.runner,
          },
        }
      : {}),
  });
}

describe("Forgejo and Gitea Actions workflows (Feature 043)", () => {
  it("renders a Forgejo Actions workflow at .forgejo/workflows/ targeting Codeberg's OCI registry", () => {
    const plan = makePlan({
      provider: "forgejo-actions",
      registry: "forgejo-registry",
      arch: "arm64",
    });
    const rendered = renderWorkflow(plan, testContext());
    expect(rendered.path).toBe(".forgejo/workflows/opscrew-deploy.yml");
    expect(rendered.content).toContain("registry: codeberg.org");
    expect(rendered.content).toContain("Forgejo Container Registry");
    expect(rendered.content).toContain(
      "password: ${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}",
    );
    expect(rendered.content).toContain(
      "REGISTRY_TOKEN: ${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}",
    );
    expect(rendered.content).toContain("identity=https://codeberg.org/$GITHUB_REPOSITORY/");
    expect(rendered.content).not.toContain("https://github.com/$GITHUB_REPOSITORY");
    expect(rendered.content).not.toContain("ghcr.io");
    expect(rendered.content).not.toContain("ubuntu-24.04-arm");
    expect(rendered.content).not.toContain("\n    environment:");
    expect(deploySecretNamesFor(plan)).toContain(FORGE_REGISTRY_TOKEN_SECRET);
    expect(deploySecretNamesFor(testPlan({ domain: "shop.example.com" }))).not.toContain(
      FORGE_REGISTRY_TOKEN_SECRET,
    );
    expect(rendered.content).toMatchSnapshot();
  });

  it("renders a Gitea Actions workflow at .gitea/workflows/ for a self-hosted host and server runner", () => {
    const plan = makePlan({
      provider: "gitea-actions",
      registry: "gitea-registry",
      host: "gitea.example.internal",
      runner: "server",
    });
    const rendered = renderWorkflow(plan, testContext());
    expect(rendered.path).toBe(".gitea/workflows/opscrew-deploy.yml");
    expect(rendered.content).toContain("registry: gitea.example.internal");
    expect(rendered.content).toContain("Gitea Container Registry");
    expect(rendered.content).toContain(
      "REGISTRY_TOKEN: ${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}",
    );
    expect(rendered.content).toContain(
      "identity=https://gitea.example.internal/$GITHUB_REPOSITORY/",
    );
    expect(rendered.content).toContain("runs-on: opscrew-shop-prod");
    expect(rendered.content).not.toContain("[self-hosted,");
    expect(rendered.content).not.toContain("ghcr.io");
    expect(rendered.content).not.toContain("\n    environment:");
    expect(deploySecretNamesFor(plan)).toContain(FORGE_REGISTRY_TOKEN_SECRET);
    expect(rendered.content).toMatchSnapshot();
  });

  it("preserves a non-main cicd.branch when plan.environment is absent", () => {
    const plan = makePlan({
      provider: "forgejo-actions",
      registry: "forgejo-registry",
      branch: "production",
    });
    const rendered = renderWorkflow(plan, testContext());
    expect(rendered.content).toContain('branches: ["production"]');
    expect(rendered.content).toContain("github.ref == 'refs/heads/production'");
    expect(rendered.content).toContain('BUILD_BRANCH: "production"');
    expect(rendered.content).not.toContain("\n    environment:");
  });

  it("refuses non-VPS targets in renderWorkflow for forgejo-actions and gitea-actions", () => {
    const pagesPlan = DeployPlanSchema.parse({
      ...testPlan({ domain: "shop.example.com" }),
      services: [],
      target: {
        provider: "github-pages",
        mode: "pages-workflow",
        site: { tool: "none", outputDir: "dist" },
      },
      dns: { provider: "cloudflare", domain: "shop.example.com", proxied: false },
      security: { wafCustomRules: false },
    });
    const forcedForgejo = {
      ...pagesPlan,
      cicd: { ...pagesPlan.cicd, provider: "forgejo-actions" as const },
    };
    expect(() => renderWorkflow(forcedForgejo, testContext())).toThrow(OpsCrewError);
  });
});
