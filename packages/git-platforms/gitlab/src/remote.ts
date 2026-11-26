import type { GitPlatformRemote } from "@opscrew/contracts";

/** Normalizes a host value from env (strips scheme, trailing slash, and lower-cases). */
export function normalizeGitLabHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitGenericGitUrl(url: string): { host: string; fullPath: string } | undefined {
  const trimmed = url.trim();
  const schemeMatch =
    /^(?:https?|ssh):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (schemeMatch) {
    return {
      host: (schemeMatch[1] as string).toLowerCase(),
      fullPath: (schemeMatch[2] as string).replace(/^\/+/, "").replace(/\/+$/, ""),
    };
  }
  const scpMatch = /^(?:[^@:\s]+@)?([a-z0-9.-]+):([^/\s].*?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scpMatch) {
    return {
      host: (scpMatch[1] as string).toLowerCase(),
      fullPath: (scpMatch[2] as string).replace(/^\/+/, "").replace(/\/+$/, ""),
    };
  }
  return undefined;
}

function isGitLabHost(host: string, env?: Record<string, string | undefined>): boolean {
  if (host === "gitlab.com") return true;
  if (env?.OPSCREW_GIT_PLATFORM?.trim().toLowerCase() === "gitlab") return true;
  const configured = normalizeGitLabHost(env?.GITLAB_HOST);
  if (configured !== undefined && host === configured) return true;
  return /(?:^|\.)gitlab(?:\.|$)/i.test(host);
}

/**
 * Parses a GitLab remote URL (`gitlab.com` or self-managed GitLab, including nested subgroups such
 * as `group/subgroup/project`) into a {@link GitPlatformRemote}, or `undefined` when not GitLab.
 */
export function parseGitLabRemote(
  url: string,
  env?: Record<string, string | undefined>,
): GitPlatformRemote | undefined {
  const split = splitGenericGitUrl(url);
  if (!split) return undefined;
  if (!isGitLabHost(split.host, env)) return undefined;
  const segments = split.fullPath.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  const repo = segments[segments.length - 1] as string;
  const owner = segments.slice(0, -1).join("/");
  const fullPath = `${owner}/${repo}`;
  return {
    host: split.host,
    owner,
    repo,
    fullPath,
  };
}

/**
 * GitLab Container Registry image name, lower-case:
 * `registry.gitlab.com/<namespace>/<project>[/<key>]` for `gitlab.com`, or
 * `<registryHost>/<namespace>/<project>[/<key>]` (default `registry.<host>`) for self-managed hosts.
 */
export function gitlabContainerImage(
  remote: Pick<GitPlatformRemote, "host" | "fullPath">,
  appKey?: string,
  registryHost?: string,
): string {
  const host =
    registryHost?.trim() ||
    (remote.host === "gitlab.com" ? "registry.gitlab.com" : `registry.${remote.host}`);
  const suffix = appKey === undefined ? "" : `/${appKey}`;
  return `${host}/${remote.fullPath}${suffix}`.toLowerCase();
}
