/**
 * Test helpers for prepare: the move harness with the app on a target of plan 9. (a proxied cloud
 * server; one with its R2 buckets and Portainer on a subdomain behind a tunnel; the user's own
 * server in tunnel mode or public; the user's Portainer; a Workers site; a GitHub Pages site; a
 * hosting account), each root's committed `terraform.tfvars.json` with A's ids, an engine whose
 * shadow states keep what B's plans created, B's tunnels in the two-account fake, the server,
 * Portainer, R2 and GitHub fakes, and the public DNS's DS answer.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FakeTunnel } from "@opscrew/connector-cloudflare/testing";
import { portainerClient } from "@opscrew/connector-portainer";
import type {
  ApprovalRequest,
  CommandResult,
  DsRecord,
  FetchLike,
  IacApplyResult,
  IacApproval,
  IacRunOptions,
  PlanSummary,
  RemoteExec,
  RemoteRunOptions,
  ResourceChange,
} from "@opscrew/contracts";
import {
  ApprovalGate,
  MemoryApprovalStore,
  type ProjectPaths,
  resolveProjectPaths,
  tfstateFile,
  toPosixRelative,
} from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import {
  backupsRootDir,
  CLOUDFLARE_DEPLOY_SECRETS_NEW,
  IMAGES,
  PORTAINER_DEPLOY_SECRETS_NEW,
  pagesVerificationRootDir,
  storageRootDir,
  TUNNEL_DEPLOY_SECRETS_NEW,
} from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { appPlan } from "../apps/__fixtures__/sites";
import { environmentPaths } from "../environments/paths";
import { hostingTestPlan } from "../hosting/__fixtures__/account";
import { originTlsApply, planOriginTls } from "../provision/origin-tls";
import { deploySecretPlace } from "../provision/secrets";
import { applySharedCloudflare, planSharedCloudflare } from "../provision/shared-cloudflare";
import {
  NEW_OFFSITE_KEY_VARS,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  STORAGE_KEY_VARS,
} from "../provision/storage";
import { DNS_OVER_HTTPS_URL, pagesVerificationStateFile } from "../shared";
import { recordPortainerConnection, updateServerAddresses } from "../shared/server-record";
import {
  fakeCertificate,
  fakePortainer,
  freshFacts,
  ownPlan,
  PORTAINER_URL,
  pagesTestPlan,
  portainerPlan,
  ScriptedApprovalHandler,
  SERVER_IPV4,
  sitePlan,
  testPlan,
  withBucket,
} from "../testing";
import { APP_BUCKET, BACKUPS_BUCKET, FakeR2 } from "./buckets.fakes";
import { B_TUNNEL, B_WEBHOOK_TUNNEL, ConnectorHost, fakeClock } from "./connector.fakes";
import { prepareMove } from "./prepare";
import { bucketKeys } from "./record.fakes";
import { moveHarness, serverPlan, unencrypted, ZONE } from "./session.fakes";
import { addressState, StateFileEngine, stateAddresses } from "./shadow.fakes";
import type { MoveResult, MoveServices, PrepareMoveOptions } from "./types";

/** Where the app runs (plan 9.). */
export type PrepareTarget =
  | "proxied"
  | "cloud"
  | "own-tunnel"
  | "own-public"
  | "portainer"
  | "site"
  | "pages"
  | "hosting";

/** Every target. */
export const PREPARE_TARGETS: readonly PrepareTarget[] = [
  "proxied",
  "cloud",
  "own-tunnel",
  "own-public",
  "portainer",
  "site",
  "pages",
  "hosting",
];

/** The secrets of the world: none may show up anywhere but where it belongs. */
const SECRETS = {
  tunnel: fakeSecret("cloudflare-token", "prepare-b-tunnel"),
  webhookTunnel: fakeSecret("cloudflare-token", "prepare-b-webhook-tunnel"),
  serviceTokenId: fakeSecret("generic-password", "prepare-b-service-token-id"),
  serviceTokenSecret: fakeSecret("generic-password", "prepare-b-service-token-secret"),
  deployToken: fakeSecret("cloudflare-token", "prepare-b-workers-deploy"),
  portainer: fakeSecret("generic-password", "prepare-portainer-api-key"),
};
const CERT = fakeCertificate("prepare portainer");

