/** `entry:<id>` in the namespace: one app's environment, written by OpsCrew. Never an address. */
export interface UptimeEntry {
  version: 1;
  /** `<owner>/<repo>`. */
  repository: string;
  /** The app's key or name. */
  app: string;
  environment: string;
  hosts: { hostname: string; healthPath: string }[];
  webhook: "slack" | "discord" | "ntfy";
  /** The name of the Worker secret with the webhook's {@link UptimeHook}, `HOOK_<hex16>`. */
  secret: string;
  /** The servers that report their own checks (`POST /report`), each by its id in the plan. */
  servers?: UptimeEntryServer[];
  /** The flags of `npx opscrew rotate` in a credential's message (` --env staging`, or empty). */
  rotate?: string;
  /** Test only: the minutes a server may stay silent, used from 5 to 1,560; else 26 hours. */
  heartbeatMinutes?: number;
}

/** A server of the entry that reports to the Worker. */
export interface UptimeEntryServer {
  /** Its id in the Actions check, `hetzner-shop`: never an address. */
  id: string;
  /** When it was first listed, `2026-11-25T10:00:00Z`: its silence counts from here until it reports. */
  since: string;
  /** Its restore drills' schedule, while the app has scheduled drills. */
  drill?: "weekly" | "daily";
}

/** A Worker secret's value: the webhook's address, ntfy's token, and the report key. */
export interface UptimeHook {
  url: string;
  token?: string;
  /** The environment's report key, 32 bytes in hex, that signs its servers' reports. */
  report?: string;
}

/** A hostname that isn't up. */
export interface UptimeHostState {
  status: "suspect" | "down";
  /** The first failure of this outage, `2026-11-25T10:05:00Z`. */
  since: string;
  reason: string;
}

/** `state:<id>`, written only by the Worker's cron: what isn't up (an up one is absent). */
export interface UptimeState {
  hosts: Record<string, UptimeHostState>;
  /** The servers whose reports stopped, each with the time of its "stopped" alert. */
  stopped?: Record<string, string>;
}

/**
 * A server's report (`POST /report`), signed with the environment's report key. A failing check
 * carries `since` only in the Worker's copy ({@link UptimeServerReport}).
 */
export interface UptimeReport {
  version: 1;
  /** The server's id, one of the entry's `servers`. */
  server: string;
  kind: "change" | "heartbeat";
  disk: {
    status: "ok" | "warn" | "high" | "unknown";
    percent?: number;
    /** Bytes. */
    free?: number;
    /** Bytes. */
    total?: number;
    since?: string;
  };
  snapshot: {
    status: "ok" | "failed" | "copy-failed" | "none" | "unknown";
    id?: string;
    since?: string;
  };
  drill: {
    status: "ok" | "failed" | "late" | "none" | "unknown";
    result?: "healthy" | "unhealthy" | "not-restored" | "failed";
    /** The last scheduled drill's end, `2026-11-24T03:41:00Z`. */
    at?: string;
    since?: string;
  };
  certificates: {
    hostname: string;
    status: "ok" | "warn" | "expired" | "none";
    days?: number;
    since?: string;
  }[];
  /** Absent with `observability.check.credentials` off. */
  credentials?: {
    name: string;
    status: "ok" | "old";
    days: number;
    source: "made" | "rotated" | "first-deploy";
    since?: string;
  }[];
}

/**
 * `report:<id>/<server>`, written only by the Worker's `fetch` handler: the server's last
 * accepted report, with the last known status of each check (an `unknown` one, or a
 * certificate's `none`, keeps the one before) and, on each failing one, `since`, when it started
 * failing.
 */
export interface UptimeServerReport extends UptimeReport {
  /** The report's time (`X-OpsCrew-Time`), Unix seconds; also the key's KV metadata, `{ at }`. */
  at: number;
}

/** The part of a Workers KV namespace the Worker uses. */
export interface UptimeKv {
  list(options?: { prefix?: string }): Promise<{ keys: { name: string; metadata?: unknown }[] }>;
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The Worker's bindings: the namespace, and one secret per entry, by its name. */
export interface UptimeEnv {
  UPTIME: UptimeKv;
  [secret: string]: string | UptimeKv | undefined;
}

/** What a run reads outside itself. */
export interface UptimeIo {
  fetch: typeof fetch;
  /** Milliseconds since the epoch, as `Date.now()`. */
  now(): number;
}

/**
 * One run: fetches each entry's hostnames once, posts the changes and the servers whose reports
 * stopped or resumed, and writes the changed states.
 */
/** The most a report's body holds, in bytes; a longer one is refused with 413. */
export const MAX_BODY: number;

export function runUptime(env: UptimeEnv, io: UptimeIo): Promise<void>;

/**
 * A request to the Worker's address: `POST /report`, a server's signed report, whose changed
 * checks it posts before it keeps the report; 404 for anything else.
 */
export function handleReport(request: Request, env: UptimeEnv, io: UptimeIo): Promise<Response>;

declare const worker: {
  /** The Cron Trigger's handler: {@link runUptime} inside `ctx.waitUntil`. */
  scheduled(
    controller: unknown,
    env: UptimeEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void>;
  /** The workers.dev address's handler: {@link handleReport}. */
  fetch(request: Request, env: UptimeEnv): Promise<Response>;
};
export default worker;
