import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  uptimeEntryKey,
  uptimeReportKey,
  uptimeSecretName,
  uptimeStateKey,
} from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, type FakeUptime } from "@opscrew/connector-cloudflare/testing";
import { uptimeReportInstance } from "@opscrew/connector-ssh-host";
import { fakeSecret } from "@opscrew/core/testing";
import { UPTIME_WORKER_SCRIPT } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
import { recordServerAddress } from "../shared/server-record";
import { ensureDeployKey } from "../shared/ssh-keys";
import {
  createTestPhaseDeps,
  FakeGitHub,
  portainerPlan,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  unusedRemote,
} from "../testing";
import { readReportKey } from "./key";
import { provisionCheck } from "./provision";
import { UPTIME_ONLY_LINE } from "./reports";
import {
  applyUptimeTeardown,
  planProvisionUptime,
  planUptimeTeardown,
  provisionUptime,
  readUptimeRecord,
  uptimeEntry,
  uptimeId,
  uptimeStatusLines,
  uptimeTeardownNote,
} from "./uptime";
import { FakeReportServer, fakeUptimeAccount, uptimePlan, WEBHOOK_URL } from "./uptime.fakes";

const ID = "acme/shop/shop/prod";
const SECRET = uptimeSecretName(ID);
/** The fake account's report address (its workers.dev subdomain `opscrew-test`). */
const REPORT_URL = "https://opscrew-uptime.opscrew-test.workers.dev/report";
/** The app's server, as the scheduled check names it, listed since the start of the test's day. */
const SERVER = { id: "hetzner-shop", since: "2026-10-11T00:00:00Z" };

type Answer = ConstructorParameters<typeof ScriptedApprovalHandler>[0];

async function setup(
  options: { env?: Record<string, string>; answer?: Answer; interactive?: boolean } = {},
) {
  const handler = new ScriptedApprovalHandler(options.answer);
  const deps = await createTestPhaseDeps({
    approvalHandler: handler,
    env: options.env ?? { OPSCREW_CHECK_WEBHOOK: WEBHOOK_URL },
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
  });
  // The app's server exists: OpsCrew created it, and reaches it as deploy.
  await recordServerAddress(deps.paths, { ipv4: SERVER_IPV4 });
  const server = new FakeReportServer();
  const { uptime, client } = fakeUptimeAccount();
  const github = new FakeGitHub();
  const asked: string[] = [];
  const services = {
    sharedCloudflare: client,
    askCheckWebhook: async (question: { prompt: string }) => {
      asked.push(question.prompt);
      return WEBHOOK_URL;
    },
    serverHost: server,
    remote: unusedRemote,
  };
  /** The uptime step as provision plans it before any change. */
  const plan = (deployPlan: DeployPlan, ask = true) =>
    planProvisionUptime(deps, {
      plan: deployPlan,
      github: async () => ({ owner: "acme", repo: "shop" }),
      services,
      command: "opscrew provision",
      ask,
    });
  /** That step planned, then provisionCheck for `plan`, as provision runs it near its end. */
  const provision = async (deployPlan: DeployPlan) => {
    await writeArtifact("plan", deps.paths.files.plan, deployPlan);
    const uptime = await plan(deployPlan);
    return provisionCheck(deps, {
      plan: deployPlan,
      github: { api: github, owner: "acme", repo: "shop", defaultBranch: "main" },
      storeSecrets: true,
      services,
      uptime,
      command: "opscrew provision",
      phase: "provision",
    });
  };
  /** Everything a user, the audit or an approval could see, and the host plans. */
  const seen = () =>
    JSON.stringify([
      deps.reporter.lines,
      deps.audit.entries,
      handler.requests,
      github.secrets,
      server.applies.map((a) => a.plan),
    ]);
  /** The Cloudflare uptime approvals, and the host plans' approvals. */
  const requests = (kind: "cloudflare-apply" | "host-apply") =>
    handler.requests.filter((r) => r.kind === kind);
  return {
    deps,
    handler,
    uptime,
    client,
    github,
    services,
    server,
    asked,
    plan,
    provision,
    seen,
    requests,
  };
}

/** The account's namespace `opscrew-uptime`, which the tests expect to exist. */
function namespaceOf(uptime: FakeUptime) {
  const namespace = uptime.namespace("opscrew-uptime");
  if (namespace === undefined) throw new Error("no namespace opscrew-uptime");
  return namespace;
}

