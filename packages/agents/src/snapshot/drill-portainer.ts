/**
 * `opscrew restore --drill [<id>] [--only <service>] [--allow-other-version]` in the user's
 * Portainer (029 plan.md 19., research R24, R27): the snapshot restored into a second stack,
 * `opscrew-<app>-drill`, from the drill's render (`renderPortainerDrill`), approved as a stack plan
 * by its hash (`stack-apply`, `allowDestroy`, `<app>-drill` typed). Read-only first (the snapshot's
 * record in the snapshots volume, the environment's stacks and volumes); then the stack is created
 * with the restored services only, its network read back as internal with no published port (else
 * removed at once), each part restored into its volumes by one-off containers with the snapshots
 * volume read-only, the app deployed on it, its `State.Health.Status` read through the Docker
 * proxy, each database's tables counted, and the stack removed with its volumes, a list proving
 * they are gone. The copy's values are its own: new passwords and `.env.preview`'s values, never
 * production's. Nothing named `opscrew-<app>` is changed.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { DockerContainer, MountSpec } from "@opscrew/connector-docker";
import { dockerClient } from "@opscrew/connector-docker";
import {
  COMPOSE_PROJECT_LABEL,
  createDrillStack,
  type DrillRemoval,
  drillStackName,
  type PortainerClient,
  planDrillStack,
  removeDrillStack,
  type StackPlan,
  stackPlanHash,
  startDrillApp,
} from "@opscrew/connector-portainer";
import {
  errorMessage,
  listText,
  OpsCrewError,
  type ProjectPaths,
  readTextIfExists,
  realSleep,
  writeFileAtomic,
} from "@opscrew/core";
import {
  DRILL_HEALTH_POLL_SECONDS,
  DRILL_HEALTH_SECONDS,
  DRILL_LIMIT_SECONDS,
  DRILL_RUNNING_SECONDS,
  type DrillRecord,
  databaseCount,
  drillName,
  drillPlan,
  FILES_VOLUME,
  PORTAINER_STACK_VARIABLES,
  partRestore,
  portainerSecretVariables,
  portainerServiceEnvironment,
  portainerSnapshotsVolume,
  portainerStackEnvKeys,
  portainerStackName,
  portainerTarget,
  renderPortainerDrill,
  type SnapshotPart,
  SQLITE_VOLUME,
  snapshotParts,
} from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { parse } from "yaml";
import { z } from "zod";
import { requirePortainerConnection, requirePortainerToken } from "../provision/portainer";
import { requireNoStackBlockers } from "../provision/stack-plan";
import { shortDigest } from "../rollback/versions";
import { pollUntil, portainerClientFor, readValidJson } from "../shared";
import { assembleAppEnv, parseDotenv } from "../shared/app-env";
import {
  drillApprovalLines,
  drillCommandText,
  drillImage,
  ownLogins,
  PREVIEW_VALUES_FILE,
  partWordsOf,
  pickParts,
  pickSnapshot,
} from "./drill-core";
import { drillReport, drillSteps } from "./drill-report";
import {
  box,
  DIR,
  ofService,
  type PortainerPlace,
  portainerListingText,
  portainerProbe,
  secretsFile,
  serviceOneOff,
  stopCleanly,
  volumesOf,
} from "./portainer";
import { partWords, typedApprovalRefused } from "./restore-checks";
import type { SnapshotRun } from "./run";
import { type About, KIND_WORDS } from "./store";
import type { DrillReport, DrillRequest } from "./types";

/** Where, in words. */
const WHERE = "in your Portainer";

/**
 * How long the app's health check may take to pass, how long an app with none must keep running,
 * and the pause between two reads of its health (R17), as on a server.
 */
const HEALTH_MS = DRILL_HEALTH_SECONDS * 1000;
const RUNNING_MS = DRILL_RUNNING_SECONDS * 1000;
const HEALTH_POLL_MS = DRILL_HEALTH_POLL_SECONDS * 1000;

/** What a Portainer can't tell OpsCrew reliably, so its drill doesn't check it. */
const NOT_CHECKED =
  "Free disk and memory, and a deploy or snapshot running at the same time, are not checked in a Portainer: its API doesn't report them reliably.";

