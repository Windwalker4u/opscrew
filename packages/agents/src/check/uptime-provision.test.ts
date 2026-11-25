import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UPTIME_RESOURCES, uptimeEntryKey, uptimeSecretName } from "@opscrew/connector-cloudflare";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest, ResourceChange } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { UPTIME_WORKER } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { DEPLOY_SETUP_BRANCH } from "../provision/publish";
import { runProvision } from "../provision/run";
import type { ProvisionServices } from "../provision/types";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeCloudflare,
  fakeSharedCloudflare,
  planJsonFor,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  SERVER_IPV6,
  testPlan,
} from "../testing";
import { UPTIME_ONLY_LINE } from "./uptime";
import { fakeUptimeAccount, WEBHOOK_URL, withUptimeAccount } from "./uptime.fakes";

const ID = "acme/shop/shop/prod";

/** The `shop` app on Hetzner at shop.example.com, checked by the Cloudflare uptime Worker. */
function workerPlan(webhook = true): DeployPlan {
  return DeployPlanSchema.parse({
    ...testPlan({ domain: "shop.example.com" }),
    observability: {
      check: { enabled: true, runner: "cloudflare", ...(webhook ? { webhook: "slack" } : {}) },
    },
  });
}

/** A whole provision of `plan` with fakes, the Worker's account the zone's. */
async function setup(plan: DeployPlan) {
  const project = await createProject(plan);
  await writeFile(join(project.root, "production.env"), "STRIPE_SECRET_KEY=sk\n");
  const github = new FakeGitHub();
  /** The approvals' answers: all granted until a test says otherwise. */
  let answer: (request: ApprovalRequest) => boolean = () => true;
  const handler = new ScriptedApprovalHandler((request) => answer(request));
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: "hcloud-test-token",
      OPSCREW_APP_ENV_FILE: "production.env",
      OPSCREW_CHECK_WEBHOOK: WEBHOOK_URL,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const account = fakeUptimeAccount();
  /** The infrastructure plan's changes (by default it creates the server), and its engines. */
  const scenario: { changes?: ResourceChange[] } = {};
  const engines: FakeEngine[] = [];
  const services: ProvisionServices = {
    engine: async () => {
      const engine = new FakeEngine({
        ...scenario,
        planJson: planJsonFor({ proxied: true }),
        outputs: {
          server_ipv4: SERVER_IPV4,
          server_ipv6: SERVER_IPV6,
          server_id: "4711",
          server_name: "shop",
          url: "https://shop.example.com",
        },
      });
      engines.push(engine);
      return engine;
    },
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    cloudflare: fakeCloudflare(),
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: withUptimeAccount(fakeSharedCloudflare(new FakeZone()), account.client),
  };
  const answerWith = (next: (request: ApprovalRequest) => boolean) => {
    answer = next;
  };
  return { ...project, deps, github, handler, answerWith, services, account, scenario, engines };
}

/** Another app's entry with `count` hostnames in the account's namespace. */
function otherHostnames(account: ReturnType<typeof fakeUptimeAccount>, count: number): void {
  const namespace =
    account.uptime.namespace("opscrew-uptime") ?? account.uptime.addNamespace("opscrew-uptime");
  const id = "acme/big/big/prod";
  namespace.values.set(
    uptimeEntryKey(id),
    JSON.stringify({
      version: 1,
      repository: "acme/big",
      app: "big",
      environment: "prod",
      hosts: Array.from({ length: count }, (_, i) => ({
        hostname: `site${i}.example.org`,
        healthPath: "/",
      })),
      webhook: "slack",
      secret: uptimeSecretName(id),
    }),
  );
}

it("the connector's and the script's names and limits are the same", () => {
  const { name, namespace, binding, cron, compatibilityDate, maxHostnames } = UPTIME_WORKER;
  expect(UPTIME_RESOURCES).toEqual({
    worker: name,
    namespace,
    binding,
    cron,
    compatibilityDate,
    maxHostnames,
  });
});