/** A cloud server with its files and snapshots' copies on R2 and Portainer on a subdomain. */
function cloudPlan(domain: string): DeployPlan {
  const base = withBucket(testPlan({ domain, deployed: true }), "r2");
  return unencrypted(
    DeployPlanSchema.parse({
      ...base,
      dns: { ...base.dns, zone: ZONE },
      portainer: {
        enabled: true,
        version: "2.33.1",
        access: "subdomain",
        hostname: `portainer.${ZONE}`,
        allowedEmails: ["owner@example.com"],
      },
      snapshots: { offsite: { provider: "r2", bucket: BACKUPS_BUCKET } },
    }),
  );
}

/** `plan` recorded as provisioned. */
function deployed(plan: DeployPlan): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    infra: { ...plan.infra, stateEncryption: false },
    deployment: { lastApplyAt: "2026-11-01T10:00:00.000Z" },
  });
}

/** The app's hostname on each target. */
const HOSTS: Readonly<Record<PrepareTarget, string>> = {
  proxied: `shop.${ZONE}`,
  cloud: `shop.${ZONE}`,
  "own-tunnel": `shop.${ZONE}`,
  "own-public": `shop.${ZONE}`,
  portainer: `shop.${ZONE}`,
  site: `site.${ZONE}`,
  pages: `pages.${ZONE}`,
  hosting: `notes.${ZONE}`,
};

/** The target's deployed plan at `domain`. */
function planOf(target: PrepareTarget, domain: string): DeployPlan {
  switch (target) {
    case "proxied":
      return serverPlan(domain);
    case "cloud":
      return cloudPlan(domain);
    case "own-tunnel":
      return unencrypted(ownPlan({ access: "tunnel", deployed: true, domain }));
    case "own-public":
      return unencrypted(ownPlan({ access: "public", deployed: true, domain }));
    case "portainer":
      return unencrypted(
        portainerPlan({ web: { mode: "tunnel" }, redeploy: "cloudflare", deployed: true, domain }),
      );
    case "site":
      return unencrypted(sitePlan({ domain, deployed: true }));
    case "pages":
      return deployed(pagesTestPlan({ domain }));
    case "hosting":
      return hostingTestPlan({ cloudflare: true });
  }
}

/** A Cloudflare resource B's plan creates at `address`. */
function created(address: string): ResourceChange {
  const local = address.replace(/^module\.\w+\./, "").replace(/\[.*\]$/, "");
  const [type = "", name = ""] = local.split(".");
  return {
    address,
    type,
    name,
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create",
  };
}

/** A state's addresses; none without the file. */
async function heldIn(file: string): Promise<string[]> {
  return stateAddresses(file).catch(() => []);
}

/** What B's plan of a root creates, and its outputs once its state holds them. */
export interface PreparedRoot {
  creates: string[];
  outputs: Record<string, unknown>;
}

/**
 * The fake engine of prepare's tests: B's plan of a root creates what {@link PreparedRoot} says
 * is missing from the state its data folder is bound to, its apply (with the plan's `-var`s, as
 * OpenTofu checks them) adds those to that state, and the state's outputs are the root's once it
 * holds anything. Each applied root folder is noted.
 */
export class PrepareEngine extends StateFileEngine {
  readonly roots = new Map<string, PreparedRoot>();
  readonly appliedDirs: string[] = [];
  readonly #planned = new Map<string, { state: string; addresses: string[] }>();

  override async plan(
    dir: string,
    planFile: string,
    options: IacRunOptions & { vars?: Record<string, string> } = {},
  ): Promise<PlanSummary> {
    const state = this.bound(dir, options.env);
    const held = await heldIn(state);
    const missing = (this.roots.get(dir)?.creates ?? []).filter((one) => !held.includes(one));
    this.scenario.changes = missing.map(created);
    const summary = await super.plan(dir, planFile, options);
    this.#planned.set(summary.planHash, { state, addresses: missing });
    return summary;
  }

