import type { GitClient } from "@opscrew/connector-github";
import type {
  GitPlatformChangeRequest,
  GitPlatformClient,
  GitPlatformDefinition,
  GitPlatformEnvironmentCapability,
  GitPlatformRemote,
  PhaseName,
} from "@opscrew/contracts";
import { OpsCrewError, toPosixRelative, writeFileAtomic } from "@opscrew/core";
import { gitPlatformByCicdProvider } from "@opscrew/git-platforms";
import {
  DEPLOY_SECRETS,
  deploySecretName,
  deploySecretNamesFor,
  githubEnvironment,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { workflowBranch } from "../environments/branches";
import { writePlanIfChanged } from "../shared";
import { gitPlatformConnectorFor, requireGitPlatformRemote } from "../shared/git-platform";
import { recordStoredValues } from "../values/record";
import { DEPLOY_SETUP_BRANCH, deploySetupPullRequestBody, type PublishResult } from "./publish";
import type { ProvisionPhase } from "./steps";

/** Authenticated git platform context for provisioning on any registered platform. */
export interface GitPlatformSetup {
  platform: GitPlatformDefinition;
  remote: GitPlatformRemote;
  client: GitPlatformClient;
  defaultBranch: string;
  containerImage: string;
}

/**
 * Resolves the repository's git platform, checks its API token, reads repository metadata, and
 * computes the container image name for `plan`.
 */
export async function setupGitPlatform(
  deps: Pick<PhaseDeps, "paths" | "runner" | "env" | "redactor" | "fetch" | "version">,
  plan: Pick<DeployPlan, "app" | "cicd">,
  options: { client?: GitPlatformClient | null } = {},
): Promise<GitPlatformSetup> {
  const expected = gitPlatformByCicdProvider(plan.cicd.provider);
  const { platform, remote } = await requireGitPlatformRemote(deps);
  if (platform.id !== expected.id) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The plan targets ${expected.displayName} (${plan.cicd.provider}), but origin points to ${platform.displayName} (${remote.host}/${remote.fullPath}).`,
      { hint: expected.texts.remoteFixHint },
    );
  }
  const client =
    options.client === null
      ? undefined
      : (options.client ?? (await gitPlatformConnectorFor(deps, platform, remote.host)).client);
  if (!client) {
    throw new OpsCrewError(
      "CREDENTIALS_MISSING",
      `No ${platform.displayName} token found: set ${platform.credentials.envVars.join(" or ")}.`,
      { hint: platform.texts.tokenFixHint },
    );
  }
  const repo = await client.getRepo(remote);
  return {
    platform,
    remote,
    client,
    defaultBranch: repo.defaultBranch,
    containerImage: platform.containerImage(remote, plan.app.key, plan.cicd.registryHost),
  };
}

/**
 * Gates secret upload behind a `github-secrets` approval listing only secret names (Constitution I),
 * then ensures the deployment environment (when supported) and stores each deploy secret on the
 * git platform. Throws `APPROVAL_REFUSED` without mutating the platform when declined.
 */
export async function setPlatformDeploySecrets(
  deps: Pick<PhaseDeps, "approvals" | "audit" | "paths" | "reporter">,
  setup: Pick<GitPlatformSetup, "platform" | "remote" | "client">,
  plan: DeployPlan,
  input: {
    secrets: Readonly<Record<string, string>>;
    variableNames?: readonly string[];
    environment?: string;
    branch?: string;
    protected?: boolean;
    phase?: Extract<PhaseName, "provision" | "dns" | "retarget">;
    about?: string;
  },
): Promise<{ capability: GitPlatformEnvironmentCapability; created: string[]; updated: string[] }> {
  const allowed = new Set(deploySecretNamesFor(plan));
  const placed = new Map<string, string>();
  for (const [rawName, value] of Object.entries(input.secrets)) {
    if (!allowed.has(rawName)) continue;
    placed.set(deploySecretName(plan, rawName), value);
  }
  const names = [...placed.keys()].sort();
  const capability = await setup.client.environmentCapability(setup.remote, {
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  });
  const envScope = capability.available ? input.environment : undefined;
  const variableNames = input.variableNames ?? [];
  const approval = await deps.approvals.request({
    kind: "github-secrets",
    title: `Store ${names.length} deploy secrets in ${setup.platform.displayName} ${setup.platform.texts.pipelineNoun} for ${setup.remote.fullPath}`,
    details: [
      `Secrets${envScope ? ` in environment ${envScope}` : ""} (names only; values are never shown):`,
      ...names.map((name) => `  ${name}`),
      input.about ??
        `The app environment contains: ${variableNames.length > 0 ? variableNames.join(", ") : "no variables"}.`,
    ].join("\n"),
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The deploy secrets were not stored, so ${setup.platform.displayName} cannot deploy yet. The server is running.`,
      { hint: "Run `opscrew provision` again when you are ready; it continues from here." },
    );
  }
  if (envScope !== undefined) {
    await setup.client.ensureEnvironment(setup.remote, envScope);
  }
  const created: string[] = [];
  const updated: string[] = [];
  const protect =
    input.protected === true && (envScope !== undefined || capability.protectedAvailable);
  for (const name of names) {
    const value = placed.get(name) as string;
    const exists = await setup.client.secretExists(setup.remote, name, {
      ...(envScope !== undefined ? { environment: envScope } : {}),
    });
    await setup.client.setSecret(setup.remote, name, value, {
      ...(envScope !== undefined ? { environment: envScope } : {}),
      ...(protect ? { protected: true } : {}),
    });
    if (exists) updated.push(name);
    else created.push(name);
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `store ${setup.platform.displayName} ${setup.platform.texts.pipelineNoun} secrets`,
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    target: setup.remote.fullPath,
    decision: "approved",
    detail: `${created.length} created, ${updated.length} updated${envScope ? ` in ${envScope}` : ""}`,
  });
  await writeFileAtomic(
    deps.paths.files.deploySecrets,
    `${JSON.stringify({
      host: input.secrets[DEPLOY_SECRETS.host],
      repo: setup.remote.fullPath,
      names,
      ...(envScope !== undefined ? { environment: envScope } : {}),
    })}\n`,
  );
  const appEnv = placed.get(deploySecretName(plan, DEPLOY_SECRETS.appEnv));
  if (appEnv !== undefined) {
    const buildEnv = placed.get(deploySecretName(plan, DEPLOY_SECRETS.buildEnv));
    const buildSecrets = placed.get(deploySecretName(plan, DEPLOY_SECRETS.buildSecrets));
    await recordStoredValues(deps, plan, {
      appEnv,
      ...(buildEnv !== undefined ? { buildEnv } : {}),
      ...(buildSecrets !== undefined ? { buildSecrets } : {}),
    });
  }
  deps.reporter.success(
    `Stored ${names.length} deploy secrets in ${setup.platform.displayName}${envScope ? ` (${envScope})` : ""}.`,
  );
  return { capability, created, updated };
}

