import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { deploySetupPullRequestBody } from "../provision/publish";
import { hostingTestPlan } from "./__fixtures__/account";

/** An SFTP-only host's plan: no database, cron or mail, which it refuses. */
const sftpPlan = () => {
  const plan = hostingTestPlan({ database: false });
  return { ...plan, target: { ...plan.target, panel: "sftp", cron: [] } } as DeployPlan;
};

describe("a hosting account's pull request lists", () => {
  const checks = { secrets: [], workflow: { unpinned: [], owners: [] } };

  it("on a panel: the checks ticked, the agent's script for the reviewer", () => {
    const body = deploySetupPullRequestBody(hostingTestPlan(), "1.2.3", { checks });
    expect(body).toContain(
      [
        "Checked by OpsCrew:",
        "- [x] OpsCrew's secret rules found no secret value in the files this pull request changes.",
        "- [x] Every action the workflow uses is pinned to a commit SHA.",
        "",
        "For you to check:",
        "- [ ] `opscrew/hosting/agent.sh` is the script you expect to run on your account.",
      ].join("\n"),
    );
  });

  it("on an SFTP-only host with every check passed, no list for the reviewer", () => {
    const body = deploySetupPullRequestBody(sftpPlan(), "1.2.3", {
      checks,
    });
    expect(body).toContain("Checked by OpsCrew:");
    expect(body).not.toContain("For you to check");
  });

  it("a finding moves to the reviewer, named by rule and file", () => {
    const body = deploySetupPullRequestBody(sftpPlan(), "1.2.3", {
      checks: { ...checks, secrets: [{ ruleId: "secrets/private-key", file: "deploy.pem" }] },
    });
    expect(body).toContain(
      "Checked by OpsCrew:\n- [x] Every action the workflow uses is pinned to a commit SHA.\n\nFor you to check:\n- [ ] OpsCrew's secret rules flagged `secrets/private-key` in `deploy.pem`",
    );
  });
});
