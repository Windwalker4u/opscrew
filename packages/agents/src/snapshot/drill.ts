// biome-ignore-all lint/suspicious/noTemplateCurlyInString: some strings are shell syntax, not JavaScript templates.
/**
 * `opscrew restore --drill [<id>] [--only <service>] [--keep] [--allow-other-version]` and
 * `opscrew restore --drill --remove` (029 US7, plan.md 19., research R15–R19, R26, R27): a
 * snapshot restored into a throwaway copy where it is, to prove it restores and the app starts on
 * it, never touching production's data.
 * - **Servers** (OpsCrew's, the user's own, a home one) **and this computer:** read-only first (the
 *   snapshot's record, the version that runs, a kept copy, the image), the copy is rendered
 *   (`renderDrill`: the project `<app>-drill`, one network with no internet, no port, none of
 *   `.env`), and its plan, bound to a drill hash, is approved like a destroy (`allowDestroy`,
 *   `<app>-drill` typed), the restore's kind. Then the machine's `snapshot.sh drill`, after its
 *   one-time approval, keeps the bounds itself and removes the copy; the copy's files and
 *   `.env.preview`'s values go on its stdin, never in the plan.
 * - **The user's Portainer and a hosting account with a panel:** their own drills
 *   (`drillInPortainer`, `drillOnHosting`).
 * - **SFTP hosts, Cloudflare's hosting, GitHub Pages:** refused with the reason, before any change.
 * Nothing it prints, audits or asks holds a password, a key, an address or a value.
 */
import type { CommandResult } from "@opscrew/contracts";
import { canonicalJson, errorMessage, listText, OpsCrewError, sha256Hex } from "@opscrew/core";
import {
  appDir,
  DRILL_APPROVAL_FILE,
  DRILL_LIMIT_SECONDS,
  DRILL_VALUES_FILE,
  type DrillAction,
  drillApprovalLine,
  drillDir,
  drillName,
  drillPlan,
  drillProject,
  drillRecordsIn,
  localComposeProject,
  type RenderedFile,
  renderDrill,
  SNAPSHOT_SCRIPT,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, isHostingTarget } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { APPROVAL_SECONDS } from "../rollback/database";
import { shortDigest } from "../rollback/versions";
import {
  drillApprovalLines,
  drillCommandText,
  drillEnvFor,
  drillImage,
  ownLogins,
  partWordsOf,
  pickParts,
  pickSnapshot,
} from "./drill-core";
import { drillOnHosting } from "./drill-hosting";
import { drillInPortainer } from "./drill-portainer";
import { type DrillTarget, drillReport, drillSteps } from "./drill-report";
import { dataHosts, hostFailure, READ_TIMEOUT_MS, type ScriptHost, scriptCommand } from "./hosts";
import { partWords, typedApprovalRefused } from "./restore-checks";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { type About, KIND_WORDS, requireSnapshotId } from "./store";
import type { DrillReport, DrillRequest, DrillSnapshotOptions } from "./types";

/** How long the machine's drill may take: its own limit and the time to remove the copy. */
const DRILL_TIMEOUT_MS = (DRILL_LIMIT_SECONDS + 5 * 60) * 1000;

/** What one machine says before the approval, read-only. */
interface Probe {
  /** Its stdout: the snapshots' listing, then the lines below. */
  stdout: string;
  /**
   * With `--allow-other-version`, the version the app's running container has: `sha256:<hex>`
   * of its image's digest, or of a local build's image ID on this computer; empty when no
   * container of the app runs or its image has no digest.
   */
  running: string;
  /** A kept copy's snapshot id, if there is one. */
  kept?: string;
  /** Something of a drill's copy is there (a kept one, or a crashed run's). */
  left: boolean;
}

/** The line the probe prints of the app's running container: `running <image> <image ID>`. */
const RUNNING_LINE = /^running (\S+) sha256:([0-9a-f]{64})$/m;

/**
 * The version the app's running container has (`Probe.running`), from {@link RUNNING_LINE}: its
 * image's digest, or on this computer a local build's image ID.
 */
