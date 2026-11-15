import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RegistryDsTtl } from "../domain/registry-ds";
import { OLD_DS } from "../testing";
import { ZONE } from "./session.fakes";
import { switchHarness } from "./switch.fakes";

const HOUR = 3600_000;

describe("the switch's DS wait from the registry's own TTL", () => {
  it("Cloudflare Registrar, TTL 1800: waits 2 hours once the DS record is gone, plus the hour after a removal", async () => {
    const h = await switchHarness({ registrar: "cloudflare", dsAtStart: true });
    h.deps.interactive = true;
    const asked: string[] = [];
    const answer: RegistryDsTtl = { kind: "published", ttlSeconds: 1800 };
    Object.assign(h.deps, {
      registryDs: async (domain: string) => {
        asked.push(domain);
        return answer;
      },
    });
    (h.aZone.dnssec as { status: string }).status = "pending-disabled";
    h.web.ds = [OLD_DS];

    const published = await h.run();
    expect(published.next[0]).toContain("about 3 hours later");
    expect(asked).toEqual([ZONE]);
    const note = join(h.deps.paths.root, ".opscrew", "cloudflare-move-switch-ds-wait.json");
    expect(JSON.parse(await readFile(note, "utf8"))).toMatchObject({ waitSeconds: 7200 });

    // Gone from the registry: the wait starts now, 2 hours plus the hour.
    h.web.ds = [];
    const waiting = await h.run();
    expect(waiting.done).toBe(false);
    expect(h.asked()).toEqual([]);

    h.time.ms += 3 * HOUR - 60_000;
    expect((await h.run()).done).toBe(false);
    expect(h.asked()).toEqual([]);

    h.time.ms += 60_000;
    await h.run();
    expect(h.asked()).toHaveLength(1);
  });
});
