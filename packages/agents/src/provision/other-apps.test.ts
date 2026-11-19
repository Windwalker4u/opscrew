import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppRecord } from "@opscrew/connector-ssh-host";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  firstAppLook,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  secondAppRecord,
  testKeyPair,
  testPlan,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionOptions } from "./types";

const HCLOUD = fakeSecret("hcloud-token");
const APPLIED = { lastApplyAt: "2026-10-11T12:30:00.000Z", lastPlanHash: "a".repeat(64) };

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake Hetzner API with cx23 (4 GB, 40 GB) and cx33 (8 GB, 80 GB) in nbg1. */
const hetznerApi: FetchLike = async (input, init) => {
  const url = new URL(String(input));
  if (new Headers(init?.headers).get("authorization") !== `Bearer ${HCLOUD}`) {
    return json({ error: { message: "bad token" } }, 401);
  }
  if (url.pathname === "/v1/locations") {
    return json({ locations: [{ id: 1, name: "nbg1", country: "DE", city: "Nuremberg" }] });
  }
  if (url.pathname === "/v1/server_types") {
    const price = (net: string) => ({ net, gross: net });
    const type = (id: number, name: string, cores: number, memory: number, disk: number) => ({
      id,
      name,
      cores,
      memory,
      disk,
      cpu_type: "shared",
      architecture: "x86",
      deprecated: false,
      prices: [{ location: "nbg1", price_hourly: price("0.01"), price_monthly: price("5.4900") }],
      locations: [{ id: 1, name: "nbg1", available: true }],
    });
    return json({
      server_types: [type(1, "cx23", 2, 4, 40), type(2, "cx33", 4, 8, 80)],
      meta: { pagination: { page: 1, per_page: 50, next_page: null } },
    });
  }
  return json({ error: { message: "not found" } }, 404);
};

/** A deployed first app on Hetzner (nbg1, `serverType`), with `changes` to its plan. */
function deployedPlan(serverType: string, changes: Partial<DeployPlan> = {}): DeployPlan {
  const plan = testPlan();
  return {
    ...plan,
    target: { ...plan.target, serverType },
    deployment: APPLIED,
    ...changes,
  } as DeployPlan;
}

/**
 * Provision of the first app `plan`, whose last run rendered `tfvars`, with a server that holds
 * `records` (or fails to be inspected with `fails`).
 */
async function provisionWith(
  plan: DeployPlan,
  tfvars: Record<string, unknown>,
  look: { records?: AppRecord[]; fails?: Error; unreadable?: string[] } = {},
  options: Omit<ProvisionOptions, "services"> = {},
) {
  const project = await createProject(plan);
  roots.push(project.root, project.bare);
  const tfvarsFile = join(project.root, plan.infra.dir, "terraform.tfvars.json");
  const tfvarsText = `${JSON.stringify(tfvars)}\n`;
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await writeFile(tfvarsFile, tfvarsText);
  const engine = new FakeEngine();
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: HCLOUD,
    },
    runner: projectRunner(),
    approvalHandler: handler,
    fetch: hetznerApi,
  });
  deps.redactor.addLiteral(HCLOUD, "HCLOUD_TOKEN");
  const { records = [], ...how } = look;
  const server = await firstAppLook(deps.paths, records, how);
  let engineAsked = false;
  const run = runProvision(deps, {
    planOnly: true,
    ...options,
    services: {
      engine: async () => {
        engineAsked = true;
        return engine;
      },
      provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
      github: new FakeGitHub(),
      remote: readyRemote,
      tcpConnect: async () => true,
      sleep: async () => undefined,
      otherApps: server,
    },
  });
  const outcome = await run.then(
    (result) => ({ result, error: undefined }),
    (error: unknown) => ({ result: undefined, error }),
  );
  const printed = () =>
    [
      deps.reporter.text(),
      JSON.stringify(deps.audit.entries),
      outcome.error instanceof OpsCrewError
        ? `${outcome.error.message}\n${outcome.error.hint}`
        : "",
    ].join("\n");
  return {
    ...outcome,
    deps,
    engine,
    handler,
    server,
    engineAsked: () => engineAsked,
    tfvarsFile,
    tfvarsText,
    printed,
  };
}

