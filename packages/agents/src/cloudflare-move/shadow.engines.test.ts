/**
 * The shadow states with the real engines (OPSCREW_TOFU_BIN / OPSCREW_TERRAFORM_BIN or PATH, as
 * `.tools/bin` provides them), skipped without them. The fixture root holds a server-like resource
 * and Cloudflare-like ones at the addresses of OpsCrew's Cloudflare module calls, all the engines'
 * built-in `terraform_data`, which stands in for the providers: no provider is downloaded and
 * nothing reaches a network. A Workers site's root, so B's plan leaves out its custom domain until
 * it is imported; OpenTofu encrypts the states with the project's passphrase.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IacEngine, IacEngineName } from "@opscrew/contracts";
import { findExecutable, tfstateFile } from "@opscrew/core";
import { detectEngines, selectEngine, tofuEncryptionEnv } from "@opscrew/iac-engine";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { ensureStatePassphrase } from "../shared";
import { sitePlan } from "../testing";
import { readAppProgress } from "./progress";
import { type MoveHarness, moveHarness, ZONE } from "./session.fakes";
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
import { checkAfterSwap, planRemoval, planShadow } from "./shadow-plans";
import type { MoveSession, ShadowRoot } from "./types";

// About 35 engine commands a test: a minute on an idle machine, much longer on a busy one.
const TIMEOUT = 900_000;
const detected = await detectEngines();

const ROOT = `terraform {
  backend "local" {}
}

variable "app" {
  type = string
}

variable "cloudflare_zone_id" {
  type = string
}

variable "cloudflare_account_id" {
  type = string
}

variable "custom_domains" {
  type    = bool
  default = true
}

variable "access_applications" {
  type    = bool
  default = true
}

variable "protected_route_records" {
  type    = bool
  default = true
}

module "server" {
  source = "./piece"
  input  = "server \${var.app}"
}

module "dns" {
  source = "./piece"
  input  = "record in \${var.cloudflare_zone_id}"
}

module "tunnel" {
  source    = "./piece"
  input     = "tunnel in \${var.cloudflare_account_id}"
  protected = var.protected_route_records
}

module "access" {
  source  = "./domain"
  enabled = var.access_applications
  input   = "application in \${var.cloudflare_account_id}"
}

module "worker" {
  source  = "./domain"
  enabled = var.custom_domains
  input   = "domain in \${var.cloudflare_account_id}"
}

output "server" {
  value = module.server.value
}

output "dns" {
  value = module.dns.value
}

output "tunnel_token" {
  value     = module.tunnel.value
  sensitive = true
}
`;

const PIECE = `variable "input" {
  type = string
}

variable "protected" {
  type    = bool
  default = false
}

resource "terraform_data" "this" {
  input = var.input
}

resource "terraform_data" "protected" {
  count = var.protected ? 1 : 0
  input = "protected \${var.input}"
}

output "value" {
  value = terraform_data.this.output
}
`;

const DOMAIN = `variable "enabled" {
  type = bool
}

variable "input" {
  type = string
}

resource "terraform_data" "domain" {
  count = var.enabled ? 1 : 0
  input = var.input
}
`;

const SERVER = "module.server.terraform_data.this";
const DNS = "module.dns.terraform_data.this";
const TUNNEL = "module.tunnel.terraform_data.this";
const DOMAIN_ADDRESS = "module.worker.terraform_data.domain[0]";
/** What B's plan holds back while B's zone is pending and the switch makes: imported at the finish. */
const ACCESS = "module.access.terraform_data.domain[0]";
const PROTECTED = "module.tunnel.terraform_data.protected[0]";

/** Addresses as `state list` gives them: sorted. */
function sorted(...addresses: string[]): string[] {
  return [...addresses].sort();
}

interface EngineHarness {
  h: MoveHarness;
  session: MoveSession;
  engine: IacEngine;
  main: ShadowRoot;
  /** The engine's environment for reading the states as they are (`TF_ENCRYPTION` with OpenTofu). */
  env: Record<string, string | undefined>;
  passphrase?: string;
  ids: (account: "Old" | "New") => { zone: string; account: string };
}

/**
 * A deployed Workers site whose committed root is the fixture with A's ids, applied once with A's
 * ids as provision leaves it, and the move's session opened with the real engine `name`.
 */
