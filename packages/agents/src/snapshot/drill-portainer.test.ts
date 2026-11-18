import { Readable } from "node:stream";
import type { TarEntry } from "@opscrew/connector-docker";
import { type FakeContainer, parseTar } from "@opscrew/connector-docker/testing";
import {
  type PinnedRequest,
  type PinnedStream,
  portainerClient,
} from "@opscrew/connector-portainer";
import { OpsCrewError } from "@opscrew/core";
import type { DrillRecord } from "@opscrew/iac-templates";
import { IMAGES } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { fakePortainer, portainerPlan } from "../testing";
import {
  CACHE_SECRET,
  DB_SECRET,
  PORTAINER_TOKEN,
  type PortainerWorld,
  portainerWorld,
} from "./__fixtures__/portainer";
import { SH_AVAILABLE } from "./__fixtures__/server";
import { everythingShown, RUNNING, stagingPlan } from "./__fixtures__/world";
import { drillSnapshot } from "./drill";
import { readPortainerDrills } from "./drill-portainer";
import { drillSummary } from "./drill-report";

const ID = "20261106T190000Z";
const STACK = "opscrew-shop-staging";
const DRILL = `${STACK}-drill`;
const LABEL = "com.docker.compose.project";

/** `shop` in staging in the user's Portainer: PostgreSQL `db`, the stop-only Kafka and SQLite. */
function plan(): DeployPlan {
  const base = portainerPlan({ deployed: true });
  return stagingPlan(
    [
      { kind: "postgres", name: "db" },
      { kind: "kafka", name: "kafka" },
    ],
    {
      sqlite: true,
      base,
      fields: {
        app: {
          ...base.app,
          build: {
            builder: "railpack",
            chosen: "auto",
            reason: "test",
            runtime: { language: "node", version: "24" },
            probe: "node",
          },
        },
      },
    },
  );
}

/** The record of {@link ID}: the database, Kafka and SQLite, of the running version. */
function record() {
  return {
    id: ID,
    kind: "manual",
    taken: "2026-11-06T19:00:00Z",
    version: `sha256:${RUNNING}`,
    services: [
      { name: "db", kind: "postgres", file: "db.dump", size: 4, image: IMAGES.postgres.ref },
      { name: "kafka", kind: "kafka", file: "kafka.tar", size: 4, image: "apache/kafka" },
      { name: "sqlite", kind: "sqlite", file: "sqlite.tar", size: 4 },
    ],
  };
}

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

interface DrillWorld extends PortainerWorld {
  portainer: ReturnType<typeof fakePortainer>;
  /** The drill stack's network as Docker reports it. */
  network: { internal: boolean };
  /** The app's health check's answer in the drill's stack. */
  health: "healthy" | "unhealthy";
  /** What the table count prints. */
  tables: string;
  /** Minutes the database's load takes on the drill's clock. */
  loadMinutes: number;
  /** Every archive put into a container. */
  puts: TarEntry[][];
}

/**
 * The world of `opscrew restore` in Portainer, with a Portainer that deploys string stacks into
 * the fake Docker: each started service a running container of the stack's project, its volumes
 * made, and a removed stack's containers gone. The app's own stack (`opscrew-shop-staging`) runs
 * beside it, as a Git stack with its volumes.
 */
