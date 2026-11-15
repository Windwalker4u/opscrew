/**
 * Where a move of the app to another Cloudflare account stands, for `opscrew status` and
 * `opscrew_status`: each covered environment's step from its record, the apps prepared in B (its
 * marks, read only with B's token), and the command to run next. Read-only.
 */
import { type CloudflareClient, cloudflareConnector } from "@opscrew/connector-cloudflare";
import { errorText, listText } from "@opscrew/core";
import type { CloudflareMove } from "@opscrew/plan-schema";
import { appFlag } from "../apps/choice";
import type { PhaseDeps } from "../context";
import { parseMarks } from "./marks";
import { readMoveRecords } from "./record";
import { B_TOKEN_VAR, MOVE_COMMAND } from "./texts";

/** A covered environment's step, from its record. */
export interface MoveEnvironmentStatus {
  name: string;
  step: CloudflareMove["step"];
  /** The abort's step, once an abort began. */
  abort?: NonNullable<CloudflareMove["abort"]>["step"];
}

/** An app prepared in B, as its mark names it. */
export interface PreparedApp {
  app: string;
  envs: string[];
}

/** Where the app's move stands. */
export interface CloudflareMoveStatus {
  zone: string;
  environments: MoveEnvironmentStatus[];
  /**
   * The apps prepared in B (its marks), read only when B's token is set and B's zone exists;
   * `undefined` otherwise.
   */
  prepared?: PreparedApp[];
  /** Why B's marks couldn't be read, in a plain line (redacted). */
  note?: string;
  /** The command to run next, in words. */
  next: string;
  /** The status as `opscrew status` prints it, each line indented by two. */
  lines: string[];
}

/** What a step means, in words. */
function stepWords(environment: MoveEnvironmentStatus): string {
  if (environment.abort === "started") return "being aborted";
  if (environment.abort === "removed") return "aborted; the abort's next run ends it";
  switch (environment.step) {
    case "started":
      return "being prepared in the new account";
    case "prepared":
      return "prepared in the new account";
    case "adopted":
      return "running from the new account; the finish still removes the old account's pieces";
  }
}

/** The command the steps need next, with the app's ` --app <key>` (`flag`). */
function nextWords(environments: readonly MoveEnvironmentStatus[], flag: string): string {
  const run = (mode: string) => `\`${MOVE_COMMAND}${mode}${flag}\``;
  if (environments.some((environment) => environment.abort !== undefined)) {
    return `run ${run(" --abort")} to finish the abort`;
  }
  if (environments.some((environment) => environment.step === "adopted")) {
    return `run ${run(" --finish")} to complete the move`;
  }
  if (environments.some((environment) => environment.step === "started")) {
    return `run ${run("")} to go on preparing it, or ${run(" --abort")} to call it off`;
  }
  return `run ${run(" --switch")} once every app in the zone is prepared, then ${run(" --finish")}; or ${run(" --abort")} before the switch`;
}

/** B's marks: the apps prepared there, or a plain line when they can't be read. */
async function preparedApps(
  deps: Pick<PhaseDeps, "env" | "fetch" | "redactor" | "version">,
  zoneId: string,
  client: Pick<CloudflareClient, "listZoneRecords"> | undefined,
): Promise<{ prepared: PreparedApp[] } | { note: string }> {
  const token = deps.env[B_TOKEN_VAR]?.trim() ?? "";
  deps.redactor.addLiteral(token, B_TOKEN_VAR);
  const b =
    client ??
    (cloudflareConnector({
      env: { CLOUDFLARE_API_TOKEN: token },
      fetch: deps.fetch,
      redactor: deps.redactor,
      version: deps.version,
    }).client as CloudflareClient);
  try {
    const { marks } = parseMarks(await b.listZoneRecords(zoneId));
    return { prepared: marks.map(({ mark }) => ({ app: mark.app, envs: mark.envs })) };
  } catch (error) {
    return {
      note: deps.redactor.redact(
        `The apps prepared in the new account could not be read with ${B_TOKEN_VAR}: ${errorText(error)}`,
      ),
    };
  }
}

/**
 * Where the move of the app `deps.paths` belongs to stands, or `undefined` when none of its
 * environments records one (or their plans can't be read). B's marks are read (GET only) when
 * `OPSCREW_NEW_CLOUDFLARE_API_TOKEN` is set and a record names B's zone; a failed read is a
 * `note`, never an error. `client`: B's client (tests).
 */
export async function cloudflareMoveStatus(
  deps: Pick<PhaseDeps, "paths" | "env" | "fetch" | "redactor" | "version">,
  options: { client?: Pick<CloudflareClient, "listZoneRecords"> } = {},
): Promise<CloudflareMoveStatus | undefined> {
  const { paths } = deps;
  const records = await readMoveRecords(paths).catch(() => []);
  const moves = records.flatMap(({ environment, plan }) =>
    plan.cloudflareMove === undefined ? [] : [{ environment, move: plan.cloudflareMove }],
  );
  const first = moves[0];
  if (first === undefined) return undefined;
  const environments = moves.map(({ environment, move }) => ({
    name: environment,
    step: move.step,
    ...(move.abort === undefined ? {} : { abort: move.abort.step }),
  }));
  const next = nextWords(environments, await appFlag(paths.root, paths.app));
  const zoneId = moves.find(({ move }) => move.to.zoneId !== undefined)?.move.to.zoneId;
  const read =
    zoneId === undefined || !deps.env[B_TOKEN_VAR]?.trim()
      ? undefined
      : await preparedApps(deps, zoneId, options.client);
  const width = Math.max(...environments.map((environment) => environment.name.length));
  const prepared = read !== undefined && "prepared" in read ? read.prepared : undefined;
  const note = read !== undefined && "note" in read ? read.note : undefined;
  const lines = [
    `  cloudflare  moving ${first.move.zone} to another Cloudflare account`,
    ...environments.map(
      (environment) => `    ${environment.name.padEnd(width)}  ${stepWords(environment)}`,
    ),
    ...(prepared === undefined
      ? []
      : [
          prepared.length === 0
            ? "    apps prepared in the new account: none yet"
            : `    apps prepared in the new account: ${listText(prepared.map((one) => `${one.app} (${one.envs.join(", ")})`))}`,
        ]),
    ...(note === undefined ? [] : [`    ${note}`]),
    `    next: ${next}.`,
  ];
  return {
    zone: first.move.zone,
    environments,
    ...(prepared === undefined ? {} : { prepared }),
    ...(note === undefined ? {} : { note }),
    next,
    lines,
  };
}
