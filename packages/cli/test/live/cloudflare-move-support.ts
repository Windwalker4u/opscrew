/**
 * Pure helpers of the live pass of feature 028 (docs/e2e.md "Moving to another Cloudflare
 * account"): the legs' gates and variables, the pass's state kept between legs, reading what
 * `opscrew cloudflare move` printed (the command to run next, a wait), the zone's records by whose
 * they are, the registrar's leg, the masks, and the probes' figures. No network, no processes;
 * unit-tested in `cloudflare-move-support.test.ts`.
 */
import { isIP } from "node:net";
import { join } from "node:path";
import type { RegistryNsLookup } from "@opscrew/agents";
import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import { providerBucket } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import { confirmNames } from "./retarget-anywhere-support";

// ---------------------------------------------------------------------------------------------
// The legs and their variables.

/** `1` runs the pass. */
export const MOVE_GATE = "OPSCREW_E2E_CLOUDFLARE_MOVE";

/** The legs of plan 15., in the order they run; L4a or L4b, as L0 found the registrar. */
export const MOVE_LEGS = ["L0", "L1", "L2", "L3", "L4a", "L4b", "L5", "L6"] as const;
export type MoveLeg = (typeof MOVE_LEGS)[number];

/** What every leg reads: both accounts' tokens, the zone, and where the pass keeps its state. */
const ZONE_VARIABLES = [
  "OPSCREW_E2E_CLOUDFLARE_TOKEN",
  "OPSCREW_E2E_MOVE_TOKEN_B",
  "OPSCREW_E2E_DOMAIN",
  "OPSCREW_TEST_TMP",
] as const;

/** What the legs with P and Q read besides: Hetzner, GitHub and both throwaway repositories. */
const APP_VARIABLES = [
  ...ZONE_VARIABLES,
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_REPO_B",
] as const;

/** Each leg's variables. */
export const LEG_VARIABLES: Readonly<Record<MoveLeg, readonly string[]>> = {
  L0: ZONE_VARIABLES,
  L1: APP_VARIABLES,
  L2: APP_VARIABLES,
  L3: APP_VARIABLES,
  L4a: APP_VARIABLES,
  L4b: APP_VARIABLES,
  L5: APP_VARIABLES,
  L6: APP_VARIABLES,
};

/** The registrars OpsCrew drives, with the variables each one's API needs. */
export const REGISTRAR_CREDENTIALS = {
  porkbun: ["PORKBUN_API_KEY", "PORKBUN_SECRET_API_KEY"],
  namecheap: ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY"],
  godaddy: ["GODADDY_API_TOKEN"],
} as const satisfies Record<string, readonly string[]>;
export type DrivenRegistrar = keyof typeof REGISTRAR_CREDENTIALS;

const set = (env: Record<string, string | undefined>, name: string) =>
  (env[name]?.trim() ?? "") !== "";

/** The registrars whose credentials are all set in `env`. */
export function configuredRegistrars(env: Record<string, string | undefined>): DrivenRegistrar[] {
  return (Object.keys(REGISTRAR_CREDENTIALS) as DrivenRegistrar[]).filter((id) =>
    REGISTRAR_CREDENTIALS[id].every((name) => set(env, name)),
  );
}

/**
 * Why `leg` is skipped (the gate, then each missing variable; L4a also needs one registrar's
 * credentials), or `undefined` when it can run.
 */
export function legSkip(env: Record<string, string | undefined>, leg: MoveLeg): string | undefined {
  if (env[MOVE_GATE] !== "1") return `set ${MOVE_GATE}=1`;
  const missing = LEG_VARIABLES[leg].filter((name) => !set(env, name));
  if (leg === "L4a" && configuredRegistrars(env).length === 0) {
    missing.push(
      Object.values(REGISTRAR_CREDENTIALS)
        .map((names) => names.join(" and "))
        .join(", or "),
    );
  }
  return missing.length === 0 ? undefined : `set ${missing.join(", ")}`;
}

/**
 * Why the switch leg `leg` doesn't run with what L0 recorded (`found`, undefined before L0): L0
 * first, the other switch leg, or no switch leg at all for a registrar the pass doesn't support.
 */
