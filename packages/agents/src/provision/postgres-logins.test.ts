import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_SECRETS, RELEASE_DB_ENV, serviceEnvSecret } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
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
import { loginsNotices, loginsSwitch, requireLogins } from "./postgres-logins";
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

describe("provision's texts for PostgreSQL's two logins (047)", () => {
  it("tells a deployed environment without logins how to switch, every run", () => {
    expect(loginsNotices(planWith(SINGLE), COMMAND)).toEqual([
      "Your app logs in to PostgreSQL (db) as its superuser. To give it a login that can only read and write data, add `logins: separate` under db's options in opscrew/plan.yaml and run `npx opscrew provision`: it shows the switch before anything changes.",
    ]);
  });

  it("says below 15 that separate logins come with an upgrade, and refuses nothing", () => {
    const plan = planWith({ version: "14", options: {} });
    expect(loginsNotices(plan, COMMAND)).toEqual([
      "db runs PostgreSQL 14, so your app logs in as its superuser. Separate logins for the app and its migrations come with an upgrade to PostgreSQL 15 or later.",
    ]);
    expect(() => requireLogins(plan, new Map([["db", false]]), COMMAND)).not.toThrow();
  });

  it("says nothing before the first deploy, nor with logins", () => {
    expect(loginsNotices(planWith(SINGLE, false), COMMAND)).toEqual([]);
    expect(loginsNotices(planWith(SEPARATE), COMMAND)).toEqual([]);
  });

  it("refuses a hand-written logins: separate below 15", () => {
    const plan = planWith({ version: "14", ...SEPARATE }, false);
    expect(() => requireLogins(plan, undefined, COMMAND)).toThrow(
      "PostgreSQL 14 can't use separate logins (OpsCrew's setup needs psql 15 or later). Upgrade db to 17 first, then add `logins: separate`.",
    );
  });

  it("refuses removing logins from a deployed database whose committed plan has them", () => {
    const committed = new Map([["db", true]]);
    expect(() => requireLogins(planWith(SINGLE), committed, COMMAND)).toThrow(
      "The database db already has separate logins for the app and its migrations, and OpsCrew can't give the app the superuser again. Put `logins: separate` back under its options in opscrew/plan.yaml.",
    );
    expect(() => requireLogins(planWith(SEPARATE), committed, COMMAND)).not.toThrow();
  });

  it("switches a deployed database whose committed plan has no logins, with data-model.md's lines", () => {
    const change = loginsSwitch(planWith(SEPARATE), new Map([["db", false]]), "prod");
    expect(change?.services).toEqual(["db"]);
    expect(change?.lines).toEqual([
      "Take a snapshot of db now.",
      "db restarts once (a few seconds) with two new passwords.",
      "The next deploy creates app_owner and app_runtime and gives app_owner the app's tables, in one transaction. If it fails, nothing changes and the app keeps its current login.",
      "From that deploy, the release command logs in as app_owner, and the app, workers and cron as app_runtime.",
    ]);
    expect(change?.hash).toMatch(/^[0-9a-f]{64}$/);
    // Another environment's switch is another plan.
    expect(loginsSwitch(planWith(SEPARATE), new Map([["db", false]]), "staging")?.hash).not.toBe(
      change?.hash,
    );
    // Nothing switches before the first deploy, for a new database, or once committed.
    expect(
      loginsSwitch(planWith(SEPARATE, false), new Map([["db", false]]), "prod"),
    ).toBeUndefined();
    expect(loginsSwitch(planWith(SEPARATE), new Map(), "prod")).toBeUndefined();
    expect(loginsSwitch(planWith(SEPARATE), new Map([["db", true]]), "prod")).toBeUndefined();
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

  it("destroy deletes the release's env file with the other deploy secrets", () => {
    expect(deploySecretNames(planWith(SEPARATE))).toContain(RELEASE_DB_ENV.secret);
    expect(deploySecretNames(planWith(SINGLE))).not.toContain(RELEASE_DB_ENV.secret);
  });
});

/** A project whose committed plan is `committed`, with `current` in the working copy. */
async function project(committed: DeployPlan, current: DeployPlan, answer = () => true) {
  const created = await createProject(committed);
  await created.git(created.root, "add", "opscrew/plan.yaml");
  await created.git(created.root, "commit", "-q", "-m", "plan");
  await writeArtifact("plan", join(created.root, "opscrew", "plan.yaml"), current);
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
  const github = new FakeGitHub();
  /** What had been written when the snapshot was taken. */
  const atSnapshot: { requests: string[]; generated: boolean; secrets: number; skip: string[] }[] =
    [];
  const snapshot: NonNullable<ProvisionServices["snapshot"]> = async (skip) => {
    atSnapshot.push({
      requests: handler.requests.map((r) => r.kind),
      generated: existsSync(generatedValuesFile(deps)),
      secrets: github.secrets.size,
      skip: [...skip],
    });
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
  return { ...created, deps, handler, github, services, atSnapshot };
}

/** Nothing of the run's changes was made: no value generated, no secret stored, no file written. */
function expectNothingWritten(s: Awaited<ReturnType<typeof project>>) {
  expect(existsSync(generatedValuesFile(s.deps))).toBe(false);
  expect(s.github.secrets.size).toBe(0);
  expect(s.handler.requests.map((r) => r.kind)).not.toContain("repo-write");
}

describe.skipIf(!findExecutable("git"))("provision's switch of an existing database (047)", () => {
  it("shows the switch in a plan approved by its hash, and takes the snapshot before anything is written", async () => {
    const s = await project(planWith(SINGLE), planWith(SEPARATE));
    await runProvision(s.deps, { services: s.services });

    const [first] = s.handler.requests;
    const change = loginsSwitch(planWith(SEPARATE), new Map([["db", false]]), "prod");
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

  it("a failed snapshot stops provision with nothing written, saying what to do next", async () => {
    const s = await project(planWith(SINGLE), planWith(SEPARATE));
    s.services.snapshot = async () => {
      throw new OpsCrewError("COMMAND_FAILED", "The app's server has too little free disk.");
    };
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe(
      "The snapshot of db before the switch to separate logins failed: The app's server has too little free disk. Nothing was changed.",
    );
    expect(error.hint).toContain("then run `opscrew provision` again");
    expectNothingWritten(s);
  });

  it("--approve with another hash changes nothing", async () => {
    const wrong = "a".repeat(64);
    const s = await project(planWith(SINGLE), planWith(SEPARATE), (request) =>
      request.planHash === undefined ? true : request.planHash === wrong,
    );
    const error = (await runProvision(s.deps, {
      services: s.services,
      approveHashes: [wrong],
    }).catch((e: unknown) => e)) as OpsCrewError;
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(s.atSnapshot).toEqual([]);
    expectNothingWritten(s);
  });

  it("refuses removing the logins before any change", async () => {
    const s = await project(planWith(SEPARATE), planWith(SINGLE));
    const error = (await runProvision(s.deps, { services: s.services }).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toContain("can't give the app the superuser again");
    expect(s.handler.requests).toEqual([]);
    expectNothingWritten(s);
  });

  it("only says how to switch for a deployed database without logins, and changes nothing for it", async () => {
    const s = await project(planWith(SINGLE), planWith(SINGLE));
    await runProvision(s.deps, { services: s.services });
    expect(s.deps.reporter.text()).toContain(
      "Your app logs in to PostgreSQL (db) as its superuser.",
    );
    expect(s.atSnapshot).toEqual([]);
    expect(s.github.secrets.has(RELEASE_DB_ENV.secret)).toBe(false);
  });
});
