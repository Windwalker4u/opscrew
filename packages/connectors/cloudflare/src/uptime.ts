/**
 * The uptime check in the user's Cloudflare account (feature 046): one Worker per account,
 * `opscrew-uptime`, with a Cron Trigger every 5 minutes and one Workers KV namespace, shared by
 * every OpsCrew app there, and its workers.dev address, where servers send their reports. Each
 * environment owns one KV entry, the state the Worker keeps for it, its servers' last reports and
 * one Worker secret (its webhook's address and report key). `inspectUptime` reads them,
 * `planUptime` plans one environment's change, `applyUptime` applies a plan approved by its hash
 * (`cloudflare-apply`), as the shared-resources adapter does (ADR 0014). See
 * `specs/046-uptime-worker/data-model.md`.
 */
import {
  canonicalJson,
  isPlanHash,
  listText,
  OpsCrewError,
  plural,
  sha256Hex,
  zodIssues,
} from "@opscrew/core";
import { z } from "zod";
import {
  CLOUDFLARE_TOKEN_PAGE,
  CLOUDFLARE_UPTIME_PERMISSIONS,
  type CloudflareClient,
  CloudflareError,
  KvNamespaceExistsError,
  WORKERS_SUBDOMAIN_HINT,
} from "./client";

/** The pieces in the user's Cloudflare account, as the Worker's script expects them. */
export const UPTIME_RESOURCES = {
  worker: "opscrew-uptime",
  namespace: "opscrew-uptime",
  binding: "UPTIME",
  cron: "*/5 * * * *",
  compatibilityDate: "2026-10-01",
  /** Most hostnames across the account's entries: 50 subrequests a run leave 10 for posts. */
  maxHostnames: 40,
} as const;

const { worker: WORKER, namespace: NAMESPACE } = UPTIME_RESOURCES;
const [WORKERS_PERMISSION, KV_PERMISSION] = CLOUDFLARE_UPTIME_PERMISSIONS;
const ENTRY_PREFIX = "entry:";
const STATE_PREFIX = "state:";
const REPORT_PREFIX = "report:";
/** The KV key that records the SHA-256 of the script last uploaded. */
const WORKER_KEY = "opscrew:worker";

const HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
/** A server's id in the Actions check: never an address and never a `/`, so its report key is its own. */
const SERVER_ID = /^[A-Za-z0-9_-]+$/;

const UptimeEntrySchema = z.looseObject({
  version: z.literal(1),
  /** `owner/repo`. */
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
  app: z.string().min(1),
  environment: z.string().min(1),
  hosts: z
    .array(
      z.looseObject({
        hostname: z.string().regex(HOSTNAME),
        healthPath: z.string().regex(/^\/\S*$/),
      }),
    )
    .min(1),
  webhook: z.enum(["slack", "discord", "ntfy"]),
  /** The name of the Worker secret holding the webhook's address: {@link uptimeSecretName}. */
  secret: z.string().regex(/^HOOK_[0-9a-f]{16}$/),
  /** The servers whose reports the Worker accepts, each since it was first listed. */
  servers: z
    .array(
      z.looseObject({
        id: z.string().regex(SERVER_ID),
        since: z.iso.datetime(),
        /** Present while the app has scheduled restore drills. */
        drill: z.string().min(1).optional(),
      }),
    )
    .optional(),
  /** The flags of the `opscrew rotate` command in a credential's message. */
  rotate: z.string().optional(),
  /** Test only: the live test's shorter silence limit; `planUptime` refuses it otherwise. */
  heartbeatMinutes: z.number().int().positive().optional(),
});

/** One environment's KV entry (`entry:<id>`): what the Worker checks and where it posts. */
export type UptimeEntry = z.infer<typeof UptimeEntrySchema>;

const UptimeStateSchema = z.looseObject({
  hosts: z.record(
    z.string(),
    z.looseObject({
      status: z.enum(["suspect", "down"]),
      since: z.string(),
      reason: z.string(),
    }),
  ),
});

/** The Worker's state of an entry (`state:<id>`): each hostname that isn't up. */
export type UptimeState = z.infer<typeof UptimeStateSchema>;

/** The Worker's `state:` value; `undefined` for anything the Worker does not write. */
export function parseUptimeState(text: string): UptimeState | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = UptimeStateSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The Worker secret's value (data-model.md): the webhook's address, for ntfy its token, and the
 * environment's report key (32 bytes in hex) that signs its servers' reports.
 */
