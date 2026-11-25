/** What {@link buildVersion} reads from the checkout. */
export interface BuildGit {
  /** The tags at the built commit. */
  tagsAtHead(): string[];
  /** The built commit's short hash; undefined when git can't name it. */
  shortCommit(): string | undefined;
}

/**
 * `version` on the commit tagged `v<version>`, else `<version>-dev.<short commit>`, or
 * `<version>-dev` when git can't name the commit.
 */
export function buildVersion(version: string, git: BuildGit): string;

/** The checkout at `cwd`, through the git binary; a failed call reads as no tags and no commit. */
export function gitAt(cwd: string): BuildGit;
