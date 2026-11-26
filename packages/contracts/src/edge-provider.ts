/**
 * The contract for a DNS and edge proxy provider (ADR 0038): everything OpsCrew knows about one
 * provider that proxies web traffic at the edge (and optionally hosts DNS), in one definition a
 * provider package exports. Only plain data, regular expressions, and functions cross it — never
 * a zod schema or a class instance (matching ADR 0029 D2). OpsCrew validates every definition it
 * loads (`@opscrew/edge-providers`) and everything it reads from one.
 */
import type { ProviderRequirement } from "./provider";

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
  /** True when the provider hosts authoritative DNS zones (Cloudflare, Bunny.net, Gcore; false for Fastly). */
  dns: boolean;
  /** How the edge authenticates upstream requests to the origin server. */
  originAuth: EdgeOriginAuth;
  /**
   * HTTP header name carrying the shared origin-verification token when `originAuth` is
   * `"shared-header"` (for example `X-OpsCrew-Origin-Token`). Omitted otherwise.
   */
  originAuthHeader?: string;
  /** Whether the edge's published IP list fits cloud firewalls (`compact-cidrs`) or not (`dynamic-ips`). */
  originIpFiltering: EdgeOriginIpFiltering;
  /**
   * HTTP request header carrying the real visitor's IP address on requests from this edge
   * (for example `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`, `Fastly-Client-IP`).
   */
  realIpHeader: string;
}

/** How the edge/DNS provider's credentials are configured. */
export interface EdgeProviderCredentials {
  /** The environment variables, in order. */
  envVars: readonly string[];
  /** Human-readable label for each variable in `envVars`. */
  labels: Readonly<Record<string, string>>;
  /** Where the user creates API tokens or keys. */
  createUrl: string;
  /** Prefixes of variables that belong to the provider, for detection (e.g. `BUNNYNET`). */
  envPrefixes: readonly string[];
}

/** Vendored Terraform module shipped by an edge provider package. */
export interface EdgeProviderTerraformModule {
  /** Folder name placed under `opscrew/infra/modules/<name>`. */
  name: string;
  /** Relative file path -> file content (`main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`). */
  files: Readonly<Record<string, string>>;
}

/** Terraform / OpenTofu facts for an edge/DNS provider. */
export interface EdgeProviderTerraform {
  provider: ProviderRequirement;
  /** Comment placed above the provider block (for example `Token from the CLOUDFLARE_API_TOKEN environment variable.`). */
  credentialsComment: string;
  /** Terraform resource type of a DNS record when `capabilities.dns` is true. */
  dnsRecordResourceType?: string;
  /** Vendored edge/DNS Terraform module shipped by this provider package. */
  module?: EdgeProviderTerraformModule;
}

/** Plain-English wording per OpsCrew surface. */
export interface EdgeProviderTexts {
  /** Plain-English summary of how origin traffic is gated for this provider. */
  originProtectionNote: string;
  secops: {
    /** Label used in TLS/edge scan reports (for example `Cloudflare's edge`). */
    edgeLabel: string;
    /** Remediation hint for edge TLS findings. */
    edgeTlsHint: string;
  };
}

/** Everything OpsCrew reads about a single DNS and/or edge proxy provider (ADR 0038). */
export interface EdgeProviderDefinition {
  contractVersion: typeof EDGE_PROVIDER_CONTRACT_VERSION;
  id: string;
  displayName: string;
  capabilities: EdgeProviderCapabilities;
  credentials: EdgeProviderCredentials;
  terraform: EdgeProviderTerraform;
  texts: EdgeProviderTexts;
}
