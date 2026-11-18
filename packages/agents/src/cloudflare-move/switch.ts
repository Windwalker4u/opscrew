/**
 * The switch (`opscrew cloudflare move --switch`, plan 5.): the zone's nameservers moved to the
 * new account once every OpsCrew app in the old account's zone is prepared there, then the HTTPS
 * gap measured, with the new account's Access applications, protected records, sites' custom
 * domains and DNSSEC made right after its zone is active. Every step reads what is there before it
 * acts, so a run after any interruption (or from another repository of the zone, once the
 * nameservers point at the new account) goes on from where the switch got to. The marks stay:
 * each app's own finish deletes its mark.
 */
import { CloudflareError } from "@opscrew/connector-cloudflare";
import { listText, OpsCrewError, plural } from "@opscrew/core";
import type { CloudflareMove } from "@opscrew/plan-schema";
import type { PhaseDeps } from "../context";
import { hosts, sameHosts } from "../domain/switch";
import { appliesNow } from "../retarget/steps";
import { PlanRefusedError } from "../shared";
import { gapText, measureGap } from "./gap";
import { coverage, markName, parseMarks, type ReadMark } from "./marks";
import {
  clearSwitchProgress,
  readSwitchProgress,
  type SwitchProgress,
  writeSwitchProgress,
} from "./progress";
import { openMoveSession } from "./session";
import { pendingStop } from "./shared";
import { protectInB } from "./switch-access";
import { waitForActive } from "./switch-activation";
import { clearDsNotes, type DsGate, dsGate, removeDs, warnPublishedDs } from "./switch-ds";
import { planSwitch, type SwitchPlan } from "./switch-plan";
import {
  currentNameservers,
  dnssecInB,
  findSwitchRegistrar,
  pointAtB,
  registrarAfterSwitch,
} from "./switch-registrar";
import { attachSites } from "./switch-sites";
import {
  A_TOKEN_VAR,
  accountName,
  accountWords,
  FINISH_COMMAND,
  MOVE_COMMAND,
  moveAudit,
  refusal,
  SWITCH_COMMAND,
} from "./texts";
import type { MoveResult, MoveSession, MoveZone, StepStop, SwitchMoveOptions } from "./types";
import {
  aNameserversClash,
  type ListedRecords,
  recordInput,
  updaterCreates,
  writeUpdaterCopies,
} from "./zone";

/**
 * `opscrew cloudflare move --switch`: refused before any change unless this repository's app is
 * prepared and every OpsCrew name in A's zone is in some mark; then plan 5.'s steps in order,
 * each checked before it acts. Stops on purpose (`done: false`, `next` says what to do) for the
 * plan's approval in a run nobody can answer, a DS record and its wait, a nameserver change the
 * user makes, B's zone still pending after the wait for its activation, and the gap's two-hour
 * limit. Nameservers found at B without this repository's approval (changed by hand) get a plan
 * and an approval of their own before anything is written, except in another repository's run
 * once B's zone is active (no switch file here at all).
 */
export async function switchMove(
  deps: PhaseDeps,
  options: SwitchMoveOptions = {},
): Promise<MoveResult> {
  const session = await openMoveSession(deps, { ...options, command: SWITCH_COMMAND });
  const move = requirePrepared(session);
  const registrar = await findSwitchRegistrar(session);
  const found = await readSwitchProgress(session.paths);
  let progress = found?.zone === session.zone ? found : undefined;
  const read = await readDelegation(session, move, registrar, progress);
  const elsewhere = progress === undefined && read.zone.status === "active";
  if (!read.switched || (progress?.approved === undefined && !elsewhere)) {
    const planned = await beforeSwitch(session, move, registrar, read, progress);
    if ("stop" in planned) return { step: move.step, done: false, ...planned.stop };
    progress = planned.progress;
  }
  return afterSwitch(session, move, { registrar, zone: read.zone, progress });
}