const WebhookSecretSchema = z.object({
  url: z.url(),
  token: z.string().min(1).optional(),
  report: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

const WorkerRecordSchema = z.looseObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** `entry:<id>`, the environment's entry. */
export function uptimeEntryKey(id: string): string {
  return `${ENTRY_PREFIX}${id}`;
}

/** `state:<id>`, the state the Worker keeps for the environment. */
export function uptimeStateKey(id: string): string {
  return `${STATE_PREFIX}${id}`;
}

/** `report:<id>/<server>`, the server's last report, which only the Worker writes. */
export function uptimeReportKey(id: string, server: string): string {
  return `${REPORT_PREFIX}${id}/${server}`;
}

/** The report keys of `id`'s servers among `keys`, not those of an id that starts the same. */
function reportsOf(keys: readonly string[], id: string): string[] {
  const prefix = uptimeReportKey(id, "");
  return keys.filter((k) => k.startsWith(prefix) && SERVER_ID.test(k.slice(prefix.length)));
}

/** `HOOK_<the first 16 hex characters of the SHA-256 of id>`, the environment's secret. */
export function uptimeSecretName(id: string): string {
  return `HOOK_${sha256Hex(id).slice(0, 16)}`;
}

/**
 * An entry's id (`<owner>/<repo>/<app>/<env>`, or its key) in words: `owner/repo (env)`, with the
 * app when it is not the repository's name.
 */
export function uptimeLabel(idOrKey: string): string {
  const id = idOrKey.startsWith(ENTRY_PREFIX) ? idOrKey.slice(ENTRY_PREFIX.length) : idOrKey;
  const parts = id.split("/");
  const [owner, repo] = parts;
  const environment = parts.at(-1);
  const app = parts.slice(2, -1).join("/");
  return app === repo
    ? `${owner}/${repo} (${environment})`
    : `${owner}/${repo} (${app}, ${environment})`;
}

/** What `inspectUptime` read. */
export interface UptimeFacts {
  accountId: string;
  /** The id of the KV namespace titled `opscrew-uptime`; null when the account has none. */
  namespaceId: string | null;
  /** The SHA-256 of the script last uploaded (the `opscrew:worker` key); null when none is. */
  sha256: string | null;
  /** Every entry, by its key. */
  entries: Record<string, UptimeEntry>;
  /** The names of the Worker's secrets; null when the account has no such Worker. */
  secrets: string[] | null;
  /**
   * The account's workers.dev subdomain, which a Worker's Cron Triggers and its workers.dev address
   * need; null when the account has none yet.
   */
  accountSubdomain: string | null;
  /** The Worker's workers.dev address is on, where the servers send their reports. */
  workersDev: boolean;
  /** Every server's report key (`report:<id>/<server>`). */
  reports: string[];
  /** The token permissions a read was refused for (HTTP 403), as the token builder names them. */
  denied: string[];
}

/** What one environment wants. */
export interface UptimeDesired {
  /** `<owner>/<repo>/<app>/<env>`. */
  id: string;
  /** Absent: remove this environment's entry (a destroy, or the runner back to `actions`). */
  entry?: UptimeEntry;
  /** Only from destroy: may delete the Worker and the namespace when no other entry is left. */
  destroy?: true;
  /** The secret's value (JSON with the webhook's address), when given this run. Never hashed. */
  secret?: string;
  /** The Worker's script, as OpsCrew ships it. */
  script: { content: string; sha256: string };
}

/** One change of an uptime plan, applied in the order of this list. */
export type UptimeChange =
  | { kind: "create-namespace" }
  /** Also sets the schedule and records the SHA-256. */
  | { kind: "upload-script"; sha256: string }
  /** The Worker's workers.dev address on, its previews off. */
  | { kind: "set-subdomain" }
  | { kind: "put-secret"; name: string }
  | { kind: "put-entry"; key: string; entry: UptimeEntry }
  /** The report key of a server that left the entry. */
  | { kind: "delete-report"; key: string }
  /** And its state key and its servers' report keys. */
  | { kind: "delete-entry"; key: string }
  | { kind: "delete-secret"; name: string }
  /** With its trigger and secrets. */
  | { kind: "delete-script" }
  | { kind: "delete-namespace" };

/** A blocking finding: what OpsCrew found and the next step, in plain English. */
export interface UptimeFinding {
  code:
    | "too-many-hostnames"
    | "permission-missing"
    | "secret-missing"
    | "workers-dev-missing"
    | "test-only-field";
  message: string;
  hint: string;
}

/** One environment's change to the account's uptime Worker. */
export interface UptimePlan {
  accountId: string;
  /** The environment's id (`<owner>/<repo>/<app>/<env>`). */
  id: string;
  changes: UptimeChange[];
  /** What the apply reads again before writing: the others' keys, the SHA-256, the namespace. */
  expect: { others: string[]; sha256: string | null; namespaceId: string | null };
  /** Any finding means the plan cannot be applied. */
  findings: UptimeFinding[];
  /** It deletes the Worker or the namespace: only with `desired.destroy`. */
  destroys: boolean;
  /**
   * Where the environment's servers send their reports (`https://opscrew-uptime.<account
   * subdomain>.workers.dev/report`); null when the account has no workers.dev subdomain.
   */
  reportUrl: string | null;
  /** SHA-256 of the canonical JSON of `accountId`, `id`, `changes` and `expect`. */
  hash: string;
}

export interface UptimeApplyResult {
  /**
   * The steps done, in order: each change by its kind, and an upload as `upload-script`,
   * `set-schedule` and `record-sha256`.
   */
  applied: string[];
  /** What the apply decided on its own, in plain English (the Worker kept for a new entry). */
  notes: string[];
}

/** An apply that stopped part-way: `applied` lists the changes made before the failure. */
export class UptimeApplyError extends OpsCrewError {
  readonly applied: string[];

  constructor(
    code: OpsCrewError["code"],
    message: string,
    options: { hint?: string; cause?: unknown },
    applied: string[],
  ) {
    super(code, message, options);
    this.name = "UptimeApplyError";
    this.applied = applied;
  }
}

// --- Inspect -------------------------------------------------------------------------------------

/** What the apply reads again: the namespace, the recorded SHA-256 and every entry's key. */
interface SharedRead {
  namespaceId: string | null;
  sha256: string | null;
  keys: string[];
}

async function readShared(client: CloudflareClient, accountId: string): Promise<SharedRead> {
  const namespace = (await client.listKvNamespaces(accountId)).find((n) => n.title === NAMESPACE);
  if (!namespace) return { namespaceId: null, sha256: null, keys: [] };
  const record = await client.getKv(accountId, namespace.id, WORKER_KEY);
  const keys = await client.listKvKeys(accountId, namespace.id, ENTRY_PREFIX);
  return {
    namespaceId: namespace.id,
    sha256: record === undefined ? null : readValue(WorkerRecordSchema, record, WORKER_KEY).sha256,
    keys: [...keys].sort(),
  };
}

/** A KV value OpsCrew wrote, validated; anything else stops the command. */
function readValue<T>(schema: z.ZodType<T>, text: string, key: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw damagedKey(key, "it is not JSON");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw damagedKey(key, zodIssues(parsed.error));
  return parsed.data;
}

function damagedKey(key: string, detail: string): OpsCrewError {
  return new OpsCrewError(
    "PROVIDER_ERROR",
    `The Workers KV key ${key} in the namespace ${NAMESPACE} does not hold what OpsCrew writes there: ${detail}.`,
    {
      hint: `If it was changed by hand, delete it in the Cloudflare dashboard (Storage & Databases → Workers KV → ${NAMESPACE}): its app's next provision writes it again. Then run the command again.`,
    },
  );
}

/**
 * Reads the account's uptime pieces: the namespace by its title, the `opscrew:worker` key, every
 * entry, and the Worker's secrets' names (never their values). A read the token may not make
 * (HTTP 403) leaves its facts out and names the permission in `denied`. Read-only.
 */
export async function inspectUptime(
  client: CloudflareClient,
  accountId: string,
): Promise<UptimeFacts> {
  const facts: UptimeFacts = {
    accountId,
    namespaceId: null,
    sha256: null,
    entries: {},
    secrets: null,
    accountSubdomain: null,
    workersDev: false,
    reports: [],
    denied: [],
  };
  /** `read()`, with `permission` noted when Cloudflare refuses it with HTTP 403. */
  const allowed = async (permission: string, read: () => Promise<void>) => {
    try {
      await read();
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
      facts.denied.push(permission);
    }
  };
  await allowed(KV_PERMISSION, async () => {
    const shared = await readShared(client, accountId);
    facts.namespaceId = shared.namespaceId;
    facts.sha256 = shared.sha256;
    for (const key of shared.keys) {
      const text = await client.getKv(accountId, shared.namespaceId as string, key);
      // Listed but gone: being deleted (a list can lag a minute behind).
      if (text !== undefined) facts.entries[key] = readValue(UptimeEntrySchema, text, key);
    }
    if (shared.namespaceId !== null) {
      const reports = await client.listKvKeys(accountId, shared.namespaceId, REPORT_PREFIX);
      facts.reports = [...reports].sort();
    }
  });
  await allowed(WORKERS_PERMISSION, async () => {
    facts.secrets = (await client.listWorkerSecrets(accountId, WORKER)) ?? null;
    facts.accountSubdomain = (await client.getWorkersSubdomain(accountId)) ?? null;
    if (facts.secrets !== null) {
      facts.workersDev = (await client.getWorkerSubdomain(accountId, WORKER))?.enabled ?? false;
    }
  });
  return facts;
}

// --- Plan ----------------------------------------------------------------------------------------

/** Why the webhook secret's value is not its shape (undefined: it is), never quoting it. */
function secretProblem(secret: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(secret);
  } catch {
    return "it is not JSON";
  }
  const parsed = WebhookSecretSchema.safeParse(value);
  return parsed.success ? undefined : zodIssues(parsed.error);
}

/** What only OpsCrew's own code gets wrong. */
const BUG_HINT = "This is a bug in OpsCrew; please report it.";

/** The desired entry's and secret's shapes: the entry the Worker reads, the user's webhook. */
function checkDesired(desired: UptimeDesired): void {
  const { id } = desired;
  const entry =
    desired.entry === undefined ? undefined : UptimeEntrySchema.safeParse(desired.entry);
  if (entry?.success === false) {
    throw new OpsCrewError(
      "INTERNAL",
      `The uptime entry of ${uptimeLabel(id)} is not what the uptime Worker reads (${zodIssues(entry.error)}), so OpsCrew changes nothing in Cloudflare.`,
      { hint: BUG_HINT },
    );
  }
  const secret = desired.secret === undefined ? undefined : secretProblem(desired.secret);
  if (secret !== undefined) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `The webhook's secret for ${uptimeLabel(id)} is not a webhook address with an optional ntfy token and report key (${secret}), so OpsCrew changes nothing in Cloudflare.`,
      {
        hint: "Set OPSCREW_CHECK_WEBHOOK to the webhook's full address (https://…), then run the command again.",
      },
    );
  }
}

