import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalRequest, FetchLike, RemoteExec } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { OPENLITESPEED_COMMAND } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import {
  ensureEdgeOriginToken,
  readEdgeOriginToken,
  setupThirdPartyEdge,
  syncEdgeOriginHeader,
  writeEdgeOriginToken,
} from "../provision/edge-origin-token";
import { ensureStatePassphrase, recordServerAddress } from "../shared";
import { ensureDeployKey } from "../shared/ssh-keys";
import {
  createTestPhaseDeps,
  FakeEngine,
  ScriptedApprovalHandler,
  writeFakeState,
} from "../testing";
import { nextEdgeOriginTokenFile, rotateEdgeOriginToken } from "./edge-origin-token";

const tempDirs: string[] = [];
const API_KEY = fakeSecret("generic-password", "bunny-rotate-key");

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeDeps(approve: boolean, env: Record<string, string> = {}): Promise<PhaseDeps> {
  const root = await mkdtemp(join(tmpdir(), "opscrew-edge-rotate-"));
  tempDirs.push(root);
  const deps = await createTestPhaseDeps({
    root,
    approvalHandler: new ScriptedApprovalHandler(() => approve),
    env: { BUNNYNET_API_KEY: API_KEY, ...env },
  });
  await recordServerAddress(deps.paths, { ipv4: "203.0.113.10" });
  await ensureDeployKey(deps.paths, deps.redactor);
  return deps;
}

function bunnyPlan(
  dnsProvider: "bunny" | "cloudflare" = "bunny",
  edge: "caddy" | "nginx" | "openlitespeed" = "caddy",
) {
  return DeployPlanSchema.parse({
    schemaVersion: 1,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    app: { name: "shop", port: 3000, healthPath: "/health", env: [] },
    target: {
      provider: "hetzner",
      mode: "vps-compose",
      location: "fsn1",
      serverType: "cx23",
      backups: true,
      edge,
    },
    dns: {
      provider: dnsProvider,
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
      www: false,
    },
    cicd: { provider: "github-actions", registry: "ghcr", branch: "main" },
    security: { httpAllowedFrom: "edge", wafCustomRules: true },
    services: [],
    externalServices: [],
    codeChanges: [],
    cost: {
      monthly: { amount: 4.5, currency: "EUR" },
      breakdown: [{ item: "Hetzner cx23", monthly: { amount: 4.5, currency: "EUR" } }],
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-26T00:00:00.000Z",
    },
  });
}

