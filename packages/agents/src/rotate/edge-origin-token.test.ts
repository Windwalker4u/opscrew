import {
  BUNNY_ACTION_SET_REQUEST_HEADER,
  type BunnyEdgeRule,
  OPSCREW_ORIGIN_HEADER_DESCRIPTION,
} from "@opscrew/edge-provider-bunny";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  ensureEdgeOriginToken,
  readEdgeOriginToken,
  syncBunnyOriginHeader,
} from "../provision/edge-origin-token";
import { createTestPhaseDeps, ScriptedApprovalHandler, testPlan } from "../testing";
import { rotateEdgeOriginToken } from "./edge-origin-token";
import { credentialInventory } from "./inventory";

function bunnyPlan(edge: "caddy" | "nginx" | "openlitespeed" = "caddy") {
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, edge },
    dns: {
      provider: "bunny",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
      www: false,
    },
    security: { ...base.security, httpAllowedFrom: "edge" },
  });
}

function fakeBunnyEdge(initial: BunnyEdgeRule[] = []) {
  let rules = [...initial];
  const calls: string[] = [];
  const upsertedTokens: string[] = [];
  return {
    calls,
    upsertedTokens,
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
        calls.push("bunny:upsert");
        upsertedTokens.push(input.token);
        rules = [
          {
            Guid: input.guid ?? "bunny-rule-1",
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

describe("Bunny.net shared-header token provisioning and zero-downtime rotation (036 PR 2)", () => {
  it("generates and persists edge-origin-token once, syncs Bunny with plan-hash approval, and lists it in credentialInventory", async () => {
    const handler = new ScriptedApprovalHandler(() => true);
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    const plan = bunnyPlan("caddy");
    const bunny = fakeBunnyEdge();

    const first = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
    expect(first.current).toBe("11".repeat(32));
    // Subsequent call reuses the kept token.
    const second = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x22));
    expect(second).toEqual(first);

    // Syncing Bunny asks for plan-hash approval without leaking the plaintext token.
    const synced = await syncBunnyOriginHeader(deps, plan, {
      pullZoneId: 77,
      token: first.current,
      client: bunny.client,
      command: "opscrew provision",
    });
    expect(synced.applied).toBe(true);
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]?.details).not.toContain(first.current);
    expect(bunny.upsertedTokens).toEqual([first.current]);

    // Inventory lists `edge-origin-token` as seamless.
    const items = await credentialInventory(deps, plan);
    expect(items.find((c) => c.name === "edge-origin-token")).toMatchObject({
      name: "edge-origin-token",
      kind: "edge-origin-token",
      rotation: { mode: "seamless" },
    });
  });

  it("rotates with zero downtime: server dual-accept -> approved Bunny switch -> server narrow", async () => {
    const handler = new ScriptedApprovalHandler(() => true);
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    const plan = bunnyPlan("nginx");
    const initial = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0xaa));
    const bunny = fakeBunnyEdge([
      {
        Guid: "existing-guid",
        ActionType: BUNNY_ACTION_SET_REQUEST_HEADER,
        ActionParameter1: "X-OpsCrew-Origin-Token",
        ActionParameter2: initial.current,
        Description: OPSCREW_ORIGIN_HEADER_DESCRIPTION,
        Enabled: true,
        Triggers: [{ Type: 0, PatternMatches: ["*"], Parameter1: "" }],
      },
    ]);

    const timeline: string[] = [];
    const snippets: { phase: string; content: string }[] = [];
    const secrets: { name: string; value: string }[] = [];

    const result = await rotateEdgeOriginToken(deps, plan, {
      pullZoneId: 77,
      bunny: {
        listEdgeRules: bunny.client.listEdgeRules,
        upsertOriginHeaderRule: async (input) => {
          timeline.push("edge:switch");
          await bunny.client.upsertOriginHeaderRule(input);
        },
      },
      installServerSnippet: async ({ phase, content }) => {
        timeline.push(`server:${phase}`);
        snippets.push({ phase, content });
      },
      setDeploySecret: async (name, value) => {
        secrets.push({ name, value });
      },
      randomBytes: () => Buffer.alloc(32, 0xbb),
    });

    const next = "bb".repeat(32);
    expect(result.rotated).toBe(true);
    expect(result.proxy).toBe("nginx");
    expect(result.serverPath).toBe("/srv/edge/tls/shop/origin-token.conf");
    expect(timeline).toEqual(["server:dual-accept", "edge:switch", "server:narrow"]);

    // Dual-accept snippet accepts BOTH next and initial; narrow snippet accepts ONLY next.
    expect(snippets[0]?.content).toContain(`${next}|${initial.current}`);
    expect(snippets[1]?.content).toContain(next);
    expect(snippets[1]?.content).not.toContain(initial.current);

    // GitHub secret updated to dual-line then single-line.
    expect(secrets).toEqual([
      { name: "OPSCREW_EDGE_ORIGIN_TOKEN", value: `${next}\n${initial.current}` },
      { name: "OPSCREW_EDGE_ORIGIN_TOKEN", value: next },
    ]);

    // Approval prompt never leaked the plaintext secret.
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]?.details).not.toContain(next);
    expect(handler.requests[0]?.details).not.toContain(initial.current);

    // Generated values persisted with `next` only (dropped `previous`).
    expect(await readEdgeOriginToken(deps)).toEqual({ current: next });
  });

  it("refuses rotating on a Cloudflare plan that does not use shared-header auth", async () => {
    const deps = await createTestPhaseDeps();
    const bunny = fakeBunnyEdge();
    await expect(
      rotateEdgeOriginToken(deps, testPlan(), {
        pullZoneId: 77,
        bunny: bunny.client,
        installServerSnippet: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