/**
 * Gates opening or updating a change request (pull/merge request) behind a `pull-request` approval
 * (Constitution I). Returns `approved: false` without mutating the platform when declined.
 */
export async function publishPlatformChangeRequest(
  deps: Pick<PhaseDeps, "approvals" | "audit" | "reporter">,
  setup: Pick<GitPlatformSetup, "platform" | "remote" | "client">,
  input: {
    head: string;
    base: string;
    title: string;
    body: string;
    phase?: PhaseName;
  },
): Promise<{
  changeRequest?: GitPlatformChangeRequest;
  created: boolean;
  approved: boolean;
}> {
  const existing = await setup.client.findOpenChangeRequest(setup.remote, input.head, input.base);
  const noun = setup.platform.texts.changeRequestNoun;
  const approval = await deps.approvals.request({
    kind: "pull-request",
    title: existing
      ? `Update the open ${noun} ${existing.url} to "${input.title}"`
      : `Open the ${noun} "${input.title}" into ${input.base}`,
    details: input.body,
  });
  if (!approval.approved) {
    deps.reporter.warn(
      existing
        ? `Pushed to the open ${noun} ${existing.url}; its title and body stay as they were.`
        : `No ${noun} opened. Open one from ${input.head} into ${input.base} when you are ready.`,
    );
    return {
      ...(existing !== undefined ? { changeRequest: existing } : {}),
      created: false,
      approved: false,
    };
  }
  const changeRequest = existing
    ? await setup.client.updateChangeRequest(setup.remote, existing.number, {
        title: input.title,
        body: input.body,
      })
    : await setup.client.createChangeRequest(setup.remote, input);
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: existing ? "pull-request-update" : "pull-request",
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
    target: changeRequest.url,
    decision: "approved",
    detail: `#${changeRequest.number}`,
  });
  deps.reporter.success(
    existing ? `Updated ${noun} ${changeRequest.url}` : `Opened ${changeRequest.url}`,
  );
  return { changeRequest, created: existing === undefined, approved: true };
}

