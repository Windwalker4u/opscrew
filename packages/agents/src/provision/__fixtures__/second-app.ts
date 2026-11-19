/**
 * A second app, `inventory`, on the server OpsCrew created for the first app `shop` (feature 030):
 * a git project whose `own` names the first app's folder, the first app provisioned in its own
 * folder on this computer, and a fake server whose host adapter applies a second app's host plans
 * as ssh-host does (only the app's own key lines, folders and record change).
 */
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type AppRecord,
  appDirs,
  checkKeyLine,
  type HostFacts,
  HostFactsSchema,
  type HostPlan,
  hostPlanHash,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { recordOwnServer, serverAddressesFile } from "../../shared";
import { ensureDeployKey, generateEd25519KeyPair } from "../../shared/ssh-keys";
import {
  createdServerFacts,
  createProject,
  createTestPhaseDeps,
  FakeDestroyGitHub,
  FakeHostServer,
  fakeSharedCloudflare,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  SERVER_IPV4,
  ScriptedApprovalHandler,
  sharedServerProject,
} from "../../testing";
import type { ProvisionServices } from "../types";

/**
 * The deploy user's authorized_keys on the first app's server before the second app came: the
 * first app's deploy key, another repository's scheduled check key and a line OpsCrew did not
 * write. Public keys made at runtime, never secrets.
 */
export const BEFORE = [
  generateEd25519KeyPair("opscrew-deploy@shop").publicKeyOpenSsh,
  checkKeyLine(generateEd25519KeyPair("check").publicKeyOpenSsh, "example/other"),
  generateEd25519KeyPair("someone@laptop").publicKeyOpenSsh,
];

/** The second app `inventory` beside `shop`, proxied at `inventory.example.com`. */
export function inventoryPlan(): DeployPlan {
  const base = ownPlan();
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: "inventory" },
    target: { ...base.target, shares: { app: "shop", provider: "hetzner" } },
    dns: { ...base.dns, domain: "inventory.example.com" },
  });
}

/** The key (base64) word of an authorized_keys line. */
const blob = (line: string) => line.trim().split(/\s+/)[1] ?? "";

/**
 * The deploy user's keys after a second app's `deploy-key` step (its parameters): every line
 * that holds none of the step's `drop` keys stays, in its order, then the step's `keys`.
 */
export function keysAfter(lines: readonly string[], params: HostPlan["steps"][number]["params"]) {
  const drop = new Set(String(params.drop).split(" "));
  const keys = String(params.keys).split("\n").filter(Boolean);
  return [...lines.filter((line) => !drop.has(blob(line))), ...keys];
}

/** The facts after a second app's setup host plan: its key lines, its folders and its record. */
function joinedFacts(before: HostFacts, plan: HostPlan): HostFacts {
  const f = structuredClone(before);
  const params = (id: string) => plan.steps.find((step) => step.id === id)?.params;
  const key = params("deploy-key");
  if (key !== undefined && f.deployUser !== null) f.deployUser.keys = keysAfter(f.deployUser.keys, key);
  const app = plan.app;
  const dirs = appDirs(app);
  for (const path of [dirs.app, dirs.data]) {
    if (f.dirs.some((dir) => dir.path === path && dir.kind === "dir")) continue;
    f.dirs.push({ path, kind: "dir", owner: "deploy", group: "deploy", mode: "750", entries: 0 });
  }
  const claim = params("app-record");
  if (claim !== undefined) {
    const words = (value: unknown) => String(value).split(" ").filter(Boolean);
    const record: AppRecord = {
      schemaVersion: 1,
      app,
      projectId: String(claim.projectId),
      state: "active",
      access: claim.access as AppRecord["access"],
      hostnames: words(claim.hostnames),
      folders: dirs,
      composeProject: app,
      services: words(claim.services),
      memoryMb: Number(claim.memoryMb),
      deployKey: String(claim.deployKey),
      shares: { app: String(claim.shares) },
      repository: String(claim.repository),
      ...(claim.previousDeployKey === undefined
        ? {}
        : { previousDeployKey: String(claim.previousDeployKey) }),
    };
    f.apps = [...f.apps.filter((item) => item.name !== app), { name: app, record }];
  }
  return HostFactsSchema.parse(f);
}

/**
 * The first app's server as a second app's deploy login sees it: a {@link FakeHostServer} whose
 * second-app host plans change only that app's parts, as ssh-host's adapter does (a teardown's
 * key removal too).
 */