/** The move's record, once this repository's app is prepared for it; refused otherwise. */
function requirePrepared(session: MoveSession): CloudflareMove {
  const { zone } = session;
  const records = session.environments.map((env) => env.plan.cloudflareMove);
  const move = records.find((record) => record !== undefined);
  if (move === undefined || move.zone !== zone) {
    throw refusal(
      `${zone} is not moving to another Cloudflare account from this repository.`,
      `Start the move with \`${MOVE_COMMAND} --to <account>\`, then run \`${SWITCH_COMMAND}\` once it is prepared.`,
    );
  }
  if (move.abort !== undefined) {
    throw refusal(
      `The move of ${zone} is being aborted.`,
      `Run \`${MOVE_COMMAND} --abort\` to the end; start the move again after that.`,
    );
  }
  if (records.some((record) => record?.step === undefined || record.step === "started")) {
    throw refusal(
      `The app is not prepared in the new Cloudflare account yet, so ${zone} can't switch.`,
      `Run \`${MOVE_COMMAND}\` to the end first, then run \`${SWITCH_COMMAND}\`.`,
    );
  }
  if (move.to.zoneId === undefined || session.accounts.b.zone === undefined) {
    throw refusal(
      `The new Cloudflare account has no zone for ${zone} yet.`,
      `Run \`${MOVE_COMMAND}\` to the end first, then run \`${SWITCH_COMMAND}\`.`,
    );
  }
  return move;
}

type Registrar = Awaited<ReturnType<typeof findSwitchRegistrar>>;

/** B's zone and the delegation, read now. */
interface Delegation {
  zone: MoveZone;
  /** The zone's nameservers now (B's once it points at B). */
  before: string[];
  /** The nameservers point at B (or B's zone is active). */
  switched: boolean;
}

/**
 * B's zone (read again) and where the zone points: at B once B's zone is active, the switch file
 * holds the nameserver change, or the registry, the registrar's API or the public DNS names B's
 * nameservers (`currentNameservers`). While B's zone is not active, refused before any change when
 * B's nameservers are A's.
 */
async function readDelegation(
  session: MoveSession,
  move: CloudflareMove,
  registrar: Registrar,
  progress: SwitchProgress | undefined,
): Promise<Delegation> {
  const { b } = session.accounts;
  const zone = await b.client.getZone(move.to.zoneId as string);
  b.zone = zone;
  const at = hosts(zone.nameServers);
  if (zone.status === "active") return { zone, before: at, switched: true };
  const clash = aNameserversClash(session, zone);
  if (clash !== undefined) throw refusal(...clash);
  if (progress?.nameserversSetAt !== undefined) return { zone, before: at, switched: true };
  const before = await currentNameservers(session, registrar);
  return { zone, before, switched: sameHosts(before, hosts(zone.nameServers)) };
}

/** The switch plan from a reading, or a stop before any change (the DS gate's). */
type Planned =
  | { plan: SwitchPlan; gate: Exclude<DsGate, { kind: "stop" }>; read: Delegation }
  | { stop: StepStop };

/**
 * The coverage, the DS gate (none once the nameservers point at B: nothing waits for a DS record
 * then) and the switch plan from `read`.
 */
async function planFrom(
  session: MoveSession,
  move: CloudflareMove,
  registrar: Registrar,
  read: Delegation,
): Promise<Planned> {
  const { a } = session.accounts;
  // Each zone listed once for the coverage and the zone copy; a second planning reads them anew.
  const listed = {
    a: await a.client.listZoneRecords(a.zoneId),
    b: await session.accounts.b.client.listZoneRecords(read.zone.id),
  };
  const marks = await requireCoverage(session, listed);
  const gate: DsGate = read.switched
    ? { kind: "clear" }
    : await dsGate(session, registrar, move.dsAtStart);
  if (gate.kind === "stop") return { stop: gate.stop };
  const { zone, before } = read;
  const input = { registrar, zone, before, gate, marks, dnssec: move.dsAtStart, listed };
  return { plan: await planSwitch(session, input), gate, read };
}

