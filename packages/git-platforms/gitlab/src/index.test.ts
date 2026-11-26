import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  definition,
  GitLabClient,
  gitlabContainerImage,
  isGitLabMaskable,
  parseGitLabRemote,
} from "./index";

describe("@opscrew/git-gitlab remote & image parsing", () => {
  it("parses gitlab.com HTTPS, SSH, SCP-like URLs including nested subgroups", () => {
    expect(parseGitLabRemote("https://gitlab.com/acme/shop.git")).toEqual({
      host: "gitlab.com",
      owner: "acme",
      repo: "shop",
      fullPath: "acme/shop",
    });
    expect(parseGitLabRemote("git@gitlab.com:acme/platform/payments/shop.git")).toEqual({
      host: "gitlab.com",
      owner: "acme/platform/payments",
      repo: "shop",
      fullPath: "acme/platform/payments/shop",
    });
  });

  it("recognises self-managed GitLab hosts by hostname, GITLAB_HOST, or OPSCREW_GIT_PLATFORM", () => {
    expect(parseGitLabRemote("https://gitlab.company.internal/team/api.git")?.host).toBe(
      "gitlab.company.internal",
    );
    expect(
      parseGitLabRemote("git@code.company.com:team/api.git", {
        GITLAB_HOST: "https://code.company.com/",
      })?.host,
    ).toBe("code.company.com");
    expect(
      parseGitLabRemote("https://git.corp.local/team/api.git", {
        OPSCREW_GIT_PLATFORM: "gitlab",
      })?.fullPath,
    ).toBe("team/api");
    expect(parseGitLabRemote("https://github.com/acme/shop.git")).toBeUndefined();
  });

  it("computes lower-case GitLab Container Registry image names", () => {
    expect(gitlabContainerImage({ host: "gitlab.com", fullPath: "Acme/Team/Shop" })).toBe(
      "registry.gitlab.com/acme/team/shop",
    );
    expect(gitlabContainerImage({ host: "gitlab.corp.com", fullPath: "Acme/Shop" }, "admin")).toBe(
      "registry.gitlab.corp.com/acme/shop/admin",
    );
    expect(
      gitlabContainerImage(
        { host: "gitlab.corp.com", fullPath: "Acme/Shop" },
        undefined,
        "reg.corp.com",
      ),
    ).toBe("reg.corp.com/acme/shop");
  });
});

