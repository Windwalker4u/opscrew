/**
 * The contract for a DNS and edge proxy provider (ADR 0038): everything OpsCrew knows about one
 * provider that hosts DNS, proxies web traffic at the edge, or both, in one definition a provider
 * package exports. Only plain data, regular expressions, and functions cross it — never a zod
 * schema or a class instance (matching ADR 0029 D2). OpsCrew validates every definition it loads
 * (`@opscrew/edge-providers`) and everything it reads from one.
 */
import type { CredentialCheck } from "./connector";
import type { ProviderConnectorDeps, ProviderRequirement, ProviderTokenRule } from "./provider";

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

/** IPv4 and IPv6 CIDR/address ranges published by an edge provider for origin allowlisting / real-IP trust. */
export interface EdgeIpRanges {
  ipv4: readonly string[];
  ipv6: readonly string[];
}

/** Capabilities of a DNS and/or edge proxy provider. */
export interface EdgeProviderCapabilities {
  /** True when the provider hosts authoritative DNS zones (Cloudflare, Bunny.net, Gcore; false for Fastly). */
  dns: boolean;
  /** True when the provider proxies HTTP/HTTPS traffic at the edge (all four). */
  edge: boolean;
  /** True when its DNS supports apex CNAME flattening / PullZone / alias records. */
  apexCnameFlattening: boolean;
  /** How the edge authenticates upstream requests to the origin server. */
  originAuth: EdgeOriginAuth;
  /** Whether the edge's published IP list fits cloud firewalls (`compact-cidrs`) or not (`dynamic-ips`). */
  originIpFiltering: EdgeOriginIpFiltering;
  /**
   * HTTP request header carrying the real visitor's IP address on requests from this edge
   * (for example `CF-Connecting-IP`, `X-Real-IP`, `X-Forwarded-For`, `Fastly-Client-IP`).
   */
  realIpHeader: string;
  /**
   * True only for Cloudflare, whose account-specific features (Tunnel, Access, Workers hosting,
   * R2, Workers uptime check, Registrar, Previews wildcard) stay Cloudflare-specific.
   */
  cloudflareOnlyFeatures: boolean;
}

/** How the edge/DNS provider's credentials are configured and scanned. */
export interface EdgeProviderCredentials {
  /** The environment variables, in order. */
  envVars: readonly string[];
  /** Human-readable label for each variable in `envVars`. */
  labels: Readonly<Record<string, string>>;
  /** `any`: first set variable wins; `all`: every variable is required. */
  mode: "any" | "all";
  /** Where the user creates API tokens or keys. */
  createUrl: string;
  /** Formats `opscrew scan` recognises; empty when credentials have no recognisable shape. */
  tokenRules: readonly ProviderTokenRule[];
  /** Prefixes of variables that belong to the provider, for detection (e.g. `CLOUDFLARE`). */
  envPrefixes: readonly string[];
  /** Engine log pattern naming the provider's API or resources, so a 403 is blamed on its token. */
  apiPattern: RegExp;
}

/** Live runtime handle created by an edge provider definition. */
export interface EdgeProviderConnector {
  readonly id: string;
  readonly displayName: string;
  /** True when the required credentials are present in `env`. */
  readonly configured: boolean;
  /** Verifies that the configured credentials are valid against the provider API. */
  verifyCredentials(): Promise<CredentialCheck>;
  /**
   * Fetches the provider's currently published edge IP ranges for firewall rules and real-IP trust.
   * Present for every edge provider with published IP lists.
   */
  fetchEdgeIpRanges?(): Promise<EdgeIpRanges>;
}

/** Terraform / OpenTofu facts for an edge/DNS provider. */
export interface EdgeProviderTerraform {
  provider: ProviderRequirement;
  /** Comment placed above the provider block (for example `Token from CLOUDFLARE_API_TOKEN.`). */
  credentialsComment: string;
  /** Vendored DNS module folder name when `capabilities.dns` is true (e.g. `cloudflare-dns`). */
  dnsModuleName?: string;
  /** Vendored edge module folder name when Terraform manages the edge service/pullzone. */
  edgeModuleName?: string;
  /** Terraform resource type of a DNS record when `capabilities.dns` is true. */
  dnsRecordResourceType?: string;
  /** Provider-populated attributes ignored by drift detection. */
  mirroredAttributes: Readonly<Record<string, readonly string[]>>;
}

/** Plain-English pricing summary shown in design and docs. */
export interface EdgeProviderPricing {
  /** Short one-line summary of the free tier or minimum monthly spend. */
  freeTier: string;
  /** Short one-line summary of ongoing usage pricing. */
  summary: string;
}

/** Plain-English wording per OpsCrew surface. */
export interface EdgeProviderTexts {
  interview: {
    label: string;
    hint: string;
  };
  design: {
    /** Plain note shown when Cloudflare-only features are unavailable on this provider (empty on Cloudflare). */
    cloudflareOnlyNote?: string;
    /** Plain note describing how origin traffic is gated for this provider. */
    originProtectionNote: string;
  };
  runbook: {
    console: string;
  };
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
  name: string;
  consoleUrl: string;
  signupUrl: string;
  pricingUrl: string;
  capabilities: EdgeProviderCapabilities;
  credentials: EdgeProviderCredentials;
  connector(deps: ProviderConnectorDeps): EdgeProviderConnector;
  terraform: EdgeProviderTerraform;
  pricing: EdgeProviderPricing;
  texts: EdgeProviderTexts;
}