/** The environment's entry in the account, as the Worker reads it. */
function entryOf(uptime: FakeUptime): Record<string, unknown> {
  return JSON.parse(namespaceOf(uptime).values.get(uptimeEntryKey(ID)) ?? "");
}

/** Another app's entry and secret in the account, as its own provision left them. */
function otherApp(uptime: FakeUptime) {
  const other = "acme/blog/blog/prod";
  const entry = {
    version: 1,
    repository: "acme/blog",
    app: "blog",
    environment: "prod",
    hosts: [{ hostname: "blog.example.org", healthPath: "/" }],
    webhook: "ntfy",
    secret: uptimeSecretName(other),
  };
  namespaceOf(uptime).values.set(uptimeEntryKey(other), JSON.stringify(entry));
  uptime.scripts.get("opscrew-uptime")?.secrets.set(entry.secret, '{"url":"elsewhere"}');
}

describe("uptimeEntry", () => {
  it("is the environment's hostnames, health path, webhook kind and secret name, never an address", () => {
    const plan = uptimePlan("cloudflare");
    expect(uptimeId(plan, "acme/shop")).toBe(ID);
    expect(uptimeEntry(plan, "acme/shop", "slack")).toEqual({
      version: 1,
      repository: "acme/shop",
      app: "shop",
      environment: "prod",
      hosts: [{ hostname: "shop.example.com", healthPath: expect.stringMatching(/^\//) }],
      webhook: "slack",
      secret: SECRET,
    });
    const staging = uptimePlan("cloudflare", { environment: "staging" });
    expect(uptimeId(staging, "acme/shop")).toBe("acme/shop/shop/staging");
  });
});

describe("provisionCheck with the Cloudflare uptime Worker", () => {
  it("plans in the zone's account, asks cloudflare-apply by its hash, applies and audits, then the server's report", async () => {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));

    // The Cloudflare plan first, bound to its hash, with no typed confirmation; then the host plan.
    expect(s.handler.requests.map((r) => r.kind)).toEqual(["cloudflare-apply", "host-apply"]);
    const [request] = s.requests("cloudflare-apply");
    expect(request).toMatchObject({
      kind: "cloudflare-apply",
      title: "Apply the Cloudflare uptime plan for acme/shop (prod) (5 changes)",
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(request?.allowDestroy).toBeUndefined();
    expect(request?.confirmPhrase).toBeUndefined();
    expect(request?.details).toContain(`Cloudflare uptime plan hash: ${request?.planHash}`);
    expect(request?.details).toContain(`Set the Worker secret ${SECRET}`);
    expect(request?.details).toContain("and take reports from hetzner-shop");
    expect(s.deps.reporter.text()).toContain(request?.details);
    // The server reports its own checks, so nothing says they need Actions.
    expect(s.deps.reporter.text()).not.toContain(UPTIME_ONLY_LINE);

    // The Worker, its trigger, the namespace, the secret and the entry, in the zone's account.
    expect(s.uptime.accountId).toBe(FAKE_ACCOUNT_ID);
    const script = s.uptime.scripts.get("opscrew-uptime");
    expect(script?.content).toBe(UPTIME_WORKER_SCRIPT);
    expect(script?.crons).toEqual(["*/5 * * * *"]);
    expect(script?.workersDev).toEqual({ enabled: true, previewsEnabled: false });
    const key = await readReportKey(s.deps.paths, s.deps.redactor);
    expect(JSON.parse(script?.secrets.get(SECRET) ?? "")).toEqual({
      url: WEBHOOK_URL,
      report: key?.value,
    });
    expect(entryOf(s.uptime)).toMatchObject({
      repository: "acme/shop",
      hosts: [{ hostname: "shop.example.com" }],
      webhook: "slack",
      servers: [SERVER],
    });
    expect(entryOf(s.uptime)).not.toHaveProperty("heartbeatMinutes");
    expect(await readUptimeRecord(s.deps.paths)).toEqual({
      accountId: FAKE_ACCOUNT_ID,
      id: ID,
      reportKey: key?.sha256,
      reportUrl: REPORT_URL,
    });

    // Audited, by the plan's hash, change by change.
    const actions = s.deps.audit.entries
      .filter((e) => e.target === request?.planHash)
      .map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "cloudflare uptime apply started",
        "cloudflare uptime change create-namespace",
        "cloudflare uptime change upload-script",
        "cloudflare uptime change set-subdomain",
        "cloudflare uptime change put-secret",
        "cloudflare uptime change put-entry",
      ]),
    );

    // The server's host plan, approved by its hash: the step uptime-report with the report
    // address, the entry, the server's id, the app's folder and the thresholds, the key by its
    // SHA-256; the key itself reaches the adapter only at apply.
    const [host] = s.requests("host-apply");
    expect(host?.title).toBe("Report the checks of the server to the Cloudflare uptime Worker");
    expect(s.server.applies).toHaveLength(1);
    const [applied] = s.server.applies;
    expect(applied?.options.approvedHash).toBe(host?.planHash);
    expect(applied?.options.rootImage).toMatch(/^.+@sha256:[0-9a-f]{64}$/);
    expect(applied?.options.secrets).toEqual({ uptimeReportKey: key?.value });
    const [step] = applied?.plan.steps ?? [];
    expect(step).toMatchObject({
      id: "uptime-report",
      state: "change",
      params: {
        app: "shop",
        instance: uptimeReportInstance(ID),
        url: REPORT_URL,
        entry: ID,
        server: "hetzner-shop",
        drill: "",
        hosts: "shop.example.com",
        diskWarn: 85,
        diskHigh: 95,
        certDays: 14,
        keySha256: key?.sha256,
      },
    });
    expect(step?.params).not.toHaveProperty("credentials");

    // No check key and no GitHub check secrets: the Worker is the check.
    expect(s.github.secrets.size).toBe(0);
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-secrets");
    // The webhook's address went only into the Worker's secret, the key only there and the server.
    expect(s.seen()).not.toContain(WEBHOOK_URL);
    expect(s.seen()).not.toContain(key?.value);
  });

  it("dates the credentials in the server's config and the entry's rotate flags, never a value", async () => {
    const s = await setup();
    const plan = DeployPlanSchema.parse({
      ...uptimePlan("cloudflare"),
      observability: {
        check: { enabled: true, runner: "cloudflare", webhook: "slack", credentials: true },
      },
      deployment: { ...uptimePlan("cloudflare").deployment, firstDeployAt: "2026-01-02T03:04:05Z" },
    });
    await ensureDeployKey(s.deps.paths, s.deps.redactor);
    await s.provision(plan);
    expect(entryOf(s.uptime)).toMatchObject({ rotate: "" });
    const params = s.server.applies[0]?.plan.steps[0]?.params;
    expect(params?.maxAgeDays).toBe(365);
    expect(String(params?.credentials).split("\n")).toContain(
      "deploy-key 2026-01-02T03:04:05Z first-deploy",
    );
  });

  it("leaves out a credential whose name is over 128 characters, says so, and still reports", async () => {
    const s = await setup();
    const base = uptimePlan("cloudflare");
    // A generated value with a long name: its credential app:<NAME> has 130 characters.
    const name = `K${"_".repeat(123)}EY`;
    const long = `app:${name}`;
    expect(long).toHaveLength(130);
    const plan = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, env: [...base.app.env, { name, secret: true, source: "generated" }] },
      observability: {
        check: { enabled: true, runner: "cloudflare", webhook: "slack", credentials: true },
      },
      deployment: { ...base.deployment, firstDeployAt: "2026-01-02T03:04:05Z" },
    });
    await ensureDeployKey(s.deps.paths, s.deps.redactor);
    await writeFile(
      generatedValuesFile(s.deps),
      `${JSON.stringify({ env: { [name]: "kept" } })}\n`,
    );
    await s.provision(plan);
    expect(s.deps.reporter.text()).toContain(
      `The uptime report leaves out the credential ${long}, whose name is over 128 characters: its age isn't reported.`,
    );
    // The report still goes out, with the other credentials.
    expect(s.server.applies).toHaveLength(1);
    const lines = String(s.server.applies[0]?.plan.steps[0]?.params.credentials).split("\n");
    expect(lines).toContain("deploy-key 2026-01-02T03:04:05Z first-deploy");
    expect(lines.some((line) => line.startsWith(long))).toBe(false);
  });

  it("asks for the address when the Worker has no secret for the entry, and keeps a stored one", async () => {
    const s = await setup({ env: {}, interactive: true });
    await s.provision(uptimePlan("cloudflare"));
    expect(s.asked).toEqual([
      "Address of the Slack webhook for the uptime check (stored as a secret of the Cloudflare Worker opscrew-uptime)",
    ]);
    expect(s.uptime.scripts.get("opscrew-uptime")?.secrets.has(SECRET)).toBe(true);

    // Run again: nothing is asked, nothing changes, nothing is approved, on Cloudflare or the server.
    s.handler.requests.length = 0;
    await s.provision(uptimePlan("cloudflare"));
    expect(s.asked).toHaveLength(1);
    expect(s.handler.requests).toEqual([]);
    expect(s.server.applies).toHaveLength(1);
    expect(s.deps.reporter.text()).toContain(
      `The uptime Worker already holds the webhook's address for this environment (its secret ${SECRET}), so it is kept.`,
    );
    expect(s.deps.reporter.text()).toContain(
      "The Cloudflare uptime Worker is already set up for this environment; nothing in Cloudflare changes.",
    );
    expect(s.deps.reporter.text()).toContain(
      "The uptime report on the server is as planned; nothing on it changes.",
    );
    expect(s.seen()).not.toContain(WEBHOOK_URL);
  });

  it("a lost report key gives a new one: the address is asked, the secret and the server's key written again", async () => {
    const s = await setup({ env: {}, interactive: true });
    await s.provision(uptimePlan("cloudflare"));
    const first = await readReportKey(s.deps.paths, s.deps.redactor);
    await rm(join(s.deps.paths.projectHomeDir, "uptime_report_key"));

    s.handler.requests.length = 0;
    await s.provision(uptimePlan("cloudflare"));
    const next = await readReportKey(s.deps.paths, s.deps.redactor);
    expect(next?.value).not.toBe(first?.value);
    expect(s.asked).toHaveLength(2);
    const [request] = s.requests("cloudflare-apply");
    expect(request?.title).toContain("(1 change)");
    const secret = JSON.parse(s.uptime.scripts.get("opscrew-uptime")?.secrets.get(SECRET) ?? "");
    expect(secret.report).toBe(next?.value);
    expect(s.server.applies.at(-1)?.options.secrets).toEqual({ uptimeReportKey: next?.value });
    expect((await readUptimeRecord(s.deps.paths))?.reportKey).toBe(next?.sha256);
    expect(s.seen()).not.toContain(next?.value);
  });

  it("stops before any change when the report key is new and no address is given", async () => {
    const s = await setup({ env: { OPSCREW_CHECK_WEBHOOK: WEBHOOK_URL } });
    await s.provision(uptimePlan("cloudflare"));
    await rm(join(s.deps.paths.projectHomeDir, "uptime_report_key"));
    delete s.deps.env.OPSCREW_CHECK_WEBHOOK;
    s.deps.interactive = false;
    const writes = s.uptime.writes().length;
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(`The uptime Worker's secret ${SECRET} doesn't hold`),
      hint: expect.stringContaining("Set OPSCREW_CHECK_WEBHOOK"),
    });
    expect(s.uptime.writes()).toHaveLength(writes);
    // No key is made that the Worker wouldn't get.
    expect(await readReportKey(s.deps.paths, s.deps.redactor)).toBeUndefined();
  });

  it("writes the secret again when a declined plan left the Worker without this computer's key", async () => {
    let approve = true;
    const s = await setup({ env: {}, interactive: true, answer: () => approve });
    await s.provision(uptimePlan("cloudflare"));
    await rm(join(s.deps.paths.projectHomeDir, "uptime_report_key"));
    // The new key is made and kept, but its plan is declined.
    approve = false;
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    const kept = await readReportKey(s.deps.paths, s.deps.redactor);
    expect(kept).toBeDefined();
    // The next run knows the Worker doesn't hold it, and writes the secret with it.
    approve = true;
    s.handler.requests.length = 0;
    await s.provision(uptimePlan("cloudflare"));
    expect(s.requests("cloudflare-apply")[0]?.details).toContain(`Set the Worker secret ${SECRET}`);
    const secret = JSON.parse(s.uptime.scripts.get("opscrew-uptime")?.secrets.get(SECRET) ?? "");
    expect(secret.report).toBe(kept?.value);
  });

  it("writes the secret again when the record holds no report key and the first plan was declined", async () => {
    let approve = true;
    const s = await setup({ env: {}, interactive: true, answer: () => approve });
    await s.provision(uptimePlan("cloudflare"));
    // The Worker holds a secret, and this computer's record names no report key (as before the
    // servers reported, or after a run on another computer); the key file is gone.
    await writeFile(
      join(s.deps.paths.stateDir, "uptime.json"),
      `${JSON.stringify({ accountId: FAKE_ACCOUNT_ID, id: ID })}\n`,
    );
    await rm(join(s.deps.paths.projectHomeDir, "uptime_report_key"));
    // The first run makes and keeps a key, but its plan is declined.
    approve = false;
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    const kept = await readReportKey(s.deps.paths, s.deps.redactor);
    expect(kept).toBeDefined();
    expect((await readUptimeRecord(s.deps.paths))?.reportKey).toBeUndefined();
    // The next run, with no address given, asks for it and writes the secret with that key.
    approve = true;
    const asked = s.asked.length;
    s.handler.requests.length = 0;
    await s.provision(uptimePlan("cloudflare"));
    expect(s.asked).toHaveLength(asked + 1);
    expect(s.requests("cloudflare-apply")[0]?.details).toContain(`Set the Worker secret ${SECRET}`);
    const secret = JSON.parse(s.uptime.scripts.get("opscrew-uptime")?.secrets.get(SECRET) ?? "");
    expect(secret.report).toBe(kept?.value);
    expect((await readUptimeRecord(s.deps.paths))?.reportKey).toBe(kept?.sha256);
  });

  it("stops before any change when no address is given or stored", async () => {
    const s = await setup({ env: {}, interactive: false });
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(`The uptime Worker has no secret ${SECRET}`),
      hint: expect.stringContaining("Set OPSCREW_CHECK_WEBHOOK"),
    });
    expect(s.handler.requests).toEqual([]);
    expect(s.uptime.writes()).toEqual([]);
    expect(await readReportKey(s.deps.paths, s.deps.redactor)).toBeUndefined();
  });

  it("names the other apps' entries it keeps, and creates nothing shared for a second app", async () => {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));
    otherApp(s.uptime);
    // The address changed: the new one replaces the secret, with the same report key.
    s.handler.requests.length = 0;
    s.deps.env.OPSCREW_CHECK_WEBHOOK = `${WEBHOOK_URL}-new`;
    await s.provision(uptimePlan("cloudflare"));
    const [request] = s.handler.requests;
    expect(request?.details).toContain("Keeps the entries of: acme/blog (prod).");
    expect(request?.title).toContain("(1 change)");
    expect(s.handler.requests).toHaveLength(1);
    const key = await readReportKey(s.deps.paths, s.deps.redactor);
    expect(JSON.parse(s.uptime.scripts.get("opscrew-uptime")?.secrets.get(SECRET) ?? "")).toEqual({
      url: `${WEBHOOK_URL}-new`,
      report: key?.value,
    });
  });

  it("fails without a word of success when another app's upload drops its secret meanwhile", async () => {
    const s = await setup();
    const plan = uptimePlan("cloudflare");
    await writeArtifact("plan", s.deps.paths.files.plan, plan);
    const step = await s.plan(plan);
    // Another app's upload at the same moment keeps no secret, as the live pass saw it happen.
    s.uptime.hooks.push({
      match: `GET /accounts/${FAKE_ACCOUNT_ID}/workers/scripts/opscrew-uptime/secrets`,
      run: () => s.uptime.scripts.get("opscrew-uptime")?.secrets.clear(),
    });
    await expect(
      provisionUptime(s.deps, step, { command: "opscrew provision", phase: "provision" }),
    ).rejects.toMatchObject({
      message:
        "Another app changed the shared uptime Worker at the same moment, so this app's settings didn't stick.",
      hint: "Run provision again.",
    });
    expect(s.deps.reporter.text()).not.toContain("Changed the Cloudflare uptime Worker");
    expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();
    expect(s.deps.audit.entries.map((e) => e.action)).toContain("cloudflare uptime apply failed");
    // The server's report waits for the Worker that takes it.
    expect(s.server.applies).toEqual([]);
  });

  it("a refused approval changes nothing in Cloudflare nor on the server, and says how to apply it later", async () => {
    const s = await setup({ answer: () => false });
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("The Cloudflare uptime plan was not approved"),
      hint: expect.stringContaining("opscrew provision --approve "),
    });
    expect(s.uptime.writes()).toEqual([]);
    expect(s.server.applies).toEqual([]);
    expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();
  });

  it("a refused host plan leaves the server as it was, after the Worker's change", async () => {
    const s = await setup({ answer: (request) => request.kind !== "host-apply" });
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("The host plan was not approved"),
      hint: expect.stringContaining("opscrew provision --approve "),
    });
    expect(s.uptime.scripts.has("opscrew-uptime")).toBe(true);
    expect(s.server.applies).toEqual([]);
  });

  for (const [what, leaving] of [
    ["moves back to actions", uptimePlan("actions")],
    ["turns the check off", uptimePlan("cloudflare", { enabled: false })],
  ] as const) {
    it(`removes only its entry, state and secret, and the server's report, when the environment ${what}`, async () => {
      const s = await setup();
      await s.provision(uptimePlan("cloudflare"));
      namespaceOf(s.uptime).values.set(uptimeStateKey(ID), '{"hosts":{}}');
      namespaceOf(s.uptime).values.set(uptimeReportKey(ID, "hetzner-shop"), '{"at":1}');
      s.handler.requests.length = 0;
      await s.provision(leaving);

      const [request] = s.requests("cloudflare-apply");
      // No typed confirmation: the Worker, its trigger and the namespace stay.
      expect(request?.allowDestroy).toBeUndefined();
      expect(request?.confirmPhrase).toBeUndefined();
      expect(request?.details).toContain("Delete the entry of acme/shop (prod)");
      expect(request?.details).toContain(`Delete the Worker secret ${SECRET}`);
      expect(request?.details).toContain("stay, with no entry");
      const values = namespaceOf(s.uptime).values;
      expect(values.has(uptimeEntryKey(ID))).toBe(false);
      expect(values.has(uptimeStateKey(ID))).toBe(false);
      expect(values.has(uptimeReportKey(ID, "hetzner-shop"))).toBe(false);
      const script = s.uptime.scripts.get("opscrew-uptime");
      expect(script?.secrets.has(SECRET)).toBe(false);
      expect(script?.crons).toEqual(["*/5 * * * *"]);
      expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();

      // The server's timer goes with it, through a host plan approved by its hash.
      const [host] = s.requests("host-apply");
      expect(host?.title).toBe("Remove the uptime report of this environment from the server");
      expect(s.server.applies.at(-1)?.options.approvedHash).toBe(host?.planHash);
      expect(s.server.applies.at(-1)?.plan.steps[0]).toMatchObject({
        id: "uptime-report",
        state: "change",
        params: { remove: true, instances: uptimeReportInstance(ID), shared: true },
      });
      expect(s.server.report.instances).toEqual([]);

      // Once gone, a provision reads nothing in Cloudflare.
      const calls = s.uptime.calls.length;
      await s.provision(leaving);
      expect(s.uptime.calls).toHaveLength(calls);
    });
  }

  it("reads nothing in Cloudflare for an environment that never chose the Worker", async () => {
    const s = await setup();
    await s.provision(uptimePlan(undefined));
    expect(s.uptime.calls).toEqual([]);
    expect(s.server.applies).toEqual([]);
    expect(s.deps.reporter.text()).not.toContain(UPTIME_ONLY_LINE);
  });

  it("plans no server step on a target with no server, and says the Worker checks the address only", async () => {
    const s = await setup();
    const base = portainerPlan();
    const plan = DeployPlanSchema.parse({
      ...base,
      observability: { check: { enabled: true, runner: "cloudflare", webhook: "slack" } },
    });
    await s.provision(plan);
    expect(s.deps.reporter.text()).toContain(UPTIME_ONLY_LINE);
    expect(entryOf(s.uptime)).not.toHaveProperty("servers");
    expect(JSON.parse(s.uptime.scripts.get("opscrew-uptime")?.secrets.get(SECRET) ?? "")).toEqual({
      url: WEBHOOK_URL,
    });
    expect(s.requests("host-apply")).toEqual([]);
    expect(await readReportKey(s.deps.paths, s.deps.redactor)).toBeUndefined();
  });
});

