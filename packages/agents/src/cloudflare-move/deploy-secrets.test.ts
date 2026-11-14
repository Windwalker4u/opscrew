import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalGate, findExecutable, MemoryApprovalStore, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { appPlan } from "../apps/__fixtures__/sites";
import { recordPortainerConnection } from "../shared/server-record";
import {
  ownPlan,
  PORTAINER_URL,
  portainerPlan,
  ScriptedApprovalHandler,
  sitePlan,
} from "../testing";
import { addNewCredentials, dropNewCredentials, promoteNewCredentials } from "./deploy-secrets";
import { appProgressFile, readAppProgress } from "./progress";
import { serverPlan, unencrypted, ZONE } from "./session.fakes";
import { StateFileEngine, shadowHarness } from "./shadow.fakes";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

/** B's deploy service token, as B's main shadow root outputs it. */
const TOKEN_ID = fakeSecret("generic-password", "b-service-token-id");
const TOKEN_SECRET = fakeSecret("generic-password", "b-service-token-secret");
const OUTPUTS = {
  deploy_service_token_client_id: TOKEN_ID,
  deploy_service_token_client_secret: TOKEN_SECRET,
};
/** B's Workers deploy token. */
const DEPLOY_TOKEN = fakeSecret("cloudflare-token", "b-workers-deploy");
/** A's values of the plain deploy secrets, as provision left them. */
const A_VALUE = fakeSecret("generic-password", "a-deploy-credential");

/** A fake engine whose shadow states output `shown`. */
class OutputsEngine extends StateFileEngine {
  shown: Record<string, unknown> = {};
  override async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return this.shown;
  }
}

type Target = "own" | "portainer" | "site";

/** The target's deployed plan at `domain`. */
function planOf(target: Target, domain: string): DeployPlan {
  if (target === "own") return unencrypted(ownPlan({ access: "tunnel", deployed: true, domain }));
  if (target === "portainer") {
    return unencrypted(portainerPlan({ redeploy: "cloudflare", deployed: true, domain }));
  }
  return unencrypted(sitePlan({ domain, deployed: true }));
}

/** `plan` as the environment staging whose deploy secrets live in its GitHub environment. */
function staged(plan: DeployPlan): DeployPlan {
  const staging = appPlan(undefined, "staging", plan);
  return DeployPlanSchema.parse({
    ...staging,
    environment: { ...staging.environment, secrets: "environment" },
  });
}

/** The `_NEW` and plain secret names (unprefixed) of each target. */
const NAMES: Record<Target, { next: [string, string]; plain: [string, string] }> = {
  own: {
    next: ["TUNNEL_SERVICE_TOKEN_ID_NEW", "TUNNEL_SERVICE_TOKEN_SECRET_NEW"],
    plain: ["TUNNEL_SERVICE_TOKEN_ID", "TUNNEL_SERVICE_TOKEN_SECRET"],
  },
  portainer: {
    next: ["PORTAINER_ACCESS_CLIENT_ID_NEW", "PORTAINER_ACCESS_CLIENT_SECRET_NEW"],
    plain: ["PORTAINER_ACCESS_CLIENT_ID", "PORTAINER_ACCESS_CLIENT_SECRET"],
  },
  site: {
    next: ["CLOUDFLARE_API_TOKEN_NEW", "CLOUDFLARE_ACCOUNT_ID_NEW"],
    plain: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  },
};

interface Moving {
  h: Awaited<ReturnType<typeof shadowHarness>>;
  session: MoveSession;
  env: MoveEnvironment;
  engine: OutputsEngine;
  handler: ScriptedApprovalHandler;
  /** Where the environment's deploy secrets live: the repository's, or its GitHub environment's. */
  secrets: () => Map<string, string>;
  /** The environment's secret name of an unprefixed one. */
  name: (unprefixed: string) => string;
  /** B's values of the plain names, in NAMES' order. */
  values: [string, string];
}

