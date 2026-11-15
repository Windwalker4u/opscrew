/**
 * Test helpers for the abort: the move harness with the app prepared in New (its record, its
 * shadow states holding B's pieces, its records and mark in New's pending zone), a fake engine
 * whose destroy plans delete what their state holds, the registrar and the public DNS, and an
 * approval handler that answers each request as a test says.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CloudflareClient, OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import type {
  ApprovalRequest,
  DsRecord,
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacEngine,
  IacRunOptions,
  PlanSummary,
  ResourceChange,
} from "@opscrew/contracts";
import { ApprovalGate, MemoryApprovalStore } from "@opscrew/core";
import {
  backupsRootDir,
  pagesVerificationRootDir,
  providerBucket,
  storageRootDir,
} from "@opscrew/iac-templates";
import {
  backupsBucketOf,
  type CloudflareMove,
  type DeployPlan,
  DeployPlanSchema,
} from "@opscrew/plan-schema";
import { vi } from "vitest";
import type { DomainServices } from "../domain";
import { environmentPaths } from "../environments/paths";
import { DNS_OVER_HTTPS_URL, pagesVerificationStateFile } from "../shared";
import { connectApi, FakeRegistrar, ScriptedApprovalHandler } from "../testing";
import { abortMove } from "./abort";
import { appMark, type MoveMark, markContents, markName } from "./marks";
import type { MoveRoot } from "./progress";
import { moveHarness, recordedMove, serverPlan, ZONE } from "./session.fakes";
import { shadowRoots } from "./shadow";
import { addressState, StateFileEngine, stateAddresses } from "./shadow.fakes";
import type { AbortMoveOptions, MoveServices, MoveSession, ShadowRoot } from "./types";
import { MARK_COMMENT } from "./zone";

/** Addresses of B's pieces in a shadow state. */
export const B_PIECES = {
  record: (name: string) => `module.dns.cloudflare_dns_record.this["${name}"]`,
  certificates: "module.dns.cloudflare_certificate_pack.this",
  tunnel: "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
  worker: "module.worker.cloudflare_workers_script.this",
  bucket: "cloudflare_r2_bucket.this",
  verification: 'cloudflare_dns_record.verification["docs.example.com"]',
} as const;

/** The server's resources a main shadow state was seeded with. */
export const COPIED_SERVER = ["module.server.hcloud_server.this", "tls_private_key.deploy"];

/** A bucket root's committed `main.tf`, with its guard. */
export const GUARDED_BUCKET = [
  'resource "cloudflare_r2_bucket" "this" {',
  "  account_id = var.cloudflare_account_id",
  "  name       = var.bucket",
  "",
  "  lifecycle {",
  "    prevent_destroy = true",
  "  }",
  "}",
  "",
].join("\n");

/** A planned deletion of `address`. */
function deletion(address: string): ResourceChange {
  const [type = "", name = ""] = address.replace(/^module\.\w+\./, "").split(".");
  return { address, type, name, provider: "registry.opentofu.org/test/test", action: "delete" };
}

/**
 * The state-file engine whose destroy plans delete every address their state holds, and whose
 * apply of one empties that state and tells `onDestroy`; `output` answers `shown`.
 */
export class AbortEngine extends StateFileEngine {
  shown: Record<string, unknown> = {};
  /** Each destroy plan made: its root folder and that folder's `main.tf`, when it has one. */
  readonly destroyPlans: { dir: string; mainTf?: string }[] = [];
  onDestroy: (addresses: readonly string[]) => void = () => {};
  readonly #destroys = new Map<string, { statePath: string; addresses: string[] }>();

  constructor() {
    super({ changes: [] });
  }

  override async plan(
    dir: string,
    planFile: string,
    options: Parameters<IacEngine["plan"]>[2] = {},
  ): Promise<PlanSummary> {
    if (options.destroy !== true) return super.plan(dir, planFile, options);
    const statePath = this.bound(dir, options.env);
    const addresses = await stateAddresses(statePath);
    this.scenario.changes = addresses.map(deletion);
    const mainTf = await readFile(join(dir, "main.tf"), "utf8").catch(() => undefined);
    this.destroyPlans.push({ dir, ...(mainTf === undefined ? {} : { mainTf }) });
    this.#destroys.set(planFile, { statePath, addresses });
    return super.plan(dir, planFile, options);
  }

  override async apply(
    dir: string,
    planFile: string,
    approval: IacApproval,
    options: IacRunOptions = {},
  ): Promise<IacApplyResult> {
    const result = await super.apply(dir, planFile, approval, options);
    const destroy = this.#destroys.get(planFile);
    if (result.ok && destroy !== undefined) {
      await writeFile(destroy.statePath, addressState([]));
      this.onDestroy(destroy.addresses);
    }
    return result;
  }

  override async output(): Promise<Record<string, unknown>> {
    this.calls.push("output");
    return this.shown;
  }
}

