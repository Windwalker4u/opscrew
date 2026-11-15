/**
 * Test helpers for the move's R2 buckets: the app with its files and its snapshots' copies on R2,
 * on a cloud server or in the user's Portainer, in a move of {@link ZONE} from Old to New. Each
 * account's buckets answer only their own key, as R2's do; rclone's one-offs reach them over SSH
 * or through Portainer's Docker API; the app's stops and starts, rclone's runs and the deploy pause
 * go into one trail.
 */
import { Readable } from "node:stream";
import { FakeDocker, parseTar } from "@opscrew/connector-docker/testing";
import type {
  CommandResult,
  DockerTransport,
  RemoteExec,
  RemoteRunOptions,
} from "@opscrew/contracts";
import { ApprovalGate, MemoryApprovalStore } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DEPLOY_PAUSED_VARIABLE, IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import {
  NEW_OFFSITE_KEY_VARS,
  NEW_STORAGE_KEY_VARS,
  OFFSITE_KEY_VARS,
  STORAGE_KEY_VARS,
} from "../provision/storage";
import type { StorageLogin } from "../shared";
import { portainerPlan, ScriptedApprovalHandler, SERVER_IPV4 } from "../testing";
import { withBucket } from "../testing/storage";
import { fakeClock } from "./connector.fakes";
import { moveHarness, recordedMove, serverPlan, unencrypted } from "./session.fakes";
import { MOVE_COMMAND } from "./texts";
import type { MoveSession } from "./types";

export const APP_BUCKET = "shop-uploads";
export const BACKUPS_BUCKET = "shop-backups";

/** One rclone run the fake answered: where, its verb and arguments, and its configuration. */
export interface R2Run {
  where: "ssh" | "docker";
  verb: string;
  args: string[];
  config: string;
  /** Whether the app's deploys were paused when it ran. */
  paused: boolean;
}

/** One section of rclone's configuration, by its keys. */
type Section = Record<string, string>;

/** rclone's configuration's sections, by remote name. */
function sections(config: string): Map<string, Section> {
  const found = new Map<string, Section>();
  let current: Section | undefined;
  for (const line of config.split("\n")) {
    const head = /^\[(\w+)\]$/.exec(line.trim());
    if (head !== null) {
      current = {};
      found.set(head[1] ?? "", current);
      continue;
    }
    const pair = /^(\w+) = (.*)$/.exec(line.trim());
    if (pair !== null && current !== undefined) current[pair[1] ?? ""] = pair[2] ?? "";
  }
  return found;
}

/**
 * R2 in two accounts: each account's buckets (by name, their objects by name) and each bucket's
 * key. rclone's `size`, `copy`, `sync`, `check --one-way` and `delete` answer as R2 and rclone
 * would; a remote whose key is not its bucket's in its endpoint's account is refused.
 */
export class FakeR2 {
  /** Objects by account id, then bucket, then object name. */
  readonly buckets = new Map<string, Map<string, Map<string, string>>>();
  /** Each bucket's key, by `<account id>/<bucket>`. */
  readonly keys = new Map<string, StorageLogin>();
  readonly runs: R2Run[] = [];
  /** Makes a verb fail with this result. */
  fail: ((verb: string) => CommandResult | undefined) | undefined;

  constructor(
    readonly trail: string[],
    private readonly paused: () => boolean,
  ) {}

  /** Adds `bucket` in `account`, with its key and objects. */
  add(account: string, bucket: string, key: StorageLogin, objects: Record<string, string> = {}) {
    this.buckets.set(account, this.buckets.get(account) ?? new Map());
    this.buckets.get(account)?.set(bucket, new Map(Object.entries(objects)));
    this.keys.set(`${account}/${bucket}`, key);
  }

  /** The objects of `bucket` in `account`. */
  objects(account: string, bucket: string): Map<string, string> {
    const found = this.buckets.get(account)?.get(bucket);
    if (found === undefined) throw new Error(`no bucket ${bucket} in ${account}`);
    return found;
  }

