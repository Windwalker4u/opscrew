/**
 * The outside check (research R7, contracts/outside-check-workflow.md): OpsCrew starts the
 * repository's `opscrew-outside-check.yml` on GitHub's hosted machines, which request the app on
 * ports 80 and 443 from outside the home, and reads the two jobs' conclusions. It changes nothing
 * and needs no approval. It never gets the home's address: the runner resolves the hostname
 * itself. No request from this computer ever counts as the check.
 */
import type { GitHubClient, RunJob } from "@opscrew/connector-github";
import { OpsCrewError } from "@opscrew/core";
import {
  OUTSIDE_CHECK_JOBS,
  OUTSIDE_CHECK_WORKFLOW_FILE,
  type OutsideCheckJob,
} from "@opscrew/iac-templates";
import type { PhaseDeps } from "../context";
import { codeOf } from "../shared/errors";
import { type OwnHome, updateServerAddresses } from "../shared/server-record";
import { type HomeForwardsInput, homeForwards } from "./forwards";

/** One port's result: `unfinished` is a run that didn't end in time, never a port failure. */
type PortResult = "ok" | "failed" | "unfinished" | "skipped";

/** A check from outside the home, as recorded in `.opscrew/server.json` → `own.home.outsideCheck`. */
export interface OutsideCheckResult {
  /** When the check was started (ISO 8601). */
  at: string;
  host: string;
  mode: "proxied" | "direct";
  http: PortResult;
  https: PortResult;
  runUrl: string;
}

/** The repository the check runs in, with the GitHub calls it needs. */
export interface OutsideCheckRepository {
  api: Pick<GitHubClient, "dispatchWorkflow" | "waitForWorkflowRun" | "runAttemptJobs">;
  owner: string;
  repo: string;
  defaultBranch: string;
}

/** How long OpsCrew waits for the run: each job takes at most five minutes. */
const WAIT_MS = 10 * 60_000;

/** A job's conclusion as a port's result; a job the run doesn't list was skipped. */
function portResult(jobs: readonly RunJob[], job: OutsideCheckJob): PortResult {
  const conclusion = jobs.find((found) => found.name === job)?.conclusion;
  if (conclusion === undefined || conclusion === "skipped") return "skipped";
  if (conclusion === "success") return "ok";
  if (conclusion === "failure") return "failed";
  return "unfinished";
}

/**
 * Runs the outside check for `input.host` on the default branch: the dispatch is audited as soon
 * as GitHub accepts it, the run is followed for up to 10 minutes, and the jobs of its first attempt
 * are read. The result goes into `own.home.outsideCheck` (audited). A wait that ends before the
 * run is `unfinished` on both ports.
 * @throws OpsCrewError `PHASE_PRECONDITION` when GitHub refuses the dispatch (the workflow isn't
 * on the default branch yet: the deploy-setup pull request isn't merged); GitHub's own error for a
 * missing or refused token, naming the permission.
 */
