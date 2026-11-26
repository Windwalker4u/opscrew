/**
 * The contract for a git hosting & CI/CD platform (ADR 0039, mirroring ADR 0029 & ADR 0038):
 * everything OpsCrew knows about one git platform (GitHub, GitLab, and later Forgejo/Gitea), in
 * one definition a platform package exports. Only plain data, regular expressions, and functions
 * cross it — never a zod schema or a class instance (ADR 0029 D2). OpsCrew validates every
 * definition it loads (`@opscrew/git-platforms`) and reads platform facts from that registry alone.
 *
 * Fields and client methods are added alongside their callers (ADR 0039 D1).
 */
import type { Connector } from "./connector";
import type { CommandRunner, FetchLike } from "./io";
import type { ProviderRedactor, ProviderTokenRule } from "./provider";

/** The contract version this OpsCrew reads; a definition of another version is refused. */
export const GIT_PLATFORM_CONTRACT_VERSION = 1;

/** Parsed coordinates of a repository remote on a git platform. */
export interface GitPlatformRemote {
  /** Hostname (lower-case, e.g. `"github.com"`, `"gitlab.com"`, `"gitlab.company.internal"`). */
  host: string;
  /** Namespace / owner path (for GitHub: `<owner>`; for GitLab: `<group>` or `<group>/<subgroup>`). */
  owner: string;
  /** Repository / project slug. */
  repo: string;
  /** Canonical `<owner>/<repo>` path on the platform. */
  fullPath: string;
}

/** How the platform's API credentials are supplied and scanned. */
export interface GitPlatformCredentials {
  /** Environment variables checked in order (e.g. `["GITHUB_TOKEN", "GH_TOKEN"]`). */
  envVars: readonly string[];
  /** Optional CLI binary that can supply an existing session token (`"gh"`, `"glab"`). */
  cliCommand?: string;
  /** Secret-scanning token rules for `opscrew scan`. */
  tokenRules: readonly ProviderTokenRule[];
}

/** Plain-English wording per platform read by shared phases and checks. */
export interface GitPlatformTexts {
  /** Singular noun for a proposed code change (`"pull request"` or `"merge request"`). */
  changeRequestNoun: string;
  /** Singular noun for a CI/CD run configuration (`"workflow"` or `"pipeline"`). */
  pipelineNoun: string;
  /** Guidance when no recognised remote named `origin` exists. */
  remoteFixHint: string;
  /** Guidance when no valid API token is configured. */
  tokenFixHint: string;
}

/** Repository metadata returned by a git platform. */
export interface GitPlatformRepoInfo {
  id: number | string;
  fullPath: string;
  defaultBranch: string;
  private: boolean;
  visibility?: "public" | "private" | "internal";
  webUrl: string;
}

/** A pull request (GitHub) or merge request (GitLab). */
export interface GitPlatformChangeRequest {
  number: number;
  url: string;
  title: string;
  head: string;
  base: string;
}

/** Whether deployment environments (and optional protection rules) are available on this repo/tier. */
export interface GitPlatformEnvironmentCapability {
  available: boolean;
  protectedAvailable: boolean;
  reason?: string;
}

/** Options when probing deployment environment support on a platform. */
export interface GitPlatformEnvironmentProbeOptions {
  /** Throwaway environment name used when a platform must probe by creating/deleting one (GitHub). */
  probeName?: string;
  /** Branch name used when probing branch-restricted environment protection rules. */
  branch?: string;
}

/** Options when storing a CI/CD secret on a platform. */
export interface GitPlatformSecretOptions {
  /** Optional environment scope (absent means repository/project-wide). */
  environment?: string;
  /**
   * Restrict exposure to protected branches/tags. On GitHub, repository-wide secrets cannot be
   * branch-restricted, so `protected: true` requires `environment` to be set.
   */
  protected?: boolean;
}

/** A pipeline / workflow run summary. */
export interface GitPlatformPipelineRun {
  id: number;
  status: "queued" | "running" | "success" | "failed" | "cancelled" | "skipped" | "unknown";
  url: string;
  ref?: string;
  sha?: string;
  createdAt?: string;
}

/** A project-scoped self-hosted runner. */
export interface GitPlatformRunnerInfo {
  id: number;
  name: string;
  online: boolean;
  busy: boolean;
  labels: readonly string[];
}

/** Result of creating a runner registration / authentication token on the platform. */
export interface GitPlatformRunnerToken {
  /** Short-lived registration token (GitHub) or `glrt-` authentication token (GitLab). */
  token: string;
  /** Runner id when created up-front (GitLab `POST /user/runners`). */
  runnerId?: number;
}

