/**
 * The fake worlds of a move to another Cloudflare account, one per step (prepare, switch, finish,
 * abort), for the CLI's end-to-end test of `opscrew cloudflare move`. Tests only.
 *
 * Each is loaded when called: the move's fakes import this package's other fakes from this
 * folder's index, which would not have loaded them yet when it loads this file.
 */
import type { AbortHarnessOptions } from "../cloudflare-move/abort.fakes";
import type { FinishTarget, FinishWorldOptions } from "../cloudflare-move/finish-removal.fakes";
import type { PrepareTarget, PrepareWorldOptions } from "../cloudflare-move/prepare.fakes";
import type { SwitchHarnessOptions } from "../cloudflare-move/switch.fakes";

export type { AbortHarness, AbortHarnessOptions } from "../cloudflare-move/abort.fakes";
export type {
  FinishTarget,
  FinishWorld,
  FinishWorldOptions,
} from "../cloudflare-move/finish-removal.fakes";
export type {
  PrepareTarget,
  PrepareWorld,
  PrepareWorldOptions,
} from "../cloudflare-move/prepare.fakes";
export type { SwitchHarness, SwitchHarnessOptions } from "../cloudflare-move/switch.fakes";

/** Prepare's world: the app on `target`, nothing prepared yet. */
export async function prepareWorld(target: PrepareTarget, options?: PrepareWorldOptions) {
  return (await import("../cloudflare-move/prepare.fakes")).prepareWorld(target, options);
}

/** The switch's world: the app prepared, B's zone pending with the marks. */
export async function switchHarness(options?: SwitchHarnessOptions) {
  return (await import("../cloudflare-move/switch.fakes")).switchHarness(options);
}

/** The finish's world: the app on `target`, prepared, B's zone active. */
export async function finishWorld(target: FinishTarget, options?: FinishWorldOptions) {
  return (await import("../cloudflare-move/finish-removal.fakes")).finishWorld(target, options);
}

/** The abort's world: the app prepared in B, before the switch. */
export async function abortHarness(options?: AbortHarnessOptions) {
  return (await import("../cloudflare-move/abort.fakes")).abortHarness(options);
}
