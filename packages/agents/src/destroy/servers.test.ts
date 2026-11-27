import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { appDirs, type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import type {
  ApprovalRequest,
  CommandResult,
  RemoteExec,
  ServerSnapshotApi,
} from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, networkInterface, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { allocateNetwork } from "../network";
import { splitPlan, withNetwork } from "../network/__fixtures__/plans";
import { ensureStatePassphrase } from "../shared";
import { readServerAddresses, updateServerAddresses } from "../shared/server-record";
import {
  createProject,
  createTestPhaseDeps,
  deployedResources,
  FakeDestroyGitHub,
  FakeHostServer,
  FakeServers,
  fakeCloudflare,
  HOST_KEY,
  preparedServerFacts,
  projectRunner,
  ScriptedApprovalHandler,
  ScriptedDestroyEngine,
  SERVER_ADDRESS,
  SERVER_IPV4,
  serverAttributes,
  testKeyMaker,
} from "../testing";
import { firstAppLook } from "../testing/other-apps";
import { dataSnapshotOffer } from "./cancel";
import { runDestroy } from "./run";
import { serverLines, serverSnapshots } from "./servers";
import type { DestroyPreview, DestroyServices } from "./types";

const DATA_HOST = "203.0.113.20";
const DATA_ADDRESS = "module.server_data.hcloud_server.this";

/** A deployed app whose Postgres runs on `data` (a Hetzner server, or the user's own). */
function deployedSplit(data: "cloud" | "own", publicSsh = true): DeployPlan {
  const base = splitPlan({ data });
  const deployed = {
    ...base,
    security: { ...base.security, ...(publicSsh ? {} : { sshAllowedCidrs: [] }) },
    deployment: {
      ...base.deployment,
      lastPlanHash: "a".repeat(64),
      lastApplyAt: "2026-10-10T09:00:00.000Z",
      firstDeployAt: "2026-10-10T09:30:00.000Z",
    },
  };
  const facts = { data: { udpPortsInUse: [], wireguardInterfaces: [] } };
  const network = allocateNetwork(deployed, facts, testKeyMaker()).network;
  return withNetwork(deployed, { ...network, publicSsh });
}

/** The data server's resources in the destroy plan, beside the app server's. */
function dataResources() {
  return [
    ...deployedResources(),
    {
      address: "module.server_data.hcloud_firewall.this",
      type: "hcloud_firewall",
      name: "this",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "delete" as const,
    },
    {
      address: DATA_ADDRESS,
      type: "hcloud_server",
      name: "this",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "delete" as const,
    },
  ];
}

/** The protection-lifting plan of both Hetzner servers. */
function unprotectBoth() {
  const change = (address: string) => ({
    address,
    mode: "managed",
    type: "hcloud_server",
    change: {
      actions: ["update"],
      before: serverAttributes(),
      after: serverAttributes({ delete_protection: false, rebuild_protection: false }),
      after_unknown: {},
    },
  });
  return {
    changes: [SERVER_ADDRESS, DATA_ADDRESS].map((address) => ({
      address,
      type: "hcloud_server",
      name: "this",
      provider: "registry.opentofu.org/hetznercloud/hcloud",
      action: "update" as const,
    })),
    planJson: {
      format_version: "1.2",
      resource_changes: [change(SERVER_ADDRESS), change(DATA_ADDRESS)],
    },
  };
}

async function setup(plan: DeployPlan, answer: (request: ApprovalRequest) => boolean = () => true) {
  const project = await createProject(plan);
  const engine = new ScriptedDestroyEngine({
    resources: plan.servers?.[0]?.target.provider === "own" ? deployedResources() : dataResources(),
    unprotect: plan.servers?.[0]?.target.provider === "own" ? undefined : unprotectBoth(),
  });
  const handler = new ScriptedApprovalHandler(answer);
  const deps = await createTestPhaseDeps({
    root: project.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(project.root, ".home-opscrew"),
      HCLOUD_TOKEN: fakeSecret("hcloud-token"),
      CLOUDFLARE_API_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  await ensureStatePassphrase(deps.paths);
  await mkdir(deps.paths.files.tfstateDir, { recursive: true });
  await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), '{"version":4}\n');
  await mkdir(join(project.root, plan.infra.dir), { recursive: true });
  await mkdir(dirname(deps.paths.files.knownHosts), { recursive: true });
  await writeFile(
    deps.paths.files.knownHosts,
    `${SERVER_IPV4} ${HOST_KEY}\n${DATA_HOST} ${HOST_KEY}\n`,
  );
  const own = plan.servers?.[0]?.target.provider === "own";
  await updateServerAddresses(deps.paths, (current) => ({
    ...current,
    servers: { data: { ipv4: DATA_HOST } },
    ...(own
      ? { ownServers: { data: { host: DATA_HOST, port: 22, user: "root", agent: true } } }
      : {}),
  }));
  const services: DestroyServices = {
    // The look for apps from other repositories on the server finds none.
    otherApps: await firstAppLook(deps.paths),
    engine: async () => engine,
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    servers: new FakeServers(),
    cloudflare: fakeCloudflare(),
    github: new FakeDestroyGitHub(),
    sleep: async () => undefined,
  };
  return { project, engine, handler, deps, services };
}

/**
 * The fake host adapter of the user's own server `data`, prepared for `shop` with its network,
 * and with `others` another project's app `blog` set up there too.
 */
function ownDataServer(plan: DeployPlan, projectId: string, others = false): FakeHostServer {
  const member = plan.network?.members.find((m) => m.name === "data");
  const iface = networkInterface(member ?? { port: 51820 });
  const facts = preparedServerFacts(projectId);
  const shop = facts.apps[0]?.record;
  const blog =
    others && shop !== undefined && shop !== null
      ? [
          {
            name: "blog",
            record: {
              ...shop,
              app: "blog",
              projectId: "blog-project",
              folders: appDirs("blog"),
              composeProject: "blog",
            },
          },
        ]
      : [];
  return new FakeHostServer(
    HostFactsSchema.parse({
      ...facts,
      apps: [...facts.apps, ...blog],
      record:
        facts.record === null
          ? null
          : {
              ...facts.record,
              apps: [...facts.record.apps, ...blog.map((app) => app.name)],
              networks: { [iface]: "shop" },
            },
    }) as HostFacts,
  );
}

/** A shell on the user's own server whose privilege probe says root. */
function rootShell(address: string): RemoteExec {
  return {
    host: address,
    async run(command): Promise<CommandResult> {
      const stdout = command.includes("echo sudo-password") ? "root\n" : "";
      return { exitCode: 0, stdout, stderr: "" };
    },
  };
}

/** Wraps `fakeServers` to record every `(app, names)` passed to `findAppServers`. */
function trackFind(
  fakeServers: FakeServers,
  findCalls: Array<{ app: string; names: readonly string[] | undefined }>,
): ServerSnapshotApi {
  return Object.assign(Object.create(fakeServers) as FakeServers, {
    findAppServers: async (app: string, names?: readonly string[]) => {
      findCalls.push({ app, names });
      return fakeServers.findAppServers(app);
    },
  });
}

describe.skipIf(!findExecutable("git"))("runDestroy with extra servers (US2 #6, FR-1812)", () => {
  it("deletes the extra Hetzner server after its own typed name, with its protection lifted", async () => {
    const plan = deployedSplit("cloud");
    const s = await setup(plan);
    const asked: DestroyPreview[] = [];
    await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });
    // The app's name, then the extra server's, each listing every server.
    expect(asked.map((p) => [p.name, p.server])).toEqual([
      ["shop", undefined],
      ["shop-data", "data"],
    ]);
    expect(asked[1]?.confirmPrompt).toBe(
      "Type shop-data to delete server data (the Hetzner Cloud server shop-data) and everything on it (anything else cancels)",
    );
    expect(asked[0]?.servers).toEqual([
      "Server app: the Hetzner Cloud server shop is deleted; OpsCrew takes no snapshot of it.",
      "Server data: the Hetzner Cloud server shop-data is deleted with the PostgreSQL database on it; OpsCrew takes no snapshot of it.",
    ]);
    // Every plan passes both servers' delete protection off.
    const vars = { delete_protection: "false", data_delete_protection: "false" };
    expect(s.engine.planOptions.every((o) => JSON.stringify(o.vars) === JSON.stringify(vars))).toBe(
      true,
    );
    const lift = s.handler.requests.find((r) => r.title.startsWith("Lift delete protection"));
    expect(lift?.title).toBe("Lift delete protection on shop and shop-data");
    const destroy = s.handler.requests.find((r) => r.title.startsWith("Delete shop"));
    expect(destroy).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
    expect(destroy?.details).toContain(DATA_ADDRESS);
    expect(destroy?.details).toContain(
      "Server data: the Hetzner Cloud server shop-data is deleted",
    );
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
    // The deleted extra server is forgotten on this computer: its address and its host key.
    expect((await readServerAddresses(s.deps.paths)).servers).toBeUndefined();
    expect(await readFile(s.deps.paths.files.knownHosts, "utf8")).not.toContain(DATA_HOST);
  });

  it("deletes nothing when the extra server's name is not typed", async () => {
    const s = await setup(deployedSplit("cloud"));
    const error = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async (preview) => preview.server === undefined,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect((error as Error).message).toContain("nothing was deleted");
    expect(s.engine.applied).toEqual([]);
    expect((await readServerAddresses(s.deps.paths)).servers?.data?.ipv4).toBe(DATA_HOST);
  });

  it("snapshots every server it deletes, each with its own record, and none with --no-snapshot", async () => {
    const s = await setup(deployedSplit("cloud"));
    const servers = s.services.servers as FakeServers;
    const asked: DestroyPreview[] = [];
    const result = await runDestroy(s.deps, {
      services: s.services,
      snapshot: true,
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });
    expect(servers.snapshots.map((snapshot) => snapshot.name)).toEqual([
      "opscrew-shop-before-destroy-20261011T120000Z",
      "opscrew-shop-data-before-destroy-20261011T120000Z",
    ]);
    expect(asked[0]?.servers?.[1]).toContain("a snapshot of it is taken first");
    expect(result.remaining.join("\n")).toContain("The snapshot of shop-data (Hetzner image 9001)");
    // Both records go once the teardown finished.
    expect(await readdir(s.deps.paths.stateDir)).not.toContainEqual(
      expect.stringMatching(/snapshot/),
    );

    const none = await setup(deployedSplit("cloud"));
    await runDestroy(none.deps, {
      services: none.services,
      snapshot: false,
      confirm: async () => true,
    });
    expect((none.services.servers as FakeServers).snapshots).toEqual([]);
  });

  it("names the snapshots taken earlier of every server it deletes, each by its name", async () => {
    const s = await setup(deployedSplit("cloud"));
    const servers = s.services.servers as FakeServers;
    // Both fake servers have the state id 4711: the app's is read first, then shop-data's.
    const answers = [["101"], ["201", "202"]];
    let reads = 0;
    servers.listSnapshots = async () =>
      (answers[reads++] ?? []).map((id) => ({ id, createdAt: "2026-10-01T00:00:00Z" }));
    const result = await runDestroy(s.deps, {
      services: s.services,
      snapshot: false,
      confirm: async () => true,
    });
    expect(reads).toBe(2);
    const destroy = s.handler.requests.find((r) => r.title.startsWith("Delete shop"));
    const billing =
      "Hetzner bills snapshots per GB per month at the rate listed on https://www.hetzner.com/cloud";
    expect(destroy?.details).toContain(
      `The snapshot of shop taken earlier stays: Hetzner image 101 (${billing}; OpsCrew never deletes it).`,
    );
    expect(destroy?.details).toContain(
      `The 2 snapshots of shop-data taken earlier stay: Hetzner image 201 and Hetzner image 202 (${billing}; OpsCrew never deletes them).`,
    );
    expect(result.remaining).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^The snapshot of shop taken earlier \(Hetzner image 101\)\./),
        expect.stringMatching(
          /^The 2 snapshots of shop-data taken earlier \(Hetzner image 201 and Hetzner image 202\)\./,
        ),
      ]),
    );
  });

  it("removes OpsCrew's part from an extra own server after the infrastructure, SSH reopened first", async () => {
    const plan = deployedSplit("own", false);
    const s = await setup(plan);
    const host = ownDataServer(plan, s.deps.paths.projectId);
    const deletedBefore: number[] = [];
    const apply = host.apply.bind(host);
    host.apply = async (remote, hostPlan, options) => {
      deletedBefore.push(s.engine.applied.length);
      return apply(remote, hostPlan, options);
    };
    await runDestroy(s.deps, {
      services: { ...s.services, remote: rootShell, own: { host, verifyLogin: async () => true } },
      snapshot: false,
      confirm: async () => true,
    });
    const applied = host.applies.map((a) => [
      a.plan.purpose,
      a.plan.steps.filter((step) => step.state === "change").map((step) => step.id),
    ]);
    expect(applied[0]).toEqual(["setup", ["public-ssh"]]);
    expect(applied[1]?.[0]).toBe("teardown");
    expect(applied[1]?.[1]).toEqual(
      expect.arrayContaining(["app-dirs", "network-filter", "network"]),
    );
    expect(applied[2]?.[0]).toBe("undo");
    // After the infrastructure was deleted (lifting the protection, then the destroy plan).
    expect(deletedBefore).toEqual([2, 2, 2]);
    const hosts = s.handler.requests.filter((r) => r.kind === "host-apply");
    expect(hosts.map((r) => [r.title, r.allowDestroy, r.confirmPhrase])).toEqual([
      ["Open SSH on server data again before its private network is removed", undefined, undefined],
      [
        expect.stringMatching(/^Remove shop's services and private network from server data/),
        true,
        "shop",
      ],
      [expect.stringMatching(/^Undo OpsCrew's changes to server data/), true, "shop"],
    ]);
    const after = await readArtifact("plan", s.deps.paths.files.plan);
    expect(after.network?.publicSsh).toBe(true);
    expect(after.security.sshAllowedCidrs).toEqual(["0.0.0.0/0", "::/0"]);
    expect(after.deployment.destroyedAt).toBeDefined();
    // The user's own server keeps its login on this computer.
    expect((await readServerAddresses(s.deps.paths)).ownServers?.data?.host).toBe(DATA_HOST);
  });

  it("changes nothing on an extra own server when the destroy plan is refused", async () => {
    const plan = deployedSplit("own", false);
    const s = await setup(plan, (request) => !request.title.startsWith("Delete shop"));
    const host = ownDataServer(plan, s.deps.paths.projectId);
    const before = await readFile(s.deps.paths.files.plan, "utf8");
    const error = await runDestroy(s.deps, {
      services: { ...s.services, remote: rootShell, own: { host, verifyLogin: async () => true } },
      snapshot: false,
      confirm: async () => true,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect((error as Error).message).toContain("Nothing was deleted.");
    expect(host.applies).toEqual([]);
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect"]);
    expect(await readFile(s.deps.paths.files.plan, "utf8")).toBe(before);
  });

  it("keeps OpsCrew's setup on an extra own server that another OpsCrew app still uses", async () => {
    const plan = deployedSplit("own");
    const s = await setup(plan);
    const host = ownDataServer(plan, s.deps.paths.projectId, true);
    await runDestroy(s.deps, {
      services: { ...s.services, remote: rootShell, own: { host, verifyLogin: async () => true } },
      snapshot: false,
      confirm: async () => true,
    });
    expect(host.applies.map((a) => a.plan.purpose)).toEqual(["teardown"]);
    expect(s.deps.reporter.text()).toContain(
      'OpsCrew\'s setup stays on server data: the OpsCrew app "blog" still uses it.',
    );
  });

  it("snapshots, lifts protection on, and confirms an extra server dropped from plan.yaml while still in state (#57)", async () => {
    // 1. Start from a split plan whose extra server `data` is in Terraform state, then drop `data` from plan.yaml.
    const full = deployedSplit("cloud");
    const { servers: _droppedServers, network: _droppedNetwork, ...rest } = full;
    const droppedPlan: DeployPlan = {
      ...rest,
      services: full.services.map(({ server: _server, ...service }) => service),
    };
    const s = await setup(droppedPlan);
    // `variables.tf` still declares `data_delete_protection` because provision has not re-run.
    await writeFile(
      join(s.project.root, droppedPlan.infra.dir, "variables.tf"),
      'variable "delete_protection" {}\nvariable "data_delete_protection" {}\n',
    );
    const findCalls: Array<{ app: string; names: readonly string[] | undefined }> = [];
    const fakeServers = s.services.servers as FakeServers;
    const trackedServices: DestroyServices = {
      ...s.services,
      servers: trackFind(fakeServers, findCalls),
    };

    // 2. Refusing the dropped server's typed name deletes nothing.
    const refused = await runDestroy(s.deps, {
      services: trackedServices,
      confirm: async (preview) => preview.server === undefined,
    }).catch((e: unknown) => e);
    expect(refused).toMatchObject({ code: "APPROVAL_REFUSED" });
    expect((refused as Error).message).toContain("nothing was deleted");
    expect(s.engine.applied).toEqual([]);

    // 3. Confirming both names snapshots both servers (under default `auto`), lifts protection on both, and cleans up.
    const asked: DestroyPreview[] = [];
    const result = await runDestroy(s.deps, {
      services: trackedServices,
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });
    expect(asked.map((p) => [p.name, p.server])).toEqual([
      ["shop", undefined],
      ["shop-data", "data"],
    ]);
    expect(asked[0]?.servers).toEqual([
      "Server app: the Hetzner Cloud server shop is deleted with the PostgreSQL database on it; a snapshot of it is taken first.",
      "Server data (removed from plan.yaml, still in the state): the Hetzner Cloud server shop-data is deleted; a snapshot of it is taken first.",
    ]);
    expect(findCalls).toContainEqual({ app: "shop", names: ["shop-data"] });
    expect(fakeServers.snapshots.map((snapshot) => snapshot.name)).toEqual([
      "opscrew-shop-before-destroy-20261011T120000Z",
      "opscrew-shop-data-before-destroy-20261011T120000Z",
    ]);
    const lift = s.handler.requests.find((r) => r.title.startsWith("Lift delete protection"));
    expect(lift?.title).toBe("Lift delete protection on shop and shop-data");
    expect(s.engine.applied.map((a) => a.kind)).toEqual(["unprotect", "destroy"]);
    expect(result.remaining.join("\n")).toContain("The snapshot of shop-data (Hetzner image 9001)");
    expect(await readdir(s.deps.paths.stateDir)).not.toContainEqual(
      expect.stringMatching(/snapshot/),
    );
    expect((await readServerAddresses(s.deps.paths)).servers).toBeUndefined();
    expect(await readFile(s.deps.paths.files.knownHosts, "utf8")).not.toContain(DATA_HOST);
  });

  it("uses the state-recorded name of a dropped Kamatera extra server for findAppServers and typed confirmation (#57)", async () => {
    const full = deployedSplit("cloud");
    const { servers: _droppedServers, network: _droppedNetwork, ...rest } = full;
    const droppedPlan: DeployPlan = {
      ...rest,
      services: full.services.map(({ server: _server, ...service }) => service),
    };
    const kamateraAddress = "module.server_cache.kamatera_server.this";
    const s = await setup(droppedPlan);
    const kamateraEngine = new ScriptedDestroyEngine({
      resources: [
        ...deployedResources(),
        {
          address: kamateraAddress,
          type: "kamatera_server",
          name: "this",
          provider: "registry.opentofu.org/kamatera/kamatera",
          action: "delete",
        },
      ],
    });
    const basePlan = kamateraEngine.plan.bind(kamateraEngine);
    kamateraEngine.plan = async (dir, planFile, options) => {
      const summary = await basePlan(dir, planFile, options);
      if (options?.destroy !== true) return summary;
      return {
        ...summary,
        planJson: {
          format_version: "1.2",
          resource_changes: [
            {
              address: SERVER_ADDRESS,
              type: "hcloud_server",
              change: { actions: ["delete"], before: { id: "4711", name: "shop" } },
            },
            {
              address: kamateraAddress,
              type: "kamatera_server",
              change: {
                actions: ["delete"],
                before: { id: "k-99", name: "shop-cache-state" },
              },
            },
          ],
        },
      };
    };
    const findCalls: Array<{ app: string; names: readonly string[] | undefined }> = [];
    const fakeServers = new FakeServers();
    fakeServers.servers = [
      { id: "4711", name: "shop", status: "running" },
      { id: "k-99", name: "shop-cache-state", status: "on", nameOnly: true },
    ];
    const trackedServers = trackFind(fakeServers, findCalls);
    const asked: DestroyPreview[] = [];
    await runDestroy(s.deps, {
      services: {
        ...s.services,
        engine: async () => kamateraEngine,
        servers: trackedServers,
      },
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });
    expect(asked.map((p) => [p.name, p.server])).toEqual([
      ["shop", undefined],
      ["shop-cache-state", "cache"],
    ]);
    expect(findCalls).toContainEqual({ app: "shop", names: ["shop-cache-state"] });
    expect(fakeServers.snapshots.map((snapshot) => snapshot.name)).toContain(
      "opscrew-shop-cache-state-before-destroy-20261011T120000Z",
    );
  });

  it("omits undeclared <name>_delete_protection -var when variables.tf was already re-rendered without the dropped server (#57)", async () => {
    const full = deployedSplit("cloud");
    const { servers: _droppedServers, network: _droppedNetwork, ...rest } = full;
    const droppedPlan: DeployPlan = {
      ...rest,
      services: full.services.map(({ server: _server, ...service }) => service),
    };
    const s = await setup(droppedPlan);
    // Earlier provision already re-rendered `variables.tf` without `data_delete_protection`.
    await writeFile(
      join(s.project.root, droppedPlan.infra.dir, "variables.tf"),
      'variable "delete_protection" {}\n',
    );
    // Unprotect only touches `app`'s server (module.server_data has no protection variable left).
    const unprotectAppOnly = {
      changes: [
        {
          address: SERVER_ADDRESS,
          type: "hcloud_server",
          name: "this",
          provider: "registry.opentofu.org/hetznercloud/hcloud",
          action: "update" as const,
        },
      ],
      planJson: {
        format_version: "1.2",
        resource_changes: [
          {
            address: SERVER_ADDRESS,
            mode: "managed",
            type: "hcloud_server",
            change: {
              actions: ["update"],
              before: serverAttributes(),
              after: serverAttributes({ delete_protection: false, rebuild_protection: false }),
              after_unknown: {},
            },
          },
        ],
      },
    };
    const engine = new ScriptedDestroyEngine({
      resources: dataResources(),
      unprotect: unprotectAppOnly,
    });
    const asked: DestroyPreview[] = [];
    await runDestroy(s.deps, {
      services: { ...s.services, engine: async () => engine },
      confirm: async (preview) => {
        asked.push(preview);
        return true;
      },
    });
    // Still confirms and snapshots the dropped server, but NEVER passes undeclared `data_delete_protection`.
    expect(asked.map((p) => [p.name, p.server])).toEqual([
      ["shop", undefined],
      ["shop-data", "data"],
    ]);
    for (const opts of engine.planOptions) {
      expect(opts.vars).toEqual({ delete_protection: "false" });
      expect(opts.vars).not.toHaveProperty("data_delete_protection");
    }
    const lift = s.handler.requests.find((r) => r.title.startsWith("Lift delete protection"));
    expect(lift?.title).toBe("Lift delete protection on shop");
  });
});

describe("serverSnapshots and dataSnapshotOffer for dropped extra servers (#57)", () => {
  it("discovers dropped extra servers from plan deletions across providers, skips module.server_previous, and respects --no-snapshot", () => {
    const full = deployedSplit("cloud");
    const { servers: _droppedServers, network: _droppedNetwork, ...rest } = full;
    const plan: DeployPlan = {
      ...rest,
      services: full.services.map(({ server: _server, ...service }) => service),
    };
    const preview = {
      changes: [
        ...deployedResources(),
        {
          address: "module.server_previous.hcloud_server.this",
          type: "hcloud_server",
          name: "this",
          provider: "registry.opentofu.org/hetznercloud/hcloud",
          action: "delete" as const,
        },
        {
          address: "module.server_db.digitalocean_droplet.this",
          type: "digitalocean_droplet",
          name: "this",
          provider: "registry.opentofu.org/digitalocean/digitalocean",
          action: "delete" as const,
        },
        {
          address: "module.server_archive.contabo_instance.this",
          type: "contabo_instance",
          name: "this",
          provider: "registry.opentofu.org/contabo/contabo",
          action: "delete" as const,
        },
      ],
      planJson: {
        format_version: "1.2",
        resource_changes: [
          {
            address: SERVER_ADDRESS,
            type: "hcloud_server",
            change: { actions: ["delete"], before: { id: "4711", name: "shop" } },
          },
          {
            address: "module.server_db.digitalocean_droplet.this",
            type: "digitalocean_droplet",
            change: { actions: ["delete"], before: { id: 888, backups: true } },
          },
          {
            address: "module.server_archive.contabo_instance.this",
            type: "contabo_instance",
            change: {
              actions: ["delete"],
              // Contabo sets internal `name` (`vmi…`) alongside OpsCrew's `display_name`: prefer `display_name`.
              before: { id: "c-10", name: "vmi123456", display_name: "shop-archive-old" },
            },
          },
        ],
      },
    };

    const autoSnapshots = serverSnapshots(plan, preview, "auto");
    expect(autoSnapshots.map((s) => [s.server, s.provider, s.name, s.ids, s.wanted])).toEqual([
      ["app", "hetzner", undefined, ["4711"], true],
      // Fallback name `<app>-<server>` when state omits `before.name`, snapshots wanted by default.
      ["db", "digitalocean", "shop-db", ["888"], true],
      // Contabo snapshots go with the server (`wanted: false`), state `display_name` preserved.
      ["archive", "contabo", "shop-archive-old", ["c-10"], false],
    ]);

    const noSnapshots = serverSnapshots(plan, preview, false);
    expect(noSnapshots.every((s) => !s.wanted)).toBe(true);

    // `serverLines` includes dropped state servers even when `plan.servers` is empty.
    const lines = serverLines(plan, autoSnapshots);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Server db (removed from plan.yaml, still in the state)");
    expect(lines[2]).toContain("shop-archive-old");

    // `dataSnapshotOffer` produces plain-English text even when dropped server has no services in plan.yaml.
    const contaboOnly = autoSnapshots.filter((s) => s.server === "archive");
    const offer = dataSnapshotOffer(plan, contaboOnly, "");
    expect(offer).toContain("To keep any data on server archive,");
  });
});
