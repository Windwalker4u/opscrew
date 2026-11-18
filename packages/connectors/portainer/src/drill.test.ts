// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation under test.
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { portainerClient } from "./client";
import {
  createDrillStack,
  type DesiredDrillStack,
  drillStackName,
  planDrillStack,
  removeDrillStack,
  startDrillApp,
} from "./drill";
import { applyStackPlan, stackPlanHash } from "./index";
import type { PinnedRequest, PinnedRequestInit } from "./pinned";

const TOKEN = fakeSecret("generic-password", "drill portainer token");
const VALUE = fakeSecret("generic-password", "drill db password");
const endpoint = { url: "https://nas.lan:9443", certFingerprint: `SHA256:${"AB".repeat(32)}` };
const NAME = "opscrew-shop-drill";

const SERVICES = [
  `name: ${NAME}`,
  "services:",
  "  db:",
  "    image: postgres",
  "    environment:",
  "      POSTGRES_PASSWORD: ${OPSCREW_DB_PASSWORD}",
  "  app:",
  "    image: app",
  "    profiles: [app]",
  "networks:",
  "  internal:",
  "    internal: true",
  "",
].join("\n");
const WITH_APP = SERVICES.replace(
  "    profiles: [app]\n",
  "    environment:\n      DATABASE_URL: ${DATABASE_URL}\n",
);

function desired(o: Partial<DesiredDrillStack> = {}): DesiredDrillStack {
  return {
    app: "shop",
    environmentId: 3,
    snapshot: "20261118T120000Z",
    services: SERVICES,
    withApp: WITH_APP,
    volumes: [`${NAME}_db_data`],
    external: ["opscrew-shop_snapshots"],
    ...o,
  };
}

interface Stack {
  Id: number;
  Name: string;
  Type: number;
  EndpointId: number;
  Status: number;
  Env: { name: string; value: string }[];
  DeploymentStatus: { Status: number; Message?: string; Time: number }[];
  GitConfig?: { URL: string; ReferenceName: string; ConfigFilePath: string };
}

/** A Portainer answering the drill's calls, with Docker's networks and containers through its proxy. */
function fake(o: { stacks?: Stack[]; volumes?: string[]; deploy?: number; message?: string } = {}) {
  const stacks: Stack[] = [...(o.stacks ?? [])];
  const volumes = [...(o.volumes ?? [])];
  const calls: string[] = [];
  const bodies: string[] = [];
  let next = 200;
  let time = 1_760_000_000;
  const json = (status: number, body?: unknown) => ({
    status,
    body: body === undefined ? "" : JSON.stringify(body),
  });
  const deployed = (stack: Stack) => {
    stack.Status = o.deploy ?? 1;
    stack.DeploymentStatus.push({
      Status: stack.Status,
      ...(o.message === undefined ? {} : { Message: o.message }),
      Time: ++time,
    });
  };
  const request: PinnedRequest = async (init: PinnedRequestInit) => {
    const path = new URL(`http://p${init.path}`).pathname;
    calls.push(`${init.method} ${path}`);
    if (init.body !== undefined) bodies.push(init.body);
    if (init.headers["X-API-Key"] !== TOKEN) return json(401, { message: "Unauthorized" });
    const body = init.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>);
    const id = Number(path.split("/")[3]);
    if (init.method === "GET" && path === "/api/stacks") return json(200, stacks);
    if (init.method === "GET" && /^\/api\/stacks\/\d+$/.test(path)) {
      const stack = stacks.find((each) => each.Id === id);
      return stack === undefined ? json(404, { message: "Not found" }) : json(200, stack);
    }
    if (init.method === "POST" && path === "/api/stacks/create/standalone/string") {
      const stack: Stack = {
        Id: ++next,
        Name: String(body.Name),
        Type: 2,
        EndpointId: 3,
        Status: 3,
        Env: body.Env as Stack["Env"],
        DeploymentStatus: [],
      };
      stacks.push(stack);
      volumes.push(`${stack.Name}_db_data`);
      deployed(stack);
      return json(200, stack);
    }
    if (init.method === "PUT" && /^\/api\/stacks\/\d+$/.test(path)) {
      const stack = stacks.find((each) => each.Id === id);
      if (stack === undefined) return json(404, { message: "Not found" });
      deployed(stack);
      return json(200, stack);
    }
    if (init.method === "DELETE" && /^\/api\/stacks\/\d+$/.test(path)) {
      const index = stacks.findIndex((each) => each.Id === id);
      if (index < 0) return json(404, { message: "Not found" });
      stacks.splice(index, 1);
      return json(204);
    }
    if (init.method === "GET" && path === "/api/endpoints/3/docker/volumes") {
      return json(200, { Volumes: volumes.map((Name) => ({ Name, Labels: {} })) });
    }
    if (init.method === "DELETE" && path.startsWith("/api/endpoints/3/docker/volumes/")) {
      const index = volumes.indexOf(decodeURIComponent(path.split("/").pop() ?? ""));
      if (index < 0) return json(404, { message: "No such volume" });
      volumes.splice(index, 1);
      return json(204);
    }
    if (init.method === "GET" && path === `/api/endpoints/3/docker/networks/${NAME}_internal`) {
      return json(200, { Name: `${NAME}_internal`, Internal: true, Containers: {} });
    }
    if (init.method === "GET" && path === "/api/endpoints/3/docker/containers/c1/json") {
      return json(200, {
        RestartCount: 0,
        State: {
          StartedAt: "2026-11-18T12:00:00Z",
          Status: "running",
          Health: { Status: "healthy" },
        },
        Config: { Env: [`POSTGRES_PASSWORD=${VALUE}`] },
      });
    }
    return json(404, { message: `no route ${init.method} ${path}` });
  };
  const client = portainerClient(endpoint, TOKEN, { request });
  return { client, stacks, volumes, calls, bodies };
}

