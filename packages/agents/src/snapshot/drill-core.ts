/**
 * What a restore drill decides before anything changes, the same on a server, this computer and
 * the user's Portainer (029 plan.md 19., research R16, R17, R27): the snapshot and its parts, the
 * version the copy runs, the approval's shared lines, and the copy's env files.
 */
import { join } from "node:path";
import { listText, OpsCrewError, readTextIfExists } from "@opscrew/core";
import {
  DRILL_HEALTH_SECONDS,
  DRILL_RUNNING_SECONDS,
  databaseCount,
  localBuildImage,
  type SnapshotPart,
} from "@opscrew/iac-templates";
import { type DeployPlan, ghcrImageFor } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { serviceEnvFiles } from "../provision/secrets";
import { gitClient, githubCoordinates } from "../shared";
import { assembleAppEnv, dotenvLine } from "../shared/app-env";
import { recordOf } from "./restore";
import { partWords } from "./restore-checks";
import type { BucketAbout } from "./restore-offsite";
import type { SnapshotRun } from "./run";
import { type About, readListing } from "./store";
import type { DrillRequest } from "./types";

/** The file the copy's own values come from: the previews', never prod's `.env` (research R16). */
export const PREVIEW_VALUES_FILE = ".env.preview";

/** The drill's command with `request`'s id and options, and the run's ` --app`/` --env` flags. */
export function drillCommandText(flags: string, request: DrillRequest = {}): string {
  return [
    "opscrew restore --drill",
    ...(request.id === undefined ? [] : [request.id]),
    ...(request.only === undefined ? [] : [`--only ${request.only}`]),
    ...(request.keep === true ? ["--keep"] : []),
    ...(request.allowOtherVersion === true ? ["--allow-other-version"] : []),
    ...(request.remove === true ? ["--remove"] : []),
  ]
    .join(" ")
    .concat(flags);
}

/**
 * The snapshot `id`, or the newest one, among the `about.json` lines of a listing's `stdout`, with
 * its bytes; `where` says where in words.
 * @throws OpsCrewError `PHASE_PRECONDITION` when there is none.
 */
export function pickSnapshot(
  run: SnapshotRun,
  stdout: string,
  id: string | undefined,
  where: string,
): BucketAbout {
  const { abouts } = readListing(stdout);
  const newest = [...abouts].sort((a, b) => b.taken.localeCompare(a.taken))[0];
  const chosen = id === undefined ? newest : abouts.find((about) => about.id === id);
  const record = chosen === undefined ? undefined : recordOf(stdout, chosen.id).record;
  if (record !== undefined) return record;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    id === undefined
      ? `There is no snapshot ${where} yet, so there is nothing to drill. ${NOTHING_CHANGED}`
      : `There is no snapshot ${id} ${where}. ${NOTHING_CHANGED}`,
    {
      hint:
        id === undefined
          ? `Take one with \`opscrew snapshot${run.flags}\`, then run the drill.`
          : `\`opscrew snapshot list${run.flags}\` shows the snapshots.`,
    },
  );
}

/**
 * The parts the copy restores: those of `planParts` (the plan's where the drill runs) the snapshot
 * holds a copy of, only `only` with `--only`.
 * @throws OpsCrewError `INVALID_INPUT` for an `--only` of no service with data,
 * `PHASE_PRECONDITION` when the snapshot holds no copy of it, or of anything the plan has there.
 */
export function pickParts(
  run: SnapshotRun,
  planParts: readonly SnapshotPart[],
  about: About,
  only: string | undefined,
): SnapshotPart[] {
  if (only !== undefined && !planParts.some((part) => part.name === only)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${only} is no service with data in ${run.environment}. ${NOTHING_CHANGED}`,
      {
        hint: `Name one of ${listText(planParts.map((part) => part.name))} with --only, or leave it out.`,
      },
    );
  }
  const copied = new Set(
    about.services.filter((entry) => "file" in entry).map((entry) => entry.name),
  );
  const parts = planParts.filter(
    (part) => copied.has(part.name) && (only === undefined || part.name === only),
  );
  if (parts.length > 0) return parts;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The snapshot ${about.id} holds no copy of ${only ?? `any part ${run.environment} has now`}, so there is nothing to drill. ${NOTHING_CHANGED}`,
    { hint: `\`opscrew snapshot list${run.flags}\` shows what each snapshot holds.` },
  );
}

/**
 * The image the copy runs: the snapshot's version, or with `--allow-other-version` `running` (the
 * one that runs now, `sha256:<hex>`, empty when unknown); a local build's tag on this computer,
 * else the app's image on GHCR by its digest. `unknown` words a `running` that is empty: why, and
 * what to do first.
 * @throws OpsCrewError `PHASE_PRECONDITION` when the version to run is unknown.
 */