export interface AbortHarnessOptions {
  /** prod's plan (default a proxied cloud server's). */
  plan?: DeployPlan;
  /** The record's step (default `prepared`). */
  step?: CloudflareMove["step"];
  /** The registry published a DS record when the move started. */
  dsAtStart?: boolean;
  /** New has the zone (default true): prepare got past its zone plan. */
  bZone?: boolean;
  /** Other apps' marks in New's zone. */
  marks?: MoveMark[];
  /** What each of B's shadow states holds (default: the main root's copied server, record, certificates). */
  shadow?: Partial<Record<MoveRoot, string[]>>;
  /** Where the zone is registered: Porkbun (default, its API reads the nameservers) or elsewhere. */
  registrar?: "porkbun" | "other";
  /** Variables of the environment. */
  env?: Record<string, string | undefined>;
}

/** The root folders of `plan` that hold Cloudflare resources, by root (relative). */
function rootFolders(plan: DeployPlan): Partial<Record<MoveRoot, string>> {
  return {
    main: plan.infra.dir,
    ...(providerBucket(plan)?.provider === "r2" ? { storage: storageRootDir(plan) } : {}),
    ...(backupsBucketOf(plan)?.provider === "r2" ? { backups: backupsRootDir(plan) } : {}),
    ...(plan.target.provider === "github-pages"
      ? { "pages-verification": pagesVerificationRootDir(plan) }
      : {}),
  };
}

/** `plan` with the move's record from Old to New at `step`. */
function moving(
  plan: DeployPlan,
  cloudflare: Parameters<typeof recordedMove>[1],
  o: AbortHarnessOptions,
): DeployPlan {
  const recorded = recordedMove(plan, cloudflare);
  const move = recorded.cloudflareMove as CloudflareMove;
  const step = o.step ?? "prepared";
  return DeployPlanSchema.parse({
    ...recorded,
    cloudflareMove: {
      ...move,
      to: {
        ...move.to,
        ...(o.bZone === false ? {} : { zoneId: cloudflare.zone(ZONE, "New").id }),
      },
      dsAtStart: o.dsAtStart ?? false,
      step,
      ...(step === "started" ? {} : { preparedAt: "2026-11-20T11:00:00.000Z" }),
      ...(step === "adopted" ? { adoptedAt: "2026-11-21T09:10:00.000Z" } : {}),
    },
  });
}

/**
 * The abort's harness: {@link moveHarness} with the app's record, each root's committed values
 * with Old's ids, the one-time PIN logins of both accounts, and (with New's zone) B's shadow
 * states, the app's OpsCrew records in New and its mark beside `o.marks`. The zone is registered
 * at Porkbun with Old's nameservers (or elsewhere, read from `web.ns`); `web.ds` is the public DS.
 */
