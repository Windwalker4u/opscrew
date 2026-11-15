/**
 * The switch plan (plan 5.5): its canonical JSON's SHA-256 is the hash the switch's approval
 * (`domain-settings`, the zone's name typed) is bound to. It covers A's and B's zones, the
 * nameservers before and after, the registrar, the DS records removed, the zone copy plan's hash,
 * the marks (apps and hostnames), the Access applications and protected records made and each
 * site's custom domains attached right after activation, and DNSSEC turned on in B.
 */
import type { DsRecord } from "@opscrew/contracts";
import { canonicalJson, listText, plural, sha256Hex } from "@opscrew/core";
import type { DomainRegistrar } from "../domain";
import { dsRecordText } from "../domain/switch";
import type { ReadMark } from "./marks";
import type { DsGate } from "./switch-ds";
import { registrarId, registrarWords } from "./switch-registrar";
import type { MoveSession, MoveZone } from "./types";
import { planZone, type ZonePlan } from "./zone";

/** What the switch plan says; hashed as canonical JSON. */
export interface SwitchPlanBody {
  zone: string;
  from: { accountId: string; zoneId: string };
  to: { accountId: string; zoneId: string };
  nameservers: { before: string[]; after: string[] };
  /** `porkbun`, `namecheap`, `godaddy`, `cloudflare` (Cloudflare Registrar) or `other`. */
  registrar: string;
  /** The DS records this run removes through the registrar's API (then it stops for the wait). */
  dsRemoval: DsRecord[];
  /** The zone copy plan's hash; absent when this run only removes DS records. */
  zoneCopy?: string;
  marks: { app: string; hosts: string[] }[];
  /** Hostnames behind Cloudflare Access, protected in B right after activation. */
  access: string[];
  sites: { worker: string; domains: string[] }[];
  /** DNSSEC turned on in B (the registry published a DS record when the move started). */
  dnssec: boolean;
}

/** The switch plan, its hash, its zone copy and its text as the approval shows it. */
export interface SwitchPlan extends SwitchPlanBody {
  planHash: string;
  copy?: ZonePlan;
  details: string;
}

/** What the switch plan is made from, read by the switch before it plans. */
export interface SwitchPlanInput {
  registrar: DomainRegistrar;
  /** The zone's nameservers now. */
  before: string[];
  /** B's zone, read now. */
  zone: MoveZone;
  gate: Exclude<DsGate, { kind: "stop" }>;
  marks: readonly ReadMark[];
  dnssec: boolean;
}

/** The switch plan, read-only: the zone copy planned (`planZone`) unless this run removes DS records. */
export async function planSwitch(
  session: MoveSession,
  input: SwitchPlanInput,
): Promise<SwitchPlan> {
  const { a, b } = session.accounts;
  const copy = input.gate.kind === "remove" ? undefined : await planZone(session);
  const sorted = (list: readonly string[]) => [...list].map((one) => one.toLowerCase()).sort();
  const body: SwitchPlanBody = {
    zone: session.zone,
    from: { accountId: a.accountId, zoneId: a.zoneId },
    to: { accountId: b.accountId, zoneId: input.zone.id },
    nameservers: { before: sorted(input.before), after: sorted(input.zone.nameServers) },
    registrar: registrarId(input.registrar),
    dsRemoval: input.gate.kind === "remove" ? (input.gate.ds.api ?? []) : [],
    ...(copy === undefined ? {} : { zoneCopy: copy.planHash }),
    marks: input.marks.map((read) => ({ app: read.mark.app, hosts: read.mark.hosts })),
    access: input.marks.flatMap((read) => read.mark.access.map((one) => one.hostname)).sort(),
    sites: input.marks.flatMap((read) => read.mark.sites),
    dnssec: input.dnssec,
  };
  const planHash = sha256Hex(canonicalJson(body));
  const details = session.deps.redactor.redact(describe(session, body, planHash, input, copy));
  return { ...body, planHash, ...(copy === undefined ? {} : { copy }), details };
}

/** The switch plan in words, as its approval shows it (plan 5.5, FR-2807). */
function describe(
  session: MoveSession,
  plan: SwitchPlanBody,
  planHash: string,
  input: SwitchPlanInput,
  copy: ZonePlan | undefined,
): string {
  const { zone } = plan;
  const { a, b } = session.accounts;
  const aName = a.name ?? a.accountId;
  const bName = b.name ?? b.accountId;
  const where = registrarWords(input.registrar);
  const lines = [
    `The switch of ${zone} from the Cloudflare account ${aName} to ${bName} (hash ${planHash}):`,
  ];
  if (plan.dsRemoval.length > 0) {
    lines.push(
      `- Remove the DNSSEC (DS) records of ${zone} at ${where}: ${plan.dsRemoval.map(dsRecordText).join("; ")}. This run stops there: resolvers may remember them for a day or two, and the run after that wait plans the switch again and asks again.`,
    );
    return lines.join("\n");
  }
  if (copy !== undefined && copy.create.length > 0) {
    lines.push(
      `- Copy ${plural(copy.create.length, "record")} the new account's zone lacks from ${aName} first (the zone plan, hash ${copy.planHash}):`,
      ...copy.details.split("\n").map((line) => `  ${line}`),
    );
  }
  const how =
    input.registrar.kind === "api"
      ? `set at ${where} through its API now`
      : input.registrar.kind === "cloudflare"
        ? "through Cloudflare Registrar's move between accounts, which you start in the old account's dashboard and accept in the new one's"
        : "set by you at the registrar that holds it";
  lines.push(
    `- The nameservers of ${zone}: from ${listText(plan.nameservers.before) || "none"} to ${listText(plan.nameservers.after)}, ${how}. Cloudflare then activates the zone in ${bName}.`,
  );
  const after: string[] = [];
  if (plan.access.length > 0) {
    after.push(
      `  - Cloudflare Access applications for ${listText(plan.access)}, as each app's own provision makes them, then their DNS records to the app's tunnel in ${bName}.`,
    );
  }
  for (const site of plan.sites) {
    after.push(
      `  - Attach ${listText(site.domains)} to the Worker ${site.worker} in ${bName} (detached in ${aName} first if Cloudflare says it still holds one there).`,
    );
  }
  if (plan.dnssec) {
    after.push(`  - Turn DNSSEC on for ${zone} in ${bName} and publish its DS record at ${where}.`);
  }
  if (after.length > 0) lines.push("- Right after the new account's zone is active:", ...after);
  lines.push(
    "- The apps prepared in the new account (each keeps its mark until its own finish):",
    ...plan.marks.map((mark) => `  - ${mark.app}: ${listText(mark.hosts)}`),
    "What it means for visitors:",
    "- From the nameserver change until the new account's zone is active and its Universal SSL certificate issued (minutes, at worst 24 hours), HTTPS visitors may get certificate errors.",
  );
  if (plan.sites.length > 0) {
    lines.push(
      "- A site on Cloudflare's hosting answers once its custom domains are attached, right after activation.",
    );
  }
  lines.push(
    "- An app with origin protection may answer 526 from activation until its finish, so run each finish right away: the switch's output lists them first.",
  );
  if (plan.access.length > 0) {
    lines.push(
      "- Deploys through Cloudflare Access pause for the moments between activation and the switch making their Access applications in the new account.",
    );
  }
  lines.push(`Nothing else in the account ${aName} changes.`);
  return lines.join("\n");
}
