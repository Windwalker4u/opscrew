/**
 * The contract for a git hosting & CI/CD platform (ADR 0039, mirroring ADR 0029 & ADR 0038):
 * everything OpsCrew knows about one git platform (GitHub, and later GitLab, Forgejo, Gitea), in
 * one definition a platform package exports. Only plain data, regular expressions, and functions
 * cross it — never a zod schema or a class instance (ADR 0029 D2). OpsCrew validates every
 * definition it loads (`@opscrew/git-platforms`) and reads platform facts from that registry alone.
 *
 * Fields are added with their first reader (ADR 0039 D1).
 */
import type { ProviderTokenRule } from "./provider";

/** The contract version this OpsCrew reads; a definition of another version is refused. */
export const GIT_PLATFORM_CONTRACT_VERSION = 1;

/** Parsed coordinates of a repository remote on a git platform. */
export interface GitPlatformRemote {
  /** Hostname (lower-case, e.g. `"github.com"`, `"gitlab.com"`). */
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
  /** Secret-scanning token rules for `opscrew scan`. */
  tokenRules: readonly ProviderTokenRule[];
}

/** Plain-English wording per platform read by shared checks. */
export interface GitPlatformTexts {
  /** Guidance when no recognised remote named `origin` exists. */
  remoteFixHint: string;
}

/** Everything OpsCrew reads about one git hosting & CI/CD platform (ADR 0039). */
export interface GitPlatformDefinition {
  contractVersion: typeof GIT_PLATFORM_CONTRACT_VERSION;
  id: string;
  displayName: string;
  credentials: GitPlatformCredentials;
  texts: GitPlatformTexts;
  /** Parses a git remote URL if it belongs to this platform; returns `undefined` otherwise. */
  parseRemote(url: string): GitPlatformRemote | undefined;
}
