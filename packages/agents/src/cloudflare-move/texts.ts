/**
 * The commands, phase, token variables, words and refusal of a move to another Cloudflare
 * account, and the environment's phase deps every step of it uses.
 */
import type { AuditInput, PhaseName } from "@opscrew/contracts";
import { type ErrorCode, OpsCrewError } from "@opscrew/core";
import type { PhaseDeps } from "../context";
import type { MoveEnvironment, MoveSession } from "./types";

/** Prepare (`--to <account>`), or continue it. */
export const MOVE_COMMAND = "opscrew cloudflare move";
export const SWITCH_COMMAND = `${MOVE_COMMAND} --switch`;
export const FINISH_COMMAND = `${MOVE_COMMAND} --finish`;
export const ABORT_COMMAND = `${MOVE_COMMAND} --abort`;

/** The phase the move's steps are audited under. */
export const MOVE_PHASE: PhaseName = "cloudflare-move";

/** A's token: the account that holds the zone when the move starts. */
export const A_TOKEN_VAR = "CLOUDFLARE_API_TOKEN";
/** B's token: the account the zone moves to. */
export const B_TOKEN_VAR = "OPSCREW_NEW_CLOUDFLARE_API_TOKEN";

/** A refusal before any change: `message` ends with "Nothing was changed.", `hint` says what next. */
export function refusal(
  message: string,
  hint: string,
  code: ErrorCode = "PHASE_PRECONDITION",
): OpsCrewError {
  return new OpsCrewError(code, `${message} Nothing was changed.`, { hint });
}

/** Something OpsCrew's own code should never do: OpsCrew's bug. */
export function bug(message: string): OpsCrewError {
  return new OpsCrewError("INTERNAL", message, {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}

/** Appends an audit entry of the move: OpsCrew's, under {@link MOVE_PHASE} (the log redacts it). */
export function moveAudit(
  deps: Pick<PhaseDeps, "audit">,
  entry: Pick<AuditInput, "kind" | "action" | "target" | "decision" | "detail">,
): Promise<void> {
  return deps.audit.append({ ...entry, actor: "opscrew", phase: MOVE_PHASE });
}

/** `shop (prod)`. */
export function appWords(environment: MoveEnvironment): string {
  return `${environment.plan.app.name} (${environment.environment})`;
}

/** The account's name as the session read it, else its id. */
export function accountName(account: { accountId: string; name?: string }): string {
  return account.name ?? account.accountId;
}

/** `the Cloudflare account <name>`: its name as the session read it, else its id. */
export function accountWords(account: { accountId: string; name?: string }): string {
  return `the Cloudflare account ${accountName(account)}`;
}

/** The phase deps with the environment's paths (its records, kept keys and server's address). */
export function environmentDeps(session: MoveSession, environment: MoveEnvironment): PhaseDeps {
  return { ...session.deps, paths: environment.paths };
}