function runningVersion(plan: DeployPlan, stdout: string): string {
  const match = RUNNING_LINE.exec(stdout);
  if (match === null) return "";
  const [, image = "", id = ""] = match;
  if (plan.target.provider === "localhost" && plan.target.image === "local-build") {
    return `sha256:${id}`;
  }
  const digest = /@sha256:([0-9a-f]{64})$/.exec(image)?.[1];
  return digest === undefined ? "" : `sha256:${digest}`;
}

/**
 * Reads on `host`, changing nothing: its snapshots (`snapshot.sh list`), whether its script has the
 * drill, what a drill left there, and with `version` the image of the app's running container
 * (`docker inspect`, by its Compose labels), which only `--allow-other-version` needs. Nothing
 * reads `.env`, and no `docker compose` runs in the app's folder, which would read it.
 */
async function probe(run: SnapshotRun, host: ScriptHost, version = false): Promise<Probe> {
  const { plan } = run;
  const name = drillName(plan.app.name);
  const project = plan.target.provider === "localhost" ? localComposeProject(plan) : plan.app.name;
  const command = [
    `${scriptCommand(["list"])} || exit $?`,
    `grep -q snapshot_cmd_drill ${SNAPSHOT_SCRIPT} || echo no-drill`,
    ...(version
      ? [
          `c="$(docker ps -q --filter label=com.docker.compose.project=${project} --filter label=com.docker.compose.service=app 2> /dev/null | head -n 1)"`,
          `if [ -n "$c" ]; then echo "running $(docker inspect --format '{{.Config.Image}} {{.Image}}' "$c")"; fi`,
        ]
      : []),
    'for k in .drill/*/kept; do if [ -f "$k" ]; then k="${k%/kept}"; echo "kept ${k#.drill/}"; fi; done',
    `if [ -e .drill ] || [ -n "$(docker ps -aq --filter label=com.docker.compose.project=${name} 2> /dev/null)" ]; then echo drill-left; fi`,
    "exit 0",
  ].join("\n");
  const result = await host.run(command, READ_TIMEOUT_MS);
  if (result.exitCode !== 0) throw hostFailure(run, host, result, "read its snapshots");
  if (/^no-drill$/m.test(result.stdout)) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `The app's ${SNAPSHOT_SCRIPT} ${host.where} is from before restore drills, so OpsCrew can't run one there yet. ${NOTHING_CHANGED}`,
      {
        hint: `Deploy the app again (push to ${run.plan.cicd.branch}, or run \`opscrew provision${run.flags}\`), which uploads the new one, then try again.`,
      },
    );
  }
  const kept = /^kept ([0-9A-Za-z]+)$/m.exec(result.stdout)?.[1];
  return {
    stdout: result.stdout,
    running: runningVersion(plan, result.stdout),
    ...(kept === undefined ? {} : { kept }),
    left: /^drill-left$/m.test(result.stdout),
  };
}

/** What of the rendered copy's `compose.yaml` its approval reads. */
interface CopyCompose {
  services?: Record<string, { healthcheck?: unknown; volumes?: string[] }>;
  volumes?: Record<string, unknown>;
}

/** The volumes and folders the rendered copy's Compose file `document` makes. */
function madeByCopy(plan: DeployPlan, document: CopyCompose): string[] {
  const project = drillName(plan.app.name);
  const folders = Object.values(document.services ?? {}).flatMap((service) =>
    (service.volumes ?? [])
      .map((mount) => mount.split(":")[0] ?? "")
      .filter((source) => source.startsWith(`/srv/data/${project}/`)),
  );
  return [
    ...Object.keys(document.volumes ?? {}).map((volume) => `the volume ${project}_${volume}`),
    ...[...new Set(folders)].map((folder) => `the folder ${folder}`),
  ];
}

/** The drill's facts that its approval's words and hash cover. */
interface DrillPlanned {
  about: About;
  /** `about.json`'s bytes, as read. */
  text: string;
  parts: SnapshotPart[];
  image: string;
  /** The image is on the machine; otherwise the drill pulls it first. */
  imageHere: boolean;
  files: RenderedFile[];
  valueNames: string[];
  request: DrillRequest;
}

