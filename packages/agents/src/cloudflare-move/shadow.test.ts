import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ResourceChange } from "@opscrew/contracts";
import {
  ApprovalGate,
  findExecutable,
  MemoryApprovalStore,
  OpsCrewError,
  tfstateFile,
} from "@opscrew/core";
import { backupsRootDir, pagesVerificationRootDir, storageRootDir } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { appPlan } from "../apps/__fixtures__/sites";
import { environmentPaths } from "../environments/paths";
import { backupsStateFile, pagesVerificationStateFile, storageStateFile } from "../shared";
import { pagesTestPlan, ScriptedApprovalHandler, sitePlan, testPlan, withBucket } from "../testing";
import { readAppProgress } from "./progress";
import { serverPlan, unencrypted, ZONE } from "./session.fakes";
import {
  dropShadow,
  importIntoShadow,
  patchTfvars,
  prepareRemoval,
  seedShadow,
  shadowFiles,
  shadowOutputs,
  shadowRoots,
  swapShadow,
} from "./shadow";
import {
  addressState,
  CLOUDFLARE_ADDRESSES,
  SERVER_ADDRESSES,
  type ShadowHarnessOptions,
  StateFileEngine,
  shadowHarness,
  stateAddresses,
} from "./shadow.fakes";
import { checkAfterSwap, planRemoval, planShadow } from "./shadow-plans";
import type { MoveEnvironment, MoveSession, ShadowRoot } from "./types";

const { record, certificates, tunnel, secret } = CLOUDFLARE_ADDRESSES;

/** A planned change of `address`. */
function change(address: string, action: ResourceChange["action"]): ResourceChange {
  const [type = "", name = ""] = address.replace(/^module\.\w+\./, "").split(".");
  return { address, type, name, provider: "registry.opentofu.org/test/test", action };
}

/** prod's plan with the app's files and the snapshots' copies in R2. */
function bucketsPlan(): DeployPlan {
  return DeployPlanSchema.parse({
    ...withBucket(serverPlan(), "r2"),
    snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
  });
}

type Harness = Awaited<ReturnType<typeof shadowHarness>>;

/** The session's first covered environment. */
function prodOf(h: Harness): MoveEnvironment {
  const [prod] = h.session.environments;
  if (prod === undefined) throw new Error("no covered environment");
  return prod;
}

/** The harness of prod's server, its main root's values naming the PIN login. */
async function serverHarness(engine: StateFileEngine, o: ShadowHarnessOptions = {}) {
  const h = await shadowHarness((plans) => [plans.prod?.infra.dir ?? ""], {
    engine,
    values: { [serverPlan().infra.dir]: { one_time_pin_identity_provider_id: "pin-of-old" } },
    ...o,
  });
  const [prod] = h.session.environments;
  if (prod === undefined) throw new Error("no prod");
  const [main] = await shadowRoots(h.session, prod);
  if (main === undefined) throw new Error("no main root");
  return { ...h, main };
}

/** The ids of an account's zone and the account. */
function idsOf(h: Harness, account: "Old" | "New") {
  return {
    cloudflare_zone_id: h.cloudflare.zone(ZONE, account).id,
    cloudflare_account_id: h.cloudflare.account(account).id,
  };
}

/** Every saved plan's sidecar and the move's local file, as text. */
async function savedTexts(h: Harness): Promise<string> {
  const dir = h.deps.paths.files.plansDir;
  const names = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith(".json"));
  const sidecars = await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")));
  return [...sidecars, JSON.stringify(await readAppProgress(h.deps.paths))].join("\n");
}

/** True when anything said, saved, sent or passed as a `-var` holds a token or the server's address. */
async function leaked(h: Harness, engine: StateFileEngine, ...texts: string[]): Promise<boolean> {
  const vars = [
    ...engine.planOptions.map((options) => options?.vars),
    ...engine.importOptions.map((options) => options?.vars),
  ];
  return h.leaks(...texts, JSON.stringify(vars), await savedTexts(h));
}

/** The approvals asked for so far. */
function requests(h: Harness) {
  return (h.deps.approvalHandler as ScriptedApprovalHandler).requests;
}

/** The plan files in the environment's plans folder. */
async function planFiles(session: MoveSession): Promise<string[]> {
  return (await readdir(session.deps.paths.files.plansDir).catch(() => [])).filter((name) =>
    name.endsWith(".tfplan"),
  );
}

