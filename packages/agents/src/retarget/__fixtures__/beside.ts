/**
 * A move onto the server OpsCrew created for another app (feature 030, plan 16.): the first app
 * `blog`, provisioned on Hetzner from its own repository folder on this computer, whose server is
 * at the move's new address; the moving app `shop` becomes a second app there.
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type AppRecord,
  appDirs,
  type HostFacts,
  HostFactsSchema,
} from "@opscrew/connector-ssh-host";
import type { FakeFile } from "@opscrew/connector-docker/testing";
import { COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL } from "@opscrew/connector-portainer";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { BEFORE, SharedServer } from "../../provision/__fixtures__/second-app";
import {
  knownHostsName,
  type OwnServerConnectionInput,
  recordOwnServer,
  recordPortainerConnection,
  type ServerAddress,
  type SharesReference,
  serverAddressesFile,
  updateServerAddresses,
} from "../../shared";
import { firstAppPaths } from "../../shares/reference";
import {
  APP,
  createdServerFacts,
  ED25519,
  ED25519_FINGERPRINT,
  FakeHostServer,
  type MoveHarness,
  moveHarness,
  OLD_IPV4,
  ownRunner,
  PORTAINER_CERT,
  PORTAINER_TOKEN,
  PORTAINER_URL,
  portainerServices,
  preparedServerFacts,
  ScriptedRunner,
  targetOf,
  testPlan,
} from "../../testing";
import type { RetargetServices } from "../types";
import { NEW_IPV4, NEW_IPV6, type PairOptions, PORTAINER, pairHarness } from "./pairs";

/** The first app, whose server OpsCrew created on Hetzner. */
export const FIRST = "blog";
/** Its server's addresses: the move's new side. */
export const FIRST_ADDRESS: ServerAddress = { ipv4: NEW_IPV4, ipv6: NEW_IPV6 };
/** The first app of a second app's old side (`shared`): another server OpsCrew created. */
export const OLD_FIRST = "wiki";

/** What the first app's plan looks like. */
export interface FirstAppOptions {
  /** Served behind Cloudflare's proxy (default false: DNS only). */
  proxied?: boolean;
  /** Its server's proxy (default Caddy). */
  edge?: "caddy" | "nginx";
  /** Its web process's memory limit in MB (default the plan's). */
  memoryMb?: number;
  /** Its target: a server of the user's own instead of one OpsCrew created. */
  own?: boolean;
}

/**
 * The first app `blog` provisioned from its own repository folder on this computer (the OpsCrew
 * home `homeDir`): its plan, its server's address ({@link FIRST_ADDRESS}), its deploy key
 * (synthetic content, which must never leave that file) and the server's pinned host key.
 */
export async function firstAppFolder(homeDir: string, o: FirstAppOptions = {}) {
  const ref: SharesReference = {
    root: await mkdtemp(join(tmpdir(), "opscrew-first-app-")),
    environment: "prod",
  };
  const paths = firstAppPaths({ homeDir }, ref);
  const base = testPlan({ deployed: true, domain: `${FIRST}.example.com` });
  const plan = DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: FIRST, ...(o.memoryMb === undefined ? {} : { memoryMb: o.memoryMb }) },
    dns: { ...base.dns, proxied: o.proxied ?? false },
    target: o.own
      ? targetOf("own")
      : { ...base.target, ...(o.edge === undefined ? {} : { edge: o.edge }) },
  });
  await writeArtifact("plan", paths.files.plan, plan);
  await updateServerAddresses(paths, (current) => ({ ...current, deployment: FIRST_ADDRESS }));
  const key = fakeSecret("private-key-pem", "blog-deploy-key");
  await mkdir(dirname(paths.files.deployKey), { recursive: true });
  await writeFile(paths.files.deployKey, key, { mode: 0o600 });
  await writeFile(
    paths.files.knownHosts,
    `${knownHostsName(FIRST_ADDRESS.ipv4)} ssh-ed25519 ${ED25519}\n`,
  );
  return { ref, paths, plan, key };
}

export type FirstAppFolder = Awaited<ReturnType<typeof firstAppFolder>>;

/**
 * The first app's server as a second app's deploy login sees it: `deploy` with root through
 * Docker, the first app's (default `blog`) folders and container, its deploy user's keys
 * {@link BEFORE}, and the records of other second apps there (`apps`).
 */
