/**
 * The switch's registrar (plan 5.3, 5.6, 5.8; research R3): where the zone is registered, the
 * delegation it has now, B's nameservers set there (Porkbun, Namecheap, GoDaddy), or what the user
 * does (Cloudflare Registrar's move between accounts, another registrar's nameservers), and
 * DNSSEC turned on in B once it is active.
 */
import { CloudflareError, CloudflareRegistrar } from "@opscrew/connector-cloudflare";
import type { Registrar } from "@opscrew/contracts";
import { listText } from "@opscrew/core";
import {
  type DomainRegistrar,
  domainZonesFrom,
  findDomainRegistrar,
  publicNameservers,
} from "../domain";
import { REGISTRAR_NAMES, registrarLinks } from "../domain/registrars";
import { resolveDomainServices } from "../domain/services";
import { dsRecordText, hosts, pointToZone, publishDs, type SwitchContext } from "../domain/switch";
import type { MoveSession, MoveZone, StepStop } from "./types";

/** The registrar in words: `Porkbun`, `Cloudflare Registrar`, `the registrar that holds it`. */
export function registrarWords(registrar: DomainRegistrar): string {
  if (registrar.kind === "api") return REGISTRAR_NAMES[registrar.registrarId];
  return registrar.kind === "cloudflare" ? "Cloudflare Registrar" : "the registrar that holds it";
}

/** The registrar's id in the switch plan: `porkbun` …, `cloudflare` or `other`. */
export function registrarId(registrar: DomainRegistrar): string {
  return registrar.kind === "api" ? registrar.registrarId : registrar.kind;
}

/** The registrar lookup: the configured registrars, Cloudflare Registrar read with each account's token. */
function lookupServices(session: MoveSession) {
  const { a, b } = session.accounts;
  const given = session.services.registrars ?? {};
  return resolveDomainServices(session.deps, {
    ...given,
    registrar:
      given.registrar ??
      ((id) => new CloudflareRegistrar(id === b.accountId ? b.client : a.client, id)),
  });
}

/**
 * Where the zone is registered (`findDomainRegistrar`): a configured Porkbun, Namecheap or GoDaddy
 * account that holds it; else Cloudflare Registrar in A; else another registrar. When A's token
 * may not read Cloudflare Registrar (HTTP 403), Cloudflare's record of the registrar on B's zone
 * (`originalRegistrar`) tells it: Cloudflare Registrar when it names Cloudflare, else another.
 */
export function findSwitchRegistrar(session: MoveSession): Promise<DomainRegistrar> {
  const services = lookupServices(session);
  const { a } = session.accounts;
  return findDomainRegistrar(
    session.deps,
    {
      ...services,
      registrar: (id) =>
        id === a.accountId
          ? fromRecordWhenRefused(session, services.registrar(id))
          : services.registrar(id),
    },
    session.zone,
    a.accountId,
  );
}