function fakeBunnyApi(opts: { initialToken?: string; failUpsertOnce?: boolean } = {}) {
  const events: string[] = [];
  let currentToken = opts.initialToken;
  let shouldFailUpsert = opts.failUpsertOnce === true;

  const fetch: FetchLike = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/dnszone")) {
      return new Response(JSON.stringify({ Items: [{ Id: 777, Domain: "example.com" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.includes("/edgerules/addOrUpdate") && init?.method === "POST") {
      if (shouldFailUpsert) {
        shouldFailUpsert = false;
        events.push("edge:failed");
        return new Response("temporary Bunny error", { status: 503 });
      }
      const body = JSON.parse(String(init.body)) as { ActionParameter2: string };
      currentToken = body.ActionParameter2;
      events.push(`edge:set:${currentToken.slice(0, 6)}`);
      return new Response(null, { status: 201 });
    }
    if (href.includes("/pullzone/")) {
      return new Response(
        JSON.stringify({
          Id: 55,
          Name: "opscrew-shop",
          EdgeRules:
            currentToken === undefined
              ? []
              : [
                  {
                    Guid: "guid-1",
                    ActionType: 6,
                    ActionParameter1: "X-OpsCrew-Origin-Token",
                    ActionParameter2: currentToken,
                    Description: "OpsCrew origin verification header",
                    Enabled: true,
                    Triggers: [{ Type: 0, PatternMatches: ["*"], Parameter1: "" }],
                  },
                ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as unknown as FetchLike;

  return { events, fetch, getCurrentToken: () => currentToken };
}

function fakeRemote(events: string[], snippets: string[]): (host: string) => RemoteExec {
  return (host) => ({
    host,
    async run(command, options) {
      const stdin = options?.input ?? "";
      snippets.push(stdin);
      const isDual = stdin.includes("|");
      events.push(isDual ? "server:dual-accept" : "server:narrow");
      expect(command).toContain("/srv/edge/tls/shop/origin-token.caddy");
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
}

describe("third-party edge setup and zero-downtime edge-origin-token rotation (036 PR 2)", () => {
  it("B1: verifies BUNNYNET_API_KEY, redacts it, looks up dnsZoneId, and syncs origin header via registry", async () => {
    const deps = await makeDeps(true);
    const plan = bunnyPlan("bunny");
    const bunny = fakeBunnyApi();

    const setup = await setupThirdPartyEdge(deps, plan, { edgeFetch: bunny.fetch });
    expect(setup).toEqual({
      id: "bunny",
      envVar: "BUNNYNET_API_KEY",
      apiKey: API_KEY,
      dnsZoneId: 777,
    });
    expect(deps.redactor.redact(`key=${API_KEY}`)).not.toContain(API_KEY);

    const token = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
    const synced = await syncEdgeOriginHeader(deps, plan, {
      resourceId: "55",
      token: token.current,
      apiKey: API_KEY,
      command: "opscrew provision",
      fetch: bunny.fetch,
    });
    expect(synced.applied).toBe(true);
    expect(bunny.getCurrentToken()).toBe("11".repeat(32));
  });

  it("rotates in order: approve -> server dual-accept -> edge switch -> server narrow, dropping previous", async () => {
    const deps = await makeDeps(true);
    const plan = bunnyPlan("bunny");
    const initial = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
    const bunny = fakeBunnyApi({ initialToken: initial.current });
    const snippets: string[] = [];

    const result = await rotateEdgeOriginToken(deps, plan, {
      resourceId: "55",
      fetch: bunny.fetch,
      remote: fakeRemote(bunny.events, snippets),
      randomBytes: () => Buffer.alloc(32, 0x22),
    });

    const next = "22".repeat(32);
    expect(result.rotated).toBe(true);
    expect(result.proxy).toBe("caddy");
    expect(result.serverPath).toBe("/srv/edge/tls/shop/origin-token.caddy");
    expect(bunny.events).toEqual(["server:dual-accept", "edge:set:222222", "server:narrow"]);
    expect(snippets[0]).toContain(`${next}|${initial.current}`);
    expect(snippets[1]).toContain(`^(${next})$`);
    expect(snippets[1]).not.toContain(initial.current);
    expect(await readEdgeOriginToken(deps)).toEqual({ current: next });
    expect(deps.redactor.redact(`t=${next} old=${initial.current}`)).not.toContain(next);
    expect(deps.redactor.redact(`t=${next} old=${initial.current}`)).not.toContain(initial.current);
  });

  it("B4: a refused rotation changes nothing locally, on the server, or on Bunny", async () => {
    const deps = await makeDeps(false);
    const plan = bunnyPlan("bunny");
    const initial = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
    const bunny = fakeBunnyApi({ initialToken: initial.current });
    const snippets: string[] = [];

    await expect(
      rotateEdgeOriginToken(deps, plan, {
        resourceId: "55",
        fetch: bunny.fetch,
        remote: fakeRemote(bunny.events, snippets),
        randomBytes: () => Buffer.alloc(32, 0x22),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });

    expect(bunny.events).toEqual([]);
    expect(snippets).toEqual([]);
    expect(bunny.getCurrentToken()).toBe(initial.current);
    expect(await readEdgeOriginToken(deps)).toEqual({ current: initial.current });
  });

  it("B4: a failed mid-rotation preserves {current, previous} and rerunning resumes with that exact pair", async () => {
    const deps = await makeDeps(true);
    const plan = bunnyPlan("bunny");
    const oldToken = "11".repeat(32);
    const nextToken = "22".repeat(32);
    await writeEdgeOriginToken(deps, { current: oldToken });
    const bunny = fakeBunnyApi({ initialToken: oldToken, failUpsertOnce: true });
    const snippets: string[] = [];

    // First run fails at the Bunny API call AFTER server dual-accept was installed.
    await expect(
      rotateEdgeOriginToken(deps, plan, {
        resourceId: "55",
        fetch: bunny.fetch,
        remote: fakeRemote(bunny.events, snippets),
        randomBytes: () => Buffer.alloc(32, 0x22),
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

    // Local state keeps BOTH nextToken and oldToken so oldToken is never dropped.
    expect(await readEdgeOriginToken(deps)).toEqual({ current: nextToken, previous: oldToken });

    // Second run with DIFFERENT randomBytes (0x33) MUST resume with (nextToken, oldToken), NOT 0x33!
    const resumed = await rotateEdgeOriginToken(deps, plan, {
      resourceId: "55",
      fetch: bunny.fetch,
      remote: fakeRemote(bunny.events, snippets),
      randomBytes: () => Buffer.alloc(32, 0x33),
    });

    expect(resumed.rotated).toBe(true);
    expect(bunny.getCurrentToken()).toBe(nextToken);
    expect(snippets[1]).toContain(`${nextToken}|${oldToken}`);
    expect(snippets[2]).toContain(`^(${nextToken})$`);
    expect(await readEdgeOriginToken(deps)).toEqual({ current: nextToken });
  });

  it("refuses plans that do not use a shared-header edge provider", async () => {
    const deps = await makeDeps(true);
    await expect(
      rotateEdgeOriginToken(deps, bunnyPlan("cloudflare"), {
        resourceId: "55",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("stages pending next token so non-interactive refuse -> --approve <hash> rerun succeeds with the same hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "opscrew-edge-rotate-approve-"));
    tempDirs.push(root);
    let approvedHash: string | undefined;
    const seenHashes: string[] = [];
    const handler = new ScriptedApprovalHandler((req: ApprovalRequest) => {
      if (req.planHash !== undefined) seenHashes.push(req.planHash);
      return approvedHash !== undefined && req.planHash === approvedHash;
    });
    const deps = await createTestPhaseDeps({
      root,
      approvalHandler: handler,
      env: { BUNNYNET_API_KEY: API_KEY },
    });
    await recordServerAddress(deps.paths, { ipv4: "203.0.113.10" });
    await ensureDeployKey(deps.paths, deps.redactor);

    const plan = bunnyPlan("bunny");
    const initial = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
    const bunny = fakeBunnyApi({ initialToken: initial.current });
    const snippets: string[] = [];

    // First run (non-interactive): refuses approval, leaves generated_values.json untouched,
    // and stages the pending next token in .edge-origin-token.next.
    await expect(
      rotateEdgeOriginToken(deps, plan, {
        resourceId: "55",
        fetch: bunny.fetch,
        remote: fakeRemote(bunny.events, snippets),
        randomBytes: () => Buffer.alloc(32, 0x22),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_REFUSED" });

    expect(seenHashes).toHaveLength(1);
    expect(await readEdgeOriginToken(deps)).toEqual({ current: initial.current });
    expect(existsSync(nextEdgeOriginTokenFile(deps))).toBe(true);

    // Second run with --approve <hash> and DIFFERENT randomBytes (0x33): MUST reuse staged 0x22,
    // produce the exact same hash, succeed, and delete .edge-origin-token.next on finish.
    approvedHash = seenHashes[0];
    const result = await rotateEdgeOriginToken(deps, plan, {
      resourceId: "55",
      fetch: bunny.fetch,
      remote: fakeRemote(bunny.events, snippets),
      randomBytes: () => Buffer.alloc(32, 0x33),
    });

    const expectedNext = "22".repeat(32);
    expect(result.rotated).toBe(true);
    expect(result.edgePlanHash).toBe(approvedHash);
    expect(bunny.getCurrentToken()).toBe(expectedNext);
    expect(await readEdgeOriginToken(deps)).toEqual({ current: expectedNext });
    expect(existsSync(nextEdgeOriginTokenFile(deps))).toBe(false);
  });

  it.each([
    [
      "caddy",
      "/srv/edge/tls/shop/origin-token.caddy",
      "docker compose -p opscrew-edge -f /srv/edge/compose.yaml exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile < /dev/null",
    ],
    [
      "nginx",
      "/srv/edge/tls/shop/origin-token.conf",
      "docker compose -p opscrew-edge -f /srv/edge/compose.yaml exec -T nginx sh -c 'nginx -t -q && nginx -s reload' < /dev/null",
    ],
    [
      "openlitespeed",
      "/srv/edge/tls/shop/origin-token.conf",
      `docker compose -p opscrew-edge -f /srv/edge/compose.yaml exec -T openlitespeed ${OPENLITESPEED_COMMAND.reload} < /dev/null`,
    ],
  ] as const)(
    "takes /srv/edge/.lock (flock 9) and runs the exact reload command for %s",
    async (proxy, expectedPath, expectedReload) => {
      const deps = await makeDeps(true);
      const plan = bunnyPlan("bunny", proxy);
      const initial = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
      const bunny = fakeBunnyApi({ initialToken: initial.current });
      const commands: string[] = [];

      const result = await rotateEdgeOriginToken(deps, plan, {
        resourceId: "55",
        fetch: bunny.fetch,
        remote: (host) => ({
          host,
          async run(command) {
            commands.push(command);
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        }),
        randomBytes: () => Buffer.alloc(32, 0x22),
      });

      expect(result.proxy).toBe(proxy);
      expect(result.serverPath).toBe(expectedPath);
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command).toContain("flock 9");
        expect(command).toContain("9> '/srv/edge/.lock'");
        expect(command).toContain(expectedPath);
        expect(command).toContain(expectedReload);
        expect(command).not.toContain("[object Object]");
      }
    },
  );

  it("reads bunny_pullzone_id via infrastructureOutputs through projectEngine (preserving PATH and TF_ENCRYPTION)", async () => {
    const deps = await makeDeps(true, { PATH: process.env.PATH ?? "/usr/bin" });
    const plan = bunnyPlan("bunny");
    await writeFakeState(deps.paths);
    await ensureStatePassphrase(deps.paths);
    let outputEnv: Record<string, string | undefined> | undefined;
    const engine = new FakeEngine({ outputs: { bunny_pullzone_id: "55" } });
    engine.output = async (_dir?: string, opts?: { env?: Record<string, string | undefined> }) => {
      engine.calls.push("output");
      outputEnv = opts?.env;
      return engine.outputs;
    };
    const initial = await ensureEdgeOriginToken(deps, () => Buffer.alloc(32, 0x11));
    const bunny = fakeBunnyApi({ initialToken: initial.current });
    const snippets: string[] = [];

    const result = await rotateEdgeOriginToken(deps, plan, {
      fetch: bunny.fetch,
      remote: fakeRemote(bunny.events, snippets),
      services: { engine: async () => engine },
      randomBytes: () => Buffer.alloc(32, 0x22),
    });

    expect(result.rotated).toBe(true);
    expect(engine.calls).toContain("output");
    // projectEngine populates PATH and TF_ENCRYPTION (not bypassed by a minimal engineEnv).
    expect(outputEnv?.PATH).toBeTruthy();
    expect(outputEnv?.TF_ENCRYPTION).toContain("pbkdf2");
    expect(bunny.getCurrentToken()).toBe("22".repeat(32));
  });
});