/** How many of the manual Portainer drills' records this computer keeps, the newest last. */
const KEPT_DRILLS = 20;

/** A word of the record: letters, digits and hyphens, never a value. */
const WORD = /^[a-z0-9-]+$/;

/** One drill's record, the fields of a server's `drills.log` line (`drillRecord`'s shape). */
const DrillRecordSchema = z.strictObject({
  end: z.iso.datetime(),
  kind: z.enum(["manual", "scheduled"]),
  result: z.enum(["healthy", "unhealthy", "not-restored", "skipped", "failed"]),
  id: z
    .string()
    .regex(/^[0-9A-Za-z]+$/)
    .optional(),
  version: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
  start: z.iso.datetime().optional(),
  parts: z.array(
    z.strictObject({
      name: z.string().regex(WORD),
      size: z.int().nonnegative(),
      seconds: z.int().nonnegative(),
    }),
  ),
  health: z
    .strictObject({ state: z.string().regex(/^[a-z]+$/), seconds: z.int().nonnegative() })
    .optional(),
  tables: z.array(
    z.strictObject({ service: z.string().regex(WORD), count: z.int().nonnegative().optional() }),
  ),
  removal: z.enum(["removed", "kept", "failed"]).optional(),
  cleaned: z.boolean(),
  reason: z.string().regex(WORD).optional(),
});

const DrillsFileSchema = z.strictObject({ drills: z.array(DrillRecordSchema).max(KEPT_DRILLS) });

/**
 * Where this computer keeps the environment's manual Portainer drills: `drills.json` in its
 * state folder (`.opscrew/`, or `.opscrew/environments/<env>/`), which a Portainer drill
 * writes after each run, since no log of OpsCrew's sits in the user's Portainer.
 */
export function portainerDrillsFile(paths: Pick<ProjectPaths, "stateDir">): string {
  return join(paths.stateDir, "drills.json");
}

/**
 * The environment's manual Portainer drills this computer recorded, oldest first (the last is
 * the newest); none when there is no record, or it isn't one (zod-checked).
 */
export async function readPortainerDrills(
  paths: Pick<ProjectPaths, "stateDir">,
): Promise<DrillRecord[]> {
  return (await readValidJson(portainerDrillsFile(paths), DrillsFileSchema))?.drills ?? [];
}

/** Adds `record` to this computer's record of the environment's Portainer drills. */
async function keepRecord(run: SnapshotRun, record: DrillRecord): Promise<void> {
  const { deps } = run;
  try {
    const kept = DrillRecordSchema.parse(record);
    const drills = [...(await readPortainerDrills(deps.paths)), kept].slice(-KEPT_DRILLS);
    await mkdir(deps.paths.stateDir, { recursive: true });
    await writeFileAtomic(
      portainerDrillsFile(deps.paths),
      `${JSON.stringify({ drills }, null, 2)}\n`,
    );
  } catch (error) {
    deps.reporter.warn(
      `OpsCrew could not keep the drill's record on this computer: ${deps.redactor.redact(errorMessage(error))}`,
    );
  }
}

/** The app's volumes in a stack, by the part that restores into them. */
const APP_VOLUMES: Partial<Record<SnapshotPart["kind"], string>> = {
  sqlite: SQLITE_VOLUME,
  files: FILES_VOLUME,
};

/**
 * The user's Portainer: its client, the app's environment there, and the snapshots volume through
 * its Docker proxy.
 */
async function connect(
  run: SnapshotRun,
): Promise<{ client: PortainerClient; place: PortainerPlace; environmentId: number }> {
  const { deps, plan, services } = run;
  const connection = await requirePortainerConnection(deps, plan);
  const client = portainerClientFor(deps, {
    connection,
    token: requirePortainerToken(deps),
    client: services.portainer?.client,
  });
  const environmentId = portainerTarget(plan.target).environmentId;
  return {
    client,
    environmentId,
    place: {
      docker: dockerClient(client.dockerProxyTransport(environmentId)),
      plan,
      stack: portainerStackName(plan),
      volume: portainerSnapshotsVolume(plan),
      recorded: connection.created.volumes,
    },
  };
}

