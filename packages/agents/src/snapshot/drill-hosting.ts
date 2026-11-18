/**
 * `opscrew restore --drill [<id>]` on a hosting account with a panel (029 plan.md 19., research
 * R25, R27): OpsCrew's agent on the account loads the snapshot's dump into the account's standing
 * drill database, counts its tables against the dump's and empties it again, and lists the
 * snapshot's copy of the shared files; the app isn't started, as an account can't run a second
 * copy of it cut off from the outside. A one-time `drill` request (`requests.ts`), bound to the
 * drill's hash after an approval like a destroy's (`allowDestroy`, `<app>-drill` typed), which the
 * agent carries out under its lock, between releases. The drill database's login stays on the
 * account and the panel's token on this computer.
 */
import { canonicalJson, listText, OpsCrewError, plural, realSleep, sha256Hex } from "@opscrew/core";
import { type DrillRecord, drillRecord } from "@opscrew/iac-templates";
import { hostingTarget } from "../hosting/provision-plans";
import { recordedObject } from "../hosting/record";
import { SNAPSHOT_ID, sendRequest } from "../hosting/requests";
import {
  agentFailure,
  downloadNote,
  type HostingSnapshotServices,
  keptSnapshots,
  reachDumps,
} from "../hosting/snapshot";
import { NOTHING_CHANGED } from "../promote/shared";
import { sizeText } from "../retarget/texts";
import { drillReport } from "./drill-report";
import type { SnapshotRun } from "./run";
import type { DrillReport, DrillRequest, SnapshotServices } from "./types";

/** A snapshot `opscrew snapshot` took (or a restore took first): `snapshot-<UTC time>[-<n>]`. */
const TAKEN = /^snapshot-\d{8}T\d{6}Z(?:-\d+)?$/;

/** What a drill proves of a snapshot that holds no dump (research R27's row). */
const FILES_ONLY = "the copy of the shared files is a valid archive; the app itself wasn't started";

/** Why each option of a server's drill has no place on a hosting account. */
const NO_OPTION: Readonly<Record<string, string>> = {
  keep: "A drill on a hosting account leaves no copy to keep: it empties the drill database again at its end.",
  remove:
    "A drill on a hosting account leaves no copy to remove: it empties the drill database again at its end.",
  only: "--only drills one service of a server's snapshot; on a hosting account a drill checks the dump and the shared files together.",
  "allow-other-version":
    "--allow-other-version starts today's version of the app on a server's copy; on a hosting account a drill starts no app.",
};

/** What did not restore, by the agent's fixed word. */
function notRestored(record: DrillRecord, expected: number | undefined): string {
  const count = record.tables.find((entry) => entry.service === "database")?.count;
  switch (record.reason) {
    case "dump":
      return "its dump is empty or not a valid gzip file";
    case "database":
      return "its dump did not load into the drill database";
    case "tables":
      if (count === undefined) return "the drill database did not answer once the dump loaded";
      if (expected === 0) return "its dump makes no table";
      return `the drill database holds ${plural(count, "table")} once the dump loaded, and the dump makes ${expected ?? "another number"}`;
    case "files":
      return "its copy of the shared files is not a valid archive";
    default:
      return `${record.reason ?? "a part of it"} did not restore`;
  }
}

/**
 * A hosting account's drill record in plain words (research R19, R27), with what to do next:
 * `expected` is the dump's count of tables, when the agent read it.
 */
export function hostingDrillSummary(
  record: DrillRecord,
  o: { id: string; flags: string; expected?: number },
): string {
  const tables = record.tables.find((entry) => entry.service === "database")?.count;
  const files = record.parts.some((part) => part.name === "files");
  switch (record.result) {
    case "healthy":
      return tables === undefined
        ? `The snapshot ${o.id}'s copy of the shared files is a valid archive; the app itself wasn't started.`
        : `The snapshot ${o.id}'s dump loaded with ${plural(tables, "table")}; the app itself wasn't started.${files ? " Its copy of the shared files is a valid archive." : ""}`;
    case "not-restored":
      return `The snapshot ${o.id} did not restore: ${notRestored(record, o.expected)}. The backup is bad: take a new snapshot now with \`opscrew snapshot${o.flags}\`.`;
    default:
      return `The drill of the snapshot ${o.id} ended ${record.result}${record.reason === undefined ? "" : ` (${record.reason})`}, so it proves nothing either way. \`opscrew logs${o.flags}\` shows the agent's lines.`;
  }
}

