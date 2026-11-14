/**
 * B's connectors beside A's in the user's Portainer while the app moves to another Cloudflare
 * account (plan 9.): the stacks `opscrew-<app>-tunnel-next` (web mode `tunnel`, on the app stack's
 * network) and `opscrew-<app>-portainer-tunnel-next` (redeploy `cloudflare`), each with its tunnel's
 * token in its environment in Portainer, set up or removed through one stack plan approved by its
 * hash (`stack-apply`). The Portainer connector plans and applies them ({@link NextStacksApi}).
 */
import {
  type ApplyStackOptions,
  applyStackPlan,
  type PortainerClient,
  type PortainerFacts,
  planNextStacks,
  type StackPlan,
  stackPlanHash,
  valueFingerprints,
} from "@opscrew/connector-portainer";
import type { PhaseName } from "@opscrew/contracts";
import { OpsCrewError, plural, writeFileAtomic } from "@opscrew/core";
import {
  portainerConnectorStackName,
  portainerStackName,
  portainerTarget,
  renderNextConnectorStacks,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import {
  requirePortainerConnection,
  requirePortainerToken,
  stackPlanFile,
} from "../provision/portainer";
import { connectPortainer } from "../provision/portainer-flow";
import { describeStackPlan, requireNoStackBlockers } from "../provision/stack-plan";
import type { TunnelModule } from "../rotate/infra-connectors";
import { PlanRefusedError } from "../shared";
import type { MoveSession } from "./types";

/** The phase the move's host and stack plans are audited under. */
export const MOVE_PHASE: PhaseName = "cloudflare-move";

/** What the Portainer connector's `planNextStacks` is given. */
export interface NextStacksInput {
  /** The app's name, which the stacks' names derive from. */
  app: string;
  environmentId: number;
  /** The beside stacks to run, as `renderNextConnectorStacks` renders them, or `"remove"` them. */
  stacks: readonly { name: string; compose: string }[] | "remove";
  /**
   * By stack name, `valueFingerprints(valueKey, { TUNNEL_TOKEN: token })` of the token it gets, so
   * a stack whose token changed plans an update and the plan is bound to the tokens; `{}` to
   * remove.
   */
  fingerprints: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** What the beside stacks' apply is given: the approved hash, and each stack's token by its name. */
export interface NextStacksApplyOptions {
  approvedHash: string;
  secrets: {
    /** The app stack's values: none (this plan has no app stack). */
    env: Readonly<Record<string, string>>;
    /** Each beside stack's `TUNNEL_TOKEN`, by the stack's name. */
    nextTunnelTokens: Readonly<Record<string, string>>;
  };
  /** The local value key the fingerprints were made with. */
  valueKey: Uint8Array;
  wait?: ApplyStackOptions["wait"];
}

/**
 * The Portainer connector's beside stacks: `plan` (`planNextStacks`) makes their stack plan, each
 * change `in-place` when the stack runs with its token's fingerprint (or, to remove, when it is
 * not there); `apply` (`applyStackPlan`) applies it after its approval, refusing another hash.
 */
export interface NextStacksApi {
  plan: (facts: PortainerFacts, input: NextStacksInput) => StackPlan;
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
    throw new OpsCrewError(
      "INTERNAL",
      "Each connector beside the current ones in Portainer needs its tunnel of the new Cloudflare account, so OpsCrew changed nothing in Portainer.",
      {
        hint: "This is a bug in OpsCrew; please report it.",
      },
    );
  }
  return { stacks, tokens };
}

/**
 * The beside stacks' stack plan in the user's Portainer: `run` B's `tunnels` (each stack with its
 * token) or `remove` them. Portainer is reached with its pinned certificate and inspected
 * read-only; the plan is saved, shown and checked for blockers; one that changes nothing is
 * skipped; else it is approved by its hash (`stack-apply`), checked against the approval store and
 * applied, the tokens sent only to Portainer. The start, every change and a failure are audited by
 * the hash.
 */
export async function nextStacksStep(
  session: MoveSession,
  deps: PhaseDeps,
  plan: DeployPlan,
  api: NextStacksApi,
  want: { run: readonly { module: TunnelModule; token: string }[] } | { remove: true },
): Promise<void> {
  const command = session.command;
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
    return;
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
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: MOVE_PHASE,
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
  deps.reporter.success(`Changed your Portainer (${plural(applied.length, "change")} applied).`);
}