export async function runOutsideCheck(
  deps: Pick<PhaseDeps, "audit" | "reporter" | "clock" | "paths">,
  github: OutsideCheckRepository,
  input: { host: string; path: string; mode: "proxied" | "direct" },
): Promise<OutsideCheckResult> {
  const { owner, repo, defaultBranch } = github;
  const at = deps.clock.now().toISOString();
  let accepted = false;
  let dispatched: { runId: number; url: string };
  try {
    dispatched = await github.api.dispatchWorkflow(
      owner,
      repo,
      OUTSIDE_CHECK_WORKFLOW_FILE,
      defaultBranch,
      { host: input.host, path: input.path, mode: input.mode },
      async () => {
        accepted = true;
        await deps.audit.append({
          kind: "provider-call",
          actor: "opscrew",
          action: "dispatch workflow",
          target: `${owner}/${repo}`,
          detail: `outside check of ${input.host}${input.path} (${input.mode})`,
        });
      },
    );
  } catch (error) {
    if (!accepted && codeOf(error) === "PHASE_PRECONDITION") {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `GitHub can't start the outside check: ${OUTSIDE_CHECK_WORKFLOW_FILE} isn't on ${defaultBranch} yet.`,
        { hint: "Merge the deploy-setup pull request first, then run `npx opscrew verify` again." },
      );
    }
    throw error;
  }
  deps.reporter.step(`Checking your app from outside your home on GitHub (${dispatched.url})`);
  let result: OutsideCheckResult;
  try {
    const run = await github.api.waitForWorkflowRun(owner, repo, {
      workflowFile: OUTSIDE_CHECK_WORKFLOW_FILE,
      ref: defaultBranch,
      runId: dispatched.runId,
      timeoutMs: WAIT_MS,
    });
    const jobs = await github.api.runAttemptJobs(owner, repo, run.id, 1);
    result = {
      at,
      host: input.host,
      mode: input.mode,
      http: portResult(jobs, "http"),
      https: portResult(jobs, "https"),
      runUrl: run.htmlUrl,
    };
  } catch (error) {
    // The wait's timeout is the connector's PROVIDER_ERROR: the run didn't finish in time.
    if (codeOf(error) !== "PROVIDER_ERROR") throw error;
    result = {
      at,
      host: input.host,
      mode: input.mode,
      http: "unfinished",
      https: "unfinished",
      runUrl: dispatched.url,
    };
  }
  await updateServerAddresses(deps.paths, (current) => {
    if (current.own === undefined) {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        "OpsCrew has no record of your server on this computer, so it can't keep the outside check's result.",
        { hint: "Run `npx opscrew interview` for this app first." },
      );
    }
    const home: OwnHome = { ...current.own.home, outsideCheck: result };
    return { ...current, own: { ...current.own, home } };
  });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "outside check result",
    target: result.runUrl,
    detail: `${result.host} (${result.mode}): port 80 ${result.http}, port 443 ${result.https}`,
  });
  return result;
}

/** What a port that answered proves, by mode (the contract's "What it proves"). */
const ANSWERED: Record<OutsideCheckJob, Record<OutsideCheckResult["mode"], string>> = {
  http: {
    direct: "Port 80 answered from outside your home.",
    proxied: "Cloudflare answered on port 80.",
  },
  https: {
    direct:
      "Port 443 answered from outside your home, with a valid certificate and your app's health path.",
    proxied: "Port 443 answered from outside your home: Cloudflare reached your app's health path.",
  },
};

const PORT: Record<OutsideCheckJob, number> = { http: 80, https: 443 };

/**
 * The lines that tell `result`: each port's result, then, when a port failed, the possible
 * causes, the router lines ({@link homeForwards}: the forwards and the fixed LAN address), the
 * tunnel and the run's link. A check that didn't finish says to run verify again instead.
 */
export function outsideCheckLines(
  result: OutsideCheckResult,
  forwards: HomeForwardsInput,
): string[] {
  if (OUTSIDE_CHECK_JOBS.every((job) => result[job] === "unfinished")) {
    return [`The check didn't finish: run \`npx opscrew verify\` again. Its run: ${result.runUrl}`];
  }
  const lines = OUTSIDE_CHECK_JOBS.map((job) => {
    const port = PORT[job];
    const said: Record<PortResult, string> = {
      ok: ANSWERED[job][result.mode],
      failed: `Port ${port} didn't answer from outside your home.`,
      unfinished: `Port ${port}: the check didn't finish: run \`npx opscrew verify\` again. Its run: ${result.runUrl}`,
      skipped: `Port ${port} wasn't checked: see ${result.runUrl}`,
    };
    return said[result[job]];
  });
  if (OUTSIDE_CHECK_JOBS.some((job) => result[job] === "failed")) {
    lines.push(
      "Possible causes: not forwarded, blocked by your provider, or no public IPv4 address; OpsCrew can't tell which.",
      ...homeForwards(forwards),
      "Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel).",
      `The check's run: ${result.runUrl}`,
    );
  }
  return lines;
}