/** `entry` with each server's `since` kept from the stored entry: when it was first listed. */
function keepSince(entry: UptimeEntry, stored: UptimeEntry | undefined): UptimeEntry {
  if (entry.servers === undefined) return entry;
  const since = new Map(stored?.servers?.map((server) => [server.id, server.since]));
  return {
    ...entry,
    servers: entry.servers.map((server) => ({
      ...server,
      since: since.get(server.id) ?? server.since,
    })),
  };
}

/**
 * Pure: the changes, blocking findings and the plan's SHA-256 (`plan.hash`). Only the live test
 * passes `liveTest`, which allows the entry's `heartbeatMinutes`.
 */
export function planUptime(
  facts: UptimeFacts,
  desired: UptimeDesired,
  options: { liveTest?: boolean } = {},
): UptimePlan {
  checkDesired(desired);
  const key = uptimeEntryKey(desired.id);
  const secret = uptimeSecretName(desired.id);
  const others = Object.keys(facts.entries)
    .filter((k) => k !== key)
    .sort();
  const expect = { others, sha256: facts.sha256, namespaceId: facts.namespaceId };
  const changes: UptimeChange[] = [];
  const findings: UptimeFinding[] = [];
  if (facts.denied.length > 0) {
    findings.push(permissionMissing(facts.denied));
  } else if (desired.entry !== undefined) {
    const stored = facts.entries[key];
    const entry = keepSince(desired.entry, stored);
    if (facts.namespaceId === null) changes.push({ kind: "create-namespace" });
    if (facts.secrets === null || facts.sha256 !== desired.script.sha256) {
      changes.push({ kind: "upload-script", sha256: desired.script.sha256 });
    }
    if (!facts.workersDev) changes.push({ kind: "set-subdomain" });
    if (desired.secret !== undefined) changes.push({ kind: "put-secret", name: secret });
    else if (!facts.secrets?.includes(secret)) findings.push(secretMissing(desired.id, secret));
    if (stored === undefined || canonicalJson(stored) !== canonicalJson(entry)) {
      changes.push({ kind: "put-entry", key, entry });
    }
    // After the entry, which no longer lists the server, so the Worker takes no report from it.
    const listed = new Set(entry.servers?.map((server) => uptimeReportKey(desired.id, server.id)));
    for (const report of reportsOf(facts.reports, desired.id)) {
      if (!listed.has(report)) changes.push({ kind: "delete-report", key: report });
    }
    if (facts.accountSubdomain === null) {
      findings.push({
        code: "workers-dev-missing",
        message:
          "Your Cloudflare account has no workers.dev subdomain yet, which the uptime Worker's trigger and the servers' reports need.",
        hint: WORKERS_SUBDOMAIN_HINT,
      });
    }
    if (entry.heartbeatMinutes !== undefined && options.liveTest !== true) {
      findings.push({
        code: "test-only-field",
        message: `The uptime entry of ${uptimeLabel(desired.id)} sets heartbeatMinutes, which only OpsCrew's live test may set.`,
        hint: BUG_HINT,
      });
    }
    const counted = others.reduce((n, k) => n + (facts.entries[k]?.hosts.length ?? 0), 0);
    if (counted + entry.hosts.length > UPTIME_RESOURCES.maxHostnames) {
      findings.push(tooManyHostnames(counted, entry.hosts.length));
    }
  } else {
    if (facts.entries[key] !== undefined) changes.push({ kind: "delete-entry", key });
    if (facts.secrets?.includes(secret)) changes.push({ kind: "delete-secret", name: secret });
    // Only a destroy that leaves no entry deletes the shared pieces; provision never does.
    if (desired.destroy === true && others.length === 0) {
      if (facts.secrets !== null) changes.push({ kind: "delete-script" });
      if (facts.namespaceId !== null) changes.push({ kind: "delete-namespace" });
    }
  }
  const plan: Omit<UptimePlan, "hash"> = {
    accountId: facts.accountId,
    id: desired.id,
    changes,
    expect,
    findings,
    destroys: changes.some((c) => c.kind === "delete-script" || c.kind === "delete-namespace"),
    reportUrl:
      facts.accountSubdomain === null
        ? null
        : `https://${WORKER}.${facts.accountSubdomain}.workers.dev/report`,
  };
  return { ...plan, hash: uptimePlanHash(plan) };
}

