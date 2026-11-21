import type { ComputeCatalog, VpsConnector } from "@opscrew/contracts";
import { Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  accessToken,
  apiError,
  CREDENTIALS,
  CREDENTIALS_ENV,
  ovhFetch,
  PROJECT,
} from "./__fixtures__/fixtures";
import { instance, project, region, SERVER, V2 } from "./__fixtures__/servers";
import { OVHCLOUD_API_URL, type OvhcloudClient } from "./client";
import { type OvhcloudConnector, ovhcloudConnector } from "./connector";

// Type-level check: the connector is a VPS connector but for its id, which joins `ProviderId`
// with the provider's other ids.
const asVps = (c: OvhcloudConnector) => c satisfies Omit<VpsConnector, "id">;

/** Every value OpsCrew must never show: the three credentials and the access token. */
const SECRETS = [...Object.values(CREDENTIALS), accessToken("1")];

function connector(
  routes: Record<string, FakeReply | FakeReply[]>,
  env: Record<string, string> = CREDENTIALS_ENV,
  redactor?: Redactor,
) {
  const fake = ovhFetch(routes);
  const built: (OvhcloudClient | undefined)[] = [];
  // Only the catalogue's identity matters here; its prices are the catalogue's own tests'.
  const catalog = {} as ComputeCatalog;
  return {
    connector: ovhcloudConnector(
      { env, fetch: fake.fetch, sleep: async () => {}, ...(redactor ? { redactor } : {}) },
      {
        catalog: (client) => {
          built.push(client);
          return catalog;
        },
      },
    ),
    calls: fake.calls,
    built,
    catalog,
  };
}

const apiCalls = (calls: FakeCall[]) =>
  calls.filter((call) => call.url.startsWith(OVHCLOUD_API_URL)).map((call) => call.path);

describe("ovhcloudConnector", () => {
  it("describes the four values and where to create the service account", () => {
    const { connector: c } = connector({});
    expect(c.id).toBe("ovhcloud");
    expect(c.displayName).toBe("OVHcloud");
    expect(c.credentials).toMatchObject({
      envVars: ["OVH_ENDPOINT", "OVH_CLIENT_ID", "OVH_CLIENT_SECRET", "OVH_CLOUD_PROJECT_SERVICE"],
      scopes: [],
      createUrl:
        "https://docs.ovhcloud.com/en/guides/manage-and-operate/api/manage-service-account",
    });
    expect(c.credentials.description).toContain("IAM policy");
    expect(c.credentials.description).toContain("your Public Cloud project");
  });

  it("is configured, with a server API, only with all four values and ovh-eu", () => {
    const full = asVps(connector({}).connector);
    expect(full.configured).toBe(true);
    expect(full.servers).toBeDefined();
    const { OVH_CLIENT_SECRET: _, ...three } = CREDENTIALS_ENV;
    for (const env of [three, { ...CREDENTIALS_ENV, OVH_ENDPOINT: "ovh-ca" }]) {
      const c = connector({}, env).connector;
      expect(c.configured).toBe(false);
      expect(c.servers).toBeUndefined();
    }
  });

  it("has no firewalls, backups or object storage: Terraform manages the security group", () => {
    const c = connector({}).connector;
    expect("firewalls" in c || "backups" in c || "objectStorage" in c).toBe(false);
  });

  it("registers every value with the redactor as it reads it", () => {
    const redactor = new Redactor();
    connector({}, CREDENTIALS_ENV, redactor);
    for (const value of Object.values(CREDENTIALS)) {
      expect(redactor.redact(`value ${value}`)).not.toContain(value);
    }
  });

  it("builds the catalogue once, from the client when the values are set", () => {
    const set = connector({});
    expect(set.connector.catalog()).toBe(set.catalog);
    expect(set.connector.catalog()).toBe(set.catalog);
    expect(set.built).toHaveLength(1);
    expect(set.built[0]).toBeDefined();

    const unset = connector({}, {});
    expect(unset.connector.catalog()).toBe(unset.catalog);
    expect(unset.built).toEqual([undefined]);
  });

  it("reaches the project through the server API it gives", async () => {
    const { connector: c, calls } = connector({
      [`GET ${V2}/compute/instance`]: { body: [instance()] },
    });
    expect(await c.servers?.findAppServers("shop")).toEqual([
      { id: SERVER, name: "shop", status: "ACTIVE", nameOnly: true },
    ]);
    expect(apiCalls(calls)).toEqual([`${V2}/compute/instance?name=shop`]);
  });
});