export function switchLegSkip(
  leg: Extract<MoveLeg, "L4a" | "L4b">,
  found: RegistrarFinding | undefined,
): string | undefined {
  if (found === undefined) return "run L0 first: it finds the registrar";
  if (found.leg === leg) return undefined;
  if (found.leg === undefined) return `L0 found ${found.why ?? "no registrar the pass supports"}`;
  return `L0 found ${found.registrar}: run ${found.leg} instead`;
}

/**
 * The other legs whose names `title` (a leg's or a step's) holds: `-t "<leg>"` selects every test
 * whose name holds the leg's, so such a title would run with that leg too.
 */
export function otherLegsNamed(leg: MoveLeg, title: string): MoveLeg[] {
  return MOVE_LEGS.filter((name) => name !== leg && title.includes(name));
}

/** The pass's folder, outside every vitest run folder so it outlasts each leg. */
export function passFolder(env: Record<string, string | undefined>): string {
  const root = env.OPSCREW_TEST_TMP?.trim() ?? "";
  if (root === "") throw new Error("Set OPSCREW_TEST_TMP: the pass keeps its state there.");
  return join(root, "opscrew-e2e-cloudflare-move");
}

// ---------------------------------------------------------------------------------------------
// The pass's state, kept between legs in `pass.json`.

const ServerSchema = z.object({
  id: z.number(),
  name: z.string(),
  serverType: z.string(),
  location: z.string(),
  hourlyGross: z.number(),
  ipv4: z.string(),
  ipv6: z.string().optional(),
  ipv6Network: z.string().optional(),
});

/** One of the pass's apps (P or Q): where its checkout is, and what it seeded. */
const AppStateSchema = z.object({
  work: z.string(),
  repo: z.string(),
  keyFile: z.string(),
  knownHostsFile: z.string(),
  exampleCommit: z.string(),
  /** Set once design named the app. */
  appName: z.string().optional(),
  hostname: z.string(),
  /** Q's throwaway server, the user's own. */
  server: ServerSchema.optional(),
  /** Q's value in its SQLite file. */
  value: z.string().optional(),
  /** Q's snapshot copies (ids) and each copy's objects with a SHA-256, read in A's bucket. */
  copies: z.record(z.string(), z.string()).optional(),
  snapshots: z.array(z.string()).optional(),
  /** The recovery copy's age key (Q's restore reads its copies with it). */
  ageKey: z.string().optional(),
  /** Its finish ended: its commands use B's token and keys. */
  moved: z.boolean().optional(),
  /** The run destroyed it (L6). */
  destroyed: z.boolean().optional(),
});
export type AppState = z.infer<typeof AppStateSchema>;

const RegistrarFindingSchema = z.object({
  registrar: z.string(),
  leg: z.enum(["L4a", "L4b"]).optional(),
  why: z.string().optional(),
});
export type RegistrarFinding = z.infer<typeof RegistrarFindingSchema>;

const LegRecordSchema = z.object({
  startedAt: z.string(),
  endedAt: z.string().optional(),
  outcome: z.enum(["running", "passed", "failed", "waiting"]),
  /** A wait's advice: when to run the leg again. */
  note: z.string().optional(),
});

export const PassStateSchema = z.object({
  runId: z.string(),
  startedAt: z.string(),
  /** The account ids, read in L0 (A's from the zone, B's from its token). */
  accounts: z.object({ a: z.string(), b: z.string() }),
  registrar: RegistrarFindingSchema.optional(),
  /** L0: A's DNSSEC status and whether the registry still publishes a DS record. */
  dnssec: z.object({ status: z.string(), dsPublished: z.boolean() }).optional(),
  /** L0: A's Zero Trust organization (its team domain) and one-time PIN logins, which must stay. */
  zeroTrust: z
    .object({ organization: z.string().optional(), oneTimePins: z.array(z.string()) })
    .optional(),
  apps: z.object({ p: AppStateSchema.optional(), q: AppStateSchema.optional() }),
  legs: z.record(z.string(), LegRecordSchema),
  /** The figures for docs/e2e-coverage.md, by name, each a line without a name or address. */
  figures: z.record(z.string(), z.string()),
});
export type PassState = z.infer<typeof PassStateSchema>;

/** A new pass's state. */
export function newPass(runId: string, accounts: PassState["accounts"], now: Date): PassState {
  return { runId, startedAt: now.toISOString(), accounts, apps: {}, legs: {}, figures: {} };
}

