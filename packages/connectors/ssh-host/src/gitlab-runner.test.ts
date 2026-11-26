import { describe, expect, it } from "vitest";
import { gitlabRunnerInstallScript, gitlabRunnerUnitText } from "./runner-unit";

describe("GitLab Runner host unit and install script (042)", () => {
  it("renders a deploy-user systemd unit with sg docker and KillMode=control-group", () => {
    const unit = gitlabRunnerUnitText("shop");
    expect(unit).toContain("Description=GitLab Runner of shop (OpsCrew)");
    expect(unit).toContain("/usr/bin/sg docker -c");
    expect(unit).toContain("/srv/runners/shop/gitlab-runner");
    expect(unit).toContain("/srv/runners/shop/config.toml");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("WorkingDirectory=/srv/runners/shop");
  });

  it("verifies pinned SHA-256 and reads the glrt- token exclusively from stdin", () => {
    const script = gitlabRunnerInstallScript({
      app: "shop",
      instanceUrl: "https://gitlab.com",
      description: "opscrew-shop-prod",
      downloadUrl:
        "https://s3.dualstack.us-east-1.amazonaws.com/gitlab-runner-downloads/v17.11.0/binaries/gitlab-runner-linux-amd64",
      sha256: "a".repeat(64),
    });
    expect(script).toContain("IFS= read -r RUNNER_TOKEN");
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain('--token "$RUNNER_TOKEN"');
    expect(script).toContain("--executor shell");
    expect(script).toContain("chmod 0600 '/srv/runners/shop/config.toml'");
    expect(script).not.toContain("glrt-");
  });
});
