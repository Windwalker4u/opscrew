// Feature 029 (T2935, research R25): the drill database restore drills load a hosting account's
// snapshots into, made by plan B through the panel's connector, removed once drills are off and at
// destroy, its login only in a 0600 file on the account.
import { fakePlesk } from "@opscrew/connector-plesk";
import type { HostingFiles, HostingPanel } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { DRILL_LOGIN_FILE } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy/run";
import { FakeDestroyGitHub, ScriptedApprovalHandler } from "../testing";
import {
  cpanelAccount,
  directAdminAccount,
  type FakeAccount,
  type HostedApp,
  hostedApp,
  hostingTestPlan,
  MemoryFiles,
  PANEL_TOKEN,
  playAgent,
} from "./__fixtures__/account";
import { applyHostingPlan, type HostingApplyContext } from "./apply";
import { panelConnector } from "./panels";
import { type AppPlan, describeHostingPlan, hostingPlanHash } from "./plan";
import {
  agentContents,
  agentSettingsText,
  buildAgentPlan,
  buildAppPlan,
  drillDatabaseNames,
  hostingTarget,
} from "./provision-plans";
import { type HostingObject, readHostingRecord, recordObject } from "./record";

const FOLDER = "opscrew/notes-prod";
const HEADER = {
  panel: "cpanel",
  account: "acct at panel.example.com",
  environment: "prod",
  hostname: "notes.example.com",
  folder: FOLDER,
} as const;
const LIMIT =
  "Your hosting plan allows no more databases, so OpsCrew couldn't make the drill's database. Remove one in the panel or raise the plan's limit, then run again. Nothing was changed.";
/** The password `randomBytes` gives the drill database (32 letters of bytes 11). */
const PASSWORD = "L".repeat(32);

/** The plan with restore drills on. */
const withDrills = (plan: DeployPlan): DeployPlan =>
  DeployPlanSchema.parse({ ...plan, snapshots: { ...plan.snapshots, drills: {} } });

/** Plan B for `app`'s account as provision builds it now, with the plan `plan`. */
async function planB(app: HostedApp, plan: DeployPlan): Promise<AppPlan> {
  const deps = await app.deps();
  return buildAppPlan({
    header: { ...HEADER, panel: app.account.kind },
    plan,
    panel: app.panel,
    files: app.files,
    record: await readHostingRecord(deps.paths),
    facts: await app.panel.inspect(),
    php: undefined,
    values: undefined,
    contents: new Map(),
  });
}

const drillSteps = (plan: AppPlan) => plan.steps.filter((step) => step.kind.includes("drill"));

/** The account's panel through its connector, sharing `redactor` (the panel's token in it). */
function connect(account: FakeAccount, redactor: Redactor): HostingPanel {
  redactor.addLiteral(PANEL_TOKEN, "OPSCREW_HOSTING_TOKEN");
  account.mkdir(`${FOLDER}/keys`);
  return panelConnector(account.kind, account.access, { fetch: account.fetch, redactor });
}