/** `registrar` with a `getDomain` that answers from B's zone's record on a permission refusal. */
function fromRecordWhenRefused(session: MoveSession, registrar: Registrar): Registrar {
  const getDomain = async (domain: string) => {
    try {
      return await registrar.getDomain(domain);
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
      const record = session.accounts.b.zone?.originalRegistrar;
      const cloudflare = record !== undefined && /cloudflare/i.test(record);
      const aName = session.accounts.a.name ?? session.accounts.a.accountId;
      session.deps.reporter.info(
        `The token of the account ${aName} can't read Cloudflare Registrar, so OpsCrew told the registrar of ${domain} from Cloudflare's record on the new account's zone: ${cloudflare ? "Cloudflare Registrar" : "another registrar"}. To have OpsCrew read it instead, give that token the Registrar permission.`,
      );
      return cloudflare
        ? { domain, registrar: "cloudflare" as const, autoRenew: false }
        : undefined;
    }
  };
  return new Proxy(registrar, {
    get: (target, key) => {
      if (key === "getDomain") return getDomain;
      const value: unknown = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * The registrar once the nameservers point at B: Cloudflare Registrar when its move between
 * accounts took the registration to B (read with B's token), else `registrar` (also when B's
 * token may not read Cloudflare Registrar).
 */
export async function registrarAfterSwitch(
  session: MoveSession,
  registrar: DomainRegistrar,
): Promise<DomainRegistrar> {
  if (registrar.kind !== "other") return registrar;
  try {
    const held = await lookupServices(session)
      .registrar(session.accounts.b.accountId)
      .getDomain(session.zone);
    return held === undefined ? registrar : { kind: "cloudflare" };
  } catch (error) {
    // B's token without the Registrar permission: another registrar, read from the public DNS.
    if (error instanceof CloudflareError) return registrar;
    throw error;
  }
}

/**
 * The zone's nameservers now: the registrar's API when it reads them, else the public DNS
 * (`publicNameservers`); lower case, without a trailing dot.
 */
export async function currentNameservers(
  session: MoveSession,
  registrar: DomainRegistrar,
): Promise<string[]> {
  const api = registrar.kind === "api" ? registrar.registrar : undefined;
  if (api?.getNameservers !== undefined)
    return hosts(await api.getNameservers(session.zone)).sort();
  return publicNameservers(session.services.fetch ?? session.deps.fetch, session.zone);
}

/** `pointToZone`'s and `publishDs`'s context for B's zone at an API registrar. */
function switchContext(
  session: MoveSession,
  registrar: Extract<DomainRegistrar, { kind: "api" }>,
): SwitchContext {
  const { b } = session.accounts;
  return {
    deps: session.deps,
    account: { id: b.accountId, name: b.name ?? b.accountId },
    zones: domainZonesFrom(b.client),
    domain: session.zone,
    registrarId: registrar.registrarId,
    registrar: registrar.registrar,
  };
}

/** What changing the nameservers did: set through the registrar's API, or left to the user. */
export type NameserverChange = { set: true } | { set: false; stop: StepStop };

/**
 * B's nameservers for the zone: set at Porkbun, Namecheap or GoDaddy (`pointToZone`, audited
 * under the move); at Cloudflare Registrar the dashboard steps of its move between accounts; at
 * another registrar the nameservers to set. Either of the last two stops: a later run finds the
 * delegation and goes on.
 */
export async function pointAtB(
  session: MoveSession,
  registrar: DomainRegistrar,
  zone: MoveZone,
  before: readonly string[],
): Promise<NameserverChange> {
  const { deps, command } = session;
  const { a, b } = session.accounts;
  const after = hosts(zone.nameServers);
  const again = `Then run \`${command}\` again: it finds the new nameservers, waits until the new account's zone is active and its certificate issued, and finishes the switch.`;
  if (registrar.kind === "api") {
    const done = await pointToZone(switchContext(session, registrar), zone);
    if (done.outcome !== "manual") {
      await deps.audit.append({
        kind: "provider-call",
        actor: "opscrew",
        action: "set nameservers",
        phase: "cloudflare-move",
        target: session.zone,
        detail: `${REGISTRAR_NAMES[registrar.registrarId]}: ${after.join(", ")}; before: ${before.join(", ") || "none"}`,
      });
      return { set: true };
    }
    return { set: false, stop: { next: [again] } };
  }
  const bName = b.name ?? b.accountId;
  const aName = a.name ?? a.accountId;
  if (registrar.kind === "cloudflare") {
    deps.reporter.warn(
      `${session.zone} is registered at Cloudflare Registrar, whose move between accounts is done in the dashboard, so OpsCrew does not change its nameservers itself.`,
    );
    return {
      set: false,
      stop: {
        next: [
          `In the account ${aName}'s dashboard (https://dash.cloudflare.com): Domain Registration, Manage Domains, ${session.zone}, Configuration, and start its move to the account ${bName} (${b.accountId}).`,
          `In the account ${bName}'s dashboard, accept the move within five days (Domain Registration, Manage Domains). Cloudflare then gives ${session.zone} the new account's nameservers (${listText(after)}), and the registration's settings in the old account are not kept.`,
          again,
        ],
      },
    };
  }
  deps.reporter.warn(
    `OpsCrew can't change the nameservers of ${session.zone} at the registrar that holds it, so set them yourself.`,
  );
  return {
    set: false,
    stop: {
      next: [
        `At the registrar that holds ${session.zone}, set its nameservers to ${listText(after)} (now ${listText([...before]) || "none"}).`,
        again,
      ],
    },
  };
}

/**
 * DNSSEC on in B's active zone, when the registry published a DS record at the move's start
 * (FR-2809): at Porkbun its DS record published through the API (`publishDs`), at Namecheap or
 * GoDaddy and at another registrar the values to add there; Cloudflare Registrar publishes it
 * itself. Returns what is left for the user to do. Skipped when DNSSEC is on and published.
 */
export async function dnssecInB(
  session: MoveSession,
  registrar: DomainRegistrar,
  zone: MoveZone,
): Promise<string[]> {
  const { deps } = session;
  const where = registrarWords(registrar);
  if (registrar.kind === "api") {
    const ctx = switchContext(session, registrar);
    const done = await publishDs(ctx, zone);
    // `publishDs` audits its own writes; the move notes only the DS record it published.
    if (done.outcome === "added") await auditDnssec(session, where);
    const link = registrarLinks(registrar.registrarId, deps.env).domains;
    if (done.outcome === "manual" && done.ds !== undefined) {
      return [
        `Add this DS record for ${session.zone} at ${link} to turn DNSSEC on: ${dsRecordText(done.ds)}.`,
      ];
    }
    if (done.outcome === "pending") {
      return [
        `Run \`${session.command}\` again in a few minutes to publish the DS record of ${session.zone}.`,
      ];
    }
    return [];
  }
  const zones = domainZonesFrom(session.accounts.b.client);
  if ((await zones.dnssecEnabled(zone.id)) !== true) {
    await zones.enableDnssec(zone.id);
    await auditDnssec(session, where);
  }
  if (registrar.kind === "cloudflare") return [];
  const ds = await zones.dsRecord(zone.id);
  return ds === undefined
    ? [`Run \`${session.command}\` again in a few minutes for the DS record of ${session.zone}.`]
    : [
        `Add this DS record for ${session.zone} at the registrar that holds it to turn DNSSEC on: ${dsRecordText(ds)}.`,
      ];
}

async function auditDnssec(session: MoveSession, where: string): Promise<void> {
  await session.deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "DNSSEC on (B)",
    phase: "cloudflare-move",
    target: session.zone,
    detail: `zone ${session.accounts.b.zone?.id ?? ""} in the account ${session.accounts.b.accountId} (domain at ${where})`,
  });
}
