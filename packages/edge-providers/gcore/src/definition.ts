/**
 * Gcore DNS and CDN edge proxy provider definition (ADR 0038).
 */
import { EDGE_PROVIDER_CONTRACT_VERSION, type EdgeProviderDefinition } from "@opscrew/contracts";
import { GCORE_API_TOKEN_URL, gcoreClient } from "./client";
import { GCORE_EDGE_MODULE_FILES, GCORE_EDGE_MODULE_NAME } from "./module";
import { applyGcoreOriginHeader, planGcoreOriginHeader } from "./origin-header";
import { checkGcorePlan, renderGcoreRoot } from "./root";

export const definition: EdgeProviderDefinition = {
  contractVersion: EDGE_PROVIDER_CONTRACT_VERSION,
  id: "gcore",
  displayName: "Gcore",
  capabilities: {
    originAuth: "shared-header",
    originAuthHeader: "X-OpsCrew-Origin-Token",
    originIpFiltering: "dynamic-ips",
    realIpHeader: "X-Forwarded-For",
  },
  credentials: {
    envVars: ["GCORE_PERMANENT_API_TOKEN"],
    createUrl: GCORE_API_TOKEN_URL,
  },
  terraform: {
    provider: {
      name: "gcore",
      source: "G-Core/gcore",
      version: "~> 0.37.2",
    },
    credentialsComment:
      "Permanent API token from the GCORE_PERMANENT_API_TOKEN environment variable.",
    dnsRecordResourceType: "gcore_dns_zone_record",
    module: {
      name: GCORE_EDGE_MODULE_NAME,
      files: GCORE_EDGE_MODULE_FILES,
    },
    root: {
      resourceIdOutput: "gcore_cdn_resource_id",
      render: renderGcoreRoot,
    },
  },
  secops: {
    checkPlan: checkGcorePlan,
  },
  connector: {
    verifyCredentials: ({ apiKey, fetch, redactor }) =>
      gcoreClient({
        apiToken: apiKey,
        ...(fetch === undefined ? {} : { fetch }),
        ...(redactor === undefined ? {} : { redactor }),
      }).verifyCredentials(),
    lookupDnsZone: ({ apiKey, domain, fetch, redactor }) =>
      gcoreClient({
        apiToken: apiKey,
        ...(fetch === undefined ? {} : { fetch }),
        ...(redactor === undefined ? {} : { redactor }),
      }).findDnsZone(domain),
    planOriginHeader: ({ apiKey, resourceId, headerName, token, fetch, redactor }) =>
      planGcoreOriginHeader(
        gcoreClient({
          apiToken: apiKey,
          ...(fetch === undefined ? {} : { fetch }),
          ...(redactor === undefined ? {} : { redactor }),
        }),
        { resourceId, headerName, token },
      ),
    applyOriginHeader: ({ apiKey, plan, token, approvedHash, fetch, redactor }) =>
      applyGcoreOriginHeader(
        gcoreClient({
          apiToken: apiKey,
          ...(fetch === undefined ? {} : { fetch }),
          ...(redactor === undefined ? {} : { redactor }),
        }),
        plan,
        { token, approvedHash },
      ),
  },
  texts: {
    secops: {
      edgeLabel: "Gcore's edge",
      edgeTlsHint:
        "This is what Gcore serves to visitors: check the CDN resource's SSL certificate settings in the Gcore Customer Portal.",
    },
  },
};
