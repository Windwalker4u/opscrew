/**
 * The prepared mark of an app (data model 4): TXT records `_opscrew-move.<label>.<zone>` in B's zone
 * holding the app's name, its covered environments' names, its hostnames, a site's Worker with its
 * custom domains and the hostnames behind Cloudflare Access (no secret, no e-mail, no repository,
 * no id), split in parts when one record can't hold it; and the switch's coverage: every OpsCrew
 * name in A's zone in some mark.
 */
import {
  type CloudflareZoneRecord,
  inspectShared,
  OPSCREW_MANAGED_COMMENT,
  sharedRuleHostnames,
} from "@opscrew/connector-cloudflare";
import { listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  beszelHostname,
  opscrewRecordNames,
  portainerHostname,
  portainerWebhookHostname,
  sshHostname,
  workerCustomDomainAddresses,
} from "@opscrew/iac-templates";
import {
  type DeployPlan,
  EnvironmentNameSchema,
  FqdnSchema,
  readArtifact,
} from "@opscrew/plan-schema";
import { z } from "zod";
import { unquoteTxt } from "../domain/connect-plan";
import { A_TOKEN_VAR } from "./texts";
import type { MoveSession, StepStop } from "./types";
import { applyZone, MARK_PREFIX, planZone } from "./zone";

/** The longest TXT content Cloudflare takes, quotes included. */
const MAX_CONTENT = 2048;
/** The longest character-string in a TXT record (RFC 1035). */
const TXT_STRING = 255;
const VERSION = "1";

const NameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

const MoveMarkSchema = z.strictObject({
  app: NameSchema,
  envs: z.array(EnvironmentNameSchema).min(1),
  hosts: z.array(FqdnSchema),
  /** Each Workers site's Worker in B and the custom domains the switch attaches to it. */
  sites: z.array(z.strictObject({ worker: NameSchema, domains: z.array(FqdnSchema) })),
  /**
   * Each hostname behind Cloudflare Access, which the switch protects in B right after activation
   * (B refuses Access applications on a pending zone): a service token's (a tunnel's SSH,
   * Portainer's webhook), Portainer's or Beszel's subdomain, with its environment.
   */
  access: z.array(
    z.strictObject({
      hostname: FqdnSchema,
      kind: z.enum(["service", "portainer", "beszel"]),
      environment: EnvironmentNameSchema,
    }),
  ),
});

/** What an app's mark says. */
export type MoveMark = z.infer<typeof MoveMarkSchema>;

/** A mark read from B's zone: its name, its records' ids and what it says. */
export interface ReadMark {
  name: string;
  ids: string[];
  mark: MoveMark;
}

/**
 * The mark's label, `<app name>-<first 8 hex of sha256("<owner>/<repo>#<app key>")>` (the key empty
 * for a repository's first app; owner and repository in lower case): unique across repositories
 * without naming one.
 */
export function markLabel(app: string, repository: { owner: string; repo: string }, key?: string) {
  const id = `${repository.owner}/${repository.repo}#${key ?? ""}`.toLowerCase();
  return `${app}-${sha256Hex(id).slice(0, 8)}`;
}

/** The app's name: prod's plan names it (another environment's is `<name>-<env>`). */
async function appName(session: MoveSession): Promise<string> {
  const prod = session.environments.find((env) => env.environment === "prod")?.plan;
  return (prod ?? (await readArtifact("plan", session.paths.files.plan))).app.name;
}

/** The name of the app's mark in the zone: `_opscrew-move.<label>.<zone>`. */
export async function markName(session: MoveSession): Promise<string> {
  const label = markLabel(await appName(session), session.github, session.paths.app);
  return `${MARK_PREFIX}${label}.${session.zone}`;
}

/** The hostnames behind Cloudflare Access of an environment, in the zone that moves. */
function accessOf(env: MoveSession["environments"][number], zone: string): MoveMark["access"] {
  const plan: DeployPlan = { ...env.plan, dns: { ...env.plan.dns, zone } };
  const found: [MoveMark["access"][number]["kind"], string | undefined][] = [
    ["service", sshHostname(plan)],
    ["service", portainerWebhookHostname(plan)],
    ["portainer", portainerHostname(plan)],
    ["beszel", beszelHostname(plan)],
  ];
  return found.flatMap(([kind, hostname]) =>
    hostname === undefined ? [] : [{ hostname, kind, environment: env.environment }],
  );
}

