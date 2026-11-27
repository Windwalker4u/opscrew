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
import { type ForgeFlavor, normalizeForgeHost } from "./remote";

export interface ForgejoGiteaClientOptions {
  flavor: ForgeFlavor;
  token: string;
  host: string;
  fetch: FetchLike;
  redactor?: ProviderRedactor;
  version?: string;
}

const UserSchema = z.object({ login: z.string().min(1) });
const RepoSchema = z.object({
  id: z.number(),
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
  private: z.boolean(),
  html_url: z.string().min(1),
});
const PullSchema = z.object({
  number: z.number(),
  html_url: z.string().min(1),
  title: z.string(),
  head: z.object({ ref: z.string().optional(), label: z.string().optional() }).optional(),
  base: z.object({ ref: z.string().optional() }).optional(),
});
const SecretItemSchema = z.object({ name: z.string() });
const RegistrationTokenSchema = z.object({ token: z.string().min(1) });
const RunnerLabelSchema = z.union([z.string(), z.object({ name: z.string() })]);
const RunnerSchema = z.object({
  id: z.number(),
  name: z.string(),
  status: z.string().optional(),
  busy: z.boolean().optional(),
  labels: z.array(RunnerLabelSchema).optional(),
});
const RunnersResponseSchema = z.union([
  z.array(RunnerSchema),
  z.object({ runners: z.array(RunnerSchema).optional() }),
]);
const RunItemSchema = z.object({
  id: z.number(),
  status: z.string().optional(),
  conclusion: z.string().optional(),
  html_url: z.string().optional(),
  url: z.string().optional(),
  prettyref: z.string().optional(),
  head_branch: z.string().optional(),
  commit_sha: z.string().optional(),
  head_sha: z.string().optional(),
  created: z.string().optional(),
  created_at: z.string().optional(),
  workflow_id: z.string().optional(),
  path: z.string().optional(),
  index_in_repo: z.number().optional(),
  run_number: z.number().optional(),
});
const RunsListSchema = z.object({
  workflow_runs: z.array(RunItemSchema).optional(),
});
const DispatchRunSchema = z.object({
  id: z.number().optional(),
  run_id: z.number().optional(),
  run_number: z.number().optional(),
  html_url: z.string().optional(),
});

function normalizeRunStatus(
  status?: string,
  conclusion?: string,
): GitPlatformPipelineRun["status"] {
  const value = (conclusion || status || "").toLowerCase();
  if (value === "success" || value === "completed") return "success";
  if (value === "failure" || value === "failed" || value === "timed_out") return "failed";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  if (value === "skipped") return "skipped";
  if (value === "running" || value === "in_progress") return "running";
  if (value === "waiting" || value === "queued" || value === "pending" || value === "blocked") {
    return "queued";
  }
  return "unknown";
}

function repoBase(remote: GitPlatformRemote): string {
  return `/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`;
}

function repoWebUrl(remote: GitPlatformRemote): string {
  return `https://${remote.host}/${remote.fullPath}`;
}

