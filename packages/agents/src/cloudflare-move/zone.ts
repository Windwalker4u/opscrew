/**
 * The zone plan of a move (data model 5): B's zone added when it is missing, A's records that are
 * no OpsCrew app's copied to it create-only (records that differ, and those only in B, are listed
 * and never changed), and an app's mark written or deleted. Planned here, shown with the app's
 * servers' addresses masked, approved by its hash (`cloudflare-apply`) and applied through the
 * Cloudflare client. A's zone is only read.
 */
import {
  CLOUDFLARE_TOKEN_PAGE,
  type CloudflareRecordInput,
  type CloudflareZoneRecord,
  type CloudflareZoneRecordInput,
  OPSCREW_MANAGED_COMMENT,
  SHARED_RULES,
  type SharedRuleRef,
  type ZonePermissionNeed,
} from "@opscrew/connector-cloudflare";
import { canonicalJson, listText, OpsCrewError, plural, sha256Hex } from "@opscrew/core";
import { type ComparableRecord, recordsMissingFromZone, sameRecordContent } from "../domain";
import { recordText } from "../domain/connect-plan";
import { sharedDesired } from "../provision/shared-cloudflare";
import { appliesNow } from "../retarget/steps";
import { approveCommand } from "../retarget/texts";
import { readServerAddresses, requestApproval } from "../shared";
import { clearPending, type MovePlanKey, writePending } from "./progress";
import { ABORT_COMMAND, B_TOKEN_VAR, MOVE_COMMAND, refusal } from "./texts";
import type { MoveSession, MoveZone, StepStop } from "./types";

/** The comment of a mark's TXT records: no copy or foreign-record check takes it for an app's. */
export const MARK_COMMENT = "OpsCrew move mark";
/** The first label of every mark's name: `_opscrew-move.<label>.<zone>`. */
export const MARK_PREFIX = "_opscrew-move.";

/** A DNS record of a zone plan: every field a copy keeps, without its id and Cloudflare's `meta`. */
export type ZoneRecord = CloudflareZoneRecordInput;

/** The TXT records of one app's mark a zone plan writes (contents) and deletes (record ids). */
export interface ZoneMarks {
  name: string;
  create: string[];
  delete: string[];
}

/**
 * A's records of a type and name against B's, listed and never changed: B has other values of
 * them (or one proxied differently, or a CNAME there that Cloudflare won't put another record
 * beside). After the switch B's are served.
 */
export interface ZoneDifference {
  /** A's records' type and name. */
  type: string;
  name: string;
  a: ZoneRecord[];
  b: ZoneRecord[];
}

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
  differ: ZoneDifference[];
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
 * True for a record Cloudflare made, by its `meta` (research R10): `read_only`, as a Workers custom
 * domain's record is; `origin_worker_id`, the Worker such a record serves, is a second sign. The
 * one place that reads them.
 */
function cloudflareManaged(record: Pick<CloudflareZoneRecord, "meta">): boolean {
  const meta = record.meta ?? {};
  return meta.read_only === true || meta.origin_worker_id !== undefined;
}

