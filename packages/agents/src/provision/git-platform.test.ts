import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensurePlatformRunner, removePlatformRunners } from "../runners/platform";
import {
  dispatchPlatformPipeline,
  latestPlatformPipeline,
  retryPlatformPipeline,
} from "../shared/git-platform";
import { repositoryPrivate } from "../shared/github";
import { createTestPhaseDeps } from "../testing";
import {
  deletePlatformDeploySecrets,
  publishPlatformChangeRequest,
  setPlatformDeploySecrets,
  setupGitPlatform,
} from "./git-platform";

function gitRunner(remoteUrl: string) {
  return {
    async run(command: string, args: readonly string[]) {
      if (command.includes("git")) {
        if (args.includes("--is-inside-work-tree")) {
          return { exitCode: 0, stdout: "true\n", stderr: "" };
        }
        if (args.includes("get-url")) {
          return { exitCode: 0, stdout: `${remoteUrl}\n`, stderr: "" };
        }
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    },
  };
}

function gitlabPlan() {
  return DeployPlanSchema.parse({
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
    cicd: { provider: "gitlab-ci", registry: "gitlab-registry", branch: "main" },
    security: {},
  });
}

describe("git-platform agents integration (GitLab end-to-end)", () => {
  it("runs setup, secrets, merge request, runners, and pipelines through GitPlatformClient", async () => {
    const token = fakeSecret("gitlab-token", "agents-gitlab");
    const runnerToken = fakeSecret("gitlab-runner-token", "agents-gitlab-runner");
    const { fetch, calls } = fakeFetch(
      {
        "GET /projects/acme%2Fshop": {
          body: {
            id: 42,
            path_with_namespace: "acme/shop",
            default_branch: "main",
            visibility: "private",
            web_url: "https://gitlab.com/acme/shop",
          },
        },
        "GET /projects/acme%2Fshop/protected_environments": {
          status: 403,
          body: { message: "403 Forbidden" },
        },
        "GET /projects/acme%2Fshop/environments": { body: [] },
        "POST /projects/acme%2Fshop/environments": {
          status: 201,
          body: { id: 1, name: "production" },
        },
        "GET /projects/acme%2Fshop/variables/OPSCREW_HOST": [
          { status: 404, body: { message: "404" } },
          { status: 200, body: { key: "OPSCREW_HOST", value: "x" } },
        ],
        "PUT /projects/acme%2Fshop/variables/OPSCREW_HOST": { status: 404, body: {} },
        "POST /projects/acme%2Fshop/variables": {
          status: 201,
          body: { key: "OPSCREW_HOST", value: "x" },
        },
        "DELETE /projects/acme%2Fshop/variables/OPSCREW_HOST": { status: 204, body: "" },
        "GET /projects/acme%2Fshop/merge_requests": { body: [] },
        "POST /projects/acme%2Fshop/merge_requests": {
          status: 201,
          body: {
            iid: 5,
            web_url: "https://gitlab.com/acme/shop/-/merge_requests/5",
            title: "Add deploy",
            source_branch: "opscrew/deploy-setup",
            target_branch: "main",
          },
        },
        "GET /projects/acme%2Fshop/runners": {
          body: [
            {
              id: 88,
              description: "shop-prod",
              online: true,
              tag_list: ["opscrew-shop-prod"],
            },
          ],
        },
        "POST /user/runners": { status: 201, body: { id: 89, token: runnerToken } },
        "DELETE /runners/88": { status: 204, body: "" },
        "POST /projects/acme%2Fshop/pipeline": {
          status: 201,
          body: {
            id: 700,
            status: "pending",
            web_url: "https://gitlab.com/acme/shop/-/pipelines/700",
            ref: "main",
          },
        },
        "GET /projects/acme%2Fshop/pipelines/700": {
          body: {
            id: 700,
            status: "running",
            web_url: "https://gitlab.com/acme/shop/-/pipelines/700",
            ref: "main",
          },
        },
        "GET /projects/acme%2Fshop/pipelines": {
          body: [
            {
              id: 700,
              status: "success",
              web_url: "https://gitlab.com/acme/shop/-/pipelines/700",
              ref: "main",
            },
          ],
        },
        "POST /projects/acme%2Fshop/pipelines/700/retry": { status: 201, body: {} },
      },
      { base: "https://gitlab.com/api/v4" },
    );

    const deps = await createTestPhaseDeps({
      env: { GITLAB_TOKEN: token },
      runner: gitRunner("git@gitlab.com:acme/shop.git"),
      fetch,
    });
    const plan = gitlabPlan();

    expect(await repositoryPrivate(deps)).toBe(true);

    const setup = await setupGitPlatform(deps, plan);
    expect(setup.platform.id).toBe("gitlab");
    expect(setup.defaultBranch).toBe("main");
    expect(setup.containerImage).toBe("registry.gitlab.com/acme/shop");

    const stored = await setPlatformDeploySecrets(deps, setup, {
      environment: "production",
      secrets: { OPSCREW_HOST: "198.51.100.10" },
    });
    expect(stored.created).toEqual(["OPSCREW_HOST"]);
    expect(stored.updated).toEqual([]);

    const deleted = await deletePlatformDeploySecrets(deps, setup, {
      environment: "production",
      names: ["OPSCREW_HOST"],
    });
    expect(deleted).toEqual(["OPSCREW_HOST"]);

    const published = await publishPlatformChangeRequest(deps, setup, {
      head: "opscrew/deploy-setup",
      base: "main",
      title: "Add deploy",
      body: "Deploy setup",
    });
    expect(published.created).toBe(true);
    expect(published.changeRequest.number).toBe(5);

    const runner = await ensurePlatformRunner(deps, setup, plan);
    expect(runner.existing).toHaveLength(1);
    expect(runner.registration).toEqual({ token: runnerToken, runnerId: 89 });
    expect(await removePlatformRunners(deps, setup, runner.label)).toBe(1);

    const run = await dispatchPlatformPipeline(deps, setup, { ref: "main" });
    expect(run).toMatchObject({ id: 700, status: "running" });
    expect(await latestPlatformPipeline(setup, { ref: "main" })).toMatchObject({
      id: 700,
      status: "success",
    });
    await retryPlatformPipeline(deps, setup, 700);
    expect(calls.some((c) => c.path === "/projects/acme%2Fshop/pipelines/700/retry")).toBe(true);
  });
});
