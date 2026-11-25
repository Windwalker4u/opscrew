import { existsSync } from "node:fs";
import { join } from "node:path";
import { uptimeEntryKey, uptimeSecretName, uptimeStateKey } from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, type FakeUptime } from "@opscrew/connector-cloudflare/testing";
import { fakeSecret } from "@opscrew/core/testing";
import { UPTIME_WORKER_SCRIPT } from "@opscrew/iac-templates";
import { type DeployPlan, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, FakeGitHub, ScriptedApprovalHandler } from "../testing";
import { provisionCheck } from "./provision";
import {
  applyUptimeTeardown,
  planProvisionUptime,
  planUptimeTeardown,
  provisionUptime,
  readUptimeRecord,
  UPTIME_ONLY_LINE,
  uptimeEntry,
  uptimeId,
  uptimeStatusLines,
  uptimeTeardownNote,
} from "./uptime";
import { fakeUptimeAccount, uptimePlan, WEBHOOK_URL } from "./uptime.fakes";

const ID = "acme/shop/shop/prod";
const SECRET = uptimeSecretName(ID);

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
  const { uptime, client } = fakeUptimeAccount();
  const github = new FakeGitHub();
  const asked: string[] = [];
  const services = {
    sharedCloudflare: client,
    askCheckWebhook: async (question: { prompt: string }) => {
      asked.push(question.prompt);
      return WEBHOOK_URL;
    },
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
  /** Everything a user, the audit or an approval could see. */
  const seen = () =>
    JSON.stringify([deps.reporter.lines, deps.audit.entries, handler.requests, github.secrets]);
  return { deps, handler, uptime, client, github, services, asked, plan, provision, seen };
}

/** The account's namespace `opscrew-uptime`, which the tests expect to exist. */
function namespaceOf(uptime: FakeUptime) {
  const namespace = uptime.namespace("opscrew-uptime");
  if (namespace === undefined) throw new Error("no namespace opscrew-uptime");
  return namespace;
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
  it("plans in the zone's account, asks cloudflare-apply by its hash, applies and audits", async () => {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));

    // One approval, bound to the uptime plan's hash, with no typed confirmation.
    expect(s.handler.requests).toHaveLength(1);
    const [request] = s.handler.requests;
    expect(request).toMatchObject({
      kind: "cloudflare-apply",
      title: "Apply the Cloudflare uptime plan for acme/shop (prod) (4 changes)",
      planHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(request?.allowDestroy).toBeUndefined();
    expect(request?.confirmPhrase).toBeUndefined();
    expect(request?.details).toContain(`Cloudflare uptime plan hash: ${request?.planHash}`);
    expect(request?.details).toContain(`Set the Worker secret ${SECRET}`);
    expect(s.deps.reporter.text()).toContain(request?.details);
    expect(s.deps.reporter.text()).toContain(UPTIME_ONLY_LINE);

    // The Worker, its trigger, the namespace, the secret and the entry, in the zone's account.
    expect(s.uptime.accountId).toBe(FAKE_ACCOUNT_ID);
    const script = s.uptime.scripts.get("opscrew-uptime");
    expect(script?.content).toBe(UPTIME_WORKER_SCRIPT);
    expect(script?.crons).toEqual(["*/5 * * * *"]);
    expect(JSON.parse(script?.secrets.get(SECRET) ?? "")).toEqual({ url: WEBHOOK_URL });
    expect(JSON.parse(namespaceOf(s.uptime).values.get(uptimeEntryKey(ID)) ?? "")).toMatchObject({
      repository: "acme/shop",
      hosts: [{ hostname: "shop.example.com" }],
      webhook: "slack",
    });
    expect(await readUptimeRecord(s.deps.paths)).toEqual({ accountId: FAKE_ACCOUNT_ID, id: ID });

    // Audited, by the plan's hash, change by change.
    const actions = s.deps.audit.entries
      .filter((e) => e.target === request?.planHash)
      .map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "cloudflare uptime apply started",
        "cloudflare uptime change create-namespace",
        "cloudflare uptime change upload-script",
        "cloudflare uptime change put-secret",
        "cloudflare uptime change put-entry",
      ]),
    );

    // No check key and no GitHub check secrets: the Worker is the check.
    expect(s.github.secrets.size).toBe(0);
    expect(s.handler.requests.map((r) => r.kind)).not.toContain("github-secrets");
    // The webhook's address only went into the Worker's secret.
    expect(s.seen()).not.toContain(WEBHOOK_URL);
  });

  it("asks for the address when the Worker has no secret for the entry, and keeps a stored one", async () => {
    const s = await setup({ env: {}, interactive: true });
    await s.provision(uptimePlan("cloudflare"));
    expect(s.asked).toEqual([
      "Address of the Slack webhook for the uptime check (stored as a secret of the Cloudflare Worker opscrew-uptime)",
    ]);
    expect(s.uptime.scripts.get("opscrew-uptime")?.secrets.has(SECRET)).toBe(true);

    // Run again: nothing is asked, nothing changes, nothing is approved.
    s.handler.requests.length = 0;
    await s.provision(uptimePlan("cloudflare"));
    expect(s.asked).toHaveLength(1);
    expect(s.handler.requests).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      `The uptime Worker already holds the webhook's address for this environment (its secret ${SECRET}), so it is kept.`,
    );
    expect(s.deps.reporter.text()).toContain(
      "The Cloudflare uptime Worker is already set up for this environment; nothing in Cloudflare changes.",
    );
    expect(s.seen()).not.toContain(WEBHOOK_URL);
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
  });

  it("names the other apps' entries it keeps, and creates nothing shared for a second app", async () => {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));
    otherApp(s.uptime);
    // The address changed: the new one replaces the secret.
    s.handler.requests.length = 0;
    s.deps.env.OPSCREW_CHECK_WEBHOOK = `${WEBHOOK_URL}-new`;
    await s.provision(uptimePlan("cloudflare"));
    const [request] = s.handler.requests;
    expect(request?.details).toContain("Keeps the entries of: acme/blog (prod).");
    expect(request?.title).toContain("(1 change)");
    expect(JSON.parse(s.uptime.scripts.get("opscrew-uptime")?.secrets.get(SECRET) ?? "")).toEqual({
      url: `${WEBHOOK_URL}-new`,
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
  });

  it("a refused approval changes nothing in Cloudflare and says how to apply it later", async () => {
    const s = await setup({ answer: () => false });
    await expect(s.provision(uptimePlan("cloudflare"))).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: expect.stringContaining("The Cloudflare uptime plan was not approved"),
      hint: expect.stringContaining("opscrew provision --approve "),
    });
    expect(s.uptime.writes()).toEqual([]);
    expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();
  });

  for (const [what, leaving] of [
    ["moves back to actions", uptimePlan("actions")],
    ["turns the check off", uptimePlan("cloudflare", { enabled: false })],
  ] as const) {
    it(`removes only its entry, state and secret when the environment ${what}, even as the last entry`, async () => {
      const s = await setup();
      await s.provision(uptimePlan("cloudflare"));
      namespaceOf(s.uptime).values.set(uptimeStateKey(ID), '{"hosts":{}}');
      s.handler.requests.length = 0;
      await s.provision(leaving);

      const [request] = s.handler.requests.filter((r) => r.kind === "cloudflare-apply");
      // No typed confirmation: the Worker, its trigger and the namespace stay.
      expect(request?.allowDestroy).toBeUndefined();
      expect(request?.confirmPhrase).toBeUndefined();
      expect(request?.details).toContain("Delete the entry of acme/shop (prod)");
      expect(request?.details).toContain(`Delete the Worker secret ${SECRET}`);
      expect(request?.details).toContain("stay, with no entry");
      const values = namespaceOf(s.uptime).values;
      expect(values.has(uptimeEntryKey(ID))).toBe(false);
      expect(values.has(uptimeStateKey(ID))).toBe(false);
      const script = s.uptime.scripts.get("opscrew-uptime");
      expect(script?.secrets.has(SECRET)).toBe(false);
      expect(script?.crons).toEqual(["*/5 * * * *"]);
      expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();

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
    expect(s.deps.reporter.text()).not.toContain(UPTIME_ONLY_LINE);
  });
});

