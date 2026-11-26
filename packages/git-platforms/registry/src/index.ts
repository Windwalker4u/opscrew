/**
 * The built-in git hosting & CI/CD platforms (ADR 0039): the one place OpsCrew reads git platform
 * facts from. Every definition is validated when this module loads.
 */
import type { GitPlatformDefinition, GitPlatformRemote } from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { definition as github } from "@opscrew/git-github";
import { validateGitPlatform } from "./validate";

export { validateGitPlatform } from "./validate";

/** The built-in git platforms, in order. */
export const GIT_PLATFORMS: readonly GitPlatformDefinition[] = [github].map(validateGitPlatform);

/** The definition of git platform `id`; throws `INVALID_INPUT` for any unknown id. */
export function gitPlatform(id: string): GitPlatformDefinition {
  const found = GIT_PLATFORMS.find((platform) => platform.id === id);
  if (found !== undefined) return found;
  throw new OpsCrewError("INVALID_INPUT", `OpsCrew does not support the git platform "${id}".`, {
    hint: `Choose one of its supported git platforms: ${listText(GIT_PLATFORMS.map((p) => p.id))}.`,
  });
}

/**
 * Parses `remoteUrl` across all registered git platforms.
 * Returns both the matching platform definition and parsed remote coordinates, or `undefined`.
 */
export function detectGitPlatform(
  remoteUrl: string,
): { platform: GitPlatformDefinition; remote: GitPlatformRemote } | undefined {
  for (const platform of GIT_PLATFORMS) {
    const remote = platform.parseRemote(remoteUrl);
    if (remote) return { platform, remote };
  }
  return undefined;
}