/** What an apply on `panel` needs, each object made or forgotten logged. */
function context(panel: HostingPanel, files: HostingFiles, redactor: Redactor) {
  const made: HostingObject[] = [];
  const forgotten: string[] = [];
  const ctx: HostingApplyContext = {
    panel,
    files,
    made: async (object) => {
      made.push(object);
    },
    forget: async (kind, key) => {
      forgotten.push(`${kind} ${key}`);
    },
    replace: async () => undefined,
    contents: new Map(),
    otherRoots: [],
    redactor,
    sleep: async () => undefined,
    now: () => new Date("2026-11-18T12:00:00.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(11),
  };
  return { ctx, made, forgotten };
}

/** Applies `steps` as an approved plan B on a `panel` account; its error, if any. */
async function apply(
  ctx: HostingApplyContext,
  steps: AppPlan["steps"],
  panel: AppPlan["panel"] = HEADER.panel,
) {
  const plan: AppPlan = { plan: "app", ...HEADER, panel, steps };
  return applyHostingPlan(plan, { ...ctx, approvedHash: hostingPlanHash(plan) }).then(
    () => undefined,
    (error: unknown) => error as Error & { applied?: string[] },
  );
}

describe("the drill database in plan B", () => {
  it("is made last when restore drills are on, saying it counts against the plan's limit", async () => {
    const app = await hostedApp();
    expect(drillSteps(await planB(app, app.plan))).toEqual([]);

    const plan = await planB(app, withDrills(app.plan));
    expect(plan.steps.at(-1)).toEqual({
      kind: "drill-database",
      name: "acct_notes_drill",
      user: "acct_notes_drill",
    });
    const words = describeHostingPlan(plan, hostingPlanHash(plan));
    expect(words).toContain(
      "Make the drill database acct_notes_drill and its user acct_notes_drill, with every privilege on it, for restore drills",
    );
    expect(words).toContain(
      "It is one more database on the account, so it counts against your hosting plan's limit on databases.",
    );
    expect(words).toContain(`~/${FOLDER}/${DRILL_LOGIN_FILE} (0600, outside every web root)`);

    // None for an app without a database: a drill there only lists the shared files.
    const plain = await hostedApp({ database: false });
    expect(drillSteps(await planB(plain, withDrills(plain.plan)))).toEqual([]);
  });

  it("stops at a database of its name OpsCrew didn't make, and goes once drills are off", async () => {
    const app = await hostedApp();
    await app.panel.addDatabase({
      name: "acct_notes_drill",
      user: "acct_notes_drill",
      password: PASSWORD,
    });
    await expect(planB(app, withDrills(app.plan))).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "The account already has the database acct_notes_drill, the name restore drills use, and OpsCrew's record (.opscrew/hosting.json) doesn't list it as OpsCrew's.",
      ),
    });

    const deps = await app.deps();
    await recordObject(deps.paths, { kind: "drill-database", key: "acct_notes_drill" });
    expect(drillSteps(await planB(app, withDrills(app.plan)))).toEqual([]);
    const off = await planB(app, app.plan);
    expect(drillSteps(off)).toEqual([
      { kind: "remove-drill-database", name: "acct_notes_drill", user: "acct_notes_drill" },
    ]);
    expect(describeHostingPlan(off, hostingPlanHash(off))).toContain(
      `Remove the drill database acct_notes_drill, its user acct_notes_drill and its login ~/${FOLDER}/${DRILL_LOGIN_FILE}`,
    );
  });

  it("fits its names in the panel's limits, the prefix included", () => {
    const target = hostingTarget(withDrills(hostingTestPlan()));
    const databases = { engines: ["mariadb" as const], prefix: "acct_" };
    expect(drillDatabaseNames(target, { databases })).toEqual({
      name: "acct_notes_drill",
      user: "acct_notes_drill",
    });
    // A user name of at most 16, where an underscore counts twice: acct_not_drill costs 16.
    expect(drillDatabaseNames(target, { databases: { ...databases, maxUserName: 16 } })).toEqual({
      name: "acct_not_drill",
      user: "acct_not_drill",
    });
  });
});

