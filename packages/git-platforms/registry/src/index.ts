/**
 * The built-in git hosting & CI/CD platforms (ADR 0039): the one place OpsCrew reads git platform
 * facts from. Every definition is validated when this module loads.
 */
import type { GitPlatformDefinition, GitPlatformRemote } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { forgejoDefinition, giteaDefinition } from "@opscrew/git-forgejo-gitea";
import { definition as github } from "@opscrew/git-github";
import { definition as gitlab } from "@opscrew/git-gitlab";
import { validateGitPlatform } from "./validate";

export { validateGitPlatform } from "./validate";

/** The built-in git platforms, in order. */
export const GIT_PLATFORMS: readonly GitPlatformDefinition[] = [
  github,
  gitlab,
  forgejoDefinition,
  giteaDefinition,
].map(validateGitPlatform);

/** The definition of git platform `id`; throws `INVALID_INPUT` for any unknown id. */
export function gitPlatform(id: string): GitPlatformDefinition {
  const found = GIT_PLATFORMS.find((platform) => platform.id === id);
  if (found !== undefined) return found;
  throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not support the git platform "${id}".`, {
    hint: `Choose one of its supported git platforms: ${listText(GIT_PLATFORMS.map((p) => p.id))}.`,
  });
}

/** Looks up the git platform owning a `cicd.provider` value (e.g. `"gitlab-ci"` -> `gitlab`). */
export function gitPlatformByCicdProvider(cicdProvider: string): GitPlatformDefinition {
  const found = GIT_PLATFORMS.find((platform) => platform.cicdProvider === cicdProvider);
  if (found !== undefined) return found;
  throw new OpsCrewError(
    "INVALID_INPUT",
    `OpsCrew does not recognise the CI/CD provider "${cicdProvider}".`,
    {
      hint: `Choose one of: ${listText(GIT_PLATFORMS.map((p) => p.cicdProvider))}.`,
    },
  );
}

/**
 * Parses `remoteUrl` across all registered git platforms, honoring `OPSCREW_GIT_PLATFORM` when set.
 * Returns both the matching platform definition and parsed remote coordinates, or `undefined`.
 */
export function detectGitPlatform(
  remoteUrl: string,
  env?: Record<string, string | undefined>,
): { platform: GitPlatformDefinition; remote: GitPlatformRemote } | undefined {
  const override = env?.OPSCREW_GIT_PLATFORM?.trim().toLowerCase();
  if (override) {
    const preferred = GIT_PLATFORMS.find((p) => p.id === override);
    if (preferred) {
      const remote = preferred.parseRemote(remoteUrl, env);
      if (remote) return { platform: preferred, remote };
    }
  }
  for (const platform of GIT_PLATFORMS) {
    const remote = platform.parseRemote(remoteUrl, env);
    if (remote) return { platform, remote };
  }
  return undefined;
}
