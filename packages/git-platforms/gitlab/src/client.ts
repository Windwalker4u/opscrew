import type {
  FetchLike,
  GitPlatformChangeRequest,
  GitPlatformClient,
  GitPlatformEnvironmentCapability,
  GitPlatformPipelineRun,
  GitPlatformRemote,
  GitPlatformRepoInfo,
  GitPlatformRunnerInfo,
  GitPlatformRunnerToken,
  GitPlatformSecretOptions,
  ProviderRedactor,
} from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";
import { z } from "zod";

const UserSchema = z.looseObject({ username: z.string().min(1) });
const ProjectSchema = z.looseObject({
  id: z.number(),
  path_with_namespace: z.string(),
  default_branch: z.string().nullable().optional(),
  visibility: z.enum(["public", "internal", "private"]).optional(),
  web_url: z.string(),
});
const MergeRequestSchema = z.looseObject({
  iid: z.number(),
  web_url: z.string(),
  title: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
});
const EnvironmentSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
});
const PipelineSchema = z.looseObject({
  id: z.number(),
  status: z.string(),
  web_url: z.string(),
  ref: z.string().optional(),
  sha: z.string().optional(),
  created_at: z.string().optional(),
});
const RunnerSchema = z.looseObject({
  id: z.number(),
  description: z.string().nullable().optional(),
  online: z.boolean().optional(),
  status: z.string().optional(),
  tag_list: z.array(z.string()).optional(),
});
const CreatedRunnerSchema = z.looseObject({
  id: z.number(),
  token: z.string().min(1),
});

/** GitLab's official masking rules (docs.gitlab.com/ee/ci/variables/#mask-a-cicd-variable). */
export function isGitLabMaskable(value: string): boolean {
  if (value.length < 8) return false;
  if (/[\r\n\s]/.test(value)) return false;
  return /^[A-Za-z0-9+/=:@.~_-]+$/.test(value);
}

function mapPipelineStatus(status: string): GitPlatformPipelineRun["status"] {
  switch (status) {
    case "created":
    case "waiting_for_resource":
    case "preparing":
    case "pending":
    case "manual":
    case "scheduled":
      return "queued";
    case "running":
      return "running";
    case "success":
      return "success";
    case "failed":
      return "failed";
    case "canceled":
    case "canceling":
      return "cancelled";
    case "skipped":
      return "skipped";
    default:
      return "unknown";
  }
}

function toPipelineRun(p: z.infer<typeof PipelineSchema>): GitPlatformPipelineRun {
  return {
    id: p.id,
    status: mapPipelineStatus(p.status),
    url: p.web_url,
    ...(p.ref !== undefined ? { ref: p.ref } : {}),
    ...(p.sha !== undefined ? { sha: p.sha } : {}),
    ...(p.created_at !== undefined ? { createdAt: p.created_at } : {}),
  };
}

export interface GitLabClientOptions {
  token: string;
  host?: string;
  fetch: FetchLike;
  redactor?: ProviderRedactor;
  version?: string;
}

/** GitLab REST API v4 client implementing {@link GitPlatformClient}. */
export class GitLabClient implements GitPlatformClient {
  readonly #token: string;
  readonly #defaultHost: string;
  readonly #fetch: FetchLike;
  readonly #redactor: ProviderRedactor;
  readonly #userAgent: string;