/** The copy's values: its stack's `Env` and the services' secrets by variable, with names shown. */
interface DrillValues {
  env: Record<string, string>;
  stack: Map<string, string>;
  /** `.env.preview`'s names (never values). */
  names: string[];
}

/**
 * The copy's own values for its stack, built for `drill` as provision builds the app's with none of
 * production's: every generated value new (the services' passwords, the app's keys), the app's
 * plain settings, and `.env.preview`'s values for the app's own variables (the rest empty). The
 * new values and `.env.preview`'s are registered with the redactor.
 */
async function drillValues(run: SnapshotRun, drill: DeployPlan): Promise<DrillValues> {
  const { deps } = run;
  const dotenvText = await readTextIfExists(join(deps.paths.root, PREVIEW_VALUES_FILE));
  const preview = parseDotenv(dotenvText ?? "");
  const env = await assembleAppEnv({
    plan: drill,
    ...(dotenvText === undefined ? {} : { dotenvText }),
    ask: async (question) => (question.localValueAvailable ? { useLocal: true } : { skip: true }),
    local: { environment: run.environment, file: PREVIEW_VALUES_FILE },
  });
  const made = [
    env.generated.dbPassword,
    ...Object.values(env.generated.env ?? {}),
    ...Object.values(env.generated.services ?? {}).flatMap(Object.values),
    ...preview.values(),
  ];
  for (const value of made) if (value !== undefined) deps.redactor.addLiteral(value, "drill-value");
  const stack = new Map<string, string>([
    [PORTAINER_STACK_VARIABLES.dbUser, env.values.db?.user ?? "app"],
    [PORTAINER_STACK_VARIABLES.dbName, env.values.db?.name ?? "app"],
  ]);
  for (const { service, secret, variable } of portainerSecretVariables(drill)) {
    const value = env.values.services[service]?.[secret];
    if (value !== undefined) stack.set(variable, value);
  }
  const keys = portainerStackEnvKeys(drill);
  const values: Record<string, string> = {};
  for (const key of keys.app) values[key] = env.values.app[key] ?? "";
  for (const key of keys.opscrew) values[key] = stack.get(key) ?? "";
  return { env: values, stack, names: [...preview.keys()].sort() };
}

/** What the drill's approval says and binds. */
interface Planned {
  about: About;
  parts: SnapshotPart[];
  image: string;
  /** The stack's file with the app, which tells whether the app has a health check. */
  withApp: string;
  stackPlan: StackPlan;
  valueNames: string[];
  request: DrillRequest;
}

/**
 * Asks the drill's approval as a stack plan by its hash, like a destroy (`allowDestroy`,
 * `<app>-drill` typed: `--confirm` with `--approve <hash>` in a script), its words the drill: the
 * snapshot, the stack, what it creates and removes, the memory, the network, the image, the health
 * check and its bounds; the hash it approved.
 * @throws OpsCrewError `APPROVAL_REFUSED` when it is not given.
 */