/** The pass's state read back from `pass.json`'s text; a plain error when it isn't one. */
export function parsePass(text: string): PassState {
  const parsed = PassStateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    throw new Error(
      "pass.json in the pass's folder is not the pass's state: run L6 to clean up what it names, or delete the folder after cleaning up by hand (docs/e2e.md).",
    );
  }
  return parsed.data;
}

/** Each leg's place in the order (L4a and L4b share one). */
const LEG_RANK: Readonly<Record<MoveLeg, number>> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4a: 4,
  L4b: 4,
  L5: 5,
  L6: 6,
};

/**
 * Why `leg` can't start, from the legs recorded: never once a later leg than it (but L6) ran; each
 * leg needs the one before it passed (L4a and L4b count as one; L6 runs after anything); a leg
 * that waits runs again.
 */
export function legOrderProblem(state: PassState | undefined, leg: MoveLeg): string | undefined {
  if (leg === "L6") return undefined;
  const later = MOVE_LEGS.filter(
    (name) => name !== "L6" && LEG_RANK[name] > LEG_RANK[leg] && state?.legs[name] !== undefined,
  );
  if (later.length > 0) {
    return `${later.join(" and ")} ran already, so ${leg} doesn't run again: go on from there, or run L6`;
  }
  if (leg === "L0") return undefined;
  if (state === undefined) return "run L0 first";
  const before: Partial<Record<MoveLeg, readonly MoveLeg[]>> = {
    L1: ["L0"],
    L2: ["L1"],
    L3: ["L2"],
    L4a: ["L3"],
    L4b: ["L3"],
    L5: ["L4a", "L4b"],
  };
  const needed = before[leg] ?? [];
  const passed = needed.some((name) => state.legs[name]?.outcome === "passed");
  return passed ? undefined : `run ${needed.join(" or ")} to its end first`;
}

/**
 * Why `leg` can't open the pass in a process that opened `claimed` already: each leg is its own
 * process (`-t "<leg>"`), since a leg's state and outputs are saved as it ends.
 */
export function otherLegProblem(claimed: MoveLeg | undefined, leg: MoveLeg): string | undefined {
  if (claimed === undefined || claimed === leg) return undefined;
  return `this run has ${claimed} too: run one leg at a time with -t "<leg>" (docs/e2e.md)`;
}

/**
 * Why L6 may not abort a move left half-way by itself: a switch leg ran (L4a or L4b), or the
 * public delegation names B's nameservers, so the switch may have begun and an abort could take
 * the zone offline. `undefined` when it may.
 */
export function abortProblem(state: PassState, delegatedToB: boolean): string | undefined {
  const switched = (["L4a", "L4b"] as const).filter((leg) => state.legs[leg] !== undefined);
  if (switched.length === 0 && !delegatedToB) return undefined;
  const why =
    switched.length > 0
      ? `${switched.join(" and ")} ran`
      : "the delegation names the new account's nameservers";
  return `the switch may have begun (${why}): run L4 again to its end, then L5 and L6; or, after checking the zone's nameservers at its registrar, abort by hand in a terminal (\`opscrew cloudflare move --abort\`), then run L6`;
}

// ---------------------------------------------------------------------------------------------
// What `opscrew cloudflare move` printed.

/** The steps a run printed under `Next:` (one, or a list), its last block. */
export function nextSteps(output: string): string[] {
  const blocks = [...output.matchAll(/^Next:(.*)$/gm)];
  const last = blocks.at(-1);
  if (last?.index === undefined) return [];
  const inline = (last[1] ?? "").trim();
  if (inline !== "") return [inline];
  const steps: string[] = [];
  for (const line of output.slice(last.index).split(/\r?\n/).slice(1)) {
    const item = /^ {2}- (.*)$/.exec(line);
    if (item === null) break;
    steps.push(item[1] ?? "");
  }
  return steps;
}

/**
 * The arguments of the command a stop says to run next (`opscrew cloudflare move <args>`, ending
 * with `--approve <hash>`), as a script runs it; `undefined` when the run printed none.
 */