  override async apply(
    dir: string,
    planFile: string,
    approval: IacApproval,
    options: IacRunOptions = {},
  ): Promise<IacApplyResult> {
    const result = await super.apply(dir, planFile, approval, options);
    const planned = this.#planned.get(approval.approvedPlanHash);
    if (!result.ok || planned === undefined) return result;
    this.appliedDirs.push(dir);
    await mkdir(dirname(planned.state), { recursive: true });
    const held = await heldIn(planned.state);
    await writeFile(planned.state, addressState([...held, ...planned.addresses]));
    return { ...result, outputs: this.roots.get(dir)?.outputs ?? {} };
  }

  override async output(dir = "", options: IacRunOptions = {}): Promise<Record<string, unknown>> {
    this.calls.push("output");
    const held = await heldIn(this.bound(dir, options.env));
    return held.length > 0 ? (this.roots.get(dir)?.outputs ?? {}) : {};
  }
}

/** What B's plan of the main root of `target`'s app at `host` creates, and its outputs. */
function bPieces(target: PrepareTarget, host: string): PreparedRoot {
  const record = `module.dns.cloudflare_dns_record.this["${host}"]`;
  const tunnel = [
    "module.tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
    "module.tunnel.random_password.secret",
  ];
  const serviceToken = {
    deploy_service_token_client_id: SECRETS.serviceTokenId,
    deploy_service_token_client_secret: SECRETS.serviceTokenSecret,
  };
  switch (target) {
    case "cloud":
      return {
        creates: [record, ...tunnel, "module.access.cloudflare_zero_trust_access_policy.this"],
        outputs: { tunnel_id: B_TUNNEL, tunnel_token: SECRETS.tunnel },
      };
    case "own-tunnel":
      return {
        creates: [...tunnel, "module.access.cloudflare_zero_trust_access_service_token.deploy"],
        outputs: { tunnel_id: B_TUNNEL, tunnel_token: SECRETS.tunnel, ...serviceToken },
      };
    case "portainer":
      return {
        creates: [
          ...tunnel,
          "module.portainer_tunnel.cloudflare_zero_trust_tunnel_cloudflared.this",
          "module.access.cloudflare_zero_trust_access_service_token.deploy",
        ],
        outputs: {
          tunnel_id: B_TUNNEL,
          tunnel_token: SECRETS.tunnel,
          portainer_tunnel_id: B_WEBHOOK_TUNNEL,
          portainer_tunnel_token: SECRETS.webhookTunnel,
          ...serviceToken,
        },
      };
    case "site":
      return {
        creates: [
          "module.worker.cloudflare_workers_script.this",
          "module.worker.cloudflare_workers_script_subdomain.this",
        ],
        outputs: {},
      };
    default:
      return { creates: [record], outputs: {} };
  }
}

/** True for a target whose main root puts hostnames behind Cloudflare Access. */
const ACCESS: ReadonlySet<PrepareTarget> = new Set(["cloud", "own-tunnel", "portainer"]);

export interface PrepareWorldOptions {
  /** A second environment, staging, on the same target at `staging.<host>`. */
  staging?: boolean;
  /** A second app of the repository, `blog` (a proxied cloud server at `blog.<zone>`). */
  secondApp?: boolean;
  /** The registry publishes a DS record for the zone. */
  ds?: boolean;
}

/** A run of prepare: interactive (every approval granted) or a script's, with `--approve <hash>`. */
export interface PrepareRun extends Omit<PrepareMoveOptions, "services" | "to"> {
  /** `--to` (default New); `null` runs without it, as a recorded move continues. */
  to?: string | null;
  /** Run as in a terminal (default true). */
  interactive?: boolean;
  /** Answers each approval request (default: granted; in a script only the `--approve` hash). */
  answer?: (request: ApprovalRequest) => boolean;
  /** The second app's (`blog`). */
  app?: "blog";
}