describe("provisionUptime --plan-only", () => {
  it("shows both plans and their hashes for scripts, and changes nothing", async () => {
    const s = await setup();
    const plan = uptimePlan("cloudflare");
    await writeArtifact("plan", s.deps.paths.files.plan, plan);
    // Planned without asking: a plan-only run gives the address with OPSCREW_CHECK_WEBHOOK.
    const hash = await provisionUptime(s.deps, await s.plan(plan, false), {
      command: "opscrew provision",
      phase: "provision",
      planOnly: true,
    });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const text = s.deps.reporter.text();
    expect(text).toContain(
      `The uptime check has a Cloudflare plan of its own: Cloudflare uptime plan ${hash}. In a script, approve it too (\`--approve ${hash}\`).`,
    );
    const host = /uptime-report plan ([0-9a-f]{64})\. In a script, approve it too/.exec(text)?.[1];
    expect(host).toBeDefined();
    expect(s.handler.requests).toEqual([]);
    expect(s.uptime.writes()).toEqual([]);
    expect(s.server.applies).toEqual([]);
    expect(s.asked).toEqual([]);
    expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();

    // The run that applies makes the same plans, so the hashes a script approves are those shown.
    await s.provision(plan);
    expect(s.requests("cloudflare-apply")[0]?.planHash).toBe(hash);
    expect(s.requests("host-apply")[0]?.planHash).toBe(host);
  });

  it("says the server's plan comes once the server exists", async () => {
    const s = await setup();
    await recordServerAddress(s.deps.paths, undefined);
    const plan = uptimePlan("cloudflare");
    await writeArtifact("plan", s.deps.paths.files.plan, plan);
    await provisionUptime(s.deps, await s.plan(plan, false), {
      command: "opscrew provision",
      phase: "provision",
      planOnly: true,
    });
    expect(s.deps.reporter.text()).toContain(
      "The uptime report's host plan is shown once the server exists",
    );
  });
});

