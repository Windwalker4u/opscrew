// Feature 048 (T4802): `opscrew values` changes an environment's app values in GitHub's secrets,
// OpsCrew's record and the plan, and nothing else; no value is ever shown.
import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { hostingTestPlan } from "../hosting/__fixtures__/account";
import { appEnvText, buildLinesText, readDotenvLine } from "../shared/app-env";
import {
  createTestPhaseDeps,
  FakeGitHub,
  ScriptedApprovalHandler,
  type TestPhaseDeps,
  testPlan,
} from "../testing";
import { sitePlan } from "../testing/serverless";
import { appValueRows, changeAppValues, checkValueChange, type ValueChange } from "./index";
import { readAppValues, writeAppValues } from "./record";

const KEY = fakeSecret("stripe-live-key", "values-key");
const NEW_KEY = fakeSecret("stripe-live-key", "values-new");
const DB_URL = `postgres://app:${fakeSecret("generic-password", "values-db")}@db:5432/app`;
const SESSION = fakeSecret("generic-password", "values-session");
const PEM = fakeSecret("private-key-pem", "values-pem");

/** What provision recorded for testPlan's prod. */
const RECORDED = {
  app: { DATABASE_URL: DB_URL, SESSION_SECRET: SESSION, STRIPE_SECRET_KEY: KEY },
  build: {},
};