async function drillWorld(
  o: { stacks?: Parameters<typeof fakePortainer>[0]["stacks"]; approve?: boolean } = {},
) {
  const base = await portainerWorld(plan(), { answer: () => o.approve ?? true });
  base.store(ID, record());
  const portainer = fakePortainer({
    token: PORTAINER_TOKEN,
    stacks: [
      {
        Id: 1,
        Name: STACK,
        Type: 2,
        EndpointId: 3,
        Status: 1,
        Env: [{ name: "OPSCREW_DB_PASSWORD", value: DB_SECRET }],
        GitConfig: {
          URL: "https://github.com/acme/shop",
          ReferenceName: "refs/heads/opscrew-deploy-staging",
          ConfigFilePath: "compose.yaml",
        },
        DeploymentStatus: [],
        file: "",
      },
      ...(o.stacks ?? []),
    ],
  });
  const world: DrillWorld = {
    ...base,
    portainer,
    network: { internal: true },
    health: "healthy",
    tables: "3",
    loadMinutes: 0,
    puts: [],
  };
  const { docker } = world;
  let clock = 0;
  const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });
  const project = (name: string, compose: string) => {
    const document = parse(compose) as {
      services: Record<string, { profiles?: string[]; volumes?: string[]; healthcheck?: unknown }>;
      volumes?: Record<string, { external?: boolean }>;
    };
    for (const [key, volume] of Object.entries(document.volumes ?? {})) {
      if (volume?.external !== true && !docker.volumes.has(`${name}_${key}`)) {
        docker.addVolume(`${name}_${key}`);
      }
    }
    for (const [service, spec] of Object.entries(document.services)) {
      const id = `${name}-${service}`.padEnd(64, "0");
      if (spec.profiles !== undefined || docker.containers.has(id)) continue;
      const container: FakeContainer = {
        id,
        name: `${name}-${service}-1`,
        image: "image",
        cmd: [],
        env: [],
        labels: { [LABEL]: name, "com.docker.compose.service": service },
        binds: (spec.volumes ?? []).map((mount) => `${name}_${mount}`),
        mounts: [],
        state: "running",
        ...(spec.healthcheck === undefined ? {} : { health: world.health }),
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
      docker.containers.set(id, container);
    }
  };
  const request: PinnedRequest = async (init) => {
    const path = init.path.split("?")[0] ?? "";
    const proxy = "/api/endpoints/3/docker";
    if (init.method === "GET" && path.startsWith(`${proxy}/networks/`)) {
      portainer.calls.push(`GET ${path}`);
      const name = decodeURIComponent(path.slice(`${proxy}/networks/`.length));
      return name === `${DRILL}_internal`
        ? json(200, { Name: name, Internal: world.network.internal })
        : json(404, { message: "network not found" });
    }
    if (init.method === "GET" && path === `${proxy}/containers/json`) {
      return json(
        200,
        [...docker.containers.values()].map((c) => ({
          Id: c.id,
          Labels: c.labels,
          State: c.state,
          Ports: [],
        })),
      );
    }
    if (init.method === "GET" && path === `${proxy}/volumes`) {
      return json(200, {
        Volumes: [...docker.volumes].map(([Name, volume]) => ({ Name, Labels: volume.labels })),
      });
    }
    if (init.method === "DELETE" && path.startsWith(`${proxy}/volumes/`)) {
      portainer.calls.push(`DELETE ${path}`);
      const name = decodeURIComponent(path.split("/").pop() ?? "");
      return docker.volumes.delete(name) ? json(204, {}) : json(404, { message: "No such volume" });
    }
    const inspected = /^\/api\/endpoints\/3\/docker\/containers\/([^/]+)\/json$/.exec(path)?.[1];
    if (init.method === "GET" && inspected !== undefined) {
      const c = docker.containers.get(inspected);
      if (c === undefined) return json(404, { message: "No such container" });
      return json(200, {
        RestartCount: 0,
        State: {
          StartedAt: "2026-11-18T12:00:00Z",
          Status: c.state,
          ...(c.health === undefined ? {} : { Health: { Status: c.health } }),
        },
      });
    }
    const response = await portainer.request(init);
    const body = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    if (response.status < 300) {
      if (init.method === "POST" && path === "/api/stacks/create/standalone/string") {
        project(String(body.Name), String(body.StackFileContent));
      }
      if (init.method === "PUT" && /^\/api\/stacks\/\d+$/.test(path)) {
        project(DRILL, String(body.StackFileContent));
      }
      if (init.method === "DELETE" && /^\/api\/stacks\/\d+$/.test(path)) {
        for (const [id, c] of docker.containers)
          if (c.labels[LABEL] === DRILL) docker.containers.delete(id);
      }
    }
    return response;
  };
  const stream: PinnedStream = async (init) => {
    let streamed = init.body;
    if (init.method === "PUT" && streamed instanceof Readable) {
      const chunks: Buffer[] = [];
      for await (const chunk of streamed) chunks.push(Buffer.from(chunk));
      const archive = Buffer.concat(chunks);
      world.puts.push(parseTar(archive));
      streamed = Readable.from([archive], { objectMode: false });
    }
    return docker.request({
      method: init.method,
      path: init.path.slice("/api/endpoints/3/docker".length),
      headers: init.headers,
      ...(streamed !== undefined ? { body: streamed } : {}),
    });
  };
  world.services = {
    ...world.services,
    portainer: {
      client: (endpoint, token, clientDeps) =>
        portainerClient(endpoint, token, { ...clientDeps, request, stream }),
      wait: {
        timeoutMs: 1000,
        intervalMs: 1,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      },
    },
  };
  const played = docker.onStart;
  docker.onStart = (container) => {
    const script = container.cmd[2] ?? "";
    if (script.includes("pg_restore")) clock += world.loadMinutes * 60_000;
    if (script.includes("information_schema")) {
      world.ran.push({ ...container });
      return { exitCode: 0, stdout: `${world.tables}\n` };
    }
    return played?.(container);
  };
  return world;
}

