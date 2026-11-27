import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, Redactor } from "@opscrew/core";
import type { FakeCall, FakeReply } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CREDENTIALS,
  CREDENTIALS_ENV,
  fakeTime,
  kamateraFetch,
  proxyError,
  queued,
  refused,
} from "./__fixtures__/fixtures";
import {
  KAMATERA_API_URL,
  KAMATERA_ENV,
  KamateraClient,
  KamateraStatusError,
  readKamateraCredentials,
} from "./client";

/** Every value OpsCrew must never show. */
const SECRETS = Object.values(CREDENTIALS);

const servers = z.array(z.looseObject({ id: z.string(), name: z.string() }));
const WAIT = { what: "power the server off", timeoutMs: 10 * 60_000 };

function setup(
  routes: Record<string, FakeReply | FakeReply[]>,
  extra: { apiUrl?: string; version?: string; timeoutMs?: number } = {},
) {
  const fake = kamateraFetch(routes, extra.apiUrl);
  const time = fakeTime();
  const redactor = new Redactor();
  // As the connector does: the values are registered when they are read.
  readKamateraCredentials(CREDENTIALS_ENV, redactor);
  const client = new KamateraClient({
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

const errorText = (error: OpsCrewError) =>
  `${error.message} ${error.hint ?? ""} ${String(error.cause ?? "")}`;

describe("readKamateraCredentials", () => {
  it("names the two variables", () => {
    expect(Object.values(KAMATERA_ENV)).toEqual(["KAMATERA_API_CLIENT_ID", "KAMATERA_API_SECRET"]);
  });

  it("returns both values and the default API, registering each value with the redactor", () => {
    const redactor = new Redactor();
    const read = readKamateraCredentials(CREDENTIALS_ENV, redactor);
    expect(read).toEqual({ credentials: CREDENTIALS, apiUrl: KAMATERA_API_URL });
    for (const value of SECRETS) {
      expect(redactor.redact(`value ${value}`)).not.toContain(value);
    }
  });

  it("names a missing or blank variable, registering the one that is set", () => {
    const redactor = new Redactor();
    const read = readKamateraCredentials(
      { KAMATERA_API_CLIENT_ID: CREDENTIALS.clientId, KAMATERA_API_SECRET: " " },
      redactor,
    );
    expect("credentials" in read).toBe(false);
    expect("problem" in read && read.problem).toMatch(
      /^KAMATERA_API_SECRET is not set: Kamatera needs both KAMATERA_API_CLIENT_ID and KAMATERA_API_SECRET\. /,
    );
    expect(redactor.redact(`id ${CREDENTIALS.clientId}`)).not.toContain(CREDENTIALS.clientId);
  });

  it("names both when neither is set", () => {
    const read = readKamateraCredentials({}, new Redactor());
    expect("problem" in read && read.problem).toMatch(
      /^KAMATERA_API_CLIENT_ID and KAMATERA_API_SECRET are not set: .*Kamatera's console/,
    );
  });

  it("takes KAMATERA_API_URL as the base, without a trailing slash", () => {
    const read = readKamateraCredentials(
      { ...CREDENTIALS_ENV, KAMATERA_API_URL: " https://kamatera.example.test/api/ " },
      new Redactor(),
    );
    expect(read).toEqual({
      credentials: CREDENTIALS,
      apiUrl: "https://kamatera.example.test/api",
    });
  });

  it.each(["http://cloudcli.cloudwm.com", "cloudcli.cloudwm.com", "not a url"])(
    "refuses KAMATERA_API_URL=%s, which would send the key unencrypted or nowhere",
    (url) => {
      const read = readKamateraCredentials(
        { ...CREDENTIALS_ENV, KAMATERA_API_URL: url },
        new Redactor(),
      );
      expect("credentials" in read).toBe(false);
      expect("problem" in read && read.problem).toMatch(
        /^KAMATERA_API_URL must be an https:\/\/ address\. /,
      );
    },
  );
});

describe("KamateraClient requests", () => {
  it("sends AuthClientId and AuthSecret on every call and parses each answer with the caller's schema", async () => {
    const { client, calls } = setup(
      {
        "GET /service/servers": { body: [{ id: "s-1", name: "opscrew-shop-ab12", power: "on" }] },
        "POST /service/server/info": { body: [{ id: "s-1", name: "opscrew-shop-ab12" }] },
      },
      { version: "9.9.9" },
    );

    await expect(client.get("/service/servers", servers)).resolves.toEqual([
      { id: "s-1", name: "opscrew-shop-ab12", power: "on" },
    ]);
    await expect(
      client.post("/service/server/info", servers, { name: "opscrew-shop-ab12" }),
    ).resolves.toEqual([{ id: "s-1", name: "opscrew-shop-ab12" }]);

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      `GET ${KAMATERA_API_URL}/service/servers`,
      `POST ${KAMATERA_API_URL}/service/server/info`,
    ]);
    for (const call of calls) {
      expect(call.headers).toMatchObject({
        AuthClientId: CREDENTIALS.clientId,
        AuthSecret: CREDENTIALS.secret,
        Accept: "application/json",
        "User-Agent": "opscrew/9.9.9",
      });
    }
    expect(calls[1]?.headers["Content-Type"]).toBe("application/json");
    expect(calls[1]?.body).toEqual({ name: "opscrew-shop-ab12" });
  });

  it("sends a read's query", async () => {
    const { client, calls } = setup({ "GET /service/server": { body: [] } });
    await client.get("/service/server", z.array(z.unknown()), { images: "1", datacenter: "EU" });
    expect(calls[0]?.path).toBe("/service/server?images=1&datacenter=EU");
  });

  it("sends every call to the base KAMATERA_API_URL set", async () => {
    const apiUrl = "https://kamatera.example.test/api";
    const { client, calls } = setup({ "GET /service/servers": { body: [] } }, { apiUrl });
    await client.get("/service/servers", servers);
    expect(calls[0]?.url).toBe(`${apiUrl}/service/servers`);
  });

  it("refuses an answer that doesn't match the caller's schema", async () => {
    const { client } = setup({ "GET /service/servers": { body: { servers: [] } } });
    const error = await failure(client.get("/service/servers", servers));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(
      /^Kamatera returned an unexpected answer for GET \/service\/servers: /,
    );
    expect(error.hint).toBe("The Kamatera API may have changed; please report this to OpsCrew.");
  });

  it("refuses an answer that isn't JSON", async () => {
    const { client } = setup({ "GET /service/servers": { text: "<html>" } });
    const error = await failure(client.get("/service/servers", servers));
    expect(error.message).toBe("Kamatera returned invalid JSON for GET /service/servers.");
  });
});

describe("KamateraClient queued commands", () => {
  it("posts the command and waits through GET /service/queue?id= until it is complete", async () => {
    const { client, calls, time } = setup({
      "POST /service/server/poweroff": { body: ["4242"] },
      "GET /service/queue": [queued("pending"), queued("running"), queued("complete", "Done.")],
    });

    const command = await client.command("/service/server/poweroff", { name: "x" }, WAIT);

    expect(command).toMatchObject({ status: "complete", log: "Done." });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /service/server/poweroff",
      "GET /service/queue?id=4242",
      "GET /service/queue?id=4242",
      "GET /service/queue?id=4242",
    ]);
    for (const call of calls) expect(call.headers.AuthSecret).toBe(CREDENTIALS.secret);
    expect(time.waits).toEqual([2000, 2000]);
  });

  it.each([
    ["a bare number", 4242],
    ["a list of one number", [4242]],
    ["a list of one string", ["4242"]],
  ])("takes the command's id as %s", async (_, body) => {
    const { client, calls } = setup({
      "POST /service/server/reboot": { body },
      "GET /service/queue": queued("complete"),
    });
    await client.command("/service/server/reboot", { name: "x" }, WAIT);
    expect(calls[1]?.path).toBe("/service/queue?id=4242");
  });

  it.each([[[]], [["1", "2"]], [{ status: "ok" }], [""]])(
    "refuses a command answer without one id (%j)",
    async (body) => {
      const { client, calls } = setup({ "POST /service/server/reboot": { body } });
      const error = await failure(client.command("/service/server/reboot", { name: "x" }, WAIT));
      expect(error.message).toMatch(
        /^Kamatera returned an unexpected answer for POST \/service\/server\/reboot: /,
      );
      expect(calls).toHaveLength(1);
    },
  );

  it("keeps waiting while the queue doesn't list the command yet", async () => {
    const { client } = setup({
      "POST /service/server/reboot": { body: ["4242"] },
      "GET /service/queue": [{ body: [] }, queued("complete")],
    });
    await expect(
      client.command("/service/server/reboot", { name: "x" }, WAIT),
    ).resolves.toMatchObject({ status: "complete" });
  });

  it("fails a command whose status is error without its log, which may hold a password", async () => {
    const { client } = setup({
      "POST /service/server/poweroff": { body: ["4242"] },
      "GET /service/queue": [
        queued("pending"),
        queued("error", `  root password Zq9-fake-pass 203.0.113.7 key ${CREDENTIALS.secret}  `),
      ],
    });
    const error = await failure(client.command("/service/server/poweroff", { name: "x" }, WAIT));
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe("Kamatera's command to power the server off failed.");
    expect(error.hint).toBe(
      "Read the command's log in your Kamatera account's console (the server's tasks), fix what it names, then try again.",
    );
    for (const value of ["Zq9-fake-pass", "203.0.113.7", CREDENTIALS.secret]) {
      expect(errorText(error)).not.toContain(value);
    }
  });

  it("says the same for a failed command with no log", async () => {
    const { client } = setup({
      "POST /service/server/poweroff": { body: ["4242"] },
      "GET /service/queue": { body: [{ id: 4242, status: "error", log: null }] },
    });
    const error = await failure(client.command("/service/server/poweroff", { name: "x" }, WAIT));
    expect(error.message).toBe("Kamatera's command to power the server off failed.");
  });

  it("stops at the timeout with a plain message, never waiting past it", async () => {
    const { client, calls, time } = setup({
      "POST /service/server/poweroff": { body: ["4242"] },
      "GET /service/queue": queued("pending"),
    });
    const error = await failure(
      client.command("/service/server/poweroff", { name: "x" }, { ...WAIT, timeoutMs: 5_000 }),
    );
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Kamatera's command to power the server off did not finish within 5 seconds.",
    );
    expect(error.hint).toBe(
      "It may still finish: check the server in your Kamatera account's console before trying again.",
    );
    expect(time.waits).toEqual([2000, 2000, 1000]);
    expect(calls.filter((call) => call.path.startsWith("/service/queue"))).toHaveLength(4);
  });
});

