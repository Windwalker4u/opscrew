import { OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, testPlan } from "../testing";
import { runDeployWorkflow } from "./site-steps";
import type { RetargetGitHubApi } from "./types";

const RUN_URL = "https://github.com/acme/shop/actions/runs/42";

/** GitHub's dispatch and wait, finishing the run with `conclusion` (or throwing `fails`). */
function workflowApi(o: { conclusion?: string | null; fails?: Error; waits?: boolean } = {}) {
  const calls: string[] = [];
  const api: Pick<RetargetGitHubApi, "dispatchWorkflow" | "waitForWorkflowRun"> = {
    async dispatchWorkflow(_owner, _repo, workflowFile, ref, _inputs, onDispatched) {
      calls.push(`dispatch ${workflowFile} ${ref}`);
      await onDispatched?.();
      return { runId: 42 } as Awaited<ReturnType<RetargetGitHubApi["dispatchWorkflow"]>>;
    },
    async waitForWorkflowRun(_owner, _repo, options) {
      calls.push(`wait ${options.runId}`);
      if (o.waits) await options.onWaiting?.(RUN_URL);
      if (o.fails !== undefined) throw o.fails;
      return {
        id: 42,
        conclusion: o.conclusion === undefined ? "success" : o.conclusion,
        htmlUrl: RUN_URL,
      };
    },
  };
  return { api, calls };
}

const TEXTS = {
  purpose: "for the new host",
  unchanged: "The old host still serves the site.",
  failedHint: "Check the workflow, then run `opscrew retarget` again.",
  unsuccessfulHint: "Push a fix, then run `opscrew retarget` again.",
};

describe("runDeployWorkflow", () => {
  it("dispatches the plan's workflow on its branch, audited under the phase, and returns the run's id", async () => {
    const deps = await createTestPhaseDeps();
    const plan = testPlan();
    const { api, calls } = workflowApi();
    const github = { api, owner: "acme", repo: "shop" };
    expect(await runDeployWorkflow(deps, github, plan, "retarget", TEXTS)).toBe(42);
    const file = plan.cicd.workflowPath.split("/").pop();
    expect(calls).toEqual([`dispatch ${file} ${plan.cicd.branch}`, "wait 42"]);
    expect(deps.audit.entries).toMatchObject([
      {
        kind: "provider-call",
        actor: "opscrew",
        action: "dispatch workflow",
        phase: "retarget",
        target: "acme/shop",
        detail: `${file} on ${plan.cicd.branch}`,
      },
      {
        kind: "provider-call",
        action: "deploy workflow",
        phase: "retarget",
        target: RUN_URL,
        decision: "approved",
        detail: "workflow run 42 finished: success",
      },
    ]);
    const said = deps.reporter.text();
    expect(said).toContain(
      `Running the deploy workflow (${file} on ${plan.cicd.branch}) for the new host`,
    );
    expect(said).toContain(`The deploy workflow succeeded (${RUN_URL}).`);
  });

  it("names the environment only when its run waits for a required reviewer", async () => {
    const deps = await createTestPhaseDeps();
    const github = { ...workflowApi({ waits: true }), owner: "acme", repo: "shop" };
    await runDeployWorkflow(deps, github, testPlan(), "cloudflare-move", TEXTS);
    expect(deps.reporter.text()).not.toContain("required reviewer");
    await runDeployWorkflow(deps, github, testPlan(), "cloudflare-move", {
      ...TEXTS,
      environment: "prod",
    });
    expect(deps.reporter.text()).toContain(
      `prod's deploy run waits in GitHub for a required reviewer: approve it at ${RUN_URL}.`,
    );
  });

  it("says what stays as it was when the run did not succeed, audited as refused", async () => {
    const deps = await createTestPhaseDeps();
    const github = { ...workflowApi({ conclusion: "failure" }), owner: "acme", repo: "shop" };
    const error = (await runDeployWorkflow(deps, github, testPlan(), "retarget", TEXTS).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      `The deploy workflow did not succeed (failure): ${RUN_URL}. The old host still serves the site.`,
    );
    expect(error.hint).toBe(TEXTS.unsuccessfulHint);
    expect(deps.audit.entries.at(-1)).toMatchObject({
      action: "deploy workflow",
      decision: "refused",
      detail: "workflow run 42 finished: failure",
    });
  });

  it("stops with the failure's reason when the run could not be started or followed", async () => {
    const deps = await createTestPhaseDeps();
    const fails = new Error("GitHub did not answer");
    const github = { ...workflowApi({ fails }), owner: "acme", repo: "shop" };
    const { unchanged: _, ...withoutUnchanged } = TEXTS;
    const error = (await runDeployWorkflow(
      deps,
      github,
      testPlan(),
      "retarget",
      withoutUnchanged,
    ).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.message).toBe("Running the deploy workflow failed: GitHub did not answer.");
    expect(error.hint?.endsWith(TEXTS.failedHint)).toBe(true);
    expect(deps.audit.entries.map((entry) => entry.action)).toEqual(["dispatch workflow"]);
  });
});
