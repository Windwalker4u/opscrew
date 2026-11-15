/**
 * What a move to another Cloudflare account leaves behind (FR-2819, plan 14.): what OpsCrew finds
 * in A that it doesn't move, read only with A's token, each kind with where to redo it in B. Prepare's
 * summary and the switch plan's details list it; it is never part of a plan's hash. Only names and
 * counts are shown, never a value such as an address.
 */
import { SHARED_RULES } from "@opscrew/connector-cloudflare";
import { listText, plural } from "@opscrew/core";
import { moveBuckets } from "./buckets";
import { accountName, accountWords } from "./texts";
import type { MoveSession } from "./types";

/** One kind of what OpsCrew doesn't move. */
export interface LeftBehindItem {
  /** The kind, as Cloudflare's dashboard names it: `Email Routing`, `Redirect Rules`, `Workers`. */
  kind: string;
  /** What was found, in names and counts; `undefined` when A's token couldn't read it. */
  found?: string;
  /** Where to redo it in B's dashboard. */
  where: string;
}

/** The zone settings OpsCrew doesn't set in B, in the order shown. */
const SETTINGS = [
  "ssl",
  "min_tls_version",
  "always_use_https",
  "security_level",
  "cache_level",
] as const;

/** The SSL/TLS modes as the dashboard names them. */
const SSL_MODES: Record<string, string> = {
  off: "Off",
  flexible: "Flexible",
  full: "Full",
  strict: "Full (strict)",
  origin_pull: "Strict (SSL-Only Origin Pull)",
};

/** Each rule phase's name and its place in the dashboard. */
const PHASES: Record<string, [kind: string, where: string]> = {
  http_request_firewall_custom: ["WAF custom rules", "Security > WAF > Custom rules"],
  http_request_firewall_managed: ["WAF managed rules", "Security > WAF > Managed rules"],
  http_ratelimit: ["Rate limiting rules", "Security > WAF > Rate limiting rules"],
  http_request_dynamic_redirect: ["Redirect Rules", "Rules > Redirect Rules"],
  http_request_transform: ["URL Rewrite Rules", "Rules > Transform Rules"],
  http_request_late_transform: ["Request Header Transform Rules", "Rules > Transform Rules"],
  http_response_headers_transform: ["Response Header Transform Rules", "Rules > Transform Rules"],
  http_request_cache_settings: ["Cache Rules", "Caching > Cache Rules"],
  http_config_settings: ["Configuration Rules", "Rules > Configuration Rules"],
  http_request_origin: ["Origin Rules", "Rules > Origin Rules"],
  http_response_compression: ["Compression Rules", "Rules > Compression Rules"],
  http_custom_errors: ["Custom Error Rules", "Rules > Custom Error Rules"],
};

/** `read`'s answer, or `undefined` when it failed: a refusal, an answer zod refused, anything. */
async function attempt<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/**
 * What OpsCrew finds in A that the move doesn't move, read only with A's token: the zone's Email
 * Routing, the settings OpsCrew doesn't set, the rules that aren't OpsCrew's and its page rules,
 * then the account's Workers, Pages projects and R2 buckets that aren't the app's, its Turnstile
 * widgets and Web Analytics sites. A kind that can't be read (HTTP 403, for one) is listed without
 * `found`; nothing stops the move. Nothing is changed in either account.
 */