export class SharedServer extends FakeHostServer {
  override async apply(
    remote: RemoteExec,
    plan: HostPlan,
    options: ApplyOptions,
  ): Promise<ApplyResult> {
    const key = plan.steps.find((step) => step.id === "deploy-key" && step.state === "change");
    if (plan.purpose === "teardown") {
      const lines = this.facts.deployUser?.keys ?? [];
      const result = await super.apply(remote, plan, options);
      if (key !== undefined && this.facts.deployUser !== null) {
        this.facts.deployUser.keys = keysAfter(lines, key.params);
      }
      return result;
    }
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.applies.push({ plan, options });
    if (this.fail !== undefined) {
      const error = this.fail;
      this.fail = undefined;
      throw error;
    }
    this.facts = joinedFacts(this.facts, plan);
    const changes = plan.steps.filter((step) => step.state === "change");
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  }
}

/** The first app's server with `shop` running, the deploy user's keys {@link BEFORE}. */
export function firstServer(): HostFacts {
  const facts = createdServerFacts();
  return HostFactsSchema.parse({
    ...facts,
    deployUser: { groups: ["deploy", "docker"], keys: [...BEFORE] },
    containers: [{ name: "shop-app-1", project: "shop", ports: "", running: true }],
  });
}

/**
 * The second app's git project (nothing provisioned yet) beside the first app `shop`, which is
 * provisioned in its own folder on this computer, with fakes for the engine (its records point at
 * the first app's address), the shared server, GitHub, Cloudflare and Zero Trust. The second app's
 * deploy key exists and its `own` names the first app (not joined yet).
 */
export async function secondAppProject() {
  const shared = await sharedServerProject();
  const project = await createProject(inventoryPlan());
  const engine = new OwnEngine(PUBLIC_CHANGES, {
    server_ipv4: SERVER_IPV4,
    server_ipv6: null,
    url: "https://inventory.example.com",
    servers: { own: { ipv4: SERVER_IPV4, ipv6: null } },
  });
  const host = new SharedServer(firstServer());
  const github = new FakeDestroyGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  // The first app's OpsCrew home is this computer's, as the second app's.
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: shared.deps.paths.homeDir,
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  const runner = ownRunner();
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner,
    approvalHandler: handler,
    interactive: false,
  });
  const key = await ensureDeployKey(deps.paths, deps.redactor);
  await recordOwnServer(deps.paths, {
    host: SERVER_IPV4,
    port: 22,
    user: "deploy",
    agent: false,
    keyPath: key.privateKeyFile,
    shares: shared.ref,
  });
  const home = await mkdtemp(join(tmpdir(), "opscrew-second-app-"));
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: ownCloudflare(),
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir: home },
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
  };
  return { ...project, shared, deps, engine, host, github, handler, services, runner, key };
}

export type SecondAppProject = Awaited<ReturnType<typeof secondAppProject>>;

/** The kinds of the approvals asked, in order. */
export const kinds = (s: SecondAppProject) => s.handler.requests.map((request) => request.kind);

/**
 * Everything the run's fakes saw and this computer's state of the second app holds: the reporter,
 * the audit log, every command, the approvals, GitHub's secrets and pull requests, the second
 * app's `server.json`, `known_hosts` and saved plans, and the repository's committed files.
 */
export async function everythingSeen(s: SecondAppProject): Promise<string> {
  const { deps } = s;
  const plans = await readdir(deps.paths.files.plansDir).catch(() => [] as string[]);
  const files = (await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
  return [
    deps.reporter.text(),
    JSON.stringify(deps.audit.entries),
    JSON.stringify(s.runner.calls),
    JSON.stringify(s.handler.requests),
    JSON.stringify([...s.github.secrets.values()]),
    JSON.stringify(s.github.pulls),
    await readFile(serverAddressesFile(deps.paths), "utf8"),
    await readFile(deps.paths.files.knownHosts, "utf8").catch(() => ""),
    ...(await Promise.all(
      plans.map((name) => readFile(join(deps.paths.files.plansDir, name), "utf8")),
    )),
    ...(await Promise.all(
      files.filter(Boolean).map((file) => readFile(join(s.root, file), "utf8").catch(() => "")),
    )),
    await s.git(s.root, "log", "--format=%B"),
  ].join("\n");
}
