import { randomBytes } from "node:crypto";
import type { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { fakeClock } from "./__fixtures__/fake-portainer";
import {
  world as baseWorld,
  CONNECTOR_COMPOSE,
  desired,
  fingerprintsFor,
  secrets,
} from "./__fixtures__/scenario";
import { type ApplyStackOptions, applyStackPlan } from "./apply";
import type { PortainerClient } from "./client";
import type { PortainerFacts } from "./facts";
import {
  type DesiredNextStacks,
  planNextStacks,
  planStacks,
  type StackPlan,
  stackPlanHash,
} from "./index";
import { valueFingerprints } from "./values";

/**
 * The seam the move to another Cloudflare account calls (agents' `NextStacksApi`, T2815): this
 * package's `planNextStacks` and `applyStackPlan` must fit it as they are.
 */
interface NextStacksApi {
  plan: (
    facts: PortainerFacts,
    input: {
      app: string;
      environmentId: number;
      stacks: readonly { name: string; compose: string }[] | "remove";
      fingerprints: Readonly<Record<string, Readonly<Record<string, string>>>>;
    },
  ) => StackPlan;
  apply: (
    client: PortainerClient,
    plan: StackPlan,
    options: {
      approvedHash: string;
      secrets: {
        env: Readonly<Record<string, string>>;
        nextTunnelTokens: Readonly<Record<string, string>>;
      };
      valueKey: Uint8Array;
      wait?: ApplyStackOptions["wait"];
    },
  ) => Promise<{ applied: readonly string[] }>;
}
const api: NextStacksApi = { plan: planNextStacks, apply: applyStackPlan };

const KEY = randomBytes(32);
const world = () => baseWorld({}, KEY);
type World = ReturnType<typeof world>;

const TUNNEL = "opscrew-shop-tunnel-next";
const CONNECTOR = "opscrew-shop-portainer-tunnel-next";

/** A connector stack as `renderNextConnectorStacks` renders it: only `${TUNNEL_TOKEN}`. */
function composeOf(name: string): string {
  return [
    `name: ${name}`,
    "services:",
    "  cloudflared:",
    "    image: cloudflare/cloudflared@sha256:3333",
    "    command: tunnel --no-autoupdate run",
    "    environment:",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation under test.
    "      TUNNEL_TOKEN: ${TUNNEL_TOKEN}",
    "",
  ].join("\n");
}

/** The new account's tunnel tokens, by stack name (synthetic, made at runtime). */
function nextTokens(seed = "a"): Record<string, string> {
  return {
    [TUNNEL]: fakeSecret("cloudflare-token", `next-tunnel-${seed}`),
    [CONNECTOR]: fakeSecret("cloudflare-token", `next-portainer-${seed}`),
  };
}

/** Both beside stacks with the fingerprints of `tokens`, as the move gives them. */
function running(tokens: Record<string, string>): DesiredNextStacks {
  return {
    app: "shop",
    environmentId: 3,
    stacks: [TUNNEL, CONNECTOR].map((name) => ({ name, compose: composeOf(name) })),
    fingerprints: Object.fromEntries(
      Object.entries(tokens).map(([name, token]) => [
        name,
        valueFingerprints(KEY, { TUNNEL_TOKEN: token }),
      ]),
    ),
  };
}

const REMOVE: DesiredNextStacks = {
  app: "shop",
  environmentId: 3,
  stacks: "remove",
  fingerprints: {},
};

function applyNext(w: World, plan: StackPlan, tokens: Record<string, string>) {
  const clock = fakeClock();
  return api.apply(w.client(), plan, {
    approvedHash: stackPlanHash(plan),
    secrets: { env: {}, nextTunnelTokens: tokens },
    valueKey: KEY,
    wait: { now: clock.now, sleep: clock.sleep },
  });
}

function mutating(w: World, from: number) {
  return w.fake.calls.slice(from).filter((call) => call.method !== "GET");
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: unknown) => error as OpsCrewError,
  );

const refusal = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error as OpsCrewError;
  }
  throw new Error("expected a refusal");
};

