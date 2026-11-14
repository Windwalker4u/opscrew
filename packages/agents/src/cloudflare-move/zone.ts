/**
 * The zone plan of a move (data model 5): B's zone added when it is missing, A's records that are
 * no OpsCrew app's copied to it create-only (records that differ, and those only in B, are listed
 * and never changed), and the apps' marks written or deleted. Planned here, shown with the app's
 * servers' addresses masked, approved by its hash (`cloudflare-apply`) and applied through the
 * Cloudflare client. A's zone is only read.
 */
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareZoneRecord,
  type CloudflareZoneRecordInput,
  OPSCREW_MANAGED_COMMENT,
  SHARED_RULES,
  type SharedRuleRef,
  type ZonePermissionNeed,
} from "@opscrew/connector-cloudflare";
import { canonicalJson, listText, OpsCrewError, plural, sha256Hex } from "@opscrew/core";
import { type ComparableRecord, recordsMissingFromZone } from "../domain";
import { sharedDesired } from "../provision/shared-cloudflare";
import { readServerAddresses, requestApproval } from "../shared";
import { ABORT_COMMAND, B_TOKEN_VAR, MOVE_COMMAND, refusal } from "./texts";
import type { MoveSession, MoveZone } from "./types";

/** The comment of a mark's TXT records: no copy or foreign-record check takes it for an app's. */
export const MARK_COMMENT = "OpsCrew move mark";
/** The first label of every mark's name: `_opscrew-move.<label>.<zone>`. */
export const MARK_PREFIX = "_opscrew-move.";

/** A DNS record of a zone plan: every field a copy keeps, without its id and Cloudflare's `meta`. */
export type ZoneRecord = CloudflareZoneRecordInput;

/** The marks a zone plan writes (TXT contents) or deletes (record ids), under the mark's name. */
export type ZoneMarks = { name: string; create: string[] } | { name: string; delete: string[] };

/** The zone plan (data model 5); `planHash` is the SHA-256 of the canonical JSON of the rest. */
export interface ZoneCopy {
  zone: string;
  from: { accountId: string; zoneId: string };
  /** No `zoneId`: the plan adds the zone to B. */
  to: { accountId: string; zoneId?: string };
  createZone: boolean;
  /** In A, missing from B: created in B. */
  create: ZoneRecord[];
  /** The same type and name in both, other content: listed only (B's is served after the switch). */
  differ: { a: ZoneRecord; b: ZoneRecord }[];
  /** Listed only, never deleted. */
  onlyInB: ZoneRecord[];
  /** A's records not copied, and why. */
  skipped: { record: ZoneRecord; reason: string }[];
  marks?: ZoneMarks;
  planHash: string;
}

/** A zone plan with its text as shown before the approval (addresses masked; not hashed). */
export interface ZonePlan extends ZoneCopy {
  details: string;
}

/** Shown in place of an app's server's address. */
const MASKED_ADDRESS = "<server address>";

/**
 * True for a record Cloudflare made, by its `meta`: a Workers custom domain's record is
 * `read_only` with the Worker in `origin_worker_id`. Research R10 (spike T2802) is to confirm which
 * fields mark Cloudflare's own records; this is the one place that reads them.
 */
export function cloudflareManaged(record: Pick<CloudflareZoneRecord, "meta">): boolean {
  const meta = record.meta ?? {};
  return meta.read_only === true || meta.origin_worker_id !== undefined;
}

/** True for a mark's record: its comment, or its name under {@link MARK_PREFIX}. */
export function isMarkRecord(record: Pick<CloudflareZoneRecord, "name" | "comment">): boolean {
  return record.comment?.trim() === MARK_COMMENT || record.name.startsWith(MARK_PREFIX);
}

