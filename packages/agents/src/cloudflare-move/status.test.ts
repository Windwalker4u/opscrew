import type { DeployPlan } from "@opscrew/plan-schema";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type MoveHarness, moveHarness, recordedMove, serverPlan, ZONE } from "./session.fakes";
import { cloudflareMoveStatus } from "./status";

let harness: MoveHarness;

/** `plan`'s record at `step`, with B's zone id `zoneId` once B has it. */
function at(plan: DeployPlan, step: "started" | "prepared" | "adopted", zoneId?: string) {
  const move = plan.cloudflareMove;
  if (move === undefined) throw new Error("no record");
  return DeployPlanSchema.parse({
    ...plan,
    cloudflareMove: {
      ...move,
      step,
      ...(zoneId === undefined ? {} : { to: { ...move.to, zoneId } }),
    },
  });
}

const MARK = `"opscrew-move=1; app=shop; envs=prod,staging; hosts=shop.${ZONE},staging.shop.${ZONE}"`;
const OTHER = `"opscrew-move=1; app=blog; envs=prod; hosts=blog.${ZONE}; worker=blog; domains=blog.${ZONE}"`;

describe("cloudflareMoveStatus", () => {
  it("is undefined while no environment records a move", async () => {
    harness = await moveHarness();
    expect(await cloudflareMoveStatus(harness.deps)).toBeUndefined();
    expect(harness.cloudflare.calls).toEqual([]);
  });

  it("shows each environment's step and, with B's token, the apps prepared there (GET only)", async () => {
    harness = await moveHarness({
      bZone: true,
      plans: (cf) => {
        const b = cf.zone(ZONE, "New").id;
        return {
          prod: at(recordedMove(serverPlan(), cf), "prepared", b),
          staging: at(
            recordedMove(serverPlan(`staging.shop.${ZONE}`, "staging"), cf),
            "started",
            b,
          ),
        };
      },
    });
    const b = harness.cloudflare.zone(ZONE, "New");
    harness.cloudflare.addRecord(b, {
      type: "TXT",
      name: `_opscrew-move.shop-1.${ZONE}`,
      content: MARK,
    });
    harness.cloudflare.addRecord(b, {
      type: "TXT",
      name: `_opscrew-move.blog-2.${ZONE}`,
      content: OTHER,
    });
    const status = await cloudflareMoveStatus(harness.deps);
    expect(status).toMatchObject({
      zone: ZONE,
      environments: [
        { name: "prod", step: "prepared" },
        { name: "staging", step: "started" },
      ],
      prepared: [
        { app: "blog", envs: ["prod"] },
        { app: "shop", envs: ["prod", "staging"] },
      ],
    });
    expect(status?.next).toContain("`opscrew cloudflare move` to go on preparing it");
    const text = status?.lines.join("\n") ?? "";
    expect(text).toContain("prod     prepared in the new account");
    expect(text).toContain(
      "apps prepared in the new account: blog (prod) and shop (prod, staging)",
    );
    // Only the app and its environments reach the output.
    expect(JSON.stringify(status)).not.toContain(`blog.${ZONE}`);
    expect(harness.readOnly()).toBe(true);
    expect(harness.leaks(text)).toBe(false);
  });

  it("reads nothing from Cloudflare without B's token or before B's zone exists", async () => {
    harness = await moveHarness({
      bZone: true,
      env: { OPSCREW_NEW_CLOUDFLARE_API_TOKEN: undefined },
      plans: (cf) => ({
        prod: at(recordedMove(serverPlan(), cf), "prepared", cf.zone(ZONE, "New").id),
      }),
    });
    const status = await cloudflareMoveStatus(harness.deps);
    expect(status?.prepared).toBeUndefined();
    expect(status?.next).toContain("`opscrew cloudflare move --switch` once every app");
    expect(harness.cloudflare.calls).toEqual([]);

    harness = await moveHarness({ plans: (cf) => ({ prod: recordedMove(serverPlan(), cf) }) });
    expect((await cloudflareMoveStatus(harness.deps))?.prepared).toBeUndefined();
    expect(harness.cloudflare.calls).toEqual([]);
  });

  it("a refused read of B is a redacted line, and the steps still show", async () => {
    harness = await moveHarness({
      bZone: true,
      plans: (cf) => ({
        prod: at(recordedMove(serverPlan(), cf), "adopted", cf.zone(ZONE, "New").id),
      }),
    });
    const token = harness.tokens.b;
    const client = {
      listZoneRecords: async () => {
        throw new Error(`refused for ${token}`);
      },
    };
    const status = await cloudflareMoveStatus(harness.deps, { client });
    expect(status?.environments).toEqual([{ name: "prod", step: "adopted" }]);
    expect(status?.note).toContain("could not be read with OPSCREW_NEW_CLOUDFLARE_API_TOKEN");
    expect(status?.note).not.toContain(token);
    expect(status?.next).toContain("`opscrew cloudflare move --finish` to complete the move");
  });

  it("names the abort while one runs", async () => {
    harness = await moveHarness({
      plans: (cf) => {
        const plan = recordedMove(serverPlan(), cf);
        const move = plan.cloudflareMove;
        return {
          prod: DeployPlanSchema.parse({
            ...plan,
            cloudflareMove: { ...move, abort: { step: "started" } },
          }),
        };
      },
    });
    const status = await cloudflareMoveStatus(harness.deps);
    expect(status?.environments).toEqual([{ name: "prod", step: "started", abort: "started" }]);
    expect(status?.lines.join("\n")).toContain("prod  being aborted");
    expect(status?.next).toBe("run `opscrew cloudflare move --abort` to finish the abort");
  });
});
