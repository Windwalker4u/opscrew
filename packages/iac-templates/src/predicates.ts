import { edgeProvider } from "@opscrew/edge-providers";
import { activeEdgeProvider, type DeployPlan } from "@opscrew/plan-schema";

/** True when the plan's DNS is a domain on Cloudflare. */
export function usesCloudflare(plan: DeployPlan): boolean {
  return plan.dns.provider === "cloudflare" && plan.dns.domain !== undefined;
}

/** True when the plan's DNS is a domain on Bunny.net. */
export function usesBunny(plan: DeployPlan): boolean {
  return plan.dns.provider === "bunny" && plan.dns.domain !== undefined;
}

/** True when web traffic reaches the server through a configured edge proxy provider. */
export function usesEdge(plan: DeployPlan): boolean {
  return activeEdgeProvider(plan) !== undefined;
}

/**
 * True when web traffic may reach the server only through the active edge proxy
 * (`security.httpAllowedFrom: edge`).
 */
export function webOnlyFromEdge(plan: DeployPlan): boolean {
  return usesEdge(plan) && plan.security.httpAllowedFrom === "edge";
}

/**
 * True when web traffic may reach the server only through Cloudflare: a proxied Cloudflare domain
 * (with no separate `dns.edge`), or a preview environment's proxied wildcard, with
 * `security.httpAllowedFrom: edge`.
 */
export function webOnlyFromCloudflare(plan: DeployPlan): boolean {
  return activeEdgeProvider(plan) === "cloudflare" && plan.security.httpAllowedFrom === "edge";
}

/**
 * True when the active edge provider publishes compact CIDRs that fit cloud firewalls and server
 * real-IP trust lists (`originIpFiltering: "compact-cidrs"`). False for `dynamic-ips` providers
 * such as Bunny.net, where the firewall leaves ports 80/443 open and the shared header is the gate.
 */
export function usesCompactEdgeCidrs(plan: DeployPlan): boolean {
  const edgeId = activeEdgeProvider(plan);
  if (edgeId === undefined || plan.security.httpAllowedFrom !== "edge") return false;
  return edgeProvider(edgeId).capabilities.originIpFiltering === "compact-cidrs";
}

/**
 * True when the active edge provider authenticates origin requests with a shared secret header
 * (`originAuth: "shared-header"`), verified by the server's reverse proxy before `kamal-proxy`.
 */
export function usesSharedOriginHeader(plan: DeployPlan): boolean {
  const edgeId = activeEdgeProvider(plan);
  if (edgeId === undefined || plan.security.httpAllowedFrom !== "edge") return false;
  return edgeProvider(edgeId).capabilities.originAuth === "shared-header";
}
