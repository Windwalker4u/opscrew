import type {
  GitPlatformChangeRequest,
  GitPlatformClient,
  GitPlatformDefinition,
  GitPlatformEnvironmentCapability,
  GitPlatformRemote,
} from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { gitPlatformByCicdProvider } from "@opscrew/git-platforms";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { gitPlatformConnectorFor, requireGitPlatformRemote } from "../shared/git-platform";

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
  options: { client?: GitPlatformClient } = {},
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
    options.client ?? (await gitPlatformConnectorFor(deps, platform, remote.host)).client;
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
 * Ensures the deployment environment (when supported) and stores each deploy secret on the git
 * platform, reporting existing vs. newly created secrets.
 */
export async function setPlatformDeploySecrets(
  deps: Pick<PhaseDeps, "audit">,
  setup: Pick<GitPlatformSetup, "platform" | "remote" | "client">,
  input: {
    environment?: string;
    branch?: string;
    secrets: Readonly<Record<string, string>>;
    protected?: boolean;
  },
): Promise<{ capability: GitPlatformEnvironmentCapability; created: string[]; updated: string[] }> {
  const capability = await setup.client.environmentCapability(setup.remote, {
    ...(input.branch !== undefined ? { branch: input.branch } : {}),
  });
  const envScope = capability.available ? input.environment : undefined;
  if (envScope !== undefined) {
    await setup.client.ensureEnvironment(setup.remote, envScope);
  }
  const created: string[] = [];
  const updated: string[] = [];
  const protect =
    input.protected === true && (envScope !== undefined || capability.protectedAvailable);
  for (const [name, value] of Object.entries(input.secrets)) {
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
    target: setup.remote.fullPath,
    decision: "approved",
    detail: `${created.length} created, ${updated.length} updated${envScope ? ` in ${envScope}` : ""}`,
  });
  return { capability, created, updated };
}

/**
 * Deletes deploy secrets (and optionally the deployment environment) during teardown on a git
 * platform.
 */
export async function deletePlatformDeploySecrets(
  deps: Pick<PhaseDeps, "audit">,
  setup: Pick<GitPlatformSetup, "platform" | "remote" | "client">,
  input: { names: readonly string[]; environment?: string; deleteEnvironment?: boolean },
): Promise<string[]> {
  const deleted: string[] = [];
  for (const name of input.names) {
    const exists = await setup.client.secretExists(setup.remote, name, {
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });
    if (!exists) continue;
    await setup.client.deleteSecret(setup.remote, name, {
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
    });
    deleted.push(name);
  }
  if (input.deleteEnvironment === true && input.environment !== undefined) {
    await setup.client.deleteEnvironment(setup.remote, input.environment);
  }
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `delete ${setup.platform.displayName} ${setup.platform.texts.pipelineNoun} secrets`,
    target: setup.remote.fullPath,
    decision: "approved",
    detail: `${deleted.length} deleted${input.environment ? ` in ${input.environment}` : ""}`,
  });
  return deleted;
}

/** Opens or updates a pull/merge request for deployment files on any registered git platform. */
export async function publishPlatformChangeRequest(
  deps: Pick<PhaseDeps, "audit">,
  setup: Pick<GitPlatformSetup, "platform" | "remote" | "client">,
  input: { head: string; base: string; title: string; body: string },
): Promise<{ changeRequest: GitPlatformChangeRequest; created: boolean }> {
  const existing = await setup.client.findOpenChangeRequest(setup.remote, input.head, input.base);
  const changeRequest = existing
    ? await setup.client.updateChangeRequest(setup.remote, existing.number, {
        title: input.title,
        body: input.body,
      })
    : await setup.client.createChangeRequest(setup.remote, input);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `${existing ? "update" : "open"} ${setup.platform.texts.changeRequestNoun}`,
    target: setup.remote.fullPath,
    decision: "approved",
    detail: `#${changeRequest.number}`,
  });
  return { changeRequest, created: existing === undefined };
}
