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
}

/** A Worker secret's value: the webhook's address, and ntfy's token when it has one. */
export interface UptimeHook {
  url: string;
  token?: string;
}

/** A hostname that isn't up. */
export interface UptimeHostState {
  status: "suspect" | "down";
  /** The first failure of this outage, `2026-11-25T10:05:00Z`. */
  since: string;
  reason: string;
}

/** `state:<id>`, written only by the Worker: its hostnames that aren't up (an up one is absent). */
export interface UptimeState {
  hosts: Record<string, UptimeHostState>;
}

/** The part of a Workers KV namespace the Worker uses. */
export interface UptimeKv {
  list(options: { prefix: string }): Promise<{ keys: { name: string }[] }>;
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
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

/** One run: fetches each entry's hostnames once, posts the changes, writes the changed states. */
export function runUptime(env: UptimeEnv, io: UptimeIo): Promise<void>;

declare const worker: {
  /** The Cron Trigger's handler: {@link runUptime} inside `ctx.waitUntil`. */
  scheduled(
    controller: unknown,
    env: UptimeEnv,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<void>;
};
export default worker;
