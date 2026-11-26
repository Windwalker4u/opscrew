import {
  type CommandRunner,
  type CredentialCheck,
  GIT_PLATFORM_CONTRACT_VERSION,
  type GitPlatformConnector,
  type GitPlatformConnectorDeps,
  type GitPlatformDefinition,
} from "@opscrew/contracts";
import { errorText, findExecutable, Redactor, TOKEN_PATTERNS } from "@opscrew/core";
import { GitLabClient } from "./client";
import { gitlabContainerImage, normalizeGitLabHost, parseGitLabRemote } from "./remote";

export { GitLabClient, isGitLabMaskable } from "./client";
export { gitlabContainerImage, normalizeGitLabHost, parseGitLabRemote } from "./remote";

/** Required GitLab token scopes for OpsCrew. */
export const GITLAB_TOKEN_PERMISSIONS = [
  "api (read/write repository, merge requests, CI/CD variables, environments, pipelines, container registry)",
  "create_runner (only when installing a self-hosted GitLab Runner on your server)",
] as const;

/**
 * GitLab token from `GITLAB_TOKEN`, `GL_TOKEN`, or the GitLab CLI (`glab auth status -t`), in order.
 */
export async function resolveGitLabToken(
  env: Record<string, string | undefined>,
  runner: CommandRunner,
): Promise<string | undefined> {
  const fromEnv = env.GITLAB_TOKEN?.trim() || env.GL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const glab = findExecutable("glab", env);
  if (!glab) return undefined;
  try {
    const result = await runner.run(glab, ["auth", "status", "-t"], { timeoutMs: 15_000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    const match = /Token:\s*(\S+)/i.exec(combined);
    const token = match?.[1]?.trim();
    return token && token.length > 0 && !/^\*+$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}

function createGitLabConnector(deps: GitPlatformConnectorDeps): GitPlatformConnector {
  const redactor = deps.redactor ?? new Redactor();
  const host = normalizeGitLabHost(deps.host) ?? "gitlab.com";
  const client = deps.token
    ? new GitLabClient({
        token: deps.token,
        host,
        fetch: deps.fetch,
        redactor,
        ...(deps.version !== undefined ? { version: deps.version } : {}),
      })
    : undefined;
  return {
    id: "gitlab",
    displayName: "GitLab",
    credentials: {
      envVars: ["GITLAB_TOKEN", "GL_TOKEN"],
      description:
        "GitLab Personal or Project Access Token with `api` scope (or log in with `glab auth login`).",
      scopes: [...GITLAB_TOKEN_PERMISSIONS],
      createUrl: `https://${host}/-/user_settings/personal_access_tokens`,
    },
    client,
    async verifyCredentials(): Promise<CredentialCheck> {
      if (!client) {
        return {
          ok: false,
          message: "No GitLab token: set GITLAB_TOKEN (or GL_TOKEN) or run `glab auth login`.",
        };
      }
      try {
        const username = await client.whoAmI();
        return {
          ok: true,
          identity: username,
          message: `GitLab token works on ${host} (signed in as ${username}).`,
        };
      } catch (error) {
        return { ok: false, message: redactor.redact(errorText(error)) };
      }
    },
  };
}

/** The GitLab git platform definition (ADR 0039, contractVersion 1). */
export const definition: GitPlatformDefinition = {
  contractVersion: GIT_PLATFORM_CONTRACT_VERSION,
  id: "gitlab",
  displayName: "GitLab",
  cicdProvider: "gitlab-ci",
  registryId: "gitlab-registry",
  credentials: {
    envVars: ["GITLAB_TOKEN", "GL_TOKEN"],
    cliCommand: "glab",
    tokenRules: [
      {
        id: "gitlab-token",
        title: "GitLab token",
        severity: "critical",
        pattern: new RegExp(TOKEN_PATTERNS["gitlab-token"].source, "g"),
        description:
          "A GitLab access, runner, deploy, or pipeline trigger token is written in this file. Anyone who can read it can act on your GitLab projects.",
      },
    ],
  },
  texts: {
    changeRequestNoun: "merge request",
    pipelineNoun: "pipeline",
    remoteFixHint:
      "Create the project on GitLab (or your self-managed host), run `git remote add origin https://gitlab.com/<group>/<project>.git`, push, then run `opscrew init` again.",
    tokenFixHint:
      "Set GITLAB_TOKEN (with `api` scope; add `create_runner` for a self-hosted runner) or run `glab auth login`.",
  },
  parseRemote: parseGitLabRemote,
  containerImage: gitlabContainerImage,
  resolveToken: resolveGitLabToken,
  createConnector: createGitLabConnector,
};