describe.skipIf(!findExecutable("git"))("provision with the Cloudflare uptime Worker", () => {
  it("applies the uptime plan by its hash, with no Actions workflow and no GitHub check secrets", async () => {
    const { deps, github, handler, services, account, root } = await setup(workerPlan());
    await runProvision(deps, { services });

    const uptime = handler.requests.filter(
      (r) => r.kind === "cloudflare-apply" && r.title.includes("uptime plan"),
    );
    expect(uptime).toHaveLength(1);
    expect(uptime[0]?.details).toContain(`Cloudflare uptime plan hash: ${uptime[0]?.planHash}`);
    expect(account.uptime.namespace("opscrew-uptime")?.values.has(uptimeEntryKey(ID))).toBe(true);
    expect(account.uptime.scripts.get("opscrew-uptime")?.secrets.has(uptimeSecretName(ID))).toBe(
      true,
    );
    expect(deps.reporter.text()).toContain(UPTIME_ONLY_LINE);

    // No workflow, no check key, no GitHub check secrets.
    expect(existsSync(join(root, ".github/workflows/opscrew-check.yml"))).toBe(false);
    expect(existsSync(join(root, "opscrew/check/check.json"))).toBe(false);
    expect([...github.secrets.keys()].filter((name) => name.startsWith("OPSCREW_CHECK"))).toEqual(
      [],
    );
    // The address was given to the redactor, and is nowhere in what was shown, asked or audited.
    expect(deps.redactor.redact(`posting to ${WEBHOOK_URL}`)).not.toContain(WEBHOOK_URL);
    const seen = JSON.stringify([deps.reporter.lines, deps.audit.entries, handler.requests]);
    expect(seen).not.toContain(WEBHOOK_URL);
  });

  it("--plan-only shows the uptime plan with its hash and changes nothing in Cloudflare", async () => {
    const { deps, handler, services, account } = await setup(workerPlan());
    await runProvision(deps, { services, planOnly: true });
    const hash = /Cloudflare uptime plan ([0-9a-f]{64})\. In a script/.exec(
      deps.reporter.text(),
    )?.[1];
    expect(hash).toBeDefined();
    expect(deps.reporter.text()).toContain(`\`--approve ${hash}\``);
    expect(account.uptime.writes()).toEqual([]);
    expect(handler.requests.map((r) => r.title).join("\n")).not.toContain("uptime plan");
  });

  it("applies the uptime plan from a script approving only its hash, kept apart from the infrastructure's", async () => {
    const { deps, github, handler, answerWith, services, account, scenario } = await setup(
      workerPlan(),
    );
    const plan = workerPlan();
    // Everything else is set up already: the Actions check ran, the server exists.
    const actions = DeployPlanSchema.parse({
      ...plan,
      observability: { check: { enabled: true, webhook: "slack" } },
    });
    await writeArtifact("plan", deps.paths.files.plan, actions);
    await runProvision(deps, { services });
    // Its deploy-setup pull request is still open, so the next runs add to it.
    github.openPulls.set(DEPLOY_SETUP_BRANCH, {
      number: 7,
      url: "https://github.com/acme/shop/pull/7",
    });
    await writeArtifact("plan", deps.paths.files.plan, {
      ...(await readArtifact("plan", deps.paths.files.plan)),
      observability: plan.observability,
    });
    scenario.changes = [];
    const shown = await runProvision(deps, { services, planOnly: true });
    expect(shown.uptimePlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.reporter.text()).toContain(`Cloudflare uptime plan ${shown.uptimePlanHash}.`);

    // A script: only the uptime plan's hash, nothing else bound to a hash is approved.
    const hash = shown.uptimePlanHash as string;
    handler.requests.length = 0;
    deps.interactive = false;
    answerWith((r) => (r.planHash === undefined ? r.allowDestroy !== true : r.planHash === hash));
    await runProvision(deps, { services, approveHashes: [hash] });
    expect(handler.requests.find((r) => r.title.includes("uptime plan"))?.planHash).toBe(hash);
    expect(account.uptime.namespace("opscrew-uptime")?.values.has(uptimeEntryKey(ID))).toBe(true);
  });

  it("refuses a 41st hostname in the account before any server is created", async () => {
    const { deps, handler, services, account, engines } = await setup(workerPlan());
    otherHostnames(account, 40);
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining("at most 40 hostnames"),
    });
    expect(engines.flatMap((engine) => engine.applied)).toEqual([]);
    expect(handler.requests.map((r) => r.kind)).not.toContain("iac-apply");
    expect(account.uptime.writes()).toEqual([]);
  });

  it("refuses the Worker without the repository's webhook before any change", async () => {
    const { deps, handler, services, account } = await setup(workerPlan(false));
    await expect(runProvision(deps, { services })).rejects.toMatchObject({
      code: "ARTIFACT_INVALID",
      file: "opscrew/plan.yaml",
    });
    expect(handler.requests).toEqual([]);
    expect(account.uptime.calls).toEqual([]);
  });
});
