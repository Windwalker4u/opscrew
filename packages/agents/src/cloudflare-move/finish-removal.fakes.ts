/**
 * Test helpers for the finish's last steps: an app on each target in a move of {@link ZONE} from
 * Old to New after the switch (New's zone active, Old's moved), the committed roots holding New's
 * ids as the swap leaves them, and a fake engine whose destroy plans delete what their state holds.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ApprovalRequest,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import { ApprovalGate, MemoryApprovalStore } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type RenderContext, renderBackups, renderStorage } from "@opscrew/iac-templates";
import { backupsBucketOf, type CloudflareMove, type DeployPlan } from "@opscrew/plan-schema";
import { providerBucket } from "../provision/storage";
import { recordPortainerConnection } from "../shared/server-record";
import {
  ownPlan,
  PORTAINER_URL,
  portainerPlan,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  sitePlan,
} from "../testing";
import { bucketWorld, type FakeR2 } from "./buckets.fakes";
import { fakeClock } from "./connector.fakes";
import { atStep } from "./record.fakes";
import {
  type MoveHarness,
  moveHarness,
  recordedMove,
  serverPlan,
  unencrypted,
  ZONE,
} from "./session.fakes";
import { shadowFiles, shadowRoots } from "./shadow";
import { addressState, StateFileEngine, stateAddresses } from "./shadow.fakes";
import { FINISH_COMMAND } from "./texts";
import type { MoveEnvironment, MoveServices, MoveSession, ShadowRoot } from "./types";

/** B's Workers deploy token. */
export const DEPLOY_TOKEN = fakeSecret("cloudflare-token", "b-workers-deploy");
/** B's deploy service token, as B's main shadow root outputs it. */
export const TOKEN_ID = fakeSecret("generic-password", "b-service-token-id");
export const TOKEN_SECRET = fakeSecret("generic-password", "b-service-token-secret");
/** A's tunnel, and the one in front of Portainer's webhook. */
export const A_TUNNEL = "0f0e0d0c-0000-4000-8000-00000000000a";
export const A_WEBHOOK_TUNNEL = "0f0e0d0c-0000-4000-8000-00000000000b";

/** A planned change of `address`. */
export function change(address: string, action: ResourceChange["action"]): ResourceChange {
  const [type = "", name = ""] = address.replace(/^module\.\w+\./, "").split(".");
  return { address, type, name, provider: "registry.opentofu.org/test/test", action };
}

/** The state and kind of a saved plan of {@link FinishEngine}. */
interface Planned {
  state: string;
  destroy: boolean;
}

/**
 * The fake engine with states of addresses: a destroy plan deletes every address its state holds
 * and its apply empties that state (and its outputs); any other plan has `checkChanges`. Each
 * state's outputs are `stateOutputs`' (by state path), read through the data folder it is bound to.
 */
export class FinishEngine extends StateFileEngine {
  checkChanges: ResourceChange[] = [];
  readonly stateOutputs = new Map<string, Record<string, unknown>>();
  /** The folder each plan was made in, in order. */
  readonly planDirs: string[] = [];
  readonly #planned = new Map<string, Planned>();

  override async plan(
    dir: string,
    planFile: string,
    options: Parameters<IacEngine["plan"]>[2] = {},
  ): Promise<PlanSummary> {
    const state = this.bound(dir, options.env);
    const destroy = options.destroy === true;
    this.scenario.changes = destroy
      ? (await stateAddresses(state)).map((address) => change(address, "delete"))
      : this.checkChanges;
    this.#planned.set(planFile, { state, destroy });
    this.planDirs.push(dir);
    return super.plan(dir, planFile, options);
  }

  override async apply(
    dir: string,
    planFile: string,
    approval: IacApproval,
    options: IacRunOptions = {},
  ): Promise<IacApplyResult> {
    const result = await super.apply(dir, planFile, approval, options);
    const planned = this.#planned.get(planFile);
    if (result.ok && planned?.destroy === true) {
      await writeFile(planned.state, addressState([]));
      this.stateOutputs.delete(planned.state);
    }
    return result;
  }

