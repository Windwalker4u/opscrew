import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable, type OpsCrewError } from "@opscrew/core";
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { repositoryPrivate } from "../shared/github";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { noOtherApps } from "../testing/other-apps";
import {
  publishPlatformChangeRequest,
  setPlatformDeploySecrets,
  setupGitPlatform,
} from "./git-platform";
import { DEPLOY_SETUP_BRANCH } from "./publish";
import { runProvision } from "./run";

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
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    dns: { provider: "none", proxied: false },
    cicd: {
      provider: "gitlab-ci",
      registry: "gitlab-registry",
      branch: "main",
      workflowPath: undefined,
    },
  });
}

describe("git-platform agents integration (GitLab)", () => {
  it("gates secret upload and merge request creation behind approvals (Constitution I)", async () => {
    const token = fakeSecret("gitlab-token", "agents-gitlab");
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
        "GET /projects/acme%2Fshop/variables/OPSCREW_HOST": { status: 404, body: {} },
        "PUT /projects/acme%2Fshop/variables/OPSCREW_HOST": { status: 404, body: {} },
        "POST /projects/acme%2Fshop/variables": {
          status: 201,
          body: { key: "OPSCREW_HOST", value: "x" },
        },
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
      },
      { base: "https://gitlab.com/api/v4" },
    );

    const plan = gitlabPlan();

    // 1. Declining approvals performs zero mutating GitLab API calls.
    const deniedHandler = new ScriptedApprovalHandler(() => false);
    const deniedDeps = await createTestPhaseDeps({
      env: { GITLAB_TOKEN: token },
      runner: gitRunner("git@gitlab.com:acme/shop.git"),
      fetch,
      approvalHandler: deniedHandler,
    });
    expect(await repositoryPrivate(deniedDeps)).toBe(true);
    const deniedSetup = await setupGitPlatform(deniedDeps, plan);
    expect(deniedSetup.platform.id).toBe("gitlab");
    expect(deniedSetup.defaultBranch).toBe("main");
    expect(deniedSetup.containerImage).toBe("registry.gitlab.com/acme/shop");

    await expect(
      setPlatformDeploySecrets(deniedDeps, deniedSetup, plan, {
        environment: "production",
        secrets: { OPSCREW_HOST: "198.51.100.10" },
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" } satisfies Partial<OpsCrewError>);
    const deniedMr = await publishPlatformChangeRequest(deniedDeps, deniedSetup, {
      head: "opscrew/deploy-setup",
      base: "main",
      title: "Add deploy",
      body: "Deploy setup",
    });
    expect(deniedMr.approved).toBe(false);
    expect(deniedMr.created).toBe(false);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(deniedHandler.requests.map((r) => r.kind)).toEqual(["github-secrets", "pull-request"]);

    // 2. Approving executes the mutations and audits them.
    const approvedHandler = new ScriptedApprovalHandler(() => true);
    const deps = await createTestPhaseDeps({
      env: { GITLAB_TOKEN: token },
      runner: gitRunner("git@gitlab.com:acme/shop.git"),
      fetch,
      approvalHandler: approvedHandler,
    });
    const setup = await setupGitPlatform(deps, plan);
    const stored = await setPlatformDeploySecrets(deps, setup, plan, {
      environment: "production",
      secrets: { OPSCREW_HOST: "198.51.100.10" },
    });
    expect(stored.created).toEqual(["OPSCREW_HOST"]);
    expect(stored.updated).toEqual([]);

    const published = await publishPlatformChangeRequest(deps, setup, {
      head: "opscrew/deploy-setup",
      base: "main",
      title: "Add deploy",
      body: "Deploy setup",
    });
    expect(published.approved).toBe(true);
    expect(published.created).toBe(true);
    expect(published.changeRequest?.number).toBe(5);
    expect(approvedHandler.requests.map((r) => r.kind)).toEqual(["github-secrets", "pull-request"]);
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/projects/acme%2Fshop/variables"),
    ).toBe(true);
    expect(
      calls.some((c) => c.method === "POST" && c.path === "/projects/acme%2Fshop/merge_requests"),
    ).toBe(true);
  });

  it.skipIf(!findExecutable("git"))(
    "runs runProvision end-to-end for a GitLab CI plan with approvals, CI variables, and merge request",
    async () => {
      const token = fakeSecret("gitlab-token", "provision-gitlab");
      const hcloud = fakeSecret("hcloud-token", "provision-gitlab");
      const stripe = fakeSecret("stripe-live-key", "provision-gitlab");
      const plan = gitlabPlan();
      const project = await createProject(plan);
      await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${stripe}\n`);
      execFileSync("git", [
        "-C",
        project.root,
        "remote",
        "set-url",
        "origin",
        "https://gitlab.com/acme/shop.git",
      ]);
      execFileSync("git", [
        "-C",
        project.root,
        "remote",
        "set-url",
        "--push",
        "origin",
        project.bare,
      ]);

      const storedVars = new Map<string, string>();
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
          "GET /projects/acme%2Fshop/merge_requests": { body: [] },
          "POST /projects/acme%2Fshop/merge_requests": {
            status: 201,
            body: {
              iid: 11,
              web_url: "https://gitlab.com/acme/shop/-/merge_requests/11",
              title: "Add OpsCrew deployment setup for shop",
              source_branch: DEPLOY_SETUP_BRANCH,
              target_branch: "main",
            },
          },
        },
        { base: "https://gitlab.com/api/v4" },
      );

      // Intercept variable existence/create/update calls dynamically for any OPSCREW_* secret name.
      const gitlabFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "POST" && /\/projects\/acme%2Fshop\/variables(?:$|\?)/.test(url)) {
          const payload = JSON.parse(String(init?.body ?? "{}")) as { key: string; value: string };
          storedVars.set(payload.key, payload.value);
          return new Response(JSON.stringify({ key: payload.key, value: payload.value }), {
            status: 201,
          });
        }
        const match = /\/projects\/acme%2Fshop\/variables\/([^/?]+)/.exec(url);
        if (match && (method === "GET" || method === "PUT")) {
          const key = decodeURIComponent(match[1] as string);
          if (method === "GET") {
            return new Response(
              JSON.stringify(storedVars.has(key) ? { key } : { message: "404" }),
              {
                status: storedVars.has(key) ? 200 : 404,
              },
            );
          }
          return new Response(JSON.stringify({ message: "404" }), { status: 404 });
        }
        return fetch(input, init);
      };

      const engine = new FakeEngine();
      const handler = new ScriptedApprovalHandler(() => true);
      const zone = new FakeZone();
      const deps = await createTestPhaseDeps({
        root: project.root,
        env: {
          ...process.env,
          OPSCREW_HOME: join(project.root, ".home-opscrew"),
          HCLOUD_TOKEN: hcloud,
          GITLAB_TOKEN: token,
          OPSCREW_APP_ENV_FILE: "production.env",
        },
        runner: projectRunner(),
        approvalHandler: handler,
        fetch: gitlabFetch,
      });

      const result = await runProvision(deps, {
        services: {
          otherApps: { inspect: noOtherApps },
          engine: async () => engine,
          provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
          tcpConnect: async () => true,
          remote: readyRemote,
          sleep: async () => undefined,
          sharedCloudflare: fakeSharedCloudflare(zone),
        },
      });

      expect(handler.requests.map((r) => r.kind)).toEqual([
        "repo-write",
        "iac-apply",
        "github-secrets",
        "git-push",
        "pull-request",
      ]);
      expect(result).toMatchObject({
        applied: true,
        branch: DEPLOY_SETUP_BRANCH,
        pushed: true,
        prUrl: "https://gitlab.com/acme/shop/-/merge_requests/11",
      });

      const pipeline = await readFile(join(project.root, ".gitlab-ci.yml"), "utf8");
      expect(pipeline).toContain("OPSCREW_APP_ENV");
      expect(pipeline).toContain("docker login");
      expect(storedVars.has("OPSCREW_HOST")).toBe(true);
      expect(storedVars.has("OPSCREW_SSH_PRIVATE_KEY")).toBe(true);
      expect(storedVars.has("OPSCREW_SSH_KNOWN_HOSTS")).toBe(true);
      expect(storedVars.has("OPSCREW_APP_ENV")).toBe(true);
      expect(
        calls.some((c) => c.method === "POST" && c.path === "/projects/acme%2Fshop/merge_requests"),
      ).toBe(true);
    },
  );

  it.skipIf(!findExecutable("git"))(
    "runs runProvision end-to-end for a Forgejo Actions plan with approvals, secrets (including OPSCREW_REGISTRY_TOKEN), and pull request",
    async () => {
      const token = fakeSecret("forgejo-token", "provision-forgejo");
      const registryToken = fakeSecret("forgejo-token", "provision-forgejo-registry");
      const hcloud = fakeSecret("hcloud-token", "provision-forgejo");
      const stripe = fakeSecret("stripe-live-key", "provision-forgejo");
      const plan = DeployPlanSchema.parse({
        ...testPlan(),
        dns: { provider: "none", proxied: false },
        cicd: {
          provider: "forgejo-actions",
          registry: "forgejo-registry",
          branch: "main",
          workflowPath: undefined,
        },
      });
      const project = await createProject(plan);
      await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${stripe}\n`);
      execFileSync("git", [
        "-C",
        project.root,
        "remote",
        "set-url",
        "origin",
        "https://codeberg.org/alice/shop.git",
      ]);
      execFileSync("git", [
        "-C",
        project.root,
        "remote",
        "set-url",
        "--push",
        "origin",
        project.bare,
      ]);

      const storedSecrets = new Map<string, string>();
      const { fetch, calls } = fakeFetch(
        {
          "GET /repos/alice/shop": {
            body: {
              id: 77,
              full_name: "alice/shop",
              default_branch: "main",
              private: true,
              html_url: "https://codeberg.org/alice/shop",
            },
          },
          "GET /repos/alice/shop/pulls": { body: [] },
          "POST /repos/alice/shop/pulls": {
            status: 201,
            body: {
              number: 9,
              html_url: "https://codeberg.org/alice/shop/pulls/9",
              title: "Add OpsCrew deployment setup for shop",
              head: { ref: DEPLOY_SETUP_BRANCH },
              base: { ref: "main" },
            },
          },
        },
        { base: "https://codeberg.org/api/v1" },
      );

      const forgejoFetch: typeof fetch = async (input, init) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (method === "GET" && /\/repos\/alice\/shop\/actions\/secrets\?/.test(url)) {
          return new Response(JSON.stringify([...storedSecrets.keys()].map((name) => ({ name }))), {
            status: 200,
          });
        }
        const putMatch = /\/repos\/alice\/shop\/actions\/secrets\/([^/?]+)/.exec(url);
        if (method === "PUT" && putMatch) {
          const name = decodeURIComponent(putMatch[1] as string);
          const payload = JSON.parse(String(init?.body ?? "{}")) as { data: string };
          storedSecrets.set(name, payload.data);
          return new Response(null, { status: 204 });
        }
        return fetch(input, init);
      };

      const engine = new FakeEngine();
      const handler = new ScriptedApprovalHandler(() => true);
      const zone = new FakeZone();
      const deps = await createTestPhaseDeps({
        root: project.root,
        env: {
          ...process.env,
          OPSCREW_HOME: join(project.root, ".home-opscrew"),
          HCLOUD_TOKEN: hcloud,
          FORGEJO_TOKEN: token,
          OPSCREW_REGISTRY_TOKEN: registryToken,
          OPSCREW_APP_ENV_FILE: "production.env",
        },
        runner: projectRunner(),
        approvalHandler: handler,
        fetch: forgejoFetch,
      });

      const result = await runProvision(deps, {
        services: {
          otherApps: { inspect: noOtherApps },
          engine: async () => engine,
          provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
          tcpConnect: async () => true,
          remote: readyRemote,
          sleep: async () => undefined,
          sharedCloudflare: fakeSharedCloudflare(zone),
        },
      });

      expect(handler.requests.map((r) => r.kind)).toEqual([
        "repo-write",
        "iac-apply",
        "github-secrets",
        "git-push",
        "pull-request",
      ]);
      expect(result).toMatchObject({
        applied: true,
        branch: DEPLOY_SETUP_BRANCH,
        pushed: true,
        prUrl: "https://codeberg.org/alice/shop/pulls/9",
      });

      const workflow = await readFile(
        join(project.root, ".forgejo/workflows/opscrew-deploy.yml"),
        "utf8",
      );
      expect(workflow).toContain("registry: codeberg.org");
      expect(workflow).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: asserting Forgejo Actions expression syntax.
        "REGISTRY_TOKEN: ${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}",
      );
      expect(storedSecrets.has("OPSCREW_HOST")).toBe(true);
      expect(storedSecrets.has("OPSCREW_SSH_PRIVATE_KEY")).toBe(true);
      expect(storedSecrets.has("OPSCREW_SSH_KNOWN_HOSTS")).toBe(true);
      expect(storedSecrets.has("OPSCREW_APP_ENV")).toBe(true);
      expect(storedSecrets.get("OPSCREW_REGISTRY_TOKEN")).toBe(registryToken);
      expect(calls.some((c) => c.method === "POST" && c.path === "/repos/alice/shop/pulls")).toBe(
        true,
      );
    },
  );
});