describe("GitLabClient REST API v4", () => {
  const token = fakeSecret("gitlab-token", "gitlab-client-test");
  const parsedRemote = parseGitLabRemote("https://gitlab.com/acme/sub/shop.git");
  if (!parsedRemote) throw new Error("expected GitLab remote");
  const remote = parsedRemote;

  it("handles Free-tier protected environments gracefully and sets masked vs file variables", async () => {
    const { fetch, calls } = fakeFetch(
      {
        "GET /projects/acme%2Fsub%2Fshop/protected_environments": {
          status: 403,
          body: { message: "403 Forbidden" },
        },
        "PUT /projects/acme%2Fsub%2Fshop/variables/DEPLOY_SSH_KEY": { status: 404, body: {} },
        "PUT /projects/acme%2Fsub%2Fshop/variables/DB_PASSWORD": { status: 404, body: {} },
        "POST /projects/acme%2Fsub%2Fshop/variables": {
          status: 201,
          body: { key: "ok", value: "x" },
        },
      },
      { base: "https://gitlab.com/api/v4" },
    );
    const client = new GitLabClient({ token, fetch });

    const cap = await client.environmentCapability(remote);
    expect(cap.available).toBe(true);
    expect(cap.protectedAvailable).toBe(false);
    expect(cap.reason).toContain("GitLab Free");

    const sshKey = fakeSecret("private-key-pem", "gitlab-ssh");
    await client.setSecret(remote, "DEPLOY_SSH_KEY", sshKey, {
      environment: "production",
      protected: true,
    });
    const sshPost = calls.find(
      (c) => c.method === "POST" && (c.body as { key?: string })?.key === "DEPLOY_SSH_KEY",
    );
    expect(sshPost?.body).toMatchObject({
      key: "DEPLOY_SSH_KEY",
      variable_type: "file",
      masked: false,
      protected: true,
      raw: true,
      environment_scope: "production",
    });
    expect(String((sshPost?.body as { value?: string } | undefined)?.value).endsWith("\n")).toBe(
      true,
    );

    const dbPass = fakeSecret("generic-password", "gitlab-db");
    expect(isGitLabMaskable(dbPass)).toBe(true);
    await client.setSecret(remote, "DB_PASSWORD", dbPass, { environment: "production" });
    const dbPost = calls.find(
      (c) => c.method === "POST" && (c.body as { key?: string })?.key === "DB_PASSWORD",
    );
    expect(dbPost?.body).toMatchObject({
      key: "DB_PASSWORD",
      variable_type: "env_var",
      masked: true,
      raw: true,
      environment_scope: "production",
    });
  });

  it("creates merge requests, triggers pipelines, and creates glrt- project runners", async () => {
    const runnerToken = fakeSecret("gitlab-runner-token", "test-runner");
    const { fetch, calls } = fakeFetch(
      {
        "GET /user": { body: { username: "alice" } },
        "GET /projects/acme%2Fsub%2Fshop": {
          body: {
            id: 42,
            path_with_namespace: "acme/sub/shop",
            default_branch: "main",
            visibility: "private",
            web_url: "https://gitlab.com/acme/sub/shop",
          },
        },
        "POST /projects/acme%2Fsub%2Fshop/merge_requests": {
          status: 201,
          body: {
            iid: 7,
            web_url: "https://gitlab.com/acme/sub/shop/-/merge_requests/7",
            title: "Add OpsCrew deploy",
            source_branch: "opscrew/deploy-setup",
            target_branch: "main",
          },
        },
        "POST /projects/acme%2Fsub%2Fshop/pipeline": {
          status: 201,
          body: {
            id: 9001,
            status: "pending",
            web_url: "https://gitlab.com/acme/sub/shop/-/pipelines/9001",
            ref: "main",
            sha: "abc123",
          },
        },
        "POST /user/runners": {
          status: 201,
          body: { id: 555, token: runnerToken },
        },
      },
      { base: "https://gitlab.com/api/v4" },
    );

    const connector = definition.createConnector({ token, fetch });
    expect(await connector.verifyCredentials()).toEqual({
      ok: true,
      identity: "alice",
      message: "GitLab token works on gitlab.com (signed in as alice).",
    });
    const client = connector.client;
    if (!client) throw new Error("expected GitLab client");

    const mr = await client.createChangeRequest(remote, {
      title: "Add OpsCrew deploy",
      body: "Deploy pipeline",
      head: "opscrew/deploy-setup",
      base: "main",
    });
    expect(mr).toEqual({
      number: 7,
      url: "https://gitlab.com/acme/sub/shop/-/merge_requests/7",
      title: "Add OpsCrew deploy",
      head: "opscrew/deploy-setup",
      base: "main",
    });

    const run = await client.triggerPipeline(remote, {
      ref: "main",
      inputs: { OPSCREW_MODE: "deploy" },
    });
    expect(run).toMatchObject({ id: 9001, status: "queued", ref: "main" });

    const createdRunner = await client.createRunnerToken(remote, {
      description: "shop-prod",
      labels: ["opscrew-shop-prod"],
    });
    expect(createdRunner).toEqual({ token: runnerToken, runnerId: 555 });
    const runnerCall = calls.find((c) => c.path === "/user/runners");
    expect(runnerCall?.body).toMatchObject({
      runner_type: "project_type",
      project_id: 42,
      tag_list: ["opscrew-shop-prod"],
      run_untagged: false,
      locked: true,
    });
  });
});