/** The deps of a deployed environment with `plan` written and `record` kept, and GitHub faked. */
async function world(
  plan: DeployPlan = testPlan({ deployed: true }),
  options: { record?: typeof RECORDED | null; approve?: boolean; environment?: string } = {},
) {
  const deps = await createTestPhaseDeps({
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    approvalHandler: new ScriptedApprovalHandler(() => options.approve ?? true),
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  if (options.record !== null) await writeAppValues(deps, options.record ?? RECORDED);
  const github = new FakeGitHub();
  const change = (input: Partial<ValueChange>) =>
    changeAppValues(
      deps,
      plan,
      { set: {}, unset: [], ...input },
      {
        api: github,
        owner: "acme",
        repo: "shop",
        defaultBranch: "main",
      },
    );
  return { deps, github, plan, change };
}

/** Everything a run wrote that a person or a log could read. */
function said(deps: TestPhaseDeps): string {
  const handler = deps.approvalHandler as ScriptedApprovalHandler;
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(handler.requests),
  ].join("\n");
}

/** The value `name` in the app env text `text`. */
function valueIn(text: string | undefined, name: string): string | undefined {
  for (const line of (text ?? "").split("\n")) {
    const pair = readDotenvLine(line);
    if (pair?.[0] === name) return pair[1];
  }
  return undefined;
}

describe("changeAppValues on a server", () => {
  it("stores one value in the app's env secret, keeping the others, and never shows it", async () => {
    const w = await world();
    const result = await w.change({ set: { STRIPE_SECRET_KEY: NEW_KEY } });
    const appEnv = w.github.secrets.get("OPSCREW_APP_ENV");
    expect(appEnv).toBe(appEnvText({ ...RECORDED.app, STRIPE_SECRET_KEY: NEW_KEY }));
    expect([...w.github.secrets.keys()]).toEqual(["OPSCREW_APP_ENV"]);
    expect(await readAppValues(w.deps)).toEqual({
      app: { ...RECORDED.app, STRIPE_SECRET_KEY: NEW_KEY },
      build: {},
    });
    expect(result.planChanged).toBe(false);
    const [request] = (w.deps.approvalHandler as ScriptedApprovalHandler).requests;
    expect(request?.kind).toBe("github-secrets");
    expect(request?.details).toContain("Set: STRIPE_SECRET_KEY.");
    expect(request?.details).toContain("  OPSCREW_APP_ENV");
    expect(request?.details).toContain("No infrastructure, Cloudflare, DNS or server change.");
    for (const value of [NEW_KEY, KEY, DB_URL, SESSION]) expect(said(w.deps)).not.toContain(value);
    expect(w.deps.reporter.text()).toContain(
      "The app gets the new values at its next deploy: a push to main",
    );
    expect(w.github.dispatches).toEqual([]);
  });

  it("keeps a multi-line PEM exactly", async () => {
    const w = await world();
    await w.change({ set: { TLS_KEY: PEM } });
    expect(valueIn(w.github.secrets.get("OPSCREW_APP_ENV"), "TLS_KEY")).toBe(PEM);
    expect(said(w.deps)).not.toContain(PEM.split("\n")[1]);
  });

  it("adds a new name to the plan as a secret, or plain with --plain", async () => {
    const w = await world();
    const result = await w.change({ set: { TLS_KEY: PEM } });
    expect(result.planChanged).toBe(true);
    const plan = await readArtifact("plan", w.deps.paths.files.plan);
    expect(plan.app.env.at(-1)).toEqual({ name: "TLS_KEY", secret: true, source: "user" });
    expect(JSON.stringify(plan)).not.toContain(PEM.split("\n")[1]);
    const plain = await world();
    await plain.change({ set: { FEATURE_FLAG: "on" }, plain: true });
    const after = await readArtifact("plan", plain.deps.paths.files.plan);
    expect(after.app.env.at(-1)).toEqual({ name: "FEATURE_FLAG", secret: false, source: "user" });
  });

  it("removes a value and its name from the plan", async () => {
    const w = await world();
    await w.change({ unset: ["STRIPE_SECRET_KEY"] });
    const { STRIPE_SECRET_KEY: _gone, ...rest } = RECORDED.app;
    expect(w.github.secrets.get("OPSCREW_APP_ENV")).toBe(appEnvText(rest));
    const plan = await readArtifact("plan", w.deps.paths.files.plan);
    expect(plan.app.env.map((v) => v.name)).not.toContain("STRIPE_SECRET_KEY");
  });

  it("stores a build value in the build's secret, split as the plan marks it", async () => {
    const base = testPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      app: {
        ...base.app,
        env: [...base.app.env, { name: "VITE_API_URL", secret: false, source: "user" }],
      },
    });
    const w = await world(plan, { record: { ...RECORDED, build: { VITE_API_URL: "https://a" } } });
    await w.change({ set: { VITE_API_URL: "https://b" } });
    expect(w.github.secrets.get("OPSCREW_BUILD_ENV")).toBe(
      buildLinesText({ VITE_API_URL: "https://b" }),
    );
    expect(w.github.secrets.has("OPSCREW_APP_ENV")).toBe(false);
    expect(w.github.secrets.has("OPSCREW_BUILD_SECRETS")).toBe(false);
  });

  it("puts a named environment's values in its GitHub environment", async () => {
    const base = testPlan({ deployed: true });
    const plan = DeployPlanSchema.parse({
      ...base,
      app: { ...base.app, name: "shop-staging" },
      environment: { name: "staging", secrets: "environment" },
    });
    const w = await world(plan, { environment: "staging" });
    w.github.environments.set("staging", new Map());
    await w.change({ set: { STRIPE_SECRET_KEY: NEW_KEY } });
    const appEnv = w.github.environments.get("staging")?.get("OPSCREW_STAGING_APP_ENV");
    expect(valueIn(appEnv, "STRIPE_SECRET_KEY")).toBe(NEW_KEY);
    expect(w.github.secrets.size).toBe(0);
  });

  it("starts the deploy workflow with --redeploy", async () => {
    const w = await world();
    const result = await w.change({ set: { STRIPE_SECRET_KEY: NEW_KEY }, redeploy: true });
    expect(w.github.dispatches).toEqual([{ workflowFile: "opscrew-deploy.yml", ref: "main" }]);
    expect(result.runUrl).toBe("https://github.com/acme/shop/actions/runs/42");
    expect(w.deps.audit.entries.map((e) => e.action)).toContain("dispatch workflow");
  });

  it("changes nothing when the approval is refused", async () => {
    const w = await world(undefined, { approve: false });
    await expect(w.change({ set: { TLS_KEY: PEM } })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
    });
    expect(w.github.secrets.size).toBe(0);
    expect(await readAppValues(w.deps)).toEqual(RECORDED);
    const plan = await readArtifact("plan", w.deps.paths.files.plan);
    expect(plan.app.env.map((v) => v.name)).not.toContain("TLS_KEY");
  });

  it("changes nothing and asks nothing when the values are the same", async () => {
    const w = await world();
    await w.change({ set: { STRIPE_SECRET_KEY: KEY } });
    expect((w.deps.approvalHandler as ScriptedApprovalHandler).requests).toEqual([]);
    expect(w.github.secrets.size).toBe(0);
  });
});