export function firstAppServer(
  o: { memoryGb?: number; diskGb?: number; apps?: AppRecord[]; first?: string } = {},
): HostFacts {
  const name = o.first ?? FIRST;
  const facts = createdServerFacts(o.apps ?? []);
  const shop = appDirs(APP);
  const blog = appDirs(name);
  return HostFactsSchema.parse({
    ...facts,
    memoryBytes: (o.memoryGb ?? 4) * 1024 ** 3,
    diskFreeBytes: (o.diskGb ?? 40) * 1024 ** 3,
    deployUser: { groups: ["deploy", "docker"], keys: [...BEFORE] },
    dirs: [
      ...facts.dirs.filter((dir) => dir.path !== shop.app && dir.path !== shop.data),
      ...[blog.app, blog.data].map((path) => ({
        path,
        kind: "dir",
        owner: "deploy",
        group: "deploy",
        mode: "750",
        entries: 1,
      })),
    ],
    containers: [{ name: `${name}-app-1`, project: name, ports: "", running: true }],
  });
}

/**
 * `facts` once the moving app's host plan was applied there: its key line after the others, its
 * folders and its record naming the first app (default `blog`).
 */
export function withMovingApp(
  facts: HostFacts,
  projectId: string,
  deployKey: string,
  first = FIRST,
): HostFacts {
  const own = appDirs(APP);
  const record: AppRecord = {
    schemaVersion: 1,
    app: APP,
    projectId,
    state: "active",
    access: "public",
    hostnames: [`${APP}.example.com`],
    folders: own,
    composeProject: APP,
    services: ["db"],
    memoryMb: 1024,
    deployKey,
    shares: { app: first },
    repository: "https://github.com/acme/shop",
  };
  return HostFactsSchema.parse({
    ...facts,
    deployUser: { groups: ["deploy", "docker"], keys: [...BEFORE, deployKey] },
    dirs: [
      ...facts.dirs,
      ...[own.app, own.data].map((path) => ({
        path,
        kind: "dir",
        owner: "deploy",
        group: "deploy",
        mode: "750",
        entries: 1,
      })),
    ],
    apps: [...facts.apps, { name: APP, record }],
  });
}

/**
 * The first app's web container on the Docker of its server at `ip`, in its folder under
 * `/srv/apps/`: the edge there is shared, so a move never stops it.
 */
export function seedFirstApp(h: Pick<MoveHarness, "hosts">, ip = NEW_IPV4): void {
  const id = `${FIRST}-app`.padEnd(64, "0");
  h.hosts.docker(ip).containers.set(id, {
    id,
    name: `${FIRST}-app-1`,
    image: `ghcr.io/acme/blog@sha256:${"b".repeat(64)}`,
    cmd: [],
    env: [],
    labels: {
      [COMPOSE_PROJECT_LABEL]: FIRST,
      [COMPOSE_SERVICE_LABEL]: "app",
      "com.docker.compose.project.working_dir": `/srv/apps/${FIRST}`,
    },
    binds: [],
    mounts: [],
    state: "running",
    exitCode: 0,
    stdout: "",
    stderr: "",
  });
}

/** The app's kept folder (`storage.files`): the volume `shop_files` at this path in its container. */
export const KEPT_FOLDER = "/app/storage/site";
/** The kept folder's files on the old side, as the app's runtime installs left them. */
export const KEPT_FILES: Record<string, FakeFile> = {
  "composer.json": file('{"require":{"example/app-core":"^1.8"}}'),
  "composer.lock": file('{"packages":[]}'),
  vendor: { type: "dir", mode: 0o755, uid: 33, gid: 33 },
  "vendor/autoload.php": file("<?php // installed at runtime"),
};

/**
 * What Docker seeds a new `files` volume with from the image at the new side's deploy: the image's
 * own copy, which the move's copy must replace with the old side's files as they are.
 */
export const IMAGE_FILES: Record<string, FakeFile> = {
  "composer.json": file('{"require":{}}'),
  "seeded-from-the-image.txt": file("the image's copy"),
};

function file(text: string): FakeFile {
  return { type: "file", mode: 0o644, uid: 33, gid: 33, data: Buffer.from(text) };
}

/**
 * Mounts the kept folder's volume (`shop_files`, holding `files`) in the app's container on the
 * Docker at `ip`, as Compose's `files` volume does.
 */
export function mountKeptFolder(
  h: Pick<MoveHarness, "hosts">,
  ip: string,
  files: Record<string, FakeFile>,
): void {
  const docker = h.hosts.docker(ip);
  if (!docker.volumes.has(`${APP}_files`)) docker.addVolume(`${APP}_files`, files);
  for (const container of docker.containers.values()) {
    const ours =
      container.labels[COMPOSE_PROJECT_LABEL] === APP &&
      container.labels[COMPOSE_SERVICE_LABEL] === "app";
    if (ours && !container.mounts.some((mount) => mount.target === KEPT_FOLDER)) {
      container.mounts.push({ type: "volume", source: `${APP}_files`, target: KEPT_FOLDER });
    }
  }
}