describe("provisionUptime --plan-only", () => {
  it("shows the plan and its hash for scripts, and changes nothing", async () => {
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
    expect(s.deps.reporter.text()).toContain(
      `The uptime check has a Cloudflare plan of its own: Cloudflare uptime plan ${hash}. In a script, approve it too (\`--approve ${hash}\`).`,
    );
    expect(s.handler.requests).toEqual([]);
    expect(s.uptime.writes()).toEqual([]);
    expect(s.asked).toEqual([]);
    expect(await readUptimeRecord(s.deps.paths)).toBeUndefined();

    // The run that applies makes the same plan, so the hash a script approves is the one shown.
    await s.provision(plan);
    expect(s.handler.requests[0]?.planHash).toBe(hash);
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
  async function status(state: string | undefined, options: { entry?: boolean } = {}) {
    const s = await setup();
    await s.provision(uptimePlan("cloudflare"));
    const values = namespaceOf(s.uptime).values;
    if (state !== undefined) values.set(uptimeStateKey(ID), state);
    if (options.entry === false) values.delete(uptimeEntryKey(ID));
    s.deps.env.CLOUDFLARE_API_TOKEN = fakeSecret("cloudflare-token", "status");
    s.deps.fetch = s.uptime.fetch;
    const lines = await uptimeStatusLines(s.deps, uptimePlan("cloudflare"));
    expect(s.uptime.writes().filter((c) => c.path.includes("status"))).toEqual([]);
    return lines;
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
    expect(lines.slice(2)).toEqual([
      "  Down:",
      "    shop.example.com since 2026-11-25T10:05:00Z: not reachable",
    ]);
  });

  it("says none is down without a state", async () => {
    expect((await status(undefined)).slice(2)).toEqual(["  Down: none"]);
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