describe("KamateraClient errors", () => {
  it("says what Kamatera refused from a 500's message holding errors[].info", async () => {
    const { client } = setup({
      "POST /service/server/configure": refused(
        "Value expected to be 'number', 'string' given.",
        "Disk too small.",
      ),
    });
    const error = await failure(client.post("/service/server/configure", z.unknown(), {}));
    expect(error).toBeInstanceOf(KamateraStatusError);
    expect((error as KamateraStatusError).status).toBe(500);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toBe(
      "Kamatera refused POST /service/server/configure: Value expected to be 'number', 'string' given. Disk too small.",
    );
    expect(error.hint).toBe(
      "Fix what Kamatera named above, then try again. If it names nothing you can change, check your Kamatera account in its console, or contact Kamatera's support.",
    );
  });

  it("reads errors[].info at the body's top level too", async () => {
    const { client } = setup({
      "GET /service/servers": {
        status: 500,
        body: { errors: [{ code: 7, info: "Datacenter not found.", category: "General Error" }] },
      },
    });
    const error = await failure(client.get("/service/servers", servers));
    expect(error.message).toBe("Kamatera refused GET /service/servers: Datacenter not found.");
  });

  it("shows a 500's plain message", async () => {
    const { client } = setup({
      "POST /service/server/info": {
        status: 500,
        body: { message: "No servers found (name='opscrew-shop-ab12')" },
      },
    });
    const error = await failure(client.post("/service/server/info", servers, {}));
    expect(error.message).toBe(
      "Kamatera refused POST /service/server/info: No servers found (name='opscrew-shop-ab12')",
    );
  });

  it("says a 404 is a server or a route Kamatera didn't find", async () => {
    const { client } = setup({ "POST /service/server/info": proxyError(404, "Not Found") });
    const error = await failure(client.post("/service/server/info", servers, {}));
    expect((error as KamateraStatusError).status).toBe(404);
    expect(error.message).toBe(
      "Kamatera found no such server or route (POST /service/server/info): Not Found",
    );
    expect(error.hint).toBe(
      "The server may have been removed: check your Kamatera account in its console.",
    );
  });

  it("names KAMATERA_API_URL in a 404's hint when it is set", async () => {
    const { client } = setup(
      { "GET /service/servers": proxyError(404, "Not Found") },
      { apiUrl: "https://kamatera.example.test" },
    );
    const error = await failure(client.get("/service/servers", servers));
    expect(error.hint).toBe(
      "The server may have been removed: check your Kamatera account in its console. If every request fails this way, check KAMATERA_API_URL, or unset it to use https://cloudcli.cloudwm.com.",
    );
  });

  it("names the variables when Kamatera refuses the key", async () => {
    const { client } = setup({ "GET /service/servers": proxyError(401, "Unauthorized") });
    const error = await failure(client.get("/service/servers", servers));
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toBe(
      "Kamatera refused the API key (HTTP 401, GET /service/servers): Unauthorized",
    );
    expect(error.hint).toMatch(/KAMATERA_API_CLIENT_ID.*KAMATERA_API_SECRET/);
  });

  it("says Kamatera failed on its side when a 500 has no message", async () => {
    const { client } = setup({
      "/service/": { status: 500, text: "PHP Fatal error: Uncaught TypeError" },
    });
    const read = await failure(client.get("/service/servers", servers));
    expect(read.message).toBe("Kamatera answered HTTP 500 to GET /service/servers.");
    expect(read.hint).toBe(
      "Kamatera failed on its side: try again in a few minutes, and contact Kamatera's support if it keeps failing.",
    );
    const write = await failure(client.post("/service/server/poweron", servers, {}));
    expect(write.hint).toBe(
      "Kamatera failed on its side, and the change may still have been made: check your Kamatera account in its console before trying again.",
    );
  });

  it("says to wait after a 429", async () => {
    const { client } = setup({ "GET /service/servers": { status: 429 } });
    const error = await failure(client.get("/service/servers", servers));
    expect(error.message).toBe("Kamatera's rate limit was reached (GET /service/servers).");
    expect(error.hint).toBe("Wait a minute and try again.");
  });
});

