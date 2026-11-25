import { errorText, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { CloudflareClient } from "./client";
import { FAKE_ACCOUNT_ID as ACCOUNT, FakeUptime } from "./testing";
import { refuse } from "./testing/replies";
import {
  applyUptime,
  describeUptimePlan,
  inspectUptime,
  parseUptimeState,
  planUptime,
  UptimeApplyError,
  type UptimeDesired,
  type UptimeEntry,
  type UptimeFacts,
  uptimeEntryKey,
  uptimeReportKey,
  uptimeSecretName,
  uptimeStateKey,
} from "./uptime";

const TOKEN = fakeSecret("cloudflare-token");
const SHOP = "acme/shop/shop/prod";
const BLOG = "acme/blog/blog/prod";
const API = "acme/web/api/staging";
const V1 = "export default { async scheduled() {} }; // v1";
const V2 = "export default { async scheduled() {} }; // v2";
const script = (content: string) => ({ content, sha256: sha256Hex(content) });
const webhook = (seed: string) =>
  JSON.stringify({ url: `https://ntfy.example.com/${fakeSecret("generic-password", seed)}` });
const HOOK = webhook("shop");

function entryFor(id: string, hostnames: string[] = ["shop.example.com"]): UptimeEntry {
  const [owner, repo, app, environment] = id.split("/") as [string, string, string, string];
  return {
    version: 1,
    repository: `${owner}/${repo}`,
    app,
    environment,
    hosts: hostnames.map((hostname) => ({ hostname, healthPath: "/health" })),
    webhook: "ntfy",
    secret: uptimeSecretName(id),
  };
}

/** The desired entry of `id`, with its webhook secret given, on script V1. */
function wanting(id: string, more: Partial<UptimeDesired> = {}): UptimeDesired {
  return { id, entry: entryFor(id), secret: webhook(id), script: script(V1), ...more };
}

/** The removal of `id`'s entry (`destroy` from a destroy). */
function leaving(id: string, destroy = false): UptimeDesired {
  return { id, script: script(V1), ...(destroy ? { destroy: true } : {}) };
}

function setup() {
  const fake = new FakeUptime();
  const client = () =>
    new CloudflareClient({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  return { fake, client: client(), client2: client() };
}

async function planFor(client: CloudflareClient, desired: UptimeDesired) {
  return planUptime(await inspectUptime(client, ACCOUNT), desired);
}

async function provision(client: CloudflareClient, desired: UptimeDesired) {
  const plan = await planFor(client, desired);
  return applyUptime(client, plan, desired, plan.hash);
}

async function rejection(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

const kinds = (plan: { changes: { kind: string }[] }) => plan.changes.map((c) => c.kind);

/** Facts as `inspectUptime` gives them, with `entries` for the ids given. */
function facts(ids: string[], more: Partial<UptimeFacts> = {}): UptimeFacts {
  return {
    accountId: ACCOUNT,
    namespaceId: "n".repeat(32),
    sha256: sha256Hex(V1),
    entries: Object.fromEntries(ids.map((id) => [uptimeEntryKey(id), entryFor(id)])),
    secrets: ids.map(uptimeSecretName),
    accountSubdomain: "opscrew-test",
    workersDev: true,
    reports: [],
    denied: [],
    ...more,
  };
}

describe("inspectUptime", () => {
  it("reads nothing but the namespace, the Worker's record, the entries and the secrets' names", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    fake.calls.length = 0;
    const read = await inspectUptime(client, ACCOUNT);
    expect(read).toEqual({
      accountId: ACCOUNT,
      namespaceId: fake.namespace("opscrew-uptime")?.id,
      sha256: sha256Hex(V1),
      entries: { [uptimeEntryKey(SHOP)]: entryFor(SHOP) },
      secrets: [uptimeSecretName(SHOP)],
      accountSubdomain: "opscrew-test",
      workersDev: true,
      reports: [],
      denied: [],
    });
    expect(fake.writes()).toEqual([]);
  });

  it("stops the plan before any change when the account has no workers.dev subdomain", async () => {
    const { fake, client } = setup();
    fake.subdomain = undefined;
    const read = await inspectUptime(client, ACCOUNT);
    expect(read.accountSubdomain).toBeNull();
    const plan = planUptime(read, wanting(SHOP));
    expect(plan.findings).toEqual([
      {
        code: "workers-dev-missing",
        message:
          "Your Cloudflare account has no workers.dev subdomain yet, which the uptime Worker's trigger and the servers' reports need.",
        hint: "Open Workers & Pages in Cloudflare's dashboard once, which asks you to choose one, then run provision again.",
      },
    ]);
    const error = await rejection(applyUptime(client, plan, wanting(SHOP), plan.hash));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(fake.writes()).toEqual([]);
    // Removing an entry needs no subdomain.
    expect(planUptime(read, leaving(SHOP)).findings).toEqual([]);
  });

  it("names a permission Cloudflare refuses, and the plan stops on it", async () => {
    const { fake, client } = setup();
    fake.denied.add("kv");
    const read = await inspectUptime(client, ACCOUNT);
    expect(read.denied).toEqual(["Account → Workers KV Storage → Edit"]);
    const plan = planUptime(read, wanting(SHOP));
    expect(plan.changes).toEqual([]);
    expect(plan.findings.map((f) => f.code)).toEqual(["permission-missing"]);
    expect(plan.findings[0]?.hint).toContain("Account → Workers Scripts → Edit");
  });

  it("stops on an entry that isn't what OpsCrew writes, naming its key", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    fake.namespace("opscrew-uptime")?.values.set(uptimeEntryKey(BLOG), '{"version":1}');
    const error = await rejection(inspectUptime(client, ACCOUNT));
    expect(error.message).toContain(uptimeEntryKey(BLOG));
  });
});

describe("planUptime", () => {
  it("creates the namespace, the script, the secret and the entry on an empty account, in order", async () => {
    const { client } = setup();
    const plan = await planFor(client, wanting(SHOP));
    expect(kinds(plan)).toEqual([
      "create-namespace",
      "upload-script",
      "set-subdomain",
      "put-secret",
      "put-entry",
    ]);
    expect(plan.expect).toEqual({ others: [], sha256: null, namespaceId: null });
    expect(plan.findings).toEqual([]);
    expect(plan.destroys).toBe(false);
  });

  it("creates nothing shared for a second app, and names the entry it keeps", async () => {
    const { client } = setup();
    await provision(client, wanting(SHOP));
    const plan = await planFor(client, wanting(BLOG));
    expect(plan.changes).toEqual([
      { kind: "put-secret", name: uptimeSecretName(BLOG) },
      { kind: "put-entry", key: uptimeEntryKey(BLOG), entry: entryFor(BLOG) },
    ]);
    expect(plan.expect.others).toEqual([uptimeEntryKey(SHOP)]);
    const words = describeUptimePlan(plan);
    expect(words).toContain("Keeps the entries of: acme/shop (prod).");
    expect(words).toContain(`Cloudflare uptime plan hash: ${plan.hash}`);
  });

  it("names an app that isn't the repository's own in the entries it keeps", () => {
    const plan = planUptime(facts([SHOP, API]), wanting(BLOG));
    expect(describeUptimePlan(plan)).toContain(
      "Keeps the entries of: acme/shop (prod), acme/web (api, staging).",
    );
  });

  it("uploads a script whose SHA-256 changed, and leaves an unchanged entry alone", () => {
    const plan = planUptime(facts([SHOP]), {
      ...wanting(SHOP, { script: script(V2) }),
      secret: undefined,
    });
    expect(plan.changes).toEqual([{ kind: "upload-script", sha256: sha256Hex(V2) }]);
    const same = planUptime(facts([SHOP]), { id: SHOP, entry: entryFor(SHOP), script: script(V1) });
    expect(same.changes).toEqual([]);
  });

  it("writes an entry whose hostnames changed", () => {
    const entry = entryFor(SHOP, ["shop.example.com", "www.shop.example.com"]);
    const plan = planUptime(facts([SHOP]), { id: SHOP, entry, script: script(V1) });
    expect(plan.changes).toEqual([{ kind: "put-entry", key: uptimeEntryKey(SHOP), entry }]);
  });

  it("keeps a stored secret when none is given, and stops when there is neither", () => {
    const kept = planUptime(facts([SHOP]), { id: SHOP, entry: entryFor(SHOP), script: script(V1) });
    expect(kinds(kept)).not.toContain("put-secret");
    expect(kept.findings).toEqual([]);
    const none = planUptime(facts([]), { id: SHOP, entry: entryFor(SHOP), script: script(V1) });
    expect(kinds(none)).not.toContain("put-secret");
    expect(none.findings.map((f) => f.code)).toEqual(["secret-missing"]);
    expect(none.findings[0]?.hint).toContain("OPSCREW_CHECK_WEBHOOK");
  });

  it("replaces a stored secret when one is given", () => {
    expect(kinds(planUptime(facts([SHOP]), wanting(SHOP)))).toEqual(["put-secret"]);
  });

  it("removes only the entry and the secret while other entries remain, in a destroy too", () => {
    for (const destroy of [false, true]) {
      const plan = planUptime(facts([SHOP, BLOG]), leaving(SHOP, destroy));
      expect(plan.changes).toEqual([
        { kind: "delete-entry", key: uptimeEntryKey(SHOP) },
        { kind: "delete-secret", name: uptimeSecretName(SHOP) },
      ]);
      expect(plan.destroys).toBe(false);
    }
  });

  it("keeps the Worker and the namespace when a provision removes the last entry", () => {
    const plan = planUptime(facts([SHOP]), leaving(SHOP));
    expect(kinds(plan)).toEqual(["delete-entry", "delete-secret"]);
    expect(plan.destroys).toBe(false);
    expect(describeUptimePlan(plan)).toContain(
      "The Worker opscrew-uptime, its trigger and the KV namespace opscrew-uptime stay, with no entry",
    );
  });

  it("deletes the Worker and the namespace only in the last entry's destroy", () => {
    const plan = planUptime(facts([SHOP]), leaving(SHOP, true));
    expect(kinds(plan)).toEqual([
      "delete-entry",
      "delete-secret",
      "delete-script",
      "delete-namespace",
    ]);
    expect(plan.destroys).toBe(true);
    expect(describeUptimePlan(plan)).toContain("Delete the Worker opscrew-uptime");
  });

  it("plans nothing for an environment with no entry and no secret", () => {
    expect(planUptime(facts([BLOG]), leaving(SHOP)).changes).toEqual([]);
  });

  it("refuses a 41st hostname in the account, naming the cap of 40", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `h${i}.example.com`);
    const read = facts([BLOG]);
    const blog = read.entries[uptimeEntryKey(BLOG)] as UptimeEntry;
    blog.hosts = many(39).map((hostname) => ({ hostname, healthPath: "/" }));
    expect(planUptime(read, wanting(SHOP)).findings).toEqual([]);
    blog.hosts.push({ hostname: "h39.example.com", healthPath: "/" });
    const [finding] = planUptime(read, wanting(SHOP)).findings;
    expect(finding?.code).toBe("too-many-hostnames");
    expect(finding?.message).toContain("at most 40 hostnames");
    expect(finding?.message).toContain("already count 40 hostnames");
    expect(finding?.hint).toContain('observability.check.runner: "actions"');
  });

  it("hashes the same input the same, changes with expect, and never with the secret's value", () => {
    const a = planUptime(facts([BLOG]), wanting(SHOP));
    expect(planUptime(facts([BLOG]), wanting(SHOP)).hash).toBe(a.hash);
    expect(planUptime(facts([BLOG]), { ...wanting(SHOP), secret: webhook("other") }).hash).toBe(
      a.hash,
    );
    const moreOthers = planUptime(facts([BLOG, API]), wanting(SHOP));
    expect(moreOthers.changes).toEqual(a.changes);
    expect(moreOthers.hash).not.toBe(a.hash);
    const otherSha = planUptime(facts([BLOG], { sha256: "f".repeat(64) }), {
      ...wanting(SHOP),
      script: { content: V1, sha256: "f".repeat(64) },
    });
    expect(otherSha.changes).toEqual(a.changes);
    expect(otherSha.hash).not.toBe(a.hash);
  });

  it("never holds the webhook's value, in the plan or its words", () => {
    const plan = planUptime(facts([]), { ...wanting(SHOP), secret: HOOK });
    expect(JSON.stringify(plan)).not.toContain(HOOK);
    expect(describeUptimePlan(plan)).not.toContain(HOOK);
    expect(describeUptimePlan(plan)).toContain(`Set the Worker secret ${uptimeSecretName(SHOP)}`);
  });

  it("refuses a webhook secret that isn't an address and an optional token, without showing it", () => {
    const address = `https://ntfy.example.com/${fakeSecret("generic-password", "bad")}`;
    for (const secret of [
      address,
      JSON.stringify({ url: address.replace("https://", "") }),
      JSON.stringify({ url: address, token: "" }),
      JSON.stringify({ token: fakeSecret("generic-password", "token") }),
      JSON.stringify([address]),
    ]) {
      const error = (() => {
        try {
          planUptime(facts([]), { ...wanting(SHOP), secret });
        } catch (e) {
          return e;
        }
      })() as OpsCrewError;
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error.code).toBe("INVALID_INPUT");
      expect(error.message).toContain("The webhook's secret for acme/shop (prod)");
      expect(errorText(error)).not.toContain(secret);
      expect(errorText(error)).not.toContain(address);
    }
    const withToken = JSON.stringify({ url: address, token: fakeSecret("generic-password", "t") });
    expect(kinds(planUptime(facts([]), { ...wanting(SHOP), secret: withToken }))).toContain(
      "put-secret",
    );
  });

  it("reads the Worker's state and nothing else", () => {
    const text = '{"hosts":{"a.example.com":{"status":"down","since":"t","reason":"r"}}}';
    expect(parseUptimeState(text)?.hosts["a.example.com"]?.status).toBe("down");
    expect(parseUptimeState("not json")).toBeUndefined();
    expect(parseUptimeState('{"hosts":{"a.example.com":{"status":"up"}}}')).toBeUndefined();
  });
});