export function nextMoveCommand(output: string): string[] | undefined {
  const found = /(?:`|run: )opscrew cloudflare move ([^`\n]*?--approve [0-9a-f]{64})/.exec(
    output,
  )?.[1];
  return found?.split(/\s+/).filter((word) => word !== "");
}

/** The names `args` types with `--confirm` that are not in `allowed`. */
export function unexpectedNames(args: readonly string[], allowed: readonly string[]): string[] {
  return confirmNames(args).filter((name) => !allowed.includes(name));
}

/** `args` with `--allow-downtime` once (a finish's window, as a script allows it). */
export function withDowntime(args: readonly string[]): string[] {
  return args.includes("--allow-downtime") ? [...args] : [...args, "--allow-downtime"];
}

/** A stop of the switch, as its steps say what it waits for. */
export type SwitchWait =
  /** DNSSEC's wait: run it again after that time. */
  | { kind: "time"; after: string }
  /** The nameservers are to be set at the registrar (Cloudflare Registrar's dashboard move). */
  | { kind: "registrar" }
  /** Activation, the certificate or an HTTPS answer: run it again, it keeps its times. */
  | { kind: "measuring" }
  | { kind: "other" };

/** What a stop's steps wait for. */
export function waitOf(steps: readonly string[]): SwitchWait {
  const text = steps.join("\n");
  const after = /again after ([^;]+);/.exec(text)?.[1];
  if (after !== undefined) return { kind: "time", after: after.trim() };
  if (text.includes("finds the new nameservers")) return { kind: "registrar" };
  if (text.includes("keeps the times measured so far")) return { kind: "measuring" };
  return { kind: "other" };
}

/**
 * What L3 makes of a `--switch` run's `output`: `undefined` when it shows its plan (every OpsCrew
 * name in the zone is in a mark); DNSSEC's wait with its time, when it waits for that (the switch
 * checks its coverage first); else the coverage's refusal.
 */
export function coverageWait(output: string): string | undefined {
  if (nextMoveCommand(output) !== undefined) return undefined;
  const wait = waitOf(nextSteps(output));
  if (wait.kind === "time") return `DNSSEC's wait: after ${wait.after}.`;
  return "the switch's coverage names hostnames no prepared app holds (above, masked): prepare each real app from its repository (`opscrew cloudflare move --to <B>`).";
}

// ---------------------------------------------------------------------------------------------
// The zone's records and the accounts' pieces.

/** A DNS record as Cloudflare lists it (the fields the pass reads). */
export interface ListedRecord {
  type: string;
  name: string;
  content?: string;
  comment?: string | null;
  proxied?: boolean;
  data?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
}

/** The prefix of an app's prepared mark (`_opscrew-move.<label>.<zone>`, data model 4). */
export const MARK_PREFIX = "_opscrew-move.";

/**
 * The zone's records by whose they are: OpsCrew's (its comment), the move's marks, Cloudflare's
 * own (`meta.read_only`: Email Routing's, Workers custom domains', others), and the user's.
 */
export function recordKinds<T extends ListedRecord>(
  records: readonly T[],
): {
  opscrew: T[];
  marks: T[];
  emailRouting: T[];
  workersDomains: T[];
  otherManaged: T[];
  user: T[];
} {
  const kinds = {
    opscrew: [] as T[],
    marks: [] as T[],
    emailRouting: [] as T[],
    workersDomains: [] as T[],
    otherManaged: [] as T[],
    user: [] as T[],
  };
  for (const record of records) {
    const meta = record.meta ?? {};
    if (record.name.startsWith(MARK_PREFIX)) kinds.marks.push(record);
    else if (record.comment === OPSCREW_MANAGED_COMMENT) kinds.opscrew.push(record);
    else if (meta.email_routing === true) kinds.emailRouting.push(record);
    else if (typeof meta.origin_worker_id === "string") kinds.workersDomains.push(record);
    else if (meta.read_only === true) kinds.otherManaged.push(record);
    else kinds.user.push(record);
  }
  return kinds;
}

/**
 * The hostnames the real apps answer on, from the zone's records: OpsCrew's address and CNAME
 * records and the Workers custom domains, apart from `_`-names and every name holding `runTag`
 * (the pass's own apps), sorted.
 */