/** The old sides a move onto another app's server is tested from. */
export type OldSide = "hetzner" | "digitalocean" | "contabo" | "own" | "portainer" | "shared";

/** The own server login of an old side over SSH at `host` (`shared`: a joined second app's). */
function oldLogin(
  from: "own" | "shared",
  deployKey: string,
  ref?: SharesReference,
): OwnServerConnectionInput {
  return from === "own"
    ? {
        host: OLD_IPV4,
        port: 22,
        user: "root",
        agent: true,
        reachable: true,
        serve: "dns-only",
        hostKey: ED25519_FINGERPRINT,
      }
    : {
        host: OLD_IPV4,
        port: 22,
        user: "deploy",
        agent: false,
        keyPath: deployKey,
        shares: ref as SharesReference,
        hostKey: ED25519_FINGERPRINT,
        joined: true,
      };
}

/**
 * ssh-keyscan reads the first app's pinned key ({@link ED25519}) on its server; every other
 * command as before.
 */
function keyscanRunner(h: Pick<MoveHarness, "deps">): void {
  const keys = ownRunner();
  const previous = h.deps.runner;
  h.deps.runner = new ScriptedRunner(async (command, args, options) =>
    command === "ssh-keyscan" && args.at(-1) === FIRST_ADDRESS.ipv4
      ? keys.run(command, args, options)
      : previous.run(command, args, options),
  );
}

/**
 * A live app `shop` on `from` (no move yet), with its connection in its usual slot, and the first
 * app `blog` provisioned on this computer: what a move beside `blog` starts from. Its plan is
 * served as `blog` is (behind Cloudflare's proxy unless `first.proxied` is false).
 */
export async function besideStart(
  from: OldSide,
  o: { first?: FirstAppOptions; server?: HostFacts } = {},
) {
  const cloud = from === "contabo" || from === "digitalocean" ? from : "hetzner";
  const h = await moveHarness({ from: cloud });
  keyscanRunner(h);
  // The stack's Caddy in a Portainer serves with DNS only.
  const proxied = o.first?.proxied ?? from !== "portainer";
  const first = await firstAppFolder(h.paths.homeDir, { ...o.first, proxied });
  const services: RetargetServices = { ...h.services };
  let plan: DeployPlan = DeployPlanSchema.parse({ ...h.plan, dns: { ...h.plan.dns, proxied } });
  if (from === "own" || from === "shared") {
    const wiki = { root: await mkdtemp(join(tmpdir(), "opscrew-old-first-")), environment: "prod" };
    const target =
      from === "own" ? targetOf("own") : { ...targetOf("own"), shares: { app: OLD_FIRST, provider: "hetzner" } };
    plan = DeployPlanSchema.parse({ ...plan, target });
    await recordOwnServer(h.paths, oldLogin(from, h.paths.files.deployKey, wiki));
    await updateServerAddresses(h.paths, (current) => ({ ...current, deployment: { ipv4: OLD_IPV4 } }));
  }
  if (from === "portainer") {
    plan = DeployPlanSchema.parse({ ...plan, target: targetOf("portainer") });
    await recordPortainerConnection(h.paths, {
      url: PORTAINER_URL,
      certFingerprint: PORTAINER_CERT.fingerprint,
      environmentId: 3,
      environmentName: "local",
      arch: "amd64",
      redeploy: "updater",
      web: { mode: "caddy", records: true },
      created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" }], volumes: [] },
    });
    h.deps.env.PORTAINER_API_KEY = PORTAINER_TOKEN;
    h.deps.redactor.addLiteral(PORTAINER_TOKEN, "PORTAINER_API_KEY");
    h.hosts.seed(PORTAINER, {}, true);
    services.portainer = portainerServices(h.hosts.docker(PORTAINER));
  }
  await writeArtifact("plan", h.paths.files.plan, plan);
  const server = new SharedServer(o.server ?? firstAppServer());
  services.own = { host: server, homeDir: h.root };
  seedFirstApp(h);
  return { ...h, plan, first, server, services };
}

export type BesideStart = Awaited<ReturnType<typeof besideStart>>;

/**
 * A move from `from` beside `blog`, recorded at `step` (default `deployed`) over the pair
 * harness's fakes ({@link pairHarness}): the new side is `blog`'s server at the pair's new
 * address, its login the second app's (joined from step `created` on), its host adapter the
 * first app's server ({@link SharedServer}) with the moving app's parts once joined, and `blog`'s
 * container beside the app there. A second app's old side (`shared`) is a joined login to the
 * server of {@link OLD_FIRST}.
 */
