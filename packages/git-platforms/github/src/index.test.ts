import type { ProviderRedactor } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { definition, githubContainerImage, parseGitHubRemote } from "./index";

describe("@opscrew/git-github", () => {
  const remote = parseGitHubRemote("git@github.com:acme/shop.git");
  if (!remote) throw new Error("expected GitHub remote");

  it("parses HTTPS, SSH, and SCP-like GitHub remotes and rejects other hosts", () => {
    for (const url of [
      "https://github.com/acme/shop.git",
      "https://github.com/acme/shop",
      "git@github.com:acme/shop.git",
      "ssh://git@github.com/acme/shop.git",
    ]) {
      expect(parseGitHubRemote(url)).toEqual({
        host: "github.com",
        owner: "acme",
        repo: "shop",
        fullPath: "acme/shop",
      });
    }
    expect(parseGitHubRemote("https://gitlab.com/acme/shop.git")).toBeUndefined();
  });

  it("formats lower-case GHCR container image names matching ghcrImageFor", () => {
    expect(githubContainerImage({ host: "github.com", fullPath: "Acme/Shop" })).toBe(
      "ghcr.io/acme/shop",
    );
    expect(githubContainerImage({ host: "github.com", fullPath: "Acme/Shop" }, "docs")).toBe(
      "ghcr.io/acme/shop/docs",
    );
  });

  it("passes a non-class ProviderRedactor straight through without adding the token twice", async () => {
    const token = fakeSecret("github-token", "git-github-redactor");
    const added: { value: string; label?: string }[] = [];
    const redacted: string[] = [];
    const customRedactor: ProviderRedactor = {
      addLiteral(value, label) {
        added.push({ value, ...(label !== undefined ? { label } : {}) });
      },
      redact(text) {
        redacted.push(text);
        return text.replaceAll(token, "[CUSTOM-REDACTED]");
      },
      redactDeep<T>(value: T): T {
        return value;
      },
    };
    const { fetch } = fakeFetch(
      { "GET /user": { status: 500, body: { message: `Server failed for ${token}` } } },
      { base: "https://api.github.com" },
    );
    const connector = definition.createConnector({ token, fetch, redactor: customRedactor });
    expect(added).toHaveLength(1);
    expect(added[0]?.value).toBe(token);
    const check = await connector.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(redacted.length).toBeGreaterThanOrEqual(1);
    expect(check.message).not.toContain(token);
    expect(check.message).toContain("[CUSTOM-REDACTED]");
  });

  it("checks environment secrets directly instead of checking only whether the environment exists", async () => {
    const token = fakeSecret("github-token", "git-github-env-secret");
    const { fetch, calls } = fakeFetch(
      {
        "GET /repos/acme/shop/environments/production/secrets/DEPLOY_KEY": {
          status: 200,
          body: { name: "DEPLOY_KEY" },
        },
        "GET /repos/acme/shop/environments/production/secrets/MISSING_KEY": {
          status: 404,
          body: { message: "Not Found" },
        },
      },
      { base: "https://api.github.com" },
    );
    const client = definition.createConnector({ token, fetch }).client;
    if (!client) throw new Error("expected client");

    expect(await client.secretExists(remote, "DEPLOY_KEY", { environment: "production" })).toBe(
      true,
    );
    expect(await client.secretExists(remote, "MISSING_KEY", { environment: "production" })).toBe(
      false,
    );
    expect(calls.map((c) => c.path)).toEqual([
      "/repos/acme/shop/environments/production/secrets/DEPLOY_KEY",
      "/repos/acme/shop/environments/production/secrets/MISSING_KEY",
    ]);
  });

  it("refuses protected: true on repository-wide GitHub secrets without an environment", async () => {
    const token = fakeSecret("github-token", "git-github-protected");
    const { fetch } = fakeFetch({}, { base: "https://api.github.com" });
    const client = definition.createConnector({ token, fetch }).client;
    if (!client) throw new Error("expected client");

    await expect(
      client.setSecret(remote, "DEPLOY_KEY", "secret-val", { protected: true }),
    ).rejects.toThrow(OpsCrewError);
  });

  it("returns real title, head, and base on change request find, create, and update", async () => {
    const token = fakeSecret("github-token", "git-github-pr");
    const { fetch } = fakeFetch(
      {
        "GET /repos/acme/shop/pulls": {
          body: [
            {
              number: 12,
              html_url: "https://github.com/acme/shop/pull/12",
              title: "Set up OpsCrew",
              head: { ref: "opscrew/deploy-setup" },
              base: { ref: "main" },
            },
          ],
        },
        "POST /repos/acme/shop/pulls": {
          status: 201,
          body: {
            number: 13,
            html_url: "https://github.com/acme/shop/pull/13",
            title: "New deploy",
            head: { ref: "opscrew/deploy-setup-2" },
            base: { ref: "main" },
          },
        },
        "PATCH /repos/acme/shop/pulls/13": {
          body: {
            number: 13,
            html_url: "https://github.com/acme/shop/pull/13",
            title: "Updated deploy",
            head: { ref: "opscrew/deploy-setup-2" },
            base: { ref: "main" },
          },
        },
      },
      { base: "https://api.github.com" },
    );
    const client = definition.createConnector({ token, fetch }).client;
    if (!client) throw new Error("expected client");

    expect(await client.findOpenChangeRequest(remote, "opscrew/deploy-setup", "main")).toEqual({
      number: 12,
      url: "https://github.com/acme/shop/pull/12",
      title: "Set up OpsCrew",
      head: "opscrew/deploy-setup",
      base: "main",
    });
    expect(
      await client.findOpenChangeRequest(remote, "opscrew/deploy-setup", "release"),
    ).toBeUndefined();
    expect(
      await client.createChangeRequest(remote, {
        title: "New deploy",
        body: "body",
        head: "opscrew/deploy-setup-2",
        base: "main",
      }),
    ).toEqual({
      number: 13,
      url: "https://github.com/acme/shop/pull/13",
      title: "New deploy",
      head: "opscrew/deploy-setup-2",
      base: "main",
    });
    expect(
      await client.updateChangeRequest(remote, 13, { title: "Updated deploy", body: "body2" }),
    ).toEqual({
      number: 13,
      url: "https://github.com/acme/shop/pull/13",
      title: "Updated deploy",
      head: "opscrew/deploy-setup-2",
      base: "main",
    });
  });

  it("probes GitHub environmentCapability instead of guessing from repository privacy", async () => {
    const token = fakeSecret("github-token", "git-github-env-cap");
    const { fetch } = fakeFetch(
      {
        "GET /user": { body: { id: 77, login: "octocat" } },
        "GET /repos/acme/shop/environments/probe-env": [
          { status: 404, body: { message: "Not Found" } },
          {
            status: 200,
            body: {
              name: "probe-env",
              deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
              protection_rules: [
                { type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 77 } }] },
              ],
            },
          },
        ],
        "PUT /repos/acme/shop/environments/probe-env": { status: 200, body: { name: "probe-env" } },
        "POST /repos/acme/shop/environments/probe-env/deployment-branch-policies": {
          status: 200,
          body: { id: 1, name: "main", type: "branch" },
        },
        "DELETE /repos/acme/shop/environments/probe-env": { status: 204, body: "" },
      },
      { base: "https://api.github.com" },
    );
    const client = definition.createConnector({ token, fetch }).client;
    if (!client) throw new Error("expected client");

    expect(
      await client.environmentCapability(remote, { probeName: "probe-env", branch: "main" }),
    ).toEqual({
      available: true,
      protectedAvailable: true,
    });
  });

  it("requires an explicit workflowFile for triggerPipeline and listPipelineRuns", async () => {
    const token = fakeSecret("github-token", "git-github-workflow");
    const { fetch, calls } = fakeFetch(
      {
        "POST /repos/acme/shop/actions/workflows/opscrew-deploy-api.yml/dispatches": {
          status: 200,
          body: { workflow_run_id: 99, html_url: "https://github.com/acme/shop/actions/runs/99" },
        },
        "GET /repos/acme/shop/actions/workflows/opscrew-deploy-api.yml/runs": {
          body: {
            workflow_runs: [
              {
                id: 99,
                status: "completed",
                conclusion: "success",
                html_url: "https://github.com/acme/shop/actions/runs/99",
                head_sha: "abc123",
                created_at: "2026-11-26T00:00:00Z",
              },
            ],
          },
        },
      },
      { base: "https://api.github.com" },
    );
    const client = definition.createConnector({ token, fetch }).client;
    if (!client) throw new Error("expected client");

    await expect(client.triggerPipeline(remote, { ref: "main" })).rejects.toThrow(
      /workflowFile is required/,
    );
    await expect(client.listPipelineRuns(remote, { ref: "main" })).rejects.toThrow(
      /workflowFile is required/,
    );

    const triggered = await client.triggerPipeline(remote, {
      ref: "main",
      workflowFile: "opscrew-deploy-api.yml",
    });
    expect(triggered).toMatchObject({ id: 99, status: "queued", ref: "main" });

    const listed = await client.listPipelineRuns(remote, {
      ref: "main",
      workflowFile: "opscrew-deploy-api.yml",
    });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 99, status: "success", sha: "abc123" });
    expect(calls.some((c) => c.path.includes("opscrew-deploy-api.yml"))).toBe(true);
  });
});
