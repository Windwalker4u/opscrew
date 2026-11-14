import { readFile } from "node:fs/promises";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { appPlan } from "../apps/__fixtures__/sites";
import { ownPlan } from "../testing";
import { moveHarness, OTHER_ZONE, serverPlan, unencrypted, ZONE } from "./session.fakes";
import { confirmMoveStart, moveSummary } from "./summary";
import type { MoveBucketSize, MoveSummary } from "./types";

const GIB = 1024 ** 3;

/** prod's app bucket and staging's backups bucket, measured on their servers. */
const SIZES: MoveBucketSize[] = [
  { environment: "prod", root: "storage", bucket: "shop-files", bytes: 3 * GIB, count: 4000 },
  { environment: "staging", root: "backups", bucket: "shop-staging-backups", bytes: 0, count: 0 },
];

/** prod and staging in the zone, dev in another zone, old not deployed, a tunnel on staging. */
async function several() {
  return moveHarness({
    plans: () => ({
      prod: serverPlan(),
      dev: serverPlan(`dev.${OTHER_ZONE}`, "dev"),
      old: serverPlan(`old.shop.${ZONE}`, "old", false),
      staging: appPlan(
        undefined,
        "staging",
        unencrypted(ownPlan({ access: "tunnel", deployed: true, domain: `staging.shop.${ZONE}` })),
      ),
    }),
  });
}

describe.skipIf(!findExecutable("git"))("moveSummary", () => {
  it("lists B's zone, each environment's pieces, the buckets, the other apps, the gap and the window", async () => {
    const h = await several();
    const session = await h.open({ to: "New" });
    const summary = moveSummary(session, SIZES);
    const fresh = h.cloudflare.account("New");
    const text = summary.lines.join("\n");
    expect(summary).toMatchObject({
      zone: ZONE,
      from: { accountId: h.cloudflare.account("Old").id },
      to: { accountId: fresh.id, name: "New" },
      staying: [{ name: "dev", zone: OTHER_ZONE }],
      skipped: ["old"],
      otherHostnames: [`blog.${ZONE}`, `docs.${ZONE}`],
      windows: [{ environment: "prod", minutes: 4 }],
    });
    expect(summary.buckets.map((bucket) => bucket.minutes)).toEqual([7, 2]);
    expect(summary.environments.map((env) => env.name)).toEqual(["prod", "staging"]);
    expect(text).toContain(
      `Add ${ZONE} to New (${fresh.id}) as a new zone (pending until the switch)`,
    );
    expect(text).toContain(
      `- prod: DNS records for shop.${ZONE}; OpsCrew's rules for its hostnames; origin protection`,
    );
    expect(text).toContain(
      "a Cloudflare Tunnel with its Access, and its connector on the server beside the current one",
    );
    expect(text).toContain("as extra GitHub secrets, so deploys work on both sides of the switch");
    expect(text).toContain("- prod's shop-files: 3.0 GB in 4000 objects, about 7 minutes.");
    expect(text).toContain(`Staying as they are: dev (in ${OTHER_ZONE}).`);
    expect(text).toContain("Skipped, since they are not deployed: old.");
    expect(text).toContain(`from its repository before the switch: blog.${ZONE} and docs.${ZONE}.`);
    expect(text).toContain("HTTPS visitors may get certificate errors");
    expect(text).toContain("a maintenance window of about 4 minutes for prod");
    expect(h.leaks(text)).toBe(false);
  });

  it("uses B's zone when it is there, and has no window without an app bucket", async () => {
    const h = await moveHarness({ bZone: true });
    const session = await h.open({ to: "New" });
    const summary = moveSummary(session, []);
    const text = summary.lines.join("\n");
    expect(text).toContain(`Use ${ZONE} in New (${h.cloudflare.account("New").id}) (pending)`);
    expect(text).toContain("  3. Mark the app as prepared in the new zone.");
    expect(text).toContain(
      "Then the finish (`opscrew cloudflare move --finish`): no maintenance window;",
    );
    expect(summary.windows).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("confirmMoveStart", () => {
  it("shows the summary and, refused, stops with nothing changed", async () => {
    const h = await moveHarness();
    const session = await h.open({ to: "New" });
    const before = await readFile(h.deps.paths.files.plan, "utf8");
    const summary = moveSummary(session, []);
    const asked: MoveSummary[] = [];
    const error = await confirmMoveStart(session, summary, async (shown) => {
      asked.push(shown);
      return false;
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "APPROVAL_REFUSED",
      message: "The move was not started. Nothing was changed.",
      hint: "Run `opscrew cloudflare move` again when you are ready.",
    });
    expect(asked).toEqual([summary]);
    expect(h.deps.reporter.text()).toContain(summary.lines[0]);
    expect(await readFile(h.deps.paths.files.plan, "utf8")).toBe(before);
    expect(h.readOnly()).toBe(true);
    expect(h.leaks()).toBe(false);
  });

  it("goes on when confirmed, or in a script without the question", async () => {
    const h = await moveHarness();
    const session = await h.open({ to: "New" });
    const summary = moveSummary(session, []);
    await expect(confirmMoveStart(session, summary, async () => true)).resolves.toBeUndefined();
    await expect(confirmMoveStart(session, summary, undefined)).resolves.toBeUndefined();
  });
});