/**
 * The SHA-256 a drill's approval is bound to: the environment, the snapshot's id and `about.json`
 * bytes, and the drill's settings (what it restores, keeps and runs, and every file of the copy).
 * `.env.preview`'s values are not in it: they reach the machine only on the drill's stdin.
 */
export function drillHash(run: SnapshotRun, input: DrillPlanned): string {
  return sha256Hex(
    canonicalJson({
      environment: run.environment,
      kind: "drill",
      id: input.about.id,
      about: input.text,
      action: input.request.keep === true ? "keep" : "drill",
      only: input.request.only ?? "",
      allowOtherVersion: input.request.allowOtherVersion === true,
      image: input.image,
      parts: input.parts.map((part) => part.name),
      files: input.files.map((file) => ({ path: file.path, content: file.content })),
    }),
  );
}

/**
 * Asks the drill's approval, like a destroy (`allowDestroy`, `<app>-drill` typed: `--confirm`
 * with `--approve <hash>` in a script), its words the drill's plan: the snapshot, the project, the
 * volumes it creates and removes, the memory, the network, the image, the health check and its
 * bounds.
 * @throws OpsCrewError `APPROVAL_REFUSED` when it is not given.
 */
async function approveDrill(
  run: SnapshotRun,
  host: ScriptHost,
  planned: DrillPlanned,
): Promise<void> {
  const { deps, plan, environment, flags } = run;
  const { about, parts, request } = planned;
  const { id } = about;
  const name = drillName(plan.app.name);
  const hash = drillHash(run, planned);
  const local = host.local;
  const compose = parse(
    planned.files.find((file) => file.path.endsWith("/compose.yaml"))?.content ?? "",
  ) as CopyCompose;
  const common = drillApprovalLines({
    plan,
    parts,
    checked: compose.services?.app?.healthcheck !== undefined,
    valueNames: planned.valueNames,
  });
  const prefix = `${drillDir(id)}/`;
  const kept = request.keep === true;
  const lines = [
    `The drill restores the snapshot ${id} (${KIND_WORDS[about.kind]}, ${formatUtc(about.taken)}) ${host.where} into a throwaway copy, starts the app on it and checks it${kept ? ", then keeps the copy for you to look at" : ", then removes the copy"}.`,
    `  Snapshot: ${id}${about.version === "" ? "" : `, version ${shortDigest(about.version)}`}: ${listText(parts.map(partWords))}, read in place and read-only.`,
    `  Project: ${name}, in ${local ? `${prefix} of the app's folder on this computer` : `${appDir(plan)}/${prefix}`} (${listText([...planned.files.map((file) => file.path.slice(prefix.length)), ...(planned.valueNames.length === 0 ? [] : [DRILL_VALUES_FILE])])}).`,
    `  It creates and removes: ${listText(["the project's containers and network", ...madeByCopy(plan, compose)])}${kept ? "; with --keep they stay until `opscrew restore --drill --remove`" : ""}.`,
    `${common.memory}; with less free memory the drill is skipped.`,
    "  Network: one network with no internet (internal), no published port, no hostname, record or site; the machine checks it before any data goes in, and removes the copy at once if it isn't so.",
    `  Image: ${planned.image}, ${request.allowOtherVersion === true ? "the version that runs now (--allow-other-version)" : "the snapshot's version"}${planned.imageHere ? "" : `; it is not ${host.where}, so the drill pulls it first with the machine's own login`}.`,
    common.health,
    ...common.values,
    `Its bounds, which ${SNAPSHOT_SCRIPT} keeps itself: only the names ${name} and .drill/, never production's containers, volumes or .env; skipped while a deploy, a snapshot or a restore runs, or with too little disk or memory; at most ${DRILL_LIMIT_SECONDS / 60} minutes, then the copy is removed.`,
    `Typing ${name} approves it. OpsCrew then leaves a one-time approval in the app's folder ${host.where}, valid for ${APPROVAL_SECONDS / 60} minutes, which the drill uses once.`,
    `Drill hash: ${hash}`,
  ];
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Run a restore drill of the snapshot ${id} of ${environment} ${host.where}`,
    details: lines.join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: name,
  });
  if (approval.approved) return;
  throw typedApprovalRefused(
    `The drill of the snapshot ${id} did not run`,
    approval.reason,
    drillCommandText(flags, { ...request, id }),
    name,
    hash,
  );
}

/**
 * `command` after the drill's one-time approval `line`, written in the app's folder as the deploy
 * user's, in one session with `command`'s stdin; the approval file goes again when they did not end
 * well, should `command` not have read it.
 */
function approvedCommand(line: string, command: string): string {
  const file = DRILL_APPROVAL_FILE;
  return [
    `(umask 077 && printf '%s\\n' ${shellQuote(line)} > ${file} && chmod 600 ${file}) || { c=$?; rm -f ${file}; exit "$c"; }`,
    `(${command})`,
    "c=$?",
    `if [ "$c" -ne 0 ]; then rm -f ${file}; fi`,
    'exit "$c"',
  ].join("; ");
}

/** A machine that threw, as one that did not answer. */
function unanswered(error: unknown): CommandResult {
  return { exitCode: 255, stdout: "", stderr: String(error) };
}

/**
 * `snapshot.sh drill` on `host` for `action` after its one-time approval, in one session
 * ({@link approvedCommand}): the drill of the snapshot `id` (`--only`, `--keep` with `keep`),
 * `input` on its stdin, or `--remove`; audited as `audit` (`<id>: <parts>: <outcome>`).
 */
async function runDrill(
  run: SnapshotRun,
  host: ScriptHost,
  o: (
    | { action: Exclude<DrillAction, "remove">; id: string; only?: string; input: string }
    | { action: "remove" }
  ) & { audit: (result: CommandResult) => string },
): Promise<CommandResult> {
  const { deps } = run;
  const expiresAt = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
  const line = drillApprovalLine(
    o.action === "remove"
      ? { action: o.action, expiresAt }
      : {
          id: o.id,
          action: o.action,
          expiresAt,
          ...(o.only === undefined ? {} : { only: o.only }),
        },
  );
  const args =
    o.action === "remove"
      ? ["--remove"]
      : [
          o.id,
          ...(o.only === undefined ? [] : ["--only", o.only]),
          ...(o.action === "keep" ? ["--keep"] : []),
        ];
  const result = await host
    .run(
      approvedCommand(line, scriptCommand(["drill", ...args])),
      DRILL_TIMEOUT_MS,
      o.action === "remove" ? undefined : o.input,
    )
    .catch(async (error: unknown) => {
      // The session broke: its approval goes in a session of its own.
      await host.run(`rm -f ${DRILL_APPROVAL_FILE}`, READ_TIMEOUT_MS).catch(() => undefined);
      return unanswered(error);
    });
  await deps.audit
    .append({
      kind: "remote-exec",
      actor: "opscrew",
      action: o.action === "remove" ? "remove a restore drill's copy" : "run a restore drill",
      target: host.audit,
      decision: "approved",
      detail: o.audit(result),
    })
    .catch((error: unknown) => {
      deps.reporter.warn(
        `OpsCrew could not write the drill ${host.where} in its audit log: ${deps.redactor.redact(errorMessage(error))}`,
      );
    });
  return result;
}

/** The copy's stdin: its image, then each file of the copy and `values.env`, base64. */
function drillInput(id: string, image: string, files: readonly RenderedFile[], values: string) {
  const prefix = `${drillDir(id)}/`;
  const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  return [
    `image ${image}`,
    ...files.map((file) => `file ${file.path.slice(prefix.length)} ${base64(file.content)}`),
    ...(values === "" ? [] : [`file ${DRILL_VALUES_FILE} ${base64(values)}`]),
    "",
  ].join("\n");
}

/** Whether `image` is on `host` (read-only). */
async function imageHere(run: SnapshotRun, host: ScriptHost, image: string): Promise<boolean> {
  const result = await host.run(
    `if docker image inspect ${shellQuote(image)} > /dev/null 2>&1; then echo image-here; fi`,
    READ_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) throw hostFailure(run, host, result, "read the app's images");
  return /^image-here$/m.test(result.stdout);
}

/** The drill of `request` on a server or this computer (see the module's comment). */
async function drillOn(
  run: SnapshotRun,
  host: ScriptHost,
  request: DrillRequest,
  target: DrillTarget,
): Promise<DrillReport> {
  const { deps, plan, flags } = run;
  const name = drillName(plan.app.name);
  // 1. What the machine holds and runs, read-only.
  const read = await probe(run, host, request.allowOtherVersion === true);
  if (read.kept !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A kept copy of the snapshot ${read.kept} is still ${host.where}, from a drill with --keep, so OpsCrew starts no other drill. ${NOTHING_CHANGED}`,
      {
        hint: `Remove it with \`${drillCommandText(flags, { remove: true })}\`, then run the drill again.`,
      },
    );
  }
  const { about, text } = pickSnapshot(run, read.stdout, request.id, host.where);
  const parts = pickParts(run, snapshotParts(plan), about, request.only);
  const image = await drillImage(run, about, request, read.running, {
    why: "No container of the app runs with an image OpsCrew can pin",
    fix: "Start the app or deploy it",
  });
  const here = await imageHere(run, host, image);
  if (!here && image.startsWith("opscrew-local/")) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `That snapshot's version of the app is gone from this computer: its local build (image ${shortDigest(about.version)}) was removed, so OpsCrew can't start a copy of it. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`${drillCommandText(flags, { ...request, id: about.id, allowOtherVersion: true })}\` to start today's build on it.`,
      },
    );
  }
  // 2. The copy, rendered here; its plan approved by its hash.
  const snapshot = { id: about.id, parts: parts.map((part) => part.name) };
  const env = await drillEnvFor(deps, drillPlan(plan, snapshot));
  const files = renderDrill(plan, snapshot, {
    image,
    env: env.templates,
    previewValues: env.values !== "",
  });
  const planned: DrillPlanned = {
    about,
    text,
    parts,
    image,
    imageHere: here,
    files,
    valueNames: env.names,
    request,
  };
  await approveDrill(run, host, planned);
  // 3. The machine's drill, which keeps the bounds itself.
  deps.reporter.step(`Running the restore drill of the snapshot ${about.id} ${host.where}`);
  const names = parts.map((part) => part.name);
  const result = await runDrill(run, host, {
    id: about.id,
    action: request.keep === true ? "keep" : "drill",
    ...(request.only === undefined ? {} : { only: request.only }),
    input: drillInput(about.id, image, files, env.values),
    audit: (done) => {
      const [record] = drillRecordsIn(done.stdout);
      return `${about.id}: ${names.join(", ")}: ${record?.result ?? `exit code ${done.exitCode}`}`;
    },
  });
  const [record] = drillRecordsIn(result.stdout);
  if (record === undefined) {
    throw hostFailure(run, host, result, `run the drill of the snapshot ${about.id}`);
  }
  // 4. The report: one line per step, then the outcome in plain words.
  const words = partWordsOf(parts);
  for (const step of drillSteps(record, words)) deps.reporter.step(step);
  const report = drillReport(record, {
    id: about.id,
    flags,
    ownLogins: ownLogins(parts),
    where: host.where,
    target,
    app: plan.app.name,
  });
  const remove = drillCommandText(flags, { remove: true });
  if (record.removal === "kept") {
    deps.reporter.info(
      `The copy stays ${host.where} as the Compose project ${name}, in ${drillProject(plan, about.id).file.replace(/\/compose\.yaml$/, "/")} of the app's folder: \`${remove}\` removes it.`,
    );
  }
  if (record.removal === "failed") {
    deps.reporter.warn(
      `OpsCrew could not remove every part of the copy ${host.where}: run \`${remove}\`.`,
    );
  }
  if (record.result === "healthy") {
    deps.reporter.success(report.summary);
    deps.reporter.info(`What it proves: ${report.proves}.`);
  } else {
    deps.reporter.warn(report.summary);
  }
  return report;
}