/** Why `record` is never copied nor compared, or `undefined` for a record a copy keeps. */
function skipReason(record: CloudflareZoneRecord, zone: string): string | undefined {
  if (record.comment?.trim() === OPSCREW_MANAGED_COMMENT) {
    return "OpsCrew's record: each app's own prepare makes it in the new account";
  }
  if (isMarkRecord(record)) return "a mark of the move";
  if (cloudflareManaged(record)) {
    return "made by Cloudflare (a Workers custom domain's record, for one)";
  }
  if (record.type.toUpperCase() === "NS" && record.name.toLowerCase() === zone) {
    return "the zone's own nameservers: the new account's zone has its own";
  }
  return undefined;
}

/** `record` without its id and `meta`, as a plan holds it. */
function zoneRecord(record: CloudflareZoneRecord): ZoneRecord {
  const { id: _id, meta: _meta, ...rest } = record;
  return rest;
}

/** `record` as the client creates it: a record with `data` (SRV, CAA) without its `content`. */
function recordInput(record: ZoneRecord): ZoneRecord {
  if (record.data === undefined) return record;
  const { content: _content, ...rest } = record;
  return rest;
}

/** True when `b` keeps `a` from being created in B: the same type and name, or a CNAME there. */
function clashes(a: CloudflareZoneRecord, b: CloudflareZoneRecord): boolean {
  if (a.name.toLowerCase() !== b.name.toLowerCase()) return false;
  const type = a.type.toUpperCase();
  const other = b.type.toUpperCase();
  return type === other || type === "CNAME" || other === "CNAME";
}

