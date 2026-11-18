/**
 * A restore drill's stack in the user's Portainer (029 plan.md 19., research R24): a second stack,
 * `opscrew-<app>-drill`, from a string beside the app's, its stack plan approved by its hash
 * (`stack-apply`, with `allowDestroy`, since the drill removes it and its volumes again). It is
 * created with the restored services only, the app added once the data is back, then removed with
 * its volumes, and a list proves they are gone. Only names that start with `opscrew-<app>-drill`
 * are created or removed: the app's own stacks and volumes never; the volumes the drill only reads
 * (the app's snapshots volume) are external.
 */
import { isPlanHash, OpsCrewError, sha256Hex, zodIssues } from "@opscrew/core";
import { z } from "zod";
import {
  type ApplyStackOptions,
  deployBaseline,
  deployWait,
  NEW_DEPLOY,
  waitForDeploy,
} from "./apply";
import type { EnvPair, PortainerClient, StackDetails, VolumeSummary } from "./client";
import { opscrewNames, VolumeNameSchema } from "./names";
import {
  ComposeTextSchema,
  composeVariables,
  STACK_PLAN_SCHEMA_VERSION,
  type StackChange,
  type StackParamValue,
  type StackPlan,
  StackPlanSchema,
  stackPlanHash,
} from "./plan";

/** What a drill's stack name adds to the app's: `opscrew-<app>-drill`. */
export const DRILL_STACK_SUFFIX = "-drill";

/** The drill's stack of the app `app` (its plan's `app.name`): `opscrew-<app>-drill`. */
export function drillStackName(app: string): string {
  return `${opscrewNames(app).app}${DRILL_STACK_SUFFIX}`;
}

/** The drill's stack to run, as `@opscrew/iac-templates` renders it. */
export interface DesiredDrillStack {
  /** The app's name in its plan; the stack is {@link drillStackName}. */
  app: string;
  environmentId: number;
  /** The snapshot it restores (letters and digits). */
  snapshot: string;
  /** The stack's file with the restored services only: the app is not started yet. */
  services: string;
  /** The same file with the app, deployed once the data is back. */
  withApp: string;
  /** The volumes the stack makes (`<stack>_<key>`), which the drill removes again. */
  volumes: readonly string[];
  /** The volumes it reads and never changes or removes (the app's snapshots volume). */
  external: readonly string[];
}

/** What the environment holds now, read-only: its stacks and volumes. */
export interface DrillFound {
  stacks: readonly StackDetails[];
  volumes: readonly VolumeSummary[];
}

/** A file that publishes no port and has its one network cut off (`internal: true`). */
const DrillComposeSchema = ComposeTextSchema.refine((text) => !/^\s*ports\s*:/m.test(text), {
  message: "must publish no port",
}).refine((text) => /^\s*internal: true$/m.test(text), {
  message: "must have its network cut off (internal: true)",
});

const DesiredDrillStackSchema = z.strictObject({
  app: z.string(),
  environmentId: z.int().positive(),
  snapshot: z.string().regex(/^[0-9A-Za-z]+$/, { message: "must be a snapshot's id" }),
  services: DrillComposeSchema,
  withApp: DrillComposeSchema,
  volumes: z.array(VolumeNameSchema).max(64),
  external: z.array(VolumeNameSchema).max(8),
});

/** True for a name of the drill's stack `name` or one of its volumes. */
function ofDrill(name: string, candidate: string): boolean {
  return candidate === name || candidate.startsWith(`${name}_`);
}

/**
 * The stack plan of a restore drill of `desired.snapshot` (purpose `drill`): first, when an earlier
 * drill left its stack or volumes, their removal (blocked when a Git stack has the name, which is
 * then not a drill's); then the drill: the stack `opscrew-<app>-drill` created from
 * `desired.services`, deployed again from `desired.withApp`, and removed with `desired.volumes`.
 * Every name is checked to be the drill's; the external volumes never are.
 * @throws OpsCrewError `INVALID_INPUT` for a file that publishes a port or isn't cut off, or a
 * name that isn't the drill's.
 */