/** `opscrew restore --drill --remove` on a server or this computer: a kept copy goes. */
async function removeOn(run: SnapshotRun, host: ScriptHost): Promise<DrillReport> {
  const { deps, plan, environment, flags } = run;
  const name = drillName(plan.app.name);
  const read = await probe(run, host);
  const base = {
    where: host.where,
    proves: "",
    parts: [],
    tables: [],
    ownLogins: [],
    ...(read.kept === undefined ? {} : { id: read.kept }),
  };
  if (!read.left) {
    const summary = `There is no drill's copy ${host.where}. ${NOTHING_CHANGED}`;
    deps.reporter.info(summary);
    return { ...base, outcome: "none", summary };
  }
  const what =
    read.kept === undefined
      ? "what a drill that stopped left"
      : `the kept copy of the snapshot ${read.kept}`;
  const hash = sha256Hex(
    canonicalJson({ environment, kind: "drill-remove", kept: read.kept ?? "" }),
  );
  const local = host.local;
  const approval = await deps.approvals.request({
    kind: "remote-exec",
    title: `Remove the restore drill's copy of ${environment} ${host.where}`,
    details: [
      `It removes ${what} ${host.where}: the Compose project ${name} with its containers, networks and volumes${local ? "" : `, /srv/data/${name}/`} and .drill/ in the app's folder, with the copy's data.`,
      "Production's containers, volumes and data are not touched.",
      `Typing ${name} approves it.`,
      `Removal hash: ${hash}`,
    ].join("\n"),
    planHash: hash,
    allowDestroy: true,
    confirmPhrase: name,
  });
  if (!approval.approved) {
    throw typedApprovalRefused(
      "The drill's copy was not removed",
      approval.reason,
      drillCommandText(flags, { remove: true }),
      name,
      hash,
    );
  }
  deps.reporter.step(`Removing the drill's copy ${host.where}`);
  const result = await runDrill(run, host, {
    action: "remove",
    audit: (done) =>
      `${read.kept ?? "-"}: ${/^drill-removal (\w+)$/m.exec(done.stdout)?.[1] ?? `exit code ${done.exitCode}`}`,
  });
  const removal = /^drill-removal (removed|none|failed)$/m.exec(result.stdout)?.[1];
  if (removal === "removed" || removal === "none") {
    const summary = `Removed the drill's copy ${host.where}.`;
    deps.reporter.success(summary);
    return {
      ...base,
      outcome: removal === "none" ? "none" : "removed",
      removal: "removed",
      summary,
    };
  }
  throw hostFailure(run, host, result, "remove the drill's copy");
}

