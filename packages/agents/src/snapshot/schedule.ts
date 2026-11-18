/**
 * `opscrew snapshot schedule on|off` (US5, FR-2406): scheduled data snapshots in the plan
 * (`snapshots.schedule`), which provision then puts on the servers (a line in the deploy user's
 * crontab, D2) or into the Portainer stack; and `opscrew snapshot drill schedule on|off` (029
 * plan.md 19., research R28): scheduled restore drills (`snapshots.drills.schedule`), which need
 * the snapshot schedule. Only the plan changes here.
 */
import { listText, OpsCrewError } from "@opscrew/core";
import { drillSlotText, snapshotParts } from "@opscrew/iac-templates";
import { type DeployPlan, isHostingTarget, snapshotScheduleOf } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { planFile } from "../runners/words";
import { drillCommandText } from "./drill-core";
import { dataServers } from "./hosts";
import { type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import {
  provisionLine,
  requireSettingsPlace,
  type SnapshotSettingChange,
  withSnapshotSetting,
  writeSnapshotSetting,
} from "./settings";

/** `opscrew snapshot schedule on`'s flags; each one left out keeps the plan's value, else its default. */
export interface ScheduleOnOptions {
  /** `--every daily|weekly|<n>h`: how often (default weekly). */
  every?: string;
  /** `--keep <n>`: how many scheduled snapshots stay (default 4). */
  keep?: number;
  /** `--stop <service>`: the stop-only services the scheduled snapshot also copies, each stopped alone. */
  stop?: readonly string[];
}

/** `weekly`, `daily`, `every 12 hours`. */
function everyText(every: string): string {
  if (every === "daily" || every === "weekly") return every;
  const hours = Number.parseInt(every, 10);
  return hours === 1 ? "every hour" : `every ${hours} hours`;
}

/** A schedule in words: `weekly, the last 4 kept, kafka stopped for its copy`; `off`. */
export function scheduleText(plan: Pick<DeployPlan, "snapshots">): string {
  const schedule = snapshotScheduleOf(plan);
  if (schedule === undefined) return "off";
  const stop = schedule.stop;
  return [
    everyText(schedule.every),
    schedule.keep === 1 ? "the last one kept" : `the last ${schedule.keep} kept`,
    ...(stop.length === 0
      ? []
      : [`${listText(stop)} stopped for ${stop.length === 1 ? "its" : "their"} copy`]),
  ].join(", ");
}

/** The plan's stop-only services with data, on every server that has some. */
function stopOnlyServices(plan: DeployPlan): string[] {
  return dataServers(plan).flatMap((server) =>
    snapshotParts(plan, server)
      .filter((part) => !part.online)
      .map((part) => part.name),
  );
}

/** What the schedule leaves out: the stop-only services it does not stop, and why. */
function leftOutLine(run: SnapshotRun, plan: DeployPlan): string | undefined {
  const stop = snapshotScheduleOf(plan)?.stop ?? [];
  const left = stopOnlyServices(plan).filter((name) => !stop.includes(name));
  if (left.length === 0) return undefined;
  const names = listText(left);
  const verb = left.length === 1 ? "is" : "are";
  if (plan.target.provider === "portainer") {
    return `${names} ${verb} left out: in Portainer the scheduled snapshots copy only the services copied while they run, because stopping one needs Docker on the host, which the stack has no access to. Take a snapshot with ${left.length === 1 ? "it" : "them"} by hand with \`opscrew snapshot${run.flags}\`.`;
  }
  return `${names} ${verb} left out: ${left.length === 1 ? "it" : "each"} must stop for its copy. Add ${left.map((name) => `--stop ${name}`).join(" ")} to copy ${left.length === 1 ? "it" : "them"} on the schedule, stopped alone meanwhile.`;
}

/** Where provision puts the schedule, or takes it away from. */
function where(plan: DeployPlan): string {
  if (plan.target.provider === "portainer") return "the app's stack in your Portainer";
  return isHostingTarget(plan.target)
    ? "the agent's settings on the hosting account"
    : "the server";
}

/**
 * True on a panel's hosting account (cPanel, Plesk, DirectAdmin), whose agent drills the newest
 * snapshot taken by hand itself (research R28): it takes none on a schedule.
 * @throws OpsCrewError `PHASE_PRECONDITION` on an SFTP host, which keeps no snapshots.
 */
function onPanelAccount(run: SnapshotRun): boolean {
  const { target } = run.plan;
  if (!isHostingTarget(target)) return false;
  if (target.panel === "sftp") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${run.environment} runs on an SFTP host, which keeps no snapshots: no agent of OpsCrew's runs there to take them, so there is nothing to drill. ${NOTHING_CHANGED}`,
    );
  }
  return true;
}