export function planDrillStack(found: DrillFound, desired: DesiredDrillStack): StackPlan {
  const parsed = DesiredDrillStackSchema.safeParse(desired);
  if (!parsed.success) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The restore drill's stack is not valid: ${zodIssues(parsed.error, 5)}`,
    );
  }
  const d = parsed.data;
  const name = drillStackName(d.app);
  const app = opscrewNames(d.app).app;
  const wrong = [
    ...d.volumes.filter((volume) => !volume.startsWith(`${name}_`)),
    ...d.external.filter((volume) => ofDrill(name, volume) || !volume.startsWith(`${app}_`)),
  ];
  if (wrong.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The restore drill's stack names volumes that are not its own to make or the app's to read (${wrong.join(", ")}), so OpsCrew changes nothing.`,
    );
  }
  const changes: StackChange[] = [];
  const stack = found.stacks.find((each) => each.name.toLowerCase() === name);
  const volumes = found.volumes
    .map((volume) => volume.name)
    .filter((volume) => volume.startsWith(`${name}_`))
    .sort();
  if (stack !== undefined || volumes.length > 0) {
    const what = [
      ...(stack === undefined ? [] : [`the stack ${name}`]),
      ...(volumes.length === 0 ? [] : [`the volumes ${volumes.join(", ")}`]),
    ].join(" and ");
    const params: Record<string, StackParamValue> = {
      action: "remove",
      name,
      volumes,
      ...(stack === undefined ? {} : { stackId: stack.id }),
    };
    changes.push(
      stack?.gitConfig !== undefined
        ? {
            id: "drill-stack",
            title: `Remove ${what}`,
            state: "blocked",
            reason: `Your Portainer has a Git stack named ${name}, which is not one a restore drill made, so OpsCrew does not touch it. Rename or remove it in Portainer, then run the drill again.`,
            params,
          }
        : {
            id: "drill-stack",
            title: `Remove what an earlier restore drill left: ${what}`,
            state: "change",
            params,
          },
    );
  }
  const envKeys = [
    ...new Set([...composeVariables(d.services), ...composeVariables(d.withApp)]),
  ].sort();
  changes.push({
    id: "drill-stack",
    title: `Create the stack ${name} with the snapshot ${d.snapshot} restored into it, start the app on it, check it, then remove the stack and its volumes`,
    state: "change",
    params: {
      action: "drill",
      name,
      snapshot: d.snapshot,
      compose: d.services,
      composeSha256: sha256Hex(d.services),
      withApp: d.withApp,
      withAppSha256: sha256Hex(d.withApp),
      envKeys,
      volumes: [...d.volumes].sort(),
      external: [...d.external].sort(),
    },
  });
  return {
    schemaVersion: STACK_PLAN_SCHEMA_VERSION,
    purpose: "drill",
    app: d.app,
    environmentId: d.environmentId,
    changes,
    findings: [],
    record: { stacks: [], volumes: [] },
  };
}

/** What the drill's stack calls are given: the approved hash, the stack's values, the wait. */
export interface DrillStackOptions {
  /** The hash the user approved (`stack-apply`); any other plan is refused. */
  approvedHash: string;
  /** The stack's `Env` values, exactly for the plan's env keys (the copy's own, never prod's). */
  env: Readonly<Record<string, string>>;
  wait?: ApplyStackOptions["wait"];
}

/** The drill's stack in Portainer, once created: its id, and why its deploy failed, if it did. */
export interface DrillStackDeploy {
  stackId: number;
  /** Portainer's words for a deploy that failed or did not end (redacted). */
  failure?: string;
}

/** The approved plan's drill change and the names it may touch, checked. */
interface Checked {
  plan: StackPlan;
  name: string;
  drill: Readonly<Record<string, StackParamValue>>;
  leftover?: Readonly<Record<string, StackParamValue>>;
  env: EnvPair[];
}

function invalid(message: string): OpsCrewError {
  return new OpsCrewError("INVALID_INPUT", `${message}, so OpsCrew changes nothing in Portainer.`, {
    hint: "Run `opscrew restore --drill` again: it makes a fresh plan for you to approve.",
  });
}

/**
 * The plan, refused unless it is a valid drill plan whose hash is `opts.approvedHash`, with no
 * finding or blocked change, every name the drill's, and every value its env keys need.
 */
function checked(client: PortainerClient, plan: StackPlan, opts: DrillStackOptions): Checked {
  const parsed = StackPlanSchema.safeParse(plan);
  if (!parsed.success || parsed.data.purpose !== "drill") {
    throw invalid("That is not a restore drill's stack plan");
  }
  const valid = parsed.data;
  if (!isPlanHash(opts.approvedHash) || opts.approvedHash.toLowerCase() !== stackPlanHash(valid)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This drill's stack plan is not the one that was approved, so OpsCrew changes nothing in Portainer.",
      { hint: "Run `opscrew restore --drill` again and approve its plan by its hash." },
    );
  }
  if (valid.findings.length > 0 || valid.changes.some((change) => change.state === "blocked")) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew cannot run the drill in your Portainer: ${[...valid.findings.map((each) => each.message), ...valid.changes.flatMap((change) => (change.reason === undefined ? [] : [change.reason]))].join(" ")}`,
      { hint: "Resolve it, then run `opscrew restore --drill` again." },
    );
  }
  const name = drillStackName(valid.app);
  const drill = valid.changes.find((change) => change.params.action === "drill")?.params;
  const leftover = valid.changes.find((change) => change.params.action === "remove")?.params;
  const others = valid.changes.filter(
    (change) =>
      change.id !== "drill-stack" ||
      (change.params.action !== "drill" && change.params.action !== "remove"),
  );
  if (drill === undefined || others.length > 0)
    throw invalid("The drill's stack plan is not whole");
  const names = [drill, ...(leftover === undefined ? [] : [leftover])];
  for (const params of names) {
    if (params.name !== name || !strings(params.volumes).every((v) => v.startsWith(`${name}_`))) {
      throw invalid(`The drill's stack plan names something other than ${name} and its volumes`);
    }
  }
  if (strings(drill.external).some((volume) => ofDrill(name, volume))) {
    throw invalid("The drill's stack plan would make a volume it only reads");
  }
  const keys = strings(drill.envKeys);
  const missing = keys.filter((key) => opts.env[key] === undefined);
  if (missing.length > 0) {
    throw invalid(`The drill's stack has no value for ${missing.join(", ")}`);
  }
  for (const key of keys) {
    const value = opts.env[key] as string;
    if (value !== "") client.registerSecret(value, key);
  }
  return {
    plan: valid,
    name,
    drill,
    ...(leftover === undefined ? {} : { leftover }),
    env: keys.map((key) => ({ name: key, value: opts.env[key] as string })),
  };
}