/** True for a mark's record: its comment, or its name under {@link MARK_PREFIX}. */
function isMarkRecord(record: Pick<CloudflareZoneRecord, "name" | "comment">): boolean {
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
export function recordInput(record: ZoneRecord): ZoneRecord {
  if (record.data === undefined) return record;
  const { content: _content, ...rest } = record;
  return rest;
}

/** A record's type and name, the set it belongs to. */
const keyOf = (record: Pick<ZoneRecord, "type" | "name">) =>
  `${record.type.toUpperCase()} ${record.name.toLowerCase()}`;

/**
 * A CNAME beside another type of record of the name, which Cloudflare refuses to create; not at
 * the zone's apex, where Cloudflare flattens a CNAME and takes other records beside it.
 */
function cnameClash(a: CloudflareZoneRecord, b: CloudflareZoneRecord, zone: string): boolean {
  const name = a.name.toLowerCase();
  if (name !== b.name.toLowerCase() || name === zone) return false;
  const types = [a.type.toUpperCase(), b.type.toUpperCase()];
  return types[0] !== types[1] && types.includes("CNAME");
}

/** The types `recordsMissingFromZone` compares by their `data`; every other by its `content`. */
const DATA_TYPES = new Set(["SRV", "CAA"]);

/** A record as compared: SRV and CAA by their `data` (Cloudflare words their content itself). */
function comparable(record: Omit<ZoneRecord, "ttl">): ComparableRecord {
  const { type, name, content, data, priority } = record;
  const byData = data !== undefined && DATA_TYPES.has(type.toUpperCase());
  return {
    type,
    name,
    ...(byData ? { data } : content === undefined ? {} : { content }),
    ...(priority === undefined ? {} : { priority }),
  };
}

/** True when `a` and `b` are the same value but one is proxied and the other not. */
function proxiedApart(a: Omit<ZoneRecord, "ttl">, b: Omit<ZoneRecord, "ttl">): boolean {
  return (
    sameRecordContent(comparable(a), comparable(b)) && Boolean(a.proxied) !== Boolean(b.proxied)
  );
}

/** `records` by their type and name. */
function sets(records: readonly CloudflareZoneRecord[]): Map<string, CloudflareZoneRecord[]> {
  const found = new Map<string, CloudflareZoneRecord[]>();
  for (const record of records)
    found.set(keyOf(record), [...(found.get(keyOf(record)) ?? []), record]);
  return found;
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

/** The plan's changes: the zone added, the records created, the mark's records written or deleted. */
function changeCount(plan: ZoneCopy): number {
  const marks = (plan.marks?.create.length ?? 0) + (plan.marks?.delete.length ?? 0);
  return (plan.createZone ? 1 : 0) + plan.create.length + marks;
}

/** True for a plan that only deletes a mark (the finish's, the abort's): it copies nothing. */
function deletesOnly(marks: ZoneMarks | undefined): boolean {
  return marks !== undefined && marks.create.length === 0 && marks.delete.length > 0;
}

/** A plan of OpsCrew's own making that is not what it must be: OpsCrew's bug. */
function bug(message: string): OpsCrewError {
  return new OpsCrewError("INTERNAL", message, {
    hint: "This is a bug in OpsCrew; please report it.",
  });
}

/** Stops unless `marks` names a mark and deletes only TXT records of that name in `inB`. */
function requireMarks(marks: ZoneMarks, inB: readonly CloudflareZoneRecord[]): void {
  if (!marks.name.startsWith(MARK_PREFIX)) {
    throw bug(`The zone plan's mark ${marks.name} is not named as a mark of the move.`);
  }
  const own = new Set(
    inB
      .filter((record) => record.type.toUpperCase() === "TXT" && record.name === marks.name)
      .map((record) => record.id),
  );
  const other = marks.delete.find((id) => !own.has(id));
  if (other !== undefined) {
    throw bug(
      `The zone plan deletes the record ${other}, which is not a TXT record of ${marks.name}.`,
    );
  }
}

/**
 * The zone plan, read-only: A's records that are no OpsCrew app's (not OpsCrew's comment, not
 * Cloudflare's own, not the apex NS, not a mark) compared with B's by type, name and normalised
 * content (`recordsMissingFromZone`), set by set (a type and a name). A's values missing from B are
 * created when B has no other value of the set and none proxied differently; otherwise, or when
 * B has a CNAME clash Cloudflare would refuse, the set is listed and never changed. B's sets that
 * A doesn't have are listed; B's zone is added when it has none; and the mark's records
 * (`marks`, a mark's name, deleting only its TXT records). A's records are read only while A's
 * zone is active (it is authoritative) and never for a plan that only deletes a mark.
 */
export async function planZone(
  session: MoveSession,
  options: { marks?: ZoneMarks } = {},
): Promise<ZonePlan> {
  const { zone } = session;
  const { a, b } = session.accounts;
  const { marks } = options;
  const copies = !deletesOnly(marks) && a.zone?.status === "active";
  const reads = copies || (marks?.delete.length ?? 0) > 0;
  const inA = copies ? await a.client.listZoneRecords(a.zoneId) : [];
  const inB = reads && b.zone !== undefined ? await b.client.listZoneRecords(b.zone.id) : [];
  if (marks !== undefined) requireMarks(marks, inB);
  const skipped: ZoneCopy["skipped"] = [];
  const fromA: CloudflareZoneRecord[] = [];
  for (const record of inA) {
    const reason = skipReason(record, zone);
    if (reason === undefined) fromA.push(record);
    else skipped.push({ record: zoneRecord(record), reason });
  }
  const fromB = copies ? inB.filter((record) => skipReason(record, zone) === undefined) : [];
  const inSetsA = sets(fromA);
  const inSetsB = sets(fromB);
  const create: ZoneRecord[] = [];
  const differ: ZoneDifference[] = [];
  /** B's records a difference lists. */
  const listed = new Set<CloudflareZoneRecord>();
  const differs = (
    first: CloudflareZoneRecord,
    setA: readonly CloudflareZoneRecord[],
    setB: readonly CloudflareZoneRecord[],
  ) => {
    differ.push({
      type: first.type,
      name: first.name,
      a: byJson(setA.map(zoneRecord)),
      b: byJson(setB.map(zoneRecord)),
    });
    for (const record of setB) listed.add(record);
  };
  for (const [key, setA] of inSetsA) {
    const first = setA[0] as CloudflareZoneRecord;
    const setB = inSetsB.get(key) ?? [];
    if (setB.length === 0) {
      const clash = fromB.filter((record) => cnameClash(first, record, zone));
      if (clash.length > 0) differs(first, setA, clash);
      else create.push(...setA.map(zoneRecord));
      continue;
    }
    // A value is added only where B has no other value of the set; otherwise the set is listed.
    const apart = setA.some((one) => setB.some((other) => proxiedApart(one, other)));
    if (missing(setB, setA).length > 0 || apart) differs(first, setA, setB);
    else create.push(...missing(setA, setB).map(zoneRecord));
  }
  const body: Omit<ZoneCopy, "planHash"> = {
    zone,
    from: { accountId: a.accountId, zoneId: a.zoneId },
    to: { accountId: b.accountId, ...(b.zone === undefined ? {} : { zoneId: b.zone.id }) },
    createZone: b.zone === undefined,
    create: byJson(create),
    differ: byJson(differ),
    onlyInB: byJson(
      fromB.filter((record) => !inSetsA.has(keyOf(record)) && !listed.has(record)).map(zoneRecord),
    ),
    skipped: byJson(skipped),
    ...(marks === undefined ? {} : { marks }),
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
  return [...new Set(found.filter((one) => one.length > 0))];
}

/** `MX example.com 10 mail.example.com`, ` (proxied)` when it is: the addresses masked. */
function shownRecord(record: ZoneRecord, addresses: readonly string[]): string {
  let text = recordText({ ...record, proxied: false } as CloudflareRecordInput);
  for (const address of addresses) text = text.replace(addressPattern(address), MASKED_ADDRESS);
  return `${text}${record.proxied ? " (proxied)" : ""}`;
}

/**
 * Where `address` stands as a whole address: `203.0.113.1` is not found inside `203.0.113.10`, while
 * an SPF policy's `ip4:203.0.113.1` and `ip6:2001:db8::1` are.
 */
function addressPattern(address: string): RegExp {
  const escaped = address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = address.includes(":")
    ? `(?:(?<=ip6:)|(?<![0-9a-fA-F:]))${escaped}(?![0-9a-fA-F]|:[0-9a-fA-F])`
    : `(?<![\\d.])${escaped}(?!\\d|\\.\\d)`;
  return new RegExp(pattern, "g");
}

/** The difference in words: `Old has x', y'; New has x, y`, and a value proxied in one only. */
function differenceText(
  difference: ZoneDifference,
  names: { a: string; b: string },
  text: (record: ZoneRecord) => string,
): string {
  const line = `${names.a} has ${difference.a.map(text).join(", ")}; ${names.b} has ${difference.b.map(text).join(", ")}`;
  const apart = difference.a.find((one) => difference.b.some((other) => proxiedApart(one, other)));
  if (apart === undefined) return line;
  const [on, off] = apart.proxied ? [names.a, names.b] : [names.b, names.a];
  return `${line} (proxied in ${on}, not in ${off})`;
}

/** The plan in words, as its approval shows it. */
function describeZone(session: MoveSession, plan: ZoneCopy, addresses: readonly string[]): string {
  const { zone, marks } = plan;
  const { a, b } = session.accounts;
  const bName = b.name ?? b.accountId;
  const aName = a.name ?? a.accountId;
  const text = (record: ZoneRecord) => shownRecord(record, addresses);
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
  if (a.zone?.status !== "active" && !deletesOnly(marks)) {
    lines.push(
      `- ${aName}'s records were not read, since ${zone} is ${a.zone?.status ?? "gone"} there: nothing is copied.`,
    );
  }
  if (plan.differ.length > 0) {
    lines.push(
      `- Different in the new account's zone, never changed there. A value is copied only where the new account's zone has no other value of its type and name; otherwise the whole set is listed. After the switch the new account's records are served:`,
      ...plan.differ.map(
        (difference) => `  - ${differenceText(difference, { a: aName, b: bName }, text)}`,
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
  if (marks !== undefined && marks.create.length > 0) {
    lines.push(
      `- Write the app's mark of the move, ${marks.name} (${plural(marks.create.length, "TXT record")}): its name, its environments' names and its hostnames, no secret.`,
    );
  }
  if (marks !== undefined && marks.delete.length > 0) {
    lines.push(
      `- Delete ${marks.create.length > 0 ? "the mark's earlier records" : "the app's mark of the move"}, ${marks.name} (${plural(marks.delete.length, "TXT record")}).`,
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

/** Which of the move's waiting plans this is: the zone's, a mark's, or a mark's deletion. */
function planKey(marks: ZoneMarks | undefined): MovePlanKey {
  if (marks === undefined) return { action: "zone" };
  return { action: marks.create.length > 0 ? "mark" : "mark-delete" };
}

/**
 * Applies the zone plan: with B's zone there (and the plan not only deleting a mark), its
 * nameservers and B's zone permissions are checked first; a plan without changes stops there.
 * A run that doesn't apply it now (not interactive, and no `--approve` with its hash) shows it,
 * records it as waiting and stops with the command that applies it. Otherwise it is approved by
 * its hash (`cloudflare-apply`), made again and refused when the hash differs (nothing changed),
 * then B's zone is added when the plan says so (and checked as above before any record), the
 * records and the mark's created in batches of 200, and the mark's records to delete deleted.
 * `session` holds B's zone from then on.
 * @throws PlanRefusedError when the plan is not approved; `PLAN_HASH_MISMATCH` when the zones
 * changed since it was made.
 */
export async function applyZone(
  session: MoveSession,
  plan: ZonePlan,
): Promise<StepStop | undefined> {
  const { deps, zone } = session;
  const { b } = session.accounts;
  const checks = !deletesOnly(plan.marks);
  if (checks && b.zone !== undefined) await requireUsableZone(session, b.zone, false);
  const changes = changeCount(plan);
  if (changes === 0) {
    // What is listed and never changed is still shown.
    if (plan.differ.length + plan.onlyInB.length + plan.skipped.length > 0) {
      deps.reporter.info(plan.details);
    }
    return undefined;
  }
  const key = planKey(plan.marks);
  if (!appliesNow(session, plan.planHash)) {
    deps.reporter.info(plan.details);
    await writePending(deps, key, plan.planHash);
    return {
      pendingPlanHash: plan.planHash,
      next: [
        `Review the plan above, then run \`${approveCommand(session.command, plan.planHash)}\` to apply it and continue.`,
      ],
    };
  }
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
  if (target === undefined) throw bug(`The zone plan has no zone for ${zone} in the new account.`);
  const { marks } = plan;
  const markRecords = (marks?.create ?? []).map((content) => ({
    type: "TXT",
    name: (marks as ZoneMarks).name,
    content,
    ttl: 1,
    proxied: false,
    comment: MARK_COMMENT,
  }));
  const records: ZoneRecord[] = [...plan.create.map(recordInput), ...markRecords];
  if (records.length > 0) {
    await b.client.createZoneRecords(target.id, records);
    await audit("cloudflare records created", `${plural(records.length, "record")} in ${zone}`);
  }
  if (marks !== undefined && marks.delete.length > 0) {
    for (const id of marks.delete) await b.client.deleteRecord(target.id, id);
    await audit(
      "cloudflare mark records deleted",
      `${marks.name}: ${plural(marks.delete.length, "record")}`,
    );
  }
  await clearPending(deps, key);
  deps.reporter.success(
    `Changed ${zone} in the account ${b.name ?? b.accountId} (${plural(changes, "change")}).`,
  );
  return undefined;
}
