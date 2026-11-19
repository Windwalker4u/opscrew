// Feature 029 (T2951, US10, FR-2925): an app's PostgreSQL database on a cPanel account whose host
// installed it, through the fake cPanel's `Postgresql::*`: plan B makes it and the drill database
// with their `pgpass` logins, the app gets `postgresql://` values, and drift and destroy reach it
// on PostgreSQL; MySQL's databases on the same account are never taken for it.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HostingPanel } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DRILL_PGPASS_FILE, renderAgentSettings } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDestroy } from "../destroy/run";
import { FakeDestroyGitHub, ScriptedApprovalHandler } from "../testing";
import {
  type FakeAccount,
  type HostedApp,
  hostedApp,
  hostingTestPlan,
  MemoryFiles,
  PANEL_TOKEN,
  playAgent,
  postgresAccount,
} from "./__fixtures__/account";
import {
  applyHostingPlan,
  databaseValues,
  type HostingApplyContext,
  pgpassLine,
  settingsText,
  valuesDigest,
} from "./apply";
import { HostingDestroyPlanSchema } from "./destroy";
import { hostingDrift } from "./drift";
import { panelConnector } from "./panels";
import { type AppPlan, describeHostingPlan, hostingPlanHash } from "./plan";
import { buildAppPlan, drillDatabaseNames, hostingTarget } from "./provision-plans";
import { type HostingObject, readHostingRecord, recordObject, updateHostingRecord } from "./record";
import { hostingSecurityChecks } from "./secure";

const FOLDER = "opscrew/notes-prod";
const HEADER = {
  panel: "cpanel",
  account: "acct at panel.example.com",
  environment: "prod",
  hostname: "notes.example.com",
  folder: FOLDER,
} as const;
/** The password `randomBytes` gives (32 letters of bytes 11). */
const PASSWORD = "L".repeat(32);
const DATABASE = { name: "acct_notes", user: "acct_notes", server: "postgres" } as const;
const DRILL = { name: "acct_notes_drill", user: "acct_notes_drill", server: "postgres" } as const;

/** The plan with restore drills on. */
const withDrills = (plan: DeployPlan, drills: object = {}): DeployPlan =>
  DeployPlanSchema.parse({ ...plan, snapshots: { ...plan.snapshots, drills } });

/** Plan B for `app`'s account as provision builds it now, with `plan` and these contents. */
async function planB(
  app: HostedApp,
  plan: DeployPlan,
  contents: Map<string, string> = new Map(),
): Promise<AppPlan> {
  const deps = await app.deps();
  return buildAppPlan({
    header: HEADER,
    plan,
    panel: app.panel,
    files: app.files,
    record: await readHostingRecord(deps.paths),
    facts: await app.panel.inspect(),
    php: undefined,
    values: undefined,
    contents,
  });
}

/** A PostgreSQL app whose database OpsCrew didn't make yet: none on the account, none recorded. */
async function withoutDatabase(): Promise<HostedApp> {
  const app = await hostedApp({ postgres: true });
  const fake = app.account.cpanel;
  fake?.state.postgresDatabases.clear();
  fake?.state.postgresUsers.clear();
  await updateHostingRecord((await app.deps()).paths, (current) => ({
    ...current,
    objects: current.objects.filter((o) => o.kind !== "database"),
  }));
  return app;
}

/** The fake cPanel's calls since `from`, as `Module::func`. */
const callsOf = (account: FakeAccount, from = 0) =>
  (account.cpanel?.calls ?? []).slice(from).map((call) => `${call.module}::${call.func}`);

/** A PostgreSQL account's panel and what an apply on it needs, objects made and forgotten logged. */
function context(account: FakeAccount = postgresAccount()) {
  const redactor = new Redactor();
  redactor.addLiteral(PANEL_TOKEN, "OPSCREW_HOSTING_TOKEN");
  account.mkdir(`${FOLDER}/keys`);
  account.mkdir(`${FOLDER}/shared`);
  const panel: HostingPanel = panelConnector(account.kind, account.access, {
    fetch: account.fetch,
    redactor,
  });
  const made: HostingObject[] = [];
  const forgotten: string[] = [];
  const ctx: HostingApplyContext = {
    panel,
    files: panel,
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
    now: () => new Date("2026-11-19T12:00:00.000Z"),
    randomBytes: (size) => new Uint8Array(size).fill(11),
  };
  return { account, panel, ctx, made, forgotten };
}