describe("changeAppValues on a site", () => {
  it("sets and deletes the site's own secret per variable", async () => {
    const plan = sitePlan({ env: ["API_KEY", "OLD_KEY"], deployed: true });
    const w = await world(plan, { record: null });
    await w.change({ set: { API_KEY: NEW_KEY } });
    expect(w.github.secrets.get("OPSCREW_ENV_API_KEY")).toBe(NEW_KEY);
    w.github.secrets.set("OPSCREW_ENV_OLD_KEY", KEY);
    await w.change({ unset: ["OLD_KEY"] });
    expect(w.github.secrets.has("OPSCREW_ENV_OLD_KEY")).toBe(false);
    expect(said(w.deps)).not.toContain(NEW_KEY);
  });
});

describe("checkValueChange's refusals", () => {
  const refused = async (
    plan: DeployPlan,
    change: Partial<ValueChange>,
    message: string,
    options: Parameters<typeof world>[1] = {},
  ) => {
    const w = await world(plan, options);
    await expect(
      checkValueChange(w.deps, plan, { set: {}, unset: [], ...change }),
    ).rejects.toMatchObject({ message: expect.stringContaining(message) });
    return w;
  };
  const deployed = testPlan({ deployed: true });

  it("refuses a target whose values don't live in GitHub, naming provision", async () => {
    const plan = DeployPlanSchema.parse({
      ...hostingTestPlan(),
      deployment: { lastApplyAt: "2026-10-11T11:00:00.000Z" },
    });
    const w = await refused(
      plan,
      { set: { A: "b" } },
      "on the hosting account, not in GitHub's secrets",
    );
    await expect(
      checkValueChange(w.deps, plan, { set: { A: "b" }, unset: [] }),
    ).rejects.toMatchObject({ hint: expect.stringContaining("opscrew provision") });
  });

  it("refuses an environment not set up, and a server without a record", async () => {
    await refused(testPlan(), { set: { A: "b" } }, "isn't set up yet");
    await refused(deployed, { set: { A: "b" } }, "no record of the app's values", { record: null });
  });

  it("refuses generated and derived names, and a name that isn't one", async () => {
    await refused(deployed, { set: { SESSION_SECRET: "x" } }, "OpsCrew generates SESSION_SECRET");
    await refused(deployed, { unset: ["DATABASE_URL"] }, "OpsCrew fills DATABASE_URL");
    await refused(deployed, { set: { "NOT-A-NAME": "x" } }, "isn't a variable name");
  });

  it("refuses a new build-time name and a new name of a site, naming provision", async () => {
    await refused(deployed, { set: { NEXT_PUBLIC_X: "x" } }, "only provision can add it");
    await refused(
      sitePlan({ deployed: true }),
      { set: { NEW_ONE: "x" } },
      "the site's deploy workflow reads each of its values by name",
    );
  });

  it("refuses --plain on a declared name, and removing what has no value", async () => {
    await refused(deployed, { set: { STRIPE_SECRET_KEY: "x" }, plain: true }, "--plain goes only");
    await refused(deployed, { unset: ["NOTHING_HERE"] }, "has no value");
  });

  it("refuses --redeploy and a build value in a promoted environment", async () => {
    const plan = sitePlan({
      deployed: true,
      environment: "prod2",
      promotedFrom: "staging",
      env: ["API_KEY"],
    });
    await refused(plan, { set: { API_KEY: "x" }, redeploy: true }, "--redeploy can't start");
    await refused(plan, { set: { API_KEY: "x" } }, "its own value would change nothing");
  });

  it("registers every value with the redactor first", async () => {
    const w = await world(deployed);
    await checkValueChange(w.deps, deployed, { set: { STRIPE_SECRET_KEY: NEW_KEY }, unset: [] });
    expect(w.deps.redactor.redact(`x ${NEW_KEY}`)).not.toContain(NEW_KEY);
  });
});

describe("appValueRows", () => {
  it("lists the plan's variables and what OpsCrew fills, with secret and source", () => {
    expect(appValueRows(testPlan())).toEqual([
      { name: "DATABASE_URL", secret: true, source: "derived" },
      { name: "SESSION_SECRET", secret: true, source: "generated" },
      { name: "STRIPE_SECRET_KEY", secret: true, source: "user" },
    ]);
  });
});