  constructor(options: GitLabClientOptions) {
    this.#token = options.token;
    this.#defaultHost = (options.host ?? "gitlab.com")
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "");
    this.#fetch = options.fetch;
    this.#redactor = options.redactor ?? new Redactor();
    this.#redactor.addLiteral(options.token, "gitlab-token");
    this.#userAgent = `opscrew/${options.version ?? "0.1.0"}`;
  }

  #base(host?: string): string {
    return `https://${host ?? this.#defaultHost}/api/v4`;
  }

  #project(remote: GitPlatformRemote): string {
    return encodeURIComponent(remote.fullPath);
  }

  async #request(
    method: string,
    path: string,
    what: string,
    options: { host?: string; body?: unknown; ok?: readonly number[] } = {},
  ): Promise<{ status: number; json: unknown }> {
    const url = `${this.#base(options.host)}${path}`;
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": this.#token,
      "User-Agent": this.#userAgent,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    const response = await this.#fetch(url, init);
    const text = await response.text();
    let json: unknown;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (response.ok || (options.ok?.includes(response.status) ?? false)) {
      return { status: response.status, json };
    }
    const detail = this.#redactor.redact(
      typeof json === "object" && json !== null && "message" in json
        ? String((json as { message: unknown }).message)
        : `HTTP ${response.status}`,
    );
    if (response.status === 401 || response.status === 403) {
      throw new OpsCrewError("CREDENTIALS_INVALID", `GitLab refused to ${what}: ${detail}.`, {
        hint: "Check GITLAB_TOKEN (needs api scope, or create_runner for self-hosted runners) and your project role (Maintainer or Owner).",
      });
    }
    throw new OpsCrewError("PROVIDER_ERROR", `GitLab could not ${what}: ${detail}.`);
  }

  #parse<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const parsed = schema.safeParse(json);
    if (parsed.success) return parsed.data;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `GitLab sent an unexpected response while trying to ${what}.`,
    );
  }

  async whoAmI(): Promise<string> {
    const { json } = await this.#request("GET", "/user", "check your GitLab token");
    return this.#parse(UserSchema, json, "check your GitLab token").username;
  }

  async getRepo(remote: GitPlatformRemote): Promise<GitPlatformRepoInfo> {
    const what = `read ${remote.fullPath}`;
    const { json } = await this.#request("GET", `/projects/${this.#project(remote)}`, what, {
      host: remote.host,
    });
    const project = this.#parse(ProjectSchema, json, what);
    const visibility = project.visibility ?? "private";
    return {
      id: project.id,
      fullPath: project.path_with_namespace,
      defaultBranch: project.default_branch ?? "main",
      private: visibility !== "public",
      visibility,
      webUrl: project.web_url,
    };
  }

  async findOpenChangeRequest(
    remote: GitPlatformRemote,
    head: string,
    base?: string,
  ): Promise<GitPlatformChangeRequest | undefined> {
    const what = "look for an open merge request";
    const query = new URLSearchParams({
      state: "opened",
      source_branch: head,
      per_page: "1",
      ...(base !== undefined ? { target_branch: base } : {}),
    });
    const { json } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/merge_requests?${query}`,
      what,
      { host: remote.host },
    );
    const first = this.#parse(z.array(MergeRequestSchema), json, what)[0];
    if (!first) return undefined;
    return {
      number: first.iid,
      url: first.web_url,
      title: first.title,
      head: first.source_branch,
      base: first.target_branch,
    };
  }

  async createChangeRequest(
    remote: GitPlatformRemote,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitPlatformChangeRequest> {
    const what = "open a merge request";
    const { json } = await this.#request(
      "POST",
      `/projects/${this.#project(remote)}/merge_requests`,
      what,
      {
        host: remote.host,
        body: {
          title: input.title,
          description: input.body,
          source_branch: input.head,
          target_branch: input.base,
        },
      },
    );
    const mr = this.#parse(MergeRequestSchema, json, what);
    return {
      number: mr.iid,
      url: mr.web_url,
      title: mr.title,
      head: mr.source_branch,
      base: mr.target_branch,
    };
  }

  async updateChangeRequest(
    remote: GitPlatformRemote,
    number: number,
    input: { title: string; body: string },
  ): Promise<GitPlatformChangeRequest> {
    const what = `update merge request !${number}`;
    const { json } = await this.#request(
      "PUT",
      `/projects/${this.#project(remote)}/merge_requests/${number}`,
      what,
      {
        host: remote.host,
        body: { title: input.title, description: input.body },
      },
    );
    const mr = this.#parse(MergeRequestSchema, json, what);
    return {
      number: mr.iid,
      url: mr.web_url,
      title: mr.title,
      head: mr.source_branch,
      base: mr.target_branch,
    };
  }

  async environmentCapability(
    remote: GitPlatformRemote,
  ): Promise<GitPlatformEnvironmentCapability> {
    const { status } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/protected_environments`,
      "check protected environments support",
      { host: remote.host, ok: [403, 404] },
    );
    if (status === 403 || status === 404) {
      return {
        available: true,
        protectedAvailable: false,
        reason:
          "Protected environments require GitLab Premium or Ultimate; project-level environment_scope CI/CD variables still work on GitLab Free.",
      };
    }
    return { available: true, protectedAvailable: true };
  }

  async ensureEnvironment(remote: GitPlatformRemote, name: string): Promise<void> {
    const query = new URLSearchParams({ name });
    const { json } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/environments?${query}`,
      `list environment ${name}`,
      { host: remote.host },
    );
    const existing = this.#parse(z.array(EnvironmentSchema), json, "list environments").find(
      (e) => e.name === name,
    );
    if (existing) return;
    await this.#request(
      "POST",
      `/projects/${this.#project(remote)}/environments`,
      `create environment ${name}`,
      { host: remote.host, body: { name } },
    );
  }

  async deleteEnvironment(remote: GitPlatformRemote, name: string): Promise<void> {
    const query = new URLSearchParams({ name });
    const { json } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/environments?${query}`,
      `find environment ${name}`,
      { host: remote.host },
    );
    const existing = this.#parse(z.array(EnvironmentSchema), json, "find environment").find(
      (e) => e.name === name,
    );
    if (!existing) return;
    await this.#request(
      "POST",
      `/projects/${this.#project(remote)}/environments/${existing.id}/stop`,
      `stop environment ${name}`,
      { host: remote.host, ok: [400, 404] },
    );
    await this.#request(
      "DELETE",
      `/projects/${this.#project(remote)}/environments/${existing.id}`,
      `delete environment ${name}`,
      { host: remote.host, ok: [404] },
    );
  }

  async setSecret(
    remote: GitPlatformRemote,
    name: string,
    value: string,
    options?: GitPlatformSecretOptions,
  ): Promise<void> {
    const scope = options?.environment ?? "*";
    const asFile = /[\r\n]/.test(value);
    const storedValue = asFile && !value.endsWith("\n") ? `${value}\n` : value;
    const masked = !asFile && isGitLabMaskable(storedValue);
    const payload = {
      key: name,
      value: storedValue,
      variable_type: asFile ? "file" : "env_var",
      protected: options?.protected ?? false,
      masked,
      raw: true,
      environment_scope: scope,
    };
    const filter = new URLSearchParams({ "filter[environment_scope]": scope });
    const { status } = await this.#request(
      "PUT",
      `/projects/${this.#project(remote)}/variables/${encodeURIComponent(name)}?${filter}`,
      `update CI/CD variable ${name}`,
      { host: remote.host, body: payload, ok: [404] },
    );
    if (status === 404) {
      await this.#request(
        "POST",
        `/projects/${this.#project(remote)}/variables`,
        `create CI/CD variable ${name}`,
        { host: remote.host, body: payload },
      );
    }
  }

  async secretExists(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<boolean> {
    const scope = options?.environment ?? "*";
    const filter = new URLSearchParams({ "filter[environment_scope]": scope });
    const { status } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/variables/${encodeURIComponent(name)}?${filter}`,
      `check CI/CD variable ${name}`,
      { host: remote.host, ok: [404] },
    );
    return status !== 404;
  }

  async deleteSecret(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<void> {
    const scope = options?.environment ?? "*";
    const filter = new URLSearchParams({ "filter[environment_scope]": scope });
    await this.#request(
      "DELETE",
      `/projects/${this.#project(remote)}/variables/${encodeURIComponent(name)}?${filter}`,
      `delete CI/CD variable ${name}`,
      { host: remote.host, ok: [404] },
    );
  }

  async triggerPipeline(
    remote: GitPlatformRemote,
    input: { ref: string; workflowFile?: string; inputs?: Record<string, string> },
  ): Promise<GitPlatformPipelineRun | undefined> {
    const what = `start a pipeline on ${input.ref}`;
    const variables = Object.entries(input.inputs ?? {}).map(([key, value]) => ({
      key,
      value,
      variable_type: "env_var",
    }));
    const { json } = await this.#request(
      "POST",
      `/projects/${this.#project(remote)}/pipeline`,
      what,
      {
        host: remote.host,
        body: { ref: input.ref, ...(variables.length > 0 ? { variables } : {}) },
      },
    );
    return toPipelineRun(this.#parse(PipelineSchema, json, what));
  }

  async listPipelineRuns(
    remote: GitPlatformRemote,
    options?: { ref?: string; workflowFile?: string; limit?: number },
  ): Promise<GitPlatformPipelineRun[]> {
    const what = "list pipelines";
    const query = new URLSearchParams({
      per_page: String(options?.limit ?? 5),
      ...(options?.ref !== undefined ? { ref: options.ref } : {}),
    });
    const { json } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/pipelines?${query}`,
      what,
      { host: remote.host },
    );
    return this.#parse(z.array(PipelineSchema), json, what).map(toPipelineRun);
  }

  async getPipelineRun(remote: GitPlatformRemote, runId: number): Promise<GitPlatformPipelineRun> {
    const what = `read pipeline #${runId}`;
    const { json } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/pipelines/${runId}`,
      what,
      { host: remote.host },
    );
    return toPipelineRun(this.#parse(PipelineSchema, json, what));
  }

  async retryPipelineRun(remote: GitPlatformRemote, runId: number): Promise<void> {
    await this.#request(
      "POST",
      `/projects/${this.#project(remote)}/pipelines/${runId}/retry`,
      `retry pipeline #${runId}`,
      { host: remote.host },
    );
  }

  async listRunners(remote: GitPlatformRemote): Promise<GitPlatformRunnerInfo[]> {
    const what = "list project runners";
    const { json } = await this.#request(
      "GET",
      `/projects/${this.#project(remote)}/runners`,
      what,
      { host: remote.host },
    );
    return this.#parse(z.array(RunnerSchema), json, what).map((runner) => ({
      id: runner.id,
      name: runner.description ?? `runner-${runner.id}`,
      online: runner.online === true || runner.status === "online",
      busy: false,
      labels: runner.tag_list ?? [],
    }));
  }

  async createRunnerToken(
    remote: GitPlatformRemote,
    options?: { description?: string; labels?: readonly string[] },
  ): Promise<GitPlatformRunnerToken> {
    const repo = await this.getRepo(remote);
    const what = "create a GitLab project runner";
    const { json } = await this.#request("POST", "/user/runners", what, {
      host: remote.host,
      body: {
        runner_type: "project_type",
        project_id: repo.id,
        description: options?.description ?? `OpsCrew runner (${remote.fullPath})`,
        ...(options?.labels && options.labels.length > 0 ? { tag_list: [...options.labels] } : {}),
        run_untagged: false,
        locked: true,
      },
    });
    const created = this.#parse(CreatedRunnerSchema, json, what);
    this.#redactor.addLiteral(created.token, "gitlab-runner-token");
    return { token: created.token, runnerId: created.id };
  }

  async deleteRunner(remote: GitPlatformRemote, id: number): Promise<void> {
    await this.#request("DELETE", `/runners/${id}`, `delete runner ${id}`, {
      host: remote.host,
      ok: [404],
    });
  }
}
