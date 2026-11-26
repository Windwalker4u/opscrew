import { githubConnector, parseGitHubRepo, resolveGitHubToken } from "@opscrew/connector-github";
import {
  GIT_PLATFORM_CONTRACT_VERSION,
  type GitPlatformConnector,
  type GitPlatformConnectorDeps,
  type GitPlatformDefinition,
  type GitPlatformRemote,
} from "@opscrew/contracts";
import { TOKEN_PATTERNS } from "@opscrew/core";
import { GitHubPlatformClient } from "./client";

export { GitHubPlatformClient } from "./client";

/** Parses a GitHub remote URL into a {@link GitPlatformRemote}, or `undefined` if not GitHub. */
export function parseGitHubRemote(url: string): GitPlatformRemote | undefined {
  const parsed = parseGitHubRepo(url);
  if (!parsed) return undefined;
  const fullPath = `${parsed.owner}/${parsed.repo}`;
  return {
    host: "github.com",
    owner: parsed.owner,
    repo: parsed.repo,
    fullPath,
  };
}

/** GitHub's container image on GHCR (`ghcr.io/<owner>/<repo>[/<key>]`, lower-case). */
export function githubContainerImage(
  remote: Pick<GitPlatformRemote, "host" | "fullPath">,
  appKey?: string,
  registryHost = "ghcr.io",
): string {
  const suffix = appKey === undefined ? "" : `/${appKey}`;
  return `${registryHost}/${remote.fullPath}${suffix}`.toLowerCase();
}

function createGitHubConnector(deps: GitPlatformConnectorDeps): GitPlatformConnector {
  const inner = githubConnector({
    token: deps.token,
    fetch: deps.fetch,
    ...(deps.redactor !== undefined ? { redactor: deps.redactor } : {}),
    ...(deps.version !== undefined ? { version: deps.version } : {}),
  });
  return {
    id: inner.id,
    displayName: inner.displayName,
    credentials: inner.credentials,
    client: inner.client ? new GitHubPlatformClient(inner.client) : undefined,
    verifyCredentials: () => inner.verifyCredentials(),
  };
}

/** The GitHub git platform definition (ADR 0039, contractVersion 1). */
export const definition: GitPlatformDefinition = {
  contractVersion: GIT_PLATFORM_CONTRACT_VERSION,
  id: "github",
  displayName: "GitHub",
  cicdProvider: "github-actions",
  registryId: "ghcr",
  credentials: {
    envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
    cliCommand: "gh",
    tokenRules: [
      {
        id: "github-token",
        title: "GitHub token",
        severity: "critical",
        pattern: new RegExp(
          `${TOKEN_PATTERNS["github-token"].source}|${TOKEN_PATTERNS["github-pat"].source}`,
          "g",
        ),
        description:
          "A GitHub access token is written in this file. Anyone who can read it can act as its owner on GitHub.",
      },
    ],
  },
  texts: {
    changeRequestNoun: "pull request",
    pipelineNoun: "workflow",
    remoteFixHint:
      "Create the repository on GitHub, run `git remote add origin https://github.com/<owner>/<repo>.git`, push, then run `opscrew init` again.",
    tokenFixHint:
      "Set GITHUB_TOKEN (or run `gh auth login`) with Contents, Pull requests, Actions, Secrets and Workflows permissions on this repository.",
  },
  parseRemote: (url) => parseGitHubRemote(url),
  containerImage: githubContainerImage,
  resolveToken: resolveGitHubToken,
  createConnector: createGitHubConnector,
};
