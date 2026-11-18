/**
 * Measuring the HTTPS gap of the switch (plan 6.), once B's zone is active (the switch waits for
 * that first, `waitForActive`): from the nameserver change until B's zone is active, its Universal
 * SSL certificate issued and each hostname answering over HTTPS from this computer. Every 30
 * seconds until each answers, or two hours: then it stops, and the next run goes on with the same
 * times (kept in the switch file).
 */
import { realSleep } from "@opscrew/core";
import { type SwitchProgress, writeSwitchProgress } from "./progress";
import type { MoveSession, MoveZone } from "./types";

/** How often the loop looks. */
export const GAP_INTERVAL_MS = 30_000;
/** How long one run measures before it stops. */
export const GAP_LIMIT_MS = 2 * 60 * 60 * 1000;
/** How long one HTTPS request may take. */
const PROBE_TIMEOUT_MS = 10_000;

/** What the measure waits on, besides the times. */
export interface GapInput {
  /** B's zone, active (its id). */
  zone: MoveZone;
  /** The hostnames probed from the start: the marks' names with an address or CNAME record in B. */
  hostnames: readonly string[];
  /**
   * Runs once per run, before the loop: the switch's steps right after activation. Returns the
   * further hostnames to probe (the sites' custom domains, once attached).
   */
  activated: () => Promise<readonly string[]>;
}

/** Where the measure got to. */
export interface GapResult {
  progress: SwitchProgress;
  /** Every hostname probed. */
  hostnames: string[];
  /** True once B's certificate is issued and every hostname answered. */
  done: boolean;
}

/**
 * True when an HTTPS request to `hostname` (certificate checked, 10 s at most) got an answer that
 * is neither a 52x nor a 530: the edge served it with a valid certificate and reached the origin.
 */
async function answers(session: MoveSession, hostname: string): Promise<boolean> {
  const fetch = session.services.fetch ?? session.deps.fetch;
  try {
    const response = await fetch(`https://${hostname}/`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status < 520 || response.status > 530;
  } catch {
    return false;
  }
}

/**
 * The gap's loop on `progress`, B's zone active: `activeAt` stamped (unless kept from an earlier
 * run) and `input.activated` run once, then `certificateAt` once the universal certificate pack is
 * active and `okAt` per hostname once it answers, each written to the switch file when first
 * seen. `sleep` and `now` (milliseconds, for the limit) come from the move's services.
 */
export async function measureGap(
  session: MoveSession,
  progress: SwitchProgress,
  input: GapInput,
): Promise<GapResult> {
  const { deps, services } = session;
  const { b } = session.accounts;
  const sleep = services.sleep ?? realSleep;
  const now = services.now ?? Date.now;
  const started = now();
  let times: SwitchProgress = { ...progress, okAt: { ...progress.okAt } };
  const stamp = async (change: Partial<SwitchProgress>) => {
    times = { ...times, ...change };
    await writeSwitchProgress(session.paths, times);
  };
  if (times.activeAt === undefined) await stamp({ activeAt: deps.clock.now().toISOString() });
  const hostnames = [...input.hostnames];
  for (const name of await input.activated()) {
    if (!hostnames.includes(name)) hostnames.push(name);
  }
  for (;;) {
    if (times.certificateAt === undefined) {
      const packs = await b.client.listCertificatePacks(input.zone.id);
      if (packs.some((p) => p.type === "universal" && p.status === "active")) {
        await stamp({ certificateAt: deps.clock.now().toISOString() });
      }
    }
    for (const hostname of hostnames) {
      if (times.okAt?.[hostname] !== undefined || !(await answers(session, hostname))) continue;
      await stamp({ okAt: { ...times.okAt, [hostname]: deps.clock.now().toISOString() } });
    }
    const done =
      times.certificateAt !== undefined &&
      hostnames.every((name) => times.okAt?.[name] !== undefined);
    if (done || now() - started >= GAP_LIMIT_MS) return { progress: times, hostnames, done };
    await sleep(GAP_INTERVAL_MS);
  }
}

/** Minutes and seconds between two ISO times: `12 min 30 s`. */
export function gapText(from: string, to: string): string {
  const seconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds % 60} s`;
}
