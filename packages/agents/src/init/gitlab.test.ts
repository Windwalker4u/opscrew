import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps } from "../testing";
import { runInitChecks } from "./checks";

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

describe("opscrew init GitLab detection (042)", () => {
  it("detects gitlab.com (including nested subgroups) and verifies GITLAB_TOKEN", async () => {
    const token = fakeSecret("gitlab-token", "init-gitlab");
    const { fetch } = fakeFetch(
      { "GET /user": { body: { username: "alice" } } },
      { base: "https://gitlab.com/api/v4" },
    );
    const deps = await createTestPhaseDeps({
      env: { GITLAB_TOKEN: token },
      runner: gitRunner("git@gitlab.com:acme/platform/shop.git"),
      fetch,
    });
    const checks = await runInitChecks(deps, {
      services: { which: (name) => (name === "git" ? "/usr/bin/git" : undefined) },
    });
    const repo = checks.find((c) => c.id === "repository");
    const gitlab = checks.find((c) => c.id === "gitlab");
    expect(repo).toMatchObject({
      status: "pass",
      message: "origin is gitlab.com/acme/platform/shop.",
    });
    expect(gitlab).toMatchObject({
      status: "pass",
      message: "GitLab token works on gitlab.com (signed in as alice).",
    });
    expect(checks.find((c) => c.id === "github")).toBeUndefined();
  });

  it("detects a self-managed GitLab host and fails with guidance when no token is set", async () => {
    const deps = await createTestPhaseDeps({
      env: {},
      runner: gitRunner("https://gitlab.company.internal/team/api.git"),
    });
    const checks = await runInitChecks(deps, {
      offline: true,
      services: { which: (name) => (name === "git" ? "/usr/bin/git" : undefined) },
    });
    expect(checks.find((c) => c.id === "repository")).toMatchObject({
      status: "pass",
      message: "origin is gitlab.company.internal/team/api.",
    });
    expect(checks.find((c) => c.id === "gitlab")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("No GitLab token found"),
      fix: expect.stringContaining("GITLAB_TOKEN"),
    });
  });
});
