/**
 * The teardown's part for an app served from home (plan 14., research R12): after the teardown
 * host plan removed the address updater from the server, the records it kept at Cloudflare are
 * deleted through their own plan (`home/records.ts`, approved by its hash with the app's name
 * typed); with the repository's last app at home, a pull request removes the outside check's
 * workflow; and the output names the page where the updater's token is deleted. Nothing here holds
 * the home's address or the token.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareConnector } from "@opscrew/connector-cloudflare";
import { isUserFacingError, lowerFirst } from "@opscrew/core";
import { homeMode } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { OUTSIDE_CHECK_PATH, outsideCheckUnused } from "../home/outside-check";
import { deleteUpdaterRecords } from "../home/records";
import { cloudflareTokenMissing } from "../provision/credentials";
import { chooseDeployBranch, commitAndPropose } from "../provision/publish";
import { gitClient } from "../shared";
import { hintOf, reasonOf } from "../shared/errors";
import type { GitHubTarget } from "./common";
import type { DestroyGitHubApi } from "./types";

/** Where the user deletes the updater's token, which OpsCrew never holds the power to revoke. */
export const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

/** True when `plan` is served from home with its DNS on Cloudflare: the address updater keeps it. */
function hasUpdater(plan: DeployPlan): boolean {
  return homeMode(plan) && plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
}

/**
 * Deletes the address updater's records at the app's name, once the teardown removed the updater
 * from the server (it would write them again): the zone found with the Cloudflare token, then
 * `deleteUpdaterRecords` (its plan approved by its hash with `allowDestroy` and the app's name
 * typed, the records read again). Nothing for an app that has no updater. A zone the token can't
 * see leaves them, with a warning saying where to delete them.
 */
export async function deleteHomeRecords(
  deps: PhaseDeps,
  plan: DeployPlan,
  command: string,
): Promise<void> {
  const name = plan.dns.domain;
  if (!hasUpdater(plan) || name === undefined) return;
  const client = cloudflareConnector(deps).client;
  if (client === undefined) throw cloudflareTokenMissing(deps);
  const zone = await client.findZone(plan.dns.zone ?? name);
  if (zone === undefined) {
    deps.reporter.warn(
      `Cloudflare shows this token no zone for ${name}, so OpsCrew could not delete the records your server's address updater kept there: delete the A and AAAA records of ${name} in the Cloudflare dashboard (DNS → Records).`,
    );
    return;
  }
  await deleteUpdaterRecords(deps, client, {
    app: plan.app.name,
    zoneId: zone.id,
    name,
    command,
    phase: "provision",
  });
}

/** What remains of the address updater after the teardown: its token, which only the user deletes. */
export function updaterTokenLeft(plan: DeployPlan): string[] {
  return hasUpdater(plan)
    ? [
        `The address updater's Cloudflare token: OpsCrew removed your server's copy, but the token works until you delete it at ${TOKEN_PAGE}.`,
      ]
    : [];
}

/** The pull request calls, which a destroy's GitHub API may lack. */
type PullRequestCalls =
  | "getRepo"
  | "findOpenPullRequest"
  | "createPullRequest"
  | "updatePullRequest";

/** True when `api` has every call the pull request that removes the workflow makes. */
function opensPullRequests(
  api: DestroyGitHubApi | undefined,
): api is DestroyGitHubApi & Required<Pick<DestroyGitHubApi, PullRequestCalls>> {
  return (
    api?.getRepo !== undefined &&
    api.findOpenPullRequest !== undefined &&
    api.createPullRequest !== undefined &&
    api.updatePullRequest !== undefined
  );
}

/**
 * With the repository's last app at home ({@link outsideCheckUnused}, `plan` leaving), a pull
 * request removes the outside check's workflow: the branch chosen as provision chooses it, the
 * file deleted and committed alone, then the push and the pull request, each after its own
 * approval. Answers what remains: the workflow, with the reason and what to do, while no pull
 * request removes it (no GitHub access, a refusal, or a clone not on the latest base branch, in
 * the branch check's words for destroy); none otherwise.
 */
export async function proposeOutsideCheckRemoval(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: GitHubTarget,
): Promise<string[]> {
  if (!homeMode(plan) || !(await outsideCheckUnused(deps, plan, { leaving: true }))) return [];
  const stays = (why: string, next = "Remove it in a pull request of your own.") => [
    `The outside check's workflow (${OUTSIDE_CHECK_PATH}): no app of this repository is at home any more; ${why}. ${next}`,
  ];
  const { api } = github;
  if (!opensPullRequests(api) || github.owner === undefined || github.repo === undefined) {
    return stays("OpsCrew has no GitHub access here to open a pull request that removes it");
  }
  const { owner, repo } = github;
  try {
    const { defaultBranch } = await api.getRepo(owner, repo);
    const setup = { api, owner, repo, defaultBranch };
    const git = gitClient(deps);
    const chosen = await chooseDeployBranch(deps, git, setup, plan, "destroy");
    await rm(join(deps.paths.root, OUTSIDE_CHECK_PATH), { force: true });
    const title = "OpsCrew: remove the outside check";
    const result = await commitAndPropose(deps, {
      git,
      github: setup,
      plan,
      chosen,
      files: [],
      paths: [OUTSIDE_CHECK_PATH],
      what: "the outside check's workflow",
      push: true,
      phase: "destroy",
      title,
      body: [
        `This pull request removes \`${OUTSIDE_CHECK_PATH}\`, the outside check \`opscrew verify\` started from GitHub's network for apps served from home. \`opscrew destroy\` removed **${plan.app.name}**, the last app of this repository at home, so nothing uses it any more.`,
        "",
        `Opened by OpsCrew ${deps.version}.`,
      ].join("\n"),
      commitMessage: `chore(opscrew): remove the outside check\n\nNo app of this repository is at home any more after the removal of ${plan.app.name}.`,
    });
    return result.prUrl === undefined
      ? stays(
          `no pull request removes it yet (its removal is committed on the branch ${result.branch})`,
          `Push ${result.branch} and open a pull request into ${result.base}.`,
        )
      : [];
  } catch (error) {
    if (!isUserFacingError(error)) throw error;
    // The branch check's stop in destroy's words: what blocked the pull request, and the way on.
    return stays(
      deps.redactor.redact(lowerFirst(reasonOf(error))),
      deps.redactor.redact(hintOf(error).trim() || "Remove it in a pull request of your own."),
    );
  }
}