/** A drill's option, by its flag's name. */
type DrillOption = "keep" | "remove" | "only" | "allow-other-version";

/** Whether `request` gives each option. */
const GIVEN: Record<DrillOption, (request: DrillRequest) => boolean> = {
  keep: (request) => request.keep === true,
  remove: (request) => request.remove === true,
  only: (request) => request.only !== undefined,
  "allow-other-version": (request) => request.allowOtherVersion === true,
};

/** Why a drill on a hosting account has no copy to keep or remove. */
const NO_COPY = (what: "keep" | "remove") =>
  `A drill on a hosting account leaves no copy to ${what}: it empties the drill database again at its end.`;

/**
 * The options a target's drill doesn't take, in the order they are checked, each with why, and
 * the refusal's code and hint; a server's and this computer's take every one.
 */
const NOT_TAKEN: Record<
  "portainer" | "hosting",
  {
    code: "PHASE_PRECONDITION" | "INVALID_INPUT";
    why: Partial<Record<DrillOption, string>>;
    hint: (flags: string, request: DrillRequest, option: DrillOption) => string;
  }
> = {
  portainer: {
    code: "PHASE_PRECONDITION",
    why: {
      keep: "A drill in your Portainer always removes its copy when it ends, so --keep doesn't apply there.",
      remove:
        "A drill in your Portainer always removes its copy when it ends, so --remove doesn't apply there.",
    },
    hint: (flags) =>
      `Run \`${drillCommandText(flags)}\` without it; a drill that stopped halfway is removed by the next one.`,
  },
  hosting: {
    code: "INVALID_INPUT",
    why: {
      keep: NO_COPY("keep"),
      remove: NO_COPY("remove"),
      only: "--only drills one service of a server's snapshot; on a hosting account a drill checks the dump and the shared files together.",
      "allow-other-version":
        "--allow-other-version starts today's version of the app on a server's copy; on a hosting account a drill starts no app.",
    },
    hint: (flags, request, option) =>
      `Run \`${drillCommandText(flags, { ...(request.id === undefined ? {} : { id: request.id }) })}\` without --${option}.`,
  },
};

