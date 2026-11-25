/**
 * Live pass of the uptime Worker (feature 046, T4692) on a real Cloudflare account: the adapter's
 * plans (`planUptime`/`applyUptime`) with the real Worker script, its Cron Trigger's real runs,
 * the alerts reaching a real ntfy topic, two apps sharing the Worker, a provision's leaving and the
 * last app's destroy. Skipped unless OPSCREW_E2E_UPTIME=1 and OPSCREW_CLOUDFLARE_TOKEN_B are set
 * (a token with Workers Scripts and Workers KV Storage edit on an account with no `opscrew-uptime`
 * Worker or namespace); see specs/046-uptime-worker/quickstart.md. About 35 minutes, free on
 * Cloudflare's free plan. An account that never opened Workers has no workers.dev subdomain, which
 * a Cron Trigger needs: the pass records the refusal, creates a throwaway one and deletes it at the
 * end. Whatever it created is deleted by its exact name at the end, then the account is listed.
 */
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  applyUptime,
  CloudflareClient,
  describeUptimePlan,
  inspectUptime,
  KvNamespaceExistsError,
  planUptime,
  UptimeApplyError,
  type UptimeDesired,
  type UptimeEntry,
  uptimeEntryKey,
  uptimeSecretName,
  uptimeStateKey,
} from "@opscrew/connector-cloudflare";
import { UPTIME_WORKER, UPTIME_WORKER_SCRIPT, UPTIME_WORKER_SHA256 } from "@opscrew/iac-templates";
import { afterAll, describe, expect, it } from "vitest";
import { CLOUDFLARE_API, minutes } from "./cloud";

