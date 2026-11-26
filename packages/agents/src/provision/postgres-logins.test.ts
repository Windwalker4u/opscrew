import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_SECRETS, RELEASE_DB_ENV, serviceEnvSecret } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { FakeComputer, localPlan, localProject } from "../localhost/__fixtures__/computer";
import { parseDotenv } from "../shared/app-env";
import { generatedValuesFile } from "../shared/app-secrets";
import { SH_AVAILABLE } from "../snapshot/__fixtures__/server";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { noOtherApps } from "../testing/other-apps";
import { type KeptLogins, loginsNotices, loginsSwitch, requireLogins } from "./postgres-logins";
import { runProvision } from "./run";
import { buildAppEnvironment, deploySecretNames, deploySecrets } from "./secrets";
import type { ProvisionServices } from "./types";

const DEPLOYED_AT = "2026-10-20T08:00:00.000Z";
const HCLOUD = fakeSecret("hcloud-token");
const STRIPE = fakeSecret("stripe-live-key");

/** `plan` with its db at `version` and `options`, deployed when `deployed`. */
function planWith(
  db: { version?: string; options?: Record<string, unknown> },
  deployed = true,
  plan = testPlan(),
): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    services: plan.services.map((s) => (s.name === "db" ? { ...s, ...db } : s)),
    ...(deployed ? { deployment: { ...plan.deployment, firstDeployAt: DEPLOYED_AT } } : {}),
  });
}

const SEPARATE = { options: { logins: "separate" } };
const SINGLE = { options: {} };
const COMMAND = "opscrew provision";
/** This environment's generated values for a database made before 047: the superuser's password. */
const BEFORE_047 = { dbPassword: fakeSecret("generic-password", "superuser") };
/** The generated values of a database with its two logins. */
const WITH_LOGINS = {
  ...BEFORE_047,
  services: {
    db: {
      "owner-password": fakeSecret("generic-password", "owner"),
      "runtime-password": fakeSecret("generic-password", "runtime"),
    },
  },
};

describe("provision's texts for PostgreSQL's two logins (047)", () => {
  it("tells an environment whose superuser's password is kept, without logins, how to switch, every run, deployed or not", () => {
    expect(loginsNotices(planWith(SINGLE, false), BEFORE_047, COMMAND)).toEqual(
      loginsNotices(planWith(SINGLE), BEFORE_047, COMMAND),
    );
    expect(loginsNotices(planWith(SINGLE), BEFORE_047, COMMAND)).toEqual([
      "Your app logs in to PostgreSQL (db) as its superuser. To give it a login that can only read and write data, add `logins: separate` under db's options in opscrew/plan.yaml and run `npx opscrew provision`: it shows the switch before anything changes.",
    ]);
  });

  it("says below 15 that separate logins come with an upgrade, and refuses nothing", () => {
    const plan = planWith({ version: "14", options: {} });
    expect(loginsNotices(plan, BEFORE_047, COMMAND)).toEqual([
      "db runs PostgreSQL 14, so your app logs in as its superuser. Separate logins for the app and its migrations come with an upgrade to PostgreSQL 15 or later.",
    ]);
    expect(() => requireLogins(plan, BEFORE_047, COMMAND)).not.toThrow();
  });

  it("says nothing without the superuser's password (a new database), nor with logins", () => {
    expect(loginsNotices(planWith(SINGLE), {}, COMMAND)).toEqual([]);
    expect(loginsNotices(planWith(SEPARATE), BEFORE_047, COMMAND)).toEqual([]);
  });

  it("refuses a hand-written logins: separate below 15", () => {
    const plan = planWith({ version: "14", ...SEPARATE }, false);
    expect(() => requireLogins(plan, {}, COMMAND)).toThrow(
      "PostgreSQL 14 can't use separate logins (OpsCrew's setup needs psql 15 or later). Upgrade db to 17 first, then add `logins: separate`.",
    );
  });

  it("refuses removing logins from a database whose owner password this environment keeps", () => {
    expect(() => requireLogins(planWith(SINGLE), WITH_LOGINS, COMMAND)).toThrow(
      "The database db already has separate logins for the app and its migrations, and OpsCrew can't give the app the superuser again. Put `logins: separate` back under its options in opscrew/plan.yaml.",
    );
    expect(() => requireLogins(planWith(SEPARATE), WITH_LOGINS, COMMAND)).not.toThrow();
    expect(() => requireLogins(planWith(SINGLE), BEFORE_047, COMMAND)).not.toThrow();
  });

  it("switches a database whose superuser's password is kept but no owner's, deployed or not, with data-model.md's lines", () => {
    const change = loginsSwitch(planWith(SEPARATE), BEFORE_047, "prod");
    expect(change?.services).toEqual(["db"]);
    expect(change?.lines).toEqual([
      "Take a snapshot of db now.",
      "db restarts once (a few seconds) with two new passwords.",
      "The next deploy creates app_owner and app_runtime and gives app_owner the app's tables, in one transaction. If it fails, nothing changes and the app keeps its current login.",
      "A database with event triggers is refused: remove them with DROP EVENT TRIGGER first.",
      "From that deploy, the release command logs in as app_owner, and the app, workers and cron as app_runtime.",
    ]);
    expect(change?.hash).toMatch(/^[0-9a-f]{64}$/);
    // Another environment's switch is another plan.
    expect(loginsSwitch(planWith(SEPARATE), BEFORE_047, "staging")?.hash).not.toBe(change?.hash);
    // The generated values alone decide, not `opscrew verify`'s first deploy.
    expect(loginsSwitch(planWith(SEPARATE, false), BEFORE_047, "prod")).toEqual(change);
    // Nothing switches without the superuser's password (a new database), or once the owner's
    // password is kept.
    expect(loginsSwitch(planWith(SEPARATE), {}, "prod")).toBeUndefined();
    expect(loginsSwitch(planWith(SEPARATE), WITH_LOGINS, "prod")).toBeUndefined();
  });
});