describe("verifyCredentials", () => {
  it("names the missing values and calls nothing", async () => {
    const { connector: c, calls } = connector(
      {},
      { OVH_ENDPOINT: "ovh-eu", OVH_CLIENT_ID: CREDENTIALS.clientId },
    );
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(
      /^OVH_CLIENT_SECRET and OVH_CLOUD_PROJECT_SERVICE are not set: OVHcloud needs all four\. /,
    );
    expect(check.message).toContain("manage-service-account");
    expect(calls).toEqual([]);
  });

  it("refuses an endpoint other than ovh-eu before any call", async () => {
    const { connector: c, calls } = connector({}, { ...CREDENTIALS_ENV, OVH_ENDPOINT: "ovh-us" });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("OVH_ENDPOINT must be ovh-eu");
    expect(calls).toEqual([]);
  });

  it("reads the project and lists its activated regions, with where to activate another", async () => {
    const { connector: c, calls } = connector({
      [`GET ${V2}/reference/region`]: {
        body: [
          region("WAW1", true),
          region("BHS5", false),
          region("GRA11", true),
          region("DE1", true),
          region("SGP1", false),
        ],
      },
      [`GET ${V2}`]: { body: project("shop-prod") },
    });
    const check = await c.verifyCredentials();
    expect(check).toEqual({
      ok: true,
      identity: "shop-prod",
      message:
        'The OVHcloud service account works with your Public Cloud project "shop-prod". Regions activated on it: DE1, GRA11 and WAW1. To activate another, open your project under Public Cloud in the control panel, then Quota & Regions under Settings.',
    });
    expect(apiCalls(calls)).toEqual([V2, `${V2}/reference/region`]);
  });

  it("says so when no region is activated", async () => {
    const { connector: c } = connector({
      [`GET ${V2}/reference/region`]: { body: [region("GRA11", false)] },
      [`GET ${V2}`]: { body: project("shop-prod") },
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(true);
    expect(check.message).toContain("No region is activated on it yet.");
    expect(check.message).toContain("Quota & Regions");
  });

  it("names the project plainly when it has no name", async () => {
    const { connector: c } = connector({
      [`GET ${V2}/reference/region`]: { body: [region("GRA11", true)] },
      [`GET ${V2}`]: { body: { ...project(null), currentState: { mode: "CLASSIC" } } },
    });
    const check = await c.verifyCredentials();
    expect(check.identity).toBeUndefined();
    expect(check.message).toMatch(
      /^The OVHcloud service account works with your Public Cloud project\. /,
    );
  });

  it("shows OVHcloud's refusal in plain English, with the IAM action to allow", async () => {
    const { connector: c } = connector({
      [`GET ${V2}`]: apiError(403, {
        class: "Client::Forbidden",
        message: "This call has not been granted",
        details: { unauthorizedActionsByIAM: "publicCloudProject:apiovh:get" },
      }),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("publicCloudProject:apiovh:get");
    expect(check.message).toContain("IAM policy");
  });

  it("says to check the project's id when OVHcloud has no such project", async () => {
    const { connector: c } = connector({
      [`GET ${V2}`]: apiError(404, {
        class: "Client::NotFound",
        message: `This service does not exist: ${PROJECT}`,
      }),
    });
    const check = await c.verifyCredentials();
    expect(check.ok).toBe(false);
    expect(check.message).toContain("OVH_CLOUD_PROJECT_SERVICE");
  });
});

describe("connector leaks", () => {
  it("puts no value in any check, even when OVHcloud repeats one", async () => {
    const echo = `${CREDENTIALS.clientId} ${CREDENTIALS.clientSecret} ${accessToken("1")} ${PROJECT}`;
    const checks = await Promise.all(
      [
        { [`GET ${V2}`]: apiError(403, { message: echo }) },
        { [`GET ${V2}`]: apiError(500, { message: echo }) },
        { [`GET ${V2}`]: { error: new Error(echo) } },
        { [`GET ${V2}`]: { body: { unexpected: echo } } },
        {
          [`GET ${V2}/reference/region`]: { body: [region(PROJECT, true)] },
          [`GET ${V2}`]: { body: project(PROJECT) },
        },
      ].map((routes) => connector(routes).connector.verifyCredentials()),
    );
    expect(checks.map((check) => check.ok)).toEqual([false, false, false, false, true]);
    const text = JSON.stringify(checks);
    for (const value of SECRETS) expect(text).not.toContain(value);
  });
});