/** Applies `steps` as an approved plan B; its error, if any. */
async function apply(ctx: HostingApplyContext, steps: AppPlan["steps"]) {
  const plan: AppPlan = { plan: "app", ...HEADER, steps };
  return applyHostingPlan(plan, { ...ctx, approvedHash: hostingPlanHash(plan) }).then(
    () => undefined,
    (error: unknown) => error as Error & { applied?: string[] },
  );
}

describe("plan B with a PostgreSQL database", () => {
  it("makes it on PostgreSQL, listing PostgreSQL's databases, its words naming pgpass", async () => {
    const app = await withoutDatabase();
    // A MySQL database of its name is another server's: it doesn't stop the plan.
    await app.panel.addDatabase({ ...DATABASE, server: "mysql", password: PASSWORD });
    const from = app.account.cpanel?.calls.length ?? 0;
    const plan = await planB(app, app.plan);
    expect(plan.steps.filter((step) => step.kind === "database")).toEqual([
      { kind: "database", ...DATABASE },
    ]);
    const calls = callsOf(app.account, from);
    expect(calls).toContain("Postgresql::list_databases");
    expect(calls).not.toContain("Mysql::list_databases");
    const words = describeHostingPlan(plan, hostingPlanHash(plan));
    expect(words).toContain(
      "Make the PostgreSQL database acct_notes and its user acct_notes, with every privilege on it",
    );
    expect(words).toContain(
      `Its password is generated now and written only into ~/${FOLDER}/shared/.env and shared/pgpass (0600, outside every web root).`,
    );
    expect(words).not.toContain("mysql.cnf");
  });

  it("stops at a PostgreSQL database of its name OpsCrew didn't make", async () => {
    const app = await withoutDatabase();
    await app.panel.addDatabase({ ...DATABASE, password: PASSWORD });
    await expect(planB(app, app.plan)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
      message: expect.stringContaining(
        "The account already has the database acct_notes, and OpsCrew's record (.opscrew/hosting.json) doesn't list it as OpsCrew's.",
      ),
    });
  });

  it("plans the drill database on PostgreSQL within PostgreSQL's limits, and its removal", async () => {
    const app = await hostedApp({ postgres: true });
    const plan = await planB(app, withDrills(app.plan));
    expect(plan.steps.at(-1)).toEqual({ kind: "drill-database", ...DRILL });
    const words = describeHostingPlan(plan, hostingPlanHash(plan));
    expect(words).toContain(
      "Make the PostgreSQL drill database acct_notes_drill and its user acct_notes_drill, with every privilege on it, for restore drills",
    );
    expect(words).toContain(`~/${FOLDER}/${DRILL_PGPASS_FILE} (0600, outside every web root)`);

    // A PostgreSQL database of its name OpsCrew didn't make stops it.
    await app.panel.addDatabase({ ...DRILL, password: PASSWORD });
    await expect(planB(app, withDrills(app.plan))).rejects.toMatchObject({
      message: expect.stringContaining(
        "The account already has the database acct_notes_drill, the name restore drills use",
      ),
    });

    // Recorded as PostgreSQL's, it goes on PostgreSQL once drills are off, with its pgpass login.
    const deps = await app.deps();
    await recordObject(deps.paths, { kind: "drill-database", key: DRILL.name, value: "postgres" });
    const off = await planB(app, app.plan);
    expect(off.steps.filter((step) => step.kind.includes("drill"))).toEqual([
      { kind: "remove-drill-database", ...DRILL },
    ]);
    expect(describeHostingPlan(off, hostingPlanHash(off))).toContain(
      `Remove the PostgreSQL drill database acct_notes_drill, its user acct_notes_drill and its login ~/${FOLDER}/${DRILL_PGPASS_FILE}`,
    );
  });

  it("fits the drill database's names in PostgreSQL's own limits, not MySQL's", () => {
    const target = hostingTarget(withDrills(hostingTestPlan({ postgres: true })));
    const databases = {
      engines: ["mariadb" as const, "postgres" as const],
      prefix: "acct_",
      maxUserName: 16,
    };
    expect(
      drillDatabaseNames(target, {
        databases: { ...databases, postgres: { maxDatabaseName: 63, maxUserName: 63 } },
      }),
    ).toEqual(DRILL);
    expect(
      drillDatabaseNames(target, {
        databases: { ...databases, postgres: { maxDatabaseName: 63, maxUserName: 16 } },
      }),
    ).toEqual({ name: "acct_not_drill", user: "acct_not_drill", server: "postgres" });
  });

  it("names the drill database's pgpass login in the scheduled drills' bounds", async () => {
    const app = await hostedApp({ postgres: true });
    const plan = withDrills(app.plan, { schedule: "weekly" });
    const settings = renderAgentSettings({
      app: "notes",
      environment: "prod",
      hostname: "notes.example.com",
      repository: "acme/notes",
      releaseBranch: "opscrew/release/prod",
      webRoot: "public",
      healthPath: "/",
      appKind: "php",
      sharedPaths: [],
      snapshots: true,
      database: DATABASE.name,
      databaseEngine: "postgres",
      drillSchedule: "weekly",
    });
    const b = await planB(app, plan, new Map([["settings.sh", settings]]));
    expect(b.steps.find((step) => step.kind === "file")).toMatchObject({
      path: "settings.sh",
      drills: "weekly",
      server: "postgres",
    });
    expect(describeHostingPlan(b, hostingPlanHash(b))).toContain(
      `into the drill database through that database's own login (${DRILL_PGPASS_FILE})`,
    );
  });
});