/** The refusal `t` ended with, checked to have changed nothing and leaked nothing. */
async function refusedBeforeAnyChange(t: Awaited<ReturnType<typeof provisionWith>>) {
  expect(t.error).toBeInstanceOf(OpsCrewError);
  const error = t.error as OpsCrewError;
  expect(error.code).toBe("PHASE_PRECONDITION");
  expect(error.message.endsWith("Nothing was changed.")).toBe(true);
  expect(t.engineAsked()).toBe(false);
  expect(t.engine.calls).toEqual([]);
  expect(t.handler.requests).toEqual([]);
  await expect(readFile(t.tfvarsFile, "utf8")).resolves.toBe(t.tfvarsText);
  expect(t.printed()).not.toContain(HCLOUD);
  expect(t.printed()).not.toContain(SERVER_IPV4);
  return error;
}

/** `t` went past the look at the server: its plan was made and saved. */
function wentOn(t: Awaited<ReturnType<typeof provisionWith>>) {
  expect(t.error).toBeUndefined();
  expect(t.result?.planHash).toMatch(/^[0-9a-f]{64}$/);
  expect(t.server.inspections).toHaveLength(1);
  expect(t.printed()).not.toContain(HCLOUD);
  expect(t.printed()).not.toContain(SERVER_IPV4);
}

/** The app's server alone on a private network. */
const NETWORK: NonNullable<DeployPlan["network"]> = {
  range: "10.200.4.0/24",
  members: [
    { name: "app", address: "10.200.4.1", port: 51820, publicKey: testKeyPair("app").publicKey },
  ],
  devices: [],
  grants: [],
  publicSsh: true,
};

const unreachable = () => new Error(`ssh: connect to host ${SERVER_IPV4} port 22: timed out`);

