/**
 * Cloudflare's DNS and edge proxy provider definition (ADR 0038). Cloudflare-only capabilities
 * (Tunnel, Access, Workers hosting, R2, Workers uptime check, Registrar, Previews wildcard, and
 * account moves) remain in `@opscrew/connector-cloudflare`.
 */
import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";

export const definition: EdgeProviderDefinition = {
  contractVersion: EDGE_PROVIDER_CONTRACT_VERSION,
  id: "cloudflare",
  displayName: "Cloudflare",
  capabilities: {
    originAuth: "cloudflare-aop",
    originIpFiltering: "compact-cidrs",
    realIpHeader: "CF-Connecting-IP",
  },
  credentials: {
    envVars: ["CLOUDFLARE_API_TOKEN"],
    createUrl: "https://dash.cloudflare.com/profile/api-tokens",
  },
  terraform: {
    provider: {
      name: "cloudflare",
      source: "cloudflare/cloudflare",
      version: "~> 5.27",
    },
    credentialsComment: "Token from the CLOUDFLARE_API_TOKEN environment variable.",
    dnsRecordResourceType: "cloudflare_dns_record",
  },
  texts: {
    secops: {
      edgeLabel: "Cloudflare's edge",
      edgeTlsHint:
        "This is what Cloudflare serves to visitors: change it in Cloudflare's SSL/TLS settings for the zone.",
    },
  },
};