async function engineHarness(name: IacEngineName): Promise<EngineHarness> {
  const encrypted = name === "tofu";
  const site = sitePlan({ domain: `site.${ZONE}`, deployed: true });
  const plan = DeployPlanSchema.parse({
    ...site,
    infra: { ...site.infra, engine: name, stateEncryption: encrypted },
  });
  const h = await moveHarness({ bZone: true, plans: () => ({ prod: plan }) });
  const ids = (account: "Old" | "New") => ({
    zone: h.cloudflare.zone(ZONE, account).id,
    account: h.cloudflare.account(account).id,
  });
  const dir = join(h.root, plan.infra.dir);
  await mkdir(join(dir, "piece"), { recursive: true });
  await mkdir(join(dir, "domain"), { recursive: true });
  await writeFile(join(dir, "main.tf"), ROOT);
  await writeFile(join(dir, "piece", "main.tf"), PIECE);
  await writeFile(join(dir, "domain", "main.tf"), DOMAIN);
  const values = {
    app: plan.app.name,
    cloudflare_zone_id: ids("Old").zone,
    cloudflare_account_id: ids("Old").account,
    custom_domains: true,
    access_applications: true,
    protected_route_records: true,
  };
  await writeFile(join(dir, "terraform.tfvars.json"), `${JSON.stringify(values, null, 2)}\n`);
  const passphrase = encrypted ? await ensureStatePassphrase(h.deps.paths) : undefined;
  const env: Record<string, string | undefined> = {
    ...h.deps.env,
    ...(passphrase === undefined ? {} : { TF_ENCRYPTION: tofuEncryptionEnv(passphrase) }),
  };
  const engine = await selectEngine(name);

  // A's deployment, as provision leaves it: the environment's state in its own data folder.
  const state = tfstateFile(h.deps.paths);
  await rm(state, { force: true });
  await engine.init(dir, { env, backendConfig: { path: state } });
  const planFile = join(h.deps.paths.files.plansDir, "deploy.tfplan");
  await mkdir(dirname(planFile), { recursive: true });
  const deployed = await engine.plan(dir, planFile, { env });
  const applied = await engine.apply(
    dir,
    planFile,
    { approvedPlanHash: deployed.planHash },
    { env },
  );
  if (!applied.ok) throw new Error(applied.log);
  await rm(planFile);

  const session = await h.open({
    to: "New",
    services: { ...h.services, engine: async () => engine },
  });
  const [prod] = session.environments;
  if (prod === undefined) throw new Error("no covered environment");
  const [main, ...more] = await shadowRoots(session, prod);
  if (main === undefined || more.length > 0) throw new Error("expected the main root only");
  return {
    h,
    session,
    engine,
    main,
    env,
    ids,
    ...(passphrase === undefined ? {} : { passphrase }),
  };
}

/** Applies the step's plan the way a script does: the run stops with its hash, `--approve` applies it. */
async function approved(
  session: MoveSession,
  step: (session: MoveSession) => Promise<{ kind: string; planHash?: string }>,
): Promise<void> {
  const planned = await step(session);
  expect(planned.kind).toBe("pending");
  session.approve = planned.planHash;
  expect((await step(session)).kind).toBe("applied");
  expect(session.approve).toBeUndefined();
}

/** The move's files, the saved plans' sidecars and the environment's states, as text. */
async function everything(t: EngineHarness): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "providers" && entry.name !== "modules") await walk(path);
      } else if (/\.(?:tfstate|json|backup)$/.test(entry.name)) {
        files.push(await readFile(path, "utf8"));
      }
    }
  };
  const { files: paths, stateDir } = t.h.deps.paths;
  for (const dir of [join(stateDir, "cloudflare-move"), paths.plansDir, paths.tfstateDir])
    await walk(dir);
  return [...files, JSON.stringify(await readAppProgress(t.h.deps.paths))].join("\n");
}