describe("applying the drill database", () => {
  it("makes it with its own login, written only into a 0600 file on the account", async () => {
    const account = cpanelAccount();
    const redactor = new Redactor();
    const panel = connect(account, redactor);
    const { ctx, made } = context(panel, panel, redactor);
    const step = {
      kind: "drill-database",
      name: "acct_notes_drill",
      user: "acct_notes_drill",
    } as const;
    expect(await apply(ctx, [step])).toBeUndefined();
    expect(account.databases()).toEqual(["acct_notes_drill"]);
    expect(account.cpanel?.state.databases.get("acct_notes_drill")?.users).toEqual(
      new Set(["acct_notes_drill"]),
    );
    expect(account.read(`${FOLDER}/${DRILL_LOGIN_FILE}`)).toBe(
      `[client]\nuser=acct_notes_drill\npassword=${PASSWORD}\nhost=localhost\n[mysql]\ndatabase=acct_notes_drill\n`,
    );
    expect(account.cpanel?.state.files.get(`${FOLDER}/${DRILL_LOGIN_FILE}`)).toMatchObject({
      mode: 0o600,
    });
    expect(made).toEqual([{ kind: "drill-database", key: "acct_notes_drill" }]);
    expect(redactor.redact(`the login ${PASSWORD}`)).not.toContain(PASSWORD);

    // Once drills are off: the database, its user and its login go.
    const { ctx: off, forgotten } = context(panel, panel, redactor);
    expect(await apply(off, [{ ...step, kind: "remove-drill-database" }])).toBeUndefined();
    expect(account.databases()).toEqual([]);
    expect(account.cpanel?.state.databaseUsers.has("acct_notes_drill")).toBe(false);
    expect(account.read(`${FOLDER}/${DRILL_LOGIN_FILE}`)).toBeUndefined();
    expect(forgotten).toEqual(["drill-database acct_notes_drill"]);
  });

  it("says plainly that Plesk's plan allows no more databases, and changes nothing", async () => {
    const fake = fakePlesk({
      token: PANEL_TOKEN,
      failures: { "database.add-db": { errcode: "1024", errtext: "Limit reached" } },
    });
    const redactor = new Redactor();
    const panel = panelConnector(
      "plesk",
      { url: fake.url, user: fake.login, token: PANEL_TOKEN },
      { fetch: fake.fetch, redactor },
    );
    const files = new MemoryFiles();
    const { ctx, made } = context(panel, files, redactor);
    const step = { kind: "drill-database", name: "notes_drill", user: "notes_drill" } as const;
    // No step after it runs.
    const error = await apply(
      ctx,
      [step, { kind: "certificate", hostname: "notes.example.com" }],
      "plesk",
    );
    expect(error).toMatchObject({ code: "PHASE_PRECONDITION", message: LIMIT, applied: [] });
    expect(fake.state.databases).toEqual([]);
    expect(files.files.size).toBe(0);
    expect(made).toEqual([]);
  });

  it("shows cPanel's and DirectAdmin's own reason, redacted, when they refuse it", async () => {
    const account = cpanelAccount();
    const redactor = new Redactor();
    const panel = connect(account, redactor);
    // A panel that echoes what it was given: the drill database's new password stays hidden.
    account.cpanel?.failNext(
      "Mysql",
      "create_database",
      `The account has reached its limit of databases (${PASSWORD}).`,
    );
    const { ctx, made } = context(panel, panel, redactor);
    const step = {
      kind: "drill-database",
      name: "acct_notes_drill",
      user: "acct_notes_drill",
    } as const;
    const error = await apply(ctx, [step]);
    expect(error?.message).toMatch(
      /^cPanel refused to create the database acct_notes_drill: The account has reached its limit of databases \(.+\)\. Nothing was changed\.$/,
    );
    expect(error?.message).not.toContain(PASSWORD);
    expect(account.databases()).toEqual([]);
    expect(account.read(`${FOLDER}/${DRILL_LOGIN_FILE}`)).toBeUndefined();
    expect(made).toEqual([]);

    const da = directAdminAccount();
    da.directadmin?.failNext("POST /api/db-manage/create-db-with-user", {
      status: 400,
      body: { type: "LIMIT_EXCEEDED", message: "You have reached your database limit" },
    });
    const daRedactor = new Redactor();
    const daPanel = connect(da, daRedactor);
    const daContext = context(daPanel, daPanel, daRedactor);
    const daError = await apply(
      daContext.ctx,
      [{ kind: "drill-database", name: "alice_notes_drill", user: "alice_notes_drill" }],
      "directadmin",
    );
    expect(daError?.message).toMatch(
      /^DirectAdmin could not create the database alice_notes_drill with its user alice_notes_drill \(HTTP 400\).*\. Nothing was changed\.$/,
    );
    expect(da.databases()).toEqual([]);
    expect(da.read(`${FOLDER}/${DRILL_LOGIN_FILE}`)).toBeUndefined();
    expect(daContext.made).toEqual([]);
  });
});

