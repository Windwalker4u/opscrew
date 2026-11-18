import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegistryDsTtl } from "../domain/registry-ds";
import { OLD_DS } from "../testing";
import { ZONE } from "./session.fakes";
import { switchHarness } from "./switch.fakes";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("the switch's DS wait from the registry's own answer", () => {
  it("Cloudflare Registrar, TTL 1800: once the registry publishes none, goes on 2 hours after that reading", async () => {
    const h = await switchHarness({ registrar: "cloudflare", dsAtStart: true });
    h.deps.interactive = true;
    const asked: string[] = [];
    let answer: RegistryDsTtl = { kind: "published", ttlSeconds: 1800, records: [OLD_DS] };
    Object.assign(h.deps, {
      registryDs: async (domain: string) => {
        asked.push(domain);
        return answer;
      },
    });
    (h.aZone.dnssec as { status: string }).status = "pending-disabled";
    h.web.ds = [OLD_DS];

    const published = await h.run();
    expect(published.next[0]).toContain("about 2 hours later");
    expect(asked).toEqual([ZONE]);
    const note = join(h.deps.paths.root, ".opscrew", "cloudflare-move-switch-ds-wait.json");
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({ waitSeconds: 7200 });

    // Ten minutes later the registry publishes none, while the public DNS still shows its copy:
    // gone, and the wait (twice the TTL plus an hour) counts from this reading, 09:10.
    h.time.ms += 10 * MINUTE;
    answer = { kind: "none" };
    const waiting = await h.run();
    expect(waiting.done).toBe(false);
    expect(h.asked()).toEqual([]);
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({
      switchAfter: "2026-11-21T11:10:00.000Z",
    });

    h.time.ms += 2 * HOUR - MINUTE;
    expect((await h.run()).done).toBe(false);
    expect(h.asked()).toEqual([]);

    h.time.ms += MINUTE;
    await h.run();
    expect(h.asked()).toHaveLength(1);
  });

  it("Cloudflare Registrar: while the registry still publishes the record, waits though the public DNS shows none", async () => {
    const h = await switchHarness({ registrar: "cloudflare", dsAtStart: true });
    h.deps.interactive = true;
    const answer: RegistryDsTtl = { kind: "published", ttlSeconds: 1800, records: [OLD_DS] };
    Object.assign(h.deps, { registryDs: async () => answer });
    (h.aZone.dnssec as { status: string }).status = "pending-disabled";

    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    expect(stopped.next[0]).toContain("about 2 hours later");
    expect(h.asked()).toEqual([]);
  });
  it("Porkbun: a fresh wait when the registry drops the records after a run still saw them published", async () => {
    const h = await switchHarness({});
    h.deps.interactive = true;
    let answer: RegistryDsTtl = { kind: "published", ttlSeconds: 1800, records: [OLD_DS] };
    Object.assign(h.deps, { registryDs: async () => answer });
    // Removed through the API by an earlier run, which noted 10:00; the API lists none now.
    const note = join(h.deps.paths.root, ".opscrew", "cloudflare-move-switch-ds.json");
    await mkdir(dirname(note), { recursive: true });
    const removed = { domain: ZONE, registrar: "porkbun", switchAfter: "2026-11-21T10:00:00.000Z" };
    await writeFile(note, JSON.stringify({ ...removed, waitSeconds: 7200 }));
    h.web.ds = [OLD_DS];

    // 09:00: the registry still publishes them; no switch time is noted any more.
    const still = await h.run();
    expect(still.done).toBe(false);
    expect(still.next[0]).toContain("after 2026-11-21 12:00 UTC");
    expect(JSON.parse(await readFile(note, "utf8")).switchAfter).toBeUndefined();

    // Dropped at 11:50; the run at 12:00 reads none: the wait starts then, 2 hours.
    answer = { kind: "none" };
    h.time.ms += 3 * HOUR;
    expect((await h.run()).done).toBe(false);
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({
      switchAfter: "2026-11-21T14:00:00.000Z",
    });
    expect(h.asked()).toEqual([]);

    h.time.ms += 2 * HOUR;
    await h.run();
    expect(h.asked()).toHaveLength(1);
  });

  /**
   * The zone at `registrar` with its DS record published by the registry (TTL 1800: a 2-hour wait)
   * and shown by the public DNS; for Cloudflare Registrar, DNSSEC is being turned off in A. The
   * first run (09:00) notes the sighting and stops; then the registry drops the record and its
   * RDAP record says it last changed the zone at 10:00. `run` moves the clock to `at` and runs.
   */
  async function droppedAtTen(registrar: "cloudflare" | "namecheap") {
    const h = await switchHarness({ registrar, dsAtStart: true });
    h.deps.interactive = true;
    let answer: RegistryDsTtl = { kind: "published", ttlSeconds: 1800, records: [OLD_DS] };
    Object.assign(h.deps, { registryDs: async () => answer });
    if (registrar === "cloudflare") {
      (h.aZone.dnssec as { status: string }).status = "pending-disabled";
    }
    h.web.ds = [OLD_DS];

    const seen = await h.run();
    expect(seen.done).toBe(false);
    const name = registrar === "cloudflare" ? "switch-ds-wait" : "switch-ds";
    const note = join(h.deps.paths.root, ".opscrew", `cloudflare-move-${name}.json`);
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({
      dsSeen: "2026-11-21T09:00:00.000Z",
      waitSeconds: 7200,
    });

    answer = { kind: "none", changedAt: "2026-11-21T10:00:00Z" };
    h.web.ds = [];
    const run = (at: string) => {
      h.time.ms = Date.parse(at) - Date.parse("2026-11-21T09:00:00.000Z");
      return h.run();
    };
    return { h, note, run };
  }

  it("Cloudflare Registrar: the wait counts from the registry's change time, not from the run that sees it gone", async () => {
    const { h, note, run } = await droppedAtTen("cloudflare");

    // 11:00: two hours from 10:00, not from this run.
    const waiting = await run("2026-11-21T11:00:00.000Z");
    expect(waiting.done).toBe(false);
    expect(waiting.next[0]).toContain("after 2026-11-21 12:00 UTC");
    expect(JSON.parse(await readFile(note, "utf8"))).toEqual({
      zone: ZONE,
      switchAfter: "2026-11-21T12:00:00.000Z",
      waitSeconds: 7200,
    });
    expect(h.asked()).toEqual([]);

    await run("2026-11-21T12:00:00.000Z");
    expect(h.asked()).toHaveLength(1);
  });

  it("Cloudflare Registrar: goes on at once when the wait from the registry's change time ended before this run", async () => {
    const { h, run } = await droppedAtTen("cloudflare");

    await run("2026-11-21T13:00:00.000Z");

    expect(h.asked()).toHaveLength(1);
    expect(h.deps.reporter.text()).not.toContain("OpsCrew waits before");
  });

  it("Namecheap, removed in its dashboard: goes on at once when the wait from the registry's change time ended", async () => {
    const { h, run } = await droppedAtTen("namecheap");

    // From this run (13:00) the wait would last until 15:00.
    await run("2026-11-21T13:00:00.000Z");

    expect(h.asked()).toHaveLength(1);
    expect(h.deps.reporter.text()).not.toContain("OpsCrew waits before");
  });

  it.each([
    // The 24-hour floor from the registry's change at 08:00, not from this run at 09:00.
    ["from the registry's change time", { changedAt: "2026-11-21T08:00:00Z" }, "2026-11-22T08:00"],
    ["from this run without a change time", {}, "2026-11-22T09:00"],
  ])(
    "Namecheap, no note: a copy the registry no longer publishes waits %s",
    async (_case, rdap, until) => {
      const h = await switchHarness({ registrar: "namecheap", dsAtStart: true });
      h.deps.interactive = true;
      Object.assign(h.deps, { registryDs: async () => ({ kind: "none", ...rdap }) });
      h.web.ds = [OLD_DS];

      const waiting = await h.run();

      expect(waiting.done).toBe(false);
      expect(h.asked()).toEqual([]);
      const note = join(h.deps.paths.root, ".opscrew", "cloudflare-move-switch-ds.json");
      expect(JSON.parse(await readFile(note, "utf8"))).toEqual({
        domain: ZONE,
        registrar: "namecheap",
        switchAfter: `${until}:00.000Z`,
        waitSeconds: 86_400,
      });
    },
  );

  it("Cloudflare Registrar, no note: a copy the registry no longer publishes starts the wait now", async () => {
    const h = await switchHarness({ registrar: "cloudflare" });
    h.deps.interactive = true;
    Object.assign(h.deps, { registryDs: async () => ({ kind: "none" }) });
    h.web.ds = [OLD_DS];

    const waiting = await h.run();
    expect(waiting.done).toBe(false);
    expect(h.asked()).toEqual([]);
    const note = join(h.deps.paths.root, ".opscrew", "cloudflare-move-switch-ds-wait.json");
    // No TTL known: the 24-hour floor from this reading.
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({
      switchAfter: "2026-11-22T09:00:00.000Z",
    });
  });
});