/** A record as compared: by its `data` alone when it has some (Cloudflare words their content). */
function comparable(record: CloudflareZoneRecord): ComparableRecord {
  const { type, name, content, data, priority } = record;
  return {
    type,
    name,
    ...(data === undefined ? { content } : { data }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** The records of `source` that `zone` does not have (`recordsMissingFromZone`). */
function missing(
  source: readonly CloudflareZoneRecord[],
  zone: readonly CloudflareZoneRecord[],
): CloudflareZoneRecord[] {
  const views = new Map(source.map((record) => [comparable(record), record] as const));
  return recordsMissingFromZone([...views.keys()], zone.map(comparable)).map(
    (view) => views.get(view) as CloudflareZoneRecord,
  );
}

const byJson = <T>(items: readonly T[]): T[] =>
  [...items].sort((x, y) => canonicalJson(x).localeCompare(canonicalJson(y)));

/** The plan's changes: the zone added, the records created, the marks written or deleted. */
function changeCount(plan: ZoneCopy): number {
  const marks = plan.marks === undefined ? 0 : marksOf(plan.marks).length;
  return (plan.createZone ? 1 : 0) + plan.create.length + marks;
}

function marksOf(marks: ZoneMarks): string[] {
  return "create" in marks ? marks.create : marks.delete;
}

/** True for a plan that only deletes marks (the finish's, the abort's): it reads and copies nothing. */
function deletesOnly(marks: ZoneMarks | undefined): boolean {
  return marks !== undefined && "delete" in marks;
}

/**
 * The zone plan, read-only: A's records that are no OpsCrew app's (not OpsCrew's comment, not
 * Cloudflare's own, not the apex NS, not a mark) compared with B's by type, name and normalised
 * content (`recordsMissingFromZone`); those missing from B created, those whose type and name B
 * has with other content listed, B's own listed; B's zone added when it has none; and `marks`.
 * A's records are read only while A's zone is active (it is authoritative) and never for a plan
 * that only deletes marks.
 */
export async function planZone(
  session: MoveSession,
  options: { marks?: ZoneMarks } = {},
): Promise<ZonePlan> {
  const { zone } = session;
  const { a, b } = session.accounts;
  const copies = !deletesOnly(options.marks) && a.zone?.status === "active";
  const inA = copies ? await a.client.listZoneRecords(a.zoneId) : [];
  const inB = copies && b.zone !== undefined ? await b.client.listZoneRecords(b.zone.id) : [];
  const skipped: ZoneCopy["skipped"] = [];
  const fromA: CloudflareZoneRecord[] = [];
  for (const record of inA) {
    const reason = skipReason(record, zone);
    if (reason === undefined) fromA.push(record);
    else skipped.push({ record: zoneRecord(record), reason });
  }
  const fromB = inB.filter((record) => skipReason(record, zone) === undefined);
  const unmatchedB = missing(fromB, fromA);
  const create: ZoneRecord[] = [];
  const differ: ZoneCopy["differ"] = [];
  const paired = new Set<CloudflareZoneRecord>();
  for (const record of missing(fromA, fromB)) {
    const other =
      unmatchedB.find((one) => clashes(record, one)) ?? fromB.find((one) => clashes(record, one));
    if (other === undefined) {
      create.push(zoneRecord(record));
      continue;
    }
    differ.push({ a: zoneRecord(record), b: zoneRecord(other) });
    paired.add(other);
  }
  const body: Omit<ZoneCopy, "planHash"> = {
    zone,
    from: { accountId: a.accountId, zoneId: a.zoneId },
    to: { accountId: b.accountId, ...(b.zone === undefined ? {} : { zoneId: b.zone.id }) },
    createZone: b.zone === undefined,
    create: byJson(create),
    differ: byJson(differ),
    onlyInB: byJson(unmatchedB.filter((record) => !paired.has(record)).map(zoneRecord)),
    skipped: byJson(skipped),
    ...(options.marks === undefined ? {} : { marks: options.marks }),
  };
  const plan: ZoneCopy = { ...body, planHash: sha256Hex(canonicalJson(body)) };
  const addresses = await serverAddresses(session, inA);
  return { ...plan, details: session.deps.redactor.redact(describeZone(session, plan, addresses)) };
}

/**
 * The addresses of the apps' servers: those OpsCrew's A and AAAA records in A's zone point at, and
 * the covered environments' servers this computer knows.
 */
async function serverAddresses(
  session: MoveSession,
  inA: readonly CloudflareZoneRecord[],
): Promise<string[]> {
  const found = inA
    .filter((record) => record.comment?.trim() === OPSCREW_MANAGED_COMMENT)
    .filter((record) => ["A", "AAAA"].includes(record.type.toUpperCase()))
    .map((record) => record.content);
  for (const env of session.environments) {
    const known = await readServerAddresses(env.paths);
    for (const address of [known.deployment, ...Object.values(known.servers ?? {})]) {
      if (address === undefined) continue;
      found.push(address.ipv4, ...(address.ipv6 === undefined ? [] : [address.ipv6]));
    }
  }
  // Longest first, so an address that contains another is masked whole.
  return [...new Set(found.filter((one) => one.length > 0))].sort((x, y) => y.length - x.length);
}

/** `MX example.com 10 mail.example.com (proxied)`: a record as the plan shows it. */
function recordText(record: ZoneRecord, addresses: readonly string[]): string {
  let content = record.content ?? canonicalJson(record.data ?? {});
  for (const address of addresses) content = content.split(address).join(MASKED_ADDRESS);
  const priority = record.priority === undefined ? "" : ` ${record.priority}`;
  return `${record.type} ${record.name}${priority} ${content}${record.proxied ? " (proxied)" : ""}`;
}

/** The plan in words, as its approval shows it. */
function describeZone(session: MoveSession, plan: ZoneCopy, addresses: readonly string[]): string {
  const { zone } = plan;
  const { a, b } = session.accounts;
  const bName = b.name ?? b.accountId;
  const aName = a.name ?? a.accountId;
  const text = (record: ZoneRecord) => recordText(record, addresses);
  const lines = [
    `The zone plan for ${zone} in the Cloudflare account ${bName} (hash ${plan.planHash}):`,
  ];
  if (plan.createZone) {
    lines.push(
      `- Add ${zone} to the account ${bName}. It stays pending, and serves nothing, until the switch.`,
    );
  }
  if (plan.create.length > 0) {
    lines.push(
      `- Copy ${plural(plan.create.length, "record")} from the account ${aName}, each with its proxied state, TTL and comment:`,
      ...plan.create.map((record) => `  - ${text(record)}`),
    );
  }
  if (plan.differ.length > 0) {
    lines.push(
      `- Different in the new account's zone, never changed there (after the switch the new account's record is served):`,
      ...plan.differ.map(
        (pair) => `  - ${aName} has ${text(pair.a)}; ${bName} has ${text(pair.b)}`,
      ),
    );
  }
  if (plan.onlyInB.length > 0) {
    lines.push(
      "- Only in the new account's zone, kept as they are:",
      ...plan.onlyInB.map((record) => `  - ${text(record)}`),
    );
  }
  if (plan.skipped.length > 0) {
    lines.push(
      "- Not copied:",
      ...plan.skipped.map(({ record, reason }) => `  - ${text(record)}: ${reason}`),
    );
  }
  if (plan.marks !== undefined) {
    const count = plural(marksOf(plan.marks).length, "TXT record");
    lines.push(
      "create" in plan.marks
        ? `- Write the app's mark of the move, ${plan.marks.name} (${count}): its name, its environments' names and its hostnames, no secret.`
        : `- Delete the app's mark of the move, ${plan.marks.name} (${count}).`,
    );
  }
  if (changeCount(plan) === 0) lines.push("- Nothing to change.");
  lines.push(`Nothing in the account ${aName} changes.`);
  return lines.join("\n");
}

/** The zone permissions B's token needs for the app's pieces: DNS, their rules' phases, SSL. */
function zoneNeeds(session: MoveSession): ZonePermissionNeed[] {
  const needs = new Set<ZonePermissionNeed>(["dns"]);
  for (const env of session.environments) {
    const { hostnames } = sharedDesired(env.plan, session.zone);
    for (const [ref, hosts] of Object.entries(hostnames)) {
      if ((hosts ?? []).length > 0) needs.add(SHARED_RULES[ref as SharedRuleRef].phase);
    }
    // Origin TLS (the client certificate, AOP, the Origin CA certificate) goes with strict TLS.
    if ((hostnames["opscrew-strict-tls"] ?? []).length > 0) needs.add("ssl");
  }
  return [...needs];
}

/**
 * Stops unless B's zone has nameservers of its own and B's token has every zone permission the
 * app's pieces need there, each missing one named. `added`: this run added the zone just now.
 */
async function requireUsableZone(
  session: MoveSession,
  zone: MoveZone,
  added: boolean,
): Promise<void> {
  const { a, b } = session.accounts;
  const unchanged = added ? "The zone was added to the new account; nothing else was changed." : "";
  const stop = (
    message: string,
    hint: string,
    code: "PHASE_PRECONDITION" | "CREDENTIALS_INVALID",
  ) =>
    added
      ? new OpsCrewError(code, `${message} ${unchanged}`, { hint })
      : refusal(message, hint, code);
  const own = (servers: readonly string[]) =>
    [...servers]
      .map((one) => one.toLowerCase())
      .sort()
      .join(",");
  const aServers = a.zone?.nameServers ?? [];
  if (aServers.length > 0 && own(zone.nameServers) === own(aServers)) {
    throw stop(
      `Cloudflare gave ${session.zone} in the account ${b.name ?? b.accountId} the nameservers it has in the account ${a.name ?? a.accountId} (${listText(zone.nameServers)}), so pointing the domain at the new account would change nothing.`,
      `Run \`${ABORT_COMMAND}\` to remove the zone from the new account, then start the move again (\`${MOVE_COMMAND} --to <account>\`): Cloudflare gives the zone another pair when it is added again.`,
      "PHASE_PRECONDITION",
    );
  }
  const { missing } = await b.client.zonePermissions(zone.id, zoneNeeds(session));
  if (missing.length === 0) return;
  throw stop(
    `${B_TOKEN_VAR} lacks ${listText(missing)} for ${session.zone} in the account ${b.name ?? b.accountId}, which the app's pieces need there.`,
    `Add ${missing.length === 1 ? "it" : "them"} to the token at ${CLOUDFLARE_TOKEN_PAGE} (for this zone, or all zones of the account), then run \`${session.command}\` again.`,
    "CREDENTIALS_INVALID",
  );
}

/**
 * Applies the zone plan: with B's zone there (and the plan not only deleting marks), its
 * nameservers and B's zone permissions are checked first; a plan without changes stops there.
 * Otherwise it is approved by its hash (`cloudflare-apply`), made again and refused when the hash
 * differs (nothing changed), then B's zone is added when the plan says so (and checked as above
 * before any record), the records and the marks created in batches of 200, and the marks to delete
 * deleted. Returns B's zone, which `session` holds from then on.
 * @throws PlanRefusedError when the plan is not approved; `PLAN_HASH_MISMATCH` when the zones
 * changed since it was made.
 */
export async function applyZone(
  session: MoveSession,
  plan: ZonePlan,
): Promise<MoveZone | undefined> {
  const { deps, zone } = session;
  const { b } = session.accounts;
  const checks = !deletesOnly(plan.marks);
  if (checks && b.zone !== undefined) await requireUsableZone(session, b.zone, false);
  const changes = changeCount(plan);
  if (changes === 0) return b.zone;
  await requestApproval(deps, {
    kind: "cloudflare-apply",
    title: `Apply the zone plan to ${zone} in the Cloudflare account ${b.name ?? b.accountId} (${plural(changes, "change")})`,
    details: plan.details,
    hash: plan.planHash,
    refused: {
      plan: "zone plan",
      unchanged: "Nothing in Cloudflare was changed.",
      again: session.command,
    },
  });
  await deps.approvals.assertApprovedCloudflarePlan(plan.planHash);
  const again = await planZone(session, plan.marks === undefined ? {} : { marks: plan.marks });
  if (again.planHash !== plan.planHash) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The zones changed since the zone plan ${plan.planHash} was made, so it was not applied. Nothing was changed.`,
      { hint: `Run \`${session.command}\` again to see the new plan.` },
    );
  }
  const audit = (action: string, detail: string) =>
    deps.audit.append({
      kind: "provider-call",
      actor: "opscrew",
      action,
      phase: "cloudflare-move",
      target: plan.planHash,
      decision: "approved",
      detail,
    });
  deps.reporter.step(`Changing ${zone} in the Cloudflare account ${b.name ?? b.accountId}`);
  let target = b.zone;
  if (plan.createZone) {
    target = { ...(await b.client.createZone(b.accountId, zone)), accountId: b.accountId };
    b.zone = target;
    await audit("cloudflare zone created", `${zone} in the account ${b.accountId}`);
    if (checks) await requireUsableZone(session, target, true);
  }
  if (target === undefined) {
    throw new OpsCrewError(
      "INTERNAL",
      `The zone plan has no zone for ${zone} in the new account.`,
      {
        hint: "This is a bug in OpsCrew; please report it.",
      },
    );
  }
  const marks = plan.marks;
  const records: ZoneRecord[] = [
    ...plan.create.map(recordInput),
    ...(marks !== undefined && "create" in marks
      ? marks.create.map((content) => ({
          type: "TXT",
          name: marks.name,
          content,
          ttl: 1,
          proxied: false,
          comment: MARK_COMMENT,
        }))
      : []),
  ];
  if (records.length > 0) {
    await b.client.createZoneRecords(target.id, records);
    await audit("cloudflare records created", `${plural(records.length, "record")} in ${zone}`);
  }
  if (marks !== undefined && "delete" in marks) {
    for (const id of marks.delete) await b.client.deleteRecord(target.id, id);
    await audit(
      "cloudflare mark deleted",
      `${marks.name}: ${plural(marks.delete.length, "record")}`,
    );
  }
  deps.reporter.success(
    `Changed ${zone} in the account ${b.name ?? b.accountId} (${plural(changes, "change")}).`,
  );
  return target;
}
