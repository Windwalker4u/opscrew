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
import { homeMode, OUTSIDE_CHECK_WORKFLOW_FILE } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { otherPlans } from "../check/files";
import type { PhaseDeps } from "../context";
import { environmentDeployed } from "../environments/list";
import { deleteUpdaterRecords } from "../home/records";
import { cloudflareTokenMissing, type GitHubSetup } from "../provision/credentials";
import { chooseDeployBranch, commitAndPropose } from "../provision/publish";
import type { GitHubApi } from "../provision/types";
import { gitClient } from "../shared";
import { reasonOf } from "../shared/errors";
import { trackedFiles } from "../shared/github";
import type { GitHubTarget } from "./common";

/** The outside check's workflow in the repository: one file every app at home shares. */
export const OUTSIDE_CHECK_PATH = `.github/workflows/${OUTSIDE_CHECK_WORKFLOW_FILE}`;

/** Where the user deletes the updater's token, which OpsCrew never holds the power to revoke. */
export const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

/** True when `plan` is served from home with its DNS on Cloudflare: the address updater keeps it. */
function hasUpdater(plan: DeployPlan): boolean {
  return homeMode(plan) && plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
}

/**
 * True when the repository tracks the outside check's workflow and no app needs it any more: no
 * other app or environment at home may still have something running (`environmentDeployed`), and
 * `plan` is no longer at home or `leaving` it (destroy).
 */
export async function outsideCheckUnused(
  deps: Pick<PhaseDeps, "paths" | "runner">,
  plan: DeployPlan,
  options: { leaving: boolean },
): Promise<boolean> {
  if (!options.leaving && homeMode(plan)) return false;
  for (const other of await otherPlans(deps.paths, plan)) {
    if (homeMode(other.plan) && (await environmentDeployed(other.paths, other.plan))) return false;
  }
  return (await trackedFiles(deps, [OUTSIDE_CHECK_PATH])).length > 0;
}

/**
 * The outside check's part of a deploy-setup pull request after a switch out of home: when no app
 * of the repository is at home any more ({@link outsideCheckUnused}), the workflow is deleted in
 * the working copy and its path answered, so the pull request removes it; otherwise none.
 */
export async function removeUnusedOutsideCheck(
  deps: Pick<PhaseDeps, "paths" | "runner" | "reporter">,
  plan: DeployPlan,
): Promise<string[]> {
  if (!(await outsideCheckUnused(deps, plan, { leaving: false }))) return [];
  await rm(join(deps.paths.root, OUTSIDE_CHECK_PATH), { force: true });
  deps.reporter.info(
    "No app of this repository is at home any more, so the pull request removes the outside check's workflow.",
  );
  return [OUTSIDE_CHECK_PATH];
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

/** The GitHub calls the pull request that removes the outside check's workflow needs. */
type PullRequestApi = Pick<
  GitHubApi,
  "getRepo" | "findOpenPullRequest" | "createPullRequest" | "updatePullRequest"
>;

/** The pull request calls of `api`, when it has every one of them. */
function pullRequestApi(api: GitHubTarget["api"]): PullRequestApi | undefined {
  return api?.getRepo !== undefined &&
    api.findOpenPullRequest !== undefined &&
    api.createPullRequest !== undefined &&
    api.updatePullRequest !== undefined
    ? (api as PullRequestApi)
    : undefined;
}

/**
 * With the repository's last app at home ({@link outsideCheckUnused}, `plan` leaving), a pull
 * request removes the outside check's workflow: the branch chosen as provision chooses it, the
 * file deleted and committed alone, then the push and the pull request, each after its own
 * approval. Answers what remains: the workflow, with the reason, while no pull request removes it
 * (no GitHub access, a refusal, or a clone not on the latest base branch); none otherwise.
 */
export async function proposeOutsideCheckRemoval(
  deps: PhaseDeps,
  plan: DeployPlan,
  github: GitHubTarget,
): Promise<string[]> {
  if (!homeMode(plan) || !(await outsideCheckUnused(deps, plan, { leaving: true }))) return [];
  const stays = (why: string, next = "Remove it in a pull request of your own.") => [
    `The outside check's workflow (${OUTSIDE_CHECK_PATH}): no app of this repository is at home any more, but ${why}. ${next}`,
  ];
  const api = pullRequestApi(github.api);
  if (api === undefined || github.owner === undefined || github.repo === undefined) {
    return stays("OpsCrew has no GitHub access here to open a pull request that removes it");
  }
  const { owner, repo } = github;
  try {
    const { defaultBranch } = await api.getRepo(owner, repo);
    // Only these calls are made: the branch's open pull request, then its creation or update.
    const setup: GitHubSetup = { api: api as GitHubApi, owner, repo, defaultBranch };
    const git = gitClient(deps);
    const chosen = await chooseDeployBranch(deps, git, setup, plan);
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
      phase: "provision",
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
    return stays(deps.redactor.redact(lowerFirst(reasonOf(error))));
  }
}
