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