describe.skipIf(!findExecutable("git"))("shadowRoots", () => {
  it("names each root with Cloudflare resources, its shadow state, data folder and B's ids", async () => {
    const staging = appPlan(
      undefined,
      "staging",
      unencrypted(testPlan({ domain: `staging.shop.${ZONE}`, deployed: true })),
    );
    const prodPlan = bucketsPlan();
    const h = await shadowHarness(
      () => [
        prodPlan.infra.dir,
        storageRootDir(prodPlan),
        backupsRootDir(prodPlan),
        staging.infra.dir,
      ],
      {
        plans: () => ({ prod: prodPlan, staging }),
        values: { [prodPlan.infra.dir]: { one_time_pin_identity_provider_id: "pin-of-old" } },
      },
    );
    const [prod, stagingEnv] = h.session.environments;
    if (prod === undefined || stagingEnv === undefined) throw new Error("no environments");
    const b = idsOf(h, "New");
    const folder = join(h.deps.paths.stateDir, "cloudflare-move");
    const roots = await shadowRoots(h.session, prod);
    const at = (relative: string) => join(h.root, relative);
    expect(roots).toEqual([
      {
        environment: "prod",
        name: "main",
        dir: at(prodPlan.infra.dir),
        statePath: join(folder, "tfstate", "prod.tfstate"),
        dataDir: join(folder, "tf", basename(prodPlan.infra.dir)),
        vars: { ...b, one_time_pin_identity_provider_id: h.pins.b },
      },
      {
        environment: "prod",
        name: "storage",
        dir: at(storageRootDir(prodPlan)),
        statePath: join(folder, "tfstate", "storage.tfstate"),
        dataDir: join(folder, "tf", basename(storageRootDir(prodPlan))),
        vars: b,
      },
      {
        environment: "prod",
        name: "backups",
        dir: at(backupsRootDir(prodPlan)),
        statePath: join(folder, "tfstate", "backups.tfstate"),
        dataDir: join(folder, "tf", basename(backupsRootDir(prodPlan))),
        vars: b,
      },
    ]);
    const [main, storage, backups] = roots as [ShadowRoot, ShadowRoot, ShadowRoot];
    expect(shadowFiles(main).environmentState).toBe(tfstateFile(prod.paths));
    expect(shadowFiles(storage).environmentState).toBe(storageStateFile(prod.paths));
    expect(shadowFiles(backups)).toEqual({
      environmentState: backupsStateFile(prod.paths),
      removalState: join(folder, "a-removal", "tfstate", "backups.tfstate"),
      removalDataDir: join(folder, "a-removal", "tf", basename(backupsRootDir(prodPlan))),
    });

    const stagingFolder = join(
      environmentPaths(h.deps.paths, "staging").stateDir,
      "cloudflare-move",
    );
    const [stagingMain, ...more] = await shadowRoots(h.session, stagingEnv);
    expect(more).toEqual([]);
    expect(stagingMain).toMatchObject({
      environment: "staging",
      statePath: join(stagingFolder, "tfstate", "staging.tfstate"),
      vars: b,
    });
    expect(shadowFiles(stagingMain as ShadowRoot).environmentState).toBe(
      tfstateFile(stagingEnv.paths),
    );
    expect(h.readOnly()).toBe(true);
    expect(h.leaks(JSON.stringify(roots))).toBe(false);
  });

  it("plans a Workers site without its custom domains, and GitHub's verification record once made", async () => {
    const site = unencrypted(sitePlan({ domain: `site.${ZONE}`, deployed: true }));
    const h = await shadowHarness((plans) => [plans.prod?.infra.dir ?? ""], {
      plans: () => ({ prod: site }),
    });
    const [main, ...more] = await shadowRoots(h.session, prodOf(h));
    expect(more).toEqual([]);
    expect(main?.vars).toEqual({ ...idsOf(h, "New"), custom_domains: "false" });

    const pages = unencrypted(pagesTestPlan({ domain: `pages.${ZONE}` }));
    const verification = pagesVerificationRootDir(pages);
    const p = await shadowHarness(() => [pages.infra.dir, verification], {
      plans: () => ({ prod: pages }),
      files: {
        ".opscrew/tfstate/prod.tfstate": addressState([record]),
        ".opscrew/tfstate/github-pages-verification.tfstate": addressState([record]),
      },
    });
    const prod = p.session.environments[0];
    if (prod === undefined) throw new Error("no prod");
    const roots = await shadowRoots(p.session, prod);
    expect(roots.map((root) => [root.name, root.dir, basename(root.statePath)])).toEqual([
      ["main", join(p.root, pages.infra.dir), "prod.tfstate"],
      ["pages-verification", join(p.root, verification), "github-pages-verification.tfstate"],
    ]);
    expect(shadowFiles(roots[1] as ShadowRoot).environmentState).toBe(
      pagesVerificationStateFile(prod.paths),
    );
    expect(roots[0]?.vars).toEqual(idsOf(p, "New"));
  });

  it("stops plainly when a root's committed values are missing", async () => {
    const h = await shadowHarness(() => [], {});
    const [prod] = h.session.environments;
    const error = await shadowRoots(h.session, prod as MoveEnvironment).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      `${serverPlan().infra.dir}/terraform.tfvars.json is missing or damaged, so OpsCrew can't tell which Cloudflare ids the app's pieces have. Nothing was changed.`,
    );
    expect((error as OpsCrewError).hint).toBe(
      "Restore it from Git, then run `opscrew cloudflare move` again.",
    );
  });
});