/**
 * `opscrew snapshot schedule on` (FR-2406): `snapshots.schedule` in the plan of the environment
 * `deps` belong to, with `options` over the plan's values or the defaults (weekly, keep 4, no
 * stop-only service), written through the plan-writing path; the lines say what changed, what the
 * schedule leaves out and to run provision.
 * @throws OpsCrewError `PHASE_PRECONDITION` for a site, a preview environment, this computer or an
 * environment without data, and for `--stop` in Portainer (D3); `INVALID_INPUT` for a value the
 * plan schema refuses. Nothing is written then.
 */
export async function snapshotScheduleOn(
  deps: PhaseDeps,
  options: ScheduleOnOptions = {},
): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  requireSettingsPlace(run, "schedule", "take scheduled snapshots");
  if (plan.target.provider === "portainer" && (options.stop ?? []).length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `In Portainer a scheduled snapshot can't stop a service: stopping one needs Docker on the host, which the app's stack has no access to. ${NOTHING_CHANGED}`,
      {
        hint: `Leave out --stop; take a snapshot with those services by hand with \`opscrew snapshot${run.flags}\`, which stops each alone for its copy.`,
      },
    );
  }
  const current = snapshotScheduleOf(plan);
  const stop = options.stop === undefined ? (current?.stop ?? []) : [...new Set(options.stop)];
  const after = withSnapshotSetting(
    plan,
    "schedule",
    {
      every: options.every ?? current?.every ?? "weekly",
      keep: options.keep ?? current?.keep ?? 4,
      ...(stop.length === 0 ? {} : { stop }),
    },
    "take scheduled snapshots",
  );
  const left = leftOutLine(run, after);
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled snapshots of ${run.environment}'s data (snapshots.schedule in ${planFile(plan)}): ${scheduleText(plan)} → ${scheduleText(after)}.`,
      ...(left === undefined ? [] : [left]),
      "Each stays on the machine that holds the data, as the snapshots by hand do.",
      provisionLine(run, `put the schedule on ${where(after)}`),
    ],
    `Scheduled snapshots of ${run.environment}'s data are already ${scheduleText(plan)}.`,
  );
}

/**
 * `opscrew snapshot schedule off` (US5 #3): `snapshots.schedule` removed from the plan; the
 * snapshots it took stay until deleted, and the lines say so and to run provision.
 */
export async function snapshotScheduleOff(deps: PhaseDeps): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  const what = "turn off scheduled snapshots";
  // The drills prove the scheduled snapshots: their schedule goes first; drills by hand stay.
  const drills = plan.snapshots?.drills?.schedule !== undefined;
  const after = withSnapshotSetting(
    drills ? withDrillSchedule(plan, undefined, what) : plan,
    "schedule",
    undefined,
    what,
  );
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled snapshots of ${run.environment}'s data (snapshots.schedule in ${planFile(plan)}): ${scheduleText(plan)} → off.`,
      ...(drills
        ? [
            `The scheduled restore drills (snapshots.drills.schedule) go too: each one proves the latest scheduled snapshot. ${byHandLine(run)}`,
          ]
        : []),
      `The scheduled snapshots already taken stay until you delete them with \`opscrew snapshot delete <id>${run.flags}\`; \`opscrew snapshot list${run.flags}\` lists them.`,
      provisionLine(run, `take the schedule off ${where(plan)}`),
    ],
    `Scheduled snapshots of ${run.environment}'s data are already off.`,
  );
}

/** How often `opscrew snapshot drill schedule on` drills: `weekly` (the default) or `daily`. */
export interface DrillScheduleOnOptions {
  every?: "weekly" | "daily";
}

/** `plan` with `snapshots.drills.schedule` set to `every`, or removed (drills by hand stay on). */
function withDrillSchedule(
  plan: DeployPlan,
  every: "weekly" | "daily" | undefined,
  what: string,
): DeployPlan {
  const { schedule: _old, ...drills } = plan.snapshots?.drills ?? {};
  return withSnapshotSetting(
    plan,
    "drills",
    every === undefined ? drills : { ...drills, schedule: every },
    what,
  );
}

/** The line that says restore drills by hand stay. */
function byHandLine(run: SnapshotRun): string {
  return `Restore drills by hand stay: \`${drillCommandText(run.flags)}\` runs one.`;
}