export function realAppHosts(records: readonly ListedRecord[], runTag: string): string[] {
  const kinds = recordKinds(records);
  const names = [...kinds.opscrew, ...kinds.workersDomains]
    .filter((record) => ["A", "AAAA", "CNAME"].includes(record.type))
    .map((record) => record.name)
    .filter((name) => !name.startsWith("_") && !name.includes(runTag));
  return [...new Set(names)].sort();
}

/**
 * The records with `data` (TLSA, HTTPS, SRV, CAA and such), each with whether Cloudflare filled
 * its `content` too (lead note on T2817: the fake leaves it empty).
 */
export function dataRecords(
  records: readonly ListedRecord[],
): { type: string; name: string; contentFilled: boolean }[] {
  return records
    .filter((record) => record.data != null && Object.keys(record.data).length > 0)
    .map((record) => ({
      type: record.type,
      name: record.name,
      contentFilled: (record.content ?? "").trim() !== "",
    }));
}

/** One account's pieces the pass lists: each kind's names, or why the token couldn't read it. */
export type AccountPieces = Record<string, string[] | { unreadable: string }>;

/** The parts of an inventory the pass compares and shows (no record content, which names addresses). */
export interface Inventory {
  /** The move's zone in the account: its status and plan, or absent. */
  zone?: { status: string; plan: string; nameServers: string[] };
  /** The zone's records as `<type> <name> <content> <proxied>` lines, sorted. */
  records: string[];
  /** The zone's settings and features read (`ssl`, `dnssec`, `email routing`…), each a short value. */
  settings: Record<string, string>;
  pieces: AccountPieces;
}

/** A record as an inventory line. */
export function recordLine(record: ListedRecord): string {
  return [record.type, record.name, record.content ?? "", record.proxied === true ? "proxied" : ""]
    .join(" ")
    .trim();
}

/**
 * What changed between two inventories of one account, by part and count only (never a value):
 * `records: 1 added, 2 removed`, `settings: ssl changed`, `pieces tunnels: 1 added`.
 */
export function inventoryChanges(before: Inventory, after: Inventory): string[] {
  const changes: string[] = [];
  const counted = (what: string, old: readonly string[], now: readonly string[]) => {
    const added = now.filter((item) => !old.includes(item)).length;
    const removed = old.filter((item) => !now.includes(item)).length;
    if (added + removed > 0) changes.push(`${what}: ${added} added, ${removed} removed`);
  };
  if (JSON.stringify(before.zone) !== JSON.stringify(after.zone)) changes.push("zone: changed");
  counted("records", before.records, after.records);
  for (const name of new Set([...Object.keys(before.settings), ...Object.keys(after.settings)])) {
    if (before.settings[name] !== after.settings[name]) changes.push(`settings: ${name} changed`);
  }
  for (const name of new Set([...Object.keys(before.pieces), ...Object.keys(after.pieces)])) {
    const old = before.pieces[name];
    const now = after.pieces[name];
    if (Array.isArray(old) && Array.isArray(now)) counted(`pieces ${name}`, old, now);
    else if (JSON.stringify(old) !== JSON.stringify(now)) changes.push(`pieces ${name}: changed`);
  }
  return changes;
}

/**
 * The inventory's lines for the log and the lead's checklist: each part with its count, each piece
 * kind's names (masked by the caller) and the pieces OpsCrew didn't make (plan 14.) apart.
 */
export function inventoryLines(label: string, inventory: Inventory): string[] {
  const lines = [
    inventory.zone === undefined
      ? `${label}: no zone of the move's name`
      : `${label}: the zone is ${inventory.zone.status} on the ${inventory.zone.plan} plan, ${inventory.records.length} records`,
  ];
  for (const [name, value] of Object.entries(inventory.settings)) {
    lines.push(`${label} setting ${name}: ${value}`);
  }
  for (const [name, value] of Object.entries(inventory.pieces)) {
    if (!Array.isArray(value)) {
      lines.push(`${label} ${name}: not readable (${value.unreadable})`);
      continue;
    }
    const others = value.filter((item) => !madeByOpscrew(item));
    lines.push(
      `${label} ${name}: ${value.length}${others.length === 0 ? "" : `, not OpsCrew's: ${others.join(", ")}`}`,
    );
  }
  return lines;
}

