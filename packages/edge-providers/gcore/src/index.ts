export {
  GCORE_API_BASE,
  GCORE_API_TOKEN_URL,
  type GcoreCdnResource,
  type GcoreClient,
  type GcoreClientDeps,
  type GcoreDnsZone,
  gcoreClient,
} from "./client";
export { definition } from "./definition";
export { GCORE_EDGE_MODULE_FILES, GCORE_EDGE_MODULE_NAME } from "./module";
export {
  applyGcoreOriginHeader,
  type GcoreOriginHeaderAction,
  planGcoreOriginHeader,
} from "./origin-header";
export { checkGcorePlan, gcoreOriginGroupName, renderGcoreRoot } from "./root";
