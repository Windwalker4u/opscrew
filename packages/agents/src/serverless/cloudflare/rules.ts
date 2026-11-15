/**
 * The zone's shared rules for an app on Cloudflare's hosting (011's adapter, ADR 0014): its
 * hostnames in OpsCrew's probe block, its `www` hostname in the redirect to the domain, and its
 * domain in the redirect of plain HTTP to HTTPS, planned by `planSharedCloudflare` as for servers
 * and approved by the Cloudflare plan's hash (`cloudflare-apply`).
 */
import type { SharedDesired, SharedRecord, SharedRuleRef } from "@opscrew/connector-cloudflare";
import type { DeployPlan } from "@opscrew/plan-schema";

const REDIRECT = "opscrew-www-redirect";
const HTTPS = "opscrew-https-redirect";
/** The rules of the redirect phase, which only a site on Cloudflare's hosting has hostnames in. */
const REDIRECTS: readonly SharedRuleRef[] = [REDIRECT, HTTPS];

/**
 * True when the app's record lists hostnames in the redirect rules (a site on Cloudflare's
 * hosting): reading or planning the shared rules then needs the redirect's phase, and only then
 * does the token need Zone → Single Redirect → Edit.
 */
export function listsRedirect(record: Pick<SharedRecord, "hostnames"> | undefined): boolean {
  return REDIRECTS.some((ref) => (record?.hostnames[ref] ?? []).length > 0);
}

/**
 * What an app on Cloudflare's hosting needs from the zone's shared rules: its hostnames in the
 * probe block with `security.wafCustomRules` (the zone's WAF sees a Worker's custom domains, 016's
 * spike, result 10), `www.<domain>` in the redirect to the domain when `www` is on (result 12), so
 * a request to it never reaches the Worker, and the domain in the redirect of plain HTTP to HTTPS
 * (T2842: a Worker answers plain HTTP itself; `www` goes to HTTPS with its own redirect). None in
 * the strict-TLS rule: a Worker has no origin.
 */
export function siteRulesDesired(plan: DeployPlan): SharedDesired {
  const domain = plan.dns.domain as string;
  const www = plan.dns.www ? [`www.${domain}`] : [];
  return {
    hostnames: {
      "opscrew-block-probes": plan.security.wafCustomRules ? [domain, ...www] : [],
      "opscrew-strict-tls": [],
      [REDIRECT]: www,
      [HTTPS]: [domain],
    },
  };
}