/** The plan's hash: SHA-256 of the canonical JSON of what the apply sends and expects. */
function uptimePlanHash(plan: Pick<UptimePlan, "accountId" | "id" | "changes" | "expect">) {
  const { accountId, id, changes, expect } = plan;
  return sha256Hex(canonicalJson({ accountId, id, changes, expect }));
}

function permissionMissing(denied: readonly string[]): UptimeFinding {
  return {
    code: "permission-missing",
    message: `The Cloudflare token may not read the account's uptime Worker or its KV namespace (HTTP 403): it lacks ${listText([...denied])}.`,
    hint: `Edit the token at ${CLOUDFLARE_TOKEN_PAGE} and give it ${listText([...CLOUDFLARE_UPTIME_PERMISSIONS])}, then run the command again.`,
  };
}

function secretMissing(id: string, secret: string): UptimeFinding {
  return {
    code: "secret-missing",
    message: `The uptime Worker has no secret ${secret} with the webhook's address for ${uptimeLabel(id)}, and none was given.`,
    hint: "Set OPSCREW_CHECK_WEBHOOK to the webhook's address (or answer the question for it), then run the command again.",
  };
}

function tooManyHostnames(counted: number, adding: number): UptimeFinding {
  return {
    code: "too-many-hostnames",
    message: `The uptime Worker checks at most ${UPTIME_RESOURCES.maxHostnames} hostnames in a Cloudflare account (the free plan's 50 requests a run, with room for the alerts). The other OpsCrew apps' entries already count ${plural(counted, "hostname")}, and this one adds ${adding}.`,
    hint: 'Keep observability.check.runner: "actions" for this app in opscrew/plan.yaml, or remove the Cloudflare uptime check from an app that no longer needs it, then run the command again.',
  };
}