/**
 * Refuses, before any change, an option of `request` the drill on `target` doesn't take.
 * @throws OpsCrewError with the target's code ({@link NOT_TAKEN}).
 */
function refuseOptions(run: SnapshotRun, target: keyof typeof NOT_TAKEN, request: DrillRequest) {
  const { code, why, hint } = NOT_TAKEN[target];
  const option = (Object.keys(why) as DrillOption[]).find((each) => GIVEN[each](request));
  if (option === undefined) return;
  throw new OpsCrewError(code, `${why[option]} ${NOTHING_CHANGED}`, {
    hint: hint(run.flags, request, option),
  });
}

/**
 * `opscrew restore --drill` on the environment `deps` belong to (see the module's comment): the
 * snapshot `id`, the latest by default. Refused, before any change, on a target without snapshots,
 * while a deploy or a move runs, with a kept copy there, for a snapshot or part it doesn't have, a
 * version it can't start, and when the approval is not given; otherwise its outcome, which
 * `outcome` tells apart: a drill that failed or was skipped is a report, not an error.
 * @throws OpsCrewError `INVALID_INPUT` for an id that isn't letters and digits or a wrong `--only`,
 * `PHASE_PRECONDITION` for each refusal, `APPROVAL_REFUSED`, and `COMMAND_FAILED` when the machine
 * did not answer or the drill could not start.
 */
