/**
 * A second app's move off the server OpsCrew created for the first app (feature 030, plan 12.):
 * its old side is an own server that is never the last one, so the shared edge keeps running
 * through the move, and `--finish` removes only the app's own parts with the second-app teardown
 * (`shares: true`), logged in with its own deploy key.
 */
import { readFile } from "node:fs/promises";
import { dockerClient } from "@opscrew/connector-docker";
import { FakeDocker, fakeDialStdio } from "@opscrew/connector-docker/testing";
import {
  type AppRecord,
  appDirs,
  HostApplyError,
  HostFactsSchema,
} from "@opscrew/connector-ssh-host";
import { findExecutable } from "@opscrew/core";
import { IMAGES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import type { DestroyPreview } from "../../destroy/types";
import {
  BEFORE,
  firstServer,
  inventoryPlan,
  secondAppProject,
} from "../../provision/__fixtures__/second-app";
import {
  readOldOwnServer,
  readOwnServer,
  recordOwnServer,
  serverAddressesFile,
  setAsideOldConnection,
} from "../../shared";
import {
  ED25519_FINGERPRINT,
  FakeHosts,
  type MoveEvent,
  OWN_IPV4,
  ownPlan,
  SERVER_IPV4,
} from "../../testing";
import { removeOldSide } from "../finish";
import type { MoveSession } from "../session";
import { ownSide } from "./own";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/**
 * The second app `inventory`, joined on the first app's server (its key line, folders, record and
 * container beside `shop`'s), moving to a server of the user's own: at `--finish`, its login set
 * aside in `retarget.fromOwn` and the new server's in `own`.
 */
async function moving() {
  const s = await secondAppProject();
  const { deps, key } = s;
  deps.interactive = true;
  const record: AppRecord = {
    schemaVersion: 1,
    app: "inventory",
    projectId: deps.paths.projectId,
    state: "active",
    access: "web-filter",
    hostnames: ["inventory.example.com"],
    folders: appDirs("inventory"),
    composeProject: "inventory",
    services: [],
    memoryMb: 512,
    deployKey: key.publicKeyOpenSsh,
    shares: { app: "shop" },
    repository: "https://github.com/example/inventory",
  };
  const first = firstServer();
  s.host.facts = HostFactsSchema.parse({
    ...first,
    deployUser: { groups: ["deploy", "docker"], keys: [...BEFORE, key.publicKeyOpenSsh] },
    dirs: [
      ...first.dirs,
      ...[appDirs("inventory").app, appDirs("inventory").data].map((path) => ({
        path,
        kind: "dir",
        owner: "deploy",
        group: "deploy",
        mode: "750",
        entries: 1,
      })),
    ],
    containers: [
      ...first.containers,
      { name: "inventory-app-1", project: "inventory", ports: "", running: true },
    ],
    apps: [{ name: "inventory", record }],
  });
  const joined = await readOwnServer(deps.paths);
  if (joined === undefined) throw new Error("the second app's login was not recorded");
  await recordOwnServer(deps.paths, { ...joined, hostKey: ED25519_FINGERPRINT, joined: true });
  await setAsideOldConnection(deps.paths, "own");
  await recordOwnServer(deps.paths, {
    host: OWN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    reachable: true,
    hostKey: ED25519_FINGERPRINT,
  });
  const plan: DeployPlan = DeployPlanSchema.parse({
    ...inventoryPlan(),
    target: ownPlan().target,
    retarget: {
      from: { target: inventoryPlan().target },
      step: "switched",
      startedAt: "2026-11-19T12:00:00.000Z",
    },
  });
  const events: MoveEvent[] = [];
  const hosts = new FakeHosts(events);
  const docker = new FakeDocker();
  const streams = fakeDialStdio(docker);
  closers.push(streams.close);
  deps.streams = streams;
  const confirmed: DestroyPreview[] = [];
  const confirm = async (preview: DestroyPreview) => {
    confirmed.push(preview);
    return true;
  };
  const session = {
    deps,
    plan,
    services: { remote: hosts.remote, sleep: async () => undefined, now: () => 0 },
    deployKey: key,
    servers: { from: { ipv4: SERVER_IPV4 } },
    command: "opscrew retarget --finish",
    approve: undefined,
  } as unknown as MoveSession;
  const services = { own: s.services.own ?? {} };
  return { ...s, session, services, events, hosts, docker, confirm, confirmed };
}

/** The `-i` key files of every ssh call since `from`. */
function keyFiles(s: Awaited<ReturnType<typeof moving>>, from: number): string[] {
  return s.runner.calls
    .slice(from)
    .filter((call) => call.command === "ssh")
    .flatMap((call) => {
      const at = call.args.indexOf("-i");
      return at < 0 ? [] : [call.args[at + 1] as string];
    });
}

describe.skipIf(!findExecutable("git"))("a second app's old side", () => {
  it("keeps the shared edge running through the move: only the app stops", async () => {
    const s = await moving();
    s.docker.images.add("ghcr.io/acme/shop:1");
    await dockerClient(s.docker).createContainer({
      image: "ghcr.io/acme/shop:1",
      labels: {
        "com.docker.compose.project": "shop",
        "com.docker.compose.project.working_dir": "/srv/apps/shop",
      },
    });
    const side = ownSide("old", s.services);
    await side.stopApp(s.session);
    await side.stopEdge(s.session);
    await side.startApp(s.session);
    const ops = s.events.flatMap((e) => (e.type === "remote" ? [e.op] : []));
    expect(ops).toEqual(["stop app", "start app"]);
    expect(s.deps.reporter.text()).toContain(
      "Caddy on your old server keeps running: other apps there use it too.",
    );
  });

  it("is removed at --finish by the second-app teardown, its own parts only", async () => {
    const s = await moving();
    const calls = s.runner.calls.length;
    // --finish's removal of the old side picks it by the move's old target.
    Object.assign(s.session.services, s.services);
    expect(await removeOldSide(s.session, { confirm: s.confirm })).toEqual({
      snapshotId: undefined,
    });

    const teardown = s.host.applies.at(-1);
    expect(s.host.applies).toHaveLength(1);
    expect(teardown?.plan.purpose).toBe("teardown");
    expect(teardown?.plan.app).toBe("inventory");
    // The record as root through Docker in the edge's image, everything else as the login.
    expect(teardown?.options.rootImage).toBe(IMAGES.caddy.ref);
    const ids = teardown?.plan.steps.map((step) => step.id) ?? [];
    expect(ids).toContain("deploy-key");
    for (const shared of ["edge", "check-key", "portainer"]) expect(ids).not.toContain(shared);
    const dirs = teardown?.plan.steps.find((step) => step.id === "app-dirs");
    expect(dirs?.params).toMatchObject({ runAs: "login", image: IMAGES.busybox.ref });
    // authorized_keys holds exactly the lines it held before the app came; shop stays.
    expect(s.host.facts.deployUser?.keys).toEqual(BEFORE);
    expect(s.host.facts.apps.find((app) => app.name === "inventory")).toBeUndefined();
    expect(s.host.facts.containers.map((c) => c.project)).toEqual(["shop"]);

    // Logged in with its own deploy key only, never the first app's.
    const used = keyFiles(s, calls);
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((file) => file === s.key.privateKeyFile)).toBe(true);

    // The server is the first app's: it stays with it.
    const request = s.handler.requests.find((r) => r.kind === "host-apply");
    expect(request).toMatchObject({ allowDestroy: true, confirmPhrase: "inventory" });
    expect(request?.details).toContain(
      'The server is the one OpsCrew created for "shop", and it stays until that app\'s `opscrew destroy`.',
    );
    expect(request?.details).not.toContain("never deletes, rebuilds or reinstalls");
    expect(s.confirmed[0]?.dataWarning).not.toContain("your own server");

    // Its key line is off the server: the old login is no longer joined, the new side's untouched.
    expect((await readOldOwnServer(s.deps.paths))?.joined).toBeUndefined();
    expect((await readOwnServer(s.deps.paths))?.host).toBe(OWN_IPV4);

    // Again (a --finish that stopped later): nothing of the app is left, and nothing connects.
    const again = s.runner.calls.length;
    expect(await ownSide("old", s.services).remove(s.session, s.confirm)).toBeUndefined();
    expect(s.host.applies).toHaveLength(1);
    expect(s.runner.calls.slice(again).filter((call) => call.command === "ssh")).toEqual([]);
    expect(s.deps.reporter.text()).toContain(
      'Nothing of inventory is left on the server of "shop".',
    );
  });

  it("stays joined when the teardown stopped, so --finish runs it again with its own key", async () => {
    const s = await moving();
    s.host.fail = new HostApplyError("COMMAND_FAILED", "the folder step failed", []);
    await expect(ownSide("old", s.services).remove(s.session, s.confirm)).rejects.toThrow(
      "the folder step failed",
    );
    expect((await readOldOwnServer(s.deps.paths))?.joined).toBe(true);
  });

  it("leaks no address or key, and never the first app's deploy key", async () => {
    const s = await moving();
    await ownSide("old", s.services).remove(s.session, s.confirm);
    const key = await readFile(s.key.privateKeyFile, "utf8");
    const printed = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}\n${JSON.stringify(s.handler.requests)}`;
    for (const secret of [SERVER_IPV4, OWN_IPV4, key.trim()]) expect(printed).not.toContain(secret);
    const seen = `${printed}\n${JSON.stringify(s.runner.calls)}\n${await readFile(serverAddressesFile(s.deps.paths), "utf8")}`;
    expect(seen).not.toContain(s.shared.firstKey);
    expect(seen).not.toContain(s.shared.first.files.deployKey);
  });
});
