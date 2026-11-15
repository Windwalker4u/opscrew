/**
 * B's connectors beside A's in the user's Portainer while the app moves to another Cloudflare
 * account (plan 9.): the stacks `opscrew-<app>-tunnel-next` (web mode `tunnel`, on the app stack's
 * network) and `opscrew-<app>-portainer-tunnel-next` (redeploy `cloudflare`), each with its tunnel's
 * token in its environment in Portainer, set up or removed through one stack plan approved by its
 * hash (`stack-apply`). The Portainer connector plans and applies them ({@link NextStacksApi}).
 */
import {
  type ApplySecrets,
  type ApplyStackOptions,
  applyStackPlan,
  type DesiredNextStacks,
  type PortainerClient,
  type PortainerFacts,
  planNextStacks,
  type StackPlan,
  stackPlanHash,
  valueFingerprints,
} from "@opscrew/connector-portainer";
import { plural, writeFileAtomic } from "@opscrew/core";
import {
  portainerConnectorStackName,
  portainerStackName,
  portainerTarget,
  renderNextConnectorStacks,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import {
  requirePortainerConnection,
  requirePortainerToken,
  stackPlanFile,
} from "../provision/portainer";
import { connectPortainer } from "../provision/portainer-flow";
import { describeStackPlan, requireNoStackBlockers } from "../provision/stack-plan";
import { appliesNow } from "../retarget/steps";
import type { TunnelModule } from "../rotate/infra-connectors";
import { PlanRefusedError } from "../shared";
import { clearPending, type MovePlanKey, writePending } from "./progress";
import { pendingStop } from "./shared";
import { bug, environmentDeps, MOVE_PHASE, moveAudit } from "./texts";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

/** What the beside stacks' apply is given: the approved hash, and each stack's token by its name. */
export type NextStacksApplyOptions = Omit<ApplyStackOptions, "secrets" | "valueKey"> & {
  /** No app stack values (this plan has no app stack), and each beside stack's `TUNNEL_TOKEN`. */
  secrets: Pick<ApplySecrets, "env"> & Required<Pick<ApplySecrets, "nextTunnelTokens">>;
  /** The local value key the fingerprints were made with. */
  valueKey: Uint8Array;
};

/**
 * The Portainer connector's beside stacks: `plan` (`planNextStacks`) makes their stack plan, each
 * change `in-place` when the stack runs with its token's fingerprint (or, to remove, when it is
 * not there); `apply` (`applyStackPlan`) applies it after its approval, refusing another hash.
 */
export interface NextStacksApi {
  plan: (facts: PortainerFacts, input: DesiredNextStacks) => StackPlan;
  apply: (
    client: PortainerClient,
    plan: StackPlan,
    options: NextStacksApplyOptions,
  ) => Promise<{ applied: readonly string[] }>;
}

/**
 * The beside stacks' planner and apply: the given ones; none is built into OpsCrew yet, so a move
 * of an app in Portainer stops here before anything changes.
 */
export function nextStacksApi(options: { nextStacks?: NextStacksApi }): NextStacksApi {
  return options.nextStacks ?? { plan: planNextStacks, apply: applyStackPlan };
}

/** The beside stack that runs the connector of a tunnel of `module`. */
function besideStackName(plan: DeployPlan, module: TunnelModule): string {
  return module === "tunnel"
    ? `${portainerStackName(plan)}-tunnel-next`
    : `${portainerConnectorStackName(plan)}-next`;
}

/** The beside stacks with their tokens by stack name: one for each of `tunnels`, as rendered. */
function besideStacks(
  plan: DeployPlan,
  tunnels: readonly { module: TunnelModule; token: string }[],
): { stacks: { name: string; compose: string }[]; tokens: Record<string, string> } {
  const tokens: Record<string, string> = {};
  for (const tunnel of tunnels) tokens[besideStackName(plan, tunnel.module)] = tunnel.token;
  const stacks = renderNextConnectorStacks(plan).map((stack) => ({
    name: stack.name,
    compose: stack.content,
  }));
  if (
    stacks.length !== tunnels.length ||
    stacks.some((stack) => tokens[stack.name] === undefined)
  ) {
    throw bug(
      "Each connector beside the current ones in Portainer needs its tunnel of the new Cloudflare account, so OpsCrew changed nothing in Portainer.",
    );
  }
  return { stacks, tokens };
}

/**
 * The beside stacks' stack plan in the user's Portainer: `run` B's `tunnels` (each stack with its
 * token) or `remove` them. Portainer is reached with its pinned certificate and inspected
 * read-only; the plan is saved, shown and checked for blockers; one that changes nothing is
 * skipped. A run that doesn't apply it now (not interactive, and no `--approve` with its hash)
 * records it as waiting (`connector`) and stops with the command that applies it; else it is
 * approved by its hash (`stack-apply`), checked against the approval store and applied, the tokens
 * sent only to Portainer. The start, every change and a failure are audited by the hash.
 */
export async function nextStacksStep(
  session: MoveSession,
  environment: MoveEnvironment,
  api: NextStacksApi,
  want: { run: readonly { module: TunnelModule; token: string }[] } | { remove: true },
): Promise<StepStop | undefined> {
  const command = session.command;
  const deps = environmentDeps(session, environment);
  const { plan } = environment;
  const key: MovePlanKey = { action: "connector", environment: environment.environment };
  const { stacks, tokens } =
    "run" in want ? besideStacks(plan, want.run) : { stacks: "remove" as const, tokens: {} };
  const connected = await connectPortainer(deps, {
    plan,
    connection: await requirePortainerConnection(deps, plan),
    token: requirePortainerToken(deps),
    services: session.services.portainer ?? {},
    phase: MOVE_PHASE,
    command,
  });
  const fingerprints = Object.fromEntries(
    Object.entries(tokens).map(([name, token]) => [
      name,
      valueFingerprints(connected.valueKey, { TUNNEL_TOKEN: token }),
    ]),
  );
  const stackPlan = api.plan(connected.facts, {
    app: plan.app.name,
    environmentId: portainerTarget(plan.target).environmentId,
    stacks,
    fingerprints,
  });
  const hash = stackPlanHash(stackPlan);
  await writeFileAtomic(
    stackPlanFile(deps.paths, hash),
    `${JSON.stringify(stackPlan, null, 2)}\n`,
    { mode: 0o600 },
  );
  const details = describeStackPlan(stackPlan, hash, connected.facts.environment?.name);
  deps.reporter.info(details);
  requireNoStackBlockers(stackPlan, command);
  const changes = stackPlan.changes.filter((change) => change.state === "change");
  const running = "run" in want;
  if (changes.length === 0) {
    deps.reporter.success(
      running
        ? "The new Cloudflare account's tunnel connectors run beside the current ones in your Portainer; nothing in it changes."
        : "No connector of the new Cloudflare account runs beside the current ones in your Portainer; nothing in it changes.",
    );
    await clearPending(deps, key);
    return undefined;
  }
  if (!appliesNow(session, hash)) {
    await writePending(deps, key, hash);
    return pendingStop(session, hash);
  }
  const approval = await deps.approvals.request({
    kind: "stack-apply",
    title: running
      ? `Run the new Cloudflare account's tunnel connectors beside the current ones in your Portainer (${plural(changes.length, "change")})`
      : `Remove the new Cloudflare account's tunnel connectors beside the current ones from your Portainer (${plural(changes.length, "change")})`,
    details,
    planHash: hash,
  });
  if (!approval.approved) {
    throw new PlanRefusedError({
      plan: "stack plan",
      ...(approval.reason ? { reason: approval.reason } : {}),
      unchanged: "Nothing in Portainer was changed.",
      hint: `To apply it later without prompts, run: ${command} --approve ${hash}`,
    });
  }
  await deps.approvals.assertApprovedStackPlan(hash);
  const audit = (action: string, decision: "approved" | "refused", detail: string) =>
    moveAudit(deps, {
      kind: "provider-call",
      action,
      target: hash,
      decision,
      detail,
    });
  await audit("stack apply started", "approved", `changes: ${changes.map((c) => c.id).join(", ")}`);
  deps.reporter.step(`Changing your Portainer (${plural(changes.length, "change")})`);
  let applied: readonly string[];
  try {
    ({ applied } = await api.apply(connected.client, stackPlan, {
      approvedHash: hash,
      secrets: { env: {}, nextTunnelTokens: tokens },
      valueKey: connected.valueKey,
      ...(session.services.portainer?.wait === undefined
        ? {}
        : { wait: session.services.portainer.wait }),
    }));
  } catch (error) {
    await audit(
      "stack apply failed",
      "refused",
      "the next stack plan shows what is left to change",
    );
    throw error;
  }
  for (const change of changes.filter((item) => applied.includes(item.id))) {
    await audit(`stack change ${change.id}`, "approved", change.title);
  }
  await clearPending(deps, key);
  deps.reporter.success(`Changed your Portainer (${plural(applied.length, "change")} applied).`);
  return undefined;
}