describe("the drill schedule in the agent's settings", () => {
  /** `plan` with drills on a schedule of `every`. */
  const scheduled = (plan: DeployPlan, every: "weekly" | "daily"): DeployPlan =>
    DeployPlanSchema.parse({ ...plan, snapshots: { drills: { schedule: every } } });
  const settingsOf = (plan: DeployPlan) =>
    agentSettingsText(plan, { repository: "acme/notes", laravel: false, database: "acct_notes" });

  it("carries snapshots.drills.schedule, and none with drills by hand or off", () => {
    const plan = hostingTestPlan();
    expect(settingsOf(scheduled(plan, "weekly"))).toContain("\nDRILL_SCHEDULE='weekly'\n");
    expect(settingsOf(scheduled(plan, "daily"))).toContain("\nDRILL_SCHEDULE='daily'\n");
    expect(settingsOf(withDrills(plan))).toContain("\nDRILL_SCHEDULE=''\n");
    expect(settingsOf(plan)).toContain("\nDRILL_SCHEDULE=''\n");
  });

  it("names the schedule and every bound on the step that writes the settings, in either plan", async () => {
    const app = await hostedApp();
    const plan = scheduled(app.plan, "weekly");
    const deps = await app.deps();
    const b = await buildAppPlan({
      header: HEADER,
      plan,
      panel: app.panel,
      files: app.files,
      record: await readHostingRecord(deps.paths),
      facts: await app.panel.inspect(),
      php: undefined,
      values: undefined,
      contents: new Map([["settings.sh", settingsOf(plan)]]),
    });
    expect(b.steps.find((step) => step.kind === "file")).toMatchObject({
      path: "settings.sh",
      drills: "weekly",
    });
    const words = describeHostingPlan(b, hostingPlanHash(b));
    for (const part of [
      "OpsCrew's agent runs a restore drill itself, weekly, on Thursdays from 03:00 UTC, with no call to the panel",
      `the newest snapshot in ~/${FOLDER}/dumps/ into the drill database through that database's own login (${DRILL_LOGIN_FILE})`,
      "only the drill database, never the app's database or its files",
      "only the newest snapshot",
      "no network, and the app isn't started",
      "what a stopped run left in the drill database is dropped first",
      "under the agent's lock after its releases",
      "skipped, never failed, when the account's disk quota leaves less room than the snapshot's dump",
      "at most 30 minutes, then it is stopped and the drill database emptied",
      `~/${FOLDER}/state/drills.log, which \`opscrew status\` shows`,
      "The agent runs as the account's user, so anything that user can run can exceed these bounds.",
    ]) {
      expect(words).toContain(part);
    }
    // The schedule is in the plan's hash: daily is another plan.
    const daily = scheduled(app.plan, "daily");
    const d = await buildAppPlan({
      header: HEADER,
      plan: daily,
      panel: app.panel,
      files: app.files,
      record: await readHostingRecord(deps.paths),
      facts: await app.panel.inspect(),
      php: undefined,
      values: undefined,
      contents: new Map([["settings.sh", settingsOf(daily)]]),
    });
    expect(hostingPlanHash(d)).not.toBe(hostingPlanHash(b));
    expect(describeHostingPlan(d, hostingPlanHash(d))).toContain("daily, from 03:00 UTC");

    // Plan A's first settings carry it too, and its folder step says so.
    const a = await buildAgentPlan({
      header: HEADER,
      panel: app.panel,
      files: new MemoryFiles(),
      record: undefined,
      contents: agentContents(settingsOf(plan), []),
    });
    expect(a.steps[0]).toMatchObject({ kind: "folder", drills: "weekly" });
    expect(describeHostingPlan(a, hostingPlanHash(a))).toContain(
      "OpsCrew's agent runs a restore drill itself, weekly",
    );

    // Without a schedule, the settings' step says nothing of drills.
    const off = await buildAgentPlan({
      header: HEADER,
      panel: app.panel,
      files: new MemoryFiles(),
      record: undefined,
      contents: agentContents(settingsOf(app.plan), []),
    });
    expect(off.steps[0]).not.toHaveProperty("drills");
    expect(describeHostingPlan(off, hostingPlanHash(off))).not.toContain("restore drill");
  });
});

