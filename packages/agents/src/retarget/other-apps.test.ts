import { findExecutable } from "@opscrew/core";
import { readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { firstAppLook, moveHarness, SERVER_IPV4, secondAppRecord } from "../testing";
import { caught, everythingPrinted, run } from "./__fixtures__/assert";

/** A live Hetzner deployment whose server holds `records` (or fails to be inspected). */
async function harness(look: { records?: ReturnType<typeof secondAppRecord>[]; fails?: Error }) {
  const h = await moveHarness();
  const { records = [], ...how } = look;
  h.services.otherApps = await firstAppLook(h.paths, records, how);
  return h;
}

describe.skipIf(!findExecutable("git"))(
  "opscrew retarget beside apps from other repositories (FR-3012)",
  () => {
    it("refuses to start the move while another app runs on the server, before any change", async () => {
      const h = await harness({ records: [secondAppRecord()] });
      const mark = h.events.length;
      const error = await caught(run(h));
      expect(error.code).toBe("PHASE_PRECONDITION");
      expect(error.message).toBe(
        'The server also runs "inventory" (from github.com/example/inventory), and moving the app off it would break it. Nothing was changed.',
      );
      expect(error.hint).toContain("then run `opscrew retarget` again");
      expect(h.events.slice(mark)).toEqual([]);
      expect(h.handler.requests).toEqual([]);
      expect((await readArtifact("plan", h.paths.files.plan)).retarget).toBeUndefined();
      expect(everythingPrinted(h)).not.toContain(SERVER_IPV4);
    });

    it("starts as before without one", async () => {
      const h = await moveHarness();
      expect(await run(h)).toMatchObject({ step: "switched" });
      expect(h.look.inspections).toHaveLength(1);
    });

    it("stops when the server can't be reached, unless --skip-other-apps-check", async () => {
      const down = await harness({ fails: new Error("unreachable") });
      const error = await caught(run(down));
      expect(error.message).toContain("OpsCrew couldn't look at the server for other apps");
      expect(error.hint).toContain("`opscrew retarget --skip-other-apps-check`");
      expect((await readArtifact("plan", down.paths.files.plan)).retarget).toBeUndefined();

      const skipped = await harness({ fails: new Error("unreachable") });
      expect(await run(skipped, { skipOtherAppsCheck: true })).toMatchObject({ step: "switched" });
      expect(skipped.reporter.text()).toContain("going on as you asked");
    });

    it("doesn't look again once a move is under way", async () => {
      const h = await moveHarness();
      await run(h);
      const inspections = h.look.inspections.length;
      await run(h).catch(() => undefined);
      expect(h.look.inspections).toHaveLength(inspections);
    });
  },
);
