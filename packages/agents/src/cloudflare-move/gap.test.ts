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
  it("looks every 30 seconds, asks for an activation check as often as Cloudflare allows while pending, and probes only once active", async () => {
    const { h, session, progress } = await started();
    const sleeps: number[] = [];
    let probedWhilePending = 0;
    h.sleeps.onSleep = () => {
      sleeps.push(h.time.ms);
      if (h.bZone.status === "pending") probedWhilePending += h.web.probes.length;
      if (h.time.ms >= 20 * 60_000 && h.bZone.status === "pending") h.cloudflare.activate(h.bZone);
    };
    const activated = vi.fn(async () => [`docs.${ZONE}`]);
    const result = await measureGap(session, progress, {
      zone: zoneOf(h),
      hostnames: [`shop.${ZONE}`],
      activated,
    });
    expect(result.done).toBe(true);
    expect(sleeps[1]).toBe(2 * GAP_INTERVAL_MS);
    expect(probedWhilePending).toBe(0);
    expect(activated).toHaveBeenCalledTimes(1);
    expect(new Set(h.web.probes)).toEqual(new Set([`shop.${ZONE}`, `docs.${ZONE}`]));
    // Accepted at the start; asked again after 5 minutes (refused: once an hour on a free zone).
    const checks = h.cloudflare.calls.filter((c) => c.path.endsWith("/activation_check"));
    expect(checks).toHaveLength(2);
    expect(h.bZone.activationChecks).toHaveLength(1);
    expect(h.deps.audit.entries.filter((e) => e.action === "activation check")).toHaveLength(1);
    const times = result.progress;
    expect(gapText(times.nameserversSetAt as string, times.activeAt as string)).toBe("20 min 0 s");
    expect(await readSwitchProgress(h.deps.paths)).toEqual(times);
  });

  it("takes a failed activation check as harmless and asks again five minutes later", async () => {
    const { h, session, progress } = await started();
    h.cloudflare.faults.push({
      match: `PUT /zones/${h.bZone.id}/activation_check`,
      reply: {
        status: 403,
        body: {
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          messages: [],
          result: null,
        },
      },
    });
    h.sleeps.onSleep = () => {
      if (h.time.ms >= 10 * 60_000 && h.bZone.status === "pending") h.cloudflare.activate(h.bZone);
    };
    const result = await measureGap(session, progress, {
      zone: zoneOf(h),
      hostnames: [`shop.${ZONE}`],
      activated: async () => [],
    });
    expect(result.done).toBe(true);
    const checks = h.cloudflare.calls.filter((c) => c.path.endsWith("/activation_check"));
    expect(checks.map((c) => c.status)).toEqual([403, 200]);
    const warned = h.deps.reporter.lines.filter((l) =>
      l.message.includes("Cloudflare checks the nameservers on its own"),
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]?.level).toBe("warn");
    expect(h.bZone.activationChecks).toHaveLength(1);
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