/** A move of `target`'s app from Old to New's pending zone, in prod or in staging. */
async function moving(
  target: Target,
  o: { staging?: boolean; env?: Record<string, string | undefined>; plan?: DeployPlan } = {},
): Promise<Moving> {
  const prod = o.plan ?? planOf(target, `shop.${ZONE}`);
  const plans: Record<string, DeployPlan> = o.staging
    ? { prod, staging: staged(planOf(target, `staging.${ZONE}`)) }
    : { prod };
  const engine = new OutputsEngine();
  const h = await shadowHarness(() => Object.values(plans).map((plan) => plan.infra.dir), {
    engine,
    plans: () => plans,
    env: { OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY_TOKEN, ...o.env },
  });
  const newId = h.cloudflare.account("New").id;
  h.cloudflare.tokens.set(DEPLOY_TOKEN, { accounts: [newId], denied: new Set() });
  const environment = o.staging ? "staging" : "prod";
  const env = h.session.environments.find((one) => one.environment === environment);
  if (env === undefined) throw new Error(`${environment} is not covered`);
  if (target === "portainer") {
    await recordPortainerConnection(env.paths, {
      url: PORTAINER_URL,
      environmentId: 3,
      environmentName: "local",
    });
  }
  const ghEnvironment = o.staging ? "staging" : undefined;
  if (ghEnvironment !== undefined) h.github.environments.set(ghEnvironment, new Map());
  const prefix = o.staging ? "OPSCREW_STAGING_" : "OPSCREW_";
  const secrets = () =>
    ghEnvironment === undefined
      ? h.github.secrets
      : (h.github.environments.get(ghEnvironment) as Map<string, string>);
  const handler = h.deps.approvalHandler as ScriptedApprovalHandler;
  handler.requests.length = 0;
  h.cloudflare.calls.length = 0;
  return {
    h,
    session: h.session,
    env,
    engine,
    handler,
    secrets,
    name: (unprefixed) => `${prefix}${unprefixed}`,
    values: target === "site" ? [DEPLOY_TOKEN, newId] : [TOKEN_ID, TOKEN_SECRET],
  };
}

/** Every file under `dir`, read as text. */
async function filesUnder(dir: string): Promise<string> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.isFile()) texts.push(await readFile(join(entry.parentPath, entry.name), "utf8"));
  }
  return texts.join("\n");
}

/** True when a token or B's credentials show up in anything said, recorded, asked or kept. */
async function leaked(m: Moving): Promise<boolean> {
  const asked = JSON.stringify(m.handler.requests);
  const kept = [
    await filesUnder(m.env.paths.stateDir),
    await filesUnder(m.env.paths.projectHomeDir),
    await readFile(appProgressFile(m.h.deps.paths), "utf8").catch(() => ""),
  ].join("\n");
  const said = [m.h.deps.reporter.text(), JSON.stringify(m.h.deps.audit.entries), asked];
  const credentials = [TOKEN_ID, TOKEN_SECRET, DEPLOY_TOKEN, A_VALUE];
  return (
    m.h.leaks(...said) ||
    credentials.some((value) => [...said, kept].some((text) => text.includes(value))) ||
    JSON.stringify(m.h.cloudflare.calls).includes(DEPLOY_TOKEN)
  );
}

/** Runs `step` without an approval (it stops with the hash), then with `--approve <hash>`. */
async function approved(m: Moving, step: () => Promise<StepStop | undefined>): Promise<string> {
  const stop = (await step()) as StepStop;
  const hash = stop?.pendingPlanHash as string;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stop.next.join("\n")).toContain(`--approve ${hash}`);
  expect(m.handler.requests).toEqual([]);
  m.session.approve = hash;
  expect(await step()).toBeUndefined();
  expect(m.session.approve).toBeUndefined();
  expect(m.handler.requests.map((r) => [r.kind, r.planHash])).toEqual([["github-secrets", hash]]);
  return hash;
}

const CASES: [Target, boolean][] = [
  ["own", false],
  ["own", true],
  ["portainer", false],
  ["portainer", true],
  ["site", false],
  ["site", true],
];