const WAIT = { timeoutMs: 1000, intervalMs: 1, sleep: async () => undefined };
const ENV = { OPSCREW_DB_PASSWORD: VALUE, DATABASE_URL: `postgres://app:${VALUE}@db/app` };

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof OpsCrewError)) throw new Error(`expected an OpsCrewError, got ${error}`);
  return error;
}

describe("the Portainer client's reads for a drill", () => {
  it("reads a network's Internal flag and a container's state and health, never its Env", async () => {
    const { client } = fake();
    expect(await client.networkInspect(3, `${NAME}_internal`)).toEqual({
      name: `${NAME}_internal`,
      internal: true,
    });
    expect(await client.networkInspect(3, "opscrew-other_internal")).toBeUndefined();
    const inspected = await client.containerInspect(3, "c1");
    expect(inspected).toMatchObject({ state: "running", health: "healthy" });
    expect(JSON.stringify(inspected)).not.toContain(VALUE);
    await expect(client.networkInspect(3, "../x")).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("planDrillStack", () => {
  it("plans the drill's stack by its name, with its volumes, the snapshots volume only read", () => {
    const plan = planDrillStack({ stacks: [], volumes: [] }, desired());
    expect(drillStackName("shop")).toBe(NAME);
    expect(plan).toMatchObject({ purpose: "drill", app: "shop", environmentId: 3, findings: [] });
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      id: "drill-stack",
      state: "change",
      params: {
        action: "drill",
        name: NAME,
        snapshot: "20261118T120000Z",
        compose: SERVICES,
        withApp: WITH_APP,
        envKeys: ["DATABASE_URL", "OPSCREW_DB_PASSWORD"],
        volumes: [`${NAME}_db_data`],
        external: ["opscrew-shop_snapshots"],
      },
    });
    // The same input, the same hash; another snapshot, another.
    const again = planDrillStack({ stacks: [], volumes: [] }, desired());
    expect(stackPlanHash(again)).toBe(stackPlanHash(plan));
    const other = planDrillStack({ stacks: [], volumes: [] }, desired({ snapshot: "X1" }));
    expect(stackPlanHash(other)).not.toBe(stackPlanHash(plan));
  });

  it("refuses a file with a port or a network not cut off, and names that aren't the drill's", () => {
    const bad = [
      desired({ services: `${SERVICES}    ports: ["80:80"]\n` }),
      desired({ withApp: WITH_APP.replace("internal: true", "internal: false") }),
      desired({ volumes: ["opscrew-shop_db_data"] }),
      desired({ external: [`${NAME}_db_data`] }),
      desired({ external: ["other_snapshots"] }),
      desired({ snapshot: "../x" }),
    ];
    for (const input of bad) {
      expect(() => planDrillStack({ stacks: [], volumes: [] }, input)).toThrow(OpsCrewError);
    }
  });

  it("removes what an earlier drill left first, and blocks on a Git stack of the name", () => {
    const details = { id: 7, name: NAME, envKeys: [], deploymentStatus: [] };
    const plan = planDrillStack(
      {
        stacks: [details],
        volumes: [{ name: `${NAME}_db_data` }, { name: "opscrew-shop_db_data" }],
      },
      desired(),
    );
    expect(plan.changes[0]).toMatchObject({
      state: "change",
      title: `Remove what an earlier restore drill left: the stack ${NAME} and the volumes ${NAME}_db_data`,
      params: { action: "remove", name: NAME, stackId: 7, volumes: [`${NAME}_db_data`] },
    });
    const git = planDrillStack(
      {
        stacks: [{ ...details, gitConfig: { authenticated: false } }],
        volumes: [],
      },
      desired(),
    );
    expect(git.changes[0]?.state).toBe("blocked");
  });

  it("is never applied as another stack plan", async () => {
    const { client, calls } = fake();
    const plan = planDrillStack({ stacks: [], volumes: [] }, desired());
    const error = await failure(
      applyStackPlan(client, plan, { approvedHash: stackPlanHash(plan), secrets: { env: ENV } }),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(calls).toEqual([]);
  });
});

describe("the drill's stack calls", () => {
  it("creates the stack from the string, starts the app, removes it and proves it is gone", async () => {
    const leftover: Stack = {
      Id: 7,
      Name: NAME,
      Type: 2,
      EndpointId: 3,
      Status: 4,
      Env: [],
      DeploymentStatus: [],
    };
    const world = fake({
      stacks: [leftover],
      volumes: [`${NAME}_db_data`, "opscrew-shop_db_data", "opscrew-shop_snapshots"],
    });
    const plan = planDrillStack(
      {
        stacks: [{ id: 7, name: NAME, envKeys: [], deploymentStatus: [] }],
        volumes: [{ name: `${NAME}_db_data` }],
      },
      desired(),
    );
    const hash = stackPlanHash(plan);
    const created = await createDrillStack(world.client, plan, {
      approvedHash: hash,
      env: ENV,
      wait: WAIT,
    });
    expect(created).toEqual({ stackId: 201 });
    const create = world.bodies.find((body) => body.includes("StackFileContent")) ?? "";
    expect(JSON.parse(create)).toMatchObject({
      Name: NAME,
      StackFileContent: SERVICES,
      Env: [
        { name: "DATABASE_URL", value: ENV.DATABASE_URL },
        { name: "OPSCREW_DB_PASSWORD", value: VALUE },
      ],
    });
    expect(
      await startDrillApp(world.client, plan, 201, { approvedHash: hash, env: ENV, wait: WAIT }),
    ).toEqual({});
    expect(await removeDrillStack(world.client, plan, 201)).toEqual({ removed: true, left: [] });
    expect(world.volumes).toEqual(["opscrew-shop_db_data", "opscrew-shop_snapshots"]);
    // Nothing named opscrew-shop was touched: every change is the drill's.
    const changes = world.calls.filter((call) => !call.startsWith("GET "));
    expect(changes).toEqual([
      "DELETE /api/stacks/7",
      `DELETE /api/endpoints/3/docker/volumes/${NAME}_db_data`,
      "POST /api/stacks/create/standalone/string",
      "PUT /api/stacks/201",
      "DELETE /api/stacks/201",
      `DELETE /api/endpoints/3/docker/volumes/${NAME}_db_data`,
    ]);
  });

  it("refuses another hash and a missing value before any call, and returns a failed deploy", async () => {
    const world = fake({ deploy: 4, message: `pull access denied for ghcr.io/acme/shop ${VALUE}` });
    const plan = planDrillStack({ stacks: [], volumes: [] }, desired());
    const hash = stackPlanHash(plan);
    const other = await failure(
      createDrillStack(world.client, plan, { approvedHash: "a".repeat(64), env: ENV }),
    );
    expect(other.code).toBe("PLAN_HASH_MISMATCH");
    const missing = await failure(
      createDrillStack(world.client, plan, {
        approvedHash: hash,
        env: { OPSCREW_DB_PASSWORD: VALUE },
      }),
    );
    expect(missing.message).toContain("no value for DATABASE_URL");
    expect(world.calls).toEqual([]);
    const created = await createDrillStack(world.client, plan, {
      approvedHash: hash,
      env: ENV,
      wait: WAIT,
    });
    expect(created.stackId).toBe(201);
    expect(created.failure).toContain("pull access denied");
    expect(created.failure).not.toContain(VALUE);
  });

  it("says what is left when a removal fails", async () => {
    const world = fake();
    const plan = planDrillStack({ stacks: [], volumes: [] }, desired());
    await createDrillStack(world.client, plan, {
      approvedHash: stackPlanHash(plan),
      env: ENV,
      wait: WAIT,
    });
    world.volumes.push(`${NAME}_db_data`);
    const removal = await removeDrillStack(world.client, plan, 201);
    expect(removal).toEqual({ removed: false, left: [`${NAME}_db_data`] });
  });
});
