import { describe, expect, it } from "vitest";
import { definition, parseGitHubRemote } from "./index";

describe("@opscrew/git-github", () => {
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
    expect(definition.parseRemote("https://github.com/acme/shop.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "shop",
      fullPath: "acme/shop",
    });
  });
});
