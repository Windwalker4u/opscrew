/**
 * The switch's wait for B's zone to become active, before the steps right after activation and
 * the HTTPS gap's measure: once the registry names B's nameservers (its RDAP record,
 * `deps.registryNs`), one activation check, then B's zone read every 30 seconds, for at most 15
 * minutes. B's zone is on the Free plan during the move, where Cloudflare takes one requested
 * check an hour: a check asked before the registry names B's nameservers finds the old ones and
 * holds the next one back for an hour. So the check is asked at once only when the registry can't
 * be asked, or hasn't been readable on any round of this run.
 */
import { errorMessage, listText, OpsCrewError, realSleep } from "@opscrew/core";
import { hosts, sameHosts } from "../domain/switch";
import { GAP_INTERVAL_MS } from "./gap";
import { moveAudit } from "./texts";
import type { MoveSession, MoveZone } from "./types";

/** How long one run waits for B's zone to become active before it stops. */
export const ACTIVATION_LIMIT_MS = 15 * 60 * 1000;

/**
 * Asks Cloudflare to check B's nameservers now; audited when Cloudflare took the request. Too soon
 * (an earlier run asked within the hour) is silent, and any other refusal a warning: Cloudflare
 * checks a pending zone's nameservers on its own as well.
 */
async function askActivationCheck(session: MoveSession, zone: MoveZone): Promise<void> {
  const { deps } = session;
  const { b } = session.accounts;
  try {
    const check = await b.client.activationCheck(zone.id);
    if (!check.requested) return;
    await moveAudit(deps, {
      kind: "provider-call",
      action: "activation check",
      target: session.zone,
      detail: `zone ${zone.id} in the account ${b.accountId}`,
    });
  } catch (error) {
    if (!(error instanceof OpsCrewError)) throw error;
    deps.reporter.warn(
      `Cloudflare could not start an activation check for ${session.zone} now (${deps.redactor.redact(errorMessage(error))}); Cloudflare checks the nameservers on its own.`,
    );
  }
}

/** Why B's zone isn't active yet, in words, from the registry's last readable answer. */
function pendingText(
  session: MoveSession,
  wanted: readonly string[],
  atRegistry: readonly string[] | undefined,
  asked: boolean,
): string {
  const { zone } = session;
  const extra = (atRegistry ?? []).filter((name) => !wanted.includes(name));
  if (asked || atRegistry === undefined) {
    return `Cloudflare has not activated ${zone} in the new account yet. OpsCrew asked it to check the nameservers, and its own checks go on; it takes one requested check an hour on the Free plan, so a run within the hour only waits for them.`;
  }
  if (wanted.every((name) => atRegistry.includes(name))) {
    return `The registry names ${listText(extra)} for ${zone} besides the new account's nameservers: remove ${extra.length === 1 ? "it" : "them"} at the registrar, so that it names only ${listText([...wanted].sort())}.`;
  }
  return `The registry still names ${listText(atRegistry)} for ${zone}, not the new account's nameservers (${listText([...wanted].sort())}), so Cloudflare can't activate the zone there yet.`;
}

/**
 * Waits for B's zone (`zone`, pending when the switch read it) to become active, within
 * {@link ACTIVATION_LIMIT_MS}: the registry read each round until it names exactly B's
 * nameservers, then the one activation check. A round whose reading fails after an earlier one
 * succeeded counts as a passing failure: nothing is asked then. Returns `undefined` once the zone
 * is active, else why it isn't (the run stops). `sleep` and `now` come from the move's services.
 */
export async function waitForActive(
  session: MoveSession,
  zone: MoveZone,
): Promise<string | undefined> {
  const { deps, services } = session;
  const sleep = services.sleep ?? realSleep;
  const now = services.now ?? Date.now;
  const started = now();
  const wanted = hosts(zone.nameServers);
  let atRegistry: string[] | undefined;
  let asked = false;
  deps.reporter.step(
    `Waiting for Cloudflare to activate ${session.zone} in the new account (at most 15 minutes)`,
  );
  for (;;) {
    const read = await session.accounts.b.client.getZone(zone.id);
    if (read.status === "active") return undefined;
    if (!asked) {
      const reading = await deps.registryNs?.(session.zone);
      atRegistry = reading ?? atRegistry;
      if (atRegistry === undefined || (reading !== undefined && sameHosts(reading, wanted))) {
        asked = true;
        await askActivationCheck(session, read);
      }
    }
    if (now() - started >= ACTIVATION_LIMIT_MS) {
      return pendingText(session, wanted, atRegistry, asked);
    }
    await sleep(GAP_INTERVAL_MS);
  }
}
