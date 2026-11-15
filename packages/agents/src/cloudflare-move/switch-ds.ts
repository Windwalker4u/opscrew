/**
 * The switch's DNSSEC gate (plan 5.4, FR-2808): the nameservers move to the new account only once
 * the registry no longer publishes a DS record for the zone and resolvers have had time to forget
 * it. Switching while they hold the old one takes the zone offline for every visitor whose
 * resolver checks DNSSEC. At Porkbun, Namecheap and GoDaddy the wait is `domain connect`'s note
 * (`removeDsAndWait`, `dsWaitStatus`); at Cloudflare Registrar and any other registrar, where the
 * user turns DNSSEC off by hand, a note of the switch's own of the same shape. Both notes are
 * machine-local, beside the switch file, and hold no secret.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { OpsCrewError, type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { IsoDateTimeSchema } from "@opscrew/plan-schema";
import { z } from "zod";
import {
  type DomainRegistrar,
  type DsReading,
  dsWaitStatus,
  readDs,
  removeDsAndWait,
} from "../domain";
import { seenState, stillPublishedState, waitFor } from "../domain/connect-ds";
import {
  type ConnectState,
  dsWaitSeconds,
  laterSwitch,
  REMOVAL_MARGIN_SECONDS,
  readConnectState,
  writeConnectState,
} from "../domain/connect-state";
import { formatTime } from "../domain/purchase";
import { REGISTRAR_NAMES, registrarLinks } from "../domain/registrars";
import { domainZonesFrom } from "../domain/services";
import { dsRecordText } from "../domain/switch";
import { readRecord } from "../shared/records";
import { accountName, moveAudit } from "./texts";
import type { MoveSession, MoveZone, StepStop } from "./types";

/** A registrar OpsCrew drives through its API. */
export type ApiRegistrar = Extract<DomainRegistrar, { kind: "api" }>;

/** `domain connect`'s note of the DS wait, for a registrar with an API. */
function connectNoteFile(paths: Pick<ProjectPaths, "root">): string {
  return join(paths.root, ".opscrew", "cloudflare-move-switch-ds.json");
}

/** The switch's own note of the DS wait, for Cloudflare Registrar and any other registrar. */
function ownNoteFile(paths: Pick<ProjectPaths, "root">): string {
  return join(paths.root, ".opscrew", "cloudflare-move-switch-ds-wait.json");
}

const OwnNoteSchema = z.strictObject({
  zone: z.string().min(1),
  /** When a run first saw the DS record published; set until a run sees it gone. */
  dsSeen: IsoDateTimeSchema.optional(),
  /** The earliest time the nameservers may switch; only ever moves later. */
  switchAfter: IsoDateTimeSchema.optional(),
  /** The wait (seconds) for the DS record's TTL (`dsWaitSeconds`). */
  waitSeconds: z.number().int().positive(),
});
type OwnNote = z.infer<typeof OwnNoteSchema>;

/** The switch's own note; an unreadable one stops, as `domain connect`'s does. */
function readOwnNote(file: string): Promise<OwnNote | undefined> {
  return readRecord(
    file,
    OwnNoteSchema,
    () =>
      new OpsCrewError(
        "PHASE_PRECONDITION",
        `OpsCrew cannot read its note about the DNSSEC record of the zone (${file}), so it cannot tell when the DS record was removed. Nothing was changed.`,
        {
          hint: "If the DS record was removed in the last 48 hours, wait until 48 hours have passed. Then delete that file and run the command again.",
        },
      ),
  );
}

/** What the DS records allow before the switch. */
export type DsGate =
  /** No DS record, and no wait. */
  | { kind: "clear" }
  /** The registrar's API lists DS records it can remove: the switch plan removes them. */
  | { kind: "remove"; ds: DsReading; registrar: ApiRegistrar }
  /** A DS record to remove by hand, or the wait after one: stops before any change. */
  | { kind: "stop"; stop: StepStop };

