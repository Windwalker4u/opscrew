import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
});