  /** The bucket a path `<remote>:<bucket>` names, with the remote's key checked. */
  private at(path: string, remotes: Map<string, Section>): Map<string, string> | string {
    const [remote = "", bucket = ""] = path.split(":");
    const section = remotes.get(remote);
    const account = /^https:\/\/([0-9a-f]{32})\.r2\.cloudflarestorage\.com$/.exec(
      section?.endpoint ?? "",
    )?.[1];
    if (section === undefined || account === undefined || section.provider !== "Cloudflare") {
      return `no R2 remote ${remote}`;
    }
    const key = this.keys.get(`${account}/${bucket}`);
    if (
      key === undefined ||
      section.access_key_id !== key.accessKeyId ||
      section.secret_access_key !== key.secretAccessKey
    ) {
      return `AccessDenied: the key of ${remote} does not open ${bucket}`;
    }
    return this.buckets.get(account)?.get(bucket) ?? `directory not found: ${bucket}`;
  }

  /** Answers rclone `args` with `config`, as a one-off container of the pinned image would. */
  run(where: R2Run["where"], args: string[], config: string): CommandResult {
    const [verb = "", ...rest] = args;
    this.runs.push({ where, verb, args, config, paused: this.paused() });
    this.trail.push(`rclone ${verb}`);
    const failed = this.fail?.(verb);
    if (failed !== undefined) return failed;
    const remotes = sections(config);
    const paths = rest.filter((arg) => !arg.startsWith("--"));
    const found = paths.map((path) => this.at(path, remotes));
    const refused = found.find((one) => typeof one === "string");
    if (typeof refused === "string")
      return { exitCode: 3, stdout: "", stderr: `ERROR : ${refused}` };
    const [from, to] = found as Map<string, string>[];
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    switch (verb) {
      case "size": {
        const bytes = [...(from?.values() ?? [])].reduce((sum, data) => sum + data.length, 0);
        return ok(JSON.stringify({ count: from?.size ?? 0, bytes, sizeless: 0 }));
      }
      case "copy":
        for (const [name, data] of from ?? []) to?.set(name, data);
        return ok();
      case "sync":
        for (const name of [...(to?.keys() ?? [])]) if (!from?.has(name)) to?.delete(name);
        for (const [name, data] of from ?? []) to?.set(name, data);
        return ok();
      case "check": {
        const missing = [...(from ?? [])].filter(([name, data]) => to?.get(name) !== data);
        if (missing.length === 0) return ok();
        const lines = missing.map(([name]) => `ERROR : ${name}: file not in the destination`);
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${lines.join("\n")}\n${missing.length} differences found`,
        };
      }
      case "delete":
        from?.clear();
        return ok();
      default:
        return { exitCode: 1, stdout: "", stderr: `unknown command ${verb}` };
    }
  }
}

/** The app's two buckets in each account, each with its own key. */
function bucketKeys() {
  const key = (seed: string): StorageLogin => ({
    accessKeyId: fakeSecret("aws-access-key-id", seed),
    secretAccessKey: fakeSecret("aws-secret-access-key", seed),
  });
  return {
    a: { storage: key("a-storage"), backups: key("a-backups") },
    b: { storage: key("b-storage"), backups: key("b-backups") },
  };
}

/** `plan` with the app's files and the snapshots' copies in R2, and a worker beside the app. */
function withR2(plan: DeployPlan): DeployPlan {
  const bucket = withBucket(plan, "r2");
  return DeployPlanSchema.parse({
    ...bucket,
    processes: {
      ...bucket.processes,
      workers: [{ name: "worker", command: "node worker.js", source: "user" }],
    },
    snapshots: { offsite: { provider: "r2", bucket: BACKUPS_BUCKET } },
  });
}

/** The app's stack containers in the fake Portainer's Docker. */
function stackContainers(docker: FakeDocker): void {
  for (const service of ["app", "worker", "db", "caddy"]) {
    const id = `opscrew-shop-${service}`.padEnd(64, "0");
    docker.containers.set(id, {
      id,
      name: `opscrew-shop-${service}-1`,
      image: "ghcr.io/acme/shop@sha256:1",
      cmd: [],
      env: [],
      labels: {
        "com.docker.compose.project": "opscrew-shop",
        "com.docker.compose.service": service,
      },
      binds: [],
      mounts: [],
      state: "running",
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  }
}

export interface BucketWorldOptions {
  /** Only the app's bucket on R2, no snapshots' copies. */
  appOnly?: boolean;
  /** No bucket on R2 at all. */
  none?: boolean;
  /** The session's command (default prepare's). */
  command?: string;
  /** Only these approvals are granted (default: every one). */
  approve?: (title: string) => boolean;
}

/**
 * The app on `target` in a move of the zone from Old to New, prepared up to its buckets: A's
 * buckets with three files and two snapshots' copies, B's empty, each with its own key in the
 * environment's variables (A's plain, B's `OPSCREW_NEW_*`); a session (interactive, every approval
 * granted and recorded) whose services reach the fakes.
 */
export async function bucketWorld(target: "cloud" | "portainer", o: BucketWorldOptions = {}) {
  const keys = bucketKeys();
  const base =
    target === "cloud"
      ? serverPlan()
      : unencrypted(portainerPlan({ web: { mode: "tunnel" }, deployed: true }));
  const plan = o.none ? base : o.appOnly ? withBucket(base, "r2") : withR2(base);
  const env: Record<string, string> = {
    [STORAGE_KEY_VARS.accessKeyId]: keys.a.storage.accessKeyId,
    [STORAGE_KEY_VARS.secretAccessKey]: keys.a.storage.secretAccessKey,
    [NEW_STORAGE_KEY_VARS.accessKeyId]: keys.b.storage.accessKeyId,
    [NEW_STORAGE_KEY_VARS.secretAccessKey]: keys.b.storage.secretAccessKey,
    [OFFSITE_KEY_VARS.accessKeyId]: keys.a.backups.accessKeyId,
    [OFFSITE_KEY_VARS.secretAccessKey]: keys.a.backups.secretAccessKey,
    [NEW_OFFSITE_KEY_VARS.accessKeyId]: keys.b.backups.accessKeyId,
    [NEW_OFFSITE_KEY_VARS.secretAccessKey]: keys.b.backups.secretAccessKey,
  };
  const h = await moveHarness({
    plans: (cloudflare) => ({ prod: recordedMove(plan, cloudflare) }),
    env,
  });
  const old = h.cloudflare.account("Old").id;
  const fresh = h.cloudflare.account("New").id;
  const trail: string[] = [];
  const paused = () => h.github.variables.has(DEPLOY_PAUSED_VARIABLE);
  const r2 = new FakeR2(trail, paused);
  r2.add(old, APP_BUCKET, keys.a.storage, { "a.png": "aaaa", "b.png": "bb", "c.pdf": "c" });
  r2.add(old, BACKUPS_BUCKET, keys.a.backups, {
    "backups/1/db.age": "one",
    "backups/2/db.age": "two",
  });
  r2.add(fresh, APP_BUCKET, keys.b.storage);
  r2.add(fresh, BACKUPS_BUCKET, keys.b.backups);

  /** Every command run on the app's server, and its standard input. */
  const commands: { host: string; command: string; input: string }[] = [];
  let stopFailure = false;
  const remote = (host: string): RemoteExec => ({
    host,
    run: async (command: string, options?: RemoteRunOptions): Promise<CommandResult> => {
      commands.push({ host, command, input: options?.input ?? "" });
      if (command.includes(IMAGES.rclone.ref)) {
        const args = /exec rclone --config \/tmp\/r\.conf (.*)'$/.exec(command)?.[1] ?? "";
        return r2.run("ssh", args.split(" "), options?.input ?? "");
      }
      const compose = /^cd \/srv\/apps\/shop && docker compose (stop|up -d) (.+)$/.exec(command);
      if (compose === null) throw new Error(`unexpected command on the server: ${command}`);
      if (compose[1] === "stop" && stopFailure) {
        stopFailure = false;
        return { exitCode: 1, stdout: "", stderr: `Connection to ${host} closed by remote host.` };
      }
      trail.push(`${compose[1] === "stop" ? "stop" : "start"} ${compose[2]}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });

  // The user's Portainer: its Docker API, whose archive writes are kept by container.
  const docker = new FakeDocker();
  /** Makes the app's next stop fail, over SSH or in Portainer. */
  const failNextStop = () => {
    stopFailure = true;
    docker.fail("POST", /^\/containers\/opscrew-shop-app0+\/stop/, 500, "the container is busy");
  };
  stackContainers(docker);
  const configs = new Map<string, string>();
  /** Each rclone container as it started: its `Env` and `Cmd`. */
  const containers: { env: string[]; cmd: string[] }[] = [];
  docker.onStart = (container) => {
    if (container.image !== IMAGES.rclone.ref) return undefined;
    containers.push({ env: container.env, cmd: container.cmd });
    return r2.run("docker", container.cmd.slice(2), configs.get(container.id) ?? "");
  };
  const transport: DockerTransport = {
    async request(request) {
      const call = /^\/containers\/([^/]+)\/(archive|stop|start)/.exec(request.path);
      if (call !== null && call[2] === "archive" && request.body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of request.body) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const file = parseTar(body).find((entry) => entry.name === "tmp/r.conf");
        configs.set(call[1] ?? "", file?.data?.toString("utf8") ?? "");
        return docker.request({ ...request, body: Readable.from([body]) });
      }
      const stack = call === null ? undefined : docker.containers.get(call[1] ?? "");
      const service = stack?.labels["com.docker.compose.service"];
      if (call !== null && call[2] !== "archive" && service !== undefined) {
        trail.push(`${call[2]} ${service}`);
      }
      return docker.request(request);
    },
  };

