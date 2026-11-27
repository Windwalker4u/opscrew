import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppRecord } from "@opscrew/connector-ssh-host";
import type { FetchLike, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { edgeMemoryMb, edgeProxy, KAMAL_PROXY_MEMORY_MB } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { appMemoryMb } from "../shared/memory";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  type FakeEngineScenario,
  FakeGitHub,
  firstAppLook,
  planJsonFor,
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
const OPEN = ["0.0.0.0/0", "::/0"];
/** Two of Cloudflare's ranges, as the last run rendered them for a proxied app. */
const CLOUDFLARE = ["173.245.48.0/20", "2400:cb00::/32"];
const SERVER = "module.server.hcloud_server.this";

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

/** The same, served behind Cloudflare's proxy at `shop.example.com`. */
function proxiedPlan(httpAllowedFrom?: "any" | "edge"): DeployPlan {
  const plan = testPlan({
    domain: "shop.example.com",
    ...(httpAllowedFrom !== undefined ? { httpAllowedFrom } : {}),
  });
  return { ...plan, deployment: APPLIED } as DeployPlan;
}

/** What the last run rendered into `terraform.tfvars.json` (nbg1, cx23, web ports open to all). */
function rendered(o: { location?: string; serverType?: string; web?: string[] } = {}) {
  return {
    location: o.location ?? "nbg1",
    server_type: o.serverType ?? "cx23",
    http_allowed_cidrs: o.web ?? OPEN,
  };
}

/** The app's server changes the engine plans: `action` on the server. */
function serverChange(action: ResourceChange["action"]): ResourceChange {
  return {
    address: SERVER,
    type: "hcloud_server",
    name: "this",
    provider: "registry.opentofu.org/hetznercloud/hcloud",
    action,
  };
}

/** The engine's plan of a resize from `from` to `to` in place. */
function resizeScenario(from: string, to: string): FakeEngineScenario {
  return {
    changes: [serverChange("update")],
    planJson: {
      ...(planJsonFor() as Record<string, unknown>),
      variables: { server_type: { value: to }, location: { value: "nbg1" } },
      resource_changes: [
        {
          address: SERVER,
          type: "hcloud_server",
          change: {
            actions: ["update"],
            before: { name: "shop", server_type: from, location: "nbg1" },
            after: { name: "shop", server_type: to, location: "nbg1" },
            after_unknown: { firewall_ids: true, ssh_keys: [true] },
          },
        },
      ],
    },
  };
}

/**
 * The first app `plan`'s project, whose last run rendered `tfvars` (none: `undefined`) and
 * `mainTf`, with a server that holds `records` (a list a test may add to between runs) or fails
 * to be inspected with `fails`; `provision(options)` runs provision there (`--plan-only` unless
 * the options say otherwise).
 */
async function firstAppProject(
  plan: DeployPlan,
  tfvars: Record<string, unknown> | undefined,
  look: { records?: AppRecord[]; fails?: Error; unreadable?: string[]; mainTf?: string } = {},
  scenario: FakeEngineScenario = {},
) {
  const project = await createProject(plan);
  roots.push(project.root, project.bare);
  const tfvarsFile = join(project.root, plan.infra.dir, "terraform.tfvars.json");
  const tfvarsText = tfvars === undefined ? undefined : `${JSON.stringify(tfvars)}\n`;
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  if (tfvarsText !== undefined) await writeFile(tfvarsFile, tfvarsText);
  if (look.mainTf !== undefined) {
    await writeFile(join(project.root, plan.infra.dir, "main.tf"), look.mainTf);
  }
  const engine = new FakeEngine(scenario);
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
  const records = look.records ?? [];
  const server = await firstAppLook(deps.paths, records, {
    ...(look.fails !== undefined ? { fails: look.fails } : {}),
    ...(look.unreadable !== undefined ? { unreadable: look.unreadable } : {}),
  });
  let engineAsked = false;
  const provision = async (options: Omit<ProvisionOptions, "services"> = {}) => {
    const outcome = await runProvision(deps, {
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
    }).then(
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
    return { ...outcome, printed };
  };
  return {
    deps,
    engine,
    handler,
    server,
    records,
    provision,
    engineAsked: () => engineAsked,
    tfvarsFile,
    tfvarsText,
  };
}

type Project = Awaited<ReturnType<typeof firstAppProject>>;
type Outcome = Awaited<ReturnType<Project["provision"]>>;

/** One `--plan-only` provision of a fresh project ({@link firstAppProject}). */
async function provisionWith(
  plan: DeployPlan,
  tfvars: Record<string, unknown> | undefined,
  look: Parameters<typeof firstAppProject>[2] = {},
  options: Omit<ProvisionOptions, "services"> = {},
) {
  const project = await firstAppProject(plan, tfvars, look);
  return { ...project, ...(await project.provision(options)) };
}

/** The refusal of the first run of `t`, checked to have changed nothing and leaked nothing. */
async function refusedBeforeAnyChange(t: Project & Outcome) {
  const error = refusedOnly(t);
  expect(t.engineAsked()).toBe(false);
  expect(t.engine.calls).toEqual([]);
  if (t.tfvarsText !== undefined) {
    await expect(readFile(t.tfvarsFile, "utf8")).resolves.toBe(t.tfvarsText);
  }
  return error;
}

/**
 * The refusal `t` ended with: before any approval (after the `asked` an earlier run made),
 * ending "Nothing was changed.", no leak.
 */
function refusedOnly(t: Pick<Project, "handler"> & Outcome, asked = 0) {
  expect(t.error).toBeInstanceOf(OpsCrewError);
  const error = t.error as OpsCrewError;
  expect(error.code).toBe("PHASE_PRECONDITION");
  expect(error.message.endsWith("Nothing was changed.")).toBe(true);
  expect(t.handler.requests.slice(asked)).toEqual([]);
  expect(t.printed()).not.toContain(HCLOUD);
  expect(t.printed()).not.toContain(SERVER_IPV4);
  return error;
}

/** `t` went past the look at the server: its plan was made and saved. */
function wentOn(t: Project & Outcome) {
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

/** The root's main.tf as a run with the app's server on the network rendered it. */
const NETWORKED_MAIN =
  'module "server" {\n  source         = "./modules/server"\n  wireguard_port = 51820\n}\n';

const unreachable = () => new Error(`ssh: connect to host ${SERVER_IPV4} port 22: timed out`);
const RESTART =
  '"inventory" (from github.com/example/inventory) runs on the server too and restarts with it.';

describe.skipIf(!findExecutable("git"))(
  "the first app's provision beside apps from other repositories",
  () => {
    describe("a replace (another location)", () => {
      const plan = () => deployedPlan("cx23");
      const before = rendered({ location: "fsn1" });

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

      it("refuses the --approve run of a plan made while the server was empty, by its plan", async () => {
        const t = await firstAppProject(plan(), before, {}, { changes: [serverChange("replace")] });
        const planned = await t.provision();
        expect(planned.error).toBeUndefined();
        // The --plan-only run rewrote the files: only the saved plan says it replaces the server.
        expect(JSON.parse(await readFile(t.tfvarsFile, "utf8"))).toMatchObject({
          location: "nbg1",
        });
        t.records.push(secondAppRecord());
        const asked = t.handler.requests.length;
        const approve = await t.provision({
          planOnly: false,
          approveHashes: [planned.result?.planHash as string],
        });
        const error = refusedOnly({ ...approve, handler: t.handler }, asked);
        expect(error.message).toContain("and replacing the server would break it");
        expect(t.engine.applied).toEqual([]);
      });
    });

    describe("a change of which addresses reach the web ports", () => {
      it("refuses a switch from Cloudflare's proxy to DNS only while another app runs there", async () => {
        const t = await provisionWith(deployedPlan("cx23"), rendered({ web: CLOUDFLARE }), {
          records: [secondAppRecord()],
        });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain(
          "changing which addresses reach the web ports would break it",
        );
      });

      it("refuses an app that comes behind Cloudflare's proxy from a DNS of its own", async () => {
        const t = await provisionWith(proxiedPlan(), rendered({ web: OPEN }), {
          records: [secondAppRecord()],
        });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain(
          "changing which addresses reach the web ports would break it",
        );
      });

      it("refuses opening the web ports to all while the proxy stays", async () => {
        const t = await provisionWith(proxiedPlan("any"), rendered({ web: CLOUDFLARE }), {
          records: [secondAppRecord()],
        });
        await refusedBeforeAnyChange(t);
      });

      it("doesn't look while the web ports' sources stay the same", async () => {
        const t = await provisionWith(proxiedPlan(), rendered({ web: CLOUDFLARE }), {
          records: [secondAppRecord()],
        });
        expect(t.server.inspections).toEqual([]);
      });

      it("goes on without one, and stops when the server can't be reached unless --skip-other-apps-check", async () => {
        const before = rendered({ web: CLOUDFLARE });
        wentOn(await provisionWith(deployedPlan("cx23"), before));
        await refusedBeforeAnyChange(
          await provisionWith(deployedPlan("cx23"), before, { fails: unreachable() }),
        );
        wentOn(
          await provisionWith(
            deployedPlan("cx23"),
            before,
            { fails: unreachable() },
            { skipOtherAppsCheck: true },
          ),
        );
      });
    });

    describe("a resize (another type)", () => {
      const plan = () => deployedPlan("cx33");
      const before = rendered();

      it("refuses when the new type doesn't hold the other apps' memory limits beside the app's", async () => {
        const t = await provisionWith(plan(), before, {
          records: [secondAppRecord({ memoryMb: 7000 })],
        });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toMatch(
          /^cx33 has 8192 MB of memory\. After 384 MB for the system and \d+ MB for OpsCrew's edge, it doesn't hold this app's \d+ MB of memory limits beside the 7032 MB of the other app on the server \("inventory" 7000 MB and 32 MB for its proxy\)\. Nothing was changed\.$/,
        );
        expect(error.hint).toContain("opscrew design");
      });

      it("says that the other apps restart with the server when it fits", async () => {
        const t = await provisionWith(plan(), before, { records: [secondAppRecord()] });
        wentOn(t);
        expect(t.deps.reporter.text()).toContain(RESTART);
        expect(t.deps.reporter.text()).not.toContain("of its memory free");
      });

      it("warns, and goes on, when the new type fits with less than 15% of its memory free", async () => {
        // cx33's 8192 MB: after the system (384) and the edge, 200 MB stay free beside this app.
        const appMb = appMemoryMb(plan());
        const edgeMb = edgeMemoryMb(edgeProxy(plan()));
        const memoryMb = 8192 - 384 - edgeMb - appMb - KAMAL_PROXY_MEMORY_MB - 200;
        const t = await provisionWith(plan(), before, { records: [secondAppRecord({ memoryMb })] });
        wentOn(t);
        const warnings = t.deps.reporter.lines.filter((line) => line.level === "warn");
        expect(warnings.map((line) => line.message)).toEqual(
          expect.arrayContaining([
            RESTART,
            `Your server keeps only 3% of its memory free after the memory limits of this app (${appMb} MB) and of the other OpsCrew app on it (${memoryMb + KAMAL_PROXY_MEMORY_MB} MB: "inventory" ${memoryMb} MB and ${KAMAL_PROXY_MEMORY_MB} MB for its proxy), OpsCrew's edge and the system, so a container that grows can make the server run out of memory. Lower a memory limit in opscrew/plan.yaml, or add memory to the server.`,
          ]),
        );
      });

      it("refuses a type the provider's catalogue doesn't list, whose memory is unknown", async () => {
        const t = await provisionWith(deployedPlan("cx43"), before, {
          records: [secondAppRecord()],
        });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain("The provider's catalogue doesn't list cx43");
      });

      it("refuses while an app's record can't be read: its memory is unknown", async () => {
        const t = await provisionWith(plan(), before, { unreadable: ["ledger"] });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain(
          'The server also runs "ledger", whose record on the server OpsCrew can\'t read',
        );
        expect(error.message).toContain("and resizing the server to cx33 would break it");
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
          "resizing the server to cx33 restarts any that run there and may leave them too little memory",
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

      it("checks the --approve run of a plan made while the server was empty, by its plan", async () => {
        const t = await firstAppProject(plan(), before, {}, resizeScenario("cx23", "cx33"));
        const planned = await t.provision();
        expect(planned.error).toBeUndefined();
        expect(planned.printed()).not.toContain("restarts with it");
        // Too big for cx33 beside the app: refused by the saved plan's new type.
        t.records.push(secondAppRecord({ memoryMb: 7000 }));
        const asked = t.handler.requests.length;
        const refused = await t.provision({
          planOnly: false,
          approveHashes: [planned.result?.planHash as string],
        });
        expect(refusedOnly({ ...refused, handler: t.handler }, asked).message).toContain(
          "cx33 has 8192 MB of memory",
        );
        // One that fits: the approve run's approval says it restarts with the server.
        t.records.splice(0, 1, secondAppRecord());
        await t.provision({
          planOnly: false,
          approveHashes: [planned.result?.planHash as string],
          push: false,
          secrets: false,
        });
        const approval = t.handler.requests.find((request) => request.kind === "iac-apply");
        expect(approval?.details).toContain(RESTART);
      });
    });

    describe("a private network", () => {
      const plan = () => deployedPlan("cx23", { network: NETWORK });
      const before = rendered();

      it("refuses the run that makes it while another app runs on the server, before any change", async () => {
        const t = await provisionWith(plan(), before, { records: [secondAppRecord()] });
        const error = await refusedBeforeAnyChange(t);
        expect(error.message).toContain("putting the server on a private network would break it");
      });

      it("makes it without one", async () => {
        const t = await provisionWith(plan(), before);
        expect(t.server.inspections).toHaveLength(1);
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

      it("doesn't look once the last run put the server on it, also over the network until the apply", async () => {
        const t = await provisionWith(
          plan(),
          before,
          { records: [secondAppRecord()], mainTf: NETWORKED_MAIN },
          { privateSshUntilApply: true },
        );
        expect(t.server.inspections).toEqual([]);
        // It goes on, to the private network's own steps (which this test doesn't set up).
        expect(String((t.error as Error | undefined)?.message)).not.toContain("other apps");
      });
    });

    it("doesn't look for a deployed app whose last run's files aren't here, with nothing to compare", async () => {
      // The committed terraform.tfvars.json is rarely missing; without it and without an approved
      // saved plan nothing says the run changes the server (a host plan alone, a --plan-only run).
      const t = await provisionWith(deployedPlan("cx23"), undefined, {
        records: [secondAppRecord()],
      });
      expect(t.server.inspections).toEqual([]);
      expect(String((t.error as Error | undefined)?.message)).not.toContain("other apps");
    });

    it("doesn't look at the server when the plan changes nothing that holds other apps", async () => {
      const t = await provisionWith(deployedPlan("cx23"), rendered());
      expect(t.error).toBeUndefined();
      expect(t.server.inspections).toEqual([]);
    });
  },
);