/**
 * The switch plan: the coverage, the DS gate (or, with the nameservers at B already, a warning
 * when A's DS record is still published), the plan shown and approved (or saved for `--approve`;
 * a plan this repository approved with the same hash is not asked again), then everything read
 * and planned again and refused when its hash changed (or stopped by what the second reading
 * found). Then the approved hash recorded in the switch file, and the DS records removed (and a
 * stop for the wait), or the zone copy's records created and B's nameservers set (the switch file
 * with their time), already at B, or left to the user (a stop).
 */
async function beforeSwitch(
  session: MoveSession,
  move: CloudflareMove,
  registrar: Registrar,
  read: Delegation,
  progress: SwitchProgress | undefined,
): Promise<{ stop: StepStop } | { progress: SwitchProgress }> {
  const { deps, zone, command } = session;
  if (read.switched) await warnPublishedDs(session, registrar);
  const first = await planFrom(session, move, registrar, read);
  if ("stop" in first) return first;
  const { plan } = first;
  let current: Exclude<Planned, { stop: StepStop }> = first;
  if (progress?.approved !== plan.planHash) {
    if (!appliesNow(session, plan.planHash)) {
      deps.reporter.info(plan.details);
      const pending = { planHash: plan.planHash, savedAt: deps.clock.now().toISOString() };
      await writeSwitchProgress(session.paths, { zone, pending });
      return { stop: pendingStop(session, plan.planHash, ["--confirm", zone]) };
    }
    const approval = await deps.approvals.request({
      kind: "domain-settings",
      title: `Switch ${zone} to ${accountWords(session.accounts.b)}`,
      details: plan.details,
      planHash: plan.planHash,
      // Typed in a terminal, `--confirm <zone>` in a script.
      confirmPhrase: zone,
    });
    if (!approval.approved) {
      throw new PlanRefusedError({
        plan: "switch plan",
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
        unchanged: "Nothing was changed.",
        hint: `Run \`${command}\` again when you are ready (in a script: --confirm ${zone} --approve ${plan.planHash}).`,
      });
    }
    // Everything read again (B's zone, the delegation, the coverage, the DS gate) and planned.
    const reread = await readDelegation(session, move, registrar, undefined);
    const again = await planFrom(session, move, registrar, reread);
    if ("stop" in again) return again;
    if (again.plan.planHash !== plan.planHash) {
      throw new OpsCrewError(
        "PLAN_HASH_MISMATCH",
        `The zones changed since the switch plan ${plan.planHash} was made, so it was not applied. Nothing was changed.`,
        { hint: `Run \`${command}\` again to see the new plan.` },
      );
    }
    current = again;
  }
  const { gate, read: now } = current;
  if (gate.kind === "remove") {
    await writeSwitchProgress(session.paths, { zone });
    return { stop: await removeDs(session, gate, now.zone) };
  }
  const approved: SwitchProgress = { zone, approved: plan.planHash };
  await writeSwitchProgress(session.paths, approved);
  await copyRecords(session, now.zone, current.plan);
  if (now.switched) return { progress: approved };
  const stop = await pointAtB(session, registrar, now.zone, now.before);
  if (stop !== undefined) return { stop };
  const set = { ...approved, nameserversSetAt: deps.clock.now().toISOString() };
  await writeSwitchProgress(session.paths, set);
  return { progress: set };
}

/**
 * The marks in B, once every OpsCrew name in A's zone is in one of them and nothing went unread;
 * refused before any change otherwise.
 */
async function requireCoverage(session: MoveSession, listed: ListedRecords): Promise<ReadMark[]> {
  const { zone, command } = session;
  const { a, b } = session.accounts;
  const found = await coverage(session, listed);
  if (found.uncovered.length > 0) {
    throw refusal(
      `${listText(found.uncovered)} in ${zone} ${found.uncovered.length === 1 ? "belongs" : "belong"} to OpsCrew apps not prepared in the new Cloudflare account yet, so ${zone} can't switch.`,
      `Run \`${MOVE_COMMAND} --to ${b.accountId}\` in the repository that deploys them, or remove those records from the account ${accountName(a)} if no app uses them, then run \`${command}\` again.`,
    );
  }
  if (found.unread.length > 0) {
    throw refusal(
      `OpsCrew could not read ${listText(found.unread)}, so it can't tell whether every OpsCrew app in ${zone} is prepared in the new account.`,
      `Give ${A_TOKEN_VAR} the permissions to read them (or run the move's prepare again for a damaged mark), then run \`${command}\` again.`,
    );
  }
  return found.marks;
}

