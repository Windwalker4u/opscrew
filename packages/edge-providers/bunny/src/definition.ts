/**
 * Bunny.net DNS and edge proxy provider definition (ADR 0038).
 */
import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";
import { BUNNY_API_KEY_URL, bunnyClient } from "./client";
import { BUNNY_EDGE_MODULE_FILES, BUNNY_EDGE_MODULE_NAME } from "./module";
import { applyBunnyOriginHeader, planBunnyOriginHeader } from "./origin-header";
import { checkBunnyPlan, renderBunnyRoot } from "./root";

export const definition: EdgeProviderDefinition = {
  contractVersion: EDGE_PROVIDER_CONTRACT_VERSION,
  id: "bunny",
  displayName: "Bunny.net",
  capabilities: {
    originAuth: "shared-header",
    originAuthHeader: "X-OpsCrew-Origin-Token",
    originIpFiltering: "dynamic-ips",
    realIpHeader: "X-Real-IP",
  },
  credentials: {
    envVars: ["BUNNYNET_API_KEY"],
    createUrl: BUNNY_API_KEY_URL,
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
    root: {
      resourceIdOutput: "bunny_pullzone_id",
      render: renderBunnyRoot,
    },
  },
  secops: {
    checkPlan: checkBunnyPlan,
  },
  connector: {
    verifyCredentials: ({ apiKey, fetch, redactor }) =>
      bunnyClient({
        apiKey,
        ...(fetch === undefined ? {} : { fetch }),
        ...(redactor === undefined ? {} : { redactor }),
      }).verifyCredentials(),
    lookupDnsZone: ({ apiKey, domain, fetch, redactor }) =>
      bunnyClient({
        apiKey,
        ...(fetch === undefined ? {} : { fetch }),
        ...(redactor === undefined ? {} : { redactor }),
      }).findDnsZone(domain),
    planOriginHeader: ({ apiKey, resourceId, headerName, token, fetch, redactor }) =>
      planBunnyOriginHeader(
        bunnyClient({
          apiKey,
          ...(fetch === undefined ? {} : { fetch }),
          ...(redactor === undefined ? {} : { redactor }),
        }),
        { pullZoneId: resourceId, headerName, token },
      ),
    applyOriginHeader: ({ apiKey, plan, token, approvedHash, fetch, redactor }) =>
      applyBunnyOriginHeader(
        bunnyClient({
          apiKey,
          ...(fetch === undefined ? {} : { fetch }),
          ...(redactor === undefined ? {} : { redactor }),
        }),
        plan,
        { token, approvedHash },
      ),
  },
  texts: {
    secops: {
      edgeLabel: "Bunny.net's edge",
      edgeTlsHint:
        "This is what Bunny.net serves to visitors: check the Pull Zone's custom hostname TLS settings in the Bunny.net dashboard.",
    },
  },
};
