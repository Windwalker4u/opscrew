/**
 * What a restore drill tells the user, the same on every target (029 plan.md 19., research R19,
 * R27): the three outcomes told apart in plain words, a skip that is never a failure, what the
 * drill proves where it ran, and one line per step.
 */
import { listText, plural, upperFirst } from "@opscrew/core";
import {
  DRILL_LIMIT_SECONDS,
  DRILLS_LOG,
  type DrillRecord,
  drillName,
} from "@opscrew/iac-templates";
import { sizeText } from "../retarget/texts";
import { drillCommandText } from "./drill-core";
import type { DrillReport } from "./types";

/** Where a drill ran: research R27's rows. */
export type DrillTarget = "server" | "computer" | "portainer" | "hosting";

/** What to do on a server or this computer about a copy that could not be made or started. */
const LOOK_AT_IT = (flags: string, id: string | undefined) =>
  `Run \`${drillCommandText(flags, { ...(id === undefined ? {} : { id }), keep: true })}\` to look at the copy's restore.log in its folder.`;

/** What to do in a Portainer or on a hosting account about a copy that could not be made. */
const FIX_IT = (flags: string, id: string | undefined) =>
  `Fix the cause, then run \`${drillCommandText(flags, id === undefined ? {} : { id })}\` again.`;

/** Where a server's or this computer's drills leave their lines. */
const IN_ITS_LOG = () => `each drill's line is in ${DRILLS_LOG} in the app's folder`;

/** What to do on a server or this computer about a copy that could not be removed. */
const REMOVE_IT = (flags: string) =>
  `its copy could not be removed: run \`${drillCommandText(flags, { remove: true })}\``;

/** What a drill's words say on each target (research R27's rows), read by the report and status. */
export const DRILL_TARGET_WORDS: Record<
  DrillTarget,
  {
    /** What a drill proves there, for the app `app`. */
    proves: (app: string) => string;
    /** Where its scheduled drills' lines are, for the warning that none ran. */
    logged: (flags: string) => string;
    /** That its copy could not be removed, and what to do. */
    notRemoved: (flags: string) => string;
    /** What to do after a copy that could not be made or started: the drill of `id` again. */
    failedHint: (flags: string, id: string | undefined) => string;
  }
> = {
  server: {
    proves: (app) =>
      `the snapshot restored into a throwaway ${drillName(app)} Compose project on the server, and the app started on it with no internet and without the production .env, checked by its own health check; nothing of it had a public route`,
    logged: IN_ITS_LOG,
    notRemoved: REMOVE_IT,
    failedHint: LOOK_AT_IT,
  },
  computer: {
    proves: (app) =>
      `the snapshot restored into a throwaway ${drillName(app)} Compose project on this computer, and the app started on it with no internet and without the production .env, checked by its own health check; nothing of it had a route`,
    logged: IN_ITS_LOG,
    notRemoved: REMOVE_IT,
    failedHint: LOOK_AT_IT,
  },
  portainer: {
    proves: (app) =>
      `the snapshot restored into a throwaway opscrew-${drillName(app)} stack in your Portainer, and the app started on it with no internet and without the production values, its health read through the Docker proxy; nothing of it had a public route`,
    logged: () =>
      "each scheduled one's line is in the log of its drill-<service> container in your Portainer",
    notRemoved: (flags) =>
      `its copy could not be removed: the next \`${drillCommandText(flags)}\` removes it first`,
    failedHint: FIX_IT,
  },
  hosting: {
    proves: () =>
      "the database's dump loaded into the account's drill database and holds its tables; the app itself wasn't started",
    logged: (flags) => `\`opscrew logs${flags}\` shows the agent's lines`,
    notRemoved: () => "the drill database could not be emptied: the next drill empties it first",
    failedHint: FIX_IT,
  },
};

/** What did not restore on a hosting account, by the agent's fixed word (its tables aside). */
export const HOSTING_NOT_RESTORED: Readonly<Record<string, string>> = {
  dump: "its dump is empty or not a valid gzip file",
  database: "its dump did not load into the drill database",
  files: "its copy of the shared files is not a valid archive",
};

/** Why a drill was skipped, by the script's reason. */
const SKIPPED: Record<string, string> = {
  locked: "a deploy, a snapshot or a restore was running",
  rotation: "a credential rotation holds the app",
  disk: "the disk has less free space than the snapshot's size and 1 GiB and 10% of the disk",
  memory: "the machine has less free memory than the copy's memory limits add up to",
};

/** What the drill's command and flags are, for the hints. */
export interface DrillWords {
  id?: string;
  /** ` [--app <key>] [--env <env>]`. */
  flags: string;
  /** Restored services of the stop-only kinds, which keep production's logins in the copy. */
  ownLogins: readonly string[];
  /** Where it ran: `--keep` is named only where a copy can be kept (a server, this computer). */
  target?: DrillTarget;
}

