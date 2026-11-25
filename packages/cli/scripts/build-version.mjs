// The version the bundle reports (tsup.config.ts embeds it at build time): the package's own on a
// commit tagged `v<version>`, which the Release workflow builds, otherwise a pre-release that names
// the commit, so a build between releases never passes for the release itself.
import { execFileSync } from "node:child_process";

/**
 * `version` when `git` lists the tag `v<version>` at the built commit, else
 * `<version>-dev.<short commit>`, or `<version>-dev` when git can't name the commit.
 * @param {string} version
 * @param {{ tagsAtHead(): string[]; shortCommit(): string | undefined }} git
 * @returns {string}
 */
export function buildVersion(version, git) {
  if (git.tagsAtHead().includes(`v${version}`)) return version;
  const commit = git.shortCommit();
  return commit === undefined ? `${version}-dev` : `${version}-dev.${commit}`;
}

/**
 * The checkout at `cwd`, through the git binary; a failed git call (no git, not a checkout) reads
 * as no tags and no commit.
 * @param {string} cwd
 */
export function gitAt(cwd) {
  /** @param {string[]} args */
  const run = (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  };
  return {
    // `--points-at` lists lightweight tags too, which is what a CI checkout of a tag creates.
    tagsAtHead: () => run(["tag", "--points-at", "HEAD"]).split(/\r?\n/).filter(Boolean),
    shortCommit: () => run(["rev-parse", "--short", "HEAD"]) || undefined,
  };
}