/**
 * Creates the zone copy's records in B (each with every field; SRV and CAA by their `data`; the
 * address updater's with A's values as read for the approved plan), then brings B's copies of the
 * updater's records to A's: updated in place, and deleted where A's updater no longer keeps them
 * (the switch's approval has the zone's name typed).
 */
async function copyRecords(session: MoveSession, zone: MoveZone, plan: SwitchPlan): Promise<void> {
  const { copy } = plan;
  if (copy === undefined) return;
  const records = [...copy.create, ...updaterCreates(copy)].map(recordInput);
  if (records.length > 0) {
    session.deps.reporter.step(
      `Copying ${plural(records.length, "record")} into the new account's zone`,
    );
    await session.accounts.b.client.createZoneRecords(zone.id, records);
    await moveAudit(session.deps, {
      kind: "provider-call",
      action: "cloudflare records created",
      target: plan.planHash,
      decision: "approved",
      detail: `${plural(records.length, "record")} in ${session.zone} (the switch)`,
    });
  }
  await writeUpdaterCopies(session, zone.id, copy, plan.planHash);
}

/**
 * Once the nameservers point at B: while B's zone is pending, the wait for its activation (at most
 * 15 minutes, then a stop the next run goes on from), then the steps right after activation
 * (Access, protected records, custom domains, DNSSEC) at once and each app's finish,
 * origin-protected apps first. The gap is measured with the times kept (`nameserversSetAt` from
 * the switch file; else from this run while B's zone is pending, and unknown once it is active),
 * except in a run that finds B's zone active with no switch file at all (another repository's,
 * after the switch): that one only makes what is missing and gives the finishes.
 */
async function afterSwitch(
  session: MoveSession,
  move: CloudflareMove,
  state: { registrar: Registrar; zone: MoveZone; progress: SwitchProgress | undefined },
): Promise<MoveResult> {
  const { deps, zone, command } = session;
  const { b } = session.accounts;
  await clearDsNotes(session.paths);
  const inB = await b.client.listZoneRecords(state.zone.id);
  const { marks } = parseMarks(inB);
  const later: string[] = [];
  const activated = async () => {
    await protectInB(session, marks, state.zone);
    const domains = await attachSites(session, marks, state.zone);
    if (move.dsAtStart) {
      const registrar = await registrarAfterSwitch(session, state.registrar);
      later.push(...(await dnssecInB(session, registrar, state.zone)));
    }
    return domains;
  };
  const { pending: _done, ...kept } = state.progress ?? { zone };
  const active = state.zone.status === "active";
  if (state.progress === undefined && active) {
    deps.reporter.info(
      `${zone} is active in the new account already; the run that switched it measured the times.`,
    );
    await activated();
    const finishes = await finishLines(session, marks, state.zone);
    return { step: "switched", done: true, next: [...finishes, ...later] };
  }
  if (kept.nameserversSetAt === undefined) {
    deps.reporter.info(
      active
        ? `${zone} is active in the new account already, and the time of the nameserver change is unknown: the certificate's and the hostnames' times are measured from this run.`
        : `The nameservers of ${zone} point at the new account already; the times are measured from this run.`,
    );
  }
  const progress: SwitchProgress =
    kept.nameserversSetAt !== undefined || active
      ? kept
      : { ...kept, nameserversSetAt: deps.clock.now().toISOString() };
  await writeSwitchProgress(session.paths, progress);
  const pending = active ? undefined : await waitForActive(session, state.zone);
  if (pending !== undefined) {
    deps.reporter.warn(pending);
    return {
      step: move.step,
      done: false,
      next: [`Run \`${command}\` again later to go on: it keeps the times measured so far.`],
    };
  }
  const protectedNames = new Set(
    marks.flatMap((read) => read.mark.access.map((one) => one.hostname)),
  );
  const served = (name: string) =>
    !protectedNames.has(name) &&
    !name.split(".").some((label) => label.startsWith("_")) &&
    inB.some((r) => r.name === name && ["A", "AAAA", "CNAME"].includes(r.type.toUpperCase()));
  const result = await measureGap(session, progress, {
    zone: state.zone,
    hostnames: [...new Set(marks.flatMap((read) => read.mark.hosts))].filter(served).sort(),
    activated,
  });
  const times = result.progress;
  // B's zone is active by now: the measure starts once it is.
  const finishes = await finishLines(session, marks, state.zone);
  if (!result.done) {
    const left = result.hostnames.filter((name) => times.okAt?.[name] === undefined);
    const status =
      times.certificateAt === undefined
        ? `The new account's Universal SSL certificate for ${zone} is not issued yet.`
        : `${listText(left)} ${left.length === 1 ? "does" : "do"} not answer over HTTPS from the new account yet.`;
    deps.reporter.warn(status);
    return {
      step: move.step,
      done: false,
      next: [
        ...finishes,
        ...later,
        `Run \`${command}\` again to go on: it keeps the times measured so far.`,
      ],
    };
  }
  const report = timesReport(zone, times, result.hostnames);
  for (const line of report) deps.reporter.success(line);
  await moveAudit(deps, {
    kind: "provider-call",
    action: "switch measured",
    target: zone,
    detail: report.join(" "),
  });
  await clearSwitchProgress(session.paths);
  return { step: "switched", done: true, next: [...finishes, ...later] };
}

