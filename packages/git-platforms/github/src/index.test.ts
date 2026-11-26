import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { definition, githubContainerImage, parseGitHubRemote } from "./index";

describe("@opscrew/git-github", () => {
  it("parses HTTPS, SSH, and SCP-like GitHub remotes and rejects other hosts", () => {
    for (const url of [
      "https://github.com/acme/shop.git",
      "https://github.com/acme/shop",
      "git@github.com:acme/shop.git",
      "ssh://git@github.com/acme/shop.git",
    ]) {
      expect(parseGitHubRemote(url)).toEqual({
        platformId: "github",
        host: "github.com",
        owner: "acme",
        repo: "shop",
        fullPath: "acme/shop",
        webUrl: "https://github.com/acme/shop",
        sshUrl: "git@github.com:acme/shop.git",
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

  it("verifies credentials and delegates basic operations through the unified GitPlatformClient", async () => {
    const token = fakeSecret("github-token", "git-github-test");
    const { fetch } = fakeFetch(
      {
        "GET /user": { body: { login: "octocat" } },
        "GET /repos/acme/shop": {
          body: {
            full_name: "acme/shop",
            default_branch: "main",
            private: true,
            html_url: "https://github.com/acme/shop",
          },
        },
      },
      { base: "https://api.github.com" },
    );
    const connector = definition.createConnector({ token, fetch });
    expect(await connector.verifyCredentials()).toEqual({
      ok: true,
      identity: "octocat",
      message: "GitHub token works (signed in as octocat).",
    });
    const remote = parseGitHubRemote("git@github.com:acme/shop.git");
    expect(remote).toBeDefined();
    if (!remote || !connector.client) throw new Error("expected client and remote");
    expect(await connector.client.getRepo(remote)).toEqual({
      id: "acme/shop",
      fullPath: "acme/shop",
      defaultBranch: "main",
      private: true,
      visibility: "private",
      webUrl: "https://github.com/acme/shop",
    });
  });
});