function strings(value: StackParamValue | undefined): string[] {
  return Array.isArray(value) ? [...value] : [];
}

function text(value: StackParamValue | undefined): string {
  if (typeof value !== "string") throw invalid("The drill's stack plan is not whole");
  return value;
}

/** Portainer's words for a deploy that failed, redacted. */
function deployFailure(client: PortainerClient, error: unknown): string {
  if (!(error instanceof OpsCrewError)) throw error;
  return client.redact(error.message);
}

/**
 * After the approval of `plan`: what an earlier drill left is removed (its stack, if it is still
 * the drill's string stack, and its volumes), then the stack is created from the services' file
 * and its deploy waited for. A deploy that fails is returned (`failure`), not thrown, so the caller
 * removes the stack.
 * @throws OpsCrewError `PLAN_HASH_MISMATCH` for another plan, `INVALID_INPUT` for a plan that names
 * anything else or lacks a value, before any change; Portainer's refusals as they come.
 */
export async function createDrillStack(
  client: PortainerClient,
  plan: StackPlan,
  opts: DrillStackOptions,
): Promise<DrillStackDeploy> {
  const { plan: valid, name, drill, leftover, env } = checked(client, plan, opts);
  const envId = valid.environmentId;
  if (leftover !== undefined) {
    const stackId = leftover.stackId;
    if (typeof stackId === "number") {
      const stack = await client.getStack(stackId);
      if (stack !== undefined) {
        if (stack.name.toLowerCase() !== name || stack.gitConfig !== undefined) {
          throw invalid(`The stack ${stackId} is no longer a drill's stack`);
        }
        await client.removeStack(stackId, envId);
      }
    }
    for (const volume of strings(leftover.volumes)) await client.removeVolume(envId, volume);
  }
  const created = await client.createStringStack(envId, {
    name,
    compose: text(drill.compose),
    env,
  });
  try {
    await waitForDeploy({ client, wait: deployWait(opts.wait) }, created, NEW_DEPLOY, name);
    return { stackId: created.id };
  } catch (error) {
    return { stackId: created.id, failure: deployFailure(client, error) };
  }
}