/**
 * The move of the app on `target` from Old to New, nothing prepared yet: its plans, states and
 * committed files as provision leaves them (each root's `terraform.tfvars.json` with Old's ids, the
 * workflows with the `_NEW` fallbacks), New's tunnels the shadow plans stand for, the server, the
 * user's Portainer, R2 in both accounts and GitHub. `run` runs prepare as a terminal or a script
 * would; `requests` are the approvals asked in every run.
 */
export async function prepareWorld(target: PrepareTarget, o: PrepareWorldOptions = {}) {
  const host = HOSTS[target];
  const plans: Record<string, DeployPlan> = { prod: planOf(target, host) };
  if (o.staging) plans.staging = appPlan(undefined, "staging", planOf(target, `staging.${host}`));
  const blog = appPlan("blog", undefined, serverPlan(`blog.${ZONE}`));
  const keys = bucketKeys("prepare-");
  const env: Record<string, string> = {};
  if (target === "cloud") {
    Object.assign(env, {
      [STORAGE_KEY_VARS.accessKeyId]: keys.a.storage.accessKeyId,
      [STORAGE_KEY_VARS.secretAccessKey]: keys.a.storage.secretAccessKey,
      [NEW_STORAGE_KEY_VARS.accessKeyId]: keys.b.storage.accessKeyId,
      [NEW_STORAGE_KEY_VARS.secretAccessKey]: keys.b.storage.secretAccessKey,
      [OFFSITE_KEY_VARS.accessKeyId]: keys.a.backups.accessKeyId,
      [OFFSITE_KEY_VARS.secretAccessKey]: keys.a.backups.secretAccessKey,
      [NEW_OFFSITE_KEY_VARS.accessKeyId]: keys.b.backups.accessKeyId,
      [NEW_OFFSITE_KEY_VARS.secretAccessKey]: keys.b.backups.secretAccessKey,
    });
  }
  if (target === "portainer") env.PORTAINER_API_KEY = SECRETS.portainer;
  if (target === "site") env.OPSCREW_NEW_CLOUDFLARE_DEPLOY_TOKEN = SECRETS.deployToken;
  const h = await moveHarness({
    plans: () => plans,
    ...(o.secondApp ? { apps: () => ({ blog }) } : {}),
    env,
  });
  const old = h.cloudflare.account("Old");
  const fresh = h.cloudflare.account("New");
  const aZone = h.cloudflare.zone(ZONE, "Old");
  h.cloudflare.tokens.set(SECRETS.deployToken, { accounts: [fresh.id], denied: new Set() });
  old.identityProviders.push({ id: "pin-of-old", name: "One-time PIN", type: "onetimepin" });
  const tunnel: FakeTunnel = { id: B_TUNNEL, name: "shop", connections: [] };
  const webhookTunnel: FakeTunnel = {
    id: B_WEBHOOK_TUNNEL,
    name: "shop-portainer",
    connections: [],
  };
  fresh.tunnels.push(tunnel, webhookTunnel);

  // The engine and each root's committed values (Old's ids), as provision leaves them.
  const engine = new PrepareEngine();
  const blogPaths = resolveProjectPaths(h.root, {
    env: { OPSCREW_HOME: join(h.root, ".home-opscrew") },
    app: "blog",
  });
  const appPaths: { paths: ProjectPaths; plan: DeployPlan; target: PrepareTarget }[] =
    Object.entries(plans).map(([name, plan]) => ({
      paths: environmentPaths(h.deps.paths, name),
      plan,
      target,
    }));
  if (o.secondApp) appPaths.push({ paths: blogPaths, plan: blog, target: "proxied" });
  for (const one of appPaths) {
    const { plan } = one;
    const roots: [string, PreparedRoot][] = [
      [plan.infra.dir, bPieces(one.target, plan.dns.domain ?? host)],
    ];
    if (one.target === "cloud") {
      roots.push([storageRootDir(plan), { creates: ["cloudflare_r2_bucket.this"], outputs: {} }]);
      roots.push([backupsRootDir(plan), { creates: ["cloudflare_r2_bucket.this"], outputs: {} }]);
    }
    if (one.target === "pages") {
      const challenge = "cloudflare_dns_record.challenge";
      roots.push([pagesVerificationRootDir(plan), { creates: [challenge], outputs: {} }]);
      const file = pagesVerificationStateFile(one.paths);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, '{"version":4}\n');
    }
    for (const [relative, pieces] of roots) {
      const dir = join(h.root, relative);
      engine.roots.set(dir, pieces);
      const access = ACCESS.has(one.target) && relative === plan.infra.dir;
      const values = {
        app: plan.app.name,
        cloudflare_zone_id: aZone.id,
        cloudflare_account_id: old.id,
        ...(one.target === "cloud" && relative === plan.infra.dir
          ? { one_time_pin_identity_provider_id: "pin-of-old" }
          : {}),
        ...(access ? { access_applications: true, protected_route_records: true } : {}),
        // A site's Worker gets its custom domains, which B's plan holds back with a `-var`.
        ...(one.target === "site" && relative === plan.infra.dir ? { custom_domains: true } : {}),
      };
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "terraform.tfvars.json"), `${JSON.stringify(values, null, 2)}\n`);
    }
    if (one.target === "site") {
      await writeFile(
        join(h.root, plan.infra.dir, "main.tf"),
        "custom_domains = var.custom_domains\n",
      );
    }
    // The workflow with the `_NEW` fallbacks (what `isMoveReady` reads of it).
    const names = [
      ...Object.values(TUNNEL_DEPLOY_SECRETS_NEW),
      ...Object.values(PORTAINER_DEPLOY_SECRETS_NEW),
      ...Object.values(CLOUDFLARE_DEPLOY_SECRETS_NEW),
    ].map((name) => `\${{ secrets.${deploySecretPlace(plan, name).name} }}`);
    const file = join(h.root, plan.cicd.workflowPath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `name: deploy\n${names.map((name) => `# ${name}\n`).join("")}`);
  }
  if (o.secondApp) {
    const file = tfstateFile(environmentPaths(blogPaths, "prod"));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{"version":4}\n');
  }

  // The server: its connectors connect New's tunnel; rclone's one-offs reach R2.
  const own = target === "own-tunnel" || target === "own-public";
  if (own) {
    await updateServerAddresses(h.deps.paths, (current) => ({
      ...current,
      own: { host: "192.0.2.50", port: 22, user: "admin", agent: true },
    }));
  }
  const server = new ConnectorHost(
    own
      ? freshFacts({ user: "admin", privilege: "sudo" })
      : freshFacts({ user: "deploy", privilege: "none" }),
    tunnel,
  );
  const r2 = new FakeR2([], () => ({ deploys: false, check: false }));
  r2.add(old.id, APP_BUCKET, keys.a.storage, { "a.png": "aaaa", "b.png": "bb" });
  r2.add(old.id, BACKUPS_BUCKET, keys.a.backups, { "backups/1/db.age": "one" });
  r2.add(fresh.id, APP_BUCKET, keys.b.storage);
  r2.add(fresh.id, BACKUPS_BUCKET, keys.b.backups);
  const commands: { command: string; input: string }[] = [];
  const remote = (address: string): RemoteExec => ({
    host: address,
    run: async (command: string, options?: RemoteRunOptions): Promise<CommandResult> => {
      commands.push({ command, input: options?.input ?? "" });
      const args = /exec rclone --config \/tmp\/r\.conf (.*)'$/.exec(command)?.[1];
      if (command.includes(IMAGES.rclone.ref) && args !== undefined) {
        return r2.run("ssh", args.split(" "), options?.input ?? "");
      }
      throw new Error(`unexpected command on the server: ${command}`);
    },
  });

  // The user's Portainer.
  const portainer = fakePortainer({ token: SECRETS.portainer });
  if (target === "portainer") {
    await recordPortainerConnection(h.deps.paths, {
      url: PORTAINER_URL,
      certFingerprint: CERT.fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: "cloudflare",
      web: { mode: "tunnel" },
    });
  }

  // The public DNS: the zone's DS records.
  const ds: DsRecord[] = o.ds
    ? [{ keyTag: 2371, algorithm: 13, digestType: 2, digest: "A".repeat(64) }]
    : [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    if (`${url.origin}${url.pathname}` !== DNS_OVER_HTTPS_URL) return h.deps.fetch(input, init);
    const name = url.searchParams.get("name") ?? "";
    const answer = ds.map((r) => ({
      name: `${name}.`,
      type: 43,
      TTL: 3600,
      data: `${r.keyTag} ${r.algorithm} ${r.digestType} ${r.digest}`,
    }));
    return Response.json({ Status: 0, ...(answer.length > 0 ? { Answer: answer } : {}) });
  };
  const clock = fakeClock();
  const services: MoveServices = {
    ...h.services,
    engine: async () => engine,
    host: server,
    remote,
    fetch,
    ...clock,
    portainer: {
      client: (endpoint, token, clientDeps) =>
        portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
      inspectCertificate: async () => CERT,
      wait: { sleep: async () => undefined, intervalMs: 1 },
    },
  };
  // A clock that moves a second each time it is read, so each saved plan has a name of its own.
  let ticks = 0;
  h.deps.clock.now = () => new Date(Date.parse("2026-11-20T10:00:00.000Z") + ticks++ * 1000);

  // Old as provision leaves it: each environment's shared plan applied there, with its origin TLS
  // (the app's client certificate kept on this computer). What that sent is no part of the tests.
  const { a } = (await h.open({ to: "New", services })).accounts;
  for (const one of appPaths) {
    const deps = { ...h.deps, paths: one.paths };
    const { plan } = one;
    const tls =
      plan.target.provider === "cloudflare-workers"
        ? undefined
        : await planOriginTls(deps, { plan, record: undefined, served: undefined });
    const planned = await planSharedCloudflare(deps, {
      services: {},
      plan,
      cloudflare: { zoneId: a.zoneId, zoneName: ZONE, accountId: a.accountId },
      command: "opscrew provision",
      tls: tls === undefined ? {} : { tls: tls.desired },
      client: a.client,
    });
    if (planned === undefined) continue;
    await applySharedCloudflare(deps, planned, {
      app: plan.app.name,
      planOnly: false,
      command: "opscrew provision",
      phase: "provision",
      ...originTlsApply(deps, tls, { sleep: async () => undefined }),
    });
  }
  h.cloudflare.calls.length = 0;
  h.deps.reporter.lines.length = 0;
  h.deps.audit.entries.length = 0;

  const requests: ApprovalRequest[] = [];
  const run = (r: PrepareRun = {}): Promise<MoveResult> => {
    const interactive = r.interactive ?? true;
    const granted = (request: ApprovalRequest) =>
      interactive || (r.approvePlanHash !== undefined && request.planHash === r.approvePlanHash);
    const handler = new ScriptedApprovalHandler((request) => {
      requests.push(request);
      return (r.answer ?? granted)(request);
    });
    const approvals = new ApprovalGate({
      handler,
      store: new MemoryApprovalStore(),
      audit: h.deps.audit,
      clock: h.deps.clock,
    });
    const { interactive: _i, answer: _a, app, to, ...options } = r;
    const deps = {
      ...h.deps,
      ...(app === "blog" ? { paths: blogPaths } : {}),
      interactive,
      approvals,
    };
    return prepareMove(deps, {
      ...(to === null ? {} : { to: to ?? "New" }),
      ...(interactive ? { confirmStart: async () => true } : {}),
      ...options,
      services,
    });
  };

  /** The plan of an environment as it is on disk now. */
  const planNow = (name = "prod", app?: "blog") =>
    readArtifact(
      "plan",
      environmentPaths(app === "blog" ? blogPaths : h.deps.paths, name).files.plan,
    );

  /** What was done in New and on the app's machines, each line a change (ids masked), sorted. */
  const done = () => {
    const mask = (text: string) =>
      text.replace(/[0-9a-f]{32}|[0-9a-f-]{36}/g, "<id>").replace(/\/[0-9a-f]{24,}\b/g, "/<id>");
    return [
      ...h.cloudflare.calls
        .filter((call) => call.method !== "GET" && call.accountId === fresh.id)
        .map((call) => `cloudflare ${call.method} ${mask(call.path)}`),
      ...engine.appliedDirs.map((dir) => `apply ${toPosixRelative(h.root, dir)}`),
      ...server.applies.map((one) => `host ${one.plan.steps.map((step) => step.id).join(",")}`),
      ...portainer.stacks.map((stack) => `stack ${stack.Name}`),
      ...h.deps.audit.entries
        .filter((entry) => entry.kind === "secret-set" || entry.action === "dispatch workflow")
        .map((entry) => `github ${entry.action}`),
      ...r2.runs.filter((one) => one.verb === "copy").map((one) => `rclone ${one.args.join(" ")}`),
    ].sort();
  };

  /** True when a call that changed anything was made in Old, or Old's buckets changed. */
  const wroteToA = () =>
    h.cloudflare.calls.some((call) => call.method !== "GET" && call.accountId === old.id) ||
    r2.objects(old.id, APP_BUCKET).size !== 2 ||
    r2.objects(old.id, BACKUPS_BUCKET).size !== 1;

  /** Every secret of the world, and both accounts' tokens. */
  const secrets = [
    ...Object.values(SECRETS),
    ...Object.values(keys.a).flatMap((key) => [key.accessKeyId, key.secretAccessKey]),
    ...Object.values(keys.b).flatMap((key) => [key.accessKeyId, key.secretAccessKey]),
  ];

  /** Every file under `dir`, as text, but OpsCrew's record of the servers' addresses. */
  const filesUnder = async (dir: string) => {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
    const texts: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === "server.json") continue;
      texts.push(await readFile(join(entry.parentPath, entry.name), "utf8").catch(() => ""));
    }
    return texts.join("\n");
  };

  /**
   * True when a token, key, connector token, service token or the server's address shows up in
   * what was said, audited, asked, sent to Cloudflare, put in a host or stack plan, passed as a
   * `-var`, run on the server's command line, or kept in the repository's plans and OpsCrew's
   * files of the move (its record, its local file, its saved plans).
   */
  const leaks = async (...texts: string[]) => {
    const kept = [
      ...(await Promise.all(Object.keys(plans).map((name) => planNow(name).then(JSON.stringify)))),
      await filesUnder(join(h.root, ".opscrew")),
      await filesUnder(join(h.root, "opscrew")),
    ];
    const shown = [
      ...texts,
      h.deps.reporter.text(),
      JSON.stringify(h.deps.audit.entries),
      JSON.stringify(requests),
      JSON.stringify(h.cloudflare.calls),
      JSON.stringify(server.applies.map((one) => one.plan)),
      JSON.stringify(engine.planOptions.map((options) => options?.vars ?? {})),
      JSON.stringify(commands.map((one) => one.command)),
      JSON.stringify([...h.github.variables]),
      ...kept,
    ].join("\n");
    return (
      h.leaks(shown) ||
      secrets.some((secret) => shown.includes(secret)) ||
      shown.includes(SERVER_IPV4)
    );
  };

  return {
    ...h,
    plans,
    engine,
    services,
    tunnel,
    r2,
    portainer,
    secrets: SECRETS,
    old,
    fresh,
    aZone,
    run,
    requests,
    planNow,
    done,
    wroteToA,
    leaks,
  };
}

export type PrepareWorld = Awaited<ReturnType<typeof prepareWorld>>;
