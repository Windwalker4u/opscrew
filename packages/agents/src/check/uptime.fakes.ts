import { CloudflareClient } from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID, FakeUptime } from "@opscrew/connector-cloudflare/testing";
import {
  type ApplyOptions,
  type ApplyResult,
  type DesiredUptimeReport,
  type HostFacts,
  type HostPlan,
  type HostStep,
  hostPlanHash,
  UPTIME_REPORT_VERSION,
  type UptimeReportFacts,
  uptimeReportConfigText,
  uptimeReportFileHashes,
} from "@opscrew/connector-ssh-host";
import type { FetchLike, RemoteExec } from "@opscrew/contracts";
import { sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { createdServerFacts, createTestPhaseDeps, testPlan, unusedRemote } from "../testing";
import { planProvisionUptime, provisionUptime } from "./uptime";

/** A webhook address the tests give; it must never appear in a plan, a line or the audit. */
export const WEBHOOK_URL = `https://hooks.example.net/uptime/${fakeSecret("generic-password", "uptime-hook")}`;

/**
 * Cloudflare's zone lookup for `example.com` (and its subdomains), in {@link FAKE_ACCOUNT_ID}:
 * what `findZone` reads. Any other request throws.
 */
const zones: FetchLike = async (input) => {
  const url = new URL(String(input));
  if (!url.pathname.endsWith("/zones")) throw new Error(`fake zones: no route for ${url}`);
  const name = url.searchParams.get("name");
  const result =
    name === "example.com"
      ? [
          {
            id: FAKE_ZONE_ID,
            name,
            status: "active",
            name_servers: [],
            account: { id: FAKE_ACCOUNT_ID },
          },
        ]
      : [];
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
      result_info: { page: 1, total_pages: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

/** The fake account of the uptime Worker (Workers KV, the Worker, its secrets) with the zone. */
export function fakeUptimeAccount(): { uptime: FakeUptime; client: CloudflareClient } {
  const uptime = new FakeUptime({ fallback: zones });
  const client = new CloudflareClient({
    token: fakeSecret("cloudflare-token", "uptime"),
    fetch: uptime.fetch,
    sleep: async () => undefined,
  });
  return { uptime, client };
}

/** The client methods the uptime Worker's steps call. */
const UPTIME_CALLS = new Set<string>([
  "findZone",
  "listKvNamespaces",
  "createKvNamespace",
  "deleteKvNamespace",
  "listKvKeys",
  "getKv",
  "putKv",
  "deleteKv",
  "uploadWorkerModule",
  "putWorkerSchedules",
  "deleteWorkerScript",
  "listWorkerSecrets",
  "putWorkerSecret",
  "deleteWorkerSecret",
  "getWorkersSubdomain",
  "getWorkerSubdomain",
  "setWorkerSubdomain",
]);

/**
 * `shared` (another fake's zone, with OpsCrew's shared rules), with the uptime Worker's calls
 * answered by `uptime` (a {@link fakeUptimeAccount}'s client) instead: one account for both.
 */
export function withUptimeAccount(
  shared: CloudflareClient,
  uptime: CloudflareClient,
): CloudflareClient {
  return new Proxy(shared, {
    get(target, property) {
      const from = typeof property === "string" && UPTIME_CALLS.has(property) ? uptime : target;
      const value: unknown = Reflect.get(from, property);
      return typeof value === "function" ? value.bind(from) : value;
    },
  });
}

/**
 * The `shop` app's prod plan at `shop.example.com` with the check on, by `runner` (`undefined`
 * leaves it out), and the repository's Slack webhook (prod's plan holds it); `environment` names
 * another environment, without the webhook.
 */
export function uptimePlan(
  runner: "actions" | "cloudflare" | undefined,
  options: { environment?: string; enabled?: boolean } = {},
): DeployPlan {
  const { environment } = options;
  const base = testPlan({ domain: `${environment ?? "shop"}.example.com` });
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name: environment === undefined ? "shop" : `shop-${environment}` },
    ...(environment === undefined ? {} : { environment: { name: environment } }),
    observability: {
      check: {
        enabled: options.enabled ?? true,
        ...(runner === undefined ? {} : { runner }),
        ...(environment === undefined ? { webhook: "slack" } : {}),
      },
    },
  });
}

/**
 * The Worker as `plan`'s provision leaves it in `client`'s account for `github` (default
 * acme/shop): provisioned (with the address {@link WEBHOOK_URL}) by a run of its own on `deps`'
 * project, so this computer records the entry too, and its server's report set up on a
 * {@link FakeReportServer} of its own. Its approvals are not `deps`'.
 */
