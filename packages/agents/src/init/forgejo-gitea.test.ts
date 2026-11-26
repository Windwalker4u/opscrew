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

describe("opscrew init Forgejo and Gitea detection (043)", () => {
  it("detects Codeberg (Forgejo) and verifies FORGEJO_TOKEN", async () => {
    const token = fakeSecret("forgejo-token", "init-forgejo");
    const { fetch } = fakeFetch(
      { "GET /user": { body: { login: "alice" } } },
      { base: "https://codeberg.org/api/v1" },
    );
    const deps = await createTestPhaseDeps({
      env: { FORGEJO_TOKEN: token },
      runner: gitRunner("git@codeberg.org:alice/shop.git"),
      fetch,
    });
    const checks = await runInitChecks(deps, {
      services: { which: (name) => (name === "git" ? "/usr/bin/git" : undefined) },
    });
    expect(checks.find((c) => c.id === "repository")).toMatchObject({
      status: "pass",
      message: "origin is codeberg.org/alice/shop.",
    });
    expect(checks.find((c) => c.id === "forgejo")).toMatchObject({
      status: "pass",
      message: "Forgejo token works on codeberg.org (signed in as alice).",
    });
    expect(checks.find((c) => c.id === "github")).toBeUndefined();
  });

  it("detects a self-hosted Gitea host via GITEA_HOST and guides missing GITEA_TOKEN", async () => {
    const deps = await createTestPhaseDeps({
      env: { GITEA_HOST: "git.example.internal" },
      runner: gitRunner("https://git.example.internal/team/api.git"),
    });
    const checks = await runInitChecks(deps, {
      offline: true,
      services: { which: (name) => (name === "git" ? "/usr/bin/git" : undefined) },
    });
    expect(checks.find((c) => c.id === "repository")).toMatchObject({
      status: "pass",
      message: "origin is git.example.internal/team/api.",
    });
    expect(checks.find((c) => c.id === "gitea")).toMatchObject({
      status: "fail",
      message: expect.stringContaining("No Gitea token found"),
      fix: expect.stringContaining("GITEA_TOKEN"),
    });
  });
});
