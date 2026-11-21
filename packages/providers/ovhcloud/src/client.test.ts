import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  accessToken,
  apiError,
  CREDENTIALS,
  CREDENTIALS_ENV,
  fakeTime,
  ovhFetch,
  PROJECT,
  TOKEN,
  token,
} from "./__fixtures__/fixtures";
import {
  OVHCLOUD_API_URL,
  OVHCLOUD_ENV,
  OVHCLOUD_TOKEN_URL,
  OvhcloudClient,
  type OvhcloudPath,
  OvhcloudStatusError,
  readOvhcloudCredentials,
} from "./client";

/** Every value OpsCrew must never show: the three credentials and the access tokens. */
const SECRETS = [...Object.values(CREDENTIALS), accessToken("1"), accessToken("2")];

const project = z.looseObject({ project_id: z.string(), description: z.string() });
const acknowledged = z.looseObject({}).optional();

function setup(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { version?: string; timeoutMs?: number } = {},
) {
  const fake = ovhFetch(routes);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the values are registered when they are read.
  readOvhcloudCredentials(CREDENTIALS_ENV, redactor);
  const client = new OvhcloudClient({
    credentials: CREDENTIALS,
    redactor,
    fetch: fake.fetch,
    sleep: time.sleep,
    now: time.now,
    ...extra,
  });
  return { client, calls: fake.calls, time };
}

/** The error `promise` rejects with. */
async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const apiCalls = (calls: FakeCall[]) =>
  calls.filter((call) => call.url.startsWith(OVHCLOUD_API_URL));
const tokenCalls = (calls: FakeCall[]) =>
  calls.filter((call) => call.url.startsWith(OVHCLOUD_TOKEN_URL));

describe("readOvhcloudCredentials", () => {
  it("names the four variables", () => {
    expect(Object.values(OVHCLOUD_ENV)).toEqual([
      "OVH_ENDPOINT",
      "OVH_CLIENT_ID",
      "OVH_CLIENT_SECRET",
      "OVH_CLOUD_PROJECT_SERVICE",
    ]);
  });

  it("returns the values when all four are set, and registers each with the redactor", () => {
    const redactor = new Redactor();
    const read = readOvhcloudCredentials(CREDENTIALS_ENV, redactor);
    expect(read).toEqual({ credentials: CREDENTIALS });
    for (const value of Object.values(CREDENTIALS)) {
      expect(redactor.redact(`value ${value}`)).not.toContain(value);
    }
  });

  it("names each missing variable, registering the ones that are set", () => {
    const redactor = new Redactor();
    const read = readOvhcloudCredentials(
      {
        OVH_ENDPOINT: "ovh-eu",
        OVH_CLIENT_ID: CREDENTIALS.clientId,
        OVH_CLIENT_SECRET: " ",
      },
      redactor,
    );
    expect("credentials" in read).toBe(false);
    expect("problem" in read && read.problem).toMatch(
      /^OVH_CLIENT_SECRET and OVH_CLOUD_PROJECT_SERVICE are not set: OVHcloud needs all four\. /,
    );
    expect(redactor.redact(`id ${CREDENTIALS.clientId}`)).not.toContain(CREDENTIALS.clientId);
  });

  it("names OVH_ENDPOINT when it is missing", () => {
    const { OVH_ENDPOINT: _, ...rest } = CREDENTIALS_ENV;
    const read = readOvhcloudCredentials(rest, new Redactor());
    expect("problem" in read && read.problem).toMatch(/^OVH_ENDPOINT is not set: /);
  });

  it.each(["ovh-ca", "ovh-us", "kimsufi-eu", "OVH-EU"])(
    "refuses OVH_ENDPOINT=%s, naming ovh-eu, before any call",
    (endpoint) => {
      const read = readOvhcloudCredentials(
        { ...CREDENTIALS_ENV, OVH_ENDPOINT: endpoint },
        new Redactor(),
      );
      expect("credentials" in read).toBe(false);
      const problem = "problem" in read ? read.problem : "";
      expect(problem).toContain("OVH_ENDPOINT must be ovh-eu");
      expect(problem).not.toContain(endpoint);
    },
  );
});