const TOKEN = process.env.OPSCREW_CLOUDFLARE_TOKEN_B?.trim().replace(/^(["'])(.*)\1$/, "$2");
const RUN = process.env.OPSCREW_E2E_UPTIME === "1" && Boolean(TOKEN);

const WORKER = UPTIME_WORKER.name;
const NAMESPACE = UPTIME_WORKER.namespace;
const POLL = 60_000;

interface Envelope {
  success: boolean;
  errors: { code: number; message: string }[];
  result: unknown;
  result_info?: unknown;
}

/** A raw Cloudflare API call, for the listings that check the adapter's work independently. */
async function cf(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Envelope }> {
  const response = await fetch(`${CLOUDFLARE_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
  const text = await response.text();
  let body: Envelope;
  try {
    body = JSON.parse(text) as Envelope;
  } catch {
    body = { success: response.ok, errors: [], result: text };
  }
  return { status: response.status, body };
}

interface NtfyMessage {
  time: number;
  title?: string;
  message: string;
  priority: number;
}

/** Every message the topic holds (ntfy.sh keeps them 12 hours). */
async function ntfy(topic: string): Promise<NtfyMessage[]> {
  const response = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=all`);
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as NtfyMessage & { event: string })
    .filter((m) => m.event === "message")
    .map((m) => ({ time: m.time, title: m.title, message: m.message, priority: m.priority ?? 3 }));
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe.skipIf(!RUN)("live uptime Worker (Cloudflare, feature 046)", () => {
  const t0 = Date.now();
  const report: string[] = [];
  const log = (line: string) => {
    const text = `[${((Date.now() - t0) / 60_000).toFixed(1)} min] ${line}`;
    report.push(text);
    console.log(text);
  };
  const client = new CloudflareClient({ token: TOKEN, fetch: globalThis.fetch });
  let accountId = "";
  /** True once step 1 found the account clean: only then is the cleanup this run's to make. */
  let ours = false;
  /** True once this run created the account's workers.dev subdomain, which the cleanup deletes. */
  let subdomainCreated = false;

  const topicA = `opscrew-live-${randomBytes(16).toString("hex")}`;
  const topicB = `opscrew-live-${randomBytes(16).toString("hex")}`;
  const invalid = `opscrew-${randomBytes(4).toString("hex")}.invalid`;
  const idA = "opscrew-live/uptime-a/uptime-a/live";
  const idB = "opscrew-live/uptime-b/uptime-b/live";
  const script = { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 };
  // A later OpsCrew version's script (the same code): its upload must keep every app's secret.
  const nextContent = `${UPTIME_WORKER_SCRIPT}// live pass: the next version\n`;
  const nextScript = { content: nextContent, sha256: sha256(nextContent) };

  const entry = (id: string, hosts: UptimeEntry["hosts"]): UptimeEntry => {
    const [owner, repo, app, environment] = id.split("/") as [string, string, string, string];
    return {
      version: 1,
      repository: `${owner}/${repo}`,
      app,
      environment,
      hosts,
      webhook: "ntfy",
      secret: uptimeSecretName(id),
    };
  };

  /** Plans one environment's change from a fresh read, logs the plan, applies it by its hash. */
  async function apply(step: string, desired: UptimeDesired) {
    const facts = await inspectUptime(client, accountId);
    const plan = planUptime(facts, desired);
    log(`${step}: ${describeUptimePlan(plan).replace(/\n/g, "\n    ")}`);
    expect(plan.findings, JSON.stringify(plan.findings)).toEqual([]);
    const started = Date.now();
    const result = await applyUptime(client, plan, desired, plan.hash);
    log(`${step}: applied ${result.applied.join(", ")} in ${Date.now() - started} ms`);
    for (const note of result.notes) log(`${step}: note: ${note}`);
    return { plan, result };
  }

  async function workers(): Promise<string[]> {
    const { body } = await cf(`/accounts/${accountId}/workers/scripts`);
    expect(body.success, JSON.stringify(body.errors)).toBe(true);
    return (body.result as { id: string }[]).map((w) => w.id);
  }

  async function namespaces(): Promise<{ id: string; title: string }[]> {
    const { body } = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
    expect(body.success, JSON.stringify(body.errors)).toBe(true);
    return body.result as { id: string; title: string }[];
  }

  async function namespaceId(): Promise<string | undefined> {
    return (await namespaces()).find((n) => n.title === NAMESPACE)?.id;
  }

  async function secrets(): Promise<string[] | undefined> {
    const { status, body } = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/secrets`);
    if (status === 404) return undefined;
    expect(body.success, JSON.stringify(body.errors)).toBe(true);
    return (body.result as { name: string; type: string }[]).map((s) => `${s.name}:${s.type}`);
  }

  async function schedules(): Promise<string[]> {
    const { body } = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/schedules`);
    expect(body.success, JSON.stringify(body.errors)).toBe(true);
    return (body.result as { schedules: { cron: string }[] }).schedules.map((s) => s.cron);
  }

  async function keys(ns: string): Promise<string[]> {
    const { body } = await cf(`/accounts/${accountId}/storage/kv/namespaces/${ns}/keys`);
    expect(body.success, JSON.stringify(body.errors)).toBe(true);
    return (body.result as { name: string }[]).map((k) => k.name).sort();
  }

  /** A KV value, parsed; undefined when the key is missing. */
  async function value(ns: string, key: string): Promise<unknown> {
    // A value is answered as it is stored, not in Cloudflare's envelope.
    const response = await fetch(
      `${CLOUDFLARE_API}/accounts/${accountId}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );
    const text = await response.text();
    if (response.status === 404) return undefined;
    expect(response.status, text.slice(0, 200)).toBe(200);
    return JSON.parse(text);
  }

  type HostState = { status: string; since: string; reason: string };
  const stateOf = async (ns: string, id: string) =>
    (await value(ns, uptimeStateKey(id))) as { hosts: Record<string, HostState> } | undefined;

  /** The latest deployment's version, and the latest version's id. */
  async function deployed(): Promise<{ serving?: string; latest?: string; versions: number }> {
    const versions = (await client.listWorkerVersions(accountId, WORKER)) ?? [];
    const [deployment] = (await client.listWorkerDeployments(accountId, WORKER)) ?? [];
    const serving = deployment?.versions.find((v) => v.percentage === 100)?.id;
    return { serving, latest: versions[0]?.id, versions: versions.length };
  }

  afterAll(async () => {
    if (accountId === "") return;
    if (ours) {
      // By exact name: the Worker (its trigger and secrets go with it), then the namespace.
      const worker = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}`, {
        method: "DELETE",
      });
      log(`cleanup: DELETE Worker ${WORKER}: HTTP ${worker.status}`);
      for (const ns of (await namespaces()).filter((n) => n.title === NAMESPACE)) {
        const gone = await cf(`/accounts/${accountId}/storage/kv/namespaces/${ns.id}`, {
          method: "DELETE",
        });
        log(`cleanup: DELETE namespace ${NAMESPACE}: HTTP ${gone.status}`);
      }
    }
    if (subdomainCreated) {
      const gone = await cf(`/accounts/${accountId}/workers/subdomain`, { method: "DELETE" });
      log(`cleanup: DELETE the workers.dev subdomain: HTTP ${gone.status}`);
    }
    const sub = await cf(`/accounts/${accountId}/workers/subdomain`);
    log(
      `listing: workers.dev subdomain: ${sub.body.success ? "present" : JSON.stringify(sub.body.errors.map((e) => e.code))}`,
    );
    log(`listing: Workers [${(await workers()).join(", ")}]`);
    log(`listing: KV namespaces [${(await namespaces()).map((n) => n.title).join(", ")}]`);
    const left = await secrets();
    log(`listing: ${WORKER} secrets ${left === undefined ? "(no such Worker)" : left.join(", ")}`);
    console.log(`\nREPORT\n${report.join("\n")}`);
  }, minutes(2));

  it("runs the uptime Worker end to end and leaves nothing behind", {
    timeout: minutes(60),
  }, async () => {
    // --- 1. The account starts clean ---
    const accounts = await cf("/accounts");
    expect(accounts.body.success, JSON.stringify(accounts.body.errors)).toBe(true);
    const list = accounts.body.result as { id: string }[];
    expect(list.length, "the token reaches exactly one account").toBe(1);
    accountId = (list[0] as { id: string }).id;
    const before = { workers: await workers(), namespaces: await namespaces() };
    log(
      `1: Workers [${before.workers.join(", ")}], KV namespaces [${before.namespaces.map((n) => n.title).join(", ")}]`,
    );
    expect(before.workers, "an opscrew-uptime Worker exists: not this run's").not.toContain(WORKER);
    expect(
      before.namespaces.map((n) => n.title),
      "a namespace exists: not this run's",
    ).not.toContain(NAMESPACE);
    expect(await secrets(), "secrets of a missing Worker").toBeUndefined();
    ours = true;
    const empty = await inspectUptime(client, accountId);
    expect(empty).toMatchObject({ namespaceId: null, sha256: null, secrets: null, denied: [] });
    log("1: passed, inspectUptime reads a clean account (secrets null, nothing denied)");

    // --- 2. Create: entry A ---
    const hostsA = [
      { hostname: "example.com", healthPath: "/" },
      { hostname: invalid, healthPath: "/" },
      // Answers 404 now; step 5 points it at "/", which answers 200: a real recovery.
      { hostname: "www.example.com", healthPath: "/opscrew-live-missing" },
    ];
    const secretA = JSON.stringify({ url: `https://ntfy.sh/${topicA}` });
    const desiredA: UptimeDesired = { id: idA, entry: entry(idA, hostsA), secret: secretA, script };
    let created: Awaited<ReturnType<typeof apply>>;
    try {
      created = await apply("2", desiredA);
      expect(created.result.applied).toEqual([
        "create-namespace",
        "upload-script",
        "put-secret",
        "put-entry",
      ]);
    } catch (error) {
      // An account that never opened Workers has no workers.dev subdomain (seen live, run 1).
      if (
        !(error instanceof UptimeApplyError) ||
        !error.message.includes("workers.dev subdomain")
      ) {
        throw error;
      }
      log(
        `2: the apply stopped (${error.code}, applied ${error.applied.join(", ")}): ${error.message}`,
      );
      const probe = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/schedules`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([{ cron: UPTIME_WORKER.cron }]),
      });
      log(
        `2: a raw PUT of the schedule: HTTP ${probe.status} ${JSON.stringify(probe.body.errors)}`,
      );
      const made = await cf(`/accounts/${accountId}/workers/subdomain`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subdomain: `opscrew-live-${randomBytes(4).toString("hex")}` }),
      });
      expect(made.body.success, JSON.stringify(made.body.errors)).toBe(true);
      subdomainCreated = true;
      log("2: created a throwaway workers.dev subdomain; planning again from the partial apply");
      created = await apply("2 (again)", desiredA);
      expect(created.result.applied).toEqual(["upload-script", "put-secret", "put-entry"]);
      const route = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/subdomain`);
      log(`2: the Worker's workers.dev route: ${JSON.stringify(route.body.result)}`);
    }
    const appliedAt = Date.now();
    const ns = (await namespaceId()) as string;
    expect(ns).toBeDefined();
    expect(await workers()).toContain(WORKER);
    expect(await schedules()).toEqual([UPTIME_WORKER.cron]);
    expect(await secrets()).toEqual([`${uptimeSecretName(idA)}:secret_text`]);
    expect(await keys(ns)).toEqual([`entry:${idA}`, "opscrew:worker"].sort());
    expect(await value(ns, uptimeEntryKey(idA))).toEqual(entry(idA, hostsA));
    expect(await value(ns, "opscrew:worker")).toEqual({ sha256: UPTIME_WORKER_SHA256 });
    log(
      `2: passed: Worker, trigger ${(await schedules()).join(" ")}, namespace, secret, keys [${(await keys(ns)).join(", ")}]`,
    );
    // The client's reading of Cloudflare's answers for a duplicate title and a missing key.
    await expect(client.createKvNamespace(accountId, NAMESPACE)).rejects.toBeInstanceOf(
      KvNamespaceExistsError,
    );
    expect(await client.getKv(accountId, ns, "opscrew:live-missing")).toBeUndefined();
    log("2: a duplicate namespace title is KvNamespaceExistsError; a missing key reads undefined");

    // --- 3. Two apps at once: entry B ---
    const deployBefore = await deployed();
    const secretB = JSON.stringify({ url: `https://ntfy.sh/${topicB}` });
    const hostsB = [{ hostname: "example.com", healthPath: "/" }];
    const second = await apply("3", {
      id: idB,
      entry: entry(idB, hostsB),
      secret: secretB,
      script,
    });
    expect(second.plan.expect.others).toEqual([uptimeEntryKey(idA)]);
    expect(second.result.applied).toEqual(["put-secret", "put-entry"]);
    expect((await secrets())?.sort()).toEqual(
      [`${uptimeSecretName(idA)}:secret_text`, `${uptimeSecretName(idB)}:secret_text`].sort(),
    );
    expect(await value(ns, uptimeEntryKey(idA))).toEqual(entry(idA, hostsA));
    expect(await value(ns, uptimeEntryKey(idB))).toEqual(entry(idB, hostsB));
    const deployAfter = await deployed();
    log(
      `3: versions ${deployBefore.versions} -> ${deployAfter.versions}; serving ${deployBefore.serving} -> ${deployAfter.serving}; latest ${deployAfter.latest}`,
    );
    expect
      .soft(deployAfter.serving, "the secret's PUT deployed a new version")
      .not.toBe(deployBefore.serving);
    expect.soft(deployAfter.serving, "the deployed version is the latest").toBe(deployAfter.latest);
    // R4 asked whether an upload at the same moment as another secret's PUT keeps that secret.
    // It didn't on 2026-11-25 (the secret was lost): recorded, not asserted, since the adapter's
    // apply reads its own secret back at its end (`checkWritten`) and stops when it is missing.
    const race = "HOOK_0000000000000000";
    await Promise.all([
      client.uploadWorkerModule(accountId, WORKER, {
        content: UPTIME_WORKER_SCRIPT,
        compatibilityDate: UPTIME_WORKER.compatibilityDate,
        bindings: [{ type: "kv_namespace", name: UPTIME_WORKER.binding, namespace_id: ns }],
        keepBindings: ["secret_text"],
      }),
      client.putWorkerSecret(accountId, WORKER, {
        name: race,
        text: JSON.stringify({ url: "https://example.invalid/" }),
      }),
    ]);
    const raced = (await secrets()) ?? [];
    log(`3: after a concurrent upload and secret PUT: secrets [${raced.join(", ")}]`);
    log(
      `3: the concurrent secret ${raced.includes(`${race}:secret_text`) ? "was kept" : "was lost"}`,
    );
    expect(raced).toContain(`${uptimeSecretName(idA)}:secret_text`);
    expect(raced).toContain(`${uptimeSecretName(idB)}:secret_text`);
    if (raced.includes(`${race}:secret_text`))
      await client.deleteWorkerSecret(accountId, WORKER, race);
    expect(await secrets()).not.toContain(`${race}:secret_text`);
    log("3: passed: both entries and both secrets kept");

    // --- 4. Real cron runs ---
    let suspectAt: number | undefined;
    let downAt: number | undefined;
    let down: { hosts: Record<string, HostState> } | undefined;
    while (Date.now() < appliedAt + minutes(25)) {
      const state = await stateOf(ns, idA);
      const posted = await ntfy(topicA);
      expect.soft(await value(ns, uptimeStateKey(idB)), "B has no state").toBeUndefined();
      expect.soft(await ntfy(topicB), "B posts nothing").toEqual([]);
      const statuses = Object.values(state?.hosts ?? {}).map((h) => h.status);
      if (suspectAt === undefined && statuses.length > 0) {
        suspectAt = Date.now();
        log(
          `4: first run seen ${((suspectAt - appliedAt) / 60_000).toFixed(1)} min after the apply (${new Date(suspectAt).toISOString()}): ${JSON.stringify(state)}`,
        );
        expect.soft(statuses, "the first failure is suspect").toEqual(["suspect", "suspect"]);
        expect.soft(posted, "nothing posted at suspect").toEqual([]);
      }
      if (statuses.length > 0 && statuses.every((s) => s === "down")) {
        downAt = Date.now();
        down = state;
        log(`4: down seen at ${new Date(downAt).toISOString()}: ${JSON.stringify(state)}`);
        break;
      }
      await sleep(POLL);
    }
    expect(suspectAt, "a run marked A's hostnames suspect within 25 minutes").toBeDefined();
    expect(downAt, "a second run marked them down within 25 minutes").toBeDefined();
    expect(Object.keys(down?.hosts ?? {}).sort()).toEqual([invalid, "www.example.com"].sort());
    expect(down?.hosts[invalid]?.reason).toBe("not reachable");
    expect(down?.hosts["www.example.com"]?.reason).toBe("answered with status 404");
    const downs = await ntfy(topicA);
    for (const m of downs) log(`4: ntfy priority ${m.priority}: ${m.title} | ${m.message}`);
    expect(downs).toHaveLength(2);
    for (const m of downs) {
      expect(m.priority).toBe(4);
      expect(m.title).toBe("OpsCrew uptime check: uptime-a (live) is down");
    }
    expect(downs.filter((m) => m.message.includes(`on ${invalid}: not reachable`))).toHaveLength(1);
    expect(
      downs.filter((m) => m.message.includes("on www.example.com: answered with status 404")),
    ).toHaveLength(1);
    // One more run: still down, nothing posted, nothing written.
    const boundary = Math.ceil((downAt as number) / minutes(5)) * minutes(5);
    await sleep(Math.max(0, boundary + minutes(2) - Date.now()));
    expect(await ntfy(topicA)).toHaveLength(2);
    expect(await stateOf(ns, idA)).toEqual(down);
    log("4: passed: a later run posted and wrote nothing; B stayed up with no state");

    // --- 5. Recovered, by a later OpsCrew version (its upload keeps B's secret) ---
    const hostsA2 = [
      { hostname: "example.com", healthPath: "/" },
      { hostname: "www.example.com", healthPath: "/" },
    ];
    const recovered = await apply("5", {
      id: idA,
      entry: entry(idA, hostsA2),
      secret: secretA,
      script: nextScript,
    });
    const recoveredAt = Date.now();
    expect(recovered.result.applied).toEqual(["upload-script", "put-secret", "put-entry"]);
    expect((await secrets())?.sort()).toEqual(
      [`${uptimeSecretName(idA)}:secret_text`, `${uptimeSecretName(idB)}:secret_text`].sort(),
    );
    log("5: the upload kept B's secret");
    let up: NtfyMessage[] = [];
    while (Date.now() < recoveredAt + minutes(12)) {
      up = (await ntfy(topicA)).slice(2);
      if (up.length > 0 && (await stateOf(ns, idA)) === undefined) break;
      await sleep(POLL);
    }
    for (const m of up) log(`5: ntfy priority ${m.priority}: ${m.title} | ${m.message}`);
    expect(up).toHaveLength(1);
    expect(up[0]?.priority).toBe(3);
    expect(up[0]?.title).toBe("OpsCrew uptime check: uptime-a (live) is up again");
    expect(up[0]?.message).toMatch(/is up again on www\.example\.com, after \d+ minutes?\./);
    expect(await stateOf(ns, idA)).toBeUndefined();
    log(`5: passed ${((Date.now() - recoveredAt) / 60_000).toFixed(1)} min after the apply`);

    // --- 6. B leaves through a provision ---
    const leaving = await apply("6", { id: idB, script: nextScript });
    expect(leaving.result.applied).toEqual(["delete-entry", "delete-secret"]);
    expect(leaving.plan.destroys).toBe(false);
    expect(await workers()).toContain(WORKER);
    expect(await secrets()).toEqual([`${uptimeSecretName(idA)}:secret_text`]);
    expect(await keys(ns)).toEqual([`entry:${idA}`, "opscrew:worker"].sort());
    log("6: passed: only B's entry and secret went; the Worker stays");

    // --- 7. Destroy A, the last entry ---
    const destroyed = await apply("7", { id: idA, destroy: true, script: nextScript });
    expect(destroyed.plan.destroys).toBe(true);
    expect(destroyed.result.applied).toEqual([
      "delete-entry",
      "delete-secret",
      "delete-script",
      "delete-namespace",
    ]);

    // --- 8. Nothing left ---
    expect(await workers()).not.toContain(WORKER);
    expect((await namespaces()).map((n) => n.title)).not.toContain(NAMESPACE);
    expect(await secrets()).toBeUndefined();
    const gone = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/schedules`);
    log(`8: schedules of the deleted Worker: HTTP ${gone.status}`);
    expect(gone.status).toBe(404);
    log("7-8: passed: the Worker, its trigger and the namespace are gone");
  });
});
