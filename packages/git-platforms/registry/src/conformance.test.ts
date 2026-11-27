import { GIT_PLATFORM_CONTRACT_VERSION } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { detectGitPlatform, GIT_PLATFORMS, gitPlatform, validateGitPlatform } from "./index";

describe("@opscrew/git-platforms registry conformance", () => {
  it("registers unique valid platform ids and parses GitHub remotes", () => {
    expect(GIT_PLATFORMS.length).toBeGreaterThanOrEqual(1);
    expect(new Set(GIT_PLATFORMS.map((p) => p.id)).size).toBe(GIT_PLATFORMS.length);

    for (const platform of GIT_PLATFORMS) {
      expect(platform.contractVersion).toBe(GIT_PLATFORM_CONTRACT_VERSION);
      expect(validateGitPlatform(platform)).toBe(platform);
      expect(gitPlatform(platform.id)).toBe(platform);
    }

    for (const url of ["https://github.com/acme/shop.git", "git@github.com:acme/shop.git"]) {
      const detected = detectGitPlatform(url);
      expect(detected?.platform.id).toBe("github");
      expect(detected?.remote).toEqual({
        host: "github.com",
        owner: "acme",
        repo: "shop",
        fullPath: "acme/shop",
      });
    }
    expect(detectGitPlatform("https://example.invalid/acme/shop.git")).toBeUndefined();
  });

  it("throws INVALID_INPUT for unknown platform ids", () => {
    expect(() => gitPlatform("unknown")).toThrow(/does not support the git platform "unknown"/);
  });
});