/** The app `shop` set up in Cloudflare redeploy mode: its Git stack and its connector stack. */
async function appSetUp(w: World) {
  const s = secrets();
  const plan = planStacks(
    await w.inspect(),
    desired({
      valueFingerprints: fingerprintsFor(KEY, s),
      redeploy: "cloudflare",
      updater: undefined,
      tunnelConnector: { compose: CONNECTOR_COMPOSE },
    }),
  );
  const clock = fakeClock();
  const result = await applyStackPlan(w.client(), plan, {
    approvedHash: stackPlanHash(plan),
    secrets: s,
    valueKey: KEY,
    wait: { now: clock.now, sleep: clock.sleep },
  });
  return { s, result };
}

describe("planNextStacks and applyStackPlan: the beside stacks", () => {
  it("creates both stacks with their tokens, in a plan bound to them that holds none", async () => {
    const w = world();
    const decoyBefore = structuredClone(w.decoy);
    const tokens = nextTokens();
    const plan = api.plan(await w.inspect(), running(tokens));
    expect(plan.purpose).toBe("setup");
    expect(plan.changes.map((change) => [change.id, change.state, change.params.action])).toEqual([
      ["tunnel-next-stack", "change", "create"],
      ["tunnel-connector-next-stack", "change", "create"],
    ]);
    expect(plan.changes.map((change) => change.params.envKeys)).toEqual([
      ["TUNNEL_TOKEN"],
      ["TUNNEL_TOKEN"],
    ]);
    expect(plan.record).toEqual({ stacks: [], volumes: [] });
    expect(plan.findings).toEqual([]);
    expect(plan.valuesDigest).toMatch(/^[0-9a-f]{64}$/);

    const start = w.fake.calls.length;
    const result = await applyNext(w, plan, tokens);
    const calls = mutating(w, start);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/stacks/create/standalone/string",
      "POST /api/stacks/create/standalone/string",
    ]);
    expect(calls.map((call) => call.body)).toEqual([
      {
        Name: TUNNEL,
        StackFileContent: composeOf(TUNNEL),
        Env: [{ name: "TUNNEL_TOKEN", value: tokens[TUNNEL] }],
        FromAppTemplate: false,
      },
      {
        Name: CONNECTOR,
        StackFileContent: composeOf(CONNECTOR),
        Env: [{ name: "TUNNEL_TOKEN", value: tokens[CONNECTOR] }],
        FromAppTemplate: false,
      },
    ]);
    expect(result).toEqual({
      applied: ["tunnel-next-stack", "tunnel-connector-next-stack"],
      record: { stacks: [], volumes: [] },
    });
    for (const name of [TUNNEL, CONNECTOR]) {
      expect(w.fake.state.stacks.find((stack) => stack.Name === name)?.Status).toBe(1);
    }
    expect(w.fake.state.stacks.find((stack) => stack.Id === w.decoy.Id)).toEqual(decoyBefore);

    // No token in the plan, its hash, the result or any call but the one creating its stack.
    for (const token of Object.values(tokens)) {
      expect(JSON.stringify(plan)).not.toContain(token);
      expect(stackPlanHash(plan)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain(token);
      const carrying = w.fake.calls.filter((call) =>
        JSON.stringify({ ...call, query: String(call.query) }).includes(token),
      );
      expect(carrying).toHaveLength(1);
      expect(String(carrying[0]?.path)).toBe("/api/stacks/create/standalone/string");
    }
  });

  it("shows nothing to do when run again, and applying that plan changes nothing", async () => {
    const w = world();
    const tokens = nextTokens();
    await applyNext(w, api.plan(await w.inspect(), running(tokens)), tokens);
    const facts = await w.inspect();
    expect(facts.stacks.map((stack) => stack.name).sort()).toEqual([CONNECTOR, TUNNEL]);
    const again = api.plan(facts, running(tokens));
    expect(again.changes.map((change) => change.state)).toEqual(["in-place", "in-place"]);
    expect(again.valuesDigest).toBeUndefined();
    const start = w.fake.calls.length;
    expect(await applyNext(w, again, tokens)).toEqual({
      applied: [],
      record: { stacks: [], volumes: [] },
    });
    expect(mutating(w, start)).toEqual([]);
  });

  it("updates only the stack whose token changed, sending the new token only to it", async () => {
    const w = world();
    const tokens = nextTokens();
    await applyNext(w, api.plan(await w.inspect(), running(tokens)), tokens);
    const changed = { ...tokens, [TUNNEL]: fakeSecret("cloudflare-token", "next-tunnel-b") };
    const plan = api.plan(await w.inspect(), running(changed));
    expect(plan.changes.map((change) => [change.state, change.params.action])).toEqual([
      ["change", "update"],
      ["in-place", "keep"],
    ]);
    expect(plan.changes[0]?.params.changedValues).toEqual(["TUNNEL_TOKEN"]);
    expect(plan.changes[0]?.title).toMatch(/the value of TUNNEL_TOKEN/);

    // The token the plan was not made with is refused before any call.
    let start = w.fake.calls.length;
    const error = await failure(applyNext(w, plan, tokens));
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(w.fake.calls.length).toBe(start);

    start = w.fake.calls.length;
    const result = await applyNext(w, plan, changed);
    expect(result.applied).toEqual(["tunnel-next-stack"]);
    const calls = mutating(w, start);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      Env: [{ name: "TUNNEL_TOKEN", value: changed[TUNNEL] }],
    });
    expect(JSON.stringify(calls)).not.toContain(tokens[CONNECTOR]);
  });

  it("removes the beside stacks only, then has nothing left to remove", async () => {
    const w = world();
    const tokens = nextTokens();
    await applyNext(w, api.plan(await w.inspect(), running(tokens)), tokens);
    const ids = [TUNNEL, CONNECTOR].map(
      (name) => w.fake.state.stacks.find((stack) => stack.Name === name)?.Id,
    );
    const plan = api.plan(await w.inspect(), REMOVE);
    expect(plan.purpose).toBe("teardown");
    expect(plan.valuesDigest).toBeUndefined();
    expect(plan.changes.map((change) => [change.id, change.state, change.params])).toEqual([
      ["tunnel-next-stack", "change", { action: "remove", name: TUNNEL, stackId: ids[0] }],
      [
        "tunnel-connector-next-stack",
        "change",
        { action: "remove", name: CONNECTOR, stackId: ids[1] },
      ],
    ]);
    const start = w.fake.calls.length;
    const result = await applyNext(w, plan, {});
    expect(result.applied).toEqual(["tunnel-next-stack", "tunnel-connector-next-stack"]);
    expect(mutating(w, start).map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /api/stacks/${ids[0]}`,
      `DELETE /api/stacks/${ids[1]}`,
    ]);
    expect(w.fake.state.stacks.map((stack) => stack.Name)).toEqual(["jellyfin"]);

    const again = api.plan(await w.inspect(), REMOVE);
    expect(again.changes.map((change) => [change.state, change.params.action])).toEqual([
      ["in-place", "absent"],
      ["in-place", "absent"],
    ]);
    const before = w.fake.calls.length;
    expect((await applyNext(w, again, {})).applied).toEqual([]);
    expect(mutating(w, before)).toEqual([]);
  });

  it("leaves the app's own stacks, roles and record as they are", async () => {
    const w = world();
    const { s, result } = await appSetUp(w);
    const own = () =>
      structuredClone(w.fake.state.stacks.filter((stack) => !stack.Name.endsWith("-next")));
    const before = own();
    expect(before.map((stack) => stack.Name).sort()).toEqual([
      "jellyfin",
      "opscrew-shop",
      "opscrew-shop-portainer-tunnel",
    ]);
    const tokens = nextTokens();
    const created = api.plan(await w.inspect(), running(tokens));
    expect(created.changes.every((change) => change.id.endsWith("-next-stack"))).toBe(true);
    await applyNext(w, created, tokens);
    expect(own()).toEqual(before);

    // With the beside stacks running, the app's own plan is unchanged: all in place.
    const appPlan = planStacks(
      await w.inspect(),
      desired({
        valueFingerprints: fingerprintsFor(KEY, s),
        redeploy: "cloudflare",
        updater: undefined,
        tunnelConnector: { compose: CONNECTOR_COMPOSE },
        record: result.record,
      }),
    );
    expect(appPlan.findings).toEqual([]);
    expect(appPlan.changes.map((change) => [change.id, change.state])).toEqual([
      ["registry", "in-place"],
      ["app-stack", "in-place"],
      ["tunnel-connector-stack", "in-place"],
    ]);
    expect(appPlan.record).toEqual(result.record);

    await applyNext(w, api.plan(await w.inspect(), REMOVE), {});
    expect(own()).toEqual(before);
  });

  it("inspects the beside stacks of the app asked for, not another app's", async () => {
    const w = world();
    const client = w.client();
    for (const name of [TUNNEL, "opscrew-blog-tunnel-next"]) {
      await client.createStringStack(3, { name, compose: composeOf(name), env: [] });
    }
    w.fake.settle();
    const facts = await w.inspect();
    expect(facts.stacks.map((stack) => stack.name)).toEqual([TUNNEL]);
    expect(facts.stacks[0]?.envKeys).toEqual([]);
  });
});

describe("planNextStacks and applyStackPlan: the safety gate", () => {
  it("plans only the app's beside stacks, each with only its TUNNEL_TOKEN, bound to it", async () => {
    const w = world();
    const facts = await w.inspect();
    const tokens = nextTokens();
    const base = running(tokens);
    const cases: Array<[string, DesiredNextStacks, RegExp]> = [
      [
        "another stack",
        { ...base, stacks: [{ name: "opscrew-shop", compose: composeOf("x") }] },
        /must be one of opscrew-shop-tunnel-next and opscrew-shop-portainer-tunnel-next/,
      ],
      [
        "another app's",
        {
          ...base,
          stacks: [{ name: "opscrew-blog-tunnel-next", compose: composeOf("x") }],
          fingerprints: { "opscrew-blog-tunnel-next": base.fingerprints[TUNNEL] ?? {} },
        },
        /must be one of/,
      ],
      [
        "twice",
        {
          ...base,
          stacks: [
            { name: TUNNEL, compose: composeOf(TUNNEL) },
            { name: TUNNEL, compose: composeOf(TUNNEL) },
          ],
        },
        /once/,
      ],
      [
        "another variable",
        {
          ...base,
          stacks: [{ name: TUNNEL, compose: `${composeOf(TUNNEL)}      OTHER: \${OTHER}\n` }],
        },
        /TUNNEL_TOKEN/,
      ],
      ["no fingerprint", { ...base, fingerprints: {} }, /fingerprint of its TUNNEL_TOKEN/],
    ];
    for (const [label, input, message] of cases) {
      const error = refusal(() => planNextStacks(facts, input));
      expect(error.code, label).toBe("INVALID_INPUT");
      expect(error.message, label).toMatch(message);
      for (const token of Object.values(tokens)) expect(error.message, label).not.toContain(token);
    }
    expect(refusal(() => planNextStacks(facts, { ...base, environmentId: 9 })).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("refuses another hash, a missing token or a stack not the app's before any call", async () => {
    const w = world();
    const tokens = nextTokens();
    const plan = api.plan(await w.inspect(), running(tokens));
    const start = w.fake.calls.length;

    const wrongHash = await failure(
      api.apply(w.client(), plan, {
        approvedHash: "0".repeat(64),
        secrets: { env: {}, nextTunnelTokens: tokens },
        valueKey: KEY,
      }),
    );
    expect(wrongHash.code).toBe("PLAN_HASH_MISMATCH");

    const missing = await failure(applyNext(w, plan, { [TUNNEL]: tokens[TUNNEL] as string }));
    expect(missing.code).toBe("INVALID_INPUT");
    expect(missing.message).toMatch(/tunnel token for opscrew-shop-portainer-tunnel-next/);

    // A plan that names the app's own stack in a beside change, even approved, is refused.
    const removal = api.plan(await w.inspect(), REMOVE);
    const tampered: StackPlan = {
      ...removal,
      changes: [
        {
          id: "tunnel-next-stack",
          title: "Remove the stack opscrew-shop",
          state: "change",
          params: { action: "remove", name: "opscrew-shop", stackId: w.decoy.Id },
        },
      ],
    };
    const notOurs = await failure(applyNext(w, tampered, {}));
    expect(notOurs.code).toBe("INVALID_INPUT");
    expect(notOurs.message).toMatch(/does not list \(tunnel-next-stack\)/);

    expect(mutating(w, start)).toEqual([]);
  });
});
