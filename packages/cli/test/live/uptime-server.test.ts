/**
 * The live pass of the uptime Worker's server part (feature 046, User Story 4, T4694; docs/e2e.md
 * "The uptime Worker's server reports"). A throwaway Hetzner server set up as the user's own
 * carries a real app (examples/flask-sqlite, DNS only, through `opscrew provision` and its first
 * deploy). Its systemd timer reports the server's own checks to the shared Worker `opscrew-uptime`
 * in the Cloudflare account of `OPSCREW_CLOUDFLARE_TOKEN_B` (the Worker's own pass's account),
 * and the Worker posts to ntfy: quickstart.md's steps 9 to 12a, the timer's removal in 13 and 14,
 * and 15. The Worker's plans go through the Cloudflare adapter (`planUptime`/`applyUptime`), the
 * timer's through the host adapter (`planUptimeReport`/`applyHostPlan`), each applied by its
 * hash; the app's teardown is `opscrew destroy --undo-host`. The test itself only fills the disk
 * (`fallocate`), stops and starts the timer (`systemctl`), reads the files' modes (`stat`) and
 * sends requests to the Worker's address.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  applyUptime,
  CloudflareClient,
  describeUptimePlan,
  inspectUptime,
  planUptime,
  type UptimeDesired,
  type UptimeEntry,
  type UptimePlan,
  uptimeEntryKey,
  uptimeReportKey,
  uptimeSecretName,
  uptimeStateKey,
} from "@opscrew/connector-cloudflare";
import {
  applyHostPlan,
  type DesiredUptimeReport,
  type HostPlan,
  hostPlanHash,
  inspectUptimeReport,
  planUptimeReport,
  UPTIME_REPORT_CONFIG_DIR,
  UPTIME_REPORT_SCRIPT,
  UPTIME_REPORT_SERVICE_UNIT,
  UPTIME_REPORT_TIMER_UNIT,
  UPTIME_REPORT_USER_AGENT,
  uptimeReportInstance,
  uptimeReportTimer,
} from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import {
  CHECK_THRESHOLDS,
  checkEnvironmentKey,
  checkHosts,
  snapshotParts,
  UPTIME_WORKER,
  UPTIME_WORKER_SCRIPT,
  UPTIME_WORKER_SHA256,
} from "@opscrew/iac-templates";
import { credentialMaxAgeDaysOf, type DeployPlan, snapshotScheduleOf } from "@opscrew/plan-schema";
import { describe, expect } from "vitest";
import { api, CLOUDFLARE_API, HETZNER_API, minutes, sleep, waitFor } from "./cloud";
import {
  AppEnvironments,
  environmentNames,
  opscrewUntilApproved,
  type SecretsRecord,
} from "./environment-checks";
import { LiveRun, serverSettings } from "./harness";
import { secretNames } from "./portainer-cloud";
import { listedCredentials } from "./rotation-support";
import {
  diskPercent,
  fillBytes,
  heartbeatBody,
  type NtfyMessage,
  type ReportedDate,
  reportedCredentials,
  reportSignature,
  type StoredReport,
  sshInvocation,
  titlesOf,
  UPTIME_SERVER_GATE,
  uptimeServerMissing,
} from "./uptime-server-support";

const ENV = process.env;
const MISSING = uptimeServerMissing(ENV);
const APP = "flask-sqlite";
const SETTINGS = { ...serverSettings(ENV, "OPSCREW_E2E_UPTIME_SERVER_TYPE"), app: APP };
const unquoted = (value: string | undefined) =>
  (value ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
/** The Worker's account: the Worker's own pass's token (Workers Scripts and Workers KV Storage edit). */
const WORKER_TOKEN = unquoted(ENV.OPSCREW_CLOUDFLARE_TOKEN_B);
const TOPIC_A = unquoted(ENV.OPSCREW_E2E_NTFY_TOPIC);

if (MISSING.length > 0 && ENV[UPTIME_SERVER_GATE] === "1") {
  console.warn(
    `OpsCrew E2E (uptime server): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "The uptime Worker's server reports").`,
  );
}

const WORKER = UPTIME_WORKER.name;
const NAMESPACE = UPTIME_WORKER.namespace;
const POLL = 20_000;
const FILL = "/var/tmp/opscrew-e2e-uptime-fill";
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