/**
 * The measured times in words: the nameserver change to activation, to the certificate, per host;
 * from the activation this run saw when the nameserver change's time is unknown.
 */
function timesReport(zone: string, times: SwitchProgress, hostnames: readonly string[]): string[] {
  const from = times.nameserversSetAt;
  const active = times.activeAt as string;
  const certificate = gapText(active, times.certificateAt as string);
  const since = from ?? active;
  const after =
    from === undefined ? "after this run saw the zone active" : "after the nameserver change";
  return [
    from === undefined
      ? `${zone} switched; the time of the nameserver change is unknown. Its certificate was issued ${certificate} after this run saw the zone active.`
      : `${zone} switched: active in the new account ${gapText(from, active)} after the nameserver change, its certificate issued ${certificate} after that.`,
    ...hostnames.map(
      (name) =>
        `${name} answered over HTTPS ${gapText(since, times.okAt?.[name] as string)} ${after}.`,
    ),
  ];
}

/**
 * Each mark's finish to run, origin-protected apps first (their hostnames may answer 526 until
 * then): this repository's here, another's in its own repository. Whether an app is origin
 * protected is read from B's per-hostname origin pulls; without the permission to read them, the
 * marks keep their order.
 */
async function finishLines(
  session: MoveSession,
  marks: readonly ReadMark[],
  zone: MoveZone,
): Promise<string[]> {
  const { b } = session.accounts;
  const own = await markName(session);
  const lines: { protected: boolean; text: string }[] = [];
  for (const read of marks) {
    const names = read.mark.hosts.filter((name) => !name.startsWith("_"));
    let aop = false;
    try {
      const settings = await b.client.listHostnameAopSettings(zone.id, names);
      aop = settings.some((one) => one.enabled === true);
    } catch (error) {
      if (!(error instanceof CloudflareError)) throw error;
    }
    const where = read.name === own ? "here" : "in its repository";
    const why = aop ? ", right away: with origin protection it may answer 526 until then" : "";
    lines.push({
      protected: aop,
      text: `Run \`${FINISH_COMMAND}\` ${where} for ${read.mark.app} (${listText(names.slice(0, 3))}${names.length > 3 ? ", …" : ""})${why}.`,
    });
  }
  return [...lines.filter((one) => one.protected), ...lines.filter((one) => !one.protected)].map(
    (one) => one.text,
  );
}