export async function abortHarness(o: AbortHarnessOptions = {}) {
  const plan = o.plan ?? serverPlan();
  const h = await moveHarness({
    bZone: o.bZone ?? true,
    plans: (cloudflare) => ({ prod: moving(plan, cloudflare, o) }),
    ...(o.env === undefined ? {} : { env: o.env }),
  });
  // A clock that moves on each reading, as one does: each saved plan gets a file of its own.
  const start = Date.parse("2026-11-21T09:00:00.000Z");
  let ticks = 0;
  h.deps.clock.now = () => new Date(start + ticks++ * 1000);
  const { cloudflare } = h;
  const aZone = cloudflare.zone(ZONE, "Old");
  const old = cloudflare.account("Old");
  const fresh = cloudflare.account("New");
  old.identityProviders.push({ id: "pin-of-old", name: "One-time PIN", type: "onetimepin" });
  fresh.identityProviders.push({ id: "pin-of-new", name: "One-time PIN", type: "onetimepin" });
  const folders = rootFolders(plan);
  for (const [root, folder] of Object.entries(folders)) {
    const dir = join(h.root, folder);
    await mkdir(dir, { recursive: true });
    const values = {
      cloudflare_zone_id: aZone.id,
      cloudflare_account_id: old.id,
      ...(root === "main" ? { one_time_pin_identity_provider_id: "pin-of-old" } : {}),
    };
    await writeFile(join(dir, "terraform.tfvars.json"), `${JSON.stringify(values, null, 2)}\n`);
    if (root === "storage" || root === "backups")
      await writeFile(join(dir, "main.tf"), GUARDED_BUCKET);
  }
  const prodPaths = environmentPaths(h.deps.paths, "prod");
  if (folders["pages-verification"] !== undefined) {
    const file = pagesVerificationStateFile(prodPaths);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, addressState([B_PIECES.verification]));
  }

  const engine = new AbortEngine();
  const bZone = o.bZone === false ? undefined : cloudflare.zone(ZONE, "New");
  // What B's destroy plans delete, Cloudflare no longer has.
  engine.onDestroy = (addresses) => {
    if (bZone === undefined) return;
    const names = addresses.flatMap((address) => /\["(.+)"\]$/.exec(address)?.[1] ?? []);
    for (const record of [...bZone.records]) {
      if (record.comment === OPSCREW_MANAGED_COMMENT && names.includes(record.name)) {
        bZone.records.splice(bZone.records.indexOf(record), 1);
      }
    }
  };

  // The zone's registrar and the public DNS.
  const events: string[] = [];
  const api = new FakeRegistrar("porkbun", events);
  api.own(ZONE);
  api.nameservers.set(ZONE, [...aZone.nameServers]);
  vi.spyOn(CloudflareClient.prototype, "getRegistration").mockResolvedValue(undefined);
  const registrars: DomainServices = {
    registrars: o.registrar === "other" ? {} : { [api.id]: connectApi(api, events) },
  };
  const web = { ns: [...aZone.nameServers], ds: [] as DsRecord[] };
  const base = h.deps.fetch;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== DNS_OVER_HTTPS_URL) return base(input, init);
    const name = url.searchParams.get("name") ?? "";
    const answer =
      url.searchParams.get("type") === "NS"
        ? web.ns.map((ns) => ({ name: `${name}.`, type: 2, TTL: 300, data: `${ns}.` }))
        : web.ds.map((r) => ({
            name: `${name}.`,
            type: 43,
            TTL: 3600,
            data: `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`,
          }));
    return Response.json({ Status: 0, ...(answer.length > 0 ? { Answer: answer } : {}) });
  };
  h.deps.fetch = fetch;

  // Every approval recorded; granted unless `answers.approve` says no.
  const answers: { approve: (request: ApprovalRequest) => boolean } = { approve: () => true };
  const handler = new ScriptedApprovalHandler((request) => answers.approve(request));
  h.deps.approvals = new ApprovalGate({
    handler,
    store: new MemoryApprovalStore(),
    audit: h.deps.audit,
    clock: h.deps.clock,
  });

  const services: MoveServices = {
    ...h.services,
    engine: async () => engine,
    registrars,
    fetch,
    sleep: async () => {},
  };
  /** A session of the move, as the abort opens it. */
  const open = (more: Partial<MoveServices> = {}): Promise<MoveSession> =>
    h.open({ services: { ...services, ...more } });

  let roots: ShadowRoot[] = [];
  if (bZone !== undefined) {
    const session = await open();
    const [environment] = session.environments;
    if (environment === undefined) throw new Error("prod is covered");
    roots = await shadowRoots(session, environment);
    const held = o.shadow ?? {
      main: [...COPIED_SERVER, B_PIECES.record(`shop.${ZONE}`), B_PIECES.certificates],
    };
    for (const root of roots) {
      const addresses = held[root.name];
      if (addresses === undefined) continue;
      await mkdir(dirname(root.statePath), { recursive: true });
      await writeFile(root.statePath, addressState(addresses));
      for (const address of addresses) {
        const name = /cloudflare_dns_record\.this\["(.+)"\]$/.exec(address)?.[1];
        if (name === undefined) continue;
        cloudflare.addRecord(bZone, {
          type: "A",
          name,
          content: "192.0.2.1",
          proxied: true,
          comment: OPSCREW_MANAGED_COMMENT,
        });
      }
    }
    const marks = [
      { name: await markName(session), mark: await appMark(session) },
      ...(o.marks ?? []).map((mark) => ({
        name: `_opscrew-move.${mark.app}-0123abcd.${ZONE}`,
        mark,
      })),
    ];
    for (const { name, mark } of marks) {
      for (const content of markContents(mark)) {
        cloudflare.addRecord(bZone, { type: "TXT", name, content, comment: MARK_COMMENT });
      }
    }
    // A record of Old's that prepare copied.
    cloudflare.addRecord(bZone, { type: "MX", name: ZONE, content: `mail.${ZONE}`, priority: 10 });
  }
  cloudflare.calls.length = 0;
  const aRecords = structuredClone(aZone.records);

  const run = (options: Partial<AbortMoveOptions> = {}) =>
    abortMove(h.deps, { ...options, services: { ...services, ...options.services } });
  /** The non-GET calls made to each account, by account name. */
  const writes = (account: "Old" | "New") =>
    cloudflare.calls.filter(
      (call) => call.method !== "GET" && call.accountId === cloudflare.account(account).id,
    );
  /** True when anything said, asked, saved, sent or passed as a `-var` holds a secret or the address. */
  const leaks = async (secrets: readonly string[], ...texts: string[]) => {
    const dir = prodPaths.files.plansDir;
    const saved = await Promise.all(
      (await readdir(dir).catch(() => [] as string[])).map((name) =>
        readFile(join(dir, name), "utf8").catch(() => ""),
      ),
    );
    const all = [
      ...texts,
      JSON.stringify(handler.requests),
      JSON.stringify(engine.planOptions.map((options) => options?.vars)),
      ...saved,
      h.deps.reporter.text(),
      JSON.stringify(h.deps.audit.entries),
    ];
    return h.leaks(...all) || secrets.some((secret) => all.some((text) => text.includes(secret)));
  };
  return {
    ...h,
    plan,
    engine,
    aZone,
    bZone,
    old,
    fresh,
    api,
    web,
    answers,
    handler,
    services,
    open,
    roots,
    prodPaths,
    run,
    writes,
    leaks,
    /** Old's zone's records are as they were. */
    aUnchanged: () => JSON.stringify(aZone.records) === JSON.stringify(aRecords),
  };
}

export type AbortHarness = Awaited<ReturnType<typeof abortHarness>>;