  override async output(dir?: string, options?: IacRunOptions): Promise<Record<string, unknown>> {
    if (dir === undefined) return super.output();
    let state: string;
    try {
      state = this.bound(dir, options?.env);
    } catch {
      return super.output();
    }
    this.calls.push("output");
    return this.stateOutputs.get(state) ?? {};
  }
}

export type FinishTarget = "cloud" | "portainer" | "own" | "site";

/** The target's deployed plan, without buckets. */
function planOf(target: FinishTarget): DeployPlan {
  const domain = `shop.${ZONE}`;
  if (target === "own") return unencrypted(ownPlan({ access: "tunnel", deployed: true, domain }));
  if (target === "portainer") {
    return unencrypted(portainerPlan({ redeploy: "cloudflare", deployed: true, domain }));
  }
  if (target === "site") return unencrypted(sitePlan({ domain: `site.${ZONE}`, deployed: true }));
  return serverPlan();
}

export interface FinishWorldOptions {
  /** The move's recorded step (default `adopted`). */
  step?: CloudflareMove["step"];
  /** The app's files and the snapshots' copies on R2 (a cloud server or Portainer only). */
  buckets?: boolean;
}

/** What a world starts from: the harness, its services and its leak check. */
interface Start {
  h: MoveHarness;
  services: MoveServices;
  /** The leak check of the start (bucketWorld's checks the bucket keys too). */
  leaks: (...texts: string[]) => boolean;
  r2?: FakeR2;
}

/** The harness with buckets (bucketWorld's) and New's zone, made with New's token. */
async function withBuckets(
  target: "cloud" | "portainer",
  step: CloudflareMove["step"],
): Promise<Start> {
  const w = await bucketWorld(target, { command: FINISH_COMMAND, step });
  await w.session.accounts.b.client.createZone(w.fresh, ZONE);
  return { h: w, services: w.session.services, leaks: w.leaks, r2: w.r2 };
}

/** The harness without buckets, with New's zone pending. */
async function withoutBuckets(target: FinishTarget, step: CloudflareMove["step"]): Promise<Start> {
  const h = await moveHarness({
    bZone: true,
    plans: (cloudflare) => ({ prod: atStep(recordedMove(planOf(target), cloudflare), step) }),
    env: { OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN: DEPLOY_TOKEN },
  });
  h.cloudflare.tokens.set(DEPLOY_TOKEN, {
    accounts: [h.cloudflare.account("New").id],
    denied: new Set(),
  });
  return { h, services: { ...h.services, ...fakeClock() }, leaks: h.leaks };
}

/** The committed files of `plan`'s roots, with New's ids as the swap leaves them. */
async function commitRoots(
  root: string,
  plan: DeployPlan,
  ids: { zoneId: string; accountId: string },
) {
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const values: Record<string, unknown> = {
    app: plan.app.name,
    cloudflare_zone_id: ids.zoneId,
    cloudflare_account_id: ids.accountId,
  };
  if (plan.target.provider === "cloudflare-workers") values.custom_domains = true;
  if (plan.target.provider === "own" || plan.target.provider === "portainer") {
    values.access_applications = true;
    values.protected_route_records = true;
  }
  await write(join(plan.infra.dir, "main.tf"), "# the app's root\n");
  await write(
    join(plan.infra.dir, "terraform.tfvars.json"),
    `${JSON.stringify(values, null, 2)}\n`,
  );
  const ctx: RenderContext = {
    opscrewVersion: "0.0.0-test",
    github: { owner: "acme", repo: "shop" },
    deploySshPublicKey: "",
    cloudflare: ids,
  };
  const buckets = [
    ...(providerBucket(plan)?.provider === "r2" ? renderStorage(plan, ctx) : []),
    ...(backupsBucketOf(plan)?.provider === "r2" ? renderBackups(plan, ctx) : []),
  ];
  for (const file of buckets) await write(file.path, file.content);
}

/**
 * The app on `target` after the switch: New's zone active (Old's moved), the move recorded at
 * `o.step` (default `adopted`), the committed roots with New's ids, and a session of the finish
 * (interactive, every approval recorded and granted unless `answers.approve` says otherwise) with
 * a {@link FinishEngine}.
 */
