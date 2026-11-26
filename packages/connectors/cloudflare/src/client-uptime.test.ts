import type { FetchLike } from "@opscrew/contracts";
import { errorText, OpsCrewError, Redactor, sha256Hex } from "@opscrew/core";
import { fakeFetch, fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_API,
  CLOUDFLARE_UPTIME_PERMISSIONS,
  CloudflareClient,
  CloudflareError,
  KvNamespaceExistsError,
} from "./client";
import { FAKE_ACCOUNT_ID as ACCOUNT, FakeUptime } from "./testing";
import { DENIED, ok, refuse } from "./testing/replies";

const TOKEN = fakeSecret("cloudflare-token");
const NS = "a".repeat(32);
const KV = `/accounts/${ACCOUNT}/storage/kv/namespaces`;
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/opscrew-uptime`;

function clientWith(routes: Parameters<typeof fakeFetch>[0], redactor?: Redactor) {
  const fake = fakeFetch(routes, { base: CLOUDFLARE_API });
  const client = new CloudflareClient({
    token: TOKEN,
    fetch: fake.fetch,
    sleep: async () => {},
    ...(redactor ? { redactor } : {}),
  });
  return { client, calls: fake.calls };
}

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

describe("Workers KV namespaces", () => {
  it("lists every page of 100 until a shorter one", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: `ns${i}`, title: `t${i}` }));
    const { client, calls } = clientWith({
      [`GET ${KV}?page=1`]: ok(full),
      [`GET ${KV}?page=2`]: ok([{ id: NS, title: "opscrew-uptime", supports_url_encoding: true }]),
    });
    const namespaces = await client.listKvNamespaces(ACCOUNT);
    expect(namespaces).toHaveLength(101);
    expect(namespaces.at(-1)).toEqual({ id: NS, title: "opscrew-uptime" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET ${KV}?page=1&per_page=100`,
      `GET ${KV}?page=2&per_page=100`,
    ]);
  });

  it("creates one by its title and answers its id", async () => {
    const { client, calls } = clientWith({
      [`POST ${KV}`]: ok({ id: NS, title: "opscrew-uptime", supports_url_encoding: true }),
    });
    expect(await client.createKvNamespace(ACCOUNT, "opscrew-uptime")).toBe(NS);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: KV,
      body: { title: "opscrew-uptime" },
      headers: { "Content-Type": "application/json" },
    });
  });

  it("maps the duplicate title's 400 to KvNamespaceExistsError", async () => {
    const { client } = clientWith({
      [`POST ${KV}`]: refuse(
        400,
        10014,
        "a namespace with this account ID and title already exists",
      ),
    });
    const error = await rejection(client.createKvNamespace(ACCOUNT, "opscrew-uptime"));
    expect(error).toBeInstanceOf(KvNamespaceExistsError);
    expect((error as KvNamespaceExistsError).title).toBe("opscrew-uptime");
  });

  it("keeps any other refusal of the create a plain error", async () => {
    const { client } = clientWith({ [`POST ${KV}`]: refuse(400, 10019, "invalid title") });
    const error = await rejection(client.createKvNamespace(ACCOUNT, "opscrew-uptime"));
    expect(error).not.toBeInstanceOf(KvNamespaceExistsError);
    expect(error.message).toContain("invalid title");
  });

  it("deletes one by its id", async () => {
    const { client, calls } = clientWith({ [`DELETE ${KV}/${NS}`]: ok(null) });
    await client.deleteKvNamespace(ACCOUNT, NS);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE ${KV}/${NS}`]);
  });

  it("names both uptime permissions when Cloudflare refuses the token", async () => {
    const { client } = clientWith({ [`GET ${KV}`]: DENIED });
    const error = await rejection(client.listKvNamespaces(ACCOUNT));
    expect(error).toBeInstanceOf(CloudflareError);
    for (const permission of CLOUDFLARE_UPTIME_PERMISSIONS)
      expect(error.hint).toContain(permission);
  });
});

describe("Workers KV keys and values", () => {
  it("lists the keys of a prefix, following the cursor", async () => {
    const page = (names: string[], cursor: string) => ({
      body: {
        success: true,
        errors: [],
        messages: [],
        result: names.map((name) => ({ name })),
        result_info: { count: names.length, cursor },
      },
    });
    const { client, calls } = clientWith({
      [`GET ${KV}/${NS}/keys?prefix=entry%3A&limit=1000&cursor=c2`]: page(["entry:b"], ""),
      [`GET ${KV}/${NS}/keys?prefix=entry%3A&limit=1000`]: page(["entry:a"], "c2"),
    });
    expect(await client.listKvKeys(ACCOUNT, NS, "entry:")).toEqual(["entry:a", "entry:b"]);
    expect(calls.map((c) => c.path)).toEqual([
      `${KV}/${NS}/keys?prefix=entry%3A&limit=1000`,
      `${KV}/${NS}/keys?prefix=entry%3A&limit=1000&cursor=c2`,
    ]);
  });

  it("reads a value as it is stored, percent-encoding the key", async () => {
    const key = "entry:acme/shop/shop/prod";
    const path = `${KV}/${NS}/values/entry%3Aacme%2Fshop%2Fshop%2Fprod`;
    const { client, calls } = clientWith({ [`GET ${path}`]: { text: '{"version":1}' } });
    expect(await client.getKv(ACCOUNT, NS, key)).toBe('{"version":1}');
    expect(calls[0]?.path).toBe(path);
  });

  it("answers undefined for a key that does not exist, and fails for another 404", async () => {
    const { client } = clientWith({
      [`GET ${KV}/${NS}/values/gone`]: refuse(404, 10009, "get: 'key not found'"),
      [`GET ${KV}/${NS}/values/other`]: refuse(404, 10013, "namespace not found"),
    });
    expect(await client.getKv(ACCOUNT, NS, "gone")).toBeUndefined();
    const error = await rejection(client.getKv(ACCOUNT, NS, "other"));
    expect(error.message).toContain("namespace not found");
  });

  it("writes a value as plain text and deletes a key", async () => {
    const { client, calls } = clientWith({
      [`PUT ${KV}/${NS}/values/opscrew%3Aworker`]: ok(null),
      [`DELETE ${KV}/${NS}/values/state%3Aa%2Fb%2Fc%2Fd`]: ok(null),
    });
    await client.putKv(ACCOUNT, NS, "opscrew:worker", '{"sha256":"x"}');
    await client.deleteKv(ACCOUNT, NS, "state:a/b/c/d");
    expect(calls[0]).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    });
    // fakeFetch parses a JSON-looking text body: it was sent as this text.
    expect(calls[0]?.body).toEqual({ sha256: "x" });
    expect(calls[1]).toMatchObject({
      method: "DELETE",
      path: `${KV}/${NS}/values/state%3Aa%2Fb%2Fc%2Fd`,
    });
  });
});

describe("the Worker module upload", () => {
  it("sends the metadata part and the module as multipart, without a JSON content type", async () => {
    let sent = { url: "", init: {} as RequestInit };
    const fetch: FetchLike = async (url, init) => {
      sent = { url: String(url), init: init ?? {} };
      return Response.json({ success: true, errors: [], result: { id: "opscrew-uptime" } });
    };
    const client = new CloudflareClient({ token: TOKEN, fetch });
    await client.uploadWorkerModule(ACCOUNT, "opscrew-uptime", {
      content: "export default { async scheduled() {} };",
      compatibilityDate: "2026-10-01",
      bindings: [{ type: "kv_namespace", name: "UPTIME", namespace_id: NS }],
      keepBindings: ["secret_text"],
    });
    expect(sent.url).toBe(`${CLOUDFLARE_API}${SCRIPT}`);
    expect(sent.init.method).toBe("PUT");
    expect((sent.init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    const form = sent.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get("metadata")))).toEqual({
      main_module: "worker.mjs",
      compatibility_date: "2026-10-01",
      bindings: [{ type: "kv_namespace", name: "UPTIME", namespace_id: NS }],
      keep_bindings: ["secret_text"],
    });
    const module = form.get("worker.mjs") as File;
    expect(module.type).toBe("application/javascript+module");
    expect(module.name).toBe("worker.mjs");
    expect(await module.text()).toBe("export default { async scheduled() {} };");
  });

  it("is accepted by the fake Cloudflare, which keeps its secrets only with keep_bindings", async () => {
    const fake = new FakeUptime();
    const { id } = fake.addNamespace("opscrew-uptime");
    const client = new CloudflareClient({ token: TOKEN, fetch: fake.fetch });
    const upload = (keepBindings: string[]) =>
      client.uploadWorkerModule(ACCOUNT, "opscrew-uptime", {
        content: "export default {};",
        compatibilityDate: "2026-10-01",
        bindings: [{ type: "kv_namespace", name: "UPTIME", namespace_id: id }],
        keepBindings,
      });
    await upload(["secret_text"]);
    await client.putWorkerSecret(ACCOUNT, "opscrew-uptime", { name: "HOOK_A", text: "value-one" });
    await upload(["secret_text"]);
    expect(await client.listWorkerSecrets(ACCOUNT, "opscrew-uptime")).toEqual(["HOOK_A"]);
    await upload([]);
    expect(await client.listWorkerSecrets(ACCOUNT, "opscrew-uptime")).toEqual([]);
    expect(fake.scripts.get("opscrew-uptime")?.bindings).toEqual([
      { type: "kv_namespace", name: "UPTIME", namespace_id: id },
    ]);
  });

  it("says an unclear answer may have reached Cloudflare, and never sends it again", async () => {
    const { client, calls } = clientWith({
      [`PUT ${SCRIPT}`]: { status: 502, text: "bad gateway" },
    });
    const error = await rejection(
      client.uploadWorkerModule(ACCOUNT, "opscrew-uptime", {
        content: "export default {};",
        compatibilityDate: "2026-10-01",
        bindings: [],
        keepBindings: ["secret_text"],
      }),
    );
    expect(error.message).toContain("may still have reached Cloudflare");
    expect(calls).toHaveLength(1);
  });
});

describe("the Worker's schedules, secrets and deletion", () => {
  it("replaces the schedules with the crons given", async () => {
    const { client, calls } = clientWith({
      [`PUT ${SCRIPT}/schedules`]: ok({ schedules: [{ cron: "*/5 * * * *" }] }),
    });
    await client.putWorkerSchedules(ACCOUNT, "opscrew-uptime", ["*/5 * * * *"]);
    expect(calls[0]).toMatchObject({
      method: "PUT",
      path: `${SCRIPT}/schedules`,
      body: [{ cron: "*/5 * * * *" }],
    });
  });

  it("refuses a schedules answer it can't read as one that may hide a change", async () => {
    const { client } = clientWith({ [`PUT ${SCRIPT}/schedules`]: ok({ crons: [] }) });
    const error = await rejection(
      client.putWorkerSchedules(ACCOUNT, "opscrew-uptime", ["*/5 * * * *"]),
    );
    expect(error.message).toContain("may still have reached Cloudflare");
  });

  it("lists the secrets' names, or undefined without the Worker", async () => {
    const { client } = clientWith({
      [`GET ${SCRIPT}/secrets`]: ok([{ name: "HOOK_A", type: "secret_text" }]),
      [`GET /accounts/${ACCOUNT}/workers/scripts/missing/secrets`]: refuse(
        404,
        10007,
        "This Worker does not exist on your account.",
      ),
    });
    expect(await client.listWorkerSecrets(ACCOUNT, "opscrew-uptime")).toEqual(["HOOK_A"]);
    expect(await client.listWorkerSecrets(ACCOUNT, "missing")).toBeUndefined();
  });

  it("sets a secret of type secret_text and deletes one by its name", async () => {
    const { client, calls } = clientWith({
      [`PUT ${SCRIPT}/secrets`]: ok({ name: "HOOK_A", type: "secret_text" }),
      [`DELETE ${SCRIPT}/secrets/HOOK_A`]: ok(null),
      [`DELETE ${SCRIPT}`]: ok(null),
    });
    await client.putWorkerSecret(ACCOUNT, "opscrew-uptime", { name: "HOOK_A", text: "the-value" });
    await client.deleteWorkerSecret(ACCOUNT, "opscrew-uptime", "HOOK_A");
    await client.deleteWorkerScript(ACCOUNT, "opscrew-uptime");
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", `${SCRIPT}/secrets`, { name: "HOOK_A", text: "the-value", type: "secret_text" }],
      ["DELETE", `${SCRIPT}/secrets/HOOK_A`, undefined],
      ["DELETE", SCRIPT, undefined],
    ]);
  });

  it("masks the secret's value in Cloudflare's refusal and in the session's redactor", async () => {
    const value = JSON.stringify({
      url: `https://ntfy.example.com/${fakeSecret("generic-password")}`,
    });
    const redactor = new Redactor();
    const { client } = clientWith(
      { [`PUT ${SCRIPT}/secrets`]: refuse(400, 10021, `invalid secret text ${value}`) },
      redactor,
    );
    const error = await rejection(
      client.putWorkerSecret(ACCOUNT, "opscrew-uptime", { name: "HOOK_A", text: value }),
    );
    expect(errorText(error)).not.toContain(value);
    expect(errorText(error)).toContain("[REDACTED:HOOK_A]");
    expect(redactor.redact(`posted ${value}`)).toBe("posted [REDACTED:HOOK_A]");
  });

  it("masks the webhook's address and token, and the report key, on their own too", async () => {
    const url = `https://ntfy.example.com/${fakeSecret("generic-password", "url")}`;
    const token = fakeSecret("generic-password", "token");
    const report = sha256Hex(fakeSecret("generic-password", "report"));
    const redactor = new Redactor();
    const { client } = clientWith(
      { [`PUT ${SCRIPT}/secrets`]: ok({ name: "HOOK_A", type: "secret_text" }) },
      redactor,
    );
    await client.putWorkerSecret(ACCOUNT, "opscrew-uptime", {
      name: "HOOK_A",
      text: JSON.stringify({ url, token, report }),
    });
    expect(redactor.redact(`posting to ${url} with ${token}, signed with ${report}`)).toBe(
      "posting to [REDACTED:HOOK_A] with [REDACTED:HOOK_A], signed with [REDACTED:HOOK_A]",
    );
  });

  it("masks a registered secret in every other method's refusal too", async () => {
    const redactor = new Redactor();
    const secret = fakeSecret("generic-password", "kv");
    redactor.addLiteral(secret, "S");
    const { client } = clientWith(
      { [`GET ${KV}/${NS}/keys`]: refuse(400, 10001, `bad cursor ${secret}`) },
      redactor,
    );
    const error = await rejection(client.listKvKeys(ACCOUNT, NS, "entry:"));
    expect(errorText(error)).not.toContain(secret);
  });
});