describe("the two logins' secrets (047)", () => {
  it("generates both passwords once, gives the app the runtime login and the release the owner's", async () => {
    const deps = await createTestPhaseDeps();
    const plan = planWith(SEPARATE, false, testPlan({ userSecret: false }));
    const environment = await buildAppEnvironment(deps, plan, {});
    const db = environment.values.services.db ?? {};
    expect(Object.keys(db).sort()).toEqual(["owner-password", "password", "runtime-password"]);
    const owner = db["owner-password"] as string;
    const runtime = db["runtime-password"] as string;
    const superuser = db.password as string;
    expect(environment.appEnv).toContain(`app_runtime:${runtime}@db:5432/app`);
    for (const value of [owner, superuser]) expect(environment.appEnv).not.toContain(value);

    const secrets = deploySecrets({
      plan,
      host: "203.0.113.10",
      privateKey: "key",
      knownHosts: "hosts",
      environment,
    });
    expect(secrets[RELEASE_DB_ENV.secret]).toBe(
      `DATABASE_URL=postgresql://app_owner:${owner}@db:5432/app\n`,
    );
    expect(secrets[serviceEnvSecret("db")]).toContain(`OPSCREW_OWNER_PASSWORD=${owner}`);

    // Kept like `password`: a second run gives the same values.
    const again = await buildAppEnvironment(deps, plan, {});
    expect(again.values.services.db).toEqual(db);
    // Each is known to the redactor.
    for (const value of [owner, runtime]) {
      expect(deps.redactor.redact(`x ${value} x`)).not.toContain(value);
    }
  });

  it("the release overrides exactly the names that give the app the runtime login", async () => {
    const deps = await createTestPhaseDeps();
    const base = testPlan({ userSecret: false });
    const names = [
      "SQLALCHEMY_DATABASE_URI",
      "APP_DATABASE_URL",
      "TEST_DATABASE_URL",
      "NEXT_PUBLIC_DATABASE_URL",
      "DB_HOST",
      "DB_USER",
      "DB_PASS",
    ];
    const env = [
      ...base.app.env,
      // Neither is filled with a connection URL, so the app may go without them.
      ...names.map((name) => ({
        name,
        secret: false,
        source: "derived" as const,
        optional: name === "TEST_DATABASE_URL" || name === "NEXT_PUBLIC_DATABASE_URL",
      })),
    ];
    const plan = planWith(SEPARATE, false, { ...base, app: { ...base.app, env } });
    const environment = await buildAppEnvironment(deps, plan, {});
    const runtime = environment.values.services.db?.["runtime-password"] as string;
    const runtimeNames = [...parseDotenv(environment.appEnv)]
      .filter(([, value]) => value.includes("app_runtime") || value.includes(runtime))
      .map(([name]) => name);
    const release = deploySecrets({
      plan,
      host: "203.0.113.10",
      privateKey: "key",
      knownHosts: "hosts",
      environment,
    })[RELEASE_DB_ENV.secret];
    const overridden = [...parseDotenv(release ?? "").keys()];
    expect(overridden.sort()).toEqual(runtimeNames.sort());
    expect(overridden).toEqual(
      expect.arrayContaining(["SQLALCHEMY_DATABASE_URI", "APP_DATABASE_URL", "DB_USER", "DB_PASS"]),
    );
  });

  it("destroy deletes the release's env file with the other deploy secrets", () => {
    expect(deploySecretNames(planWith(SEPARATE))).toContain(RELEASE_DB_ENV.secret);
    expect(deploySecretNames(planWith(SINGLE))).not.toContain(RELEASE_DB_ENV.secret);
  });
});