describe("KamateraClient never sends a post twice", () => {
  it.each<[string, FakeReply]>([
    ["a 500", refused("Busy.")],
    ["a 500 without a body", { status: 500 }],
    ["a 429", { status: 429 }],
    ["a 502", { status: 502 }],
  ])("sends it once after %s", async (_, reply) => {
    const { client, calls } = setup({ "POST /service/server/terminate": reply });
    await failure(client.post("/service/server/terminate", z.unknown(), { force: true }));
    expect(calls).toHaveLength(1);
  });

  it("sends it once after no answer, saying it may have been made", async () => {
    const { client, calls } = setup({
      "POST /service/server/terminate": { error: new Error("socket hang up") },
    });
    const error = await failure(client.post("/service/server/terminate", z.unknown(), {}));
    expect(calls).toHaveLength(1);
    expect(error.message).toBe(
      "Lost the connection to Kamatera's API (POST /service/server/terminate).",
    );
    expect(error.hint).toBe(
      "The change may still have been made: check your Kamatera account in its console before trying again.",
    );
  });

  it("says the API did not answer in time", async () => {
    const { client, calls } = setup(
      { "POST /service/server/terminate": { hang: true } },
      { timeoutMs: 1_000 },
    );
    const error = await failure(client.post("/service/server/terminate", z.unknown(), {}));
    expect(calls).toHaveLength(1);
    expect(error.message).toBe(
      "Kamatera's API did not answer within 1 second (POST /service/server/terminate).",
    );
  });

  it("says to check the connection after a read that got no answer", async () => {
    const { client } = setup({ "GET /service/servers": { error: new Error("ECONNREFUSED") } });
    const error = await failure(client.get("/service/servers", servers));
    expect(error.hint).toBe("Check your internet connection and try again.");
  });
});