describe.skipIf(!findExecutable("git"))(
  "the first app's provision beside apps from other repositories",
  () => {
    describe("a replace (another location)", () => {
      const plan = () => deployedPlan("cx23");
      const before = { location: "fsn1", server_type: "cx23" };

      it("refuses while another app runs on the server, before any change", async () => {
        const t = await provisionWith(plan(), before, { records: [secondAppRecord()] });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain(
          'The server also runs "inventory" (from github.com/example/inventory), and replacing the server would break it.',
        );
        expect(t.server.inspections).toHaveLength(1);
      });

      it("goes on without one", async () => {
        wentOn(await provisionWith(plan(), before));
      });

      it("stops when the server can't be reached, unless --skip-other-apps-check", async () => {
        const error = await refusedBeforeAnyChange(
          await provisionWith(plan(), before, { fails: unreachable() }),
        );
        expect(error.message).toContain("OpsCrew couldn't look at the server for other apps");
        expect(error.hint).toContain("--skip-other-apps-check");

        const skipped = await provisionWith(
          plan(),
          before,
          { fails: unreachable() },
          { skipOtherAppsCheck: true },
        );
        wentOn(skipped);
        expect(skipped.deps.reporter.text()).toContain("going on as you asked");
      });
    });

    describe("a switch between Cloudflare's proxy and DNS only", () => {
      const plan = () => deployedPlan("cx23");
      const before = { location: "nbg1", server_type: "cx23", proxied: true };

      it("refuses while another app runs on the server, before any change", async () => {
        const t = await provisionWith(plan(), before, { records: [secondAppRecord()] });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain(
          "changing which addresses reach the web ports would break it",
        );
      });

      it("goes on without one", async () => {
        wentOn(await provisionWith(plan(), before));
      });

      it("stops when the server can't be reached, unless --skip-other-apps-check", async () => {
        await refusedBeforeAnyChange(await provisionWith(plan(), before, { fails: unreachable() }));
        wentOn(
          await provisionWith(
            plan(),
            before,
            { fails: unreachable() },
            { skipOtherAppsCheck: true },
          ),
        );
      });
    });

    describe("a resize (another type)", () => {
      const plan = () => deployedPlan("cx33");
      const before = { location: "nbg1", server_type: "cx23" };

      it("refuses when the new type doesn't hold the other apps' memory limits beside the app's", async () => {
        const t = await provisionWith(plan(), before, {
          records: [secondAppRecord({ memoryMb: 7000 })],
        });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toMatch(
          /^cx33 has 8192 MB of memory\. After 384 MB for the system and \d+ MB for OpsCrew's edge, it doesn't hold this app's \d+ MB of memory limits beside the 7000 MB of the other app on the server \("inventory" 7000 MB\)\. Nothing was changed\.$/,
        );
        expect(error.hint).toContain("opscrew design");
      });

      it("says that the other apps restart with the server when it fits", async () => {
        const t = await provisionWith(plan(), before, { records: [secondAppRecord()] });
        wentOn(t);
        expect(t.deps.reporter.text()).toContain(
          '"inventory" (from github.com/example/inventory) runs on the server too and restarts with it.',
        );
      });

      it("puts the restart line in the infrastructure plan's approval", async () => {
        const t = await provisionWith(
          plan(),
          before,
          { records: [secondAppRecord()] },
          { planOnly: false, push: false, secrets: false },
        );
        const approval = t.handler.requests.find((request) => request.kind === "iac-apply");
        expect(approval?.details).toContain(
          '"inventory" (from github.com/example/inventory) runs on the server too and restarts with it.',
        );
      });

      it("refuses while an app's record can't be read: its memory is unknown", async () => {
        const t = await provisionWith(plan(), before, { unreadable: ["ledger"] });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain(
          'The server also runs "ledger", whose record on the server OpsCrew can\'t read',
        );
        expect(error.message).toContain("can't tell whether cx33 holds it beside this app");
      });

      it("goes on without one, and says nothing of other apps", async () => {
        const t = await provisionWith(plan(), before);
        wentOn(t);
        expect(t.deps.reporter.text()).not.toContain("restarts with it");
      });

      it("stops when the server can't be reached, unless --skip-other-apps-check", async () => {
        const error = await refusedBeforeAnyChange(
          await provisionWith(plan(), before, { fails: unreachable() }),
        );
        expect(error.message).toContain(
          "resizing it to cx33 restarts any that run there and may leave them too little memory",
        );
        const skipped = await provisionWith(
          plan(),
          before,
          { fails: unreachable() },
          { skipOtherAppsCheck: true },
        );
        wentOn(skipped);
        expect(skipped.deps.reporter.text()).toContain("going on as you asked");
      });
    });

    describe("a private network", () => {
      const plan = () => deployedPlan("cx23", { network: NETWORK });
      const before = { location: "nbg1", server_type: "cx23" };

      it("refuses while another app runs on the server, before any change", async () => {
        const t = await provisionWith(plan(), before, { records: [secondAppRecord()] });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain("putting the server on a private network would break it");
      });

      it("goes on without one", async () => {
        const t = await provisionWith(plan(), before);
        expect(t.server.inspections.length).toBeGreaterThan(0);
        expect(t.engineAsked()).toBe(true);
      });

      it("stops when the server can't be reached, unless --skip-other-apps-check", async () => {
        await refusedBeforeAnyChange(await provisionWith(plan(), before, { fails: unreachable() }));
        const skipped = await provisionWith(
          plan(),
          before,
          { fails: unreachable() },
          { skipOtherAppsCheck: true },
        );
        expect(skipped.engineAsked()).toBe(true);
        expect(skipped.deps.reporter.text()).toContain("going on as you asked");
      });
    });

    it("doesn't look at the server when the plan changes nothing that holds other apps", async () => {
      const t = await provisionWith(deployedPlan("cx23"), {
        location: "nbg1",
        server_type: "cx23",
      });
      expect(t.error).toBeUndefined();
      expect(t.server.inspections).toEqual([]);
    });
  },
);