export async function leftBehind(session: MoveSession): Promise<LeftBehindItem[]> {
  const { client, accountId, zoneId } = session.accounts.a;
  const items: LeftBehindItem[] = [];
  const add = (kind: string, where: string, found: string | undefined) => {
    items.push({ kind, where, ...(found === undefined ? {} : { found }) });
  };

  const routing = await attempt(() => client.emailRouting(zoneId));
  if (routing === undefined || routing.enabled || routing.rules > 0 || routing.catchAll) {
    add(
      "Email Routing",
      "Email > Email Routing",
      routing &&
        `${routing.enabled ? "on" : "off"}, ${plural(routing.rules, "rule")}${routing.catchAll ? " and a catch-all" : ""}`,
    );
  }

  const settings = await attempt(() => client.zoneSettings(zoneId, SETTINGS));
  add(
    "Zone settings",
    "SSL/TLS, Security > Settings and Caching > Configuration",
    settings &&
      [
        `SSL/TLS mode ${SSL_MODES[settings.ssl] ?? settings.ssl}`,
        `minimum TLS ${settings.min_tls_version}`,
        `Always Use HTTPS ${settings.always_use_https}`,
        `security level ${settings.security_level.replaceAll("_", " ")}`,
        `cache level ${settings.cache_level}`,
      ].join(", "),
  );

  const phases = await attempt(() => client.listRulesetPhases(zoneId));
  if (phases === undefined) add("Rules", "Rules, and Security > WAF", undefined);
  for (const phase of phases ?? []) {
    const [kind, where] = PHASES[phase] ?? [`Rules of the ${phase} phase`, "Rules"];
    // `none`: the entrypoint is gone since it was listed.
    const ruleset = await attempt(
      async () => (await client.entrypointRuleset(zoneId, phase)) ?? "none",
    );
    if (ruleset === "none") continue;
    if (ruleset === undefined || ruleset === "forbidden") {
      add(kind, where, undefined);
      continue;
    }
    const own = ruleset.rules.filter(
      (rule) => !(rule.ref !== undefined && rule.ref in SHARED_RULES),
    );
    if (own.length > 0) add(kind, where, `${plural(own.length, "rule")} of your own`);
  }

  const pageRules = await attempt(() => client.pageRuleCount(zoneId));
  if (pageRules !== 0) {
    add(
      "Page Rules",
      "Rules > Page Rules",
      pageRules === undefined ? undefined : plural(pageRules, "page rule"),
    );
  }

  const plans = session.environments.map((env) => env.plan);
  const appWorkers = plans.flatMap((plan) =>
    plan.target.provider === "cloudflare-workers" ? [plan.target.worker] : [],
  );
  // A Worker serving a custom domain in the zone is an OpsCrew app's, which its own prepare moves.
  const zoneWorkers =
    (await attempt(() => client.listZoneWorkerDomains(accountId, zoneId)))?.map((d) => d.service) ??
    [];
  const ownWorkers = new Set([...appWorkers, ...zoneWorkers]);
  const ownBuckets = new Set(plans.flatMap((plan) => moveBuckets(plan).map((b) => b.bucket)));
  const lists: [string, string, () => Promise<string[]>, (name: string) => boolean][] = [
    [
      "Workers",
      "Workers & Pages",
      () => client.listWorkerNames(accountId),
      (n) => !ownWorkers.has(n),
    ],
    ["Pages projects", "Workers & Pages", () => client.listPagesProjects(accountId), () => true],
    [
      "R2 buckets",
      "R2 Object Storage",
      () => client.listR2Buckets(accountId),
      (n) => !ownBuckets.has(n),
    ],
    ["Turnstile widgets", "Turnstile", () => client.listTurnstileWidgets(accountId), () => true],
    [
      "Web Analytics sites",
      "Analytics & Logs > Web Analytics",
      () => client.listWebAnalyticsSites(accountId),
      () => true,
    ],
  ];
  for (const [kind, where, read, keep] of lists) {
    const names = (await attempt(read))?.filter(keep);
    if (names === undefined || names.length > 0) add(kind, where, names && listText(names));
  }
  return items;
}

/** `items` in words, for prepare's summary and the switch plan's details. */
export function leftBehindLines(session: MoveSession, items: readonly LeftBehindItem[]): string[] {
  const { a, b } = session.accounts;
  const aWords = accountWords(a);
  const bName = accountName(b);
  if (items.length === 0) {
    return [`What OpsCrew doesn't move: nothing found in ${aWords} beyond what OpsCrew made.`];
  }
  return [
    `What OpsCrew doesn't move, read in ${aWords} (none of it is moved or changed): redo in ${bName} what should go with ${session.zone}, or leave it:`,
    ...items.map(
      (item) =>
        `  - ${item.kind}: ${item.found ?? "couldn't read: check in the dashboard"}. In ${bName}: ${item.where}.`,
    ),
  ];
}
