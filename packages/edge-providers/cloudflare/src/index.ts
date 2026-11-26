/**
 * Cloudflare's DNS and edge proxy provider definition (ADR 0038), wrapping
 * `@opscrew/connector-cloudflare`. Cloudflare-only capabilities (Tunnel, Access, Workers hosting,
 * R2, Workers uptime check, Registrar, Previews wildcard, and account moves) remain in
 * `@opscrew/connector-cloudflare`.
 */
import { CLOUDFLARE_TOKEN_PAGE, cloudflareConnector } from "@opscrew/connector-cloudflare";
import {
  EDGE_PROVIDER_CONTRACT_VERSION,
  type EdgeIpRanges,
  type EdgeProviderConnector,
  type EdgeProviderDefinition,
  type FetchLike,
  type ProviderConnectorDeps,
} from "@opscrew/contracts";
import { OpsCrewError, Redactor } from "@opscrew/core";

const CLOUDFLARE_IPS_URL = "https://api.cloudflare.com/client/v4/ips";

interface CloudflareIpsResponse {
  success?: boolean;
  result?: {
    ipv4_cidrs?: unknown;
    ipv6_cidrs?: unknown;
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Fetches Cloudflare's currently published IPv4 and IPv6 edge CIDRs from `/client/v4/ips`. */
export async function fetchCloudflareEdgeIpRanges(
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<EdgeIpRanges> {
  const response = await fetchImpl(CLOUDFLARE_IPS_URL, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare's IP range list answered HTTP ${response.status}.`,
      { hint: "Check your internet connection and Cloudflare's status page, then try again." },
    );
  }
  const body = (await response.json()) as CloudflareIpsResponse;
  const ipv4 = stringList(body.result?.ipv4_cidrs);
  const ipv6 = stringList(body.result?.ipv6_cidrs);
  if (body.success === false || ipv4.length === 0) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      "Cloudflare's IP range list returned no IPv4 CIDR ranges.",
      { hint: "Check Cloudflare's status page and try again." },
    );
  }
  return { ipv4, ipv6 };
}

function createCloudflareEdgeConnector(deps: ProviderConnectorDeps): EdgeProviderConnector {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const redactor = new Redactor();
  const base = cloudflareConnector({
    env: deps.env,
    fetch: fetchImpl,
    redactor,
    ...(deps.version === undefined ? {} : { version: deps.version }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
  });
  const token = deps.env.CLOUDFLARE_API_TOKEN?.trim();
  if (token) deps.redactor?.addLiteral(token, "cloudflare-token");

  return {
    id: "cloudflare",
    displayName: "Cloudflare",
    configured: base.client !== undefined,
    verifyCredentials: () => base.verifyCredentials(),
    fetchEdgeIpRanges: () => fetchCloudflareEdgeIpRanges(fetchImpl),
  };
}

export const definition: EdgeProviderDefinition = {
  contractVersion: EDGE_PROVIDER_CONTRACT_VERSION,
  id: "cloudflare",
  displayName: "Cloudflare",
  name: "Cloudflare",
  consoleUrl: "https://dash.cloudflare.com",
  signupUrl: "https://dash.cloudflare.com/sign-up",
  pricingUrl: "https://www.cloudflare.com/plans/",
  capabilities: {
    dns: true,
    edge: true,
    apexCnameFlattening: true,
    originAuth: "cloudflare-aop",
    originIpFiltering: "compact-cidrs",
    realIpHeader: "CF-Connecting-IP",
    cloudflareOnlyFeatures: true,
  },
  credentials: {
    envVars: ["CLOUDFLARE_API_TOKEN"],
    labels: {
      CLOUDFLARE_API_TOKEN: "Cloudflare API token",
    },
    mode: "any",
    createUrl: CLOUDFLARE_TOKEN_PAGE,
    tokenRules: [],
    envPrefixes: ["CLOUDFLARE"],
    apiPattern: /cloudflare/i,
  },
  connector: createCloudflareEdgeConnector,
  terraform: {
    provider: {
      name: "cloudflare",
      source: "cloudflare/cloudflare",
      version: "~> 5.0",
    },
    credentialsComment: "Token from the CLOUDFLARE_API_TOKEN environment variable.",
    dnsModuleName: "cloudflare-dns",
    dnsRecordResourceType: "cloudflare_dns_record",
    mirroredAttributes: {},
  },
  pricing: {
    freeTier: "Free DNS, CDN proxy, Universal SSL, and 5 custom WAF rules per zone.",
    summary: "Free plan covers standard DNS and proxying; Pro starts at $20/month per zone.",
  },
  texts: {
    interview: {
      label: "Cloudflare",
      hint: "Free DNS, CDN proxy, Universal SSL, origin mTLS, plus optional Tunnel, Access, R2, and Workers.",
    },
    design: {
      originProtectionNote:
        "Server web ports accept only Cloudflare's CIDRs, and origin TLS requires Cloudflare's per-hostname client certificate (Authenticated Origin Pulls).",
    },
    runbook: {
      console: "Cloudflare dashboard (https://dash.cloudflare.com)",
    },
    secops: {
      edgeLabel: "Cloudflare's edge",
      edgeTlsHint:
        "This is what Cloudflare serves to visitors: change it in Cloudflare's SSL/TLS settings for the zone.",
    },
  },
};