async function approveDrill(run: SnapshotRun, planned: Planned): Promise<string> {
  const { deps, plan, environment, flags } = run;
  const { about, parts, image, stackPlan, request } = planned;
  const hash = stackPlanHash(stackPlan);
  const typed = drillName(plan.app.name);
  const compose = parse(planned.withApp) as {
    services?: Record<string, { healthcheck?: unknown }>;
  };
  const common = drillApprovalLines({
    plan,
    parts,
    checked: compose.services?.app?.healthcheck !== undefined,
    valueNames: planned.valueNames,
  });
  const drill = stackPlan.changes.find((change) => change.params.action === "drill");
  const leftover = stackPlan.changes.find((change) => change.params.action === "remove");
  const volumes = Array.isArray(drill?.params.volumes) ? drill.params.volumes : [];
  const lines = [
    `The drill restores the snapshot ${about.id} (${KIND_WORDS[about.kind]}, ${formatUtc(about.taken)}) ${WHERE} into a throwaway stack, starts the app on it and checks it, then removes the stack and its volumes.`,
    `  Snapshot: ${about.id}${about.version === "" ? "" : `, version ${shortDigest(about.version)}`}: ${listText(parts.map(partWords))}, read in place from the volume ${portainerSnapshotsVolume(plan)}, mounted read-only.`,
    `  Stack: ${drillStackName(plan.app.name)}, from a stack file OpsCrew gives (not from Git), beside the app's stack ${portainerStackName(plan)}, which it doesn't touch.`,
    ...(leftover === undefined ? [] : [`  First: ${leftover.title}.`]),
    `  It creates and removes: ${listText(["the stack's containers and network", ...volumes.map((volume) => `the volume ${volume}`)])}.`,
    `${common.memory}.`,
    "  Network: one network with no internet (internal), no published port, no hostname, record or site; OpsCrew reads it back after each deploy, before any data goes in, and removes the stack at once if it isn't so.",
    `  Image: ${image}, ${request.allowOtherVersion === true ? "the version that runs now (--allow-other-version)" : "the snapshot's version"}.`,
    common.health,
    `  Bounds: at most ${DRILL_LIMIT_SECONDS / 60} minutes, then OpsCrew stops it and removes the stack. ${NOT_CHECKED}`,
    ...common.values,
    `Typing ${typed} approves it.`,
    `Stack plan hash: ${hash}`,
  ];
  const approval = await deps.approvals.request({
    kind: "stack-apply",
    title: `Run a restore drill of the snapshot ${about.id} of ${environment} ${WHERE}`,
    details: lines.join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: typed,
  });
  if (!approval.approved) {
    throw typedApprovalRefused(
      `The drill of the snapshot ${about.id} did not run`,
      approval.reason,
      drillCommandText(flags, { ...request, id: about.id }),
      typed,
      hash,
    );
  }
  await deps.approvals.assertApprovedStackPlan(hash, { allowDestroy: true });
  return hash;
}

/** The drill's stack, while it runs: the place, its name, client and environment. */
interface Copy {
  run: SnapshotRun;
  client: PortainerClient;
  place: PortainerPlace;
  name: string;
  environmentId: number;
  drill: DeployPlan;
  values: DrillValues;
}

/** The drill stack's containers. */
function copyContainers(copy: Copy): Promise<DockerContainer[]> {
  return copy.place.docker.listContainers([`${COMPOSE_PROJECT_LABEL}=${copy.name}`]);
}

/** True when the copy's network is internal and none of its containers publishes a port. */
async function cutOff(copy: Copy): Promise<boolean> {
  const network = await copy.client.networkInspect(copy.environmentId, `${copy.name}_internal`);
  if (network?.internal !== true) return false;
  const containers = await copy.client.listContainers(copy.environmentId);
  return containers
    .filter((container) => container.project === copy.name)
    .every((container) => container.publishedPorts.length === 0);
}

/**
 * Puts `part` back from the snapshot `id` into the copy (`partRestore`): a stop-only part's
 * container stopped, its volumes filled by a busybox one-off, started again; the app's volumes
 * filled the same way; a database loaded by a one-off of its own image with the copy's secrets on
 * the copy's network. The snapshots volume is read-only in each.
 * @throws OpsCrewError `COMMAND_FAILED` when a step fails.
 */