describe.skipIf(!findExecutable("git"))("the deploy's credentials for the new account", () => {
  it.each(CASES)(
    "adds %s's _NEW secrets (in a GitHub environment: %s), skips them when set, then promotes them",
    async (target, staging) => {
      const m = await moving(target, { staging });
      const [plainA, plainB] = NAMES[target].plain.map(m.name) as [string, string];
      const [nextA, nextB] = NAMES[target].next.map(m.name) as [string, string];
      m.secrets().set(plainA, A_VALUE);
      m.secrets().set(plainB, A_VALUE);
      const outputs = target === "site" ? {} : OUTPUTS;
      const add = () => addNewCredentials(m.session, m.env, outputs);

      // A script's run stops with the hash and changes nothing.
      const stop = (await add()) as StepStop;
      expect(m.secrets().has(nextA)).toBe(false);
      expect((await readAppProgress(m.h.deps.paths)).pending).toMatchObject({
        action: "secrets",
        environment: m.env.environment,
        planHash: stop.pendingPlanHash,
      });
      expect(m.h.github.dispatches).toEqual([]);
      m.session.approve = undefined;
      m.handler.requests.length = 0;

      const hash = await approved(m, add);
      expect(hash).toBe(stop.pendingPlanHash);
      expect(m.secrets().get(nextA)).toBe(m.values[0]);
      expect(m.secrets().get(nextB)).toBe(m.values[1]);
      expect(m.secrets().get(plainA)).toBe(A_VALUE);
      const [request] = m.handler.requests;
      expect(request?.details).toContain(nextA);
      expect(request?.details).toContain(nextB);
      expect((await readAppProgress(m.h.deps.paths)).pending).toBeUndefined();
      // A site's deploy ran once, so B's Worker runs the current code.
      expect(m.h.github.dispatches.length).toBe(target === "site" ? 1 : 0);

      // The same values again: nothing asked, nothing set, nothing run.
      m.h.deps.interactive = true;
      m.secrets().delete(nextA);
      expect(await add()).toBeUndefined();
      expect(m.handler.requests.length).toBe(1);
      expect(m.secrets().has(nextA)).toBe(false);
      expect(m.h.github.dispatches.length).toBe(target === "site" ? 1 : 0);
      m.secrets().set(nextA, m.values[0]);

      // The finish: the plain names take B's values, the _NEW ones go.
      m.engine.shown = outputs;
      expect(await promoteNewCredentials(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests.map((r) => r.kind)).toEqual(["github-secrets", "github-secrets"]);
      expect(m.secrets().get(plainA)).toBe(m.values[0]);
      expect(m.secrets().get(plainB)).toBe(m.values[1]);
      expect(m.secrets().has(nextA)).toBe(false);
      expect(m.secrets().has(nextB)).toBe(false);
      const details = m.handler.requests[1]?.details ?? "";
      for (const name of [plainA, plainB, nextA, nextB]) expect(details).toContain(name);
      expect(await promoteNewCredentials(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests.length).toBe(2);
      if (target !== "site") expect(m.engine.calls).toContain("output");
      // Only GitHub's encrypted secrets got the values, and A was never written to.
      expect(await leaked(m)).toBe(false);
      const oldId = m.h.cloudflare.account("Old").id;
      expect(
        m.h.cloudflare.calls.some((call) => call.method !== "GET" && call.accountId === oldId),
      ).toBe(false);
      expect(m.h.github.environments.has("production")).toBe(false);
    },
  );

  it("deletes the _NEW secrets at an abort and leaves A's", async () => {
    const m = await moving("own");
    m.h.deps.interactive = true;
    m.secrets().set("OPSCREW_TUNNEL_SERVICE_TOKEN_ID", A_VALUE);
    expect(await addNewCredentials(m.session, m.env, OUTPUTS)).toBeUndefined();
    expect(m.secrets().has("OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET_NEW")).toBe(true);
    expect(await dropNewCredentials(m.session, m.env)).toBeUndefined();
    expect([...m.secrets().keys()]).toEqual(["OPSCREW_TUNNEL_SERVICE_TOKEN_ID"]);
    expect(m.secrets().get("OPSCREW_TUNNEL_SERVICE_TOKEN_ID")).toBe(A_VALUE);
    expect(m.handler.requests.map((r) => r.kind)).toEqual(["github-secrets", "github-secrets"]);
    expect(m.handler.requests[1]?.details).toContain("OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET_NEW");
    expect(await dropNewCredentials(m.session, m.env)).toBeUndefined();
    expect(m.handler.requests.length).toBe(2);
    expect(
      m.h.deps.audit.entries.filter((entry) => entry.action.startsWith("delete secret")),
    ).toHaveLength(2);
    expect(await leaked(m)).toBe(false);
  });

  it("stops a script's abort with the deletion's hash", async () => {
    const m = await moving("portainer", { staging: true });
    const hash = await approved(m, () => dropNewCredentials(m.session, m.env));
    expect((await readAppProgress(m.h.deps.paths)).pending).toBeUndefined();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets B's values again when they changed", async () => {
    const m = await moving("own");
    m.h.deps.interactive = true;
    expect(await addNewCredentials(m.session, m.env, OUTPUTS)).toBeUndefined();
    const fresh = fakeSecret("generic-password", "b-service-token-secret-2");
    const changed = { ...OUTPUTS, deploy_service_token_client_secret: fresh };
    expect(await addNewCredentials(m.session, m.env, changed)).toBeUndefined();
    expect(m.handler.requests.length).toBe(2);
    expect(m.handler.requests[0]?.planHash).not.toBe(m.handler.requests[1]?.planHash);
    expect(m.secrets().get("OPSCREW_TUNNEL_SERVICE_TOKEN_SECRET_NEW")).toBe(fresh);
    expect(m.h.deps.reporter.text()).not.toContain(fresh);
  });

  it("changes nothing when the approval is refused", async () => {
    const m = await moving("own");
    m.h.deps.interactive = true;
    const { deps } = m.session;
    deps.approvals = new ApprovalGate({
      handler: new ScriptedApprovalHandler([false]),
      store: new MemoryApprovalStore(),
      audit: deps.audit,
      clock: deps.clock,
    });
    const error = await addNewCredentials(m.session, m.env, OUTPUTS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("APPROVAL_REFUSED");
    expect((error as OpsCrewError).message).toContain("No GitHub secret was changed.");
    expect(m.h.github.secrets.size).toBe(0);
  });

  it("refuses without B's Access service token in the outputs, before any change", async () => {
    const m = await moving("own");
    m.h.deps.interactive = true;
    const error = await addNewCredentials(m.session, m.env, {}).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("ENGINE_FAILED");
    expect((error as OpsCrewError).message).toContain("Nothing was changed.");
    expect(m.handler.requests).toEqual([]);
    expect(m.h.github.secrets.size).toBe(0);
  });

  it("refuses a site without B's deploy token, naming it, before any change", async () => {
    const m = await moving("site", { env: { OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN: undefined } });
    m.h.deps.interactive = true;
    const error = (await addNewCredentials(m.session, m.env, {}).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toContain("OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN is not set");
    expect(error.hint).toContain("set OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN to it");
    expect(`${error.message} ${error.hint}`).not.toMatch(/(?<!NEW_)CLOUDFLARE_DEPLOY_TOKEN/);
    expect(m.handler.requests).toEqual([]);
    expect(m.h.github.secrets.size).toBe(0);
    expect(m.h.github.dispatches).toEqual([]);
  });

  it("refuses B's own token as the site's deploy token, naming B's variables", async () => {
    const m = await moving("site");
    m.h.deps.interactive = true;
    m.h.deps.env.OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN = m.h.tokens.b;
    const error = (await addNewCredentials(m.session, m.env, {}).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain(
      "OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN is the same token as OPSCREW_NEW_CLOUDFLARE_API_TOKEN",
    );
    expect(m.h.github.secrets.size).toBe(0);
  });

  it("refuses a site's deploy token without Workers permission for B", async () => {
    const m = await moving("site");
    m.h.deps.interactive = true;
    m.h.cloudflare.tokens.set(DEPLOY_TOKEN, { accounts: [], denied: new Set() });
    const error = (await addNewCredentials(m.session, m.env, {}).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN");
    expect(m.h.github.secrets.size).toBe(0);
  });

  it("runs a site's deploy again when it did not succeed", async () => {
    const m = await moving("site");
    m.h.deps.interactive = true;
    m.h.github.conclusion = "failure";
    const error = (await addNewCredentials(m.session, m.env, {}).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toContain(
      "The site is still served from the current Cloudflare account.",
    );
    m.h.github.conclusion = "success";
    expect(await addNewCredentials(m.session, m.env, {})).toBeUndefined();
    expect(m.h.github.dispatches.length).toBe(2);
    expect(await addNewCredentials(m.session, m.env, {})).toBeUndefined();
    expect(m.h.github.dispatches.length).toBe(2);
    expect(
      m.h.deps.audit.entries
        .filter((entry) => entry.action === "deploy workflow")
        .map((e) => e.decision),
    ).toEqual(["refused", "approved"]);
    expect(await leaked(m)).toBe(false);
  });

  it("does nothing for a deploy that needs none of the new account's credentials", async () => {
    const inPlace = planOf("own", `shop.${ZONE}`);
    const plans = [
      serverPlan(),
      unencrypted(ownPlan({ access: "public", deployed: true, domain: `shop.${ZONE}` })),
      unencrypted(portainerPlan({ redeploy: "updater", deployed: true, domain: `shop.${ZONE}` })),
      DeployPlanSchema.parse({ ...inPlace, environment: { runner: "server" } }),
    ];
    for (const plan of plans) {
      const m = await moving("own", { plan });
      m.h.deps.interactive = true;
      expect(await addNewCredentials(m.session, m.env, OUTPUTS)).toBeUndefined();
      expect(await promoteNewCredentials(m.session, m.env)).toBeUndefined();
      expect(await dropNewCredentials(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toEqual([]);
      expect(m.h.github.secrets.size).toBe(0);
    }
  });
});