/** The stop: the warning shown and what to do next. */
function stopped(session: MoveSession, warning: string, next: string[]): DsGate {
  session.deps.reporter.warn(warning);
  return { kind: "stop", stop: { next } };
}

/** The wait until `switchAfter`, said once the DS record is gone. */
function waiting(session: MoveSession, switchAfter: string): DsGate {
  const { zone, command } = session;
  const until = formatTime(switchAfter);
  return stopped(
    session,
    `OpsCrew waits before it switches the nameservers of ${zone}: resolvers may remember its old DNSSEC (DS) record until about ${until}, and switching earlier could take ${zone} offline for visitors whose resolver checks DNSSEC. Nothing was changed.`,
    [
      `Run \`${command}\` again after ${until}; it plans the switch again and asks before changing anything. Until then ${zone} keeps working from the account it is in now.`,
    ],
  );
}

/**
 * The DS gate before the switch, read fresh (`readDs`: the registrar's API, when OpsCrew drives
 * it, and the registry's own answer, or the public DNS when the registry cannot be read): `clear`,
 * `remove` (the API lists DS records it can remove), or a stop before any change. `dsAtStart` (the
 * registry published one when the move started) makes a first look that finds none wait as after
 * a removal, since nothing says when it went; it and a note ask the registry even while nothing
 * is listed or shown.
 */
export async function dsGate(
  session: MoveSession,
  registrar: DomainRegistrar,
  dsAtStart: boolean,
): Promise<DsGate> {
  const api = registrar.kind === "api" ? registrar : undefined;
  if (api !== undefined) {
    const state = await readConnectState(connectNoteFile(session.paths));
    const ds = await readPublished(session, registrar, dsAtStart || state !== undefined);
    return apiGate(session, api, ds, dsAtStart, state);
  }
  const note = await readOwnNote(ownNoteFile(session.paths));
  const ds = await readPublished(session, registrar, dsAtStart || note !== undefined);
  return ownGate(session, registrar.kind === "cloudflare", ds, dsAtStart, note);
}

/**
 * The DS records published now: the registrar's API, when OpsCrew drives it, and the registry's
 * own answer or the public DNS (`readDs`; `seenBefore`: a note or `dsAtStart`).
 */
export function readPublished(
  session: MoveSession,
  registrar: DomainRegistrar,
  seenBefore = false,
): Promise<DsReading> {
  const { deps, services, zone } = session;
  return readDs(
    {
      deps: { ...deps, fetch: services.fetch ?? deps.fetch },
      domain: zone,
      ...(registrar.kind === "api" ? { registrar: registrar.registrar } : {}),
    },
    seenBefore,
  );
}

/**
 * Once the nameservers point at B without the switch's approval: warns when the registry still
 * publishes a DS record of the zone (the old account's), since nothing waits for it any more.
 */
export async function warnPublishedDs(
  session: MoveSession,
  registrar: DomainRegistrar,
): Promise<void> {
  const ds = await readPublished(session, registrar);
  if (ds.records.length === 0) return;
  const { zone } = session;
  session.deps.reporter.warn(
    `The nameservers of ${zone} point at the new account, but the registry still publishes a DNSSEC (DS) record of ${zone} (${ds.records.map(dsRecordText).join("; ")}): visitors whose resolver checks DNSSEC may not reach ${zone} until it is removed. Remove it at the registrar that holds ${zone}, or turn DNSSEC off in the old account's dashboard when the zone is registered at Cloudflare.`,
  );
}