async function restorePart(copy: Copy, part: SnapshotPart, id: string): Promise<void> {
  const { place, name, run, drill } = copy;
  const restore = partRestore(part);
  const file = `${DIR}/${id}/${part.file}`;
  const containers = ofService(await copyContainers(copy), part.name);
  const appVolume = APP_VOLUMES[part.kind];
  const mounts: MountSpec[] =
    appVolume !== undefined
      ? [{ type: "volume", source: `${name}_${appVolume}`, target: "/data" }]
      : volumesOf(containers).map((mount) => ({ ...mount, readOnly: false }));
  const ran = containers.filter((container) => container.state === "running");
  const fail = (what: string, exitCode: number) =>
    new OpsCrewError(
      "COMMAND_FAILED",
      `OpsCrew could not ${what} in the drill's stack (exit code ${exitCode}).`,
    );
  if (restore.stop) await stopCleanly(place, part, ran, "restore its files");
  if (restore.put !== undefined) {
    const put = await box(place, restore.put(file), { readOnly: true, mounts });
    if (put.exitCode !== 0) throw fail(`put back the files of ${part.name}`, put.exitCode);
  }
  if (restore.stop) for (const container of ran) await place.docker.startContainer(container.id);
  if (restore.load !== undefined) {
    const service = drill.services.find((each) => each.name === part.name);
    if (service === undefined || part.image === undefined) {
      throw new OpsCrewError("INTERNAL", `The drill has no service ${part.name} to load.`, {
        hint: "This is a bug in OpsCrew; please report it.",
      });
    }
    const loaded = await serviceOneOff(place, {
      name: part.name,
      image: part.image,
      script: restore.load(file),
      secrets: secretsFile(
        run,
        portainerServiceEnvironment(drill, service),
        copy.values.stack,
        part.name,
      ),
      mounts: [{ type: "volume", source: place.volume, target: DIR, readOnly: true }],
      network: `${name}_internal`,
    });
    if (loaded.exitCode !== 0) throw fail(`restore ${part.name}`, loaded.exitCode);
  }
  if (restore.after !== undefined) {
    const after = await box(place, restore.after, { readOnly: true, mounts });
    if (after.exitCode !== 0) throw fail(`finish the restore of ${part.name}`, after.exitCode);
  }
}

/** The app's health on the copy (R17): its health check until healthy, or still running. */
async function appHealth(copy: Copy, leftMs: number): Promise<{ state: string; ms: number }> {
  const wait = copy.run.services.portainer?.wait;
  const now = wait?.now ?? Date.now;
  const sleep = wait?.sleep ?? realSleep;
  const started = now();
  const read = async () => {
    const [app] = ofService(await copyContainers(copy), "app");
    if (app === undefined) return { state: "stopped" };
    const inspected = await copy.client.containerInspect(copy.environmentId, app.id);
    return {
      state: inspected.state === "running" ? (inspected.health ?? "running") : "stopped",
      checked: inspected.health !== undefined,
    };
  };
  const first = await read();
  if (first.checked !== true) {
    if (first.state !== "running") return { state: "stopped", ms: now() - started };
    await sleep(Math.max(0, Math.min(RUNNING_MS, leftMs)));
    const later = await read();
    return { state: later.state === "running" ? "running" : "stopped", ms: now() - started };
  }
  let last = first.state;
  const healthy = await pollUntil(
    async () => {
      const current = await read();
      last = current.state;
      return current.state === "healthy" || current.state === "stopped" ? current.state : undefined;
    },
    {
      timeoutMs: Math.max(1, Math.min(HEALTH_MS, leftMs)),
      intervalMs: HEALTH_POLL_MS,
      sleep,
      now,
    },
  );
  return { state: healthy ?? last, ms: now() - started };
}

/** Each restored database's tables, by a one-off of its image with the copy's secrets. */
async function countTables(copy: Copy, part: SnapshotPart): Promise<number | undefined> {
  const count = databaseCount(part);
  const service = copy.drill.services.find((each) => each.name === part.name);
  if (count === undefined || service === undefined || part.image === undefined) return undefined;
  const result = await serviceOneOff(copy.place, {
    name: part.name,
    image: part.image,
    script: count,
    secrets: secretsFile(
      copy.run,
      portainerServiceEnvironment(copy.drill, service),
      copy.values.stack,
      part.name,
    ),
    mounts: [],
    network: `${copy.name}_internal`,
  }).catch(() => undefined);
  const last = result?.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  return result?.exitCode === 0 && /^\d+$/.test(last) ? Number(last) : undefined;
}

/** A deploy's failure as the record's reason: `gone` when the image could not be pulled. */
function deployReason(failure: string): string {
  return /pull access denied|manifest unknown|not found|unauthorized/i.test(failure)
    ? "gone"
    : "start";
}