/** The app's health in words, from the record's `health`. */
function healthWords(health: DrillRecord["health"]): string {
  if (health === undefined) return "";
  switch (health.state) {
    case "healthy":
      return ` in ${plural(health.seconds, "second")}`;
    case "running":
      return ` (it has no health check: it was still running after ${plural(health.seconds, "second")})`;
    case "stopped":
      return " (it stopped)";
    default:
      return ` (still ${health.state} after ${plural(health.seconds, "second")})`;
  }
}

/** The record's outcome in plain words, with what to do next (research R19). */
export function drillSummary(record: DrillRecord, o: DrillWords): string {
  const snapshot = o.id === undefined ? "The snapshot" : `The snapshot ${o.id}`;
  const id = o.id === undefined ? {} : { id: o.id };
  const reason = record.reason ?? "";
  switch (record.result) {
    case "healthy":
      return `${snapshot} restored, and the app became healthy on it${healthWords(record.health)}, with no internet and without your production .env.`;
    case "unhealthy": {
      const logins =
        o.ownLogins.length === 0
          ? ""
          : ` ${listText(o.ownLogins)} ${o.ownLogins.length === 1 ? "keeps" : "keep"} production's logins in the copy, so the copy can't sign in to ${o.ownLogins.length === 1 ? "it" : "them"}.`;
      return `${snapshot} restored, but the app did not become healthy on it${healthWords(record.health)} with no internet and without your production values. The backup itself is fine: add the app's test values to .env.preview, or accept this result.${logins}`;
    }
    case "not-restored": {
      const table = record.tables.find((entry) => entry.service === reason);
      const what =
        table === undefined
          ? `${reason} did not restore`
          : table.count === 0
            ? `${reason} holds no table once restored`
            : `${reason} did not answer once restored`;
      return `${snapshot} did not restore: ${what}. The backup is bad: take a new snapshot now with \`opscrew snapshot${o.flags}\`.`;
    }
    case "skipped":
      return `The drill was skipped: ${SKIPPED[reason] ?? reason}. Nothing was changed; run \`${drillCommandText(o.flags, id)}\` again later.`;
    case "failed":
      switch (reason) {
        case "gone":
          return `That snapshot's version of the app is gone: its image is not on the machine, and its login could not pull it. Run \`${drillCommandText(o.flags, { ...id, allowOtherVersion: true })}\` to drill the snapshot with today's version.`;
        case "network":
          return "The copy's network was not cut off from the internet, or one of its ports was published, so OpsCrew removed it at once, before any data went in.";
        case "timeout":
          return `The drill ran past its ${DRILL_LIMIT_SECONDS / 60}-minute limit, so OpsCrew stopped it and removed the copy.`;
        case "leftovers":
          return `OpsCrew could not remove what an earlier drill left, so it started no new one. Run \`${drillCommandText(o.flags, { remove: true })}\`, then the drill again.`;
        case "stopped":
          return "The drill was stopped before it ended, and its copy removed.";
        default:
          return `The copy could not be made or started (${reason}), so the drill proves nothing either way. ${DRILL_TARGET_WORDS[o.target ?? "server"].failedHint(o.flags, o.id)}`;
      }
  }
}

/** One line per step of the drill's record (research R18), for the reporter. */
export function drillSteps(record: DrillRecord, partWords: (name: string) => string): string[] {
  const health = record.health;
  return [
    ...(record.cleaned ? ["Removed what an earlier drill left"] : []),
    ...record.parts.map(
      (part) =>
        `Restored ${partWords(part.name)}, ${sizeText(part.size)}, in ${plural(part.seconds, "second")}`,
    ),
    ...(health === undefined
      ? []
      : [`Started the app on it: ${health.state}${healthWords(health)}`]),
    ...record.tables.map((table) =>
      table.count === undefined
        ? `${upperFirst(table.service)} did not answer`
        : `${upperFirst(table.service)} holds ${plural(table.count, "table")}`,
    ),
  ];
}

/** The report of `record` on `target` ({@link DrillReport}). */
export function drillReport(
  record: DrillRecord,
  o: DrillWords & { where: string; target: DrillTarget; app: string },
): DrillReport {
  return {
    ...(record.id === undefined ? {} : { id: record.id }),
    where: o.where,
    outcome: record.result,
    summary: drillSummary(record, o),
    proves: DRILL_TARGET_WORDS[o.target].proves(o.app),
    parts: record.parts,
    ...(record.health === undefined ? {} : { health: record.health }),
    tables: record.tables,
    ...(record.removal === undefined ? {} : { removal: record.removal }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ownLogins: [...o.ownLogins],
  };
}
