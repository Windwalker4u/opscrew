import { describe, expect, it } from "vitest";
import {
  BUNNY_ACTION_SET_REQUEST_HEADER,
  type BunnyEdgeRule,
  OPSCREW_ORIGIN_HEADER_DESCRIPTION,
} from "./client";
import {
  applyBunnyOriginHeader,
  BUNNY_ORIGIN_AUTH_HEADER,
  planBunnyOriginHeader,
} from "./origin-header";

const TOKEN_1 = "1".repeat(64);
const TOKEN_2 = "2".repeat(64);

function fakeBunny(initial: BunnyEdgeRule[] = []) {
  let rules = [...initial];
  const upserts: { pullZoneId: number; guid?: string; headerName: string; token: string }[] = [];
  return {
    upserts,
    client: {
      async listEdgeRules() {
        return [...rules];
      },
      async upsertOriginHeaderRule(input: {
        pullZoneId: number;
        guid?: string;
        headerName: string;
        token: string;
      }) {
        upserts.push(input);
        rules = [
          {
            Guid: input.guid ?? "guid-created-1",
            ActionType: BUNNY_ACTION_SET_REQUEST_HEADER,
            ActionParameter1: input.headerName,
            ActionParameter2: input.token,
            Description: OPSCREW_ORIGIN_HEADER_DESCRIPTION,
            Enabled: true,
            Triggers: [{ Type: 0, PatternMatches: ["*"], Parameter1: "" }],
          },
        ];
      },
    },
  };
}

describe("Bunny origin-verification header plan & hash-bound apply", () => {
  it("plans create, noop, and update without ever leaking the plaintext token in summary or hash", async () => {
    const fake = fakeBunny();
    const createPlan = await planBunnyOriginHeader(fake.client, {
      pullZoneId: 101,
      token: TOKEN_1,
    });
    expect(createPlan.action).toBe("create");
    expect(createPlan.headerName).toBe(BUNNY_ORIGIN_AUTH_HEADER);
    expect(createPlan.summary).not.toContain(TOKEN_1);
    expect(createPlan.hash).toMatch(/^[0-9a-f]{64}$/);

    // Applying with wrong hash is refused and touches nothing.
    await expect(
      applyBunnyOriginHeader(fake.client, createPlan, {
        token: TOKEN_1,
        approvedHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(fake.upserts).toEqual([]);

    // Applying with a different token than planned is refused even with the old hash.
    await expect(
      applyBunnyOriginHeader(fake.client, createPlan, {
        token: TOKEN_2,
        approvedHash: createPlan.hash,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(fake.upserts).toEqual([]);

    // Applying with matching hash creates the rule.
    await expect(
      applyBunnyOriginHeader(fake.client, createPlan, {
        token: TOKEN_1,
        approvedHash: createPlan.hash,
      }),
    ).resolves.toEqual({ applied: true });
    expect(fake.upserts).toHaveLength(1);

    // Re-planning with the same token is a noop.
    const noopPlan = await planBunnyOriginHeader(fake.client, {
      pullZoneId: 101,
      token: TOKEN_1,
    });
    expect(noopPlan.action).toBe("noop");
    expect(noopPlan.existingGuid).toBe("guid-created-1");
    await expect(
      applyBunnyOriginHeader(fake.client, noopPlan, {
        token: TOKEN_1,
        approvedHash: noopPlan.hash,
      }),
    ).resolves.toEqual({ applied: false });
    expect(fake.upserts).toHaveLength(1);

    // Planning a rotation to TOKEN_2 updates the existing GUID in place.
    const rotatePlan = await planBunnyOriginHeader(fake.client, {
      pullZoneId: 101,
      token: TOKEN_2,
    });
    expect(rotatePlan.action).toBe("update");
    expect(rotatePlan.existingGuid).toBe("guid-created-1");
    expect(rotatePlan.summary).not.toContain(TOKEN_2);
    expect(rotatePlan.hash).not.toBe(createPlan.hash);

    await expect(
      applyBunnyOriginHeader(fake.client, rotatePlan, {
        token: TOKEN_2,
        approvedHash: rotatePlan.hash,
      }),
    ).resolves.toEqual({ applied: true });
    expect(fake.upserts[1]).toEqual({
      pullZoneId: 101,
      guid: "guid-created-1",
      headerName: BUNNY_ORIGIN_AUTH_HEADER,
      token: TOKEN_2,
    });
  });

  it("refuses tokens that are not 64 lower-case hex characters", async () => {
    const fake = fakeBunny();
    await expect(
      planBunnyOriginHeader(fake.client, { pullZoneId: 101, token: "too-short" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
