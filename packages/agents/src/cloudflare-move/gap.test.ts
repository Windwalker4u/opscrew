import { afterEach, describe, expect, it, vi } from "vitest";
import { GAP_INTERVAL_MS, GAP_LIMIT_MS, gapText, measureGap } from "./gap";
import { readSwitchProgress, type SwitchProgress } from "./progress";
import { ZONE } from "./session.fakes";
import { type SwitchHarness, switchHarness } from "./switch.fakes";
import type { MoveSession } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The harness's session, New's zone in it, and the switch file's start. */
async function started(): Promise<{
  h: SwitchHarness;
  session: MoveSession;
  progress: SwitchProgress;
}> {
  const h = await switchHarness();
  const session = await h.open({ services: h.services });
  const progress = { zone: ZONE, nameserversSetAt: h.deps.clock.now().toISOString() };
  return { h, session, progress };
}

const zoneOf = (h: SwitchHarness) => ({
  id: h.bZone.id,
  name: ZONE,
  status: h.bZone.status,
  nameServers: h.bZone.nameServers,
});

describe("measureGap", () => {
  it("stamps the activation and runs the steps after it once, then looks every 30 seconds until the certificate is issued and every hostname answers", async () => {
    const { h, session, progress } = await started();
    h.cloudflare.activate(h.bZone);
    for (const pack of h.bZone.certificatePacks) pack.status = "initializing";
    const sleeps: number[] = [];
    h.sleeps.onSleep = () => {
      sleeps.push(h.time.ms);
      if (h.time.ms < 5 * 60_000) return;
      for (const pack of h.bZone.certificatePacks) pack.status = "active";
    };
    const activated = vi.fn(async () => [`docs.${ZONE}`]);
    const result = await measureGap(session, progress, {
      zone: zoneOf(h),
      hostnames: [`shop.${ZONE}`],
      activated,
    });
    expect(result.done).toBe(true);
    expect(activated).toHaveBeenCalledTimes(1);
    expect(sleeps.slice(0, 2)).toEqual([GAP_INTERVAL_MS, 2 * GAP_INTERVAL_MS]);
    expect(new Set(h.web.probes)).toEqual(new Set([`shop.${ZONE}`, `docs.${ZONE}`]));
    expect(result.hostnames).toEqual([`shop.${ZONE}`, `docs.${ZONE}`]);
    const times = result.progress;
    expect(times.activeAt).toBe(progress.nameserversSetAt);
    expect(gapText(times.activeAt as string, times.certificateAt as string)).toBe("5 min 0 s");
    // Nothing asks Cloudflare to activate a zone that is active.
    expect(h.cloudflare.calls.some((c) => c.path.endsWith("/activation_check"))).toBe(false);
    expect(await readSwitchProgress(h.deps.paths)).toEqual(times);
  });

  it("stops at the two-hour limit without counting a 52x or 530 answer, and the next run goes on with the same times", async () => {
    const { h, session, progress } = await started();
    h.cloudflare.activate(h.bZone);
    h.web.status.set(`shop.${ZONE}`, 530);
    const input = { zone: zoneOf(h), hostnames: [`shop.${ZONE}`], activated: async () => [] };
    const first = await measureGap(session, progress, input);
    expect(first.done).toBe(false);
    expect(h.time.ms).toBe(GAP_LIMIT_MS);
    expect(first.progress.okAt).toEqual({});
    const kept = await readSwitchProgress(h.deps.paths);
    expect(kept?.activeAt).toBe(progress.nameserversSetAt);
    expect(kept?.certificateAt).toBeDefined();

    h.web.status.delete(`shop.${ZONE}`);
    const next = await measureGap(session, kept as SwitchProgress, input);
    expect(next.done).toBe(true);
    expect(next.progress.activeAt).toBe(kept?.activeAt);
    expect(next.progress.okAt?.[`shop.${ZONE}`]).toBeDefined();
  });
});