/**
 * The app's mark: its covered environments, every name OpsCrew gives them, its sites' Workers and
 * its hostnames behind Cloudflare Access.
 */
export async function appMark(session: MoveSession): Promise<MoveMark> {
  const plans = session.environments.map((env) => env.plan);
  return MoveMarkSchema.parse({
    access: session.environments.flatMap((env) => accessOf(env, session.zone)),
    app: await appName(session),
    envs: session.environments.map((env) => env.environment),
    hosts: [...new Set(plans.flatMap((plan) => opscrewRecordNames(plan, session.zone)))].sort(),
    sites: plans.flatMap((plan) =>
      plan.target.provider === "cloudflare-workers"
        ? [
            {
              worker: plan.target.worker,
              domains: workerCustomDomainAddresses(plan).map((domain) => domain.hostname),
            },
          ]
        : [],
    ),
  });
}

/** TXT content as Cloudflare takes it: quoted strings of 255 characters at most. */
function quoted(text: string): string {
  const strings: string[] = [];
  for (let i = 0; i < text.length; i += TXT_STRING) strings.push(text.slice(i, i + TXT_STRING));
  return strings.map((one) => `"${one}"`).join(" ");
}

type Field = [string, string];

const contentOf = (fields: readonly Field[]) =>
  quoted(fields.map(([key, value]) => `${key}=${value}`).join("; "));

/**
 * The contents of the mark's TXT records: one, `opscrew-move=1; app=shop; envs=prod,staging;
 * hosts=…` (a site's `worker=…; domains=…` after its hosts), when it fits in 2,048 characters;
 * otherwise parts `part=1/3` … with the hosts split between them, the first holding the rest.
 */
