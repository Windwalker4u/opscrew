import type { GitPlatformDefinition } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { definition as github } from "@opscrew/git-github";
import { definition as gitlab } from "@opscrew/git-gitlab";
import { describe, expect, it } from "vitest";
import { validateGitPlatform } from "./validate";

describe("validateGitPlatform", () => {
  it("accepts every built-in git platform definition", () => {
    expect(validateGitPlatform(github)).toBe(github);
    expect(validateGitPlatform(gitlab)).toBe(gitlab);
  });

  it("refuses a wrong contract version", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        contractVersion: 99 as unknown as GitPlatformDefinition["contractVersion"],
      }),
    ).toThrow(OpsCrewError);
  });

  it("refuses a bad platform id, cicdProvider, or registryId", () => {
    for (const badId of ["", "GitHub", "1github", "git_hub"]) {
      expect(() => validateGitPlatform({ ...github, id: badId })).toThrow(OpsCrewError);
      expect(() => validateGitPlatform({ ...github, cicdProvider: badId })).toThrow(OpsCrewError);
      expect(() => validateGitPlatform({ ...github, registryId: badId })).toThrow(OpsCrewError);
    }
  });

  it("refuses an empty displayName or blank texts", () => {
    expect(() => validateGitPlatform({ ...github, displayName: "" })).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({ ...github, texts: { ...github.texts, remoteFixHint: "" } }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({ ...github, texts: { ...github.texts, tokenFixHint: "" } }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({ ...github, texts: { ...github.texts, changeRequestNoun: "" } }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({ ...github, texts: { ...github.texts, pipelineNoun: "" } }),
    ).toThrow(OpsCrewError);
  });

  it("refuses empty credentials.envVars or blank env var names", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        credentials: { ...github.credentials, envVars: [] },
      }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({
        ...github,
        credentials: { ...github.credentials, envVars: [""] },
      }),
    ).toThrow(OpsCrewError);
  });

  it("refuses a token rule without the /g flag", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        credentials: {
          ...github.credentials,
          tokenRules: [
            {
              id: "bad-token",
              title: "Bad token",
              severity: "critical",
              pattern: /ghp_[A-Za-z0-9]{36}/,
              description: "Missing global flag.",
            },
          ],
        },
      }),
    ).toThrow(/must use the \/g flag/);
  });

  it("refuses non-function hooks", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        parseRemote: "bad" as unknown as GitPlatformDefinition["parseRemote"],
      }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({
        ...github,
        containerImage: "bad" as unknown as GitPlatformDefinition["containerImage"],
      }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({
        ...github,
        resolveToken: "bad" as unknown as GitPlatformDefinition["resolveToken"],
      }),
    ).toThrow(OpsCrewError);
    expect(() =>
      validateGitPlatform({
        ...github,
        createConnector: "bad" as unknown as GitPlatformDefinition["createConnector"],
      }),
    ).toThrow(OpsCrewError);
  });
});