describe.skipIf(!findExecutable("git"))("seedShadow", () => {
  it("copies the environment's state without its Cloudflare addresses against the shadow backend", async () => {
    const engine = new StateFileEngine();
    const h = await serverHarness(engine);
    const { main } = h;
    const state = shadowFiles(main).environmentState;
    const before = addressState([...SERVER_ADDRESSES, record, certificates, tunnel, secret]);
    await writeFile(state, before);

    await seedShadow(h.session, main);
    expect(await stateAddresses(main.statePath)).toEqual([...SERVER_ADDRESSES]);
    expect(await readFile(state, "utf8")).toBe(before);
    expect(engine.initOptions?.backendConfig).toEqual({ path: main.statePath });
    expect(engine.initOptions?.env).toMatchObject({
      TF_DATA_DIR: main.dataDir,
      CLOUDFLARE_API_TOKEN: h.tokens.b,
    });
    expect(engine.stateRemoveOptions[0]?.env?.TF_DATA_DIR).toBe(main.dataDir);
    expect(h.deps.audit.entries).toContainEqual(
      expect.objectContaining({
        kind: "iac",
        action: "state rm",
        phase: "cloudflare-move",
        target: "prod main root",
      }),
    );

    // Seeded: kept as it is.
    const calls = engine.calls.length;
    await seedShadow(h.session, main);
    expect(engine.calls.length).toBe(calls);

    // A seeding that stopped after the copy is done again.
    await writeFile(main.statePath, before);
    await writeFile(`${main.statePath}.seeding`, "");
    await seedShadow(h.session, main);
    expect(await stateAddresses(main.statePath)).toEqual([...SERVER_ADDRESSES]);
    expect(await readdir(dirname(main.statePath))).toEqual(["prod.tfstate"]);
    expect(h.readOnly()).toBe(true);
    expect(await leaked(h, engine)).toBe(false);
  });

  it("leaves a Cloudflare-only root's shadow state empty, and seeds nothing without a state", async () => {
    const engine = new StateFileEngine();
    const plan = bucketsPlan();
    const h = await shadowHarness(
      () => [plan.infra.dir, storageRootDir(plan), backupsRootDir(plan)],
      {
        engine,
        plans: () => ({ prod: plan }),
      },
    );
    const [, storage, backups] = await shadowRoots(h.session, prodOf(h));
    if (storage === undefined || backups === undefined) throw new Error("no bucket roots");
    await writeFile(
      shadowFiles(storage).environmentState,
      addressState(["cloudflare_r2_bucket.this"]),
    );
    await seedShadow(h.session, storage);
    expect(await stateAddresses(storage.statePath)).toEqual([]);

    const calls = engine.calls.length;
    await seedShadow(h.session, backups);
    expect(engine.calls.length).toBe(calls);
    await expect(readFile(backups.statePath)).rejects.toThrow();
  });
});

