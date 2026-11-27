import type {
  ComputeCatalog,
  ProviderConnectorDeps,
  ProviderExtras,
  VpsConnector,
} from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import type { FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CREDENTIALS, CREDENTIALS_ENV, kamateraFetch, queued } from "./__fixtures__/fixtures";
import { POWER_COMMAND, SERVER_IDS, server, serverList, WORKER_ID } from "./__fixtures__/servers";
import { type KamateraConnector, kamateraConnector } from "./connector";

// Type-level check: the Kamatera connector satisfies the VPS connector contract.
const asVps = (c: KamateraConnector) => c satisfies VpsConnector;

/** Every value OpsCrew must never show: the API key and the servers' ids. */
const SECRETS = [...Object.values(CREDENTIALS), ...SERVER_IDS];

/** A stand-in for the price catalogue, which another module builds. */
function fakeCatalog(): ComputeCatalog {
  return {
    provider: "kamatera",
    listOffers: async () => [],
    extras: async (): Promise<ProviderExtras> => ({
      pricesIncludeVat: false,
      source: "static",
      asOf: "2026-11-22T00:00:00Z",
    }),
  };
}

/** One datacenter as `GET /service/server/options/datacenters` lists it. */
const datacenter = (id: string, region: string) => ({ id, region });

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string> = CREDENTIALS_ENV,
  extra: Partial<ProviderConnectorDeps> = {},
) {
  const fake = kamateraFetch(routes);
  const made: ProviderConnectorDeps[] = [];
  const waits: number[] = [];
  let time = Date.parse("2026-11-26T10:00:00Z");
  const c = kamateraConnector(
    {
      env,
      fetch: fake.fetch,
      sleep: async (ms) => {
        waits.push(ms);
        time += ms;
      },
      now: () => new Date(time),
      ...extra,
    },
    {
      catalog: (deps) => {
        made.push(deps);
        return fakeCatalog();
      },
    },
  );
  return { connector: c, calls: fake.calls, made, waits };
}

const paths = (calls: { method: string; path: string }[]) =>
  calls.map((call) => `${call.method} ${call.path}`);

describe("kamateraConnector", () => {
  it("describes the API key, that it can't be limited, and where to create it", () => {
    const { connector: c } = connector({});
    expect(c.id).toBe("kamatera");
    expect(c.displayName).toBe("Kamatera");
    expect(c.credentials).toEqual({
      envVars: ["KAMATERA_API_CLIENT_ID", "KAMATERA_API_SECRET"],
      description:
        "A Kamatera API key: its access key as KAMATERA_API_CLIENT_ID and its secret key as KAMATERA_API_SECRET, from API → Keys in Kamatera's console. A key can't be limited: it can do everything on your Kamatera account, so a separate Kamatera account for OpsCrew is the safest.",
      scopes: [],
      createUrl:
        "https://www.kamatera.com/knowledgebase/how-to-deploy-terraform-on-a-kamatera-vps/",
    });
  });

  it("is configured, with a server API, only with both values", () => {
    const full = asVps(connector({}).connector);
    expect(full.configured).toBe(true);
    expect(full.servers).toBeDefined();
    const { KAMATERA_API_SECRET: _, ...one } = CREDENTIALS_ENV;
    for (const env of [one, {}]) {
      const c = connector({}, env).connector;
      expect(c.configured).toBe(false);
      expect(c.servers).toBeUndefined();
    }
  });

  it("has no firewalls, backups or object storage", () => {
    const c = connector({}).connector;
    expect("firewalls" in c || "backups" in c || "objectStorage" in c).toBe(false);
  });

  it("registers both values with the redactor as it reads them", () => {
    const redactor = new Redactor();
    connector({}, CREDENTIALS_ENV, { redactor });
    for (const value of Object.values(CREDENTIALS)) {
      expect(redactor.redact(`value ${value}`)).not.toContain(value);
    }
  });

  it("makes the catalogue once, from its deps, with or without the values", async () => {
    for (const env of [CREDENTIALS_ENV, {}]) {
      const { connector: c, made, calls } = connector({}, env);
      const catalog = c.catalog();
      expect(c.catalog()).toBe(catalog);
      expect(made).toHaveLength(1);
      expect(made[0]?.env).toBe(env);
      expect(made[0]?.fetch).toBeDefined();
      expect(await catalog.listOffers()).toEqual([]);
      expect(calls).toEqual([]);
    }
  });

  it("reaches the account through its server API, with the injected clock and sleep", async () => {
    const {
      connector: c,
      calls,
      waits,
    } = connector({
      "GET /service/servers": serverList(
        server("shop"),
        server("shop-worker", { id: WORKER_ID, power: "off" }),
      ),
      "POST /service/server/poweron": POWER_COMMAND,
      "GET /service/queue": [queued("pending"), queued("complete")],
    });
    expect(await c.servers?.findAppServers("shop")).toEqual([
      { id: "shop", name: "shop", status: "on", nameOnly: true },
      { id: "shop-worker", name: "shop-worker", status: "off", nameOnly: true },
    ]);
    await c.servers?.powerOn("shop-worker");
    expect(waits).toEqual([2_000]);
    expect(paths(calls)).toContain("POST /service/server/poweron");
  });

  it("sends the key to the address KAMATERA_API_URL names", async () => {
    const base = "https://kamatera.example.test";
    const fake = kamateraFetch({ "GET /service/servers": serverList() }, base);
    const c = kamateraConnector(
      { env: { ...CREDENTIALS_ENV, KAMATERA_API_URL: base }, fetch: fake.fetch },
      { catalog: fakeCatalog },
    );
    await c.servers?.findAppServers("shop");
    expect(fake.calls.map((call) => call.url)).toEqual([`${base}/service/servers`]);
  });
});