/**
 * A project whose plan `plan` is committed (a hand edit committed first), with this environment's
 * generated values `kept`.
 */
async function project(
  plan: DeployPlan,
  kept: KeptLogins,
  answer: (request: ApprovalRequest) => boolean = () => true,
) {
  const created = await createProject(plan);
  await created.git(created.root, "add", "opscrew/plan.yaml");
  await created.git(created.root, "commit", "-q", "-m", "plan");
  await writeFile(join(created.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const handler = new ScriptedApprovalHandler(answer);
  const deps = await createTestPhaseDeps({
    root: created.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(created.root, ".home-opscrew"),
      HCLOUD_TOKEN: HCLOUD,
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const keptText = `${JSON.stringify(kept)}\n`;
  await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
  await writeFile(generatedValuesFile(deps), keptText);
  const github = new FakeGitHub();
  /** What had been written when the snapshot was taken. */
  const atSnapshot: { requests: string[]; generated: boolean; secrets: number; skip: string[] }[] =
    [];
  /** The switching databases the snapshot finds no container or volume of. */
  const empty: string[] = [];
  const snapshot: NonNullable<ProvisionServices["snapshot"]> = {
    neverRan: async (names) => names.filter((name) => empty.includes(name)),
    take: async (skip) => {
      atSnapshot.push({
        requests: handler.requests.map((r) => r.kind),
        generated: (await readFile(generatedValuesFile(deps), "utf8")) !== keptText,
        secrets: github.secrets.size,
        skip: [...skip],
      });
    },
  };
  const services: ProvisionServices = {
    otherApps: { inspect: noOtherApps },
    engine: async () => new FakeEngine(),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    snapshot,
  };
  return { ...created, deps, handler, github, services, atSnapshot, keptText, empty, snapshot };
}

/** Nothing of the run's changes was made: no value generated, no secret stored, no file written. */
async function expectNothingWritten(s: Awaited<ReturnType<typeof project>>) {
  expect(await readFile(generatedValuesFile(s.deps), "utf8")).toBe(s.keptText);
  expect(s.github.secrets.size).toBe(0);
  expect(s.handler.requests.map((r) => r.kind)).not.toContain("repo-write");
}

describe.skipIf(!findExecutable("git"))("provision's switch of an existing database (047)", () => {
  it("shows the switch of a hand-committed edit in a plan approved by its hash, and takes the snapshot before anything is written", async () => {
    const s = await project(planWith(SEPARATE), BEFORE_047);
    await runProvision(s.deps, { services: s.services });

    const [first] = s.handler.requests;
    const change = loginsSwitch(planWith(SEPARATE), BEFORE_047, "prod");
    expect(first).toMatchObject({ kind: "iac-apply", planHash: change?.hash });
    for (const line of change?.lines ?? []) expect(first?.details).toContain(line);
    expect(first?.details).toContain(`Switch hash: ${change?.hash}`);
    expect(s.atSnapshot).toEqual([
      { requests: ["iac-apply"], generated: false, secrets: 0, skip: [] },
    ]);

    // Then provision goes on: the release's env file reaches GitHub with the owner's login.
    expect(s.github.secrets.get(RELEASE_DB_ENV.secret)).toContain("app_owner:");
    expect(s.github.secrets.get(DEPLOY_SECRETS.appEnv)).toContain("app_runtime:");
    const said = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}`;
    const generated = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8")) as {
      services: Record<string, Record<string, string>>;
    };
    for (const value of Object.values(generated.services.db ?? {})) {
      expect(said).not.toContain(value);
    }
  });

  it("asks for the switch and takes the snapshot first on an environment `opscrew verify` never saw deploy", async () => {
    const plan = planWith(SEPARATE, false);
    const s = await project(plan, BEFORE_047);
    await runProvision(s.deps, { services: s.services });
    const change = loginsSwitch(plan, BEFORE_047, "prod");
    expect(change).toBeDefined();
    expect(s.handler.requests[0]).toMatchObject({ kind: "iac-apply", planHash: change?.hash });
    expect(s.atSnapshot).toEqual([
      { requests: ["iac-apply"], generated: false, secrets: 0, skip: [] },
    ]);
    expect(s.github.secrets.get(RELEASE_DB_ENV.secret)).toContain("app_owner:");
  });

  it("says a database that never ran has no data to snapshot, and goes on", async () => {
    const plan = planWith(SEPARATE, false);
    const s = await project(plan, BEFORE_047);
    s.empty.push("db");
    await runProvision(s.deps, { services: s.services });
    expect(s.handler.requests[0]).toMatchObject({
      kind: "iac-apply",
      planHash: loginsSwitch(plan, BEFORE_047, "prod")?.hash,
    });
    expect(s.atSnapshot).toEqual([]);
    const info = s.deps.reporter.lines.filter((line) => line.message.includes("no data yet"));
    expect(info.map((line) => line.message)).toEqual([
      "db has no data yet, so there's nothing to snapshot.",
    ]);
    expect(s.deps.reporter.text()).not.toContain("Taking a snapshot of db");
    expect(s.github.secrets.get(RELEASE_DB_ENV.secret)).toContain("app_owner:");
  });

  it("a failed look for the database's data stops provision with nothing written", async () => {
    const s = await project(planWith(SEPARATE, false), BEFORE_047);
    s.services.snapshot = {
      ...s.snapshot,
      neverRan: async () => {
        throw new OpsCrewError("COMMAND_FAILED", "The app's server did not answer over SSH.");
      },
    };
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "The snapshot of db before the switch to separate logins failed: The app's server did not answer over SSH. Nothing was changed.",
    );
    await expectNothingWritten(s);
  });

  it("--plan-only shows the switch and keeps no new login's password, so the run that approves it still takes the snapshot first", async () => {
    const s = await project(planWith(SEPARATE), BEFORE_047);
    const change = loginsSwitch(planWith(SEPARATE), BEFORE_047, "prod");
    await runProvision(s.deps, { services: s.services, planOnly: true });
    expect(s.deps.reporter.text()).toContain(`approve it with --approve ${change?.hash}.`);
    expect(s.atSnapshot).toEqual([]);
    const kept = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8")) as KeptLogins;
    expect(kept.services?.db ?? {}).toEqual({});
    expect(s.github.secrets.size).toBe(0);

    const before = s.handler.requests.length;
    await runProvision(s.deps, { services: s.services, approveHashes: [change?.hash ?? ""] });
    expect(s.handler.requests[before]).toMatchObject({ kind: "iac-apply", planHash: change?.hash });
    expect(s.atSnapshot).toHaveLength(1);
    expect(s.atSnapshot[0]).toMatchObject({ generated: false, secrets: 0 });
    expect(s.github.secrets.get(RELEASE_DB_ENV.secret)).toContain("app_owner:");
  });

  it("a failed snapshot stops provision with nothing written, saying what to do next", async () => {
    const s = await project(planWith(SEPARATE), BEFORE_047);
    s.services.snapshot = {
      ...s.snapshot,
      take: async () => {
        throw new OpsCrewError("COMMAND_FAILED", "The app's server has too little free disk.");
      },
    };
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "The snapshot of db before the switch to separate logins failed: The app's server has too little free disk. Nothing was changed.",
    );
    expect(error.hint).toContain("then run `opscrew provision` again");
    await expectNothingWritten(s);
  });

  it("--approve with another hash changes nothing", async () => {
    const wrong = "a".repeat(64);
    const s = await project(planWith(SEPARATE), BEFORE_047, (request) =>
      request.planHash === undefined ? true : request.planHash === wrong,
    );
    const error = (await runProvision(s.deps, {
      services: s.services,
      approveHashes: [wrong],
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(s.atSnapshot).toEqual([]);
    await expectNothingWritten(s);
  });

  it("refuses a hand-committed removal of the logins before any change", async () => {
    const s = await project(planWith(SINGLE), WITH_LOGINS);
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("can't give the app the superuser again");
    expect(s.handler.requests).toEqual([]);
    await expectNothingWritten(s);
  });

  it("only says how to switch for a deployed database without logins, and changes nothing for it", async () => {
    const s = await project(planWith(SINGLE), BEFORE_047);
    await runProvision(s.deps, { services: s.services });
    expect(s.deps.reporter.text()).toContain(
      "Your app logs in to PostgreSQL (db) as its superuser.",
    );
    expect(s.atSnapshot).toEqual([]);
    expect(s.github.secrets.has(RELEASE_DB_ENV.secret)).toBe(false);
  });
});

describe.skipIf(!SH_AVAILABLE)("the switch's snapshot on this computer (047)", () => {
  /** `shop` on this computer with `logins: separate`, a database made before 047, never verified. */
  async function local(computer = new FakeComputer()) {
    const plan = planWith(SEPARATE, false, localPlan());
    const handler = new ScriptedApprovalHandler();
    const { deps, root } = await localProject(plan, computer, { approve: handler });
    await writeFile(join(root, "Dockerfile"), "FROM node:22-alpine\n");
    const keptText = `${JSON.stringify(BEFORE_047)}\n`;
    await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
    await writeFile(generatedValuesFile(deps), keptText);
    const run = () => runProvision(deps, { services: { localhost: computer.services() } });
    return { deps, plan, handler, keptText, run };
  }

  it("says a database that never ran has no data yet, and goes on with the switch", async () => {
    const computer = new FakeComputer();
    const s = await local(computer);
    await s.run();
    expect(s.handler.requests[0]).toMatchObject({
      kind: "iac-apply",
      planHash: loginsSwitch(s.plan, BEFORE_047, "prod")?.hash,
    });
    expect(s.deps.reporter.text()).toContain("db has no data yet, so there's nothing to snapshot.");
    expect(computer.scripts.some((run) => run.script.includes("'take'"))).toBe(false);
    const kept = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8")) as KeptLogins;
    expect(Object.keys(kept.services?.db ?? {}).sort()).toEqual([
      "owner-password",
      "runtime-password",
    ]);
  });

  it("takes the snapshot of a database that ran, and stops with nothing written when it fails", async () => {
    // The computer's shell answers nothing, so the snapshot can't read the free disk.
    const computer = new FakeComputer().deployed();
    const s = await local(computer);
    const error = (await s.run().catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toMatch(
      /^The snapshot of db before the switch to separate logins failed: .+ Nothing was changed\.$/,
    );
    expect(s.deps.reporter.text()).toContain("Taking a snapshot of db before the switch");
    expect(s.deps.reporter.text()).not.toContain("no data yet");
    expect(await readFile(generatedValuesFile(s.deps), "utf8")).toBe(s.keptText);
  });
});