describe("the uptime entry's teardown", () => {
  async function provisioned(other = false) {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));
    if (other) otherApp(s.uptime);
    s.handler.requests.length = 0;
    const plan = uptimePlan("cloudflare");
    const step = await planUptimeTeardown(s.deps, plan, {
      services: s.services,
      github: { owner: "acme", repo: "shop" },
      command: "opscrew destroy",
    });
    if (step === undefined) throw new Error("no teardown planned");
    return { ...s, plan, step };
  }

  it("removes the Worker and its namespace with the last entry, under the typed name", async () => {
    const s = await provisioned();
    // Planned read-only, before the typed confirmation: the plan's words and its hash.
    const writesBefore = s.uptime.writes().length;
    const note = uptimeTeardownNote(s.step);
    expect(note[0]).toBe(
      "This also removes the uptime check's entry for acme/shop (prod) from the Cloudflare Worker opscrew-uptime, and the Worker, its trigger and its KV namespace opscrew-uptime, which no other entry uses:",
    );
    expect(note[1]).toContain(`Cloudflare uptime plan hash: ${s.step.plan.hash}`);
    expect(s.uptime.writes()).toHaveLength(writesBefore);
    // A destroy changes no server here: a deleted one needs nothing, a kept one's teardown does it.
    expect(s.step.reports).toBeUndefined();

    await applyUptimeTeardown(s.deps, s.plan, s.step, {
      command: "opscrew destroy",
      phase: "provision",
    });
    expect(s.handler.requests).toEqual([
      expect.objectContaining({
        kind: "cloudflare-apply",
        planHash: s.step.plan.hash,
        allowDestroy: true,
        confirmPhrase: "shop",
      }),
    ]);
    expect(s.uptime.scripts.has("opscrew-uptime")).toBe(false);
    expect(s.uptime.namespace("opscrew-uptime")).toBeUndefined();
    expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();
    expect(s.seen()).not.toContain(WEBHOOK_URL);
  });

  it("keeps the Worker for another app's entry", async () => {
    const s = await provisioned(true);
    expect(s.step.plan.destroys).toBe(false);
    expect(uptimeTeardownNote(s.step)[0]).toBe(
      "This also removes the uptime check's entry for acme/shop (prod) from the Cloudflare Worker opscrew-uptime:",
    );
    await applyUptimeTeardown(s.deps, s.plan, s.step, {
      command: "opscrew destroy",
      phase: "provision",
    });
    expect(s.uptime.scripts.get("opscrew-uptime")?.secrets.has(SECRET)).toBe(false);
    expect(namespaceOf(s.uptime).values.has(uptimeEntryKey(ID))).toBe(false);
    expect(namespaceOf(s.uptime).values.has(uptimeEntryKey("acme/blog/blog/prod"))).toBe(true);
  });

  it("stops, never skipping, when neither a record nor a GitHub remote says which entry it is", async () => {
    const s = await setup();
    await expect(
      planUptimeTeardown(s.deps, uptimePlan("cloudflare"), {
        services: s.services,
        github: {},
        command: "opscrew destroy",
      }),
    ).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "OpsCrew can't tell which entry of the Cloudflare uptime Worker opscrew-uptime is this environment's",
      ),
      hint: expect.stringContaining("from the repository's clone"),
    });
    expect(s.uptime.calls).toEqual([]);
  });

  it("plans nothing for an environment without an entry this computer knows of", async () => {
    const s = await setup();
    await expect(
      planUptimeTeardown(s.deps, uptimePlan("actions"), {
        services: s.services,
        github: { owner: "acme", repo: "shop" },
        command: "opscrew destroy",
      }),
    ).resolves.toBeUndefined();
    expect(s.uptime.calls).toEqual([]);
  });
});

