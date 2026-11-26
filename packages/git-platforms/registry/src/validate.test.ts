import type { GitPlatformDefinition } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { definition as github } from "@opscrew/git-github";
import { describe, expect, it } from "vitest";
import { validateGitPlatform } from "./validate";

describe("validateGitPlatform", () => {
  it("accepts a valid built-in git platform definition", () => {
    expect(validateGitPlatform(github)).toBe(github);
  });

  it("refuses a wrong contract version", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        contractVersion: 99 as unknown as GitPlatformDefinition["contractVersion"],
      }),
    ).toThrow(OpsCrewError);
  });

  it("refuses a bad platform id", () => {
    for (const badId of ["", "GitHub", "1github", "git_hub"]) {
      expect(() => validateGitPlatform({ ...github, id: badId })).toThrow(OpsCrewError);
    }
  });

  it("refuses an empty displayName", () => {
    expect(() => validateGitPlatform({ ...github, displayName: "" })).toThrow(OpsCrewError);
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

  it("refuses a missing remoteFixHint", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        texts: { remoteFixHint: "" },
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

  it("refuses a non-function parseRemote", () => {
    expect(() =>
      validateGitPlatform({
        ...github,
        parseRemote: "not-a-function" as unknown as GitPlatformDefinition["parseRemote"],
      }),
    ).toThrow(OpsCrewError);
  });
});