describe("verifyCredentials", () => {
  it("names the missing value and calls nothing", async () => {
    const { connector: c, calls } = connector({}, { KAMATERA_API_CLIENT_ID: CREDENTIALS.clientId });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(
      /^KAMATERA_API_SECRET is not set: Kamatera needs both KAMATERA_API_CLIENT_ID and KAMATERA_API_SECRET\. /,
    );
    expect(calls).toEqual([]);
  });

  it("refuses an API address that isn't https:// before any call", async () => {
    const { connector: c, calls } = connector(
      {},
      { ...CREDENTIALS_ENV, KAMATERA_API_URL: "http://kamatera.example.test" },
    );
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("KAMATERA_API_URL must be an https:// address");
    expect(calls).toEqual([]);
  });

  it("reads the account's servers and its datacenters, and says what it found", async () => {
    const { connector: c, calls } = connector({
      "GET /service/servers": serverList(
        server("shop"),
        server("shop-worker", { id: WORKER_ID, power: "off" }),
      ),
      "GET /service/server/options/datacenters": {
        body: [
          datacenter("EU-FR", "Frankfurt"),
          datacenter("AS-SG", "Singapore"),
          datacenter("EU", "Amsterdam"),
        ],
      },
    });
    expect(await c.verifyCredentials()).toEqual({
      ok: true,
      message:
        "The Kamatera API key works: your Kamatera account has 2 servers, and its datacenters are AS-SG, EU and EU-FR.",
    });
    expect(paths(calls)).toEqual([
      "GET /service/servers",
      "GET /service/server/options/datacenters",
    ]);
  });

  it("counts one server, or none", async () => {
    for (const [servers, said] of [
      [[server("shop")], "1 server"],
      [[], "0 servers"],
    ] as const) {
      const { connector: c } = connector({
        "GET /service/servers": serverList(...servers),
        "GET /service/server/options/datacenters": { body: [datacenter("EU", "Amsterdam")] },
      });
      const check = await c.verifyCredentials();
      expect(check.message).toBe(
        `The Kamatera API key works: your Kamatera account has ${said}, and its datacenters are EU.`,
      );
    }
  });

  it("shows Kamatera's refusal in plain English", async () => {
    const { connector: c } = connector({
      "GET /service/servers": { status: 401, body: { message: "Authentication failed" } },
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("Kamatera refused the API key");
    expect(check.message).toContain("Authentication failed");
  });
});

describe("connector leaks", () => {
  it("puts no value in any check, even when Kamatera repeats one", async () => {
    const echo = `${CREDENTIALS.clientId} ${CREDENTIALS.secret}`;
    const datacenters = "GET /service/server/options/datacenters";
    const routes: Record<string, FakeReply>[] = [
      { "GET /service/servers": { status: 401, body: { message: echo } } },
      { "GET /service/servers": { status: 500, body: { message: echo } } },
      { "GET /service/servers": { error: new Error(echo) } },
      { "GET /service/servers": { body: { unexpected: echo } } },
      {
        "GET /service/servers": serverList(server("shop")),
        [datacenters]: { status: 500, body: { message: `${echo} ${SERVER_IDS[0]}` } },
      },
      {
        "GET /service/servers": serverList(server("shop")),
        [datacenters]: { body: [datacenter("EU", echo)] },
      },
    ];
    const checks = await Promise.all(
      routes.map((route) => connector(route).connector.verifyCredentials()),
    );
    expect(checks.map((check) => check.ok)).toEqual([false, false, false, false, false, true]);
    const text = JSON.stringify(checks);
    for (const value of SECRETS) expect(text).not.toContain(value);
  });
});
