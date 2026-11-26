import type { GitHubClient } from "@opscrew/connector-github";
import type {
  GitPlatformAddedDeployKey,
  GitPlatformChangeRequest,
  GitPlatformClient,
  GitPlatformDeployKey,
  GitPlatformEnvironmentCapability,
  GitPlatformPipelineRun,
  GitPlatformRemote,
  GitPlatformRepoInfo,
  GitPlatformRunnerInfo,
  GitPlatformRunnerToken,
  GitPlatformSecretOptions,
} from "@opscrew/contracts";

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
      webUrl: remote.webUrl,
    };
  }

  async fileText(
    remote: GitPlatformRemote,
    path: string,
    ref?: string,
  ): Promise<string | undefined> {
    const targetRef = ref ?? (await this.raw.getRepo(remote.owner, remote.repo)).defaultBranch;
    return this.raw.fileText(remote.owner, remote.repo, path, targetRef);
  }

  async findOpenChangeRequest(
    remote: GitPlatformRemote,
    head: string,
    base?: string,
  ): Promise<GitPlatformChangeRequest | undefined> {
    const pr = await this.raw.findOpenPullRequest(remote.owner, remote.repo, head);
    if (!pr) return undefined;
    return { number: pr.number, url: pr.url, title: "", head, base: base ?? "" };
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
      title: input.title,
      head: input.head,
      base: input.base,
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
    return { number: pr.number, url: pr.url, title: input.title, head: "", base: "" };
  }

  listDeployKeys(remote: GitPlatformRemote): Promise<GitPlatformDeployKey[]> {
    return this.raw.listDeployKeys(remote.owner, remote.repo);
  }

  addDeployKey(
    remote: GitPlatformRemote,
    input: { title: string; key: string; readOnly: boolean },
  ): Promise<GitPlatformAddedDeployKey> {
    return this.raw.addDeployKey(remote.owner, remote.repo, input.title, input.key);
  }

  removeDeployKey(remote: GitPlatformRemote, id: number): Promise<"deleted" | "absent"> {
    return this.raw.removeDeployKey(remote.owner, remote.repo, id);
  }

  async environmentCapability(
    remote: GitPlatformRemote,
  ): Promise<GitPlatformEnvironmentCapability> {
    const repo = await this.raw.getRepo(remote.owner, remote.repo);
    return {
      available: true,
      protectedAvailable: !repo.private,
      ...(repo.private
        ? {
            reason:
              "GitHub Free private repositories may not enforce environment protection rules.",
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
    await this.raw.setActionsSecret(remote.owner, remote.repo, name, value);
  }

  async secretExists(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<boolean> {
    if (options?.environment !== undefined) {
      return (
        (await this.raw.getEnvironment(remote.owner, remote.repo, options.environment)) !==
        undefined
      );
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

  getVariable(remote: GitPlatformRemote, name: string): Promise<string | undefined> {
    return this.raw.getRepoVariable(remote.owner, remote.repo, name);
  }

  setVariable(remote: GitPlatformRemote, name: string, value: string): Promise<void> {
    return this.raw.setRepoVariable(remote.owner, remote.repo, name, value);
  }

  deleteVariable(remote: GitPlatformRemote, name: string): Promise<void> {
    return this.raw.deleteRepoVariable(remote.owner, remote.repo, name);
  }

  async triggerPipeline(
    remote: GitPlatformRemote,
    input: { ref: string; workflowFile?: string; inputs?: Record<string, string> },
  ): Promise<GitPlatformPipelineRun | undefined> {
    const workflow = input.workflowFile ?? "opscrew-deploy.yml";
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
    const runs = await this.raw.listWorkflowRuns(remote.owner, remote.repo, {
      workflowFile: options?.workflowFile ?? "opscrew-deploy.yml",
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

  taggedDigest(
    remote: GitPlatformRemote,
    packageName: string,
    tag: string,
  ): Promise<string | undefined> {
    return this.raw.taggedDigest(remote.owner, packageName, tag);
  }
}