for (const name of ["tofu", "terraform"] as const satisfies readonly IacEngineName[]) {
  const found = detected.find((engine) => engine.name === name && engine.supported);
  if (!found) {
    console.warn(
      `[agents] skipping the shadow states with the real ${name}: no usable ${name} binary (set OPSCREW_${name.toUpperCase()}_BIN or add .tools/bin to PATH).`,
    );
  }

  describe.skipIf(!found || !findExecutable("git"))(`shadow states with the real ${name}`, () => {
    it(
      "seeds, plans in B, imports, swaps after a stop, patches, checks and removes A's pieces",
      async () => {
        const t = await engineHarness(name);
        const { session, engine, main, env } = t;
        const list = (file: string) => engine.stateResources(file, { env });
        const { environmentState, removalState, removalDataDir } = shadowFiles(main);
        const b = t.ids("New");
        const a = t.ids("Old");
        // Ids only in the -vars.
        expect(main.vars).toEqual({
          cloudflare_zone_id: b.zone,
          cloudflare_account_id: b.account,
          custom_domains: "false",
        });
        const before = await readFile(environmentState, "utf8");
        if (name === "tofu") expect(JSON.parse(before)).toHaveProperty("encrypted_data");
        const deployed = sorted(ACCESS, DNS, SERVER, PROTECTED, TUNNEL, DOMAIN_ADDRESS);
        expect(await list(environmentState)).toEqual(deployed);

        await seedShadow(session, main);
        expect(await list(main.statePath)).toEqual([SERVER]);
        expect(await readFile(environmentState, "utf8")).toBe(before);
        if (name === "tofu") {
          expect(JSON.parse(await readFile(main.statePath, "utf8"))).toHaveProperty(
            "encrypted_data",
          );
        }

        // B's zone is pending: no Access application, no record it protects, no custom domain.
        await approved(session, (s) => planShadow(s, main));
        expect(await list(main.statePath)).toEqual([DNS, SERVER, TUNNEL]);
        expect(await shadowOutputs(session, main)).toMatchObject({
          server: `server ${session.environments[0]?.plan.app.name}`,
          dns: `record in ${b.zone}`,
          tunnel_token: `tunnel in ${b.account}`,
        });
        // A's state and its outputs are as they were.
        expect(await readFile(environmentState, "utf8")).toBe(before);
        expect(await engine.output(main.dir, { env })).toMatchObject({
          dns: `record in ${a.zone}`,
        });

        // What the switch made in B, imported as the finish does.
        for (const address of [DOMAIN_ADDRESS, ACCESS, PROTECTED]) {
          await importIntoShadow(session, main, address, `id-of-${address}`);
        }
        expect(await list(main.statePath)).toEqual(deployed);

        // The swap stopped after its first rename, then a run finishes it.
        await mkdir(dirname(removalState), { recursive: true });
        await rename(environmentState, removalState);
        await swapShadow(main);
        await swapShadow(main);
        expect(await list(environmentState)).toEqual(deployed);
        expect(await list(removalState)).toEqual(deployed);
        await expect(readFile(main.statePath)).rejects.toThrow();

        const tfvars = join(main.dir, "terraform.tfvars.json");
        const committed = await readFile(tfvars, "utf8");
        expect(await patchTfvars(main)).toBe(true);
        expect(await readFile(tfvars, "utf8")).toBe(
          committed.replace(a.zone, b.zone).replace(a.account, b.account),
        );

        // The imported pieces get their values in place; then nothing is left to change.
        await approved(session, (s) => checkAfterSwap(s, main));
        expect(await checkAfterSwap(session, main)).toEqual({
          kind: "unchanged",
          outputs: expect.objectContaining({ dns: `record in ${b.zone}` }),
        });

        await prepareRemoval(session, main, "a");
        expect(await list(removalState)).toEqual(
          sorted(ACCESS, DNS, PROTECTED, TUNNEL, DOMAIN_ADDRESS),
        );
        await approved(session, (s) => planRemoval(s, main, "a"));
        expect(await list(removalState)).toEqual([]);
        expect(await list(environmentState)).toEqual(deployed);

        await dropShadow(session, main);
        for (const path of [main.statePath, main.dataDir, removalState, removalDataDir]) {
          await expect(readFile(path)).rejects.toThrow();
        }
        const said = await everything(t);
        expect(t.h.leaks(said)).toBe(false);
        if (t.passphrase !== undefined) {
          expect(`${said}\n${t.h.deps.reporter.text()}`).not.toContain(t.passphrase);
        }
      },
      TIMEOUT,
    );

    it(
      "removes all of B's pieces on an abort and leaves A's state as it was",
      async () => {
        const t = await engineHarness(name);
        const { session, engine, main, env } = t;
        const list = (file: string) => engine.stateResources(file, { env });
        const { environmentState } = shadowFiles(main);
        const before = await readFile(environmentState, "utf8");
        await seedShadow(session, main);
        await approved(session, (s) => planShadow(s, main));

        await prepareRemoval(session, main, "b");
        expect(await list(main.statePath)).toEqual([DNS, TUNNEL]);
        await approved(session, (s) => planRemoval(s, main, "b"));
        expect(await list(main.statePath)).toEqual([]);
        await dropShadow(session, main);
        await expect(readFile(main.statePath)).rejects.toThrow();
        expect(await readFile(environmentState, "utf8")).toBe(before);
        expect(t.h.leaks(await everything(t))).toBe(false);
      },
      TIMEOUT,
    );
  });
}