  const clock = fakeClock();
  const opened = await h.open({
    command: o.command ?? MOVE_COMMAND,
    services: { ...h.services, remote, docker: () => transport, ...clock },
  });
  // Every approval asked and recorded, as in a terminal; granted unless `o.approve` says no.
  const handler = new ScriptedApprovalHandler((request) => o.approve?.(request.title) ?? true);
  const approvals = new ApprovalGate({
    handler,
    store: new MemoryApprovalStore(),
    audit: opened.deps.audit,
    clock: opened.deps.clock,
  });
  const session: MoveSession = {
    ...opened,
    deps: { ...opened.deps, approvals, interactive: true },
  };
  const [environment] = session.environments;
  if (environment === undefined) throw new Error("the app's environment is covered");
  const secrets = [...Object.values(keys.a), ...Object.values(keys.b)].flatMap((key) => [
    key.accessKeyId,
    key.secretAccessKey,
  ]);
  /** True when a key reached a command line, a container's Env or Cmd, an output, an approval or the audit. */
  const leaks = (...texts: string[]) => {
    const shown = [
      ...texts,
      h.deps.reporter.text(),
      JSON.stringify(h.deps.audit.entries),
      JSON.stringify(handler.requests),
      JSON.stringify(commands.map((one) => one.command)),
      JSON.stringify(containers),
      JSON.stringify([...h.github.variables]),
    ].join("\n");
    return (
      h.leaks(...texts) ||
      secrets.some((secret) => shown.includes(secret)) ||
      shown.includes(SERVER_IPV4)
    );
  };
  return {
    ...h,
    session,
    handler,
    environment,
    keys,
    old,
    fresh,
    r2,
    trail,
    commands,
    docker,
    containers,
    clock,
    failNextStop,
    leaks,
  };
}

export type BucketWorld = Awaited<ReturnType<typeof bucketWorld>>;

/** `w`'s session as a script's: not interactive, with `--approve <hash>` when given. */
export function asScript(w: BucketWorld, approve?: string): MoveSession {
  return {
    ...w.session,
    deps: { ...w.session.deps, interactive: false },
    approve,
  };
}
