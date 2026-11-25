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
  planUptime,
  UptimeApplyError,
  type UptimeDesired,
  type UptimeEntry,
  type UptimeFacts,
  uptimeEntryKey,
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
      denied: [],
    });
    expect(fake.writes()).toEqual([]);
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
    expect(kinds(plan)).toEqual(["create-namespace", "upload-script", "put-secret", "put-entry"]);
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

  it("refuses an entry that isn't the environment's", () => {
    expect(() => planUptime(facts([]), { ...wanting(SHOP), entry: entryFor(BLOG) })).toThrowError(
      /cannot write/,
    );
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
      applied: ["create-namespace", "upload-script", "put-secret", "put-entry"],
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
      `PUT ${worker}/secrets`,
      `PUT ${kv}/${id}/values/${encodeURIComponent(uptimeEntryKey(SHOP))}`,
    ]);
    const uploaded = fake.scripts.get("opscrew-uptime");
    expect(uploaded).toMatchObject({
      content: V1,
      compatibilityDate: "2026-10-01",
      bindings: [{ type: "kv_namespace", name: "UPTIME", namespace_id: id }],
      crons: ["*/5 * * * *"],
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
      ["create-namespace", "upload-script", "put-secret", "put-entry"],
      ["create-namespace", "upload-script", "put-secret", "put-entry"],
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

  it("fails with 'run the command again' when its secret is missing at the end", async () => {
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
      "put-secret",
      "put-entry",
    ]);
    expect(error.message).toContain(`the Worker secret ${uptimeSecretName(SHOP)}`);
    expect(error.hint).toContain("Run the command again");
    // Running it again plans the secret back.
    expect(kinds(await planFor(client, wanting(SHOP)))).toEqual(["put-secret"]);
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
    expect((error as UptimeApplyError).applied).toEqual(["create-namespace", "upload-script"]);
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