function workflowFileName(workflowFile: string): string {
  const trimmed = workflowFile.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Shared typed REST v1 client for Forgejo and Gitea (Feature 043).
 *
 * Parameterized by `flavor: "forgejo" | "gitea"` for the three verified protocol divergences:
 * 1. Runner registration token uses `GET` on Forgejo vs `POST` on Gitea.
 * 2. Workflow dispatch requests run metadata via JSON body `return_run_info: true` on Forgejo
 *    vs query `?return_run_details=true` on Gitea.
 * 3. Workflow run listing filters by `ref` on Forgejo vs `branch` on Gitea, and normalizes both
 *    `ActionRun` (`prettyref`/`commit_sha`/`created`) and `ActionWorkflowRun`
 *    (`head_branch`/`head_sha`/`created_at`/`conclusion`).
 */
export class ForgejoGiteaClient implements GitPlatformClient {
  readonly flavor: ForgeFlavor;
  private readonly host: string;
  private readonly apiBase: string;
  private readonly token: string;
  private readonly fetch: FetchLike;
  private readonly redactor: ProviderRedactor;
  private readonly userAgent: string;
  private readonly displayName: string;

  constructor(options: ForgejoGiteaClientOptions) {
    this.flavor = options.flavor;
    this.displayName = options.flavor === "forgejo" ? "Forgejo" : "Gitea";
    this.host =
      normalizeForgeHost(options.host) ??
      options.host
        .trim()
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .toLowerCase();
    this.apiBase = `https://${this.host}/api/v1`;
    this.token = options.token;
    this.fetch = options.fetch;
    this.redactor = options.redactor ?? new Redactor();
    this.redactor.addLiteral(options.token, `${options.flavor}-token`);
    this.userAgent = `opscrew/${options.version ?? "0.0.0"}`;
  }

  /**
   * Ensures a caller never sends a token configured for one Forgejo/Gitea host to a remote on
   * another host.
   */
  private assertHost(remote: GitPlatformRemote): void {
    const remoteHost = normalizeForgeHost(remote.host);
    if (remoteHost !== this.host) {
      const hostEnv = this.flavor === "forgejo" ? "FORGEJO_HOST" : "GITEA_HOST";
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${this.displayName} client is configured for ${this.host}, not ${remote.host}.`,
        {
          hint: `Set ${hostEnv}=${remote.host} (or cicd.host in opscrew/plan.yaml) so OpsCrew uses a token scoped to ${remote.host}.`,
        },
      );
    }
  }

  /** Parses an API payload with `schema.safeParse`, throwing a redacted `PROVIDER_ERROR` on failure. */
  private parsePayload<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
    const result = schema.safeParse(data);
    if (result.success) return result.data;
    const summary = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    const safeSummary = this.redactor.redact(summary || "invalid response shape");
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${this.displayName} returned an unexpected ${what} response: ${safeSummary}`,
      {
        hint: `Check that https://${this.host} is a supported ${this.displayName} instance and try again.`,
      },
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    allowStatus: readonly number[] = [],
  ): Promise<{ status: number; data: unknown }> {
    const url = `${this.apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    let response: Response;
    try {
      response = await this.fetch(url, init);
    } catch (error) {
      const detail = this.redactor.redact(error instanceof Error ? error.message : String(error));
      throw new OpsCrewError(
        "PROVIDER_ERROR",
        `Could not reach ${this.displayName} at ${this.host}: ${detail}`,
        { hint: `Check your network connection and that https://${this.host} is reachable.` },
      );
    }
    const text = await response.text();
    let data: unknown;
    if (text.length > 0) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (response.ok || allowStatus.includes(response.status)) {
      return { status: response.status, data };
    }
    const apiMessage =
      typeof data === "object" && data !== null && "message" in data
        ? String((data as { message?: unknown }).message ?? "")
        : text.slice(0, 200);
    const safeMsg = this.redactor.redact(apiMessage || `HTTP ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      throw new OpsCrewError(
        "CREDENTIALS_INVALID",
        `${this.displayName} rejected the token (${response.status}): ${safeMsg}`,
        {
          hint: `Check ${this.flavor === "forgejo" ? "FORGEJO_TOKEN" : "GITEA_TOKEN"} permissions (repository write and package read/write) on ${this.host}.`,
        },
      );
    }
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `${this.displayName} API ${method} ${path} failed (${response.status}): ${safeMsg}`,
    );
  }

  async whoAmI(): Promise<string> {
    const { data } = await this.request("GET", "/user");
    return this.parsePayload(UserSchema, data, "user").login;
  }

  async getRepo(remote: GitPlatformRemote): Promise<GitPlatformRepoInfo> {
    this.assertHost(remote);
    const { data } = await this.request("GET", repoBase(remote));
    const parsed = this.parsePayload(RepoSchema, data, "repository");
    return {
      id: parsed.id,
      fullPath: parsed.full_name,
      defaultBranch: parsed.default_branch,
      private: parsed.private,
      visibility: parsed.private ? "private" : "public",
      webUrl: parsed.html_url,
    };
  }

  async findOpenChangeRequest(
    remote: GitPlatformRemote,
    head: string,
    base?: string,
  ): Promise<GitPlatformChangeRequest | undefined> {
    this.assertHost(remote);
    const params = new URLSearchParams({ state: "open", limit: "50" });
    if (base) {
      params.set(this.flavor === "forgejo" ? "base" : "base_branch", base);
    }
    const { data } = await this.request("GET", `${repoBase(remote)}/pulls?${params.toString()}`);
    const list = this.parsePayload(z.array(PullSchema), data, "pull request list");
    const match = list.find((pr) => {
      const headRef = pr.head?.ref ?? pr.head?.label;
      const headOk = headRef === head || headRef === `${remote.owner}:${head}`;
      const baseOk = base === undefined || pr.base?.ref === base;
      return headOk && baseOk;
    });
    if (!match) return undefined;
    return {
      number: match.number,
      url: match.html_url,
      title: match.title,
      head: match.head?.ref ?? head,
      base: match.base?.ref ?? base ?? "",
    };
  }

  async createChangeRequest(
    remote: GitPlatformRemote,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitPlatformChangeRequest> {
    this.assertHost(remote);
    const { data } = await this.request("POST", `${repoBase(remote)}/pulls`, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base,
    });
    const pr = this.parsePayload(PullSchema, data, "pull request");
    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      head: pr.head?.ref ?? input.head,
      base: pr.base?.ref ?? input.base,
    };
  }

  async updateChangeRequest(
    remote: GitPlatformRemote,
    number: number,
    input: { title: string; body: string },
  ): Promise<GitPlatformChangeRequest> {
    this.assertHost(remote);
    const { data } = await this.request("PATCH", `${repoBase(remote)}/pulls/${number}`, {
      title: input.title,
      body: input.body,
    });
    const pr = this.parsePayload(PullSchema, data, "pull request");
    return {
      number: pr.number,
      url: pr.html_url,
      title: pr.title,
      head: pr.head?.ref ?? "",
      base: pr.base?.ref ?? "",
    };
  }

  async environmentCapability(
    remote: GitPlatformRemote,
  ): Promise<GitPlatformEnvironmentCapability> {
    this.assertHost(remote);
    return {
      available: false,
      protectedAvailable: false,
      reason: `${this.displayName} does not support deployment environments; OpsCrew stores secrets at repository scope with per-environment prefixes.`,
    };
  }

  async ensureEnvironment(remote: GitPlatformRemote, _name: string): Promise<void> {
    this.assertHost(remote);
    // No-op: neither Forgejo nor Gitea has a deployment environments API.
  }

  async deleteEnvironment(remote: GitPlatformRemote, _name: string): Promise<void> {
    this.assertHost(remote);
    // No-op: neither Forgejo nor Gitea has a deployment environments API.
  }

  async setSecret(
    remote: GitPlatformRemote,
    name: string,
    value: string,
    _options?: GitPlatformSecretOptions,
  ): Promise<void> {
    this.assertHost(remote);
    this.redactor.addLiteral(value, `secret:${name}`);
    await this.request("PUT", `${repoBase(remote)}/actions/secrets/${encodeURIComponent(name)}`, {
      data: value,
    });
  }

  async secretExists(
    remote: GitPlatformRemote,
    name: string,
    _options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<boolean> {
    this.assertHost(remote);
    const target = name.toUpperCase();
    for (let page = 1; page <= 10; page++) {
      const { status, data } = await this.request(
        "GET",
        `${repoBase(remote)}/actions/secrets?page=${page}&limit=50`,
        undefined,
        [404],
      );
      if (status === 404) return false;
      const list = this.parsePayload(z.array(SecretItemSchema), data, "secrets list");
      if (list.some((item) => item.name.toUpperCase() === target)) return true;
      if (list.length < 50) return false;
    }
    return false;
  }

  async deleteSecret(
    remote: GitPlatformRemote,
    name: string,
    _options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<void> {
    this.assertHost(remote);
    await this.request(
      "DELETE",
      `${repoBase(remote)}/actions/secrets/${encodeURIComponent(name)}`,
      undefined,
      [404],
    );
  }

  private mapRun(
    remote: GitPlatformRemote,
    raw: z.infer<typeof RunItemSchema>,
  ): GitPlatformPipelineRun {
    const runUrl =
      raw.html_url ||
      raw.url ||
      `${repoWebUrl(remote)}/actions/runs/${raw.index_in_repo ?? raw.run_number ?? raw.id}`;
    return {
      id: raw.id,
      status: normalizeRunStatus(raw.status, raw.conclusion),
      url: runUrl,
      ...((raw.head_branch ?? raw.prettyref) ? { ref: raw.head_branch ?? raw.prettyref } : {}),
      ...((raw.head_sha ?? raw.commit_sha) ? { sha: raw.head_sha ?? raw.commit_sha } : {}),
      ...((raw.created_at ?? raw.created) ? { createdAt: raw.created_at ?? raw.created } : {}),
    };
  }

  async triggerPipeline(
    remote: GitPlatformRemote,
    input: { ref: string; workflowFile?: string; inputs?: Record<string, string> },
  ): Promise<GitPlatformPipelineRun | undefined> {
    this.assertHost(remote);
    if (!input.workflowFile?.trim()) {
      throw new OpsCrewError(
        "INVALID_INPUT",
        `${this.displayName} workflowFile is required to dispatch a workflow run.`,
      );
    }
    const workflow = encodeURIComponent(workflowFileName(input.workflowFile));
    const isForgejo = this.flavor === "forgejo";
    const query = isForgejo ? "" : "?return_run_details=true";
    const body = isForgejo
      ? {
          ref: input.ref,
          ...(input.inputs ? { inputs: input.inputs } : {}),
          return_run_info: true,
        }
      : {
          ref: input.ref,
          ...(input.inputs ? { inputs: input.inputs } : {}),
        };
    const { status, data } = await this.request(
      "POST",
      `${repoBase(remote)}/actions/workflows/${workflow}/dispatches${query}`,
      body,
    );
    if (status === 204 || !data || typeof data !== "object") return undefined;
    const parsed = DispatchRunSchema.safeParse(data);
    if (!parsed.success) return undefined;
    const id = parsed.data.id ?? parsed.data.run_id;
    if (id === undefined) return undefined;
    return {
      id,
      status: "queued",
      url:
        parsed.data.html_url ??
        `${repoWebUrl(remote)}/actions/runs/${parsed.data.run_number ?? id}`,
      ref: input.ref,
    };
  }

  async listPipelineRuns(
    remote: GitPlatformRemote,
    options?: { ref?: string; workflowFile?: string; limit?: number },
  ): Promise<GitPlatformPipelineRun[]> {
    this.assertHost(remote);
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.ref) {
      params.set(this.flavor === "forgejo" ? "ref" : "branch", options.ref);
    }
    if (options?.workflowFile && this.flavor === "forgejo") {
      params.set("workflow_id", workflowFileName(options.workflowFile));
    }
    const qs = params.toString();
    const { status, data } = await this.request(
      "GET",
      `${repoBase(remote)}/actions/runs${qs ? `?${qs}` : ""}`,
      undefined,
      [404],
    );
    let rawRuns: z.infer<typeof RunItemSchema>[] = [];
    if (status === 404) {
      const fallback = await this.request(
        "GET",
        `${repoBase(remote)}/actions/tasks${options?.limit ? `?limit=${options.limit}` : ""}`,
      );
      rawRuns =
        this.parsePayload(RunsListSchema, fallback.data, "workflow runs").workflow_runs ?? [];
    } else {
      rawRuns = this.parsePayload(RunsListSchema, data, "workflow runs").workflow_runs ?? [];
    }
    const wantedWorkflow = options?.workflowFile
      ? workflowFileName(options.workflowFile)
      : undefined;
    const filtered = rawRuns.filter((run) => {
      if (wantedWorkflow) {
        const wf = run.workflow_id ?? run.path ?? "";
        if (wf && !wf.endsWith(wantedWorkflow)) return false;
      }
      if (options?.ref) {
        const runRef = run.head_branch ?? run.prettyref;
        if (runRef && runRef !== options.ref && runRef !== `refs/heads/${options.ref}`) {
          return false;
        }
      }
      return true;
    });
    return filtered.map((run) => this.mapRun(remote, run));
  }

  async getPipelineRun(remote: GitPlatformRemote, runId: number): Promise<GitPlatformPipelineRun> {
    this.assertHost(remote);
    const { data } = await this.request("GET", `${repoBase(remote)}/actions/runs/${runId}`);
    return this.mapRun(remote, this.parsePayload(RunItemSchema, data, "workflow run"));
  }

  async retryPipelineRun(remote: GitPlatformRemote, runId: number): Promise<void> {
    this.assertHost(remote);
    await this.request("POST", `${repoBase(remote)}/actions/runs/${runId}/rerun`);
  }

  async listRunners(remote: GitPlatformRemote): Promise<GitPlatformRunnerInfo[]> {
    this.assertHost(remote);
    const { data } = await this.request("GET", `${repoBase(remote)}/actions/runners`);
    const parsed = this.parsePayload(RunnersResponseSchema, data, "runners list");
    const items = Array.isArray(parsed) ? parsed : (parsed.runners ?? []);
    return items.map((r) => {
      const status = (r.status ?? "").toLowerCase();
      return {
        id: r.id,
        name: r.name,
        online: status === "idle" || status === "active" || status === "online",
        busy: r.busy ?? status === "active",
        labels: (r.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
      };
    });
  }

  async createRunnerToken(
    remote: GitPlatformRemote,
    _options?: { description?: string; labels?: readonly string[] },
  ): Promise<GitPlatformRunnerToken> {
    this.assertHost(remote);
    const method = this.flavor === "forgejo" ? "GET" : "POST";
    const { data } = await this.request(
      method,
      `${repoBase(remote)}/actions/runners/registration-token`,
    );
    const { token } = this.parsePayload(RegistrationTokenSchema, data, "runner registration token");
    this.redactor.addLiteral(token, `${this.flavor}-runner-token`);
    return { token };
  }

  async deleteRunner(remote: GitPlatformRemote, id: number): Promise<void> {
    this.assertHost(remote);
    await this.request("DELETE", `${repoBase(remote)}/actions/runners/${id}`, undefined, [404]);
  }
}
