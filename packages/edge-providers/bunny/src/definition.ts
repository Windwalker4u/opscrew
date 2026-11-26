/**
 * Bunny.net DNS and edge proxy provider definition (ADR 0038).
 */
import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";
import { BUNNY_API_KEY_URL } from "./client";
import { BUNNY_EDGE_MODULE_FILES, BUNNY_EDGE_MODULE_NAME } from "./module";
import { BUNNY_ORIGIN_AUTH_HEADER } from "./origin-header";

export const definition: EdgeProviderDefinition = {
  contractVersion: EDGE_PROVIDER_CONTRACT_VERSION,
  id: "bunny",
  displayName: "Bunny.net",
  capabilities: {
    dns: true,
    originAuth: "shared-header",
    originAuthHeader: BUNNY_ORIGIN_AUTH_HEADER,
    originIpFiltering: "dynamic-ips",
    realIpHeader: "X-Real-IP",
  },
  credentials: {
    envVars: ["BUNNYNET_API_KEY"],
    labels: {
      BUNNYNET_API_KEY: "Bunny.net API key",
    },
    createUrl: BUNNY_API_KEY_URL,
    envPrefixes: ["BUNNYNET"],
  },
  terraform: {
    provider: {
      name: "bunnynet",
      source: "BunnyWay/bunnynet",
      version: "~> 0.20.2",
    },
    credentialsComment: "API key from the BUNNYNET_API_KEY environment variable.",
    dnsRecordResourceType: "bunnynet_dns_record",
    module: {
      name: BUNNY_EDGE_MODULE_NAME,
      files: BUNNY_EDGE_MODULE_FILES,
    },
  },
  texts: {
    originProtectionNote:
      "Bunny.net's edge IPs are numerous and change often, so the cloud firewall leaves ports 80 and 443 open and the server's reverse proxy rejects every request missing OpsCrew's per-app X-OpsCrew-Origin-Token header before kamal-proxy and before trusting X-Real-IP.",
    secops: {
      edgeLabel: "Bunny.net's edge",
      edgeTlsHint:
        "This is what Bunny.net serves to visitors: check the Pull Zone's custom hostname TLS settings in the Bunny.net dashboard.",
    },
  },
};
