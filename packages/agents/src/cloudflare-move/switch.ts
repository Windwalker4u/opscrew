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
import { approveCommand } from "../retarget/texts";
import { PlanRefusedError } from "../shared";
import { gapText, measureGap } from "./gap";
import { coverage, markName, type ReadMark, readMarks } from "./marks";
import {
  clearSwitchProgress,
  readSwitchProgress,
  type SwitchProgress,
  writeSwitchProgress,
} from "./progress";
import { openMoveSession } from "./session";
import { protectInB } from "./switch-access";
import { clearDsNotes, dsGate, removeDs } from "./switch-ds";
import { planSwitch, type SwitchPlan } from "./switch-plan";
import {
  currentNameservers,
  dnssecInB,
  findSwitchRegistrar,
  pointAtB,
  registrarAfterSwitch,
} from "./switch-registrar";
import { attachSites } from "./switch-sites";
import { A_TOKEN_VAR, FINISH_COMMAND, MOVE_COMMAND, refusal, SWITCH_COMMAND } from "./texts";
import type { MoveResult, MoveSession, MoveZone, StepStop, SwitchMoveOptions } from "./types";

/**
 * `opscrew cloudflare move --switch`: refused before any change unless this repository's app is
 * prepared and every OpsCrew name in A's zone is in some mark; then plan 5.'s steps in order,
 * each checked before it acts. Stops on purpose (`done: false`, `next` says what to do) for the
 * plan's approval in a run nobody can answer, a DS record and its wait, a nameserver change the
 * user makes, and the gap's two-hour limit.
 */