describe("applying a PostgreSQL database", () => {
  it("writes shared/pgpass (0600) before the panel makes it, and fills postgresql:// values", async () => {
    const { account, ctx, made } = context();
    const values = { NOTES_API_KEY: "kept" };
    const keys = [
      "DATABASE_URL",
      "DB_DATABASE",
      "DB_HOST",
      "DB_PASSWORD",
      "DB_PORT",
      "DB_USERNAME",
    ];
    const plan: AppPlan = {
      plan: "app",
      ...HEADER,
      steps: [
        { kind: "database", ...DATABASE },
        {
          kind: "values",
          file: ".env",
          keys: [...keys, "NOTES_API_KEY"],
          database: keys,
          generated: ["DB_PASSWORD"],
          digest: valuesDigest(values),
        },
      ],
    };
    const result = await applyHostingPlan(plan, {
      ...ctx,
      values,
      database: DATABASE,
      approvedHash: hostingPlanHash(plan),
    });
    expect(result.applied).toEqual(["database", "values"]);
    const fake = account.cpanel;
    expect(account.read(`${FOLDER}/shared/pgpass`)).toBe(
      `localhost:5432:acct_notes:acct_notes:${PASSWORD}\n`,
    );
    expect(fake?.state.files.get(`${FOLDER}/shared/pgpass`)).toMatchObject({ mode: 0o600 });
    expect(account.read(`${FOLDER}/shared/mysql.cnf`)).toBeUndefined();
    // The login is on the account before the panel makes the database.
    const calls = callsOf(account);
    expect(calls.indexOf("Fileman::upload_files")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("Fileman::upload_files")).toBeLessThan(
      calls.indexOf("Postgresql::create_database"),
    );
    expect(fake?.state.postgresDatabases.get("acct_notes")).toEqual(new Set(["acct_notes"]));
    expect(fake?.state.databases.size).toBe(0);
    expect(made).toEqual([
      { kind: "database", key: "acct_notes", value: "postgres" },
      { kind: "file", key: `${FOLDER}/shared/.env`, value: valuesDigest(values) },
    ]);
    expect(account.read(`${FOLDER}/shared/.env`)).toBe(
      settingsText({
        ...values,
        DATABASE_URL: `postgresql://acct_notes:${PASSWORD}@localhost:5432/acct_notes`,
        DB_DATABASE: "acct_notes",
        DB_HOST: "localhost",
        DB_PASSWORD: PASSWORD,
        DB_PORT: "5432",
        DB_USERNAME: "acct_notes",
      }),
    );
    expect(JSON.stringify(plan)).not.toContain(PASSWORD);
    expect(ctx.redactor.redact(`x ${PASSWORD} y`)).not.toContain(PASSWORD);
  });

  it("reads the password back from shared/pgpass on a later run, its escapes undone", async () => {
    const { ctx } = context();
    const files = new MemoryFiles();
    // A password with the characters pgpass escapes (OpsCrew's own are letters and digits).
    const password = `${fakeSecret("generic-password", "pgpass")}:\\`;
    const line = pgpassLine({ ...DATABASE, password });
    expect(line).toBe(`localhost:5432:acct_notes:acct_notes:${password.slice(0, -2)}\\:\\\\\n`);
    await files.writeFile(`${FOLDER}/shared/pgpass`, new TextEncoder().encode(line));
    const values = { NOTES_API_KEY: "kept" };
    const step: AppPlan["steps"][number] = {
      kind: "values",
      file: ".env",
      keys: ["DB_PASSWORD", "NOTES_API_KEY"],
      database: ["DB_PASSWORD"],
      generated: ["DB_PASSWORD"],
      digest: valuesDigest(values),
    };
    const later = { ...ctx, files, values, database: DATABASE };
    expect(await apply(later, [step])).toBeUndefined();
    expect(files.files.get(`${FOLDER}/shared/.env`)).toBe(
      settingsText({ ...values, DB_PASSWORD: password }),
    );

    // Without the login, it says which file it couldn't read.
    const error = await apply({ ...later, files: new MemoryFiles() }, [step]);
    expect(error?.message).toContain(
      `OpsCrew can't read the database's password from ~/${FOLDER}/shared/pgpass, so it can't write the app's settings.`,
    );
  });

  it("fills port 5432 and a postgresql:// URL, the names as MySQL's", () => {
    expect(
      databaseValues(["DATABASE_URL", "DB_HOST", "DB_NAME", "DB_PASS", "DB_PORT", "DB_USER"], {
        ...DATABASE,
        password: "p4ss",
      }),
    ).toEqual({
      DATABASE_URL: "postgresql://acct_notes:p4ss@localhost:5432/acct_notes",
      DB_HOST: "localhost",
      DB_NAME: "acct_notes",
      DB_PASS: "p4ss",
      DB_PORT: "5432",
      DB_USER: "acct_notes",
    });
  });
});

