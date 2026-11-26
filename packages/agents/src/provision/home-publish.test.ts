/**
 * The pull request of an app at home (plan 10., step 6): it brings the outside check's workflow,
 * once per repository, and says what the check does and what to set on the router before merging,
 * from the plan alone: no address of the home or its network is ever written into it.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findExecutable } from "@opscrew/core";
import { renderOutsideCheckWorkflow } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { gitClient } from "../shared";
import {
  createProject,
  createTestPhaseDeps,
  FakeGitHub,
  ownPlan,
  projectRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { deploySetupPullRequestBody, publishDeploySetup } from "./publish";

/** `shop` at home: behind the proxy (default) or with DNS only, over IPv4 (default) or IPv6. */
function homePlan(o: { ipv4?: boolean; proxied?: boolean } = {}): DeployPlan {
  const proxied = o.proxied ?? true;
  const base = ownPlan({ proxied });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: o.ipv4 ?? true } },
    security: { ...base.security, httpAllowedFrom: proxied ? "edge" : "any" },
    environment: { runner: "server" },
  });
}

const CHECK_LINE =
  "- `.github/workflows/opscrew-outside-check.yml`: the outside check, which `opscrew verify` starts. From GitHub's network, outside your home, it requests the site on ports 80 and 443 and logs only each try's status code. It has no permissions, secrets or actions, changes nothing and never gets your home's address. Every app of this repository at home uses this one file.";

/** The body's lines from its router heading to the next blank line. */
function routerLines(body: string): string[] {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.startsWith("**Before merging, set your router**"));
  const end = lines.indexOf("", start);
  return start === -1 ? [] : lines.slice(start, end);
}

describe("the deploy-setup pull request of an app at home", () => {
  it("behind the proxy over IPv4: the outside check, the forwards so Cloudflare reaches the server, and the records the root keeps", () => {
    const body = deploySetupPullRequestBody(homePlan(), "1.2.3");
    expect(body).toContain(CHECK_LINE);
    expect(body).toContain(
      "the site's CAA records at Cloudflare; the address updater on your server keeps its A/AAAA records at your home's address (works with OpenTofu and Terraform).",
    );
    expect(routerLines(body)).toEqual([
      "**Before merging, set your router** (so Cloudflare reaches your server). `opscrew provision` named the server's address on your home network, which is never written here:",
      "- On your router, forward TCP 80 and TCP 443 to this server's address on your network.",
      "- Reserve that address for this server in the router's DHCP settings so it stays fixed.",
      "- Don't forward SSH.",
      "- When the server has its public IPv4 address itself, it needs no forwards.",
    ]);
    // The router's settings come before the merge that deploys.
    expect(body.indexOf("**Before merging, set your router**")).toBeLessThan(
      body.indexOf("**Merging this pull request deploys the app"),
    );
  });

  it("with DNS only: the first deploy's certificate needs the forwards, and the IPv6 firewall while there is IPv6", () => {
    expect(routerLines(deploySetupPullRequestBody(homePlan({ proxied: false }), "1.2.3"))).toEqual([
      "**Before merging, set your router** (the first deploy fetches the site's certificate through them). `opscrew provision` named the server's address on your home network, which is never written here:",
      "- On your router, forward TCP 80 and TCP 443 to this server's address on your network.",
      "- Reserve that address for this server in the router's DHCP settings so it stays fixed.",
      "- Don't forward SSH.",
      "- While your connection has IPv6, the site also has an AAAA record: allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.",
      "- When the server has its public IPv4 address itself, it needs no forwards.",
    ]);
  });

  it("over IPv6 only: no forwards, the router's IPv6 firewall", () => {
    expect(routerLines(deploySetupPullRequestBody(homePlan({ ipv4: false }), "1.2.3"))).toEqual([
      "**Before merging, set your router** (so Cloudflare reaches your server). `opscrew provision` named the server's address on your home network, which is never written here:",
      "- Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.",
    ]);
  });

  it("names neither the check nor the router for a server that isn't at home, and the environment in the command", () => {
    const body = deploySetupPullRequestBody(ownPlan(), "1.2.3");
    expect(body).not.toContain("opscrew-outside-check.yml");
    expect(routerLines(body)).toEqual([]);
    expect(body).toContain("the Cloudflare DNS records that point the domain at your server");
    expect(deploySetupPullRequestBody(homePlan(), "1.2.3", { flag: " --env dev" })).toContain(
      "the outside check, which `opscrew verify --env dev` starts.",
    );
  });
});

describe.skipIf(!findExecutable("git"))("a later pull request of an app at home", () => {
  async function published(o: { check: boolean }) {
    const plan = homePlan({ proxied: false });
    const project = await createProject(plan);
    const deps = await createTestPhaseDeps({
      root: project.root,
      env: { OPSCREW_HOME: join(project.root, ".home-opscrew") },
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(),
    });
    // An earlier setup's deploy workflow is on main already.
    await mkdir(join(project.root, ".github", "workflows"), { recursive: true });
    await writeFile(join(project.root, plan.cicd.workflowPath), "name: deploy\n");
    await project.git(project.root, "add", "opscrew/plan.yaml", plan.cicd.workflowPath);
    await project.git(project.root, "commit", "-q", "-m", "earlier setup");
    const workflow = renderOutsideCheckWorkflow();
    const paths = o.check ? [workflow.path] : ["opscrew/RUNBOOK.md"];
    if (o.check) await writeFile(join(project.root, workflow.path), workflow.content);
    else await writeFile(join(project.root, "opscrew", "RUNBOOK.md"), "# Runbook\n");
    const github = new FakeGitHub();
    await publishDeploySetup(deps, {
      git: gitClient(deps),
      github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
      plan,
      paths,
      push: true,
      recoveryCopy: { files: [] },
    });
    return github.pulls[0];
  }

  it("that brings the outside check says what it does and what to set on the router", async () => {
    const pull = await published({ check: true });
    expect(pull?.title).toBe("OpsCrew: the outside check for shop");
    expect(pull?.body).toContain(CHECK_LINE);
    expect(routerLines(pull?.body ?? "")[0]).toBe(
      "**Before merging, set your router** (the first deploy fetches the site's certificate through them). `opscrew provision` named the server's address on your home network, which is never written here:",
    );
  });

  it("that leaves the outside check as it is names no router settings", async () => {
    const pull = await published({ check: false });
    expect(pull?.title).toBe("OpsCrew: the runbook and reports for shop");
    expect(routerLines(pull?.body ?? "")).toEqual([]);
  });
});