/** Whether a piece's name is one OpsCrew gives (`opscrew-…`, `OpsCrew …`). */
export function madeByOpscrew(name: string): boolean {
  return /^opscrew[- ]/i.test(name);
}

/** Whether two nameserver lists name the same servers (case and order aside); never two empty ones. */
export function sameNameservers(a: readonly string[], b: readonly string[]): boolean {
  const key = (names: readonly string[]) =>
    names
      .map((name) => name.toLowerCase().replace(/\.$/, ""))
      .sort()
      .join();
  return a.length > 0 && key(a) === key(b);
}

/**
 * The nameservers `zone` is delegated to now: the registry's (its RDAP record, `registry`), which
 * change as soon as the registrar's change is accepted; without them, the public DNS's
 * (`publicDns`), which can show the old delegation for as long as the TLD lets resolvers keep it
 * (a day for `.dev`); none when neither answers.
 */
export async function currentNameservers(
  zone: string,
  lookups: { registry: RegistryNsLookup; publicDns: (zone: string) => Promise<string[]> },
): Promise<string[]> {
  return (await lookups.registry(zone)) ?? (await lookups.publicDns(zone).catch(() => []));
}

/** `text` with every character a regular expression gives a meaning escaped. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * What the cleanup takes as P's and Q's (`appNames`, and `tag`, their run's hostnames' tag), and
 * nothing else: a piece (tunnel, Access application, policy, service token, bucket) whose name holds
 * an app's name between separators (`opscrew-<app>`, `OpsCrew SSH (<app>)`, `<app>-prod-backups`);
 * a record with a label that is the tag, starts with `<tag>-` or holds an app's name so
 * (`ssh-<app>`); an app's mark (`_opscrew-move.<app>-<8 hex>.<zone>`). With no app, nothing matches.
 */
export function leftoverMatch(
  appNames: readonly string[],
  tag: string,
): { piece(name: string): boolean; record(name: string): boolean } {
  const apps = appNames.filter((app) => app !== "");
  const patterns = apps.map((app) => new RegExp(`(^|[\\s(-])${escaped(app)}([\\s)-]|$)`));
  const marks = apps.map((app) => new RegExp(`^${escaped(app)}-[0-9a-f]{8}$`));
  const piece = (name: string) => patterns.some((pattern) => pattern.test(name));
  const tagged = (label: string) =>
    tag !== "" && apps.length > 0 && (label === tag || label.startsWith(`${tag}-`));
  return {
    piece,
    record(name) {
      const labels = name.toLowerCase().split(".");
      if (name.startsWith(MARK_PREFIX)) {
        const label = labels[1] ?? "";
        return marks.some((mark) => mark.test(label));
      }
      return labels.some((label) => tagged(label) || piece(label));
    },
  };
}

/**
 * The bucket L6 empties before an app's `opscrew destroy --delete-data`, as the user does: the
 * app's own R2 bucket, since Cloudflare deletes only an empty one and OpsCrew never deletes its
 * files (a Hetzner or Spaces bucket goes with its files); `undefined` for an app without one.
 */
export function bucketEmptiedFirst(plan: Pick<DeployPlan, "storage">): string | undefined {
  const bucket = providerBucket(plan);
  return bucket?.provider === "r2" ? bucket.bucket : undefined;
}

// ---------------------------------------------------------------------------------------------
// The accounts and the registrar.

/**
 * The account a token works in: the one it sees, or `given` (`variable`'s value) when it sees
 * several and `given` is one of them.
 */
export function oneAccount(
  accounts: readonly { id: string }[],
  given: string | undefined,
  variable: string,
): string {
  const wanted = given?.trim() ?? "";
  if (wanted !== "") {
    if (accounts.some((account) => account.id === wanted)) return wanted;
    throw new Error(`${variable} names an account the token doesn't see.`);
  }
  const [only] = accounts;
  if (accounts.length === 1 && only !== undefined) return only.id;
  throw new Error(
    `The token sees ${accounts.length} accounts: set ${variable} to the one the pass uses.`,
  );
}

