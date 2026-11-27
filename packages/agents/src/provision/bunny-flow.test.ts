import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_SECRETS } from "@opscrew/iac-templates";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy/run";
import {
  createProject,
  createTestPhaseDeps,
  deployedResources,
  FakeDestroyGitHub,
  FakeEngine,
  FakeGitHub,
  FakeServers,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
  writeFakeState,
} from "../testing";
import { noOtherApps } from "../testing/other-apps";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const HCLOUD = fakeSecret("hcloud-token");
const BUNNY_KEY = fakeSecret("generic-password", "bunny-flow-key");
const STRIPE = fakeSecret("stripe-live-key");

function bunnyPlan() {
  const base = testPlan({ domain: "shop.example.com" });
  return DeployPlanSchema.parse({
    ...base,
    dns: {
      provider: "bunny",
      domain: "shop.example.com",
      zone: "example.com",
      proxied: true,
      www: false,
    },
    security: {
      ...base.security,
      httpAllowedFrom: "edge",
      wafCustomRules: true,
    },
  });
}

function fakeBunnyApi() {
  let tokenOnBunny: string | undefined;
  let zoneLookups = 0;
  let headerUpserts = 0;
  const fetch: FetchLike = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.includes("/dnszone")) {
      zoneLookups++;
      return new Response(JSON.stringify({ Items: [{ Id: 4321, Domain: "example.com" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.includes("/edgerules/addOrUpdate") && init?.method === "POST") {
      headerUpserts++;
      const body = JSON.parse(String(init.body)) as {
        ActionParameter1: string;
        ActionParameter2: string;
      };
      expect(body.ActionParameter1).toBe("X-OpsCrew-Origin-Token");
      tokenOnBunny = body.ActionParameter2;
      return new Response(null, { status: 201 });
    }
    if (href.includes("/pullzone/55")) {
      return new Response(
        JSON.stringify({
          Id: 55,
          Name: "opscrew-shop",
          EdgeRules:
            tokenOnBunny === undefined
              ? []
              : [
                  {
                    Guid: "guid-1",
                    ActionType: 6,
                    ActionParameter1: "X-OpsCrew-Origin-Token",
                    ActionParameter2: tokenOnBunny,
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
  return {
    fetch,
    getToken: () => tokenOnBunny,
    getZoneLookups: () => zoneLookups,
    getHeaderUpserts: () => headerUpserts,
  };
}

async function setupBunny(engine: FakeEngine) {
  const project = await createProject(bunnyPlan());
  await writeFile(join(project.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const github = new FakeGitHub();
  const bunny = fakeBunnyApi();
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: HCLOUD,
      BUNNYNET_API_KEY: BUNNY_KEY,
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const services: ProvisionServices = {
    otherApps: { inspect: noOtherApps },
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    edgeFetch: bunny.fetch,
  };
  return { ...project, deps, github, bunny, handler, services };
}

describe.skipIf(!findExecutable("git"))("Bunny.net end-to-end provision and destroy flow", () => {
  it("runs setupThirdPartyEdge -> renderInfra -> syncEdgeOriginHeader -> deploySecrets -> destroy", async () => {
    const engine = new FakeEngine({
      outputs: {
        server_ipv4: SERVER_IPV4,
        server_ipv6: SERVER_IPV6,
        url: "https://shop.example.com",
        bunny_pullzone_id: 55,
        bunny_pullzone_hostname: "opscrew-shop.b-cdn.net",
      },
    });
    const { root, deps, github, bunny, services } = await setupBunny(engine);

    const result = await runProvision(deps, { services });
    expect(result.applied).toBe(true);
    expect(bunny.getZoneLookups()).toBeGreaterThanOrEqual(1);
    expect(bunny.getHeaderUpserts()).toBe(1);

    // Infra rendered bunny-edge module with looked-up zone id and zero SetRequestHeader secrets.
    const tfvars = JSON.parse(
      await readFile(join(root, "opscrew/infra/prod/terraform.tfvars.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(tfvars.bunny_dns_zone_id).toBe(4321);
    expect(tfvars.http_allowed_cidrs).toEqual(["0.0.0.0/0", "::/0"]);

    // GitHub Actions received OPSCREW_EDGE_ORIGIN_TOKEN matching the token synced to Bunny.
    const secretToken = github.secrets.get(DEPLOY_SECRETS.edgeOriginToken);
    expect(secretToken).toMatch(/^[0-9a-f]{64}$/);
    expect(bunny.getToken()).toBe(secretToken);

    // Secrets never leak to reporter or audit log.
    const printed = `${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
    expect(printed).not.toContain(BUNNY_KEY);
    expect(printed).not.toContain(secretToken as string);

    // Destroy tears down the Bunny deployment cleanly.
    const destroyGitHub = new FakeDestroyGitHub();
    for (const [k, v] of github.secrets.entries()) destroyGitHub.secrets.set(k, v);
    const destroyEngine = new ScriptedDestroyEngine({
      resources: [
        {
          address: "module.edge.bunnynet_pullzone.this[0]",
          type: "bunnynet_pullzone",
          name: "this",
          provider: "registry.opentofu.org/bunnyway/bunnynet",
          action: "delete",
        },
        ...deployedResources(),
      ],
    });
    const destroyDeps = await createTestPhaseDeps({
      root,
      env: {
        ...process.env,
        OPSCREW_HOME: join(root, ".home-opscrew"),
        HCLOUD_TOKEN: HCLOUD,
        BUNNYNET_API_KEY: BUNNY_KEY,
      },
      runner: projectRunner(),
      approvalHandler: new ScriptedApprovalHandler(() => ({
        approved: true,
        confirmation: "shop",
      })),
    });
    await writeFakeState(destroyDeps.paths);
    const destroyed = await runDestroy(destroyDeps, {
      snapshot: false,
      services: {
        otherApps: { inspect: noOtherApps },
        engine: async () => destroyEngine,
        provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
        servers: new FakeServers(),
        github: destroyGitHub,
      },
    });
    expect(destroyed.destroyed).toHaveLength(4);
    expect(destroyed.destroyed.map((r) => r.address)).toContain(
      "module.edge.bunnynet_pullzone.this[0]",
    );
    expect(destroyGitHub.secrets.has(DEPLOY_SECRETS.edgeOriginToken)).toBe(false);
  });

  it("reads bunny_pullzone_id via currentOutputs on a no-op re-provision and syncs the origin header", async () => {
    const engine = new FakeEngine({
      changes: [],
      outputs: {
        server_ipv4: SERVER_IPV4,
        server_ipv6: SERVER_IPV6,
        url: "https://shop.example.com",
        bunny_pullzone_id: "55",
      },
    });
    const { deps, github, bunny, services } = await setupBunny(engine);
    await writeFakeState(deps.paths);
    engine.applied.push({
      planFile: "prior.plan",
      approval: { approvedPlanHash: "a".repeat(64) },
    });

    const result = await runProvision(deps, { services });
    expect(result.applied).toBe(false);
    expect(engine.calls).toContain("output");
    expect(bunny.getHeaderUpserts()).toBe(1);
    expect(github.secrets.get(DEPLOY_SECRETS.edgeOriginToken)).toBe(bunny.getToken());
  });

  it("fails loudly before setting OPSCREW_EDGE_ORIGIN_TOKEN when bunny_pullzone_id is missing from outputs", async () => {
    const engine = new FakeEngine({
      outputs: {
        server_ipv4: SERVER_IPV4,
        server_ipv6: SERVER_IPV6,
        url: "https://shop.example.com",
      },
    });
    const { deps, github, bunny, services } = await setupBunny(engine);

    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("bunny_pullzone_id"),
    });
    expect(bunny.getHeaderUpserts()).toBe(0);
    expect(github.secrets.has(DEPLOY_SECRETS.edgeOriginToken)).toBe(false);
  });
});