describe("applying a PostgreSQL drill database", () => {
  it("makes it with keys/drill.pgpass (0600), and removes both once drills are off", async () => {
    const { account, ctx, made } = context();
    expect(await apply(ctx, [{ kind: "drill-database", ...DRILL }])).toBeUndefined();
    const fake = account.cpanel;
    expect(fake?.state.postgresDatabases.get(DRILL.name)).toEqual(new Set([DRILL.user]));
    expect(fake?.state.databases.size).toBe(0);
    expect(account.read(`${FOLDER}/${DRILL_PGPASS_FILE}`)).toBe(
      `localhost:5432:acct_notes_drill:acct_notes_drill:${PASSWORD}\n`,
    );
    expect(fake?.state.files.get(`${FOLDER}/${DRILL_PGPASS_FILE}`)).toMatchObject({
      mode: 0o600,
    });
    expect(made).toEqual([{ kind: "drill-database", key: DRILL.name, value: "postgres" }]);

    const off = context(account);
    expect(await apply(off.ctx, [{ kind: "remove-drill-database", ...DRILL }])).toBeUndefined();
    expect(fake?.state.postgresDatabases.size).toBe(0);
    expect(fake?.state.postgresUsers.size).toBe(0);
    expect(account.read(`${FOLDER}/${DRILL_PGPASS_FILE}`)).toBeUndefined();
    expect(off.forgotten).toEqual([`drill-database ${DRILL.name}`]);
  });

  it("removes one cPanel made before refusing its user, on PostgreSQL, before the stop", async () => {
    const { account, ctx, made } = context();
    account.cpanel?.failNext("Postgresql", "create_user", `No more users (${PASSWORD}).`);
    const error = await apply(ctx, [{ kind: "drill-database", ...DRILL }]);
    expect(error?.message).toMatch(
      /acct_notes_drill: No more users \(.+\)\. Nothing was changed\.$/,
    );
    expect(error?.message).not.toContain(PASSWORD);
    const calls = callsOf(account);
    expect(calls).toContain("Postgresql::delete_database");
    expect(calls.filter((call) => call.startsWith("Mysql::"))).toEqual([]);
    expect(account.cpanel?.state.postgresDatabases.size).toBe(0);
    expect(account.read(`${FOLDER}/${DRILL_PGPASS_FILE}`)).toBeUndefined();
    expect(made).toEqual([]);
  });
});