export async function provisionedUptime(
  deps: Pick<PhaseDeps, "paths" | "env">,
  plan: DeployPlan,
  client: CloudflareClient,
  github: { owner: string; repo: string } = { owner: "acme", repo: "shop" },
): Promise<void> {
  const own = await createTestPhaseDeps({
    root: deps.paths.root,
    env: { ...deps.env, OPSCREW_CHECK_WEBHOOK: WEBHOOK_URL },
    ...(deps.paths.app === undefined ? {} : { app: deps.paths.app }),
    environment: deps.paths.environment,
  });
  const step = await planProvisionUptime(own, {
    plan,
    github: async () => github,
    services: { sharedCloudflare: client, ...reportServices(new FakeReportServer()) },
    command: "opscrew provision",
    ask: false,
  });
  await provisionUptime(own, step, { command: "opscrew provision", phase: "provision" });
}

/**
 * The services that reach `server` for the uptime report, on a server OpsCrew created
 * (`serverHost`) or the user's own (`own.host`), with a shell that is never used.
 */
export function reportServices(server: FakeReportServer) {
  return { serverHost: server, own: { host: server }, remote: unusedRemote };
}

/** No uptime report on the server yet, with `curl` and `openssl` there. */
export function noUptimeReport(): UptimeReportFacts {
  return {
    version: null,
    script: null,
    service: null,
    timer: null,
    dir: null,
    tools: { curl: true, openssl: true },
    instances: [],
  };
}

/** A root file with `mode` and SHA-256 `sha256`, as inspection reads it. */
const rootFile = (mode: string, sha256: string) => ({ mode, owner: "root", sha256 });

/** The settings the `uptime-report` step's params carry (the step's own params format). */
function reportOf(p: HostStep["params"]): DesiredUptimeReport {
  const lines = (value: unknown, sep: string) =>
    String(value ?? "")
      .split(sep)
      .filter((line) => line !== "");
  const drill = p.drill === "weekly" || p.drill === "daily" ? p.drill : undefined;
  return {
    url: String(p.url),
    entry: String(p.entry),
    server: String(p.server),
    ...(drill === undefined ? {} : { drill }),
    hosts: lines(p.hosts, " "),
    thresholds: {
      diskWarn: Number(p.diskWarn),
      diskHigh: Number(p.diskHigh),
      certDays: Number(p.certDays),
    },
    ...(p.maxAgeDays === undefined
      ? {}
      : {
          credentials: {
            maxAgeDays: Number(p.maxAgeDays),
            dates: lines(p.credentials, "\n").map((line) => {
              const [name = "", at = "", source] = line.split(" ");
              return { name, at, source: source as "made" | "rotated" | "first-deploy" };
            }),
          },
        }),
    keySha256: String(p.keySha256),
  };
}

/**
 * A server's uptime report behind the host adapter (`services.serverHost`, or `services.own.host`
 * on a server the user owns): `inspect` gives `base` with {@link FakeReportServer.report};
 * `apply` refuses a plan whose hash is not the approved one, records it, and leaves the report as
 * the `uptime-report` step would: installed and running with its config and key, or removed.
 */
export class FakeReportServer {
  readonly applies: { plan: HostPlan; options: ApplyOptions }[] = [];
  report: UptimeReportFacts = noUptimeReport();
  constructor(private readonly base: HostFacts = createdServerFacts()) {}

  async inspect(_remote: RemoteExec, _options?: { rootImage?: string }): Promise<HostFacts> {
    return { ...this.base, uptimeReport: this.report };
  }

  async apply(_remote: RemoteExec, plan: HostPlan, options: ApplyOptions): Promise<ApplyResult> {
    if (options.approvedHash !== hostPlanHash(plan)) throw new Error("host plan hash mismatch");
    this.applies.push({ plan, options });
    const changes = plan.steps.filter((step) => step.state === "change");
    for (const { id, params: p } of changes) {
      if (id !== "uptime-report") continue;
      if (p.remove === true) {
        const gone = String(p.instances).split(" ");
        const instances = this.report.instances.filter((i) => !gone.includes(i.instance));
        this.report =
          p.shared === true ? { ...noUptimeReport(), instances } : { ...this.report, instances };
        continue;
      }
      const hashes = uptimeReportFileHashes();
      const instance = {
        instance: String(p.instance),
        app: String(p.app),
        config: rootFile("600", sha256Hex(uptimeReportConfigText(String(p.app), reportOf(p)))),
        key: rootFile("600", String(p.keySha256)),
        timer: { enabled: true, active: true },
      };
      this.report = {
        version: UPTIME_REPORT_VERSION,
        script: rootFile("755", hashes.script),
        service: rootFile("644", hashes.service),
        timer: rootFile("644", hashes.timer),
        dir: { mode: "700", owner: "root" },
        tools: { curl: true, openssl: true },
        instances: [
          ...this.report.instances.filter((i) => i.instance !== instance.instance),
          instance,
        ],
      };
    }
    return {
      applied: changes.map((step) => step.id),
      skipped: plan.steps.filter((step) => step.state !== "change").map((step) => step.id),
    };
  }
}