describe("OvhcloudClient sign-in", () => {
  it("gets a client-credentials token with scope all, then sends it as a Bearer token", async () => {
    const { client, calls } = setup(
      {
        [`GET /v1/cloud/project/${PROJECT}`]: {
          body: { project_id: PROJECT, description: "shop" },
        },
      },
      { version: "1.2.3" },
    );
    const answer = await client.get(client.projectPath("v1"), project);
    expect(answer.description).toBe("shop");

    const [login, read] = calls;
    expect(login?.method).toBe("POST");
    expect(login?.url).toBe("https://auth.eu.ovhcloud.com/oauth2/token");
    expect(login?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(login?.body)))).toEqual({
      grant_type: "client_credentials",
      client_id: CREDENTIALS.clientId,
      client_secret: CREDENTIALS.clientSecret,
      scope: "all",
    });
    expect(read?.url).toBe(`https://api.eu.ovhcloud.com/v1/cloud/project/${PROJECT}`);
    expect(read?.headers.Authorization).toBe(`Bearer ${accessToken("1")}`);
    expect(read?.headers["User-Agent"]).toBe("opscrew/1.2.3");
  });

  it("keeps the token until it expires, then gets a new one", async () => {
    const { client, calls, time } = setup({
      [TOKEN]: [token("1", 300), token("2", 300)],
      "/v2/": { body: {} },
    });
    await client.get("/v2/publicCloud/project", acknowledged);
    await client.get("/v2/publicCloud/project", acknowledged);
    time.advance(271_000); // past the expiry, less the 30 seconds kept in hand
    await client.get("/v2/publicCloud/project", acknowledged);

    expect(tokenCalls(calls)).toHaveLength(2);
    expect(apiCalls(calls).map((call) => call.headers.Authorization)).toEqual([
      `Bearer ${accessToken("1")}`,
      `Bearer ${accessToken("1")}`,
      `Bearer ${accessToken("2")}`,
    ]);
  });

  it("gets a new token once on a 401 and sends the read again", async () => {
    const { client, calls } = setup({
      [TOKEN]: [token("1"), token("2")],
      "/v1/cloud/project": [
        apiError(401, { class: "Client::Unauthorized", message: "You must login first" }),
        { body: {} },
      ],
    });
    await client.get(client.projectPath("v1"), acknowledged);
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "POST", "GET"]);
    expect(apiCalls(calls).map((call) => call.headers.Authorization)).toEqual([
      `Bearer ${accessToken("1")}`,
      `Bearer ${accessToken("2")}`,
    ]);
  });

  it("stops with the variables named when the new token is refused too", async () => {
    const { client, calls } = setup({
      [TOKEN]: [token("1"), token("2")],
      "/v1/cloud/project": apiError(401, {
        class: "Client::Unauthorized",
        message: "You must login first",
      }),
    });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("You must login first");
    expect(error.hint).toContain("OVH_CLIENT_ID");
    expect(calls).toHaveLength(4);
  });

  it("names the service account's variables when the token endpoint refuses them", async () => {
    const { client, calls } = setup({
      [TOKEN]: {
        status: 401,
        body: { error: "invalid_client", error_description: "Client authentication failed" },
      },
    });
    const error = await failure(client.get(client.projectPath("v2"), acknowledged));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      "OVHcloud refused the service account: Client authentication failed",
    );
    expect(error.hint).toContain("OVH_CLIENT_ID and OVH_CLIENT_SECRET");
    expect(error.hint).toContain("control panel");
    expect(calls).toHaveLength(1);
  });

  it("refuses a token answer without an access token", async () => {
    const { client } = setup({ [TOKEN]: { body: { token_type: "Bearer" } } });
    const error = await failure(client.get(client.projectPath("v2"), acknowledged));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("without an access token");
  });

  it("says to check the connection when the token endpoint can't be reached", async () => {
    const { client } = setup({ [TOKEN]: { error: new Error("ECONNREFUSED") } });
    const error = await failure(client.get(client.projectPath("v2"), acknowledged));
    expect(error.message).toBe("Could not reach OVHcloud's sign-in (auth.eu.ovhcloud.com).");
    expect(error.hint).toBe("Check your internet connection and try again.");
  });

  it("says the sign-in did not answer in time when it times out", async () => {
    const { client } = setup({ [TOKEN]: { hang: true } }, { timeoutMs: 20 });
    const error = await failure(client.get(client.projectPath("v2"), acknowledged));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(
      /^OVHcloud's sign-in \(auth\.eu\.ovhcloud\.com\) did not answer within \d+ seconds?\.$/,
    );
    expect(error.hint).toBe("Try again in a few minutes.");
  });
});

