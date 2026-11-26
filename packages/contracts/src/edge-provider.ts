/**
 * The contract for an edge proxy provider (ADR 0038): everything OpsCrew knows about one provider
 * that proxies web traffic at the edge (and optionally hosts DNS), in one definition a provider
 * package exports. Only plain data, regular expressions, and functions cross it — never a zod
 * schema or a class instance (matching ADR 0029 D2). OpsCrew validates every definition it loads
 * (`@opscrew/edge-providers`) and everything it reads from one.
 *
 * Fields are added with their first reader: PR 1 holds the fields currently read plus the origin
 * protection decisions from #29; credentials, connectors, and extra Terraform/UI fields join as
 * PRs 2–4 add their readers.
 */

/** The contract version this OpsCrew reads; a definition of another version is refused. */
export const EDGE_PROVIDER_CONTRACT_VERSION = 1;

/**
 * How the edge authenticates itself to the app's origin server (ADR 0038, D6):
 * - `cloudflare-aop`: Cloudflare Origin CA + per-hostname mTLS Authenticated Origin Pulls (`pull.pem`).
 * - `mtls-client-cert`: Per-app P-256 client certificate (`pull.pem`) presented by the edge backend (Fastly).
 * - `shared-header`: Per-app 32-byte hex secret header set via a connector call (never in Terraform
 *   state), verified by the server's reverse proxy before `kamal-proxy` and before trusting the
 *   visitor-IP header (Bunny.net, Gcore).
 */
export type EdgeOriginAuth = "cloudflare-aop" | "mtls-client-cert" | "shared-header";

/**
 * How the server's firewall handles the edge's published IP addresses (ADR 0038, D6):
 * - `compact-cidrs`: The provider publishes a compact CIDR list (~20 ranges) that fits cloud
 *   firewalls and the server's own web filter (Cloudflare, Fastly).
 * - `dynamic-ips`: The provider publishes a large or frequently changing list of edge IPs that
 *   exceeds cloud firewall CIDR limits; the firewall leaves ports 80/443 open and `originAuth`
 *   (`shared-header`) is the gate (Bunny.net, Gcore).
 */
export type EdgeOriginIpFiltering = "compact-cidrs" | "dynamic-ips";

/** Capabilities of an edge proxy provider. */
export interface EdgeProviderCapabilities {
  /** How the edge authenticates upstream requests to the origin server. */
  originAuth: EdgeOriginAuth;
  /** Whether the edge's published IP list fits cloud firewalls (`compact-cidrs`) or not (`dynamic-ips`). */
  originIpFiltering: EdgeOriginIpFiltering;
  /**
   * HTTP request header carrying the real visitor's IP address on requests from this edge
   * (for example `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`, `Fastly-Client-IP`).
   */
  realIpHeader: string;
}

/** Terraform / OpenTofu facts for an edge/DNS provider. */
export interface EdgeProviderTerraform {
  /** Terraform resource type of a DNS record when the provider manages DNS. */
  dnsRecordResourceType?: string;
}

/** Plain-English wording per OpsCrew surface. */
export interface EdgeProviderTexts {
  secops: {
    /** Label used in TLS/edge scan reports (for example `Cloudflare's edge`). */
    edgeLabel: string;
    /** Remediation hint for edge TLS findings. */
    edgeTlsHint: string;
  };
}

/** Everything OpsCrew reads about a single edge proxy provider (ADR 0038). */
export interface EdgeProviderDefinition {
  contractVersion: typeof EDGE_PROVIDER_CONTRACT_VERSION;
  id: string;
  displayName: string;
  capabilities: EdgeProviderCapabilities;
  terraform: EdgeProviderTerraform;
  texts: EdgeProviderTexts;
}
