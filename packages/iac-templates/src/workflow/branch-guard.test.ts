// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { cloudflarePlan, NPM_SITE, pagesPlan, ssrPlan } from "../serverless/__fixtures__/plans";
import { inEnvironment, ofApp, serverPlan } from "./__fixtures__/plans";
import { renderWorkflow } from "./index";

type Step = { name?: string; env?: Record<string, string>; run?: string };
type Job = { if?: string; needs?: string | string[]; permissions: unknown; steps: Step[] };
type Workflow = { jobs: Record<string, Job> };

const ctx = {
  ...testContext(),
  builderBranch: "main",
  builderWorkflowPath: ".github/workflows/opscrew-deploy-staging.yml",
};
const workflow = (plan: DeployPlan) => parse(renderWorkflow(plan, ctx).content) as Workflow;
const PROMOTE = { from: "promote", source: "staging" } as const;
const ON_MAIN = "github.ref == 'refs/heads/main'";
const ON_DEFAULT = "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

/** `plan` following `branch` (its pushes deploy it). */
function onBranch(plan: DeployPlan, branch: string): DeployPlan {
  return DeployPlanSchema.parse({ ...plan, cicd: { ...plan.cicd, branch } });
}

/** The test plan on a hosting account (`panel`), as staging's plan. */
function hostingPlan(panel: "cpanel" | "sftp"): DeployPlan {
  const base = serverPlan();
  const plan = DeployPlanSchema.parse({
    ...base,
    target: { provider: "hosting", panel, app: "static", webRoot: ".", site: NPM_SITE },
    services: [],
    externalServices: [],
    dns: { provider: "none", domain: "shop.example.com", proxied: false, www: false },
    security: { ...base.security, httpAllowedFrom: "any" },
  });
  return inEnvironment(plan, { name: "staging", secrets: "environment" });
}

/** Every deploy workflow OpsCrew renders, by what it deploys, with the guard its jobs carry. */
const FLOWS: [name: string, plan: DeployPlan, guard: string, guarded: string[]][] = [
  ["a server", serverPlan(), ON_MAIN, ["build", "verify", "deploy"]],
  [
    "a server's staging, which follows its own branch",
    onBranch(inEnvironment(serverPlan(), { name: "staging", secrets: "environment" }), "staging"),
    "github.ref == 'refs/heads/staging'",
    ["build", "verify", "deploy"],
  ],
  [
    "a server's promoted prod",
    inEnvironment(serverPlan(), { deploySource: PROMOTE, secrets: "environment" }),
    ON_DEFAULT,
    ["verify", "deploy"],
  ],
  ["a further app's server", ofApp(serverPlan(), "docs"), ON_MAIN, ["build", "verify", "deploy"]],
  ["Portainer", portainerTestPlan(), ON_MAIN, ["build", "verify", "deploy"]],
  ["a hosting account with a panel", hostingPlan("cpanel"), ON_MAIN, ["build", "publish"]],
  ["an SFTP-only host", hostingPlan("sftp"), ON_MAIN, ["build", "deploy"]],
  ["Cloudflare's hosting", cloudflarePlan({ env: ["API_KEY"] }), ON_MAIN, ["build", "deploy"]],
  [
    "Cloudflare's hosting for the demo branch",
    onBranch(cloudflarePlan({ environment: "demo" }), "demo"),
    "github.ref == 'refs/heads/demo'",
    ["build", "deploy"],
  ],
  [
    "Cloudflare's hosting, promoted",
    ssrPlan({ promotedFrom: "staging", env: ["API_KEY"] }),
    ON_DEFAULT,
    ["deploy"],
  ],
  ["a further app's site on Cloudflare", ofApp(ssrPlan(), "docs"), ON_MAIN, ["build", "deploy"]],
  ["GitHub Pages", pagesPlan({ env: ["API_KEY"] }), ON_MAIN, ["build", "deploy"]],
];

describe("the deploy workflows run only on the environment's branch", () => {
  it.each(FLOWS)("%s: its build, check and deploy jobs", (_name, plan, guard, guarded) => {
    const { jobs } = workflow(plan);
    for (const id of guarded) {
      expect(jobs[id]?.if, id).toMatch(
        new RegExp(
          `^\\$\\{\\{ ${guard.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( && \\(.*\\))? \\}\\}$`,
        ),
      );
    }
  });

  it.each(FLOWS)(
    "%s: every job with a secret, or after one, runs only there",
    (_n, plan, guard) => {
      const { jobs } = workflow(plan);
      /** True when job `id` or one it needs runs only on the guard's branch. */
      const onlyThere = (id: string): boolean => {
        const job = jobs[id];
        if (job === undefined) return false;
        if (job.if?.startsWith(`\${{ ${guard}`)) return true;
        const needs = job.needs === undefined ? [] : [job.needs].flat();
        // A job runs after a skipped one only with a status check of its own; each such job here
        // names the results it needs, which the guarded jobs before it never give elsewhere.
        return needs.length > 0 && needs.every(onlyThere);
      };
      for (const [id, job] of Object.entries(jobs)) {
        if (id === "branch") continue;
        const secrets = stringify(job).match(/secrets\.(?!GITHUB_TOKEN\b)\w+/g) ?? [];
        const deploys = ["deploy", "publish", "label", "tag", "prune", "sign", "wait"].includes(id);
        if (secrets.length > 0 || deploys) expect(onlyThere(id), `${id} (${secrets})`).toBe(true);
      }
    },
  );

  it.each(FLOWS)("%s: a run on another branch fails with what to do", (_n, plan, guard) => {
    const { jobs } = workflow(plan);
    const branch = jobs.branch;
    expect(branch?.if).toBe(`\${{ !(${guard}) }}`);
    expect(branch?.needs).toBeUndefined();
    expect(branch?.permissions).toEqual({});
    const run = branch?.steps[0]?.run ?? "";
    expect(run).toContain("::error::This workflow deploys ");
    expect(run.trim().endsWith("exit 1")).toBe(true);
  });

  it("says which branch to start it on, or for a promoted environment which command", () => {
    const step = workflow(onBranch(cloudflarePlan({ environment: "demo" }), "demo")).jobs.branch
      ?.steps[0];
    expect(step?.env).toEqual({ BRANCH: "demo" });
    const bash = spawnSync("bash", ["-c", step?.run ?? ""], {
      env: { ...process.env, BRANCH: "demo", GITHUB_REF_NAME: "feature" },
      encoding: "utf8",
    });
    if (bash.error === undefined) {
      expect(bash.status).toBe(1);
      expect(bash.stdout.trim()).toBe(
        "::error::This workflow deploys demo only from the branch demo, and this run is on feature, so nothing was built or deployed. Start it on demo (Run workflow, then Use workflow from demo), or push to demo.",
      );
    }
    const promoted = workflow(ssrPlan({ promotedFrom: "staging" })).jobs.branch?.steps[0];
    expect(promoted?.env).toBeUndefined();
    expect(promoted?.run).toContain(
      "only from the repository's default branch, and this run is on $GITHUB_REF_NAME, so nothing was deployed. Start it with \\`opscrew promote --to prod\\`, which runs it there.",
    );
  });

  it("writes a quote in the branch's name twice, as an expression's string needs", () => {
    const { jobs } = workflow(onBranch(serverPlan(), "it's"));
    expect(jobs.deploy?.if).toMatch(/^\$\{\{ github\.ref == 'refs\/heads\/it''s' && \(/);
    expect(jobs.branch?.if).toBe("${{ !(github.ref == 'refs/heads/it''s') }}");
  });
});