/**
 * The drill `request` asks in the user's Portainer of `run` (see the module's comment), which
 * takes no `--keep` or `--remove` (`drillSnapshot` refuses them: the copy is always removed).
 * Refused, before any change, for a snapshot or part the volume doesn't have, a version it can't
 * start, a Git stack of the drill's name, and when the approval is not given; otherwise its
 * outcome, which `outcome` tells apart.
 */
export async function drillInPortainer(
  run: SnapshotRun,
  request: DrillRequest,
): Promise<DrillReport> {
  const { deps, plan, flags } = run;
  // 1. What the snapshots volume and the environment hold, read-only; the copy rendered.
  const { client, place, environmentId } = await connect(run);
  const { about } = pickSnapshot(run, await portainerListingText(place), request.id, WHERE);
  const parts = pickParts(run, snapshotParts(plan), about, request.only);
  const running =
    request.allowOtherVersion === true ? (await portainerProbe(place, about.id)).version : "";
  const image = await drillImage(run, about, request, running, {
    why: `OpsCrew can't tell which version of the app runs ${WHERE}`,
    fix: "Deploy the app",
  });
  const snapshot = { id: about.id, parts: parts.map((part) => part.name) };
  const drill = drillPlan(plan, snapshot);
  const stack = renderPortainerDrill(plan, snapshot, { image });
  const values = await drillValues(run, drill);
  const stackPlan = planDrillStack(
    {
      stacks: await client.listStacks(environmentId),
      volumes: await client.listVolumes(environmentId),
    },
    {
      app: plan.app.name,
      environmentId,
      snapshot: about.id,
      services: stack.services,
      withApp: stack.withApp,
      volumes: stack.volumes,
      external: stack.external,
    },
  );
  const command = drillCommandText(flags, { ...request, id: about.id });
  requireNoStackBlockers(stackPlan, command);
  const hash = await approveDrill(run, {
    about,
    parts,
    image,
    withApp: stack.withApp,
    stackPlan,
    valueNames: values.names,
    request,
  });

  // 2. The stack with the services, cut off; the parts restored; the app on them; its health.
  deps.reporter.step(`Running the restore drill of the snapshot ${about.id} ${WHERE}`);
  const copy: Copy = {
    run,
    client,
    place,
    name: drillStackName(plan.app.name),
    environmentId,
    drill,
    values,
  };
  const wait = run.services.portainer?.wait;
  // The whole drill's limit (R29 8.): each wait gets at most the time left, and past it the drill
  // stops and its copy is removed.
  const now = wait?.now ?? Date.now;
  const deadline = now() + DRILL_LIMIT_SECONDS * 1000;
  const left = () => deadline - now();
  const late = () => left() <= 0;
  const options = () => ({
    approvedHash: hash,
    env: values.env,
    wait: { ...wait, timeoutMs: Math.max(1, Math.min(wait?.timeoutMs ?? 10 * 60_000, left())) },
  });
  const timedOut = { result: "failed", reason: "timeout" } as const;
  const start = deps.clock.now();
  const done: Omit<DrillRecord, "end" | "result" | "removal"> = {
    kind: "manual",
    id: about.id,
    ...(about.version === "" ? {} : { version: about.version.slice(7, 19) }),
    start: start.toISOString().replace(/\.\d{3}Z$/, "Z"),
    parts: [],
    tables: [],
    cleaned: stackPlan.changes.some((change) => change.params.action === "remove"),
  };
  const seconds = (from: Date) =>
    Math.max(0, Math.round((deps.clock.now().getTime() - from.getTime()) / 1000));
  let stackId: number | undefined;
  const outcome = async (): Promise<Pick<DrillRecord, "result" | "reason" | "health">> => {
    const created = await createDrillStack(client, stackPlan, options());
    stackId = created.stackId;
    if (late()) return timedOut;
    if (created.failure !== undefined) {
      return { result: "failed", reason: deployReason(created.failure) };
    }
    if (!(await cutOff(copy))) return { result: "failed", reason: "network" };
    for (const part of parts) {
      const began = deps.clock.now();
      try {
        await restorePart(copy, part, about.id);
      } catch {
        return { result: "not-restored", reason: part.name };
      }
      if (late()) return timedOut;
      const size = about.services.find((entry) => entry.name === part.name);
      done.parts.push({
        name: part.name,
        size: size !== undefined && "size" in size ? Number(size.size) : 0,
        seconds: seconds(began),
      });
    }
    const app = await startDrillApp(client, stackPlan, stackId, options());
    if (late()) return timedOut;
    if (app.failure !== undefined) return { result: "failed", reason: deployReason(app.failure) };
    if (!(await cutOff(copy))) return { result: "failed", reason: "network" };
    const health = await appHealth(copy, left());
    const read = { state: health.state, seconds: Math.round(health.ms / 1000) };
    let bad: string | undefined;
    for (const part of parts.filter((each) => databaseCount(each) !== undefined)) {
      const count = await countTables(copy, part);
      done.tables.push({ service: part.name, ...(count === undefined ? {} : { count }) });
      if (count === undefined || count === 0) bad ??= part.name;
    }
    if (bad !== undefined) return { result: "not-restored", reason: bad, health: read };
    if (late() && health.state !== "healthy") return { ...timedOut, health: read };
    return {
      result: health.state === "healthy" || health.state === "running" ? "healthy" : "unhealthy",
      health: read,
    };
  };
  let ended: Pick<DrillRecord, "result" | "reason" | "health">;
  let thrown: unknown;
  try {
    ended = await outcome();
  } catch (error) {
    thrown = error;
    ended = { result: "failed", reason: "start" };
  }
  // 3. The copy removed, whatever happened, and a list proving it is gone.
  let removal: DrillRemoval;
  try {
    removal = await removeDrillStack(client, stackPlan, stackId);
  } catch {
    removal = { removed: false, left: [copy.name] };
  }
  const record: DrillRecord = {
    ...done,
    ...ended,
    end: deps.clock
      .now()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    removal: removal.removed ? "removed" : "failed",
  };
  await keepRecord(run, record);
  await deps.audit
    .append({
      kind: "provider-call",
      actor: "opscrew",
      action: "run a restore drill",
      target: "portainer",
      decision: "approved",
      detail: `${about.id}: ${parts.map((part) => part.name).join(", ")}: ${record.result}${record.reason === undefined ? "" : ` (${record.reason})`}; stack plan ${hash}`,
    })
    .catch((error: unknown) => {
      deps.reporter.warn(
        `OpsCrew could not write the drill ${WHERE} in its audit log: ${deps.redactor.redact(errorMessage(error))}`,
      );
    });
  if (thrown !== undefined) {
    throw new OpsCrewError(
      thrown instanceof OpsCrewError ? thrown.code : "COMMAND_FAILED",
      `The drill of the snapshot ${about.id} stopped: ${errorMessage(thrown)} ${removal.removed ? "OpsCrew removed its stack and volumes." : `OpsCrew could not remove every part of it (${listText(removal.left)}).`}`,
      {
        hint: removal.removed
          ? `Fix what it names, then run \`${command}\` again.`
          : `The next \`${command}\` removes it first, or remove the stack ${copy.name} and its volumes in Portainer.`,
      },
    );
  }
  // 4. The report: one line per step, then the outcome in plain words.
  for (const step of drillSteps(record, partWordsOf(parts))) deps.reporter.step(step);
  const report = drillReport(record, {
    id: about.id,
    flags,
    ownLogins: ownLogins(parts),
    where: WHERE,
    target: "portainer",
    app: plan.app.name,
  });
  if (!removal.removed) {
    deps.reporter.warn(
      `OpsCrew could not remove every part of the drill's copy ${WHERE} (${listText(removal.left)}): the next \`${drillCommandText(flags)}\` removes it first, or remove the stack ${copy.name} and its volumes in Portainer.`,
    );
  }
  if (record.result === "healthy") {
    deps.reporter.success(report.summary);
    deps.reporter.info(`What it proves: ${report.proves}.`);
  } else {
    deps.reporter.warn(report.summary);
  }
  deps.reporter.info(NOT_CHECKED);
  return report;
}
