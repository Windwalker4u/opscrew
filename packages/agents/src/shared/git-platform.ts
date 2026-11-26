import type {
  GitPlatformClient,
  GitPlatformConnector,
  GitPlatformDefinition,
  GitPlatformPipelineRun,
  GitPlatformRemote,
} from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { detectGitPlatform, GIT_PLATFORMS } from "@opscrew/git-platforms";
import type { PhaseDeps } from "../context";
import { gitClient } from "./github";

type GitPlatformDeps = Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">;

/** A resolved git platform, its remote coordinates, and authenticated client. */
export interface GitPlatformTarget {
  platform: GitPlatformDefinition;
  remote: GitPlatformRemote;
  client: GitPlatformClient;
}

/**
 * Detects the git platform and remote coordinates from the repository's `origin` remote.
 * Returns `undefined` when `origin` is absent or not a recognised git platform.
 */
export async function detectProjectGitPlatform(
  deps: GitPlatformDeps,
  git?: string,
): Promise<{ platform: GitPlatformDefinition; remote: GitPlatformRemote } | undefined> {
  const client = gitClient(deps, git);
  const remoteUrl = await client.remoteUrl("origin");
  if (!remoteUrl) return undefined;
  return detectGitPlatform(remoteUrl, deps.env);
}

/**
 * Like {@link detectProjectGitPlatform}, stopping with a plain `PHASE_PRECONDITION` when no
 * supported git platform remote named `origin` exists.
 */
export async function requireGitPlatformRemote(
  deps: GitPlatformDeps,
  git?: string,
): Promise<{ platform: GitPlatformDefinition; remote: GitPlatformRemote }> {
  const detected = await detectProjectGitPlatform(deps, git);
  if (detected !== undefined) return detected;
  const names = listText(GIT_PLATFORMS.map((p) => p.displayName));
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This repository has no ${names} remote named origin, so there is nowhere to build and deploy from.`,
    {
      hint: GIT_PLATFORMS.map((p) => p.texts.remoteFixHint).join(" "),
    },
  );
}

/**
 * Builds the platform connector for `platform` (resolving its API token from `deps.env` or the
 * platform CLI; the connector registers the token with `deps.redactor`).
 */
export async function gitPlatformConnectorFor(
  deps: Pick<PhaseDeps, "env" | "runner" | "redactor" | "fetch" | "version">,
  platform: GitPlatformDefinition,
  host?: string,
): Promise<GitPlatformConnector> {
  const token = await platform.resolveToken(deps.env, deps.runner);
  return platform.createConnector({
    token,
    ...(host !== undefined ? { host } : {}),
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
}

/**
 * Triggers a deploy pipeline on `target` and reads back its run status once the platform returns a
 * run id. Audits the trigger as a `provider-call`.
 */
export async function dispatchPlatformPipeline(
  deps: Pick<PhaseDeps, "audit">,
  target: GitPlatformTarget,
  input: { ref: string; workflowFile?: string; inputs?: Record<string, string> },
): Promise<GitPlatformPipelineRun | undefined> {
  const started = await target.client.triggerPipeline(target.remote, input);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `trigger ${target.platform.texts.pipelineNoun}`,
    target: target.remote.fullPath,
    decision: "approved",
    detail: `ref ${input.ref}${started ? ` (run #${started.id})` : ""}`,
  });
  if (!started) return undefined;
  return target.client.getPipelineRun(target.remote, started.id);
}

/** Returns the most recent pipeline run for `target` (or `undefined` when none exist). */
export async function latestPlatformPipeline(
  target: GitPlatformTarget,
  options?: { ref?: string; workflowFile?: string },
): Promise<GitPlatformPipelineRun | undefined> {
  const runs = await target.client.listPipelineRuns(target.remote, { ...options, limit: 1 });
  return runs[0];
}

/** Retries an existing pipeline run on `target` and audits the call. */
export async function retryPlatformPipeline(
  deps: Pick<PhaseDeps, "audit">,
  target: GitPlatformTarget,
  runId: number,
): Promise<void> {
  await target.client.retryPipelineRun(target.remote, runId);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `retry ${target.platform.texts.pipelineNoun}`,
    target: target.remote.fullPath,
    decision: "approved",
    detail: `run #${runId}`,
  });
}