/** One line per step of a hosting account's drill record, for the reporter. */
function hostingDrillSteps(record: DrillRecord, expected: number | undefined): string[] {
  return [
    ...record.parts.map((part) =>
      part.name === "database"
        ? `Loaded the dump (${sizeText(part.size)}) into the drill database in ${plural(part.seconds, "second")}`
        : `Listed the copy of the shared files (${sizeText(part.size)}): a valid archive`,
    ),
    ...record.tables.map((entry) =>
      entry.count === undefined
        ? "The drill database did not answer"
        : `The drill database held ${plural(entry.count, "table")}${expected === undefined ? "" : ` (the dump makes ${expected})`}`,
    ),
    ...(record.removal === "removed" ? ["Emptied the drill database again"] : []),
  ];
}

/**
 * The drill `request` asks on the hosting account of `run` (see the module's comment): the
 * snapshot `request.id` the account keeps in `dumps/`, by default the newest one `opscrew
 * snapshot` took. Refused, before any change, with a server's options (`--keep`, `--remove`,
 * `--only`, `--allow-other-version`), before provision, for an app with a database while its drill
 * database isn't made (drills off, or not provisioned since), for a snapshot the account doesn't
 * keep, and when the approval is not given; a drill that did not restore is a report, not an error.
 * @throws OpsCrewError `INVALID_INPUT` for those options or an id that can't be one,
 * `PHASE_PRECONDITION` for each refusal, `APPROVAL_REFUSED`, `COMMAND_FAILED` when the agent refuses
 * or doesn't finish, and `PROVIDER_ERROR` for an answer OpsCrew can't read.
 */