describe("OvhcloudClient requests", () => {
  const instance = z.looseObject({ id: z.string(), name: z.string() });

  it("sends get, post, put and delete to the v1 and v2 bases and parses each answer", async () => {
    const v1: OvhcloudPath = `/v1/cloud/project/${PROJECT}/instance`;
    const v2: OvhcloudPath = `/v2/publicCloud/project/${PROJECT}/compute/instance`;
    const { client, calls } = setup({
      [`GET ${v1}`]: { body: [{ id: "i-1", name: "shop", future_field: true }] },
      [`POST ${v1}/i-1/snapshot`]: { body: {} },
      [`PUT ${v2}/i-1`]: { body: { id: "i-1", name: "shop" } },
      [`DELETE ${v1}/i-1`]: { status: 204 },
    });

    const listed = await client.get(v1, z.array(instance), { region: "GRA11" });
    expect(listed).toEqual([{ id: "i-1", name: "shop", future_field: true }]);
    await client.post(`${v1}/i-1/snapshot`, acknowledged, { snapshotName: "opscrew-shop" });
    expect(await client.put(`${v2}/i-1`, instance, { name: "shop" })).toEqual({
      id: "i-1",
      name: "shop",
    });
    await client.delete(`${v1}/i-1`, z.undefined());

    expect(apiCalls(calls).map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET https://api.eu.ovhcloud.com${v1}?region=GRA11`,
      `POST https://api.eu.ovhcloud.com${v1}/i-1/snapshot`,
      `PUT https://api.eu.ovhcloud.com${v2}/i-1`,
      `DELETE https://api.eu.ovhcloud.com${v1}/i-1`,
    ]);
    const [, post, put] = apiCalls(calls);
    expect(post?.body).toEqual({ snapshotName: "opscrew-shop" });
    expect(put?.body).toEqual({ name: "shop" });
  });

  it("names the project's paths under each base", () => {
    const { client } = setup({});
    expect(client.projectPath("v1")).toBe(`/v1/cloud/project/${PROJECT}`);
    expect(client.projectPath("v2")).toBe(`/v2/publicCloud/project/${PROJECT}`);
  });

  it("refuses an answer that doesn't match the caller's schema", async () => {
    const { client } = setup({ "/v1/": { body: [{ id: 7 }] } });
    const error = await failure(
      client.get(`/v1/cloud/project/${PROJECT}/instance`, z.array(instance)),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/^OVHcloud returned an unexpected answer for GET \/v1\//);
    expect(error.hint).toBe("The OVHcloud API may have changed; please report this to OpsCrew.");
  });

  it("refuses an answer that isn't JSON", async () => {
    const { client } = setup({ "/v1/": { text: "<html>" } });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.message).toMatch(/^OVHcloud returned invalid JSON for GET \/v1\//);
  });
});