describe("uptimeStatusLines", () => {
  async function status(
    state: string | undefined,
    options: { entry?: boolean; report?: unknown; now?: string } = {},
  ) {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));
    const values = namespaceOf(s.uptime).values;
    if (state !== undefined) values.set(uptimeStateKey(ID), state);
    if (options.entry === false) values.delete(uptimeEntryKey(ID));
    if (options.report !== undefined) {
      values.set(uptimeReportKey(ID, "hetzner-shop"), JSON.stringify(options.report));
    }
    s.deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "status");
    s.deps.fetch = s.uptime.fetch;
    if (options.now !== undefined) {
      const now = new Date(options.now);
      s.deps.clock = { now: () => now };
    }
    const lines = await uptimeStatusLines(s.deps, uptimePlan("cloudflare"));
    expect(s.uptime.writes().filter((c) => c.path.includes("status"))).toEqual([]);
    return lines;
  }

  /** A server's last report as the Worker keeps it, at `at` (ISO). */
  function report(at: string) {
    return {
      version: 1,
      server: "hetzner-shop",
      kind: "change",
      disk: { status: "warn", percent: 87, free: 5_368_709_120, total: 42_949_672_960 },
      snapshot: { status: "ok", id: "20261010T030000Z" },
      drill: { status: "none" },
      certificates: [{ hostname: "shop.example.com", status: "ok", days: 60 }],
      at: Date.parse(at) / 1000,
    };
  }

  it("says where the check runs and lists the hostnames down, with since when and why", async () => {
    const lines = await status(
      JSON.stringify({
        hosts: {
          "shop.example.com": {
            status: "down",
            since: "2026-11-25T10:05:00Z",
            reason: "not reachable",
          },
          "www.shop.example.com": {
            status: "suspect",
            since: "2026-11-25T10:15:00Z",
            reason: "answered with status 502",
          },
        },
      }),
    );
    expect(lines[0]).toBe(
      "Uptime check (the Cloudflare Worker opscrew-uptime, read from Cloudflare now):",
    );
    expect(lines[1]).toMatch(
      /^ {2}Checked every 5 minutes by the Cloudflare Worker opscrew-uptime: shop\.example\.com\//,
    );
    expect(lines.slice(2, 4)).toEqual([
      "  Down:",
      "    shop.example.com since 2026-11-25T10:05:00Z: not reachable",
    ]);
  });

  it("says none is down without a state, and that the server has not reported yet", async () => {
    expect((await status(undefined)).slice(2)).toEqual([
      "  Down: none",
      "  Server checks (each server reports its own, on a change and once a day):",
      "    hetzner-shop: no report yet (listed since 2026-10-11T00:00:00Z).",
    ]);
  });

  it("shows each listed server's last report time and statuses", async () => {
    const lines = await status(undefined, {
      report: report("2026-10-11T09:00:00Z"),
      now: "2026-10-11T12:00:00Z",
    });
    expect(lines.at(-1)).toBe(
      "    hetzner-shop: last report 2026-10-11T09:00:00Z (3 hours ago): disk warn (87% used), snapshot ok, restore drill none, certificate of shop.example.com ok (60 days left).",
    );
  });

  it('says "reports stopped" once the last report is over 26 hours old, or none came', async () => {
    const lines = await status(undefined, {
      report: report("2026-10-11T09:00:00Z"),
      now: "2026-10-12T11:01:00Z",
    });
    expect(lines.at(-1)).toMatch(
      /^ {4}hetzner-shop: reports stopped: the last one came 2026-10-11T09:00:00Z \(26 hours ago\): disk warn/,
    );
    const none = await status(undefined, { now: "2026-10-12T03:00:00Z" });
    expect(none.at(-1)).toBe(
      "    hetzner-shop: reports stopped: none came since it was listed, 2026-10-11T00:00:00Z (27 hours ago).",
    );
  });

  it("says to run provision when the entry is missing", async () => {
    expect((await status(undefined, { entry: false })).slice(1)).toEqual([
      "  This environment's entry is missing from the Cloudflare account, so nothing checks the app now. Run `opscrew provision` to set it up again.",
    ]);
  });
});

it("keeps its record in the environment's state folder", async () => {
  const s = await setup();
  await s.provision(uptimePlan("cloudflare"));
  expect(existsSync(join(s.deps.paths.stateDir, "uptime.json"))).toBe(true);
});