describe("applyUptime", () => {
  it("refuses a different hash before any request", async () => {
    const { fake, client } = setup();
    const plan = await planFor(client, wanting(SHOP));
    fake.calls.length = 0;
    const error = await rejection(applyUptime(client, plan, wanting(SHOP), "0".repeat(64)));
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(fake.calls).toEqual([]);
  });

  it("refuses a script, an id or a missing secret that isn't the plan's", async () => {
    const { fake, client } = setup();
    const plan = await planFor(client, wanting(SHOP));
    fake.calls.length = 0;
    for (const desired of [
      wanting(SHOP, { script: { content: V2, sha256: sha256Hex(V1) } }),
      { ...wanting(SHOP), secret: undefined },
      { ...wanting(BLOG), id: BLOG },
    ]) {
      const error = await rejection(applyUptime(client, plan, desired, plan.hash));
      expect(error.code).toBe("PLAN_HASH_MISMATCH");
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses a deleting plan given without destroy", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    const plan = await planFor(client, leaving(SHOP, true));
    fake.calls.length = 0;
    const error = await rejection(applyUptime(client, plan, leaving(SHOP), plan.hash));
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(fake.writes()).toEqual([]);
  });

  it("refuses changes that delete the Worker without destroy, whatever the unhashed destroys says", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    const plan = { ...(await planFor(client, leaving(SHOP, true))), destroys: false };
    expect(kinds(plan)).toContain("delete-script");
    fake.calls.length = 0;
    const error = await rejection(applyUptime(client, plan, leaving(SHOP), plan.hash));
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(error.message).toContain("only a destroy may do");
    expect(fake.writes()).toEqual([]);
    expect(fake.scripts.has("opscrew-uptime")).toBe(true);
  });

  it("stops before any write when an entry appeared since the plan", async () => {
    const { fake, client, client2 } = setup();
    await provision(client, wanting(SHOP));
    const plan = await planFor(client, wanting(BLOG));
    await provision(client2, wanting(API));
    fake.calls.length = 0;
    const error = await rejection(applyUptime(client, plan, wanting(BLOG), plan.hash));
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("changed since the plan");
    expect(error.message).toContain("acme/web (api, staging) was added");
    expect(fake.writes()).toEqual([]);
  });

  it("stops before any write when the script's SHA-256 changed since the plan", async () => {
    const { fake, client, client2 } = setup();
    await provision(client, wanting(SHOP));
    const plan = await planFor(client, wanting(BLOG));
    await provision(client2, { ...wanting(SHOP, { script: script(V2) }), secret: undefined });
    fake.calls.length = 0;
    const error = await rejection(applyUptime(client, plan, wanting(BLOG), plan.hash));
    expect(error.message).toContain("uploaded again");
    expect(fake.writes()).toEqual([]);
  });

  it("applies in the data model's order, and records the script's SHA-256 after the upload", async () => {
    const { fake, client } = setup();
    const result = await provision(client, wanting(SHOP));
    expect(result).toEqual({
      applied: [
        "create-namespace",
        "upload-script",
        "set-schedule",
        "record-sha256",
        "set-subdomain",
        "put-secret",
        "put-entry",
      ],
      notes: [],
    });
    const kv = `/accounts/${ACCOUNT}/storage/kv/namespaces`;
    const id = fake.namespace("opscrew-uptime")?.id as string;
    const worker = `/accounts/${ACCOUNT}/workers/scripts/opscrew-uptime`;
    expect(fake.writes().map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${kv}`,
      `PUT ${worker}`,
      `PUT ${worker}/schedules`,
      `PUT ${kv}/${id}/values/opscrew%3Aworker`,
      `POST ${worker}/subdomain`,
      `PUT ${worker}/secrets`,
      `PUT ${kv}/${id}/values/${encodeURIComponent(uptimeEntryKey(SHOP))}`,
    ]);
    const uploaded = fake.scripts.get("opscrew-uptime");
    expect(uploaded).toMatchObject({
      content: V1,
      compatibilityDate: "2026-10-01",
      bindings: [{ type: "kv_namespace", name: "UPTIME", namespace_id: id }],
      crons: ["*/5 * * * *"],
      workersDev: { enabled: true, previewsEnabled: false },
    });
    expect(uploaded?.secrets.get(uptimeSecretName(SHOP))).toBe(webhook(SHOP));
    const values = fake.namespace("opscrew-uptime")?.values;
    expect(JSON.parse(values?.get("opscrew:worker") ?? "")).toEqual({ sha256: sha256Hex(V1) });
    expect(JSON.parse(values?.get(uptimeEntryKey(SHOP)) ?? "")).toEqual(entryFor(SHOP));
    // A second run finds everything in place.
    expect((await planFor(client, { ...wanting(SHOP), secret: undefined })).changes).toEqual([]);
  });

  it("ends two applies interleaved with one namespace, one script and both entries and secrets", async () => {
    const { fake, client, client2 } = setup();
    const shop = await planFor(client, wanting(SHOP));
    const blog = await planFor(client2, wanting(BLOG));
    const results = await Promise.all([
      applyUptime(client, shop, wanting(SHOP), shop.hash),
      applyUptime(client2, blog, wanting(BLOG), blog.hash),
    ]);
    expect(results.map((r) => r.applied)).toEqual([
      [
        "create-namespace",
        "upload-script",
        "set-schedule",
        "record-sha256",
        "set-subdomain",
        "put-secret",
        "put-entry",
      ],
      [
        "create-namespace",
        "upload-script",
        "set-schedule",
        "record-sha256",
        "set-subdomain",
        "put-secret",
        "put-entry",
      ],
    ]);
    // Both creates were sent; Cloudflare refused the second, which used the first's namespace.
    const kv = `/accounts/${ACCOUNT}/storage/kv/namespaces`;
    expect(fake.calls.filter((c) => c.method === "POST" && c.path === kv)).toHaveLength(2);
    expect(fake.namespaces.map((n) => n.title)).toEqual(["opscrew-uptime"]);
    expect([...fake.scripts.keys()]).toEqual(["opscrew-uptime"]);
    expect([...(fake.scripts.get("opscrew-uptime")?.secrets.keys() ?? [])].sort()).toEqual(
      [uptimeSecretName(SHOP), uptimeSecretName(BLOG)].sort(),
    );
    const values = fake.namespace("opscrew-uptime")?.values;
    expect(values?.has(uptimeEntryKey(SHOP))).toBe(true);
    expect(values?.has(uptimeEntryKey(BLOG))).toBe(true);
  });

  it("keeps another app's secret when it uploads the script again", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    await provision(client, { ...wanting(BLOG, { script: script(V2) }) });
    const secrets = fake.scripts.get("opscrew-uptime")?.secrets;
    expect(secrets?.get(uptimeSecretName(SHOP))).toBe(webhook(SHOP));
    expect(fake.scripts.get("opscrew-uptime")?.content).toBe(V2);
  });

  it("removes the last entry's entry, state and secret in a provision, keeping the Worker", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    fake.namespace("opscrew-uptime")?.values.set(uptimeStateKey(SHOP), '{"hosts":{}}');
    const result = await provision(client, leaving(SHOP));
    expect(result.applied).toEqual(["delete-entry", "delete-secret"]);
    const namespace = fake.namespace("opscrew-uptime");
    expect([...(namespace?.values.keys() ?? [])]).toEqual(["opscrew:worker"]);
    expect(fake.scripts.get("opscrew-uptime")?.secrets.size).toBe(0);
    expect(fake.scripts.get("opscrew-uptime")?.crons).toEqual(["*/5 * * * *"]);
  });

  it("removes one app's entry and secret in a destroy, keeping the other's and the Worker", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    await provision(client, wanting(BLOG));
    const plan = await planFor(client, leaving(SHOP, true));
    const result = await applyUptime(client, plan, leaving(SHOP, true), plan.hash);
    expect(result.applied).toEqual(["delete-entry", "delete-secret"]);
    expect([...(fake.scripts.get("opscrew-uptime")?.secrets.keys() ?? [])]).toEqual([
      uptimeSecretName(BLOG),
    ]);
    expect(fake.namespace("opscrew-uptime")?.values.has(uptimeEntryKey(BLOG))).toBe(true);
  });

  it("deletes the Worker and the namespace in the last entry's destroy, listing the entries just before", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    const plan = await planFor(client, leaving(SHOP, true));
    fake.calls.length = 0;
    const result = await applyUptime(client, plan, leaving(SHOP, true), plan.hash);
    expect(result).toEqual({
      applied: ["delete-entry", "delete-secret", "delete-script", "delete-namespace"],
      notes: [],
    });
    expect(fake.scripts.size).toBe(0);
    expect(fake.namespaces).toEqual([]);
    const worker = `/accounts/${ACCOUNT}/workers/scripts/opscrew-uptime`;
    const secretDeleted = fake.calls.findIndex(
      (c) => c.method === "DELETE" && c.path.startsWith(`${worker}/secrets/`),
    );
    const workerDeleted = fake.calls.findIndex((c) => c.method === "DELETE" && c.path === worker);
    const lastList = fake.calls.findLastIndex(
      (c) => c.method === "GET" && c.path.includes("/keys?"),
    );
    expect(secretDeleted).toBeGreaterThan(-1);
    expect(lastList).toBeGreaterThan(secretDeleted);
    expect(lastList).toBeLessThan(workerDeleted);
  });

  it("keeps the Worker and the namespace, and says so, when a new entry appears just before", async () => {
    const { fake, client } = setup();
    await provision(client, wanting(SHOP));
    const plan = await planFor(client, leaving(SHOP, true));
    fake.hooks.push({
      match: `DELETE /accounts/${ACCOUNT}/workers/scripts/opscrew-uptime/secrets/`,
      run: () => {
        fake
          .namespace("opscrew-uptime")
          ?.values.set(uptimeEntryKey(BLOG), JSON.stringify(entryFor(BLOG)));
      },
    });
    const result = await applyUptime(client, plan, leaving(SHOP, true), plan.hash);
    expect(result.applied).toEqual(["delete-entry", "delete-secret"]);
    expect(result.notes).toEqual([
      "The Worker opscrew-uptime, its trigger and the KV namespace opscrew-uptime stay: the entry of acme/blog (prod) was added after the plan, so that app uses them now.",
    ]);
    expect(fake.scripts.has("opscrew-uptime")).toBe(true);
    expect(fake.namespace("opscrew-uptime")).toBeDefined();
  });

  it("fails, saying another app's change at the same moment lost its settings, when its secret is missing at the end", async () => {
    const { fake, client } = setup();
    const plan = await planFor(client, wanting(SHOP));
    // An upload at the same moment that kept no secret, just before the apply reads them back.
    fake.hooks.push({
      match: `GET /accounts/${ACCOUNT}/workers/scripts/opscrew-uptime/secrets`,
      run: () => fake.scripts.get("opscrew-uptime")?.secrets.clear(),
    });
    const error = await rejection(applyUptime(client, plan, wanting(SHOP), plan.hash));
    expect(error).toBeInstanceOf(UptimeApplyError);
    expect((error as UptimeApplyError).applied).toEqual([
      "create-namespace",
      "upload-script",
      "set-schedule",
      "record-sha256",
      "set-subdomain",
      "put-secret",
      "put-entry",
    ]);
    expect(error.message).toBe(
      "Another app changed the shared uptime Worker at the same moment, so this app's settings didn't stick.",
    );
    expect(error.hint).toBe("Run provision again.");
    // Running it again plans the secret back.
    expect(kinds(await planFor(client, wanting(SHOP)))).toEqual(["put-secret"]);
  });

  it("lists exactly the steps done when the schedule is refused after the upload", async () => {
    const { fake, client } = setup();
    const plan = await planFor(client, wanting(SHOP));
    fake.faults.push({
      match: `PUT /accounts/${ACCOUNT}/workers/scripts/opscrew-uptime/schedules`,
      reply: refuse(403, 10063, "You need a workers.dev subdomain in order to proceed"),
    });
    const error = await rejection(applyUptime(client, plan, wanting(SHOP), plan.hash));
    expect(error).toBeInstanceOf(UptimeApplyError);
    expect((error as UptimeApplyError).applied).toEqual(["create-namespace", "upload-script"]);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toContain("Your Cloudflare account has no workers.dev subdomain yet");
  });

  it("lists the changes already applied when one fails part-way", async () => {
    const { fake, client } = setup();
    const plan = await planFor(client, wanting(SHOP));
    fake.faults.push({
      match: `PUT /accounts/${ACCOUNT}/workers/scripts/opscrew-uptime/secrets`,
      reply: refuse(400, 10021, "secret refused"),
    });
    const error = await rejection(applyUptime(client, plan, wanting(SHOP), plan.hash));
    expect(error).toBeInstanceOf(UptimeApplyError);
    expect((error as UptimeApplyError).applied).toEqual([
      "create-namespace",
      "upload-script",
      "set-schedule",
      "record-sha256",
      "set-subdomain",
    ]);
    expect(error.message).toContain("secret refused");
  });

  it("never puts the webhook's value in a result, an error or a note", async () => {
    const { fake, client } = setup();
    const desired = { ...wanting(SHOP), secret: HOOK };
    const plan = await planFor(client, desired);
    const result = await applyUptime(client, plan, desired, plan.hash);
    expect(JSON.stringify(result)).not.toContain(HOOK);
    const again = await planFor(client, desired);
    fake.faults.push({
      match: `PUT /accounts/${ACCOUNT}/workers/scripts/opscrew-uptime/secrets`,
      reply: refuse(400, 10021, `invalid secret ${HOOK}`),
    });
    const error = await rejection(applyUptime(client, again, desired, again.hash));
    expect(errorText(error)).not.toContain(HOOK);
  });
});

describe("server reports", () => {
  const T0 = "2026-11-25T10:00:00Z";
  const T1 = "2026-11-26T09:00:00Z";
  /** 32 random bytes in hex, as the agents keep them: never in a plan, a hash or its words. */
  const REPORT = sha256Hex(fakeSecret("generic-password", "report"));
  const withReport = (id: string, report = REPORT) =>
    JSON.stringify({ ...JSON.parse(webhook(id)), report });

  function serving(id: string, servers: string[], since = T0): UptimeEntry {
    return { ...entryFor(id), servers: servers.map((server) => ({ id: server, since })) };
  }

  function storedReports(fake: FakeUptime, keys: string[]): void {
    const values = fake.namespace("opscrew-uptime")?.values;
    for (const key of keys) values?.set(key, '{"version":1}');
  }

  it("names each server's report key under its entry", () => {
    expect(uptimeReportKey(SHOP, "hetzner-shop")).toBe("report:acme/shop/shop/prod/hetzner-shop");
  });

  it("reads the account's subdomain, the Worker's workers.dev address and the report keys", async () => {
    const { fake, client } = setup();
    expect((await inspectUptime(client, ACCOUNT)).workersDev).toBe(false);
    await provision(client, { ...wanting(SHOP), entry: serving(SHOP, ["hetzner-shop"]) });
    storedReports(fake, [uptimeReportKey(SHOP, "hetzner-shop")]);
    fake.calls.length = 0;
    const read = await inspectUptime(client, ACCOUNT);
    expect(read).toMatchObject({
      accountSubdomain: "opscrew-test",
      workersDev: true,
      reports: [uptimeReportKey(SHOP, "hetzner-shop")],
    });
    expect(fake.writes()).toEqual([]);
    // An upload of the script again keeps the address on.
    await provision(client, { ...wanting(SHOP, { script: script(V2) }), secret: undefined });
    expect((await inspectUptime(client, ACCOUNT)).workersDev).toBe(true);
  });

  it("turns the workers.dev address on only when it is off, and returns the report URL", () => {
    const off = planUptime(facts([SHOP], { workersDev: false }), wanting(SHOP));
    expect(kinds(off)).toEqual(["set-subdomain", "put-secret"]);
    expect(off.reportUrl).toBe("https://opscrew-uptime.opscrew-test.workers.dev/report");
    expect(describeUptimePlan(off)).toContain(
      "Turn on the workers.dev address of the Worker opscrew-uptime, https://opscrew-uptime.opscrew-test.workers.dev, where the servers send their reports (its previews stay off).",
    );
    const on = planUptime(facts([SHOP]), wanting(SHOP));
    expect(kinds(on)).toEqual(["put-secret"]);
    expect(on.reportUrl).toBe(off.reportUrl);
    expect(on.hash).not.toBe(off.hash);
    const none = planUptime(facts([SHOP], { accountSubdomain: null }), wanting(SHOP));
    expect(none.reportUrl).toBeNull();
    expect(none.findings.map((f) => f.code)).toEqual(["workers-dev-missing"]);
    expect(none.findings[0]?.hint).toContain("Open Workers & Pages in Cloudflare's dashboard once");
  });

  it("keeps each server's since from the stored entry, and adds a new server's", () => {
    const read = facts([SHOP]);
    read.entries[uptimeEntryKey(SHOP)] = serving(SHOP, ["hetzner-shop"], T0);
    const same = planUptime(read, {
      ...wanting(SHOP),
      entry: serving(SHOP, ["hetzner-shop"], T1),
      secret: undefined,
    });
    expect(same.changes).toEqual([]);
    const more = planUptime(read, {
      ...wanting(SHOP),
      entry: serving(SHOP, ["hetzner-shop", "own-shop"], T1),
      secret: undefined,
    });
    expect(more.changes).toEqual([
      {
        kind: "put-entry",
        key: uptimeEntryKey(SHOP),
        entry: {
          ...entryFor(SHOP),
          servers: [
            { id: "hetzner-shop", since: T0 },
            { id: "own-shop", since: T1 },
          ],
        },
      },
    ]);
    expect(describeUptimePlan(more)).toContain("and take reports from hetzner-shop and own-shop");
  });

  it("deletes the report key of a server that left, after its entry, and no other's", () => {
    const read = facts([SHOP, BLOG], {
      reports: [
        uptimeReportKey(BLOG, "own-shop"),
        uptimeReportKey(SHOP, "hetzner-shop"),
        uptimeReportKey(SHOP, "own-shop"),
      ],
    });
    read.entries[uptimeEntryKey(SHOP)] = serving(SHOP, ["hetzner-shop", "own-shop"]);
    const plan = planUptime(read, {
      ...wanting(SHOP),
      entry: serving(SHOP, ["hetzner-shop"]),
      secret: undefined,
    });
    expect(plan.changes).toEqual([
      { kind: "put-entry", key: uptimeEntryKey(SHOP), entry: serving(SHOP, ["hetzner-shop"]) },
      { kind: "delete-report", key: uptimeReportKey(SHOP, "own-shop") },
    ]);
    expect(describeUptimePlan(plan)).toContain(
      "Delete the last report of the server own-shop, which no longer reports for acme/shop (prod).",
    );
  });

  it("refuses heartbeatMinutes unless the live test plans it", () => {
    const entry = { ...serving(SHOP, ["hetzner-shop"]), heartbeatMinutes: 10 };
    const plan = planUptime(facts([]), { ...wanting(SHOP), entry });
    expect(plan.findings).toEqual([
      {
        code: "test-only-field",
        message:
          "The uptime entry of acme/shop (prod) sets heartbeatMinutes, which only OpsCrew's live test may set.",
        hint: "This is a bug in OpsCrew; please report it.",
      },
    ]);
    const live = planUptime(facts([]), { ...wanting(SHOP), entry }, { liveTest: true });
    expect(live.findings).toEqual([]);
    expect(live.changes).toContainEqual({ kind: "put-entry", key: uptimeEntryKey(SHOP), entry });
  });

  it("accepts the report key in the secret, and never hashes or shows it", () => {
    const plan = planUptime(facts([]), { ...wanting(SHOP), secret: withReport(SHOP) });
    expect(kinds(plan)).toContain("put-secret");
    expect(JSON.stringify(plan)).not.toContain(REPORT);
    expect(describeUptimePlan(plan)).not.toContain(REPORT);
    const other = sha256Hex(fakeSecret("generic-password", "other-report"));
    expect(planUptime(facts([]), { ...wanting(SHOP), secret: withReport(SHOP, other) }).hash).toBe(
      plan.hash,
    );
    const short = withReport(SHOP, REPORT.slice(0, 40));
    const error = (() => {
      try {
        planUptime(facts([]), { ...wanting(SHOP), secret: short });
      } catch (e) {
        return e;
      }
    })() as OpsCrewError;
    expect(error.code).toBe("INVALID_INPUT");
    expect(errorText(error)).not.toContain(REPORT.slice(0, 40));
  });

  it("refuses an entry whose servers aren't the shape the Worker reads", () => {
    for (const servers of [
      [{ id: "a/b", since: T0 }],
      [{ id: "hetzner-shop", since: "yesterday" }],
    ]) {
      const entry = { ...entryFor(SHOP), servers } as UptimeEntry;
      expect(() => planUptime(facts([]), { ...wanting(SHOP), entry })).toThrow(
        "The uptime entry of acme/shop (prod) is not what the uptime Worker reads",
      );
    }
  });

  it("applies the removal of a server that left, deleting its report key", async () => {
    const { fake, client } = setup();
    await provision(client, {
      ...wanting(SHOP),
      entry: serving(SHOP, ["hetzner-shop", "own-shop"]),
    });
    storedReports(fake, [uptimeReportKey(SHOP, "hetzner-shop"), uptimeReportKey(SHOP, "own-shop")]);
    const result = await provision(client, {
      ...wanting(SHOP),
      entry: serving(SHOP, ["hetzner-shop"]),
      secret: undefined,
    });
    expect(result.applied).toEqual(["put-entry", "delete-report"]);
    const values = fake.namespace("opscrew-uptime")?.values;
    expect(values?.has(uptimeReportKey(SHOP, "own-shop"))).toBe(false);
    expect(values?.has(uptimeReportKey(SHOP, "hetzner-shop"))).toBe(true);
  });

  it("deletes the entry's report keys with the entry, and no other entry's", async () => {
    const { fake, client } = setup();
    await provision(client, { ...wanting(SHOP), entry: serving(SHOP, ["hetzner-shop"]) });
    await provision(client, { ...wanting(BLOG), entry: serving(BLOG, ["hetzner-blog"]) });
    storedReports(fake, [
      uptimeReportKey(SHOP, "hetzner-shop"),
      uptimeReportKey(BLOG, "hetzner-blog"),
    ]);
    // A report the Worker writes after the plan is deleted too: the apply lists them again.
    const plan = await planFor(client, leaving(SHOP));
    storedReports(fake, [uptimeReportKey(SHOP, "own-shop")]);
    await applyUptime(client, plan, leaving(SHOP), plan.hash);
    const keys = [...(fake.namespace("opscrew-uptime")?.values.keys() ?? [])].sort();
    expect(keys).toEqual(
      ["opscrew:worker", uptimeEntryKey(BLOG), uptimeReportKey(BLOG, "hetzner-blog")].sort(),
    );
  });
});
