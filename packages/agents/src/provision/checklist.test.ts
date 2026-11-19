import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { ownPlan } from "../testing/own";
import { checkWorkflowFiles, checkWorkflows, scanSecrets } from "./checklist";
import { deploySetupPullRequestBody } from "./publish";

const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const offline = {
  fetch: () => Promise.reject(new Error("offline")),
  runner: { run: () => Promise.reject(new Error("offline")) },
};

describe("checkWorkflows", () => {
  it("passes actions pinned to a commit SHA and local ones, and names the owners that are not GitHub's", () => {
    const text = [
      "steps:",
      `  - uses: actions/checkout@${SHA} # v7.0.1`,
      `  - uses: docker/build-push-action@${SHA}`,
      `  - uses: "buildpacks/github-actions/setup-pack@${SHA}"`,
      "  - uses: ./.github/actions/local",
      `  - uses: sigstore/cosign-installer@${SHA}`,
    ].join("\n");
    expect(checkWorkflows([{ file: "deploy.yml", text }])).toEqual({
      unpinned: [],
      owners: ["buildpacks", "docker", "sigstore"],
    });
  });

  it("names each action that is not pinned to a commit SHA, with its file", () => {
    const text = "    steps:\n      - uses: actions/checkout@v4\n      - uses: docker://alpine:3\n";
    expect(checkWorkflows([{ file: "a.yml", text }])).toEqual({
      unpinned: [
        { file: "a.yml", uses: "actions/checkout@v4" },
        { file: "a.yml", uses: "docker://alpine:3" },
      ],
      owners: [],
    });
  });
});

describe("the files on disk", () => {
  const tmp = () => mkdtemp(join(tmpdir(), "opscrew-checklist-"));

  it("reads only the workflows that exist", async () => {
    const root = await tmp();
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await writeFile(join(root, ".github/workflows/d.yml"), `- uses: actions/checkout@${SHA}\n`);
    expect(await checkWorkflowFiles(root, ["missing.yml"])).toBeUndefined();
    expect(await checkWorkflowFiles(root, [".github/workflows/d.yml", "missing.yml"])).toEqual({
      unpinned: [],
      owners: [],
    });
  });

  it("names each secret finding's rule and file once, never its value", async () => {
    const root = await tmp();
    const token = fakeSecret("github-token");
    await writeFile(join(root, "config.js"), `const a = "${token}";\nconst b = "${token}";\n`);
    await writeFile(join(root, "clean.js"), "export const port = 3000;\n");
    const findings = await scanSecrets(offline, root, ["config.js", "clean.js", "gone.js"]);
    expect(findings).toEqual([{ ruleId: "secrets/github-token", file: "config.js" }]);
    expect(JSON.stringify(findings)).not.toContain(token);
  });
});

describe("the deploy-setup pull request's lists", () => {
  const clean = { secrets: [], workflow: { unpinned: [], owners: ["docker", "sigstore"] } };

  it("ticks what the run checked and leaves the rest to the reviewer", () => {
    const body = deploySetupPullRequestBody(ownPlan(), "1.2.3", { checks: clean });
    expect(body).toContain(
      [
        "Checked by OpsCrew:",
        "- [x] OpsCrew's secret rules found no secret value in the files this pull request changes.",
        "- [x] Every action the workflow uses is pinned to a commit SHA.",
        "",
        "For you to check:",
        "- [ ] The workflow also uses actions by docker and sigstore: check that you trust them.",
        "- [ ] The host changes OpsCrew showed before applying them (Docker, the deploy user, SSH settings, the ufw firewall) match what you expect.",
        "",
        "Opened by OpsCrew 1.2.3.",
      ].join("\n"),
    );
    expect(body).not.toContain("first-party");
  });

  it("moves a finding to the reviewer, naming its rule and file", () => {
    const body = deploySetupPullRequestBody(ownPlan(), "1.2.3", {
      checks: {
        secrets: [{ ruleId: "secrets/github-token", file: "opscrew/runtime/compose.yaml" }],
        workflow: {
          unpinned: [
            { file: ".github/workflows/opscrew-deploy.yml", uses: "docker/login-action@v4" },
          ],
          owners: ["docker"],
        },
      },
    });
    expect(body).not.toContain("Checked by OpsCrew");
    expect(body).toContain(
      "- [ ] OpsCrew's secret rules flagged `secrets/github-token` in `opscrew/runtime/compose.yaml`: check each and move any secret value out of the repository.",
    );
    expect(body).toContain(
      "- [ ] Not pinned to a commit SHA: `docker/login-action@v4` in `.github/workflows/opscrew-deploy.yml`.",
    );
  });

  it("ticks nothing when the run did not check", () => {
    const body = deploySetupPullRequestBody(ownPlan(), "1.2.3");
    expect(body).not.toContain("Checked by OpsCrew");
    expect(body).not.toContain("[x]");
    expect(body).toContain(
      "For you to check:\n- [ ] Every action the workflow uses is pinned to a commit SHA, and you trust the owners of those that are not GitHub's own.",
    );
  });
});