export async function drillImage(
  run: SnapshotRun,
  about: About,
  request: DrillRequest,
  running: string,
  unknown: { why: string; fix: string },
): Promise<string> {
  const { deps, plan, flags } = run;
  const allow = request.allowOtherVersion === true;
  const version = allow ? running : about.version;
  if (version === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      allow
        ? `${unknown.why}, so there is no version of today's to run the copy of the snapshot ${about.id} with. ${NOTHING_CHANGED}`
        : `The snapshot ${about.id} records no version (it was taken before a first deploy, or with an older OpsCrew), so OpsCrew can't tell which version of the app to start on it. ${NOTHING_CHANGED}`,
      allow
        ? {
            hint: `${unknown.fix}, then try again; or drill the snapshot with its own version: \`${drillCommandText(flags, { ...request, id: about.id, allowOtherVersion: false })}\`.`,
          }
        : {
            hint: `Run \`${drillCommandText(flags, { ...request, id: about.id, allowOtherVersion: true })}\` to start today's version on it.`,
          },
    );
  }
  const hex = version.slice("sha256:".length);
  if (plan.target.provider === "localhost" && plan.target.image === "local-build") {
    return localBuildImage(plan, hex);
  }
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  return `${ghcrImageFor(`${owner}/${repo}`, plan.app.key)}@sha256:${hex}`;
}

/** Restored services of the stop-only kinds, whose copied files keep production's logins. */
export function ownLogins(parts: readonly SnapshotPart[]): string[] {
  return parts
    .filter((part) => !part.online && part.kind !== "sqlite" && part.kind !== "files")
    .map((part) => part.name);
}

/** Each of `parts`' words by its name; a name of none of them as it is. */
export function partWordsOf(parts: readonly SnapshotPart[]): (name: string) => string {
  return (name) => {
    const part = parts.find((each) => each.name === name);
    return part === undefined ? name : partWords(part);
  };
}

/**
 * The lines of a drill's approval that are the same on every target, for each to put among its
 * own: the copy's memory (`memory`, without its end), its health check and bounds (`health`), and
 * its values with the logins it keeps (`values`).
 */
export function drillApprovalLines(c: {
  plan: DeployPlan;
  parts: readonly SnapshotPart[];
  /** The copy's app has a health check. */
  checked: boolean;
  /** `.env.preview`'s names (never values). */
  valueNames: readonly string[];
}): { memory: string; health: string; values: string[] } {
  const { plan, parts, valueNames } = c;
  const databases = parts.filter((part) => databaseCount(part) !== undefined);
  const limits = [
    { name: "the app", mb: plan.app.memoryMb },
    ...plan.services
      .filter((service) => parts.some((part) => part.name === service.name))
      .map((service) => ({ name: service.name, mb: service.memoryMb })),
  ];
  const total = limits.reduce((sum, limit) => sum + limit.mb, 0);
  const logins = ownLogins(parts);
  return {
    memory: `  Memory: ${listText(limits.map((limit) => `${limit.name} ${limit.mb} MB`))} (${total} MB in all)`,
    health: `  Health check: ${c.checked ? `the app's own health check (${plan.app.healthPath}) until healthy, at most ${DRILL_HEALTH_SECONDS / 60} minutes` : `the app has none, so it must still run after ${DRILL_RUNNING_SECONDS} seconds`}${databases.length === 0 ? "" : `; then ${listText(databases.map((part) => part.name))} must answer and hold at least one table`}.`,
    values: [
      "The copy runs with no internet and without your production `.env`. The app may need some values to start; add them to `.env.preview` with test values.",
      valueNames.length === 0
        ? "There are no values in .env.preview: the app gets only its plain settings and the copy's own new passwords."
        : `Values from .env.preview (names only): ${listText(valueNames)}.`,
      ...(logins.length === 0
        ? []
        : [
            `${listText(logins)} ${logins.length === 1 ? "is" : "are"} restored from a copy of ${logins.length === 1 ? "its" : "their"} files, which keeps production's logins, so the copy can't sign in to ${logins.length === 1 ? "it" : "them"}.`,
          ]),
    ],
  };
}

/**
 * The env files of the drill's copy `drill` (a `drillPlan`), built with the preview server's
 * placeholders for generated values and none of `.env`'s, and `.env.preview`'s values as the text
 * of its `values.env` with their names, each value known to the redactor from here on.
 */
export async function drillEnvFor(deps: Pick<PhaseDeps, "paths" | "redactor">, drill: DeployPlan) {
  const dotenvText = await readTextIfExists(join(deps.paths.root, PREVIEW_VALUES_FILE));
  const env = await assembleAppEnv({
    plan: drill,
    ...(dotenvText === undefined ? {} : { dotenvText }),
    previewTemplates: true,
  });
  const own = env.preview?.values ?? {};
  for (const value of Object.values(own)) deps.redactor.addLiteral(value, "preview-value");
  const names = Object.keys(own).sort();
  return {
    templates: { app: env.appEnv, services: serviceEnvFiles(drill, env) },
    values: names.map((name) => `${dotenvLine(name, own[name] as string)}\n`).join(""),
    names,
  };
}