describe("a drill database cPanel made before refusing its user", () => {
  const step = {
    kind: "drill-database",
    name: "acct_notes_drill",
    user: "acct_notes_drill",
  } as const;

  it("is removed again before the stop, so the next provision makes it anew", async () => {
    const account = cpanelAccount();
    const redactor = new Redactor();
    const panel = connect(account, redactor);
    account.cpanel?.failNext("Mysql", "create_user", "The account has reached its limit of users.");
    const { ctx, made } = context(panel, panel, redactor);
    const error = await apply(ctx, [step]);
    expect(error?.message).toBe(
      "cPanel refused to create the database user acct_notes_drill: The account has reached its limit of users. Nothing was changed.",
    );
    expect(account.databases()).toEqual([]);
    expect(account.read(`${FOLDER}/${DRILL_LOGIN_FILE}`)).toBeUndefined();
    expect(made).toEqual([]);

    // The next run makes it: no database of its name is left to stop at.
    const again = context(panel, panel, redactor);
    expect(await apply(again.ctx, [step])).toBeUndefined();
    expect(account.databases()).toEqual(["acct_notes_drill"]);
  });

  it("says so, with what to remove in the panel, when removing it again fails too", async () => {
    const account = cpanelAccount();
    const redactor = new Redactor();
    const panel = connect(account, redactor);
    account.cpanel?.failNext("Mysql", "create_user", `No more users (${PASSWORD}).`);
    account.cpanel?.failNext("Mysql", "delete_database", "The database is busy.");
    const { ctx, made } = context(panel, panel, redactor);
    const error = await apply(ctx, [step]);
    expect(error?.message).toMatch(
      /^cPanel refused to create the database user acct_notes_drill: No more users \(.+\)\. The panel had made the drill database acct_notes_drill before that, and removing it again failed too: .*The database is busy\..* Nothing was changed before it\.$/,
    );
    expect(error?.message).not.toContain(PASSWORD);
    expect(error).toMatchObject({
      hint: "Remove the database acct_notes_drill and its user acct_notes_drill in the panel, then run `opscrew provision` again.",
    });
    expect(account.databases()).toEqual(["acct_notes_drill"]);
    expect(made).toEqual([]);
  });
});

describe("destroy with a drill database", () => {
  it("removes it and its user with the app's", async () => {
    const app = await hostedApp();
    await app.panel.addDatabase({
      name: "acct_notes_drill",
      user: "acct_notes_drill",
      password: PASSWORD,
    });
    const setup = await app.deps();
    await recordObject(setup.paths, { kind: "drill-database", key: "acct_notes_drill" });
    await writeArtifact("plan", setup.paths.files.plan, withDrills(app.plan));
    const agent = playAgent(app);
    const github = Object.assign(new FakeDestroyGitHub([]), {
      async removeDeployKey() {
        return "deleted" as const;
      },
      async deleteBranch() {
        return "deleted" as const;
      },
    });
    const handler = new ScriptedApprovalHandler(() => true);
    const deps = await app.deps(handler);
    await runDestroy(deps, { services: { github, sleep: agent.sleep } });
    const approval = handler.requests.find((request) => request.kind === "hosting-apply");
    expect(approval?.details).toContain(
      "Remove the database acct_notes_drill and its user acct_notes_drill",
    );
    expect(app.account.databases()).toEqual([]);
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([]);
    expect(`${deps.reporter.text()}${JSON.stringify(deps.audit.entries)}`).not.toContain(
      PANEL_TOKEN,
    );
  });
});
