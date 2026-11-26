import type {
  GitPlatformConnector,
  GitPlatformDefinition,
  GitPlatformRemote,
} from "@opscrew/contracts";
import { listText, OpsCrewError } from "@opscrew/core";
import { detectGitPlatform, GIT_PLATFORMS } from "@opscrew/git-platforms";
import type { PhaseDeps } from "../context";
import { gitClient } from "./github";

type GitPlatformDeps = Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor">;

/**
 * Detects the git platform and remote coordinates from the repository's `origin` remote.
 * Returns `undefined` when `origin` is absent or not a recognised git platform.
 */
export async function detectProjectGitPlatform(
  deps: GitPlatformDeps,
  git?: string,
): Promise<{ platform: GitPlatformDefinition; remote: GitPlatformRemote } | undefined> {
  const client = gitClient(deps, git);
  const remoteUrl = await client.remoteUrl("origin");
  if (!remoteUrl) return undefined;
  return detectGitPlatform(remoteUrl, deps.env);
}

/**
 * Like {@link detectProjectGitPlatform}, stopping with a plain `PHASE_PRECONDITION` when no
 * supported git platform remote named `origin` exists.
 */
export async function requireGitPlatformRemote(
  deps: GitPlatformDeps,
  git?: string,
): Promise<{ platform: GitPlatformDefinition; remote: GitPlatformRemote }> {
  const detected = await detectProjectGitPlatform(deps, git);
  if (detected !== undefined) return detected;
  const names = listText(GIT_PLATFORMS.map((p) => p.displayName));
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `This repository has no ${names} remote named origin, so there is nowhere to build and deploy from.`,
    {
      hint: GIT_PLATFORMS.map((p) => p.texts.remoteFixHint).join(" "),
    },
  );
}

/**
 * Builds the platform connector for `platform` (resolving its API token from `deps.env` or the
 * platform CLI and registering it with `deps.redactor`).
 */
export async function gitPlatformConnectorFor(
  deps: Pick<PhaseDeps, "env" | "runner" | "redactor" | "fetch" | "version">,
  platform: GitPlatformDefinition,
  host?: string,
): Promise<GitPlatformConnector> {
  const token = await platform.resolveToken(deps.env, deps.runner);
  if (token) deps.redactor.addLiteral(token, `${platform.id}-token`);
  return platform.createConnector({
    token,
    ...(host !== undefined ? { host } : {}),
    fetch: deps.fetch,
    redactor: deps.redactor,
    version: deps.version,
  });
}