export function markContents(mark: MoveMark): string[] {
  const app: Field = ["app", mark.app];
  const sites = mark.sites.flatMap((site): Field[] => [
    ["worker", site.worker],
    ["domains", site.domains.join(",")],
  ]);
  const access: Field[] =
    mark.access.length === 0
      ? []
      : [
          [
            "access",
            mark.access.map((one) => `${one.kind}:${one.environment}:${one.hostname}`).join(","),
          ],
        ];
  const head = (index: number): Field[] =>
    index === 0 ? [app, ["envs", mark.envs.join(",")]] : [app];
  const tail = (index: number): Field[] => (index === 0 ? [...sites, ...access] : []);
  const whole = contentOf([
    ["opscrew-move", VERSION],
    ...head(0),
    ["hosts", mark.hosts.join(",")],
    ...tail(0),
  ]);
  if (whole.length <= MAX_CONTENT) return [whole];
  const part = (index: number, of: string, hosts: readonly string[]) =>
    contentOf([
      ["opscrew-move", VERSION],
      ["part", of],
      ...head(index),
      ["hosts", hosts.join(",")],
      ...tail(index),
    ]);
  // Only the hostnames are split between parts: the first holds the rest whole.
  if (part(0, "999/999", []).length > MAX_CONTENT) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The mark of ${mark.app} can't hold its sites and its hostnames behind Cloudflare Access in one TXT record of 2,048 characters, so the move can't record the app as prepared.`,
      {
        hint: "Please report this to OpsCrew with the number of the app's environments and hostnames behind Access.",
      },
    );
  }
  const chunks: string[][] = [[]];
  for (const host of mark.hosts) {
    const index = chunks.length - 1;
    const current = chunks[index] as string[];
    // Sized with the longest part numbers, so the real ones fit too.
    if (part(index, "999/999", [...current, host]).length <= MAX_CONTENT) current.push(host);
    else chunks.push([host]);
  }
  return chunks.map((hosts, index) => part(index, `${index + 1}/${chunks.length}`, hosts));
}

/** One record's fields in order, or `undefined` when it is not a mark of this version. */
function fieldsOf(content: string): Field[] | undefined {
  const fields: Field[] = [];
  for (const item of unquoteTxt(content).split(";")) {
    const at = item.indexOf("=");
    if (at === -1) return undefined;
    fields.push([item.slice(0, at).trim(), item.slice(at + 1).trim()]);
  }
  return fields[0]?.[0] === "opscrew-move" && fields[0][1] === VERSION ? fields : undefined;
}

const listOf = (value: string) => (value === "" ? [] : value.split(","));

/** The mark its records' contents say, or `undefined` when one is damaged or a part is missing. */
function parseMark(contents: readonly string[]): MoveMark | undefined {
  const parts: { index: number; of: number; fields: Field[] }[] = [];
  for (const content of contents) {
    const fields = fieldsOf(content);
    if (fields === undefined) return undefined;
    const part = fields.find(([key]) => key === "part")?.[1] ?? "1/1";
    const numbers = /^(\d+)\/(\d+)$/.exec(part);
    if (numbers === null) return undefined;
    parts.push({ index: Number(numbers[1]), of: Number(numbers[2]), fields });
  }
  parts.sort((x, y) => x.index - y.index);
  if (!parts.every((part, i) => part.index === i + 1 && part.of === parts.length)) return undefined;
  const apps = new Set<string>();
  const envs: string[] = [];
  const hosts: string[] = [];
  const sites: { worker: string; domains: string[] }[] = [];
  const access: { kind: string; environment?: string; hostname?: string }[] = [];
  for (const { fields } of parts) {
    for (const [key, value] of fields) {
      if (key === "app") apps.add(value);
      else if (key === "envs") envs.push(...listOf(value));
      else if (key === "hosts") hosts.push(...listOf(value));
      else if (key === "worker") sites.push({ worker: value, domains: [] });
      else if (key === "domains") sites.at(-1)?.domains.push(...listOf(value));
      else if (key === "access") {
        for (const one of listOf(value)) {
          const [kind = "", environment, hostname, ...rest] = one.split(":");
          if (rest.length > 0) return undefined;
          access.push({ kind, environment, hostname });
        }
      }
    }
  }
  if (apps.size !== 1) return undefined;
  const parsed = MoveMarkSchema.safeParse({ app: [...apps][0], envs, hosts, sites, access });
  return parsed.success ? parsed.data : undefined;
}

/** The marks a zone's records hold, and the names of those that can't be read. */
export interface MarksRead {
  marks: ReadMark[];
  /** Marks with a damaged or missing part, by name. */
  damaged: string[];
}

/** The marks among a zone's records, by name; a damaged or incomplete one is named apart. */
export function parseMarks(records: readonly CloudflareZoneRecord[]): MarksRead {
  const byName = new Map<string, CloudflareZoneRecord[]>();
  for (const record of records) {
    if (record.type.toUpperCase() !== "TXT" || !record.name.startsWith(MARK_PREFIX)) continue;
    byName.set(record.name, [...(byName.get(record.name) ?? []), record]);
  }
  const read: MarksRead = { marks: [], damaged: [] };
  for (const [name, found] of [...byName].sort(([x], [y]) => x.localeCompare(y))) {
    const mark = parseMark(found.map((record) => record.content));
    if (mark === undefined) read.damaged.push(name);
    else read.marks.push({ name, ids: found.map((record) => record.id), mark });
  }
  return read;
}

/** Every mark in B's zone (none while B has no zone). Read-only. */
export async function readMarks(session: MoveSession): Promise<MarksRead> {
  const { b } = session.accounts;
  if (b.zone === undefined) return { marks: [], damaged: [] };
  return parseMarks(await b.client.listZoneRecords(b.zone.id));
}

/** The TXT records of the app's mark in B's zone (`name`), damaged ones too. */
async function ownMarkRecords(session: MoveSession, name: string): Promise<CloudflareZoneRecord[]> {
  const { b } = session.accounts;
  if (b.zone === undefined) return [];
  const records = await b.client.listZoneRecords(b.zone.id);
  return records.filter((record) => record.type.toUpperCase() === "TXT" && record.name === name);
}

/**
 * Writes the app's mark into B's zone through one zone plan (`planZone`, `applyZone`): its records
 * not there yet created, the app's records there that it no longer has deleted; nothing when the
 * mark there says it already. A run that doesn't apply the plan now stops with it.
 */
export async function writeMark(session: MoveSession): Promise<StepStop | undefined> {
  const name = await markName(session);
  const contents = markContents(await appMark(session));
  const existing = await ownMarkRecords(session, name);
  const have = new Set(existing.map((record) => unquoteTxt(record.content)));
  const want = new Set(contents.map(unquoteTxt));
  const marks = {
    name,
    create: contents.filter((content) => !have.has(unquoteTxt(content))),
    delete: existing.filter((record) => !want.has(unquoteTxt(record.content))).map((r) => r.id),
  };
  if (marks.create.length === 0 && marks.delete.length === 0) return undefined;
  return applyZone(session, await planZone(session, { marks }));
}

/**
 * Deletes the app's mark from B's zone through a zone plan of its own (each app's finish and abort
 * delete their own); other apps' marks stay. A run that doesn't apply the plan now stops with it.
 */
export async function deleteMark(session: MoveSession): Promise<StepStop | undefined> {
  const name = await markName(session);
  const existing = await ownMarkRecords(session, name);
  if (existing.length === 0) return undefined;
  const marks = { name, create: [], delete: existing.map((record) => record.id) };
  return applyZone(session, await planZone(session, { marks }));
}

/** GitHub's domain verification record of a Pages site: `_github-pages-challenge-<owner>.<domain>`. */
const PAGES_CHALLENGE = /^_github-pages-challenge-[^.]+\.(.+)$/;

/** What the switch's coverage check found. */
export interface MoveCoverage {
  /** OpsCrew's names in A's zone that no mark holds, sorted. */
  uncovered: string[];
  /** The marks in B's zone that can be read. */
  marks: ReadMark[];
  /** What could not be read, in words: what A's token may not read, and damaged marks. */
  unread: string[];
}

/**
 * The switch's coverage, read-only: OpsCrew's names in A's zone (its records with OpsCrew's comment,
 * the hostnames in OpsCrew's rules, the account's Workers custom domains in the zone) against every
 * mark's `hosts`. A Pages site's verification record counts as the site's, by its domain.
 */
export async function coverage(session: MoveSession): Promise<MoveCoverage> {
  const { a } = session.accounts;
  const records = (await a.client.listDnsRecords(a.zoneId)).filter(
    (record) => record.comment?.trim() === OPSCREW_MANAGED_COMMENT,
  );
  const facts = await inspectShared(a.client, {
    zoneId: a.zoneId,
    accountId: a.accountId,
    access: false,
    redirect: true,
  });
  const unread: string[] = [];
  if ((facts.deniedPhases ?? []).length > 0) {
    unread.push(
      `the hostnames in OpsCrew's rules of the phases ${listText(facts.deniedPhases ?? [])}, which ${A_TOKEN_VAR} may not read`,
    );
  }
  const workers = (await a.client.workersPermissions(a.accountId)).missing.length === 0;
  const domains = workers
    ? (await a.client.listZoneWorkerDomains(a.accountId, a.zoneId)).map((domain) => domain.hostname)
    : [];
  if (!workers) {
    unread.push(
      `the zone's Workers custom domains, since ${A_TOKEN_VAR} may not read the account's Workers`,
    );
  }
  const { marks, damaged } = await readMarks(session);
  unread.push(...damaged.map((name) => `the mark ${name}, which can't be read`));
  const hosts = new Set(marks.flatMap((read) => read.mark.hosts));
  const covered = (name: string, type = "") => {
    const site = type.toUpperCase() === "TXT" ? PAGES_CHALLENGE.exec(name)?.[1] : undefined;
    return hosts.has(name) || (site !== undefined && hosts.has(site));
  };
  const uncovered = [
    ...records.filter((record) => !covered(record.name, record.type)).map((record) => record.name),
    ...[...sharedRuleHostnames(facts), ...domains].filter((name) => !covered(name)),
  ];
  return { uncovered: [...new Set(uncovered)].sort(), marks, unread };
}