/** Unified platform API implemented by each git platform package. */
export interface GitPlatformClient {
  whoAmI(): Promise<string>;
  getRepo(remote: GitPlatformRemote): Promise<GitPlatformRepoInfo>;

  findOpenChangeRequest(
    remote: GitPlatformRemote,
    head: string,
    base?: string,
  ): Promise<GitPlatformChangeRequest | undefined>;
  createChangeRequest(
    remote: GitPlatformRemote,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<GitPlatformChangeRequest>;
  updateChangeRequest(
    remote: GitPlatformRemote,
    number: number,
    input: { title: string; body: string },
  ): Promise<GitPlatformChangeRequest>;

  environmentCapability(
    remote: GitPlatformRemote,
    options?: GitPlatformEnvironmentProbeOptions,
  ): Promise<GitPlatformEnvironmentCapability>;
  ensureEnvironment(remote: GitPlatformRemote, name: string): Promise<void>;
  deleteEnvironment(remote: GitPlatformRemote, name: string): Promise<void>;

  setSecret(
    remote: GitPlatformRemote,
    name: string,
    value: string,
    options?: GitPlatformSecretOptions,
  ): Promise<void>;
  secretExists(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<boolean>;
  deleteSecret(
    remote: GitPlatformRemote,
    name: string,
    options?: Pick<GitPlatformSecretOptions, "environment">,
  ): Promise<void>;

  triggerPipeline(
    remote: GitPlatformRemote,
    input: { ref: string; workflowFile?: string; inputs?: Record<string, string> },
  ): Promise<GitPlatformPipelineRun | undefined>;
  listPipelineRuns(
    remote: GitPlatformRemote,
    options?: { ref?: string; workflowFile?: string; limit?: number },
  ): Promise<GitPlatformPipelineRun[]>;
  getPipelineRun(remote: GitPlatformRemote, runId: number): Promise<GitPlatformPipelineRun>;
  retryPipelineRun(remote: GitPlatformRemote, runId: number): Promise<void>;

  listRunners(remote: GitPlatformRemote): Promise<GitPlatformRunnerInfo[]>;
  createRunnerToken(
    remote: GitPlatformRemote,
    options?: { description?: string; labels?: readonly string[] },
  ): Promise<GitPlatformRunnerToken>;
  deleteRunner(remote: GitPlatformRemote, id: number): Promise<void>;
}

/** Dependencies OpsCrew passes when constructing a git platform connector. */
export interface GitPlatformConnectorDeps {
  token: string | undefined;
  /** Hostname of the platform instance (e.g. `"github.com"`, `"gitlab.com"`, or self-managed host). */
  host?: string;
  fetch: FetchLike;
  redactor?: ProviderRedactor;
  version?: string;
}

/** A git platform connector: credential check + optional typed platform client. */
export interface GitPlatformConnector extends Omit<Connector, "id"> {
  readonly id: string;
  readonly client: GitPlatformClient | undefined;
}

/** Everything OpsCrew reads about one git hosting & CI/CD platform (ADR 0039). */
export interface GitPlatformDefinition {
  contractVersion: typeof GIT_PLATFORM_CONTRACT_VERSION;
  id: string;
  displayName: string;
  /** Value of `cicd.provider` in `opscrew/plan.yaml` (e.g. `"github-actions"`, `"gitlab-ci"`). */
  cicdProvider: string;
  /** Value of `cicd.registry` in `opscrew/plan.yaml` (e.g. `"ghcr"`, `"gitlab-registry"`). */
  registryId: string;
  credentials: GitPlatformCredentials;
  texts: GitPlatformTexts;
  /** Parses a git remote URL if it belongs to this platform; returns `undefined` otherwise. */
  parseRemote(url: string, env?: Record<string, string | undefined>): GitPlatformRemote | undefined;
  /** Builds the lower-case container image name for this platform's registry. */
  containerImage(
    remote: Pick<GitPlatformRemote, "host" | "fullPath">,
    appKey?: string,
    registryHost?: string,
  ): string;
  /** Resolves an API token from `env` or the platform's CLI if installed. */
  resolveToken(
    env: Record<string, string | undefined>,
    runner: CommandRunner,
  ): Promise<string | undefined>;
  /** Builds the connector (credential verifier + platform client). */
  createConnector(deps: GitPlatformConnectorDeps): GitPlatformConnector;
}