describe("KamateraClient leaks", () => {
  it("puts neither value in any error, request line or body, nor in a fixture", async () => {
    const echo = `bad ${CREDENTIALS.clientId} ${CREDENTIALS.secret}`;
    const failing: FakeReply[] = [
      refused(echo),
      { status: 500, body: { message: echo } },
      { status: 500, body: { errors: [{ info: echo }] } },
      ...[400, 401, 403, 404, 429, 502].map((status) => proxyError(status, echo)),
      { status: 500, text: echo },
      { error: new Error(echo) },
      { body: { unexpected: echo } },
      { text: echo },
    ];
    const errors: OpsCrewError[] = [];
    const requests: FakeCall[] = [];
    for (const reply of failing) {
      const { client, calls } = setup({ "/service/": reply });
      errors.push(await failure(client.get("/service/servers", servers)));
      errors.push(await failure(client.post("/service/server/info", servers, {})));
      requests.push(...calls);
    }
    const { client, calls } = setup({
      "POST /service/server/poweroff": { body: ["4242"] },
      "GET /service/queue": queued("error", echo),
    });
    errors.push(await failure(client.command("/service/server/poweroff", { name: "x" }, WAIT)));
    requests.push(...calls);

    for (const error of errors) {
      for (const value of SECRETS) expect(errorText(error)).not.toContain(value);
    }
    // The values travel only in the two headers.
    const sent = JSON.stringify(requests.map(({ url, body }) => ({ url, body })));
    for (const value of SECRETS) expect(sent).not.toContain(value);

    const fixtures = join(import.meta.dirname, "__fixtures__");
    for (const name of await readdir(fixtures)) {
      const text = await readFile(join(fixtures, name), "utf8");
      for (const value of SECRETS) expect(text).not.toContain(value);
    }
  });
});