interface Envelope {
  success: boolean;
  errors: { code: number; message: string }[];
  result: unknown;
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live uptime Worker, the server's reports (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : `live uptime Worker, the server's reports: examples/${APP} on a throwaway server as your own`,
  () => {
    const run = new LiveRun({ label: "uptime server", name: "uptime", settings: SETTINGS });
    const { log } = run;
    const envs = new AppEnvironments(run, "");
    const client = new CloudflareClient({ token: WORKER_TOKEN, fetch: globalThis.fetch });
    const topicB = `opscrew-live-${randomBytes(16).toString("hex")}`;
    const keyA = randomBytes(32).toString("hex");
    const keyB = randomBytes(32).toString("hex");
    run.scrubber.add(WORKER_TOKEN, "cloudflare-token-b");
    run.scrubber.add(TOPIC_A, "ntfy-topic");
    run.scrubber.add(topicB, "ntfy-topic-b");
    run.scrubber.add(keyA, "report-key-a");
    run.scrubber.add(keyB, "report-key-b");
    const passStarted = Math.floor(Date.now() / 1000);

    let hostKey = "";
    let accountId = "";
    /** True once step 9 found the Worker's account clean: only then is its cleanup this run's. */
    let ours = false;
    /** True once this run created the account's workers.dev subdomain, which it deletes again. */
    let subdomainCreated = false;
    let plan: DeployPlan | undefined;
    let secrets: SecretsRecord | undefined;
    let reportUrl = "";
    let serverId = "";
    let idA = "";
    let idB = "";
    let dates: ReportedDate[] = [];
    let rotated = "";
    /** Provision ran, so the leak search must have seen its Cloudflare plan and record. */
    let provisioned = false;
    /** Step 14 deleted the Worker, so step 15 checks that nothing of it is left. */
    let workerDestroyed = false;
    /** The Worker's tail session (its log lines, for the report), while one is open. */
    let tail: WebSocket | undefined;
    /** What the tail showed: each request or cron run, its answer and the Worker's log lines. */
    const tailEvents: { what: string; status?: number; logs: string[] }[] = [];
    let tailShown = 0;

    // --- Helpers ------------------------------------------------------------------------------

    /** A raw Cloudflare API call in the Worker's account, for listings independent of the adapter. */
    async function cf(path: string, init: RequestInit = {}) {
      const response = await fetch(`${CLOUDFLARE_API}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${WORKER_TOKEN}`, ...init.headers },
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

    async function namespaceId(): Promise<string> {
      const id = (await namespaces()).find((n) => n.title === NAMESPACE)?.id;
      if (id === undefined) throw new Error(`The account has no KV namespace ${NAMESPACE}.`);
      return id;
    }

    async function workerSecrets(): Promise<string[] | undefined> {
      const { status, body } = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/secrets`);
      if (status === 404) return undefined;
      expect(body.success, JSON.stringify(body.errors)).toBe(true);
      return (body.result as { name: string }[]).map((s) => s.name).sort();
    }

    /** Every KV key with its metadata. */
    async function kvKeys(): Promise<{ name: string; metadata?: { at?: number } }[]> {
      const ns = await namespaceId();
      const { body } = await cf(`/accounts/${accountId}/storage/kv/namespaces/${ns}/keys`);
      expect(body.success, JSON.stringify(body.errors)).toBe(true);
      return body.result as { name: string; metadata?: { at?: number } }[];
    }

    /** A KV value, parsed; undefined when the key is missing. */
    async function kvValue(key: string): Promise<unknown> {
      const ns = await namespaceId();
      const response = await fetch(
        `${CLOUDFLARE_API}/accounts/${accountId}/storage/kv/namespaces/${ns}/values/${encodeURIComponent(key)}`,
        { headers: { Authorization: `Bearer ${WORKER_TOKEN}` } },
      );
      const text = await response.text();
      if (response.status === 404) return undefined;
      expect(response.status, text.slice(0, 200)).toBe(200);
      return JSON.parse(text);
    }

    /** The time (Unix seconds) of the server's last report the Worker kept for `id`. */
    async function reportAt(id: string): Promise<number | undefined> {
      const key = uptimeReportKey(id, serverId);
      return (await kvKeys()).find((k) => k.name === key)?.metadata?.at;
    }

    /** The messages a topic holds since the pass started (ntfy.sh keeps them 12 hours). */
    async function ntfy(topic: string): Promise<NtfyMessage[]> {
      const response = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=${passStarted}`);
      const text = await response.text();
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as NtfyMessage & { event: string })
        .filter((m) => m.event === "message");
    }

    /**
     * Waits up to `timeoutMs` for `count` messages on `topic` whose titles hold every part. ntfy.sh
     * refuses some of the Worker's posts (HTTP 429: Workers share their addresses), and the message
     * goes again at the next run, so a wait for a server's message takes up to six runs.
     */
    async function waitForTitles(
      topic: string,
      parts: string[],
      timeoutMs: number,
      count = 1,
    ): Promise<string[]> {
      const what = parts.join(" … ");
      log(`waiting up to ${timeoutMs / 60_000} minutes for "${what}"`);
      const started = Date.now();
      try {
        const titles = await waitFor(
          `the ntfy message "${what}"`,
          timeoutMs,
          async () => {
            // A poll this computer could not send (its network) counts as nothing yet.
            const messages = await ntfy(topic).catch(() => undefined);
            if (messages === undefined) return undefined;
            const found = titlesOf(messages, ...parts);
            return found.length >= count ? found : undefined;
          },
          POLL,
        );
        log(`"${what}" came after ${((Date.now() - started) / 60_000).toFixed(1)} minutes`);
        return titles;
      } catch (error) {
        await diagnose(`no "${what}"`);
        throw error;
      }
    }

    /**
     * Opens a tail session on the Worker (read-only), whose events show each request's answer and
     * the Worker's own log lines: names, statuses and reasons, never a key or an address. A token
     * that may not open one leaves the report without them.
     */
    async function startTail(): Promise<void> {
      const made = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/tails`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!made.body.success) {
        log(
          `the Worker's tail was refused (HTTP ${made.status}, ${made.body.errors.map((e) => e.code).join(", ")}): its log lines are not shown`,
        );
        return;
      }
      const { url } = made.body.result as { url: string };
      const socket = new WebSocket(url, "trace-v1");
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => socket.send(JSON.stringify({ debug: false })));
      socket.addEventListener("message", (event) => {
        const text =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(event.data as ArrayBuffer).toString("utf8");
        try {
          const e = JSON.parse(text) as {
            event?: {
              cron?: string;
              request?: { method?: string; url?: string };
              response?: { status?: number };
            } | null;
            logs?: { message?: unknown[] }[];
            exceptions?: { message?: string }[];
          };
          const request = e.event?.request;
          tailEvents.push({
            what:
              e.event?.cron !== undefined
                ? "cron"
                : `${request?.method ?? "?"} ${request?.url === undefined ? "?" : new URL(request.url).pathname}`,
            ...(e.event?.response?.status === undefined ? {} : { status: e.event.response.status }),
            logs: [
              ...(e.logs ?? []).map((line) => (line.message ?? []).map(String).join(" ")),
              ...(e.exceptions ?? []).map((x) => `exception: ${x.message ?? "?"}`),
            ],
          });
        } catch {
          // Not an event.
        }
      });
      tail = socket;
      log("opened a tail session on the Worker");
    }

    /** The tail's events since the last call, each request kind with its answers and log lines. */
    function logTail(label: string): void {
      const fresh = tailEvents.slice(tailShown);
      tailShown = tailEvents.length;
      if (tail === undefined || fresh.length === 0) return;
      const counts = new Map<string, number>();
      for (const e of fresh) {
        const key = `${e.what}${e.status === undefined ? "" : ` ${e.status}`}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const lines = [...new Set(fresh.flatMap((e) => e.logs))];
      log(
        `${label}: the Worker's tail: ${[...counts].map(([key, n]) => `${key} ×${n}`).join(", ")}${lines.length === 0 ? "; no log line" : `; its log lines:\n    ${lines.join("\n    ")}`}`,
      );
    }

    /** When a wait gave up: the timers' last journal lines and what the Worker's tail showed. */
    async function diagnose(why: string): Promise<void> {
      try {
        if (idA !== "") {
          const lines = await shell(
            `journalctl -u ${timerOf(idA).replace(/timer$/, "service")} -u ${timerOf(idB).replace(/timer$/, "service")} --no-pager -o cat | grep '^uptime report: ' | tail -n 6 || true`,
          );
          log(`${why}: the timers' last journal lines:\n    ${lines.replace(/\n/g, "\n    ")}`);
        }
      } catch (error) {
        log(`${why}: the journal could not be read (${String(error)})`);
      }
      logTail(why);
    }

    function closeTail(): void {
      tail?.close();
      tail = undefined;
    }

    /** Root on the server through OpsCrew's own way of sending commands and secrets over SSH. */
    function rootRemote(): RemoteExec {
      const args = [
        "-i",
        run.keyFile,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${run.knownHostsFile}`,
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ServerAliveInterval=15",
        `root@${run.ipv4()}`,
      ];
      return {
        host: run.ipv4(),
        run: (command, options = {}) => {
          const sent = sshInvocation(command, options.input);
          return run.runner.run("ssh", [...args, sent.command], {
            env: run.env,
            timeoutMs: options.timeoutMs ?? 60_000,
            ...(sent.input === undefined ? {} : { input: sent.input }),
          });
        },
      };
    }

    const shell = (command: string) => run.shell().ok(command, minutes(3));
    const currentPlan = () => plan as DeployPlan;

    /** The id of the app's environment in the Worker, with `env` instead of prod's. */
    function entryId(env = "prod"): string {
      const key = checkEnvironmentKey(currentPlan());
      return `${SETTINGS.githubRepo}/${key.slice(0, key.lastIndexOf("/"))}/${env}`;
    }

    /** The entry the agents write for the environment `id`, with the server that reports. */
    function entryOf(id: string, extra: Partial<UptimeEntry> = {}): UptimeEntry {
      const parts = id.split("/");
      return {
        version: 1,
        repository: SETTINGS.githubRepo,
        app: parts[2] as string,
        environment: parts[3] as string,
        hosts: checkHosts(currentPlan()),
        webhook: "ntfy",
        secret: uptimeSecretName(id),
        servers: [{ id: serverId, since: `${new Date().toISOString().slice(0, 10)}T00:00:00Z` }],
        rotate: id === idA ? "" : ` --env ${parts[3]}`,
        ...extra,
      };
    }

    const secretOf = (topic: string, key: string) =>
      JSON.stringify({ url: `https://ntfy.sh/${topic}`, report: key });

    /** One environment's Cloudflare plan from a fresh read, logged and applied by its hash. */
    async function applyWorker(
      step: string,
      desired: UptimeDesired,
      options: { liveTest?: boolean } = {},
    ): Promise<{ plan: UptimePlan; applied: string[] }> {
      const facts = await inspectUptime(client, accountId);
      const planned = planUptime(facts, desired, options);
      log(`${step}: ${describeUptimePlan(planned).replace(/\n/g, "\n    ")}`);
      expect(planned.findings, JSON.stringify(planned.findings)).toEqual([]);
      const result = await applyUptime(client, planned, desired, planned.hash);
      log(`${step}: applied ${result.applied.join(", ")} (Cloudflare plan hash ${planned.hash})`);
      for (const note of result.notes) log(`${step}: note: ${note}`);
      return { plan: planned, applied: result.applied };
    }

    /** The report's settings on the server for `entry`, as the agents' `reportSettings` makes them. */
    function settingsOf(
      entry: string,
      key: string,
      credentials: ReportedDate[],
    ): DesiredUptimeReport {
      const p = currentPlan();
      const drill =
        snapshotScheduleOf(p) === undefined || snapshotParts(p).length === 0
          ? undefined
          : p.snapshots?.drills?.schedule;
      return {
        url: reportUrl,
        entry,
        server: serverId,
        ...(drill === undefined ? {} : { drill }),
        hosts: checkHosts(p).map((host) => host.hostname),
        thresholds: {
          diskWarn: CHECK_THRESHOLDS.diskWarn,
          diskHigh: CHECK_THRESHOLDS.diskHigh,
          certDays: CHECK_THRESHOLDS.certDays,
        },
        credentials: { maxAgeDays: credentialMaxAgeDaysOf(p), dates: credentials },
        keySha256: sha256(key),
      };
    }

    /** A host plan for the uptime report from a fresh inspection, logged and applied by its hash. */
    async function applyReport(
      step: string,
      change: { enable: DesiredUptimeReport; key: string } | { disable: string },
    ): Promise<HostPlan> {
      const remote = rootRemote();
      const facts = await inspectUptimeReport(remote);
      const hostPlan = planUptimeReport({
        app: currentPlan().app.name,
        facts,
        ...("enable" in change
          ? { enable: change.enable }
          : { disable: { entry: change.disable } }),
      });
      const hash = hostPlanHash(hostPlan);
      for (const item of hostPlan.steps) {
        log(
          `${step}: host plan step ${item.id} (${item.state}): ${item.title}. ${item.reason ?? ""}`,
        );
      }
      log(`${step}: Host plan hash: ${hash}`);
      const result = await applyHostPlan(remote, hostPlan, {
        approvedHash: hash,
        command: "the live test",
        verifyLogin: async () => true,
        ...("enable" in change ? { secrets: { uptimeReportKey: change.key } } : {}),
      });
      log(`${step}: applied ${result.applied.join(", ") || "nothing"} on the server`);
      return hostPlan;
    }

    const timers = async () =>
      (await shell("systemctl list-timers 'opscrew-uptime-report@*' --all --no-legend --no-pager"))
        .split("\n")
        .flatMap((line) => line.match(/opscrew-uptime-report@[0-9a-f]{16}\.timer/g) ?? [])
        .sort();
    const instanceOf = (id: string) => uptimeReportInstance(id);
    const timerOf = (id: string) => uptimeReportTimer(instanceOf(id));
    const configFile = (id: string) => `${UPTIME_REPORT_CONFIG_DIR}/${instanceOf(id)}.conf`;
    const keyFile = (id: string) => `${UPTIME_REPORT_CONFIG_DIR}/${instanceOf(id)}.key`;

    /** POSTs a report to the Worker's address; returns the status. */
    async function postReport(headers: Record<string, string>, body: string): Promise<number> {
      const response = await fetch(reportUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": UPTIME_REPORT_USER_AGENT,
          ...headers,
        },
        body,
      });
      await response.body?.cancel();
      return response.status;
    }

    async function signedPost(id: string, key: string, time: number, body: string) {
      return postReport(
        {
          "X-OpsCrew-Entry": id,
          "X-OpsCrew-Time": String(time),
          "X-OpsCrew-Signature": reportSignature(key, time, body),
        },
        body,
      );
    }

    // --- 1 and 2: the server and the app --------------------------------------------------------

    run.step(
      "1. a throwaway Hetzner server with its own SSH key, outside OpsCrew",
      minutes(30),
      async () => {
        await run.prepareRepo({
          commit: `e2e: examples/${APP} on your own server, for the uptime Worker's server reports`,
          env: { CLOUDFLARE_API_TOKEN: SETTINGS.cloudflareToken },
        });
        await envs.snapshotGithub();
        hostKey = await run.createServer();
      },
    );

    run.step(
      "2. DNS only: init, interview, design, adapt, provision and the first deploy",
      minutes(75),
      async () => {
        await run.initFix();
        await run.opscrewOk("analyze", "--no-ai");
        const answers = join(run.work, "answers.json");
        await writeFile(
          answers,
          JSON.stringify({
            provider: "own",
            expectedMonthlyUsers: "<1k",
            budgetMonthly: 20,
            uptime: "best-effort",
            dataCriticality: "important",
            dnsProvider: "cloudflare",
            domain: run.appHost,
            keepExternalServices: { s3: false },
            "server.host": run.ipv4(),
            "server.port": 22,
            "server.user": "root",
            "server.key": run.keyFile,
            "server.reachable": true,
            "server.serve": "dns-only",
          }),
        );
        await run.opscrewOk("interview", "--answers", answers);
        await run.opscrewOk("design", "--host-key", hostKey);
        plan = await run.readPlan();
        expect(plan.target.provider, "design planned the user's own server").toBe("own");
        run.appName = plan.app.name;
        // A DNS-only pass never checks the Zero Trust pieces, and the zone's token may not read them.
        await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`], {
          zeroTrust: false,
        });
        // The off-server copy of snapshots needs a key only the user can make; the recovery copy's
        // age key goes to a file, its copies to a folder (a script passes them).
        await run.opscrewOk("snapshot", "offsite", "off");
        const copies = join(run.work, "copies");
        await mkdir(copies, { recursive: true });
        await run.opscrewOk("secrets", "folder", copies);
        run.provisionFlags = ["--key-out", join(run.work, "age-key.txt")];
        await run.adaptAndMerge();
        envs.provisioned.add("prod");
        provisioned = true;
        await run.provisionUntilDone("your own server");
        await run.rememberSecretFile(run.paths().files.deployKey, "deploy-private-key");
        await run.rememberSecretFile(run.paths().files.statePassphrase, "state-passphrase");
        await run.rememberGeneratedValues();
        await run.deployAny("the first deploy");
        await run.waitForHealth(minutes(15), false);
        // verify records the first deploy, the date of the credentials OpsCrew made no record of.
        await run.opscrewOk("verify");
        plan = await run.readPlan();
        secrets = await envs.expectSecretsPlaced("prod");
        const listed = listedCredentials((await run.opscrewOk("rotate", "--json")).stdout);
        log(
          `2: opscrew rotate lists ${listed.map((c) => `${c.name} (${c.kind}, ${c.rotation.mode}, ${c.date?.source ?? "undated"})`).join(", ")}`,
        );
        dates = reportedCredentials(listed);
        log(
          `2: the credentials the report dates: ${dates.map((d) => `${d.name} (${d.source})`).join(", ")}`,
        );
        expect(dates.length, "the app has credentials the report dates").toBeGreaterThan(0);
      },
    );

    // --- 9. The Worker, and the server's timer ----------------------------------------------------

    run.step(
      "9. the Worker (its upload with the script's plain exports), workers.dev on, the host step uptime-report by its hash; one timer per entry, its config and key 0600 root, the first report in KV",
      minutes(45),
      async () => {
        const accounts = await cf("/accounts");
        expect(accounts.body.success, JSON.stringify(accounts.body.errors)).toBe(true);
        const list = accounts.body.result as { id: string }[];
        expect(list.length, "the Worker's token reaches exactly one account").toBe(1);
        accountId = (list[0] as { id: string }).id;
        run.scrubber.add(accountId, "worker-account-id");
        const before = { workers: await workers(), namespaces: await namespaces() };
        log(
          `9: the Worker's account has ${before.workers.length} Worker(s) and ${before.namespaces.length} KV namespace(s) before the run`,
        );
        expect(before.workers, "an opscrew-uptime Worker exists: not this run's").not.toContain(
          WORKER,
        );
        expect(
          before.namespaces.map((n) => n.title),
          "a namespace exists: not this run's",
        ).not.toContain(NAMESPACE);
        ours = true;

        serverId = `own-${hostKey
          .replace(/^SHA256:/, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")}`;
        idA = entryId("prod");
        idB = entryId("staging");
        // The first credential's date is 400 days old, so the first report says it is due.
        const [first, ...rest] = dates as [ReportedDate, ...ReportedDate[]];
        const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
        dates = [{ ...first, at: old, source: "made" }, ...rest];

        const desiredA: UptimeDesired = {
          id: idA,
          entry: entryOf(idA),
          secret: secretOf(TOPIC_A, keyA),
          script: { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 },
        };
        const facts = await inspectUptime(client, accountId);
        const first9 = planUptime(facts, desiredA);
        log(`9: ${describeUptimePlan(first9).replace(/\n/g, "\n    ")}`);
        if (first9.findings.some((f) => f.code === "workers-dev-missing")) {
          // An account that never opened Workers & Pages: the plan stops before any change, as
          // the guide says; the pass makes the subdomain the dashboard would, and deletes it.
          expect(first9.changes.length, "the plan lists its changes").toBeGreaterThan(0);
          const made = await cf(`/accounts/${accountId}/workers/subdomain`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ subdomain: `opscrew-live-${randomBytes(4).toString("hex")}` }),
          });
          expect(made.body.success, JSON.stringify(made.body.errors)).toBe(true);
          subdomainCreated = true;
          log(
            "9: the plan stopped on the missing workers.dev subdomain; the pass made a throwaway one",
          );
        }
        const created = await applyWorker("9 (A)", desiredA);
        expect(created.applied).toEqual(
          expect.arrayContaining([
            "create-namespace",
            "upload-script",
            "set-subdomain",
            "put-secret",
            "put-entry",
          ]),
        );
        reportUrl = created.plan.reportUrl ?? "";
        await startTail();
        expect(reportUrl).toMatch(/^https:\/\/opscrew-uptime\.[a-z0-9-]+\.workers\.dev\/report$/);
        run.scrubber.add(
          reportUrl.replace(/^https:\/\/opscrew-uptime\./, "").replace(/\/report$/, ""),
          "workers-dev-subdomain",
        );
        const second = await applyWorker("9 (B)", {
          id: idB,
          entry: entryOf(idB),
          secret: secretOf(topicB, keyB),
          script: { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 },
        });
        expect(second.plan.expect.others).toEqual([uptimeEntryKey(idA)]);
        expect(second.applied).toEqual(["put-secret", "put-entry"]);
        const route = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}/subdomain`);
        log(`9: the Worker's workers.dev route: ${JSON.stringify(route.body.result)}`);
        expect((route.body.result as { enabled?: boolean }).enabled, "workers.dev is on").toBe(
          true,
        );
        // A new address can take minutes to resolve: the server asks for it only once it answers.
        await waitFor(
          "the Worker's workers.dev address answering the server",
          minutes(10),
          async () =>
            (await shell(
              `curl -s -o /dev/null -w '%{http_code}' --max-time 10 ${reportUrl} || true`,
            )) === "404"
              ? true
              : undefined,
          POLL,
        );

        const planA = await applyReport("9 (A)", {
          enable: settingsOf(idA, keyA, dates),
          key: keyA,
        });
        expect(planA.steps.map((s) => `${s.id}:${s.state}`)).toEqual(["uptime-report:change"]);
        for (const s of planA.steps)
          expect(JSON.stringify(s), "the host plan names no key").not.toContain(keyA);
        await applyReport("9 (B)", { enable: settingsOf(idB, keyB, dates), key: keyB });

        expect(await timers(), "one timer per entry").toEqual([timerOf(idA), timerOf(idB)].sort());
        for (const id of [idA, idB]) {
          expect(await shell(`stat -c '%a %U' ${configFile(id)}`), "the config").toBe("600 root");
          expect(await shell(`stat -c '%a %U' ${keyFile(id)}`), "the key file").toBe("600 root");
          expect(await shell(`systemctl is-active ${timerOf(id)}`)).toBe("active");
        }
        expect(await shell(`stat -c '%a %U' ${UPTIME_REPORT_CONFIG_DIR}`)).toBe("700 root");
        expect(await shell(`stat -c '%a %U' ${UPTIME_REPORT_SCRIPT}`)).toBe("755 root");
        const config = await shell(`cat ${configFile(idA)}`);
        expect(
          config.includes(keyA) || config.includes(sha256(keyA)),
          "the config holds no key",
        ).toBe(false);
        expect(config).toContain(`url=${reportUrl}`);
        expect(config).toContain(`server=${serverId}`);
        for (const host of checkHosts(currentPlan()))
          expect(config).toContain(`host=${host.hostname}`);
        for (const d of dates) expect(config).toContain(`credential=${d.name} ${d.at} ${d.source}`);
        log(
          `9: A's config: ${config.split("\n").filter((l) => !l.startsWith("#")).length} lines, names and dates only`,
        );

        // The host step's verify ran the service once: its report is the first.
        await waitFor(
          "the first reports in KV",
          minutes(5),
          async () =>
            (await reportAt(idA)) !== undefined && (await reportAt(idB)) !== undefined
              ? true
              : undefined,
          POLL,
        );
        const firstReport = (await kvValue(uptimeReportKey(idA, serverId))) as StoredReport;
        log(`9: A's first report: ${JSON.stringify({ ...firstReport, server: "<server>" })}`);
        const journal = await shell(
          `journalctl -u ${timerOf(idA).replace(/timer$/, "service")} -u ${timerOf(idB).replace(/timer$/, "service")} --no-pager -o cat | grep '^uptime report: ' | tail -n 4`,
        );
        log(`9: the timer's journal lines:\n    ${journal.replace(/\n/g, "\n    ")}`);
        expect(journal.includes(keyA) || journal.includes(keyB), "the journal holds no key").toBe(
          false,
        );
        expect(firstReport.credentials?.find((c) => c.name === first.name)?.status).toBe("old");
        // A message a webhook refused goes again at the next run, 5 minutes later.
        await waitForTitles(TOPIC_A, [`credential ${first.name} is due for rotation`], minutes(8));
        await waitForTitles(topicB, [`credential ${first.name} is due for rotation`], minutes(8));
        expect(
          (await kvKeys()).map((k) => k.name).sort(),
          "the keys of both entries, their reports and the Worker's record",
        ).toEqual(
          [
            "opscrew:worker",
            uptimeEntryKey(idA),
            uptimeEntryKey(idB),
            uptimeReportKey(idA, serverId),
            uptimeReportKey(idB, serverId),
          ].sort(),
        );
        expect(await workerSecrets()).toEqual(
          [uptimeSecretName(idA), uptimeSecretName(idB)].sort(),
        );
        logTail("9");
        log("9: passed");
      },
    );

    // --- 10. A disk alert --------------------------------------------------------------------------

    run.step(
      "10. the disk past 85%: one message to each entry's webhook within about 5 minutes, one when it recovered, one KV write per change",
      minutes(120),
      async () => {
        const df = await shell("df -P -B1 /");
        const bytes = fillBytes(df, 88);
        log(`10: the disk is ${diskPercent(df)}% full; filling ${(bytes / 1e9).toFixed(1)} GB`);
        const ats = new Set<number>([(await reportAt(idA)) as number]);
        await shell(`fallocate -l ${bytes} ${FILL}`);
        const filled = await shell("df -P -B1 /");
        log(`10: now ${diskPercent(filled)}% full`);
        expect(diskPercent(filled)).toBeGreaterThanOrEqual(85);
        expect(diskPercent(filled)).toBeLessThan(95);
        const over = "disk over 85% full on";
        const watch = async () => {
          const at = await reportAt(idA).catch(() => undefined);
          if (at !== undefined) ats.add(at);
        };
        await waitForTitles(TOPIC_A, [over, serverId], minutes(31));
        await watch();
        await waitForTitles(topicB, [over, serverId], minutes(31));
        await shell(`rm -f ${FILL}`);
        log(`10: removed the file; the disk is ${diskPercent(await shell("df -P -B1 /"))}% full`);
        const resolved = `the disk on ${serverId}`;
        const started = Date.now();
        while (
          titlesOf((await ntfy(TOPIC_A).catch(() => undefined)) ?? [], "resolved", resolved)
            .length === 0
        ) {
          if (Date.now() - started > minutes(31)) {
            await diagnose("no recovery message");
            throw new Error("No message said the disk recovered within 31 minutes.");
          }
          await watch();
          await sleep(POLL);
        }
        await watch();
        await waitForTitles(topicB, ["resolved", resolved], minutes(31));
        // One more run of the timer: nothing more is sent.
        await sleep(minutes(5.5));
        await watch();
        const messages = await ntfy(TOPIC_A);
        expect(titlesOf(messages, over), "one message that the disk is full").toHaveLength(1);
        expect(
          titlesOf(messages, "resolved", resolved),
          "one message that it recovered",
        ).toHaveLength(1);
        const message = messages.find((m) => m.title?.includes(over));
        log(
          `10: ntfy priority ${message?.priority}: ${message?.title} | ${message?.message.split("\n")[0]}`,
        );
        // The first report's time, then one per change.
        expect(
          [...ats].filter((at) => at !== undefined),
          "A's report times: one KV write per change",
        ).toHaveLength(3);
        logTail("10");
        log("10: passed");
      },
    );

    // --- 11. The endpoint refuses -------------------------------------------------------------------

    run.step(
      "11. the report address refuses an unsigned report (401, nothing written), GET / (404) and a signed report sent again (409)",
      minutes(10),
      async () => {
        const at = await reportAt(idA);
        const unsigned = await postReport({}, JSON.stringify({ version: 1 }));
        expect(unsigned, "an unsigned report").toBe(401);
        const stored = (await kvValue(uptimeReportKey(idA, serverId))) as StoredReport;
        const body = heartbeatBody(stored);
        const refusedAt = Math.floor(Date.now() / 1000);
        expect(
          await signedPost(idA, keyB, refusedAt, body),
          "signed with another entry's key",
        ).toBe(401);
        expect(await signedPost(idA, keyA, refusedAt - 600, body), "ten minutes old").toBe(401);
        // KV's listing can lag a minute behind a write.
        await sleep(65_000);
        expect(await reportAt(idA), "no KV write for a refused report").toBe(at);
        const root = await fetch(reportUrl.replace(/\/report$/, "/"));
        await root.body?.cancel();
        expect(root.status, "GET /").toBe(404);
        const getReport = await fetch(reportUrl);
        await getReport.body?.cancel();
        expect(getReport.status, "GET /report").toBe(404);
        // Signed now (the refusals' time is over a minute old, within the 5 minutes allowed).
        const fresh = Math.floor(Date.now() / 1000);
        expect(await signedPost(idA, keyA, fresh, body), "a signed heartbeat").toBe(204);
        expect(await signedPost(idA, keyA, fresh, body), "the same report sent again").toBe(409);
        await waitFor(
          "the heartbeat's time in KV",
          minutes(2),
          async () => ((await reportAt(idA)) === fresh ? true : undefined),
          10_000,
        );
        logTail("11");
        log(`11: passed: 401, 401, 401, 404, 404, then 204 and 409 for the same signed report`);
      },
    );

    // --- 12 and 12a. Silence, then the credentials' dates -------------------------------------------

    run.step(
      "12. silence in minutes: heartbeatMinutes 10 through the adapter's live-test path; the timer stopped, one 'reports … stopped'",
      minutes(60),
      async () => {
        const desired: UptimeDesired = {
          id: idA,
          entry: entryOf(idA, { heartbeatMinutes: 10 }),
          script: { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 },
        };
        const refused = planUptime(await inspectUptime(client, accountId), desired);
        expect(
          refused.findings.map((f) => f.code),
          "an ordinary plan refuses the field",
        ).toEqual(["test-only-field"]);
        const set = await applyWorker("12", desired, { liveTest: true });
        expect(set.applied).toEqual(["put-entry"]);
        // A KV read shows a write within a minute (the inspection just read the old entry).
        await waitFor(
          "A's entry with heartbeatMinutes",
          minutes(2),
          async () =>
            ((await kvValue(uptimeEntryKey(idA))) as UptimeEntry).heartbeatMinutes === 10
              ? true
              : undefined,
          10_000,
        );
        await shell(`systemctl stop ${timerOf(idA)}`);
        const last = (await reportAt(idA)) as number;
        log(
          `12: stopped ${timerOf(idA)}; A's last report came at ${new Date(last * 1000).toISOString()}`,
        );
        const stopped = `reports from ${entryOf(idA).app} (prod) on ${serverId} stopped`;
        await waitForTitles(
          TOPIC_A,
          [stopped],
          Math.max(minutes(5), last * 1000 + minutes(40) - Date.now()),
        );
        const state = await waitFor(
          "state: noting the silent server",
          minutes(2),
          async () => {
            const got = (await kvValue(uptimeStateKey(idA))) as
              | { stopped?: Record<string, string> }
              | undefined;
            return got?.stopped?.[serverId] === undefined ? undefined : got;
          },
          10_000,
        );
        expect(Object.keys(state.stopped ?? {}), "state: notes the silent server").toEqual([
          serverId,
        ]);
        // The next run posts nothing more.
        await sleep(minutes(5.5));
        expect(titlesOf(await ntfy(TOPIC_A), stopped)).toHaveLength(1);
        expect(titlesOf(await ntfy(topicB), "stopped"), "B's reports kept coming").toEqual([]);
        // Started again with no change, the script sends nothing: its own heartbeat is daily, longer
        // than the test-only limit, so "resumed" waits for the next report (12a's).
        const since = (await shell("date +%s")).trim();
        await shell(`systemctl start ${timerOf(idA)}`);
        const line = await waitFor(
          "the timer's next run",
          minutes(7),
          async () => {
            const got = await shell(
              `journalctl -u opscrew-uptime-report@${instanceOf(idA)}.service --since @${since} --no-pager -o cat | grep '^uptime report: ' | tail -n 1 || true`,
            );
            return got === "" ? undefined : got;
          },
          POLL,
        );
        log(`12: started the timer again; its run said: ${line}`);
        logTail("12");
        log("12: passed");
      },
    );

    run.step(
      "12a. the dates: the config lists the hostnames and the credentials' dates; the new date by the server's host plan; its recovery, then 'reports resumed'; the certificates' days in the last report; provision again drops heartbeatMinutes",
      minutes(80),
      async () => {
        const [first, ...rest] = dates as [ReportedDate, ...ReportedDate[]];
        rotated = new Date().toISOString();
        dates = [{ ...first, at: rotated, source: "rotated" }, ...rest];
        await applyReport("12a (rotate)", { enable: settingsOf(idA, keyA, dates), key: keyA });
        const config = await shell(`cat ${configFile(idA)}`);
        expect(config).toContain(`credential=${first.name} ${rotated} rotated`);
        expect(await shell(`systemctl is-active ${timerOf(idA)}`)).toBe("active");
        await waitForTitles(
          TOPIC_A,
          ["resolved", `the age of the credential ${first.name}`],
          minutes(31),
        );
        const app = entryOf(idA).app;
        await waitForTitles(
          TOPIC_A,
          [`reports resumed from ${app} (prod) on ${serverId}`],
          minutes(31),
        );
        const report = (await kvValue(uptimeReportKey(idA, serverId))) as StoredReport;
        log(
          `12a: what status shows from the last report: certificates ${JSON.stringify(report.certificates)}, credentials ${JSON.stringify(report.credentials)}`,
        );
        for (const host of checkHosts(currentPlan())) {
          const cert = report.certificates.find((c) => c.hostname === host.hostname);
          expect.soft(cert?.status, `the certificate of ${host.hostname}`).toBe("ok");
          expect
            .soft(Number(cert?.days), `its days left`)
            .toBeGreaterThan(CHECK_THRESHOLDS.certDays);
        }
        const credential = report.credentials?.find((c) => c.name === first.name);
        expect(credential).toMatchObject({ status: "ok", source: "rotated" });
        // A date a second ahead of the server's clock counts as -1 days.
        expect(Math.abs(Number(credential?.days)), "rotated today").toBeLessThanOrEqual(1);
        const again = await applyWorker("12a (provision again)", {
          id: idA,
          entry: entryOf(idA),
          script: { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 },
        });
        expect(again.applied).toEqual(["put-entry"]);
        await waitFor(
          "A's entry without heartbeatMinutes",
          minutes(2),
          async () =>
            ((await kvValue(uptimeEntryKey(idA))) as UptimeEntry).heartbeatMinutes === undefined
              ? true
              : undefined,
          10_000,
        );
        logTail("12a");
        log("12a: passed");
      },
    );

    // --- 13 and 14. Leaving, then the destroy ----------------------------------------------------

    run.step(
      "13. B leaves: only its entry, report and secret go, and its timer, config and key; A's timer and the Worker stay",
      minutes(15),
      async () => {
        const leaving = await applyWorker("13", {
          id: idB,
          script: { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 },
        });
        expect(leaving.applied).toEqual(["delete-entry", "delete-secret"]);
        expect(leaving.plan.destroys).toBe(false);
        const removal = await applyReport("13", { disable: idB });
        expect(removal.steps.map((s) => `${s.id}:${s.state}`)).toEqual(["uptime-report:change"]);
        expect(await timers(), "only A's timer").toEqual([timerOf(idA)]);
        expect(
          await shell(`test ! -e ${configFile(idB)} && test ! -e ${keyFile(idB)} && echo gone`),
        ).toBe("gone");
        expect(await shell(`test -f ${UPTIME_REPORT_SCRIPT} && echo kept`)).toBe("kept");
        expect(await workers()).toContain(WORKER);
        expect(await workerSecrets()).toEqual([uptimeSecretName(idA)]);
        // KV's listing can lag a minute behind a deletion.
        await waitFor(
          "no KV key of B",
          minutes(2),
          async () => ((await kvKeys()).some((k) => k.name.includes(idB)) ? undefined : true),
          10_000,
        );
        logTail("13");
        log("13: passed");
      },
    );

    run.step(
      "14. destroy A, the last entry: the Worker, its trigger and the namespace go; opscrew destroy --undo-host removes the timer and its files",
      minutes(40),
      async () => {
        logTail("14");
        closeTail();
        const destroyed = await applyWorker("14", {
          id: idA,
          destroy: true,
          script: { content: UPTIME_WORKER_SCRIPT, sha256: UPTIME_WORKER_SHA256 },
        });
        expect(destroyed.plan.destroys).toBe(true);
        workerDestroyed = true;
        expect(destroyed.applied).toEqual(
          expect.arrayContaining([
            "delete-entry",
            "delete-secret",
            "delete-script",
            "delete-namespace",
          ]),
        );
        const shown = run.outputs.size;
        await opscrewUntilApproved(run, ["destroy", "--confirm", run.app(), "--undo-host"]);
        run.destroyed = true;
        envs.destroyed.add("prod");
        // The teardown's host plan, under the typed confirmation, in any of destroy's runs.
        const named = [...run.outputs.values()]
          .slice(shown)
          .flatMap((output) => output.split(/\r?\n/))
          .filter((line) => line.includes("uptime report"));
        log(`14: destroy's lines about the uptime report:\n    ${run.scrub(named.join("\n    "))}`);
        expect(named.length, "destroy's plan named the uptime report").toBeGreaterThan(0);
        expect(await timers(), "no timer is left").toEqual([]);
        expect(
          await shell(
            `for f in ${UPTIME_REPORT_SCRIPT} ${UPTIME_REPORT_SERVICE_UNIT} ${UPTIME_REPORT_TIMER_UNIT} ${UPTIME_REPORT_CONFIG_DIR} /var/lib/opscrew-uptime-report; do test -e $f && echo $f; done; true`,
          ),
          "the uptime report's files on the server",
        ).toBe("");
        await run.expectCloudflareClean();
        if (secrets !== undefined) await envs.expectSecretsGone("prod", secrets);
        log("14: passed");
      },
    );

    // --- 15. Nothing left behind ---------------------------------------------------------------

    /** Deletes the throwaway workers.dev subdomain once, after the Worker. */
    async function removeSubdomain(): Promise<void> {
      if (!subdomainCreated) return;
      const gone = await cf(`/accounts/${accountId}/workers/subdomain`, { method: "DELETE" });
      log(`deleted the throwaway workers.dev subdomain: HTTP ${gone.status}`);
      if (gone.status < 300 || gone.status === 404) subdomainCreated = false;
    }

    /** The Worker's account's pieces: the account's Workers and namespaces, the Worker's secrets. */
    async function workerAccountListing(): Promise<{ text: string; left: string[] }> {
      const all = await workers();
      const titles = (await namespaces()).map((n) => n.title);
      const secretsLeft = await workerSecrets();
      const subdomain = (await cf(`/accounts/${accountId}/workers/subdomain`)).body.success;
      const left = [
        ...(all.includes(WORKER) ? [`the Worker ${WORKER}`] : []),
        ...(titles.includes(NAMESPACE) ? [`the KV namespace ${NAMESPACE}`] : []),
        ...(secretsLeft === undefined ? [] : [`the Worker's secrets ${secretsLeft.join(", ")}`]),
        ...(subdomainCreated ? ["the throwaway workers.dev subdomain"] : []),
      ];
      return {
        text: `${all.length} Worker(s) (${all.includes(WORKER) ? "with" : "no"} ${WORKER}), ${titles.length} KV namespace(s) (${titles.includes(NAMESPACE) ? "with" : "no"} ${NAMESPACE}), ${secretsLeft === undefined ? "no such Worker's secrets" : `secrets ${secretsLeft.join(", ")}`}, workers.dev subdomain ${subdomain ? "present" : "none"}`,
        left,
      };
    }

    /** The zone's records on the run's hostnames. */
    async function runRecords(): Promise<number> {
      if (run.zone === undefined) return 0;
      return (await run.cloudflare.zoneRecords(run.zone)).filter((r) =>
        run.hostnames.includes(r.name),
      ).length;
    }

    /** The run's deploy secrets GitHub still has (by OpsCrew's record of their names). */
    async function runSecrets(): Promise<string[]> {
      if (!run.repoReady || secrets === undefined) return [];
      const record = secrets;
      const names = [
        ...(await secretNames(run.github)),
        ...(record.environment === undefined
          ? []
          : await secretNames(run.github, record.environment)),
      ];
      return names.filter((name) => record.names.includes(name));
    }

    run.step(
      "15. nothing left after the destroys: the account's Workers, KV namespaces and the Worker's secrets; the run's DNS records; GitHub's secrets; no secret in any output",
      minutes(10),
      async () => {
        if (accountId !== "" && workerDestroyed) {
          await removeSubdomain();
          const listing = await workerAccountListing();
          log(`15: the Worker's account: ${listing.text}`);
          expect(listing.left).toEqual([]);
        }
        if (run.destroyed) {
          const records = await runRecords();
          log(`15: the zone's records on the run's hostnames: ${records}`);
          expect(records).toBe(0);
          const left = await runSecrets();
          log(
            `15: the run's deploy secrets left at GitHub: ${left.length}; the repository's environments: ${(await environmentNames(run.github)).join(", ") || "none"}`,
          );
          expect(left).toEqual([]);
        }
        run.expectNothingLeaked(await envs.leaks({ cloudflare: provisioned }));
      },
      { always: true },
    );

    envs.registerCleanup({
      first: () => closeTail(),
      last: async (attempt) => {
        if (accountId !== "" && ours) {
          await attempt("delete the run's uptime Worker and namespace", async () => {
            if ((await workers()).includes(WORKER)) {
              const gone = await cf(`/accounts/${accountId}/workers/scripts/${WORKER}`, {
                method: "DELETE",
              });
              log(`cleanup: DELETE Worker ${WORKER}: HTTP ${gone.status}`);
            }
            for (const ns of (await namespaces()).filter((n) => n.title === NAMESPACE)) {
              const gone = await cf(`/accounts/${accountId}/storage/kv/namespaces/${ns.id}`, {
                method: "DELETE",
              });
              log(`cleanup: DELETE namespace ${NAMESPACE}: HTTP ${gone.status}`);
            }
            await removeSubdomain();
            const listing = await workerAccountListing();
            log(`cleanup: listed, the Worker's account: ${listing.text}`);
            return listing.left.map((what) => `${what} is left in the Worker's account`);
          });
        }
        // After the harness's own cleanup: what is left of the run anywhere, by listing.
        await attempt("list the run's DNS records", async () => {
          const records = await runRecords();
          log(`cleanup: listed, the zone's records on the run's hostnames: ${records}`);
          return records === 0 ? [] : [`${records} record(s) on the run's hostnames are left`];
        });
        await attempt("list the run's GitHub secrets", async () => {
          const left = await runSecrets();
          log(`cleanup: listed, the run's deploy secrets at GitHub: ${left.length}`);
          return left.map((name) => `the GitHub secret ${name} is left`);
        });
        await attempt("list the run's Hetzner resources", async () => {
          const selector = encodeURIComponent(`managed-by=opscrew-e2e,run=${run.runId}`);
          const counts: string[] = [];
          for (const kind of ["servers", "ssh_keys", "firewalls"]) {
            const got = await api(
              HETZNER_API,
              SETTINGS.hcloudToken,
              "GET",
              `/${kind}?label_selector=${selector}`,
            );
            counts.push(
              `${kind} ${((got.json as Record<string, unknown[]> | undefined)?.[kind] ?? []).length}`,
            );
          }
          log(`cleanup: listed, Hetzner with the run's label: ${counts.join(", ")}`);
          return counts.filter((c) => !c.endsWith(" 0")).map((c) => `Hetzner still lists ${c}`);
        });
      },
    });
  },
);