/**
 * Writes `opscrew/plan.yaml`, commits generated deployment files on the deploy branch, requests a
 * `git-push` approval before pushing, and opens/updates the platform's change request (merge
 * request on GitLab) behind a `pull-request` approval.
 */
export async function publishPlatformDeployment(
  deps: PhaseDeps,
  input: {
    git: GitClient;
    setup: GitPlatformSetup;
    plan: DeployPlan;
    files: readonly string[];
    push: boolean;
    secretsStored: boolean;
    phase: ProvisionPhase;
  },
): Promise<{ plan: DeployPlan; published: PublishResult }> {
  const { git, setup, plan } = input;
  await writePlanIfChanged(deps, plan);
  const paths = [...input.files, toPosixRelative(deps.paths.root, deps.paths.files.plan)];
  const base = workflowBranch(plan, setup.defaultBranch);
  const branch =
    plan.app.key === undefined ? DEPLOY_SETUP_BRANCH : `${DEPLOY_SETUP_BRANCH}-${plan.app.key}`;
  const current = await git.currentBranch();
  await git.add(paths);
  const staged = await git.hasStagedChanges(paths);
  if (!staged) {
    return {
      plan,
      published: { branch: current, base, published: false, pushed: false },
    };
  }
  if (current !== branch) {
    if (await git.branchExists(branch)) await git.checkout(branch);
    else await git.createBranch(branch);
  }
  const commitMessage = `chore(opscrew): deployment infrastructure for ${plan.app.name}\n\nGenerated by OpsCrew ${deps.version}.`;
  const commit = await git.commit(commitMessage, paths);
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "commit",
    phase: input.phase,
    target: branch,
    detail: commit,
  });
  const result: PublishResult = {
    branch,
    base,
    commit,
    published: true,
    pushed: false,
  };
  if (!input.push) return { plan, published: result };

  const pushApproval = await deps.approvals.request({
    kind: "git-push",
    title: `Push branch ${branch} to ${setup.remote.fullPath}`,
    details: `Files:\n${paths.map((p) => `  ${p}`).join("\n")}`,
  });
  if (!pushApproval.approved) {
    deps.reporter.warn(
      `Not pushed. The commit stays on the local branch ${branch}; push it yourself and open a ${setup.platform.texts.changeRequestNoun} into ${base}.`,
    );
    return { plan, published: result };
  }
  await git.push(branch, { setUpstream: true });
  result.pushed = true;
  await deps.audit.append({
    kind: "git",
    actor: "opscrew",
    action: "push",
    phase: input.phase,
    target: `${setup.remote.fullPath}:${branch}`,
    decision: "approved",
  });

  const title = `Add OpsCrew deployment setup for ${plan.app.name}`;
  const body = deploySetupPullRequestBody(plan, deps.version, {
    secretsStored: input.secretsStored,
  });
  const cr = await publishPlatformChangeRequest(deps, setup, {
    head: branch,
    base,
    title,
    body,
    phase: input.phase,
  });
  if (cr.changeRequest !== undefined) {
    result.prUrl = cr.changeRequest.url;
  }
  return { plan, published: result };
}

/** Default deployment environment name for a plan on any git platform. */
export function platformEnvironmentName(plan: DeployPlan): string {
  return githubEnvironment(plan) ?? "production";
}