const WEBHOOKS: Record<UptimeEntry["webhook"], string> = {
  slack: "Slack",
  discord: "Discord",
  ntfy: "ntfy",
};

/** ", and take reports from a and b" for an entry with servers. */
function serversText(entry: UptimeEntry): string {
  const ids = entry.servers?.map((server) => server.id) ?? [];
  return ids.length === 0 ? "" : `, and take reports from ${listText(ids)}`;
}

/** One change of the plan in plain English. */
function changeText(change: UptimeChange, plan: UptimePlan): string {
  const label = uptimeLabel(plan.id);
  switch (change.kind) {
    case "create-namespace":
      return `Create the Workers KV namespace ${NAMESPACE}, where the uptime Worker keeps its entries and what is down. Every OpsCrew app in this Cloudflare account shares it.`;
    case "upload-script":
      return `Upload the Worker ${WORKER} (its script's SHA-256 starts ${change.sha256.slice(0, 12)}) with its trigger every 5 minutes (${UPTIME_RESOURCES.cron}). Every OpsCrew app in this Cloudflare account shares it, and the upload keeps their webhook secrets.`;
    case "set-subdomain": {
      const address = plan.reportUrl?.replace(/\/report$/, "");
      return `Turn on the workers.dev address of the Worker ${WORKER}${address === undefined ? "" : `, ${address}`}, where the servers send their reports (its previews stay off).`;
    }
    case "put-secret":
      return `Set the Worker secret ${change.name}: the webhook's address for ${label} (its value is never shown).`;
    case "put-entry":
      return `Write the entry of ${label}: check ${listText(change.entry.hosts.map((h) => `${h.hostname}${h.healthPath}`))} and post to ${WEBHOOKS[change.entry.webhook]}${serversText(change.entry)}.`;
    case "delete-report":
      return `Delete the last report of the server ${change.key.slice(uptimeReportKey(plan.id, "").length)}, which no longer reports for ${label}.`;
    case "delete-entry":
      return `Delete the entry of ${label}, what the Worker keeps for it and its servers' last reports.`;
    case "delete-secret":
      return `Delete the Worker secret ${change.name}.`;
    case "delete-script":
      return `Delete the Worker ${WORKER}, with its trigger and secrets: no other entry is left.`;
    case "delete-namespace":
      return `Delete the Workers KV namespace ${NAMESPACE}.`;
  }
}