/** The gate at Porkbun, Namecheap or GoDaddy, on `domain connect`'s note. */
async function apiGate(
  session: MoveSession,
  api: ApiRegistrar,
  ds: DsReading,
  dsAtStart: boolean,
  state: ConnectState | undefined,
): Promise<DsGate> {
  const { deps, zone, command } = session;
  const file = connectNoteFile(session.paths);
  const ctx = { deps, domain: zone, registrarId: api.registrarId };
  const name = REGISTRAR_NAMES[api.registrarId];
  if (ds.records.length > 0) {
    const listed = ds.api ?? [];
    const removable = api.registrar.capabilities.dnssec && api.registrar.removeDsRecord;
    if (listed.length > 0 && removable) return { kind: "remove", ds, registrar: api };
    if (state !== undefined && state.dsSeen === undefined) {
      // Removed through the API earlier, and still published: the wait starts once they are gone.
      const still = stillPublishedState(state, ds);
      await writeConnectState(file, still.state);
      return waiting(session, still.switchAfter);
    }
    await writeConnectState(file, seenState({ ...ctx, state }, session.accounts.b.zone?.id, ds));
    const link = registrarLinks(api.registrarId, deps.env).domains;
    return stopped(
      session,
      `${zone} has DNSSEC (DS) records at ${name}, which ${name}'s API cannot remove. Switching the nameservers while they are published would take ${zone} offline for visitors whose resolver checks DNSSEC. Nothing was changed.`,
      [
        `Remove the DS records of ${zone} in ${name}'s dashboard (${link}): ${ds.records.map(dsRecordText).join("; ")}. Then run \`${command}\` again: it notes when they are gone and says when the switch can go on.`,
      ],
    );
  }
  // Neither the API nor the registry (or the public DNS) shows a DS record now, as `dsWaitStatus`
  // expects.
  const now = deps.clock.now();
  let status = await dsWaitStatus(file, now, ds);
  if (status === undefined && (dsAtStart || ds.shown.length > 0)) {
    // Gone before the switch ever saw it (or only a resolver's copy is left): resolvers may hold
    // it for the whole wait from now on.
    await writeConnectState(file, seenState({ ...ctx, state: undefined }, undefined, ds));
    status = await dsWaitStatus(file, now, ds);
  }
  if (status?.waiting && status.switchAfter !== undefined) {
    return waiting(session, status.switchAfter);
  }
  return { kind: "clear" };
}

/**
 * The gate at Cloudflare Registrar (`cloudflare`: the user turns DNSSEC off in the old account's
 * dashboard; while A's zone's DNSSEC is `active` or `pending` the registry publishes, or is about
 * to publish, its DS record, and `pending-disabled` counts as gone once the public DNS shows none)
 * and at any other registrar: while a DS record is published, the run notes it and stops; the
 * first run that sees it gone waits the noted wait (`dsWaitSeconds`) from its reading when the
 * registry answered that it publishes none, else plus `REMOVAL_MARGIN_SECONDS` from then.
 */