/**
 * Deploys the drill's stack `stackId` again from the file with the app, the same values, once the
 * data is back, and waits for it; a deploy that fails is returned (`failure`).
 */
export async function startDrillApp(
  client: PortainerClient,
  plan: StackPlan,
  stackId: number,
  opts: DrillStackOptions,
): Promise<Omit<DrillStackDeploy, "stackId">> {
  const { plan: valid, name, drill, env } = checked(client, plan, opts);
  const stack = await client.getStack(stackId);
  if (stack === undefined || stack.name.toLowerCase() !== name || stack.gitConfig !== undefined) {
    throw invalid(`The stack ${stackId} is not the drill's stack ${name}`);
  }
  try {
    const before = await deployBaseline(client, stackId);
    const started = await client.updateStringStack(stackId, valid.environmentId, {
      compose: text(drill.withApp),
      env,
    });
    await waitForDeploy({ client, wait: deployWait(opts.wait) }, started, before, name);
    return {};
  } catch (error) {
    return { failure: deployFailure(client, error) };
  }
}

/** What the removal of a drill's stack left: nothing (`removed`), or the names still there. */
export interface DrillRemoval {
  removed: boolean;
  /** The drill's stack and volumes still listed after the removal. */
  left: string[];
}

/**
 * Removes the drill's stack `stackId` (when given, and still the drill's) and the plan's volumes,
 * each removal tried even when one before it failed, then lists the environment's stacks and
 * volumes: `removed` when none of the drill's names is there any more.
 * @throws OpsCrewError `INVALID_INPUT` for a plan that is not a valid drill plan.
 */
export async function removeDrillStack(
  client: PortainerClient,
  plan: StackPlan,
  stackId: number | undefined,
): Promise<DrillRemoval> {
  const parsed = StackPlanSchema.safeParse(plan);
  const valid = parsed.success && parsed.data.purpose === "drill" ? parsed.data : undefined;
  const drill = valid?.changes.find((change) => change.params.action === "drill")?.params;
  if (valid === undefined || drill === undefined) {
    throw invalid("That is not a restore drill's stack plan");
  }
  const name = drillStackName(valid.app);
  const envId = valid.environmentId;
  const volumes = strings(drill.volumes);
  if (drill.name !== name || !volumes.every((volume) => volume.startsWith(`${name}_`))) {
    throw invalid(`The drill's stack plan names something other than ${name} and its volumes`);
  }
  const attempt = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch {
      // The list below says what is left.
    }
  };
  if (stackId !== undefined) {
    await attempt(async () => {
      const stack = await client.getStack(stackId);
      if (stack?.name.toLowerCase() === name && stack.gitConfig === undefined) {
        await client.removeStack(stackId, envId);
      }
    });
  }
  for (const volume of volumes) await attempt(() => client.removeVolume(envId, volume));
  const stacks = await client.listStacks(envId);
  const listed = await client.listVolumes(envId);
  const left = [
    ...stacks.filter((stack) => stack.name.toLowerCase() === name).map((stack) => stack.name),
    ...listed.map((volume) => volume.name).filter((volume) => volume.startsWith(`${name}_`)),
  ];
  return { removed: left.length === 0, left };
}