/** The committed agent and settings, the same as the account's copies. */
async function commit(app: HostedApp) {
  await mkdir(join(app.root, "opscrew/hosting"), { recursive: true });
  await writeFile(join(app.root, "opscrew/hosting/agent.sh"), "#!/bin/bash\n");
  await writeFile(join(app.root, "opscrew/hosting/prod.sh"), "APP='notes'\n");
}

describe("drift with a PostgreSQL database", () => {
  it("finds it among PostgreSQL's databases, and says when it is gone", async () => {
    const app = await hostedApp({ postgres: true });
    await commit(app);
    const deps = await app.deps();
    const recorded = (await readHostingRecord(deps.paths))?.objects.find(
      (o) => o.kind === "deploy-key",
    );
    const github = {
      listDeployKeys: async () => [
        { id: 4001, title: "opscrew-notes-prod", key: recorded?.value ?? "", readOnly: true },
      ],
    };
    const from = app.account.cpanel?.calls.length ?? 0;
    expect(await hostingDrift(deps, app.plan, { github })).toMatchObject({
      clean: true,
      hosting: [],
    });
    expect(callsOf(app.account, from)).toContain("Postgresql::list_databases");
    expect(callsOf(app.account, from)).not.toContain("Mysql::list_databases");

    // Gone from PostgreSQL: a MySQL database of its name doesn't stand in for it.
    app.account.cpanel?.state.postgresDatabases.delete("acct_notes");
    await app.panel.addDatabase({ ...DATABASE, server: "mysql", password: PASSWORD });
    const report = await hostingDrift(await app.deps(), app.plan, { github });
    expect(report.hosting?.map((d) => d.title)).toEqual([
      "The database acct_notes is gone from the account",
    ]);
  });
});

describe("destroy with a PostgreSQL database", () => {
  it("removes it and the drill database on PostgreSQL, leaving MySQL's as they are", async () => {
    const app = await hostedApp({ postgres: true });
    await app.panel.addDatabase({ ...DRILL, password: PASSWORD });
    // The user's own MySQL database, of the app's database's name.
    await app.panel.addDatabase({ ...DATABASE, server: "mysql", password: PASSWORD });
    const setup = await app.deps();
    await recordObject(setup.paths, { kind: "drill-database", key: DRILL.name, value: "postgres" });
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
    await runDestroy(deps, { snapshot: false, services: { github, sleep: agent.sleep } });

    const plan = HostingDestroyPlanSchema.parse(
      JSON.parse(
        await readFile(join(deps.paths.files.plansDir, "hosting-prod-destroy.json"), "utf8"),
      ),
    );
    expect(plan.steps.filter((step) => step.kind === "database")).toEqual([
      { kind: "database", ...DATABASE },
      { kind: "database", ...DRILL },
    ]);
    const approval = handler.requests.find((request) => request.kind === "hosting-apply");
    expect(approval?.details).toContain(
      "Remove the PostgreSQL database acct_notes and its user acct_notes",
    );
    const fake = app.account.cpanel;
    expect(fake?.state.postgresDatabases.size).toBe(0);
    expect(fake?.state.postgresUsers.size).toBe(0);
    expect([...(fake?.state.databases.keys() ?? [])]).toEqual(["acct_notes"]);
    expect((await readHostingRecord(deps.paths))?.objects).toEqual([]);
    expect(`${deps.reporter.text()}${JSON.stringify(deps.audit.entries)}`).not.toContain(
      PANEL_TOKEN,
    );
  });
});

describe("secure with a PostgreSQL database", () => {
  it("names pgpass among the settings files OpsCrew writes 0600", async () => {
    const app = await hostedApp({ postgres: true });
    const security = await hostingSecurityChecks(await app.deps(), app.plan, {
      fetch: async () =>
        new Response(null, { status: 301, headers: { location: "https://notes.example.com/" } }),
    });
    const modes = security.checks.find((check) => check.id === "hosting-file-modes");
    expect(modes?.message).toContain(
      "OpsCrew writes the settings files (shared/.env, env.php, pgpass) 0600",
    );
  });
});
