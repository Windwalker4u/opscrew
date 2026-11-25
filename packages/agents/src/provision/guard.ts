import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import type { CloudflareMove, DeployPlan } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { placeWords } from "../retarget/sides";

/** What to say while `opscrew retarget` is moving the deployment. */
export interface MoveInProgress {
  message: string;
  hint: string;
}

/**
 * The plain-English notice for a move in progress (`plan.retarget` exists), or `undefined` when
 * no move is under way. `plan.target` is already the provider the move goes to. Once an abort
 * began (`retarget.abort`), the move can only be aborted, so the hint names only the abort.
 */
export function moveInProgress(
  plan: Pick<DeployPlan, "target" | "retarget">,
): MoveInProgress | undefined {
  if (plan.retarget === undefined) return undefined;
  const to = placeWords(plan.target);
  if (plan.retarget.abort !== undefined) {
    return {
      message: `A move to ${to} is being aborted.`,
      hint: "Run `opscrew retarget --abort` to finish the abort; it continues where it stopped and puts the app back on the previous server.",
    };
  }
  return {
    message: `A move to ${to} is in progress.`,
    hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
  };
}

/**
 * The command a Cloudflare move's step needs next: preparing, the switch, the finish or the abort,
 * with a further app's `--app <key>` (the move takes no `--env`: it covers every environment).
 */
function cloudflareMoveHint(move: CloudflareMove, app: string | undefined): string {
  const run = `opscrew cloudflare move${app === undefined ? "" : ` --app ${app}`}`;
  const next =
    move.abort !== undefined
      ? `Run \`${run} --abort\` to finish the abort; it goes on where it stopped.`
      : move.step === "started"
        ? `Run \`${run}\` to go on preparing it, or \`${run} --abort\` to call it off.`
        : move.step === "prepared"
          ? `Run \`${run} --switch\` once every app in the zone is prepared and \`${run} --finish\` after it, or \`${run} --abort\` before the switch.`
          : `Run \`${run} --finish\` to complete it.`;
  return `${next} Then run this command again.`;
}

/**
 * Stops with `PHASE_PRECONDITION` while the app's zone moves to another Cloudflare account
 * (`plan.cloudflareMove` exists), naming the command its step needs next (with a further app's
 * `--app <key>`). `destroy`, `retarget`, every rotation, a new preview environment and
 * {@link requireNoMoveInProgress}'s callers refuse with it; snapshot, rollback, advise and design
 * go on during such a move.
 */
export function requireNoCloudflareMove(plan: Pick<DeployPlan, "app" | "cloudflareMove">): void {
  const move = plan.cloudflareMove;
  if (move === undefined) return;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `A move of ${move.zone} to another Cloudflare account is in progress. Nothing was changed.`,
    { hint: cloudflareMoveHint(move, plan.app.key) },
  );
}

/**
 * Stops with `PHASE_PRECONDITION` while a move to another provider is in progress, so provision,
 * dns, drift and the other phases never act on a half-moved deployment; also while the app's zone
 * moves to another Cloudflare account ({@link requireNoCloudflareMove}) unless
 * `allowCloudflareMove` (design's).
 */
export function requireNoMoveInProgress(
  plan: Pick<DeployPlan, "app" | "target" | "retarget" | "cloudflareMove">,
  options: { allowCloudflareMove?: true } = {},
): void {
  const move = moveInProgress(plan);
  if (move !== undefined) {
    throw new OpsCrewError("PHASE_PRECONDITION", move.message, { hint: move.hint });
  }
  if (options.allowCloudflareMove !== true) requireNoCloudflareMove(plan);
}

/**
 * Whether `root` is `temp` or inside it, comparing real paths (links resolved; a path that doesn't
 * exist as it is), without case on Windows.
 */
export async function inTempFolder(
  root: string,
  temp: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const real = (path: string) => realpath(path).catch(() => resolve(path));
  const [inner, outer] = (await Promise.all([real(root), real(temp)])).map((path) =>
    platform === "win32" ? path.toLowerCase() : path,
  );
  const rel = relative(outer ?? "", inner ?? "");
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Warns, without stopping, when the project is in the system's temporary folder (`tempDir`,
 * default `os.tmpdir()`), which the system may clear: the plan, the generated files and the
 * deployment's state there could be lost.
 */
export async function warnInTempFolder(
  deps: Pick<PhaseDeps, "paths" | "reporter">,
  tempDir: string = tmpdir(),
): Promise<void> {
  if (!(await inTempFolder(deps.paths.root, tempDir))) return;
  deps.reporter.warn(
    `This project is in the system's temporary folder (${tempDir}), which the system may clear at any time: its plan, its generated files and the deployment's state (.opscrew/) could be lost. Commit opscrew/, and keep the project in a folder that isn't temporary, such as one in your home folder.`,
  );
}