/** The RDAP servers of `zone`'s top-level domain, from IANA's bootstrap file (`dns.json`). */
export function rdapServers(bootstrap: unknown, zone: string): string[] {
  const tld = zone.split(".").at(-1)?.toLowerCase() ?? "";
  const services = (bootstrap as { services?: unknown } | undefined)?.services;
  if (!Array.isArray(services)) return [];
  for (const service of services) {
    if (!Array.isArray(service) || !Array.isArray(service[0]) || !Array.isArray(service[1])) {
      continue;
    }
    const [tlds, urls] = service as [unknown[], unknown[]];
    if (tlds.some((item) => typeof item === "string" && item.toLowerCase() === tld)) {
      return urls.filter((url): url is string => typeof url === "string");
    }
  }
  return [];
}

/** The registrar's name in an RDAP domain answer (its `registrar` entity's vCard `fn`). */
export function rdapRegistrar(answer: unknown): string | undefined {
  const entities = (answer as { entities?: unknown } | undefined)?.entities;
  if (!Array.isArray(entities)) return undefined;
  for (const entity of entities as { roles?: unknown; vcardArray?: unknown }[]) {
    if (!Array.isArray(entity.roles) || !entity.roles.includes("registrar")) continue;
    const card = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] : undefined;
    if (!Array.isArray(card)) continue;
    for (const field of card) {
      if (Array.isArray(field) && field[0] === "fn" && typeof field[3] === "string") {
        return field[3];
      }
    }
  }
  return undefined;
}

/**
 * The switch's leg from where the zone is registered: Cloudflare Registrar in A (A's token reads it,
 * or the public record says Cloudflare) is L4b; a registrar OpsCrew drives is L4a when its
 * credentials are `configured`; anything else has no leg, with why.
 */
export function registrarFinding(input: {
  /** A's token on Cloudflare Registrar: it holds the domain, it may not read it, or it doesn't. */
  cloudflare: "holds" | "refused" | "absent";
  /** The registrar the public record (RDAP) names. */
  publicName?: string;
  configured: readonly DrivenRegistrar[];
}): RegistrarFinding {
  const name = input.publicName ?? "";
  if (input.cloudflare === "holds" || /cloudflare/i.test(name)) {
    return { registrar: "Cloudflare Registrar", leg: "L4b" };
  }
  const driven = (Object.keys(REGISTRAR_CREDENTIALS) as DrivenRegistrar[]).find((id) =>
    name
      .toLowerCase()
      .replaceAll(/[^a-z]/g, "")
      .includes(id),
  );
  if (driven === undefined) {
    return {
      registrar: name === "" ? "an unknown registrar" : "another registrar",
      why: "a registrar the pass doesn't drive: change the nameservers there by hand, as the switch prints",
    };
  }
  if (!input.configured.includes(driven)) {
    return {
      registrar: driven,
      why: `${driven}, but its credentials aren't set: set ${REGISTRAR_CREDENTIALS[driven].join(" and ")} and run L0 again`,
    };
  }
  return { registrar: driven, leg: "L4a" };
}

// ---------------------------------------------------------------------------------------------
// The masks and the leak search.

/** The labels of values masked in every output but never searched for (they are in commits). */
export const MASK_PREFIX = "mask-";

/**
 * Every IPv4 and IPv6 address in the records' contents, to be masked (`mask-address`): the real
 * apps' origins among them.
 */
export function recordAddresses(records: readonly ListedRecord[]): string[] {
  const found = records
    .map((record) => record.content?.trim() ?? "")
    .filter((content) => isIP(content) !== 0);
  return [...new Set(found)];
}

/** The labels of values each process derives again from the environment, never written down. */
const DERIVED_LABELS = [
  "hetzner-token",
  "github-token",
  "github-basic-auth",
  "cloudflare-token",
  "cloudflare-token-b",
];

/**
 * The scrubber's entries the pass keeps in `known.json` between legs: the masks and what OpsCrew
 * generated (keys, passwords, outputs, addresses), never a token or an R2 key, which each process
 * derives again.
 */
export function persistedEntries(
  entries: readonly { label: string; value: string }[],
): { label: string; value: string }[] {
  return entries.filter(
    ({ label }) =>
      !DERIVED_LABELS.includes(label) &&
      !label.startsWith("r2-key-id-") &&
      !label.startsWith("r2-secret-"),
  );
}

/**
 * The scrubber's entries the leak search looks for: `secrets` everywhere, and `addresses` (the
 * servers') in commits and pull requests; masks (zone, account ids, addresses of the zone's
 * records) and this computer's address are never searched for.
 */
