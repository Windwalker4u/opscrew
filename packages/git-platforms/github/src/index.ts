import { parseGitHubRepo } from "@opscrew/connector-github";
import {
  GIT_PLATFORM_CONTRACT_VERSION,
  type GitPlatformDefinition,
  type GitPlatformRemote,
} from "@opscrew/contracts";
import { TOKEN_PATTERNS } from "@opscrew/core";

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

/** The GitHub git platform definition (ADR 0039, contractVersion 1). */
export const definition: GitPlatformDefinition = {
  contractVersion: GIT_PLATFORM_CONTRACT_VERSION,
  id: "github",
  displayName: "GitHub",
  credentials: {
    envVars: ["GITHUB_TOKEN", "GH_TOKEN"],
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
    remoteFixHint:
      "Create the repository on GitHub, run `git remote add origin https://github.com/<owner>/<repo>.git`, push, then run `opscrew init` again.",
  },
  parseRemote: parseGitHubRemote,
};
