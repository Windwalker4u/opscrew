import { randomBytes } from "node:crypto";
import type { GitHubClient } from "@opscrew/connector-github";
import type {
  GitPlatformChangeRequest,
  GitPlatformClient,
  GitPlatformEnvironmentCapability,
  GitPlatformEnvironmentProbeOptions,
  GitPlatformPipelineRun,
  GitPlatformRemote,
  GitPlatformRepoInfo,
  GitPlatformRunnerInfo,
  GitPlatformRunnerToken,
  GitPlatformSecretOptions,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";

type GitHubWorkflowRun = Awaited<ReturnType<GitHubClient["getWorkflowRun"]>>;

function mapWorkflowStatus(run: GitHubWorkflowRun): GitPlatformPipelineRun["status"] {
  if (run.status === "completed") {
    switch (run.conclusion) {
      case "success":
        return "success";
      case "cancelled":
        return "cancelled";
      case "skipped":
        return "skipped";
      case "failure":
      case "timed_out":
      case "action_required":
      case "startup_failure":
        return "failed";
      default:
        return "unknown";
    }
  }
  if (run.status === "in_progress") return "running";
  if (run.status === "queued" || run.status === "waiting" || run.status === "pending") {
    return "queued";
  }
  return "unknown";
}

function toPipelineRun(run: GitHubWorkflowRun): GitPlatformPipelineRun {
  return {
    id: run.id,
    status: mapWorkflowStatus(run),
    url: run.htmlUrl,
    ...(run.headSha ? { sha: run.headSha } : {}),
    ...(run.createdAt ? { createdAt: run.createdAt } : {}),
  };
}

function requireWorkflowFile(workflowFile: string | undefined): string {
  const trimmed = workflowFile?.trim();
  if (trimmed) return trimmed;
  throw new OpsCrewError(
    "INVALID_INPUT",
    "GitHub workflowFile is required to dispatch or list workflow runs.",
    {
      hint: "Pass the workflow file name from workflowPathFor(plan) (for example opscrew-deploy.yml or opscrew-deploy-<app>.yml).",
    },
  );
}

/** Adapts `@opscrew/connector-github`'s `GitHubClient` to the unified `GitPlatformClient` contract. */
export class GitHubPlatformClient implements GitPlatformClient {
  readonly raw: GitHubClient;

  constructor(client: GitHubClient) {
    this.raw = client;
  }

  whoAmI(): Promise<string> {
    return this.raw.whoAmI();
  }

  async getRepo(remote: GitPlatformRemote): Promise<GitPlatformRepoInfo> {
    const repo = await this.raw.getRepo(remote.owner, remote.repo);
    return {
      id: remote.fullPath,
      fullPath: remote.fullPath,
      defaultBranch: repo.defaultBranch,
      private: repo.private,
      visibility: repo.private ? "private" : "public",
      webUrl: `https://${remote.host}/${remote.fullPath}`,
    };
  }

  async findOpenChangeRequest(
    remote: GitPlatformRemote,
    head: string,
    base?: string,
  ): Promise<GitPlatformChangeRequest | undefined> {
    const pr = await this.raw.findOpenPullRequest(remote.owner, remote.repo, head);
    if (!pr) return undefined;
    if (base !== undefined && pr.base !== undefined && pr.base !== base) return undefined;
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title ?? "",
      head: pr.head ?? head,
      base: pr.base ?? base ?? "",
    };
  }

  async createChangeRequest(
    remote: GitPlatformRemote,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitPlatformChangeRequest> {
    const pr = await this.raw.createPullRequest({
      owner: remote.owner,
      repo: remote.repo,
      ...input,
    });
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title ?? input.title,
      head: pr.head ?? input.head,
      base: pr.base ?? input.base,
    };
  }

  async updateChangeRequest(
    remote: GitPlatformRemote,
    number: number,
    input: { title: string; body: string },
  ): Promise<GitPlatformChangeRequest> {
    const pr = await this.raw.updatePullRequest({
      owner: remote.owner,
      repo: remote.repo,
      number,
      ...input,
    });
    return {
      number: pr.number,
      url: pr.url,
      title: pr.title ?? input.title,
      head: pr.head ?? "",
      base: pr.base ?? "",
    };
  }

  async environmentCapability(
    remote: GitPlatformRemote,
    options?: GitPlatformEnvironmentProbeOptions,
  ): Promise<GitPlatformEnvironmentCapability> {
    const branch =
      options?.branch ?? (await this.raw.getRepo(remote.owner, remote.repo)).defaultBranch;
    const probe = options?.probeName ?? `opscrew-probe-${randomBytes(4).toString("hex")}`;
    const cap = await this.raw.environmentCapability(remote.owner, remote.repo, probe, branch);
    if (!cap.environments) {
      return {
        available: false,
        protectedAvailable: false,
        reason: "This GitHub repository does not support deployment environments.",
      };
    }
    const protectedAvailable = cap.branchPolicies && cap.reviewers;
    return {
      available: true,
      protectedAvailable,
      ...(!protectedAvailable
        ? {
            reason: cap.branchPolicies
              ? "GitHub enforces branch rules on environments in this repository, but not required reviewers."
              : "GitHub does not enforce branch rules or required reviewers on environments in this repository.",
          }
        : {}),
    };
  }

  async ensureEnvironment(remote: GitPlatformRemote, name: string): Promise<void> {
    await this.raw.putEnvironment(remote.owner, remote.repo, name, {});
  }

  deleteEnvironment(remote: GitPlatformRemote, name: string): Promise<void> {
    return this.raw.deleteEnvironment(remote.owner, remote.repo, name);
  }

  async setSecret(
    remote: GitPlatformRemote,
    name: string,
    value: string,
    options?: GitPlatformSecretOptions,
  ): Promise<void> {
    if (options?.environment !== undefined) {
      await this.raw.setEnvironmentSecret(
        remote.owner,
        remote.repo,
        options.environment,
        name,
        value,
      );
      return;
    }
    if (options?.protected === true) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `GitHub repository secret "${name}" cannot be restricted to protected branches without an environment.`,
        {
          hint: "Pass an environment name to store a branch-restricted secret in a GitHub environment.",
        },
      );
    }
    await this.raw.setActionsSecret(remote.owner, remote.repo, name, value);
  }

  async secretExists(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<boolean> {
    if (options?.environment !== undefined) {
      return this.raw.environmentSecretExists(remote.owner, remote.repo, options.environment, name);
    }
    return this.raw.actionsSecretExists(remote.owner, remote.repo, name);
  }

  async deleteSecret(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<void> {
    if (options?.environment !== undefined) {
      await this.raw.deleteEnvironmentSecret(remote.owner, remote.repo, options.environment, name);
      return;
    }
    await this.raw.deleteActionsSecret(remote.owner, remote.repo, name);
  }

  async triggerPipeline(
    remote: GitPlatformRemote,
    input: { ref: string; workflowFile?: string; inputs?: Record<string, string> },
  ): Promise<GitPlatformPipelineRun | undefined> {
    const workflow = requireWorkflowFile(input.workflowFile);
    const dispatched = await this.raw.dispatchWorkflow(
      remote.owner,
      remote.repo,
      workflow,
      input.ref,
      input.inputs,
    );
    return { id: dispatched.runId, status: "queued", url: dispatched.url, ref: input.ref };
  }

  async listPipelineRuns(
    remote: GitPlatformRemote,
    options?: { ref?: string; workflowFile?: string; limit?: number },
  ): Promise<GitPlatformPipelineRun[]> {
    const workflowFile = requireWorkflowFile(options?.workflowFile);
    const runs = await this.raw.listWorkflowRuns(remote.owner, remote.repo, {
      workflowFile,
      ...(options?.ref !== undefined ? { branch: options.ref } : {}),
      ...(options?.limit !== undefined ? { perPage: options.limit } : {}),
    });
    return runs.map(toPipelineRun);
  }

  async getPipelineRun(remote: GitPlatformRemote, runId: number): Promise<GitPlatformPipelineRun> {
    return toPipelineRun(await this.raw.getWorkflowRun(remote.owner, remote.repo, runId));
  }

  retryPipelineRun(remote: GitPlatformRemote, runId: number): Promise<void> {
    return this.raw.rerunWorkflowRun(remote.owner, remote.repo, runId);
  }

  async listRunners(remote: GitPlatformRemote): Promise<GitPlatformRunnerInfo[]> {
    const runners = await this.raw.listRunners(remote.owner, remote.repo);
    return runners.map((runner) => ({
      id: runner.id,
      name: runner.name,
      online: runner.status === "online",
      busy: runner.busy === true,
      labels: runner.labels,
    }));
  }

  async createRunnerToken(remote: GitPlatformRemote): Promise<GitPlatformRunnerToken> {
    const token = await this.raw.runnerRegistrationToken(remote.owner, remote.repo);
    return { token };
  }

  deleteRunner(remote: GitPlatformRemote, id: number): Promise<void> {
    return this.raw.deleteRunner(remote.owner, remote.repo, id);
  }
}