export async function drillOnHosting(
  run: SnapshotRun,
  services: SnapshotServices & HostingSnapshotServices,
  request: DrillRequest,
): Promise<DrillReport> {
  const { deps, plan, environment, flags } = run;
  const name = `${plan.app.name}-drill`;
  const option = (
    [
      ["keep", request.keep === true],
      ["remove", request.remove === true],
      ["only", request.only !== undefined],
      ["allow-other-version", request.allowOtherVersion === true],
    ] as const
  ).find(([, given]) => given)?.[0];
  if (option !== undefined) {
    throw new OpsCrewError("INVALID_INPUT", `${NO_OPTION[option]} ${NOTHING_CHANGED}`, {
      hint: `Run \`opscrew restore --drill${request.id === undefined ? "" : ` ${request.id}`}${flags}\` without --${option}.`,
    });
  }
  if (request.id !== undefined && !SNAPSHOT_ID.test(request.id)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${request.id} is no snapshot's id on a hosting account: an id has letters, digits, _ and - only, like snapshot-20261112T120000Z. ${NOTHING_CHANGED}`,
    );
  }
  const { files, folder, record } = await reachDumps(run, services, NOTHING_CHANGED);
  const target = hostingTarget(plan);
  const drillDatabase = recordedObject(record, "drill-database")?.key;
  if (target.database !== undefined && drillDatabase === undefined) {
    const off = plan.snapshots?.drills === undefined;
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      off
        ? `Restore drills are off for ${environment}: on a hosting account a drill loads the snapshot's dump into a database of its own, which OpsCrew makes once they are on. ${NOTHING_CHANGED}`
        : `The drill database isn't made on the hosting account yet, so there is nothing to load the snapshot's dump into. ${NOTHING_CHANGED}`,
      {
        hint: off
          ? `Add \`drills: {}\` under \`snapshots:\` in opscrew/plan.yaml, then run \`opscrew provision${flags}\`, which makes the drill database (it counts against your hosting plan's limit on databases).`
          : `Run \`opscrew provision${flags}\`, which makes it, then the drill again.`,
      },
    );
  }

  // The snapshot: the one named, or the newest one taken.
  const { names, ids } = await keptSnapshots(files, folder);
  const id = request.id ?? ids.filter((each) => TAKEN.test(each)).at(-1);
  if (id === undefined || !ids.includes(id)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      id === undefined
        ? `The hosting account keeps no snapshot of ${environment} that \`opscrew snapshot\` took, so there is nothing to drill${ids.length === 0 ? "" : `; it keeps the releases' dumps ${listText(ids)}, which a drill takes by id`}. ${NOTHING_CHANGED}`
        : `The hosting account keeps no snapshot ${id} of ${environment}${ids.length === 0 ? "" : `; it keeps ${listText(ids)}`}. ${NOTHING_CHANGED}`,
      { hint: `\`opscrew snapshot${flags}\` takes one. ${downloadNote(folder)}` },
    );
  }
  const dumped = names.includes(`${id}.sql.gz`);
  const shared = names.includes(`${id}.shared.tar.gz`);

  // The approval, bound to the drill's hash.
  const hash = sha256Hex(
    canonicalJson({
      environment,
      kind: "drill",
      folder,
      snapshot: id,
      dump: dumped,
      shared,
      database: drillDatabase ?? "",
      planHash: sha256Hex(canonicalJson(plan)),
    }),
  );
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Run a restore drill of the snapshot ${id} of ${environment} on the hosting account`,
    details: [
      `The drill checks the snapshot ${id} in ~/${folder}/dumps/ (${[dumped ? `${id}.sql.gz` : "", shared ? `${id}.shared.tar.gz` : ""].filter(Boolean).join(" and ")}). The app itself isn't started: a hosting account can't run a second copy of it cut off from the outside.`,
      ...(dumped
        ? [
            `  The dump: checked as a gzip file and for its size, then loaded into the drill database ${drillDatabase} only, every table and view in it dropped first; its tables are counted against the dump's (names and counts only, no row is read), then the drill database is emptied again.`,
          ]
        : []),
      ...(shared
        ? [`  The shared files: ${id}.shared.tar.gz is listed as an archive; nothing is unpacked.`]
        : []),
      "  Its bounds: OpsCrew's agent on the account does it under its lock, between releases, signed in with the drill database's own login, which has no right on the app's database; the app's database, its files and its settings are not touched.",
      `Typing ${name} approves it.`,
      `Drill hash: ${hash}`,
    ].join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: name,
  });
  if (!approval.approved) {
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The drill of the snapshot ${id} did not run${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`opscrew restore --drill ${id}${flags}\` again and type ${name} (in a script: --confirm ${name} --approve ${hash}).`,
      },
    );
  }

  // The agent's drill.
  deps.reporter.step(`Asking the agent on the account for a restore drill of the snapshot ${id}`);
  const answer = await sendRequest(
    files,
    folder,
    { kind: "drill", snapshot: id },
    { hash, now: deps.clock.now(), sleep: services.sleep ?? realSleep },
  );
  const drilled = answer.record === undefined ? undefined : drillRecord(answer.record);
  await deps.audit.append({
    kind: "provider-call",
    actor: "opscrew",
    action: `ask the agent for a restore drill of the snapshot ${id}`,
    target: hash,
    decision: answer.result === "done" ? "approved" : "refused",
    detail: drilled?.result ?? answer.result,
  });
  if (answer.result !== "done") {
    throw agentFailure(run, answer, {
      what: `the drill of the snapshot ${id}`,
      nothing: NOTHING_CHANGED,
      after: "The next drill empties the drill database first.",
    });
  }
  if (drilled === undefined) {
    throw new OpsCrewError(
      "PROVIDER_ERROR",
      "The agent on the hosting account ran the drill, but OpsCrew can't read its record.",
      {
        hint: `\`opscrew logs${flags}\` shows the agent's lines; the drill's record is in ~/${folder}/state/drills.log.`,
      },
    );
  }

  // The report: one line per step, then the outcome in plain words.
  const expected = answer.expected === undefined ? undefined : Number(answer.expected);
  for (const step of hostingDrillSteps(drilled, expected)) deps.reporter.step(step);
  const report: DrillReport = {
    ...drillReport(drilled, {
      id,
      flags,
      ownLogins: [],
      where: `on the hosting account (~/${folder}/dumps/)`,
      target: "hosting",
      app: plan.app.name,
    }),
    summary: hostingDrillSummary(drilled, {
      id,
      flags,
      ...(expected === undefined ? {} : { expected }),
    }),
    ...(dumped ? {} : { proves: FILES_ONLY }),
  };
  if (drilled.removal === "failed") {
    deps.reporter.warn(
      `The agent could not empty the drill database ${drillDatabase} again, so it still holds the snapshot's data: run \`opscrew restore --drill${flags}\` again, which empties it first.`,
    );
  }
  if (drilled.result === "healthy") {
    deps.reporter.success(report.summary);
    deps.reporter.info(`What it proves: ${report.proves}.`);
  } else {
    deps.reporter.warn(report.summary);
  }
  return report;
}