async function ownGate(
  session: MoveSession,
  cloudflare: boolean,
  ds: DsReading,
  dsAtStart: boolean,
  note: OwnNote | undefined,
): Promise<DsGate> {
  const { deps, zone, command } = session;
  const { a } = session.accounts;
  const file = ownNoteFile(session.paths);
  const now = deps.clock.now();
  const on = cloudflare && (await domainZonesFrom(a.client).dnssecEnabled(a.zoneId)) === true;
  const aName = accountName(a);
  if (ds.records.length > 0 || on) {
    const waitSeconds = waitFor(note, ds);
    await writeNote(file, { zone, dsSeen: note?.dsSeen ?? now.toISOString(), waitSeconds });
    const records = ds.records.length > 0 ? `: ${ds.records.map(dsRecordText).join("; ")}` : "";
    const margin = ds.registry.kind === "unreadable" ? REMOVAL_MARGIN_SECONDS : 0;
    const hours = Math.round((waitSeconds + margin) / 3600);
    const after = `Then run \`${command}\` again: once the registry no longer publishes the DS record, it says when the switch can go on (about ${hours} hours later, once resolvers have forgotten it).`;
    if (on) {
      return stopped(
        session,
        `DNSSEC is on for ${zone} in the account ${aName}, so the registry publishes its DS record${records}. Switching the nameservers now would take ${zone} offline for visitors whose resolver checks DNSSEC. Nothing was changed.`,
        [
          `Turn DNSSEC off for ${zone} in the account ${aName}'s dashboard (https://dash.cloudflare.com: ${zone}, DNS, Settings, DNSSEC, Disable DNSSEC). ${after}`,
        ],
      );
    }
    return stopped(
      session,
      cloudflare
        ? `DNSSEC is being turned off for ${zone} in the account ${aName}, and the registry still publishes its DS record${records}. Nothing was changed.`
        : `The registry still publishes a DNSSEC (DS) record of ${zone}${records}. Switching the nameservers while it is published would take ${zone} offline for visitors whose resolver checks DNSSEC. Nothing was changed.`,
      [
        cloudflare
          ? `Cloudflare removes the DS record from the registry on its own, usually within a day. ${after}`
          : `Remove the DS record at the registrar that holds ${zone} (turn DNSSEC off there). ${after}`,
      ],
    );
  }
  // A resolver's copy the registry no longer publishes, with no note: gone as of this reading.
  if (note === undefined && !dsAtStart && ds.shown.length === 0) return { kind: "clear" };
  let switchAfter = note?.switchAfter;
  if (switchAfter === undefined || note?.dsSeen !== undefined) {
    const waitSeconds = note?.waitSeconds ?? dsWaitSeconds(undefined);
    // The registry publishes none as of this reading: every cached copy is gone within the wait.
    const at =
      ds.registry.kind === "none"
        ? ds.at.getTime() + waitSeconds * 1000
        : now.getTime() + (waitSeconds + REMOVAL_MARGIN_SECONDS) * 1000;
    switchAfter = laterSwitch(note, at);
    await writeNote(file, { zone, switchAfter, waitSeconds });
  }
  if (now.getTime() < Date.parse(switchAfter)) return waiting(session, switchAfter);
  return { kind: "clear" };
}

async function writeNote(file: string, note: OwnNote): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(OwnNoteSchema.parse(note), null, 2)}\n`);
}

/**
 * Removes the DS records the reading `gate.ds` showed through the registrar's API (after the
 * switch plan's approval, before switching to `bZone`), notes the switch time and stops until then: the next run after it plans
 * the switch again and asks again.
 */
export async function removeDs(
  session: MoveSession,
  gate: Extract<DsGate, { kind: "remove" }>,
  bZone: MoveZone,
): Promise<StepStop> {
  const { deps, zone, command } = session;
  const file = connectNoteFile(session.paths);
  const { registrarId, registrar } = gate.registrar;
  const { switchAfter } = await removeDsAndWait(
    {
      deps,
      domain: zone,
      registrarId,
      registrar,
      state: await readConnectState(file),
      ds: gate.ds,
      zoneId: bZone.id,
    },
    file,
  );
  await moveAudit(deps, {
    kind: "provider-call",
    action: "DS removed",
    target: zone,
    detail: `${REGISTRAR_NAMES[registrarId]}: ${gate.ds.records.length} DS record(s); switch after ${switchAfter}`,
  });
  const until = formatTime(switchAfter);
  deps.reporter.success(
    `Removed the DNSSEC (DS) records of ${zone} at ${REGISTRAR_NAMES[registrarId]}.`,
  );
  deps.reporter.warn(
    `The nameservers of ${zone} are not switched yet: resolvers may remember the old DNSSEC records until about ${until}, and switching earlier could take ${zone} offline.`,
  );
  return {
    next: [
      `Run \`${command}\` again after ${until}; it plans the switch again and asks before changing anything. Until then ${zone} keeps working from the account it is in now, without DNSSEC.`,
    ],
  };
}

/** Deletes both DS notes once the nameservers point at the new account. */
export async function clearDsNotes(paths: Pick<ProjectPaths, "root">): Promise<void> {
  await rm(connectNoteFile(paths), { force: true });
  await rm(ownNoteFile(paths), { force: true });
}