export async function finishWorld(target: FinishTarget, o: FinishWorldOptions = {}) {
  const step = o.step ?? "adopted";
  if (o.buckets && target !== "cloud" && target !== "portainer") {
    throw new Error("buckets only on a cloud server or Portainer");
  }
  const start =
    o.buckets && (target === "cloud" || target === "portainer")
      ? await withBuckets(target, step)
      : await withoutBuckets(target, step);
  const { h } = start;
  // Every approval asked and recorded, as in a terminal; granted unless `answers.approve` says no.
  const answers: {
    approve: (request: ApprovalRequest) => boolean | { approved: boolean; confirmation?: string };
  } = { approve: () => true };
  const handler = new ScriptedApprovalHandler((request) => answers.approve(request));
  const bZone = h.cloudflare.zone(ZONE, "New");
  h.cloudflare.activate(bZone);
  const old = h.cloudflare.account("Old");
  const fresh = h.cloudflare.account("New");
  const engine = new FinishEngine();
  const first = await h.open({
    command: FINISH_COMMAND,
    services: { ...start.services, engine: async () => engine },
  });
  const [prod] = first.environments;
  if (prod === undefined) throw new Error("the app's environment is covered");
  await commitRoots(h.root, prod.plan, { zoneId: bZone.id, accountId: fresh.id });
  if (target === "portainer") {
    await recordPortainerConnection(prod.paths, {
      url: PORTAINER_URL,
      environmentId: 3,
      environmentName: "local",
    });
  }
  const approvals = new ApprovalGate({
    handler,
    store: new MemoryApprovalStore(),
    audit: first.deps.audit,
    clock: first.deps.clock,
  });
  const session: MoveSession = {
    ...first,
    deps: { ...first.deps, approvals, interactive: true },
  };
  const environment: MoveEnvironment = prod;
  const roots = await shadowRoots(session, environment);
  const rootOf = (name: ShadowRoot["name"]): ShadowRoot => {
    const found = roots.find((root) => root.name === name);
    if (found === undefined) throw new Error(`no ${name} root`);
    return found;
  };
  /** Writes A's former state of a root (as the swap leaves it), with its outputs. */
  const seedRemoval = async (
    name: ShadowRoot["name"],
    addresses: readonly string[],
    outputs?: Record<string, unknown>,
  ) => {
    const { removalState } = shadowFiles(rootOf(name));
    await mkdir(dirname(removalState), { recursive: true });
    await writeFile(removalState, addressState(addresses));
    if (outputs !== undefined) engine.stateOutputs.set(removalState, outputs);
  };
  /** Writes B's shadow state of a root, with its outputs. */
  const seedShadow = async (
    name: ShadowRoot["name"],
    addresses: readonly string[],
    outputs?: Record<string, unknown>,
  ) => {
    const { statePath } = rootOf(name);
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, addressState(addresses));
    if (outputs !== undefined) engine.stateOutputs.set(statePath, outputs);
  };
  /** Every call that changed something in Old. */
  const aWrites = () =>
    h.cloudflare.calls.filter((call) => call.method !== "GET" && call.accountId === old.id);
  /** True when a token, a key, a secret or the server's address was said, sent or passed as a -var. */
  const leaks = (...texts: string[]) => {
    const said = [
      ...texts,
      h.deps.reporter.text(),
      JSON.stringify(h.deps.audit.entries),
      JSON.stringify(handler.requests),
      JSON.stringify(engine.planOptions.map((options) => options?.vars)),
      JSON.stringify(engine.importOptions.map((options) => options?.vars)),
    ].join("\n");
    return (
      start.leaks(...texts) ||
      [DEPLOY_TOKEN, TOKEN_ID, TOKEN_SECRET, SERVER_IPV4].some((secret) => said.includes(secret))
    );
  };
  return {
    ...h,
    session,
    environment,
    engine,
    handler,
    answers,
    old,
    fresh,
    bZone,
    r2: start.r2,
    rootOf,
    seedRemoval,
    seedShadow,
    aWrites,
    leaks,
  };
}

export type FinishWorld = Awaited<ReturnType<typeof finishWorld>>;