/**
 * The plain-English plan shown before its `cloudflare-apply` approval: each change, the findings,
 * the other environments' entries it keeps, then the hash. The webhook's address is never in it.
 */
export function describeUptimePlan(plan: UptimePlan): string {
  const label = uptimeLabel(plan.id);
  const lines = [`Cloudflare uptime plan for ${label}: ${plural(plan.changes.length, "change")}.`];
  for (const change of plan.changes) lines.push(`  ~ ${changeText(change, plan)}`);
  for (const finding of plan.findings) {
    lines.push(`  ! ${finding.message}`, `      ${finding.hint}`);
  }
  if (plan.expect.others.length > 0) {
    lines.push(`Keeps the entries of: ${plan.expect.others.map(uptimeLabel).join(", ")}.`);
  } else if (!plan.destroys && plan.changes.some((c) => c.kind === "delete-entry")) {
    lines.push(
      `The Worker ${WORKER}, its trigger and the KV namespace ${NAMESPACE} stay, with no entry: they cost nothing, the next app reuses them, and the last app's destroy removes them.`,
    );
  }
  lines.push(`Cloudflare uptime plan hash: ${plan.hash}`);
  return lines.join("\n");
}

// --- Apply ---------------------------------------------------------------------------------------

/** What the apply reads again, in the plan's terms: `own` is the environment's key. */
function expectOf(read: SharedRead, own: string): UptimePlan["expect"] {
  return {
    others: read.keys.filter((k) => k !== own),
    sha256: read.sha256,
    namespaceId: read.namespaceId,
  };
}

/** Why the account no longer is what the plan expected (undefined: it is). */
function staleReason(
  expected: UptimePlan["expect"],
  now: UptimePlan["expect"],
): string | undefined {
  if (now.namespaceId !== expected.namespaceId) {
    return expected.namespaceId === null
      ? `another OpsCrew app created the KV namespace ${NAMESPACE}`
      : `the KV namespace ${NAMESPACE} was deleted or replaced`;
  }
  if (now.sha256 !== expected.sha256) {
    return `the Worker ${WORKER} was uploaded again, by another OpsCrew app or another OpsCrew version`;
  }
  const added = now.others.filter((k) => !expected.others.includes(k));
  const removed = expected.others.filter((k) => !now.others.includes(k));
  const words = [
    ...(added.length > 0 ? [`the entry of ${listText(added.map(uptimeLabel))} was added`] : []),
    ...(removed.length > 0
      ? [`the entry of ${listText(removed.map(uptimeLabel))} was removed`]
      : []),
  ];
  return words.length > 0 ? listText(words) : undefined;
}

