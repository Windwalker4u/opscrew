import type { GitPlatformRunnerInfo, GitPlatformRunnerToken } from "@opscrew/contracts";
import { runnerLabel } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import type { GitPlatformTarget } from "../shared/git-platform";

/**
 * Looks up existing runners matching the plan's label (`opscrew-<app>-<env>`) and mints a fresh
 * runner registration / authentication token on any registered git platform.
 */
export async function ensurePlatformRunner(
  deps: Pick<PhaseDeps, "audit">,
  target: GitPlatformTarget,
  plan: DeployPlan,
  options: { description?: string } = {},
): Promise<{
  existing: GitPlatformRunnerInfo[];
  registration: GitPlatformRunnerToken;
  label: string;
}> {
  const label = runnerLabel(plan);
  const runners = await target.client.listRunners(target.remote);
  const existing = runners.filter((r) => r.labels.includes(label));
  const registration = await target.client.createRunnerToken(target.remote, {
    description: options.description ?? `OpsCrew runner (${plan.app.name})`,
    labels: [label],
  });
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `create ${target.platform.displayName} runner token`,
    target: target.remote.fullPath,
    decision: "approved",
    detail: `label ${label}`,
  });
  return { existing, registration, label };
}

/** Deletes every runner carrying `label` on `target` and audits each removal. */
export async function removePlatformRunners(
  deps: Pick<PhaseDeps, "audit">,
  target: GitPlatformTarget,
  label: string,
): Promise<number> {
  const matching = (await target.client.listRunners(target.remote)).filter((r) =>
    r.labels.includes(label),
  );
  for (const runner of matching) {
    await target.client.deleteRunner(target.remote, runner.id);
    await deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action: `delete ${target.platform.displayName} runner`,
      target: target.remote.fullPath,
      decision: "approved",
      detail: `${runner.name} (#${runner.id})`,
    });
  }
  return matching.length;
}