export function leakSearchValues(entries: readonly { label: string; value: string }[]): {
  secrets: { label: string; value: string }[];
  addresses: { label: string; value: string }[];
} {
  const searched = entries.filter(
    ({ label }) => !label.startsWith(MASK_PREFIX) && label !== "tester-ipv4",
  );
  return {
    secrets: searched.filter(({ label }) => !label.startsWith("server-")),
    addresses: searched.filter(({ label }) => label.startsWith("server-")),
  };
}

/**
 * The leak search's line for `kept`, the pass's kept version of the move's local file `label`,
 * which holds `found` (labels): where it is, and how to remove a version that a command run by
 * hand outside the pass made (a plan the lead made to diagnose a leg), which the pass kept at its
 * next run as it keeps every version it finds.
 */
export function keptVersionLeak(label: string, kept: string, found: readonly string[]): string {
  return `a kept version of ${label} contains: ${found.join(", ")}. If a command run by hand outside the pass made that version, delete ${kept} (and ${label} in the app's checkout, if it is still there) and run L6 again; else it is a leak`;
}

// ---------------------------------------------------------------------------------------------
// The load and the probes.

/**
 * A real app's answer as the load counts it: the edge answered (any status below 500, a redirect
 * to a login too) is fine (200); a 5xx, 52x included, stays a failure.
 */
export function edgeAnswer(status: number): number {
  return status >= 500 ? status : 200;
}

/** One probe of a hostname, by one way of asking. */
export interface ProbeSample {
  /** Epoch milliseconds. */
  at: number;
  /** The hostname's label (`P`, `Q`, `real 1`…), never the name. */
  host: string;
  via: "resolver" | "doh-edge" | "ns-a" | "ns-b";
  ok: boolean;
  /** What it got, without a name or address: `HTTP 200`, `NXDOMAIN`, `CNAME`, `A`, an error code. */
  answer: string;
}

/**
 * The probes' figures from `since` (the nameserver change): per host and way, the first good answer
 * after the last bad one (seconds after `since`), how many probes failed, and what A's and B's
 * nameservers answered, each answer with when it was first seen.
 */
export function probeFigures(samples: readonly ProbeSample[], since: number): string[] {
  const lines: string[] = [];
  const keys = [...new Set(samples.map((sample) => `${sample.host}\u0000${sample.via}`))].sort();
  for (const key of keys) {
    const [host, via] = key.split("\u0000") as [string, ProbeSample["via"]];
    const series = samples
      .filter((sample) => sample.host === host && sample.via === via)
      .sort((a, b) => a.at - b.at);
    const failed = series.filter((sample) => !sample.ok).length;
    if (via === "ns-a" || via === "ns-b") {
      const seen: string[] = [];
      for (const sample of series) {
        const last = seen.at(-1);
        if (last === undefined || !last.startsWith(`${sample.answer} `)) {
          seen.push(`${sample.answer} (${seconds(sample.at - since)})`);
        }
      }
      lines.push(`${host} ${via}: ${seen.join(" → ")}`);
      continue;
    }
    const lastBad = series.findLast((sample) => !sample.ok);
    const good = series.find(
      (sample) => sample.ok && (lastBad === undefined || sample.at > lastBad.at),
    );
    lines.push(
      `${host} ${via}: ${good === undefined ? "no good answer yet" : `good from ${seconds(good.at - since)}`}, ${failed} of ${series.length} probes failed`,
    );
  }
  return lines;
}

/** Milliseconds as `<n> s` (negative: before the change). */
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/**
 * The load's figures of one leg: each target's requests and failures, the failures grouped by why
 * (`HTTP 526: 3`), by label only.
 */
export function loadFigures(
  summaries: readonly { label: string; sent: number; failures: readonly { what: string }[] }[],
): string[] {
  return summaries.map(({ label, sent, failures }) => {
    const why = new Map<string, number>();
    for (const failure of failures) why.set(failure.what, (why.get(failure.what) ?? 0) + 1);
    const grouped = [...why].map(([what, count]) => `${what}: ${count}`).join(", ");
    return `${label}: ${sent} requests, ${failures.length} failed${grouped === "" ? "" : ` (${grouped})`}`;
  });
}
