import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { renderWorkflow } from "./index";

function gitlabPlan(overrides: Record<string, unknown> = {}) {
  const base = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    cicd: {
      ...base.cicd,
      provider: "gitlab-ci",
      registry: "gitlab-registry",
      workflowPath: undefined,
    },
    ...overrides,
  });
}

describe("GitLab CI pipeline rendering (042)", () => {
  it("renders valid .gitlab-ci.yml with build, deploy, verify, and rollback jobs", () => {
    const plan = gitlabPlan();
    expect(plan.cicd.workflowPath).toBe(".gitlab-ci.yml");

    const file = renderWorkflow(plan, testContext());
    expect(file.path).toBe(".gitlab-ci.yml");

    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;
    expect(parsed.stages).toEqual(["build", "deploy", "verify"]);
    expect(parsed.build).toBeDefined();
    expect(parsed.deploy).toBeDefined();
    expect(parsed.verify).toBeDefined();
    expect(parsed.rollback).toBeDefined();

    // Uses $CI_JOB_TOKEN and $CI_REGISTRY_USER (zero stored registry passwords).
    const buildScript = ((parsed.build?.script as string[] | undefined) ?? []).join("\n");
    expect(buildScript).toContain("$CI_JOB_TOKEN");
    expect(buildScript).toContain("$CI_REGISTRY_USER");
    expect(buildScript).toContain("$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA");

    // Deploy uses resource_group, environment, file-friendly SSH key setup, and kamal-proxy switch.
    expect(parsed.deploy?.resource_group).toBe("opscrew-shop");
    expect(parsed.deploy?.environment).toEqual({
      name: "production",
      url: "https://shop.example.com",
    });
    const deployScript = ((parsed.deploy?.script as string[] | undefined) ?? []).join("\n");
    expect(deployScript).toContain("OPSCREW_DEPLOY_SSH_KEY");
    expect(deployScript).toContain("StrictHostKeyChecking=yes");
    expect(deployScript).toContain("kamal-proxy");
  });

  it("tags jobs for the server's self-hosted GitLab Runner and skips SSH when runner is server", () => {
    const base = testPlan({ domain: "staging.example.com" });
    const plan = gitlabPlan({
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging", runner: "server" },
    });
    expect(plan.cicd.workflowPath).toBe(".gitlab/opscrew-deploy-staging.yml");
    const file = renderWorkflow(plan, testContext());
    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;

    expect(parsed.build?.tags).toEqual(["opscrew-shop-staging"]);
    expect(parsed.deploy?.tags).toEqual(["opscrew-shop-staging"]);
    const deployScript = ((parsed.deploy?.script as string[] | undefined) ?? []).join("\n");
    expect(deployScript).not.toContain("StrictHostKeyChecking");
    expect(deployScript).toContain("/srv/apps/shop-staging");
  });

  it("renders merge-request preview_up and preview_down (on_stop) excluding forks (ADR 0026)", () => {
    const base = testPlan();
    const plan = gitlabPlan({
      app: { ...base.app, name: "shop-preview" },
      dns: { provider: "cloudflare", zone: "example.com", proxied: true },
      environment: {
        name: "preview",
        previews: {
          domain: "preview.example.com",
          lifetimeDays: 7,
        },
      },
    });
    const file = renderWorkflow(plan, testContext());
    const parsed = parse(file.content) as Record<string, Record<string, unknown>>;
    expect(parsed.stages).toEqual(["build", "deploy", "verify", "cleanup"]);
    expect(parsed.preview_up).toBeDefined();
    expect(parsed.preview_down).toBeDefined();

    // Fork guard: source project must equal target project.
    expect(JSON.stringify(parsed.preview_up?.rules)).toContain(
      "$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID",
    );
    expect(parsed.preview_up?.environment).toEqual({
      name: "review/mr-$CI_MERGE_REQUEST_IID",
      on_stop: "preview_down",
      auto_stop_in: "7 days",
    });
    expect(parsed.preview_down?.environment).toEqual({
      name: "review/mr-$CI_MERGE_REQUEST_IID",
      action: "stop",
    });
    const upScript = ((parsed.preview_up?.script as string[] | undefined) ?? []).join("\n");
    expect(upScript).toContain("up $CI_MERGE_REQUEST_IID $PREVIEW_IMAGE $CI_COMMIT_SHA");
    const downScript = ((parsed.preview_down?.script as string[] | undefined) ?? []).join("\n");
    expect(downScript).toContain("down $CI_MERGE_REQUEST_IID");
  });

  it("keeps GitHub Actions workflows completely unchanged", () => {
    const gh = testPlan({ domain: "shop.example.com" });
    expect(gh.cicd.provider).toBe("github-actions");
    expect(gh.cicd.workflowPath).toBe(".github/workflows/opscrew-deploy.yml");
    const file = renderWorkflow(gh, testContext());
    expect(file.path).toBe(".github/workflows/opscrew-deploy.yml");
    expect(file.content).toContain("runs-on:");
  });
});