describe("the account's workers.dev subdomain", () => {
  const SUBDOMAIN = `/accounts/${ACCOUNT}/workers/subdomain`;

  it("is read, or undefined when the account has none yet (code 10007) or an empty one", async () => {
    const { client, calls } = clientWith({ [`GET ${SUBDOMAIN}`]: ok({ subdomain: "acme" }) });
    expect(await client.getWorkersSubdomain(ACCOUNT)).toBe("acme");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${SUBDOMAIN}`]);
    const none = clientWith({
      [`GET ${SUBDOMAIN}`]: refuse(404, 10007, "This subdomain does not exist."),
    });
    expect(await none.client.getWorkersSubdomain(ACCOUNT)).toBeUndefined();
    const empty = clientWith({ [`GET ${SUBDOMAIN}`]: ok({ subdomain: "" }) });
    expect(await empty.client.getWorkersSubdomain(ACCOUNT)).toBeUndefined();
  });

  it("reads whether a Worker's workers.dev address is on, or undefined with no such Worker", async () => {
    const { client, calls } = clientWith({
      [`GET ${SCRIPT}/subdomain`]: ok({ enabled: true, previews_enabled: false }),
    });
    expect(await client.getWorkerSubdomain(ACCOUNT, "opscrew-uptime")).toEqual({
      enabled: true,
      previewsEnabled: false,
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${SCRIPT}/subdomain`]);
    const none = clientWith({
      [`GET ${SCRIPT}/subdomain`]: refuse(
        404,
        10007,
        "This Worker does not exist on your account.",
      ),
    });
    expect(await none.client.getWorkerSubdomain(ACCOUNT, "opscrew-uptime")).toBeUndefined();
  });

  it("turns a Worker's workers.dev address on, with its previews off", async () => {
    const { client, calls } = clientWith({
      [`POST ${SCRIPT}/subdomain`]: ok({ enabled: true, previews_enabled: false }),
    });
    await client.setWorkerSubdomain(ACCOUNT, "opscrew-uptime", {
      enabled: true,
      previewsEnabled: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: `${SCRIPT}/subdomain`,
      body: { enabled: true, previews_enabled: false },
    });
  });

  it("names it, not the token, when a call is refused for want of one (code 10063)", async () => {
    const { client } = clientWith({
      [`PUT ${SCRIPT}/schedules`]: refuse(
        403,
        10063,
        "You need a workers.dev subdomain in order to proceed",
      ),
    });
    const error = await rejection(
      client.putWorkerSchedules(ACCOUNT, "opscrew-uptime", ["* * * * *"]),
    );
    expect(error).not.toBeInstanceOf(CloudflareError);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "Your Cloudflare account has no workers.dev subdomain yet, so Cloudflare refused to set the schedule of the Worker opscrew-uptime.",
    );
    expect(error.hint).toBe(
      "Open Workers & Pages in Cloudflare's dashboard once, which asks you to choose one, then run provision again.",
    );
  });
});

describe("the uptime permissions", () => {
  it("name each one the token lacks, probed read-only", async () => {
    const workers = `GET /accounts/${ACCOUNT}/workers/scripts`;
    const kv = `GET ${KV}?per_page=5`;
    for (const [routes, missing] of [
      [{ [workers]: ok([]), [kv]: ok([]) }, []],
      [{ [workers]: ok([]), [kv]: DENIED }, ["Account → Workers KV Storage → Edit"]],
      [{ [workers]: DENIED, [kv]: DENIED }, [...CLOUDFLARE_UPTIME_PERMISSIONS]],
    ] as const) {
      const { client, calls } = clientWith(routes);
      expect(await client.uptimePermissions(ACCOUNT)).toEqual({ missing });
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([workers, kv]);
    }
    expect(CLOUDFLARE_UPTIME_PERMISSIONS).toEqual([
      "Account → Workers Scripts → Edit",
      "Account → Workers KV Storage → Edit",
    ]);
  });
});