/**
 * `opscrew snapshot drill schedule on` (research R28): `snapshots.drills.schedule` in the plan,
 * `options.every` over the plan's value, else weekly, written through the plan-writing path; once
 * provision puts it on the target, each drill runs three hours after the scheduled snapshot's slot.
 * On a panel's hosting account the agent runs them, with no snapshot schedule needed.
 * @throws OpsCrewError `PHASE_PRECONDITION` on this computer, where snapshots can't be scheduled,
 * on an SFTP host, and elsewhere without the snapshot schedule (offering both commands). Nothing is
 * written then.
 */
export async function snapshotDrillScheduleOn(
  deps: PhaseDeps,
  options: DrillScheduleOnOptions = {},
): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  if (onPanelAccount(run)) return drillScheduleOnAccount(run, options);
  if (snapshotTarget(run) === "computer") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew does not run scheduled restore drills on this computer: it isn't always on to run them. ${NOTHING_CHANGED}`,
      { hint: `Run one when you need it with \`${drillCommandText(run.flags)}\`.` },
    );
  }
  requireSettingsPlace(run, "drills", "run scheduled restore drills");
  if (snapshotScheduleOf(plan) === undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A scheduled restore drill proves the latest scheduled snapshot, and ${run.environment} takes none on a schedule, so OpsCrew did not schedule drills. ${NOTHING_CHANGED}`,
      {
        hint: `Turn both on: \`opscrew snapshot schedule on${run.flags}\`, then \`opscrew snapshot drill schedule on${run.flags}\`.`,
      },
    );
  }
  const current = plan.snapshots?.drills?.schedule;
  const every = options.every ?? current ?? "weekly";
  const after = withDrillSchedule(plan, every, "schedule restore drills");
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled restore drills of ${run.environment} (snapshots.drills.schedule in ${planFile(plan)}): ${current ?? "off"} → ${every}, three hours after the scheduled snapshot.`,
      "Each one restores the latest scheduled snapshot into a throwaway copy with no internet and none of the production .env's values, checks it and removes it. A deploy or a snapshot running, or too little disk or memory, skips it.",
      provisionLine(run, `put the schedule on ${where(after)}`),
    ],
    `Scheduled restore drills of ${run.environment} are already ${every}.`,
  );
}

/**
 * `opscrew snapshot drill schedule on` on a panel's hosting account: the agent drills the newest
 * snapshot into the drill database itself, so no snapshot schedule is needed; the lines say when,
 * what each drill does and, when drills were off, that provision makes the drill database.
 */
async function drillScheduleOnAccount(
  run: SnapshotRun,
  options: DrillScheduleOnOptions,
): Promise<SnapshotSettingChange> {
  const { plan } = run;
  const current = plan.snapshots?.drills?.schedule;
  const every = options.every ?? current ?? "weekly";
  const after = withDrillSchedule(plan, every, "schedule restore drills");
  const database = isHostingTarget(plan.target) && plan.target.database !== undefined;
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled restore drills of ${run.environment} (snapshots.drills.schedule in ${planFile(plan)}): ${current ?? "off"} → ${drillSlotText(every)}.`,
      `Each one: OpsCrew's agent on the account loads the newest snapshot (\`opscrew snapshot${run.flags}\` takes one) into the drill database, counts its tables and empties it again, once there is a newer snapshot than the last drill proved; the app isn't started. It runs between deploys, and too little room under the account's disk quota skips it.`,
      ...(database && plan.snapshots?.drills === undefined
        ? [
            "Provision makes the drill database first: one more database, which counts against your hosting plan's limit.",
          ]
        : []),
      provisionLine(run, `put the schedule in ${where(after)}`),
    ],
    `Scheduled restore drills of ${run.environment} are already ${every}.`,
  );
}

/**
 * `opscrew snapshot drill schedule off`: `snapshots.drills.schedule` removed from the plan; drills
 * by hand stay, and the lines say so and to run provision.
 */
export async function snapshotDrillScheduleOff(deps: PhaseDeps): Promise<SnapshotSettingChange> {
  const run = await snapshotRun(deps);
  const { plan } = run;
  const current = plan.snapshots?.drills?.schedule;
  const after =
    current === undefined ? plan : withDrillSchedule(plan, undefined, "turn off scheduled drills");
  return writeSnapshotSetting(
    run,
    after,
    [
      `Scheduled restore drills of ${run.environment} (snapshots.drills.schedule in ${planFile(plan)}): ${current} → off.`,
      byHandLine(run),
      provisionLine(run, `take the schedule off ${where(plan)}`),
    ],
    `Scheduled restore drills of ${run.environment} are already off.`,
  );
}