describe.skipIf(!findExecutable("git"))("planShadow", () => {
  const CREATES = [change(record, "create"), change(tunnel, "create"), change(secret, "create")];

  it("plans in B with B's token and ids, stops a script with the hash and applies it with --approve", async () => {
    const engine = new StateFileEngine({ changes: CREATES });
    const h = await serverHarness(engine);
    const { main, session } = h;
    const step = await planShadow(session, main);
    if (step.kind !== "pending") throw new Error(`planned ${step.kind}`);
    const [options] = engine.planOptions;
    expect(options?.vars).toEqual(main.vars);
    expect(options?.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: h.tokens.b,
      TF_DATA_DIR: main.dataDir,
    });
    expect(Object.values(options?.env ?? {})).not.toContain(h.tokens.a);
    expect(options?.env).not.toHaveProperty("OPSCREW_NEW_CLOUDFLARE_API_TOKEN");
    expect(engine.initOptions?.backendConfig).toEqual({ path: main.statePath });
    expect((await readAppProgress(h.deps.paths)).pending).toMatchObject({
      action: "shadow-create",
      environment: "prod",
      root: "main",
      planHash: step.planHash,
    });
    expect(await planFiles(session)).toEqual([expect.stringMatching(/-move\.tfplan$/)]);
    expect(engine.applied).toEqual([]);
    expect(requests(h)).toEqual([]);

    session.approve = step.planHash;
    const applied = await planShadow(session, main);
    expect(applied).toMatchObject({ kind: "applied", planHash: step.planHash });
    expect(session.approve).toBeUndefined();
    expect(engine.applied).toHaveLength(1);
    expect(engine.applied[0]?.approval.allowDestroy).toBe(false);
    expect(requests(h)).toEqual([
      expect.objectContaining({
        kind: "iac-apply",
        planHash: step.planHash,
        title: `Create shop's Cloudflare pieces (prod) in the Cloudflare account New (nothing changes in the account that holds ${ZONE} now)`,
      }),
    ]);
    expect(requests(h)[0]).not.toHaveProperty("costDelta");
    expect((await readAppProgress(h.deps.paths)).pending).toBeUndefined();
    expect(await leaked(h, engine)).toBe(false);
  });

  it("holds back Access applications and the records they protect while B's zone is pending", async () => {
    const engine = new StateFileEngine({ changes: CREATES });
    const values = { access_applications: true, protected_route_records: true };
    const h = await serverHarness(engine, { values: { [serverPlan().infra.dir]: values } });
    const { session, main } = h;
    expect(main.vars).toEqual(idsOf(h, "New"));
    await planShadow(session, main);
    expect(engine.planOptions[0]?.vars).toEqual({
      ...main.vars,
      access_applications: "false",
      protected_route_records: "false",
    });
    const zone = session.accounts.b.zone;
    if (zone === undefined) throw new Error("no zone in B");
    session.accounts.b.zone = { ...zone, status: "active" };
    await planShadow(session, main);
    expect(engine.planOptions[1]?.vars).toEqual(main.vars);
  });

  it("refuses a plan that does more than create Cloudflare pieces, before any approval", async () => {
    const engine = new StateFileEngine({
      changes: [...CREATES, change("module.server.hcloud_server.this", "update")],
    });
    const h = await serverHarness(engine, { interactive: true });
    const error = await planShadow(h.session, h.main).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      [
        "The plan of shop's Cloudflare pieces (prod) in the Cloudflare account New would do more than create them there, so OpsCrew stopped. Nothing was changed.",
        "  update module.server.hcloud_server.this",
      ].join("\n"),
    );
    expect(await planFiles(h.session)).toEqual([]);
    expect((await readAppProgress(h.deps.paths)).pending).toBeUndefined();
    expect(requests(h)).toEqual([]);
    expect(engine.applied).toEqual([]);
  });

  it("applies in a terminal after the approval; a refused one keeps the plan for --approve", async () => {
    const engine = new StateFileEngine({ changes: CREATES });
    const h = await serverHarness(engine, { interactive: true });
    const { session, main } = h;
    const handler = new ScriptedApprovalHandler([false]);
    const { deps } = session;
    deps.approvals = new ApprovalGate({
      handler,
      store: new MemoryApprovalStore(),
      audit: deps.audit,
      clock: deps.clock,
    });
    const refusedRun = await planShadow(session, main).catch((e: unknown) => e);
    expect((refusedRun as OpsCrewError).code).toBe("APPROVAL_REFUSED");
    const pending = (await readAppProgress(h.deps.paths)).pending;
    expect(pending?.action).toBe("shadow-create");

    deps.approvals = new ApprovalGate({
      handler: new ScriptedApprovalHandler(),
      store: new MemoryApprovalStore(),
      audit: deps.audit,
      clock: deps.clock,
    });
    session.approve = pending?.planHash;
    const plans = engine.planOptions.length;
    expect(await planShadow(session, main)).toMatchObject({ kind: "applied" });
    expect(engine.planOptions.length).toBe(plans);
    expect(engine.applied).toHaveLength(1);

    // Nothing left to create: no approval.
    const done = new StateFileEngine({ changes: [] });
    const again = await serverHarness(done, { interactive: true });
    expect(await planShadow(again.session, again.main)).toEqual({ kind: "unchanged", outputs: {} });
    expect(requests(again)).toEqual([]);
  });

  it("stops when the approved plan file is gone, and forgets it", async () => {
    const engine = new StateFileEngine({ changes: CREATES });
    const h = await serverHarness(engine);
    const step = await planShadow(h.session, h.main);
    if (step.kind !== "pending") throw new Error(`planned ${step.kind}`);
    for (const name of await planFiles(h.session)) {
      await writeFile(join(h.session.deps.paths.files.plansDir, name), "changed");
    }
    h.session.approve = step.planHash;
    const error = await planShadow(h.session, h.main).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("PLAN_HASH_MISMATCH");
    expect((error as OpsCrewError).message).toBe(
      `The plan you approved (hash ${step.planHash}) is missing or was changed after it was saved, so OpsCrew will not apply it. Nothing was changed.`,
    );
    expect((await readAppProgress(h.deps.paths)).pending).toBeUndefined();
    expect(engine.applied).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("the swap", () => {
  it("swaps the states in two renames, resumable after each, and never over A's former state", async () => {
    const h = await serverHarness(new StateFileEngine());
    const { main } = h;
    const { environmentState, removalState } = shadowFiles(main);
    await writeFile(environmentState, "A");
    await mkdir(dirname(main.statePath), { recursive: true });
    await writeFile(main.statePath, "B");
    await swapShadow(main);
    expect(await readFile(removalState, "utf8")).toBe("A");
    expect(await readFile(environmentState, "utf8")).toBe("B");
    await expect(readFile(main.statePath)).rejects.toThrow();
    await swapShadow(main);
    expect(await readFile(environmentState, "utf8")).toBe("B");

    // Stopped after the first rename.
    await rename(environmentState, main.statePath);
    await swapShadow(main);
    expect(await readFile(environmentState, "utf8")).toBe("B");
    expect(await readFile(removalState, "utf8")).toBe("A");

    // Both states and A's former one: nothing is renamed.
    await writeFile(main.statePath, "B2");
    const error = await swapShadow(main).catch((e: unknown) => e);
    expect((error as OpsCrewError).code).toBe("INTERNAL");
    expect(await readFile(main.statePath, "utf8")).toBe("B2");
    expect(await readFile(removalState, "utf8")).toBe("A");
  });

  it("patches only the id keys of the committed values, and nothing on a second run", async () => {
    const site = unencrypted(sitePlan({ domain: `site.${ZONE}`, deployed: true }));
    const h = await shadowHarness((plans) => [plans.prod?.infra.dir ?? ""], {
      plans: () => ({ prod: site }),
      values: {
        [site.infra.dir]: { one_time_pin_identity_provider_id: "pin-of-old", custom_domains: true },
      },
    });
    const [main] = await shadowRoots(h.session, prodOf(h));
    if (main === undefined) throw new Error("no main root");
    const file = join(main.dir, "terraform.tfvars.json");
    const before = await readFile(file, "utf8");
    expect(await patchTfvars(main)).toBe(true);
    const a = idsOf(h, "Old");
    const b = idsOf(h, "New");
    expect(await readFile(file, "utf8")).toBe(
      before
        .replace(a.cloudflare_zone_id, b.cloudflare_zone_id)
        .replace(a.cloudflare_account_id, b.cloudflare_account_id)
        .replace("pin-of-old", h.pins.b),
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ custom_domains: true });
    expect(await patchTfvars(main)).toBe(false);
  });

  it("checks the swapped state with B's token in the environment's own data folder", async () => {
    const engine = new StateFileEngine({ changes: [] });
    const h = await serverHarness(engine, { interactive: true });
    const { session, main } = h;
    expect(await checkAfterSwap(session, main)).toEqual({ kind: "unchanged", outputs: {} });
    const [options] = engine.planOptions;
    expect(options?.vars).toBeUndefined();
    expect(options?.env?.CLOUDFLARE_API_TOKEN).toBe(h.tokens.b);
    expect(options?.env).not.toHaveProperty("TF_DATA_DIR");
    expect(engine.initOptions?.backendConfig).toEqual({ path: shadowFiles(main).environmentState });
    expect(requests(h)).toEqual([]);

    const updates = new StateFileEngine({ changes: [change(record, "update")] });
    const u = await serverHarness(updates);
    const step = await checkAfterSwap(u.session, u.main);
    if (step.kind !== "pending") throw new Error(`planned ${step.kind}`);
    expect((await readAppProgress(u.deps.paths)).pending?.action).toBe("swap-check");
    u.session.approve = step.planHash;
    expect(await checkAfterSwap(u.session, u.main)).toMatchObject({ kind: "applied" });
    expect(requests(u)).toEqual([
      expect.objectContaining({
        title: "Update shop's Cloudflare pieces (prod) in place in the Cloudflare account New",
      }),
    ]);

    const replaces = new StateFileEngine({ changes: [change(record, "replace")] });
    const r = await serverHarness(replaces);
    const error = await checkAfterSwap(r.session, r.main).catch((e: unknown) => e);
    expect((error as OpsCrewError).message).toContain(`  replace ${record}`);
    expect(await leaked(u, updates)).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("the removals", () => {
  const ALL = [...SERVER_ADDRESSES, record, certificates, tunnel, secret];

  it("removes A's account-scoped pieces only, with A's token, ids and data folder, the app's name typed", async () => {
    const engine = new StateFileEngine({
      changes: [change(tunnel, "delete"), change(secret, "delete")],
    });
    const h = await serverHarness(engine);
    const { session, main } = h;
    const { removalState, removalDataDir } = shadowFiles(main);
    expect(await planRemoval(session, main, "a")).toEqual({ kind: "unchanged", outputs: {} });
    expect(engine.calls).toEqual([]);

    await mkdir(dirname(removalState), { recursive: true });
    await writeFile(removalState, addressState(ALL));
    await patchTfvars(main);
    await prepareRemoval(session, main, "a");
    expect(await stateAddresses(removalState)).toEqual([tunnel, secret]);
    expect(engine.stateRemoveOptions[0]?.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: h.tokens.a,
      TF_DATA_DIR: removalDataDir,
    });

    const step = await planRemoval(session, main, "a");
    if (step.kind !== "pending") throw new Error(`planned ${step.kind}`);
    const options = engine.planOptions.at(-1);
    expect(options?.destroy).toBe(true);
    expect(options?.vars).toEqual({
      ...idsOf(h, "Old"),
      one_time_pin_identity_provider_id: h.pins.a,
    });
    expect(options?.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: h.tokens.a,
      TF_DATA_DIR: removalDataDir,
    });
    expect(Object.values(options?.env ?? {})).not.toContain(h.tokens.b);
    expect((await readAppProgress(h.deps.paths)).pending?.action).toBe("a-removal");

    session.approve = step.planHash;
    expect(await planRemoval(session, main, "a")).toMatchObject({ kind: "applied" });
    expect(engine.applied[0]?.approval.allowDestroy).toBe(true);
    expect(requests(h)).toEqual([
      expect.objectContaining({
        title: "Delete shop's Cloudflare pieces (prod) in the Cloudflare account Old",
        allowDestroy: true,
        confirmPhrase: "shop",
      }),
    ]);
    expect(await leaked(h, engine)).toBe(false);
  });

  it("refuses a removal of A's zone-scoped pieces before any approval", async () => {
    const engine = new StateFileEngine({ changes: [change(record, "delete")] });
    const h = await serverHarness(engine, { interactive: true });
    const { removalState } = shadowFiles(h.main);
    await mkdir(dirname(removalState), { recursive: true });
    await writeFile(removalState, addressState([tunnel]));
    const error = await planRemoval(h.session, h.main, "a").catch((e: unknown) => e);
    expect((error as OpsCrewError).message).toBe(
      [
        "The removal of shop's Cloudflare pieces (prod) in the Cloudflare account Old would do more than delete its pieces that stay in that account, so OpsCrew stopped. Nothing was changed.",
        `  delete ${record}`,
      ].join("\n"),
    );
    expect(requests(h)).toEqual([]);
  });

  it("removes all of B's pieces on an abort, never the copied server", async () => {
    const engine = new StateFileEngine({
      changes: [change(record, "delete"), change(certificates, "delete"), change(tunnel, "delete")],
    });
    const h = await serverHarness(engine, { interactive: true });
    const { session, main } = h;
    await mkdir(dirname(main.statePath), { recursive: true });
    await writeFile(
      main.statePath,
      addressState([...SERVER_ADDRESSES, record, certificates, tunnel]),
    );
    await prepareRemoval(session, main, "b");
    expect(await stateAddresses(main.statePath)).toEqual([record, certificates, tunnel]);
    expect(await planRemoval(session, main, "b")).toMatchObject({ kind: "applied" });
    const options = engine.planOptions.at(-1);
    expect(options?.vars).toEqual(main.vars);
    expect(options?.env).toMatchObject({
      CLOUDFLARE_API_TOKEN: h.tokens.b,
      TF_DATA_DIR: main.dataDir,
    });
    expect(requests(h)).toEqual([
      expect.objectContaining({
        title: "Delete shop's Cloudflare pieces (prod) in the Cloudflare account New",
        confirmPhrase: "shop",
      }),
    ]);
    expect(await leaked(h, engine)).toBe(false);
  });

  it("drops a root's files only once its states hold nothing", async () => {
    const engine = new StateFileEngine();
    const h = await serverHarness(engine);
    const { session, main } = h;
    const { removalState, removalDataDir } = shadowFiles(main);
    for (const dir of [
      main.dataDir,
      removalDataDir,
      dirname(removalState),
      dirname(main.statePath),
    ]) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(main.statePath, addressState([record]));
    await writeFile(removalState, addressState([]));
    const error = await dropShadow(session, main).catch((e: unknown) => e);
    expect((error as OpsCrewError).message).toBe(
      ".opscrew/cloudflare-move/tfstate/prod.tfstate still holds pieces of shop OpsCrew hasn't removed, or can't be read, so OpsCrew keeps it. Nothing was deleted.",
    );
    expect(await stateAddresses(main.statePath)).toEqual([record]);

    await writeFile(main.statePath, addressState([]));
    await dropShadow(session, main);
    for (const path of [main.statePath, main.dataDir, removalState, removalDataDir]) {
      await expect(readFile(path)).rejects.toThrow();
    }
  });
});

describe.skipIf(!findExecutable("git"))("the shadow state's outputs and imports", () => {
  it("reads the outputs and imports a custom domain against the shadow backend with B's ids", async () => {
    const engine = new StateFileEngine();
    const site = unencrypted(sitePlan({ domain: `site.${ZONE}`, deployed: true }));
    const h = await shadowHarness((plans) => [plans.prod?.infra.dir ?? ""], {
      engine,
      plans: () => ({ prod: site }),
    });
    const [main] = await shadowRoots(h.session, prodOf(h));
    if (main === undefined) throw new Error("no main root");
    expect(await shadowOutputs(h.session, main)).toEqual({});
    expect(engine.initOptions).toMatchObject({
      backendConfig: { path: main.statePath },
      env: { TF_DATA_DIR: main.dataDir },
    });

    await mkdir(dirname(main.statePath), { recursive: true });
    await writeFile(main.statePath, addressState(["module.worker.cloudflare_workers_script.this"]));
    const address = "module.worker.cloudflare_workers_custom_domain.domain[0]";
    const id = `${h.cloudflare.account("New").id}/domain-id`;
    await importIntoShadow(h.session, main, address, id);
    expect(engine.imports).toEqual([{ address, id, env: expect.any(Object) }]);
    expect(engine.importOptions[0]?.vars).toEqual(idsOf(h, "New"));
    expect(engine.importOptions[0]).toMatchObject({
      env: { TF_DATA_DIR: main.dataDir, CLOUDFLARE_API_TOKEN: h.tokens.b },
    });
    expect(await stateAddresses(main.statePath)).toContain(address);
    expect(h.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "import", phase: "cloudflare-move" }),
    );
    expect(await leaked(h, engine)).toBe(false);
  });
});