/** The started one-offs whose script holds `text`. */
function ranWith(world: PortainerWorld, text: string) {
  return world.ran.filter((container) => (container.cmd[2] ?? "").includes(text));
}

/** Portainer's and Docker's changing calls. */
function changes(world: DrillWorld): string[] {
  return [
    ...world.portainer.mutations(),
    ...world.docker.calls.filter((call) =>
      /^POST \/containers\/opscrew-[^/]+\/(stop|start)$/.test(call),
    ),
  ];
}

describe.skipIf(!SH_AVAILABLE)("opscrew restore --drill in the user's Portainer", () => {
  it("restores into a second stack, starts the app on it, reads its health and removes it", async () => {
    const world = await drillWorld();
    const report = await drillSnapshot(world.deps, ID, { services: world.services });
    expect(report).toMatchObject({
      id: ID,
      where: "in your Portainer",
      outcome: "healthy",
      removal: "removed",
      health: { state: "healthy" },
      tables: [{ service: "db", count: 3 }],
      ownLogins: ["kafka"],
    });
    expect(report.parts.map((part) => part.name)).toEqual(["db", "kafka", "sqlite"]);
    expect(report.proves).toContain(`opscrew-${world.plan.app.name}-drill stack in your Portainer`);

    // Approved as a stack plan by its hash, like a destroy.
    const [approval] = world.handler.requests;
    expect(approval).toMatchObject({
      kind: "stack-apply",
      allowDestroy: true,
      confirmPhrase: `${world.plan.app.name}-drill`,
    });
    expect(approval?.details).toContain(`Stack: ${DRILL}, from a stack file OpsCrew gives`);
    expect(approval?.details).toContain(`the volume ${DRILL}_db_data`);
    expect(approval?.details).toContain(
      `read in place from the volume ${STACK}_snapshots, mounted read-only`,
    );
    expect(approval?.details).toMatch(/Stack plan hash: [0-9a-f]{64}/);

    // The stack from a string: cut off, no port, the app only once the data is back.
    const created = world.portainer.bodies.find((entry) =>
      entry.call.startsWith("POST /api/stacks/create/standalone/string"),
    )?.body as { Name: string; StackFileContent: string; Env: { name: string; value: string }[] };
    expect(created.Name).toBe(DRILL);
    expect(created.StackFileContent).toContain("internal: true");
    expect(created.StackFileContent).not.toMatch(/^\s*ports:/m);
    expect(
      (parse(created.StackFileContent) as { services: Record<string, { profiles?: string[] }> })
        .services.app?.profiles,
    ).toEqual(["app"]);
    // The copy's own values, never production's.
    const sent = JSON.stringify(world.portainer.bodies);
    expect(sent).not.toContain(DB_SECRET);
    expect(sent).not.toContain(CACHE_SECRET);
    const password = created.Env.find((pair) => pair.name === "OPSCREW_DB_PASSWORD")?.value ?? "";
    expect(password.length).toBeGreaterThanOrEqual(16);

    // The database loaded by a one-off of its image on the copy's network, the snapshots read-only.
    const [load] = ranWith(world, "pg_restore");
    expect(load?.network).toBe(`${DRILL}_internal`);
    expect(load?.mounts).toContainEqual({
      type: "volume",
      source: `${STACK}_snapshots`,
      target: "/snapshots",
      readOnly: true,
    });
    const secrets = world.puts
      .flat()
      .map((entry) => entry.data?.toString() ?? "")
      .join("\n");
    expect(secrets).toContain(password);
    expect(secrets).not.toContain(DB_SECRET);
    const [kafka] = ranWith(world, `/snapshots/${ID}/kafka.tar`);
    expect(kafka?.mounts).toContainEqual({
      type: "volume",
      source: `${DRILL}_kafka_data`,
      target: "/var/lib/kafka/data",
      readOnly: false,
    });
    const [sqlite] = ranWith(world, `/snapshots/${ID}/sqlite.tar`);
    expect(sqlite?.mounts).toContainEqual({
      type: "volume",
      source: `${DRILL}_sqlite`,
      target: "/data",
      readOnly: false,
    });
    for (const one of world.ran) {
      for (const mount of one.mounts) {
        if (mount.source.startsWith(`${STACK}_`)) expect(mount.readOnly).toBe(true);
      }
    }

    // Removed, and listed as gone; nothing named opscrew-shop-staging changed.
    expect(world.portainer.stacks.map((stack) => stack.Name)).toEqual([STACK]);
    expect([...world.docker.volumes.keys()].filter((name) => name.startsWith(DRILL))).toEqual([]);
    expect([...world.docker.volumes.keys()].filter((name) => name.startsWith(`${STACK}_`))).toEqual(
      [`${STACK}_snapshots`, `${STACK}_db_data`, `${STACK}_kafka_data`],
    );
    for (const call of changes(world)) {
      expect(call).not.toMatch(/\/api\/stacks\/1(\/|$)/);
      expect(call).not.toMatch(new RegExp(`/volumes/${STACK}_`));
      expect(call).not.toMatch(new RegExp(`/containers/${STACK}-(app|db|kafka)0`));
    }
    for (const service of ["app", "db", "kafka"]) {
      expect(world.docker.containers.get(`${STACK}-${service}`.padEnd(64, "0"))?.state).toBe(
        "running",
      );
    }
    expect(world.deps.audit.entries).toContainEqual(
      expect.objectContaining({ action: "run a restore drill", target: "portainer" }),
    );
    // The record kept on this computer, the fields of a server's drills.log line, no value.
    const [kept] = await readPortainerDrills(world.deps.paths);
    expect(kept).toMatchObject({
      kind: "manual",
      result: "healthy",
      id: ID,
      version: RUNNING.slice(0, 12),
      removal: "removed",
      tables: [{ service: "db", count: 3 }],
    });
    expect(JSON.stringify(kept)).not.toContain(password);
    expect(approval?.details).toContain("not checked in a Portainer");
    expect(world.deps.reporter.text()).toContain("not checked in a Portainer");
    const shown = everythingShown(world);
    for (const secret of [DB_SECRET, CACHE_SECRET, PORTAINER_TOKEN, password]) {
      expect(shown).not.toContain(secret);
    }
  });

  it("removes the stack at once when its network isn't cut off, before any data goes in", async () => {
    const world = await drillWorld();
    world.network.internal = false;
    const report = await drillSnapshot(world.deps, ID, { services: world.services });
    expect(report).toMatchObject({ outcome: "failed", reason: "network", removal: "removed" });
    expect(report.summary).toContain("removed it at once, before any data went in");
    expect(ranWith(world, "pg_restore")).toEqual([]);
    expect(world.portainer.stacks.map((stack) => stack.Name)).toEqual([STACK]);
  });

  it("tells a backup that didn't restore from an app that didn't become healthy", async () => {
    const empty = await drillWorld();
    empty.tables = "0";
    const bad = await drillSnapshot(empty.deps, ID, { services: empty.services });
    expect(bad).toMatchObject({ outcome: "not-restored", reason: "db", removal: "removed" });
    expect(bad.summary).toContain("The backup is bad");

    const sick = await drillWorld();
    sick.health = "unhealthy";
    const unhealthy = await drillSnapshot(sick.deps, ID, { services: sick.services });
    expect(unhealthy).toMatchObject({ outcome: "unhealthy", health: { state: "unhealthy" } });
    expect(unhealthy.summary).toContain("The backup itself is fine");
  });

  it("removes what an earlier drill left first", async () => {
    const world = await drillWorld({
      stacks: [
        {
          Id: 9,
          Name: DRILL,
          Type: 2,
          EndpointId: 3,
          Status: 4,
          Env: [],
          DeploymentStatus: [],
          file: "",
        },
      ],
    });
    const report = await drillSnapshot(world.deps, ID, { services: world.services });
    expect(report.outcome).toBe("healthy");
    expect(world.handler.requests[0]?.details).toContain(
      `First: Remove what an earlier restore drill left: the stack ${DRILL}.`,
    );
    expect(world.portainer.mutations()[0]).toMatch(/^DELETE \/api\/stacks\/9\?/);
  });

  it("refuses --keep, a refused approval and a Git stack of the drill's name before any change", async () => {
    const keep = await drillWorld();
    const kept = await failure(
      drillSnapshot(keep.deps, ID, { services: keep.services, keep: true }),
    );
    expect(kept.message).toContain("always removes its copy when it ends");
    expect(kept.message).toContain("Nothing was changed.");

    const refused = await drillWorld({ approve: false });
    const error = await failure(drillSnapshot(refused.deps, ID, { services: refused.services }));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(error.hint).toContain(`--confirm ${refused.plan.app.name}-drill --approve`);
    expect(changes(refused)).toEqual([]);

    const taken = await drillWorld({
      stacks: [
        {
          Id: 9,
          Name: DRILL,
          Type: 2,
          EndpointId: 3,
          Status: 1,
          Env: [],
          GitConfig: {
            URL: "https://github.com/acme/other",
            ReferenceName: "refs/heads/main",
            ConfigFilePath: "compose.yaml",
          },
          DeploymentStatus: [],
          file: "",
        },
      ],
    });
    const blocked = await failure(drillSnapshot(taken.deps, ID, { services: taken.services }));
    expect(blocked.message).toContain("not one a restore drill made");
    expect(taken.handler.requests).toEqual([]);
    expect(changes(taken)).toEqual([]);
  });

  it("stops at its 30-minute limit, removes its copy and records it", async () => {
    const world = await drillWorld();
    world.loadMinutes = 31;
    const report = await drillSnapshot(world.deps, ID, { services: world.services });
    expect(report).toMatchObject({ outcome: "failed", reason: "timeout", removal: "removed" });
    expect(report.summary).toContain("ran past its 30-minute limit");
    expect(world.portainer.stacks.map((stack) => stack.Name)).toEqual([STACK]);
    expect(world.portainer.mutations().some((call) => call.startsWith("PUT "))).toBe(false);
    expect((await readPortainerDrills(world.deps.paths)).at(-1)).toMatchObject({
      result: "failed",
      reason: "timeout",
    });
  });

  it("names --keep only where a copy can be kept", () => {
    const record: DrillRecord = {
      end: "2026-11-18T12:00:00Z",
      kind: "manual",
      result: "failed",
      parts: [],
      tables: [],
      cleaned: false,
      reason: "start",
    };
    const words = { id: ID, flags: "", ownLogins: [] };
    expect(drillSummary(record, { ...words, target: "server" })).toContain("--keep");
    expect(drillSummary(record, words)).toContain("--keep");
    expect(drillSummary(record, { ...words, target: "portainer" })).not.toContain("--keep");
    expect(drillSummary(record, { ...words, target: "hosting" })).not.toContain("--keep");
  });
});