/** The given script, secret and id are the plan's; a deleting plan comes only from a destroy. */
function checkGiven(plan: UptimePlan, desired: UptimeDesired): void {
  const mismatch = (what: string) =>
    new OpsCrewError("PLAN_HASH_MISMATCH", `${what}, so OpsCrew changes nothing in Cloudflare.`, {
      hint: "Look at the current Cloudflare uptime plan and approve it by its hash.",
    });
  if (desired.id !== plan.id) {
    throw mismatch(`This uptime plan is for ${plan.id}, not ${desired.id}`);
  }
  for (const change of plan.changes) {
    if (change.kind === "upload-script" && sha256Hex(desired.script.content) !== change.sha256) {
      throw mismatch("The Worker's script given is not the one this uptime plan uploads");
    }
    if (change.kind === "put-secret" && desired.secret === undefined) {
      throw mismatch(
        "This uptime plan sets the webhook's secret, but no webhook address was given",
      );
    }
  }
  // From the hashed changes, not `destroys`, which the hash does not cover.
  const deletes = plan.changes.some(
    (c) => c.kind === "delete-script" || c.kind === "delete-namespace",
  );
  if (deletes && desired.destroy !== true) {
    throw mismatch("This uptime plan deletes the Worker, which only a destroy may do");
  }
}

/** The namespace's id: created, or the one another apply created at the same moment. */
async function createNamespace(client: CloudflareClient, accountId: string): Promise<string> {
  try {
    return await client.createKvNamespace(accountId, NAMESPACE);
  } catch (error) {
    if (!(error instanceof KvNamespaceExistsError)) throw error;
    const found = (await client.listKvNamespaces(accountId)).find((n) => n.title === NAMESPACE);
    if (found) return found.id;
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      `Cloudflare said the account already has the KV namespace ${NAMESPACE}, but does not list it.`,
      { hint: "Run the command again in a minute: OpsCrew reads the current state first." },
    );
  }
}

/**
 * Applies an approved plan, in its order: throws OpsCrewError PLAN_HASH_MISMATCH when
 * `approvedHash` differs or the script, secret or id given is not the plan's, PHASE_PRECONDITION
 * when the plan has findings or the account changed since the plan (nothing written), and
 * UptimeApplyError {applied} when a change fails part-way or, at the end, the environment's entry
 * or secret is missing. Every write is sent once. Just before deleting the Worker or the
 * namespace, the entries are listed again: with another one there, both stay, and `notes` says so.
 */