export async function drillSnapshot(
  deps: PhaseDeps,
  id: string | undefined,
  options: DrillSnapshotOptions = {},
): Promise<DrillReport> {
  const { services = {}, ...rest } = options;
  const request: DrillRequest = { ...(id === undefined ? {} : { id }), ...rest };
  const run = await snapshotRun(deps, services);
  const { plan, environment } = run;
  if (isHostingTarget(plan.target)) {
    if (plan.target.panel === "sftp") {
      throw new OpsCrewError(
        "PHASE_PRECONDITION",
        `${environment} is on an SFTP host, where no agent of OpsCrew's runs to take snapshots, so there is none to drill. ${NOTHING_CHANGED}`,
        {
          hint: "Copy the app's shared files over SFTP, and back up the database where your host keeps it.",
        },
      );
    }
    refuseOptions(run, "hosting", request);
    // A hosting account's ids (snapshot-<time>, a release's) are checked by its own drill.
    return drillOnHosting(run, request);
  }
  if (id !== undefined) requireSnapshotId(id);
  const target = snapshotTarget(run);
  if (target === "portainer") {
    refuseOptions(run, "portainer", request);
    return drillInPortainer(run, request);
  }
  await requireNoDeployOrMove(run, "run a restore drill");
  if (snapshotParts(plan, APP_SERVER).length === 0) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `${environment} keeps no data ${target === "computer" ? "on this computer" : "on the app's server"}, so there is nothing to drill there. ${NOTHING_CHANGED}`,
      {
        hint: "A drill runs where the snapshot is, beside the app; the parts on the app's other servers are not drilled.",
      },
    );
  }
  const host = (await dataHosts(run, [APP_SERVER])).get(APP_SERVER) as ScriptHost;
  if (request.remove === true) return removeOn(run, host);
  return drillOn(run, host, request, target === "computer" ? "computer" : "server");
}
