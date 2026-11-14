/** The commands, token variables and refusal of a move to another Cloudflare account. */
import { type ErrorCode, OpsCrewError } from "@opscrew/core";

/** Prepare (`--to <account>`), or continue it. */
export const MOVE_COMMAND = "opscrew cloudflare move";
export const SWITCH_COMMAND = `${MOVE_COMMAND} --switch`;
export const FINISH_COMMAND = `${MOVE_COMMAND} --finish`;
export const ABORT_COMMAND = `${MOVE_COMMAND} --abort`;

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
