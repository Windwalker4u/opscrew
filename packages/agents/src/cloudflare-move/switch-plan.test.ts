import { describe, expect, it } from "vitest";
import { ZONE } from "./session.fakes";
import { switchHarness } from "./switch.fakes";

describe("planSwitch: what OpsCrew doesn't move", () => {
  it("lists it in the details before the approval, outside the hash: a list that changed since still applies", async () => {
    const h = await switchHarness();
    h.aZone.data.pageRules = 1;
    const stopped = await h.run();
    const hash = stopped.pendingPlanHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Found since: more page rules, a Worker, and a kind A's token may no longer read.
    h.aZone.data.pageRules = 4;
    h.cloudflare.account("Old").workers.set("hello", {});
    h.cloudflare.tokens.get(h.tokens.a)?.denied.add("turnstile");
    const result = await h.run({ approvePlanHash: hash });
    expect(result.done).toBe(true);
    const [approval] = h.asked();
    expect(approval?.planHash).toBe(hash);
    const details = approval?.details ?? "";
    const [plan, list] = details.split(/\n(?=What OpsCrew doesn't move)/);
    expect(plan).toMatch(/Nothing else in the account .* changes\.$/);
    expect(list).toMatch(
      new RegExp(
        `^What OpsCrew doesn't move, read in the Cloudflare account Old .*: redo in New what should go with ${ZONE.replace(".", "\\.")}, or leave it:`,
      ),
    );
    for (const line of [
      "  - Page Rules: 4 page rules. In New: Rules > Page Rules.",
      "  - Workers: hello. In New: Workers & Pages.",
      "  - Turnstile widgets: couldn't read: check in the dashboard. In New: Turnstile.",
    ]) {
      expect(list?.split("\n")).toContain(line);
    }
    expect(h.writes("Old")).toEqual([]);
  });
});
