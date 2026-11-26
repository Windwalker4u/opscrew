import type { GitPlatformRemote } from "@opscrew/contracts";

export type ForgeFlavor = "forgejo" | "gitea";

/** Normalizes a Forgejo or Gitea host value (e.g. `https://codeberg.org/` -> `codeberg.org`). */
export function normalizeForgeHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

const KNOWN_HOSTS: Record<ForgeFlavor, ReadonlySet<string>> = {
  forgejo: new Set(["codeberg.org", "code.forgejo.org"]),
  gitea: new Set(["gitea.com"]),
};

const HOST_ENV: Record<ForgeFlavor, string> = {
  forgejo: "FORGEJO_HOST",
  gitea: "GITEA_HOST",
};

/**
 * Matches SSH (`git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git`) and
 * HTTPS (`https://host/owner/repo[.git]`) git remote URLs.
 */
function extractHostAndPath(url: string): { host: string; fullPath: string } | undefined {
  const trimmed = url.trim();
  const scp = /^git@([^:/\s]+):([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (scp?.[1] && scp[2]) {
    return { host: scp[1].toLowerCase(), fullPath: scp[2] };
  }
  const sshUrl =
    /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshUrl?.[1] && sshUrl[2]) {
    return { host: sshUrl[1].toLowerCase(), fullPath: sshUrl[2] };
  }
  const http =
    /^https?:\/\/(?:[^@/\s]+@)?([^:/\s]+(?::\d+)?)\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i.exec(
      trimmed,
    );
  if (http?.[1] && http[2]) {
    return { host: http[1].toLowerCase(), fullPath: http[2] };
  }
  return undefined;
}

function hostMatchesFlavor(
  host: string,
  flavor: ForgeFlavor,
  env?: Record<string, string | undefined>,
): boolean {
  const hostname = host.replace(/:\d+$/, "");
  if (KNOWN_HOSTS[flavor].has(hostname)) return true;
  const configured = normalizeForgeHost(env?.[HOST_ENV[flavor]]);
  if (configured !== undefined && (host === configured || hostname === configured)) return true;
  if (hostname.includes(flavor)) return true;
  if (env?.OPSCREW_GIT_PLATFORM?.trim().toLowerCase() === flavor) return true;
  return false;
}

function parseForgeRemote(
  flavor: ForgeFlavor,
  url: string,
  env?: Record<string, string | undefined>,
): GitPlatformRemote | undefined {
  const parsed = extractHostAndPath(url);
  if (!parsed) return undefined;
  if (!hostMatchesFlavor(parsed.host, flavor, env)) return undefined;
  const slash = parsed.fullPath.indexOf("/");
  if (slash <= 0 || slash === parsed.fullPath.length - 1) return undefined;
  const owner = parsed.fullPath.slice(0, slash);
  const repo = parsed.fullPath.slice(slash + 1);
  if (repo.includes("/")) return undefined;
  return {
    host: parsed.host,
    owner,
    repo,
    fullPath: `${owner}/${repo}`,
  };
}

/** Parses a Forgejo (Codeberg or self-hosted) git remote URL. */
export function parseForgejoRemote(
  url: string,
  env?: Record<string, string | undefined>,
): GitPlatformRemote | undefined {
  return parseForgeRemote("forgejo", url, env);
}

/** Parses a Gitea (`gitea.com` or self-hosted) git remote URL. */
export function parseGiteaRemote(
  url: string,
  env?: Record<string, string | undefined>,
): GitPlatformRemote | undefined {
  return parseForgeRemote("gitea", url, env);
}

/**
 * Builds the lower-case OCI container image reference for a Forgejo or Gitea instance's built-in
 * container registry (`<registryHost>/<owner>/<repo>[/<appKey>]`).
 */
export function forgeContainerImage(
  remote: Pick<GitPlatformRemote, "host" | "fullPath">,
  appKey?: string,
  registryHost?: string,
): string {
  const host = normalizeForgeHost(registryHost) ?? normalizeForgeHost(remote.host) ?? remote.host;
  const suffix = appKey === undefined ? "" : `/${appKey}`;
  return `${host}/${remote.fullPath}${suffix}`.toLowerCase();
}
