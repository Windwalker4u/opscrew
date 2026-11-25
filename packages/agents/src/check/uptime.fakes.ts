import { CloudflareClient } from "@opscrew/connector-cloudflare";
import { FAKE_ACCOUNT_ID, FAKE_ZONE_ID, FakeUptime } from "@opscrew/connector-cloudflare/testing";
import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { createTestPhaseDeps, testPlan } from "../testing";
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
  "workersSubdomain",
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
 * project, so this computer records the entry too. Its approvals are not `deps`'.
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
    services: { sharedCloudflare: client },
    command: "opscrew provision",
    ask: false,
  });
  await provisionUptime(own, step, { command: "opscrew provision", phase: "provision" });
}