export async function switchMove(
  deps: PhaseDeps,
  options: SwitchMoveOptions = {},
): Promise<MoveResult> {
  const session = await openMoveSession(deps, { ...options, command: SWITCH_COMMAND });
  const move = requirePrepared(session);
  const { b } = session.accounts;
  const zone = await b.client.getZone(move.to.zoneId as string);
  b.zone = zone;
  const registrar = await findSwitchRegistrar(session);
  const found = await readSwitchProgress(session.paths);
  let progress = found?.zone === session.zone ? found : undefined;
  let switched = zone.status === "active" || progress?.nameserversSetAt !== undefined;
  const before = switched ? [] : await currentNameservers(session, registrar);
  switched ||= sameHosts(before, hosts(zone.nameServers));
  if (!switched) {
    const stop = await beforeSwitch(session, move, { registrar, zone, before });
    if (stop !== undefined) return { step: move.step, done: false, ...stop };
    progress = { zone: session.zone, nameserversSetAt: deps.clock.now().toISOString() };
  }
  return afterSwitch(session, move, { registrar, zone, progress });
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

/** What the switch reads before it plans. */
interface SwitchState {
  registrar: Awaited<ReturnType<typeof findSwitchRegistrar>>;
  zone: MoveZone;
  before: string[];
}

/**
 * Before the nameservers point at B: the coverage, the DS gate, the switch plan shown and approved
 * (or saved for `--approve`), planned again and refused when its hash changed; then the DS records
 * removed (and a stop for the wait), or the zone copy's records created and B's nameservers set
 * (undefined) or left to the user (a stop).
 */
async function beforeSwitch(
  session: MoveSession,
  move: CloudflareMove,
  state: SwitchState,
): Promise<StepStop | undefined> {
  const { deps, zone, command } = session;
  const marks = await requireCoverage(session);
  const gate = await dsGate(session, state.registrar, move.dsAtStart);
  if (gate.kind === "stop") return gate.stop;
  const input = { ...state, gate, marks, dnssec: move.dsAtStart };
  const plan = await planSwitch(session, input);
  if (!appliesNow(session, plan.planHash)) {
    deps.reporter.info(plan.details);
    const pending = { planHash: plan.planHash, savedAt: deps.clock.now().toISOString() };
    await writeSwitchProgress(session.paths, { zone, pending });
    const approve = approveCommand(command, plan.planHash, ["--confirm", zone]);
    return {
      pendingPlanHash: plan.planHash,
      next: [`Review the plan above, then run \`${approve}\` to apply it and continue.`],
    };
  }
  const approval = await deps.approvals.request({
    kind: "domain-settings",
    title: `Switch ${zone} to the Cloudflare account ${session.accounts.b.name ?? session.accounts.b.accountId}`,
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
  const again = await planSwitch(session, input);
  if (again.planHash !== plan.planHash) {
    throw new OpsCrewError(
      "PLAN_HASH_MISMATCH",
      `The zones changed since the switch plan ${plan.planHash} was made, so it was not applied. Nothing was changed.`,
      { hint: `Run \`${command}\` again to see the new plan.` },
    );
  }
  await writeSwitchProgress(session.paths, { zone });
  if (gate.kind === "remove") return removeDs(session, gate, state.zone);
  await copyRecords(session, state.zone, again);
  const change = await pointAtB(session, state.registrar, state.zone, state.before);
  return change.set ? undefined : change.stop;
}

/**
 * The marks in B, once every OpsCrew name in A's zone is in one of them and nothing went unread;
 * refused before any change otherwise.
 */
async function requireCoverage(session: MoveSession): Promise<ReadMark[]> {
  const { zone, command } = session;
  const { a, b } = session.accounts;
  const found = await coverage(session);
  if (found.uncovered.length > 0) {
    throw refusal(
      `${listText(found.uncovered)} in ${zone} ${found.uncovered.length === 1 ? "belongs" : "belong"} to OpsCrew apps not prepared in the new Cloudflare account yet, so ${zone} can't switch.`,
      `Run \`${MOVE_COMMAND} --to ${b.accountId}\` in the repository that deploys them, or remove those records from the account ${a.name ?? a.accountId} if no app uses them, then run \`${command}\` again.`,
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

/** Creates the zone copy's records in B (each with every field; SRV and CAA by their `data`). */
async function copyRecords(session: MoveSession, zone: MoveZone, plan: SwitchPlan): Promise<void> {
  const records = (plan.copy?.create ?? []).map(({ content, ...rest }) =>
    rest.data === undefined ? { ...rest, ...(content === undefined ? {} : { content }) } : rest,
  );
  if (records.length === 0) return;
  session.deps.reporter.step(
    `Copying ${plural(records.length, "record")} into the new account's zone`,
  );
  await session.accounts.b.client.createZoneRecords(zone.id, records);
  await session.deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "cloudflare records created",
    phase: "cloudflare-move",
    target: plan.planHash,
    decision: "approved",
    detail: `${plural(records.length, "record")} in ${session.zone} (the switch)`,
  });
}

/**
 * Once the nameservers point at B: the times kept (`nameserversSetAt` from the switch file, else
 * from this run), the gap measured with the steps right after activation (Access, protected
 * records, custom domains, DNSSEC), and the output: the times, then each app's finish.
 */
async function afterSwitch(
  session: MoveSession,
  move: CloudflareMove,
  state: Omit<SwitchState, "before"> & { progress: SwitchProgress | undefined },
): Promise<MoveResult> {
  const { deps, zone, command } = session;
  const { b } = session.accounts;
  const { pending: _done, ...kept } = state.progress ?? { zone };
  if (kept.nameserversSetAt === undefined) {
    deps.reporter.info(
      `The nameservers of ${zone} point at the new account already; the times are measured from this run.`,
    );
  }
  const progress: SwitchProgress = {
    ...kept,
    nameserversSetAt: kept.nameserversSetAt ?? deps.clock.now().toISOString(),
  };
  await writeSwitchProgress(session.paths, progress);
  await clearDsNotes(session.paths);
  const { marks } = await readMarks(session);
  const inB = await b.client.listZoneRecords(state.zone.id);
  const served = (name: string) =>
    !name.split(".").some((label) => label.startsWith("_")) &&
    inB.some((r) => r.name === name && ["A", "AAAA", "CNAME"].includes(r.type.toUpperCase()));
  const later: string[] = [];
  const result = await measureGap(session, progress, {
    zone: state.zone,
    hostnames: [...new Set(marks.flatMap((read) => read.mark.hosts))].filter(served).sort(),
    activated: async () => {
      await protectInB(session, marks, state.zone);
      const domains = await attachSites(session, marks, state.zone);
      if (move.dsAtStart) {
        const registrar = await registrarAfterSwitch(session, state.registrar);
        later.push(...(await dnssecInB(session, registrar, state.zone)));
      }
      return domains;
    },
  });
  const times = result.progress;
  const finishes =
    times.activeAt === undefined ? [] : await finishLines(session, marks, state.zone);
  if (!result.done) {
    const left = result.hostnames.filter((name) => times.okAt?.[name] === undefined);
    const status =
      times.activeAt === undefined
        ? `Cloudflare has not activated ${zone} in the new account yet: it does once the registry publishes the new nameservers, usually within an hour and at worst in 24 hours.`
        : times.certificateAt === undefined
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
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: "switch measured",
    phase: "cloudflare-move",
    target: zone,
    detail: report.join(" "),
  });
  await clearSwitchProgress(session.paths);
  return { step: "switched", done: true, next: [...later, ...finishes] };
}

/** The measured times in words: the nameserver change to activation, to the certificate, per host. */
function timesReport(zone: string, times: SwitchProgress, hostnames: readonly string[]): string[] {
  const from = times.nameserversSetAt as string;
  const active = times.activeAt as string;
  return [
    `${zone} switched: active in the new account ${gapText(from, active)} after the nameserver change, its certificate issued ${gapText(active, times.certificateAt as string)} after that.`,
    ...hostnames.map(
      (name) =>
        `${name} answered over HTTPS ${gapText(from, times.okAt?.[name] as string)} after the nameserver change.`,
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
