export type {
  UptimeEntry,
  UptimeEntryServer,
  UptimeHook,
  UptimeHostState,
  UptimeReport,
  UptimeServerReport,
  UptimeState,
} from "../../uptime/worker.mjs";
/** The most a server's report to the uptime Worker holds, in bytes. */
export { MAX_BODY as UPTIME_REPORT_MAX_BYTES } from "../../uptime/worker.mjs";
export { UPTIME_WORKER_SCRIPT, UPTIME_WORKER_SHA256 } from "../generated/uptime";

/**
 * The uptime Worker in a Cloudflare account: its script's name, its KV namespace's title and
 * binding, its Cron Trigger, its compatibility date, the hostnames one account can have checked,
 * and the free plan's subrequests per run.
 */
export const UPTIME_WORKER = {
  name: "opscrew-uptime",
  namespace: "opscrew-uptime",
  binding: "UPTIME",
  cron: "*/5 * * * *",
  compatibilityDate: "2026-10-01",
  maxHostnames: 40,
  subrequests: 50,
} as const;