export async function besidePair(from: OldSide, o: PairOptions = {}) {
  const shared = from === "shared";
  const h = await pairHarness(shared ? "own" : from, "own", o);
  const first = await firstAppFolder(h.paths.homeDir);
  const step = o.step ?? "deployed";
  const joined = !["started", "renamed"].includes(step);
  const target = { ...h.plan.target, shares: { app: FIRST, provider: "hetzner" } };
  const fromTarget = shared
    ? { ...targetOf("own"), shares: { app: OLD_FIRST, provider: "hetzner" } }
    : h.plan.retarget?.from.target;
  const plan = DeployPlanSchema.parse({
    ...h.plan,
    target,
    retarget: { ...h.plan.retarget, from: { ...h.plan.retarget?.from, target: fromTarget } },
  });
  await writeArtifact("plan", h.paths.files.plan, plan);
  h.session.plan = plan;
  const key = h.session.deployKey;
  await recordOwnServer(h.paths, {
    host: NEW_IPV4,
    port: 22,
    user: "deploy",
    agent: false,
    keyPath: key.privateKeyFile,
    shares: first.ref,
    hostKey: ED25519_FINGERPRINT,
    ...(joined ? { joined: true as const } : {}),
  });
  if (shared) {
    const wiki = { root: await mkdtemp(join(tmpdir(), "opscrew-old-first-")), environment: "prod" };
    await updateServerAddresses(h.paths, (current) => ({
      ...current,
      retarget: { ...current.retarget, fromOwn: oldLogin("shared", key.privateKeyFile, wiki) },
    }));
  }
  const facts = firstAppServer();
  const server = new SharedServer(
    joined ? withMovingApp(facts, h.paths.projectId, key.publicKeyOpenSsh) : facts,
  );
  const own = { host: server, homeDir: h.root };
  Object.assign(h.services, { own });
  Object.assign(h.session.services, { own });
  seedFirstApp(h);
  // After the switch DNS points to the first app's server, where the edge runs for both apps.
  if (step === "switched" && h.engine.state.dns !== undefined) h.engine.state.dns = NEW_IPV4;
  if (joined) Object.assign(h.hosts.host(NEW_IPV4), { caddy: true });
  return { ...h, plan, first, server, own };
}

export type BesidePair = Awaited<ReturnType<typeof besidePair>>;

/**
 * For `--finish` from a server over SSH, one of the user's (`own`) or a second app's (`shared`, on
 * the server of {@link OLD_FIRST}): the old server's host adapter, in place of the first app's.
 */
export function useOldServer(h: BesidePair, from: "own" | "shared"): FakeHostServer {
  const key = h.session.deployKey.publicKeyOpenSsh;
  const host =
    from === "own"
      ? new FakeHostServer(preparedServerFacts(h.paths.projectId))
      : new SharedServer(
          withMovingApp(firstAppServer({ first: OLD_FIRST }), h.paths.projectId, key, OLD_FIRST),
        );
  const own = { host, homeDir: h.root };
  Object.assign(h.services, { own });
  Object.assign(h.session.services, { own });
  return host;
}

/**
 * What a run showed, audited, asked for approval, saved as a plan, committed or opened as a pull
 * request: no server address, key or token belongs there.
 */
export async function printed(h: MoveHarness): Promise<string> {
  const { deps } = h;
  const plans = await readdir(deps.paths.files.plansDir).catch(() => [] as string[]);
  const files = (await h.git(h.root, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
  return [
    h.reporter.text(),
    JSON.stringify(h.audit.entries),
    JSON.stringify(h.handler.requests),
    JSON.stringify(h.github.pulls),
    ...(await Promise.all(
      plans.map((name) => readFile(join(deps.paths.files.plansDir, name), "utf8")),
    )),
    ...(await Promise.all(
      files.filter(Boolean).map((path) => readFile(join(h.root, path), "utf8").catch(() => "")),
    )),
    await h.git(h.root, "log", "--all", "--format=%B"),
  ].join("\n");
}

/**
 * Everything the run's fakes saw beside {@link printed}: every command (ssh reads the first app's
 * deploy key there by its path), GitHub's secrets, and this computer's state of the moving app
 * (its `server.json` and `known_hosts`, which hold the servers' addresses and host keys).
 */
export async function everythingSeen(h: MoveHarness): Promise<string> {
  const { deps } = h;
  return [
    await printed(h),
    JSON.stringify((deps.runner as ScriptedRunner).calls),
    JSON.stringify([...h.github.secrets.entries()]),
    await readFile(serverAddressesFile(deps.paths), "utf8").catch(() => ""),
    await readFile(deps.paths.files.knownHosts, "utf8").catch(() => ""),
  ].join("\n");
}