describe("OvhcloudClient errors", () => {
  const create: OvhcloudPath = `/v2/publicCloud/project/${PROJECT}/compute/instance`;

  it("names the IAM action a missing right needs", async () => {
    const { client } = setup({
      [`POST ${create}`]: apiError(403, {
        class: "Client::Forbidden",
        message: "This call has not been granted",
        details: {
          unauthorizedActionsByIAM: "publicCloudProject:apiovh:instance/create",
        },
      }),
    });
    const error = await failure(client.post(create, acknowledged, { name: "shop" }));
    expect(error).toBeInstanceOf(OvhcloudStatusError);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain(
      "OVHcloud's IAM doesn't allow the service account to do publicCloudProject:apiovh:instance/create",
    );
    expect(error.hint).toContain(
      "Allow publicCloudProject:apiovh:instance/create in the IAM policy that names the service account and your Public Cloud project",
    );
    expect(error.hint).toContain("control panel");
  });

  it("names every action refused by IAM or by the sign-in", async () => {
    const { client } = setup({
      "/v1/": apiError(403, {
        message: "This call has not been granted",
        details: {
          unauthorizedActionsByAuthentication: "publicCloudProject:apiovh:get",
          unauthorizedActionsByIAM: "publicCloudProject:apiovh:instance/get",
        },
      }),
    });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.message).toContain(
      "publicCloudProject:apiovh:get and publicCloudProject:apiovh:instance/get",
    );
  });

  it("says what to check after a 403 without the actions", async () => {
    const { client } = setup({
      "/v1/": apiError(403, { class: "Client::Forbidden", message: "Forbidden" }),
    });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Forbidden");
    expect(error.hint).toContain("IAM policy");
  });

  it.each(["v1", "v2"] as const)(
    "says to check OVH_CLOUD_PROJECT_SERVICE after a 404 on the %s project",
    async (api) => {
      const { client } = setup({
        "/": apiError(404, {
          class: "Client::NotFound",
          message: `This service does not exist: ${PROJECT}`,
        }),
      });
      const error = await failure(client.get(client.projectPath(api), acknowledged));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toContain("OVHcloud found no Public Cloud project");
      expect(error.hint).toContain("OVH_CLOUD_PROJECT_SERVICE");
      expect(error.hint).toContain("your Public Cloud project's id");
    },
  );

  it("says a 404 below the project may be a deleted resource, or the project id", async () => {
    const { client } = setup({
      "/": apiError(404, { class: "Client::NotFound", message: "Instance not found" }),
    });
    const error = await failure(
      client.get(`/v1/cloud/project/${PROJECT}/instance/i-1`, acknowledged),
    );
    expect(error).toBeInstanceOf(OvhcloudStatusError);
    expect((error as OvhcloudStatusError).status).toBe(404);
    expect(error.message).toContain("Instance not found");
    expect(error.hint).toContain("may have been deleted");
    expect(error.hint).toContain("OVH_CLOUD_PROJECT_SERVICE");
  });

  it("waits for Retry-After and repeats a read once after a 429", async () => {
    const { client, calls, time } = setup({
      "/v1/": [
        apiError(429, { message: "Too many requests" }, { "Retry-After": "3" }),
        { body: {} },
      ],
    });
    await client.get(client.projectPath("v1"), acknowledged);
    expect(apiCalls(calls)).toHaveLength(2);
    expect(time.waits).toEqual([3000]);
  });

  it("reads Retry-After as a date too", async () => {
    const { client, time } = setup({
      "/v1/": [
        apiError(
          429,
          { message: "Too many requests" },
          { "Retry-After": new Date(Date.parse("2026-11-21T10:00:05Z")).toUTCString() },
        ),
        { body: {} },
      ],
    });
    await client.get(client.projectPath("v1"), acknowledged);
    expect(time.waits).toEqual([5000]);
  });

  it("stops after a second 429 on a read, saying to wait", async () => {
    const { client, calls } = setup({
      "/v1/": apiError(429, { message: "Too many requests" }, { "Retry-After": "1" }),
    });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.message).toContain("OVHcloud's rate limit was reached");
    expect(error.hint).toBe("Wait a minute and try again.");
    expect(apiCalls(calls)).toHaveLength(2);
  });

  it.each<[string, Record<string, string>, number]>([
    ["waits at most a minute", { "Retry-After": "600" }, 60_000],
    ["waits 2 seconds without Retry-After", {}, 2_000],
  ])("%s before repeating a read after a 429", async (_, headers, wait) => {
    const { client, time } = setup({
      "/v1/": [apiError(429, { message: "Too many requests" }, headers), { body: {} }],
    });
    await client.get(client.projectPath("v1"), acknowledged);
    expect(time.waits).toEqual([wait]);
  });

  it("maps other statuses to plain English with the next step", async () => {
    const cases: [number, RegExp][] = [
      [400, /refused the request as sent/],
      [409, /another change is still running/],
      [500, /failed on its side/],
    ];
    for (const [status, hint] of cases) {
      const { client } = setup({
        "/v1/": apiError(status, { message: `OVHcloud says ${status}` }),
      });
      const error = await failure(client.get(client.projectPath("v1"), acknowledged));
      expect(error.code).toBe("PROVIDER_ERROR");
      expect(error.message).toBe(
        `OVHcloud answered HTTP ${status} to GET /v1/cloud/project/[REDACTED:OVH_CLOUD_PROJECT_SERVICE]: OVHcloud says ${status}`,
      );
      expect(error.hint).toMatch(hint);
    }
  });

  it("shows the class when the message is empty", async () => {
    const { client } = setup({
      "/v1/": apiError(400, { class: "Client::BadRequest", message: "" }),
    });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.message).toMatch(/: Client::BadRequest$/);
  });
});

