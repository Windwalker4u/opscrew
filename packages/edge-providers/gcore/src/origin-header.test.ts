import { describe, expect, it } from "vitest";
import { definition } from "./definition";
import { applyGcoreOriginHeader, planGcoreOriginHeader } from "./origin-header";

const HEADER_NAME = definition.capabilities.originAuthHeader ?? "";
const TOKEN_1 = "1".repeat(64);
const TOKEN_2 = "2".repeat(64);

function fakeGcore(initialHeaders: Record<string, string> = {}, enabled = false) {
  let headers = { ...initialHeaders };
  let isEnabled = enabled;
  const patches: { resourceId: number; headers: Readonly<Record<string, string>> }[] = [];
  return {
    patches,
    client: {
      async getCdnResource(resourceId: number) {
        return {
          id: resourceId,
          cname: "shop.example.com",
          options: {
            staticRequestHeaders: {
              enabled: isEnabled,
              value: { ...headers },
            },
          },
        };
      },
      async patchStaticRequestHeaders(input: {
        resourceId: number;
        headers: Readonly<Record<string, string>>;
      }) {
        patches.push(input);
        headers = { ...input.headers };
        isEnabled = true;
      },
    },
  };
}

describe("Gcore origin-verification header plan & hash-bound apply", () => {
  it("plans create, noop, and update while preserving unrelated headers and hiding secrets", async () => {
    const fake = fakeGcore({ "X-Custom": "keep-me" }, true);
    const createPlan = await planGcoreOriginHeader(fake.client, {
      resourceId: 505,
      headerName: HEADER_NAME,
      token: TOKEN_1,
    });
    expect(createPlan.action).toBe("create");
    expect(createPlan.headerName).toBe("X-OpsCrew-Origin-Token");
    expect(createPlan.resourceId).toBe("505");
    expect(createPlan.summary).not.toContain(TOKEN_1);
    expect(createPlan.hash).toMatch(/^[0-9a-f]{64}$/);

    // Mismatched hash refused.
    await expect(
      applyGcoreOriginHeader(fake.client, createPlan, {
        token: TOKEN_1,
        approvedHash: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });
    expect(fake.patches).toEqual([]);

    // Changed token after hashing refused.
    await expect(
      applyGcoreOriginHeader(fake.client, createPlan, {
        token: TOKEN_2,
        approvedHash: createPlan.hash,
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });

    // Approved apply sets OpsCrew header and preserves X-Custom.
    await expect(
      applyGcoreOriginHeader(fake.client, createPlan, {
        token: TOKEN_1,
        approvedHash: createPlan.hash,
      }),
    ).resolves.toEqual({ applied: true });
    expect(fake.patches[0]).toEqual({
      resourceId: 505,
      headers: {
        "X-Custom": "keep-me",
        [HEADER_NAME]: TOKEN_1,
      },
    });

    // Re-planning with same token is a noop.
    const noopPlan = await planGcoreOriginHeader(fake.client, {
      resourceId: 505,
      headerName: HEADER_NAME,
      token: TOKEN_1,
    });
    expect(noopPlan.action).toBe("noop");
    await expect(
      applyGcoreOriginHeader(fake.client, noopPlan, {
        token: TOKEN_1,
        approvedHash: noopPlan.hash,
      }),
    ).resolves.toEqual({ applied: false });

    // Rotation to TOKEN_2 updates in place and keeps X-Custom.
    const updatePlan = await planGcoreOriginHeader(fake.client, {
      resourceId: 505,
      headerName: HEADER_NAME,
      token: TOKEN_2,
    });
    expect(updatePlan.action).toBe("update");
    await expect(
      applyGcoreOriginHeader(fake.client, updatePlan, {
        token: TOKEN_2,
        approvedHash: updatePlan.hash,
      }),
    ).resolves.toEqual({ applied: true });
    expect(fake.patches[1]?.headers).toEqual({
      "X-Custom": "keep-me",
      [HEADER_NAME]: TOKEN_2,
    });
  });
});