export async function applyUptime(
  client: CloudflareClient,
  plan: UptimePlan,
  desired: UptimeDesired,
  approvedHash: string,
): Promise<UptimeApplyResult> {
  if (!isPlanHash(approvedHash) || approvedHash.toLowerCase() !== uptimePlanHash(plan)) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      "This Cloudflare uptime plan is not the one that was approved, so OpsCrew changes nothing in Cloudflare.",
      { hint: "Look at the current Cloudflare uptime plan and approve it by its hash." },
    );
  }
  if (plan.findings.length > 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `OpsCrew cannot change the Cloudflare uptime Worker yet: ${plan.findings.map((f) => f.message).join(" ")}`,
      { hint: plan.findings.map((f) => f.hint).join(" ") },
    );
  }
  checkGiven(plan, desired);
  const { accountId } = plan;
  const own = uptimeEntryKey(plan.id);
  const reason = staleReason(plan.expect, expectOf(await readShared(client, accountId), own));
  if (reason !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The Cloudflare uptime Worker changed since the plan: ${reason}. OpsCrew changed nothing.`,
      {
        hint: "Run the command again to make a new plan from the current state, and approve that one.",
      },
    );
  }

  const applied: string[] = [];
  const notes: string[] = [];
  let namespaceId = plan.expect.namespaceId;
  let keep: boolean | undefined;
  const ns = () => namespaceId as string;
  try {
    for (const change of plan.changes) {
      switch (change.kind) {
        case "create-namespace":
          namespaceId = await createNamespace(client, accountId);
          break;
        case "upload-script":
          await client.uploadWorkerModule(accountId, WORKER, {
            content: desired.script.content,
            compatibilityDate: UPTIME_RESOURCES.compatibilityDate,
            bindings: [
              { type: "kv_namespace", name: UPTIME_RESOURCES.binding, namespace_id: ns() },
            ],
            keepBindings: ["secret_text"],
          });
          applied.push("upload-script");
          await client.putWorkerSchedules(accountId, WORKER, [UPTIME_RESOURCES.cron]);
          applied.push("set-schedule");
          await client.putKv(
            accountId,
            ns(),
            WORKER_KEY,
            JSON.stringify({ sha256: change.sha256 }),
          );
          applied.push("record-sha256");
          continue;
        case "set-subdomain":
          await client.setWorkerSubdomain(accountId, WORKER, {
            enabled: true,
            previewsEnabled: false,
          });
          break;
        case "put-secret":
          await client.putWorkerSecret(accountId, WORKER, {
            name: change.name,
            text: desired.secret as string,
          });
          break;
        case "put-entry":
          await client.putKv(accountId, ns(), change.key, JSON.stringify(change.entry));
          break;
        case "delete-report":
          await client.deleteKv(accountId, ns(), change.key);
          break;
        case "delete-entry": {
          // Listed now, so a report written since the plan goes too. The reports and the state
          // first: a stop before the entry goes leaves it, so the next plan deletes them all.
          const listed = await client.listKvKeys(accountId, ns(), uptimeReportKey(plan.id, ""));
          for (const report of reportsOf(listed, plan.id)) {
            await client.deleteKv(accountId, ns(), report);
          }
          await client.deleteKv(accountId, ns(), uptimeStateKey(plan.id));
          await client.deleteKv(accountId, ns(), change.key);
          break;
        }
        case "delete-secret":
          await client.deleteWorkerSecret(accountId, WORKER, change.name);
          break;
        case "delete-script":
        case "delete-namespace":
          keep ??= await keptFor(client, accountId, own, notes);
          if (keep) continue;
          if (change.kind === "delete-script") await client.deleteWorkerScript(accountId, WORKER);
          else await client.deleteKvNamespace(accountId, ns());
          break;
      }
      applied.push(change.kind);
    }
    if (desired.entry !== undefined) await checkWritten(client, plan, ns());
  } catch (error) {
    throw applyError(error, applied);
  }
  return { applied, notes };
}

/**
 * Lists the entries again just before the Worker and the namespace go: true (with the note) when
 * another one appeared since the plan, which keeps both.
 */
async function keptFor(
  client: CloudflareClient,
  accountId: string,
  own: string,
  notes: string[],
): Promise<boolean> {
  const { others } = expectOf(await readShared(client, accountId), own);
  if (others.length === 0) return false;
  const one = others.length === 1;
  notes.push(
    `The Worker ${WORKER}, its trigger and the KV namespace ${NAMESPACE} stay: the ${one ? "entry" : "entries"} of ${listText(others.map(uptimeLabel))} ${one ? "was" : "were"} added after the plan, so ${one ? "that app uses" : "those apps use"} them now.`,
  );
  return true;
}

/**
 * Reads the environment's secret and entry back, and fails when either is missing: an upload by
 * another app at the same moment drops a secret set meanwhile (the live pass showed it).
 */
async function checkWritten(
  client: CloudflareClient,
  plan: UptimePlan,
  namespaceId: string,
): Promise<void> {
  const secrets = await client.listWorkerSecrets(plan.accountId, WORKER);
  const entry = await client.getKv(plan.accountId, namespaceId, uptimeEntryKey(plan.id));
  if (secrets?.includes(uptimeSecretName(plan.id)) && entry !== undefined) return;
  throw new OpsCrewError(
    "PROVIDER_ERROR",
    "Another app changed the shared uptime Worker at the same moment, so this app's settings didn't stick.",
    { hint: "Run provision again." },
  );
}

function applyError(error: unknown, applied: string[]): UptimeApplyError {
  if (error instanceof OpsCrewError) {
    return new UptimeApplyError(
      error.code,
      error.message,
      { ...(error.hint === undefined ? {} : { hint: error.hint }), cause: error },
      [...applied],
    );
  }
  return new UptimeApplyError(
    "INTERNAL",
    "OpsCrew stopped on an error it did not expect while changing the Cloudflare uptime Worker.",
    { hint: "Run the command again to see the current state.", cause: error },
    [...applied],
  );
}