describe("OvhcloudClient never sends a post twice", () => {
  const snapshot: OvhcloudPath = `/v1/cloud/project/${PROJECT}/instance/i-1/snapshot`;
  const posts = (calls: FakeCall[]) => apiCalls(calls).filter((call) => call.method === "POST");

  it.each<[string, FakeReply]>([
    ["a 429", apiError(429, { message: "Too many requests" }, { "Retry-After": "1" })],
    ["a 500", apiError(500, { message: "Internal server error" })],
    ["a 503", apiError(503, { message: "Service unavailable" })],
    ["a 401", apiError(401, { class: "Client::Unauthorized", message: "You must login first" })],
  ])("sends it once after %s", async (_, reply) => {
    const { client, calls } = setup({ [TOKEN]: [token("1"), token("2")], [snapshot]: reply });
    await failure(client.post(snapshot, acknowledged, { snapshotName: "opscrew-shop" }));
    expect(posts(calls)).toHaveLength(1);
  });

  it("gets a new token for the next request after a post's 401", async () => {
    const { client, calls } = setup({
      [TOKEN]: [token("1"), token("2")],
      [`POST ${snapshot}`]: apiError(401, { message: "You must login first" }),
      "GET /v1/": { body: {} },
    });
    const error = await failure(client.post(snapshot, acknowledged, {}));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("You must login first");
    expect(error.hint).toMatch(
      /^OVHcloud refused the access token, so nothing was changed\. Run the command again; only if it fails the same way, /,
    );
    expect(error.hint).toContain("create a service account");
    await client.get(client.projectPath("v1"), acknowledged);
    expect(apiCalls(calls).map((call) => call.headers.Authorization)).toEqual([
      `Bearer ${accessToken("1")}`,
      `Bearer ${accessToken("2")}`,
    ]);
  });

  it("sends it once after no answer, saying it may have been made", async () => {
    const { client, calls } = setup({ [snapshot]: { hang: true } }, { timeoutMs: 20 });
    const error = await failure(client.post(snapshot, acknowledged, {}));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toContain("did not answer within");
    expect(error.hint).toContain("may still have been made");
    expect(posts(calls)).toHaveLength(1);
  });

  it("says to check the connection after a read that got no answer", async () => {
    const { client } = setup({ "/v1/": { error: new Error("socket hang up") } });
    const error = await failure(client.get(client.projectPath("v1"), acknowledged));
    expect(error.message).toMatch(/^Lost the connection to OVHcloud's API \(GET \/v1\//);
    expect(error.hint).toBe("Check your internet connection and try again.");
  });
});

describe("OvhcloudClient leaks", () => {
  it("puts no value in any error, even when OVHcloud repeats one, nor in the API's requests", async () => {
    const echo = (status: number) =>
      apiError(status, {
        class: "Client::Echo",
        message: `bad ${CREDENTIALS.clientId} ${CREDENTIALS.clientSecret} ${accessToken("1")} in ${PROJECT}`,
        details: { unauthorizedActionsByIAM: `publicCloudProject:apiovh:get on ${PROJECT}` },
      });
    const failing: Record<string, FakeReply>[] = [
      {
        [TOKEN]: {
          status: 401,
          body: { error: "invalid_client", error_description: `${CREDENTIALS.clientSecret}?` },
        },
      },
      { [TOKEN]: { status: 500, text: `oops ${CREDENTIALS.clientId}` } },
      { [TOKEN]: { error: new Error(`refused ${CREDENTIALS.clientSecret}`) } },
      ...[400, 401, 403, 404, 409, 429, 500].map((status) => ({ "/v1/": echo(status) })),
      { "/v1/": { error: new Error(`lost ${PROJECT}`) } },
      { "/v1/": { body: { unexpected: PROJECT } } },
    ];
    const errors: OpsCrewError[] = [];
    const requests: FakeCall[] = [];
    for (const routes of failing) {
      const { client, calls } = setup(routes);
      errors.push(await failure(client.get(client.projectPath("v1"), z.array(z.unknown()))));
      errors.push(await failure(client.post(`${client.projectPath("v1")}/x`, z.never(), {})));
      requests.push(...calls);
    }

    for (const error of errors) {
      const text = `${error.message} ${error.hint ?? ""} ${String(error.cause ?? "")}`;
      for (const value of SECRETS) expect(text).not.toContain(value);
    }
    // The credentials go only to the token endpoint, the tokens only to the API.
    const api = JSON.stringify(apiCalls(requests));
    expect(api).not.toContain(CREDENTIALS.clientId);
    expect(api).not.toContain(CREDENTIALS.clientSecret);
    const signIn = JSON.stringify(tokenCalls(requests));
    expect(signIn).not.toContain(PROJECT);
    expect(signIn).not.toContain(accessToken("1"));
  });
});
