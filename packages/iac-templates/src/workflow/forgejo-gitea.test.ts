// biome-ignore-all lint/suspicious/noTemplateCurlyInString: asserting Forgejo/Gitea Actions expression syntax.
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderWorkflow } from "./index";

function makePlan(overrides: {
  provider: "forgejo-actions" | "gitea-actions";
  registry: "forgejo-registry" | "gitea-registry";
  host?: string;
  registryHost?: string;
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
    expect(rendered.content).not.toContain("ghcr.io");
    expect(rendered.content).not.toContain("ubuntu-24.04-arm");
    expect(rendered.content).not.toContain("\n    environment:");
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
    expect(rendered.content).toContain("runs-on: opscrew-shop-prod");
    expect(rendered.content).not.toContain("[self-hosted,");
    expect(rendered.content).not.toContain("ghcr.io");
    expect(rendered.content).not.toContain("\n    environment:");
    expect(rendered.content).toMatchSnapshot();
  });
});
