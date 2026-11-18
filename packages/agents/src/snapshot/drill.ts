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
import { join } from "node:path";
import type { CommandResult } from "@opscrew/contracts";
import {
  canonicalJson,
  errorMessage,
  listText,
  OpsCrewError,
  readTextIfExists,
  sha256Hex,
} from "@opscrew/core";
import {
  appDir,
  DRILL_APPROVAL_FILE,
  DRILL_LIMIT_SECONDS,
  DRILL_RECORD_PREFIX,
  DRILL_VALUES_FILE,
  type DrillAction,
  drillApprovalLine,
  drillDir,
  drillPlan,
  drillProject,
  drillRecord,
  localBuildImage,
  localComposeProject,
  type RenderedFile,
  renderDrill,
  SNAPSHOT_SCRIPT,
  type SnapshotPart,
  shellQuote,
  snapshotParts,
} from "@opscrew/iac-templates";
import { APP_SERVER, type DeployPlan, ghcrImageFor, isHostingTarget } from "@opscrew/plan-schema";
import { formatUtc } from "@opscrew/secops";
import { parse } from "yaml";
import type { PhaseDeps } from "../context";
import { NOTHING_CHANGED } from "../promote/shared";
import { serviceEnvFiles } from "../provision/secrets";
import { APPROVAL_SECONDS } from "../rollback/database";
import { shortDigest } from "../rollback/versions";
import { gitClient, githubCoordinates } from "../shared";
import { assembleAppEnv, dotenvLine } from "../shared/app-env";
import { drillOnHosting } from "./drill-hosting";
import { drillInPortainer } from "./drill-portainer";
import { type DrillTarget, drillReport, drillSteps } from "./drill-report";
import { dataHosts, hostFailure, READ_TIMEOUT_MS, type ScriptHost, scriptCommand } from "./hosts";
import { recordOf } from "./restore";
import { partWords } from "./restore-checks";
import { requireNoDeployOrMove, type SnapshotRun, snapshotRun, snapshotTarget } from "./run";
import { type About, KIND_WORDS, readListing, requireSnapshotId } from "./store";
import type { DrillReport, DrillRequest, DrillSnapshotOptions } from "./types";

/** The file the copy's own values come from: the previews', never prod's `.env` (research R16). */
export const PREVIEW_VALUES_FILE = ".env.preview";

/** How long the machine's drill may take: its own limit and the time to remove the copy. */
const DRILL_TIMEOUT_MS = (DRILL_LIMIT_SECONDS + 5 * 60) * 1000;

/** The words the approval and the hints use for the drill's command. */
function drillCommandText(run: SnapshotRun, id: string | undefined, request: DrillRequest): string {
  return [
    "opscrew restore --drill",
    ...(id === undefined ? [] : [id]),
    ...(request.only === undefined ? [] : [`--only ${request.only}`]),
    ...(request.keep === true ? ["--keep"] : []),
    ...(request.allowOtherVersion === true ? ["--allow-other-version"] : []),
  ]
    .join(" ")
    .concat(run.flags);
}

/** What one machine says before the approval, read-only. */
interface Probe {
  stdout: string;
  abouts: About[];
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
  const name = `${plan.app.name}-drill`;
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
    abouts: readListing(result.stdout).abouts,
    running: runningVersion(plan, result.stdout),
    ...(kept === undefined ? {} : { kept }),
    left: /^drill-left$/m.test(result.stdout),
  };
}

/** The snapshot `id`, or the newest complete one, with its `about.json` bytes. */
function chooseSnapshot(
  run: SnapshotRun,
  host: ScriptHost,
  read: Probe,
  id: string | undefined,
): { about: About; text: string } {
  const newest = [...read.abouts].sort((a, b) => b.taken.localeCompare(a.taken))[0];
  const chosen = id === undefined ? newest : read.abouts.find((about) => about.id === id);
  const record = chosen === undefined ? undefined : recordOf(read.stdout, chosen.id).record;
  if (record !== undefined) return record;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    id === undefined
      ? `There is no snapshot ${host.where} yet, so there is nothing to drill. ${NOTHING_CHANGED}`
      : `There is no snapshot ${id} ${host.where}. ${NOTHING_CHANGED}`,
    {
      hint:
        id === undefined
          ? `Take one with \`opscrew snapshot${run.flags}\`, then run the drill.`
          : `\`opscrew snapshot list${run.flags}\` shows the snapshots.`,
    },
  );
}

/**
 * The parts the copy restores: those the snapshot holds a copy of that the plan still has where
 * the drill runs, only `only` with `--only`.
 */
function chooseParts(
  run: SnapshotRun,
  about: About,
  planParts: readonly SnapshotPart[],
  only: string | undefined,
): SnapshotPart[] {
  if (only !== undefined && !planParts.some((part) => part.name === only)) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `${only} is no service with data in ${run.environment}. ${NOTHING_CHANGED}`,
      {
        hint: `Name one of ${listText(planParts.map((part) => part.name))} with --only, or leave it out.`,
      },
    );
  }
  const copied = new Set(
    about.services.filter((entry) => "file" in entry).map((entry) => entry.name),
  );
  const parts = planParts.filter(
    (part) => copied.has(part.name) && (only === undefined || part.name === only),
  );
  if (parts.length > 0) return parts;
  throw new OpsCrewError(
    "PHASE_PRECONDITION",
    `The snapshot ${about.id} holds no copy of ${only ?? `any part ${run.environment} has now`}, so there is nothing to drill. ${NOTHING_CHANGED}`,
    { hint: `\`opscrew snapshot list${run.flags}\` shows what each snapshot holds.` },
  );
}

/**
 * The image the copy runs: the snapshot's version, or with `--allow-other-version` the one that
 * runs now; a local build's tag on this computer, else the app's image on GHCR by its digest.
 */
async function drillImage(
  run: SnapshotRun,
  about: About,
  running: string,
  request: DrillRequest,
): Promise<string> {
  const { deps, plan } = run;
  const allow = request.allowOtherVersion === true;
  const version = allow ? running : about.version;
  if (version === "") {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      allow
        ? `No container of the app runs with an image OpsCrew can pin, so there is no version of today's to run the copy of the snapshot ${about.id} with. ${NOTHING_CHANGED}`
        : `The snapshot ${about.id} records no version (it was taken before a first deploy, or with an older OpsCrew), so OpsCrew can't tell which version of the app to start on it. ${NOTHING_CHANGED}`,
      allow
        ? {
            hint: `Start the app or deploy it, then try again; or drill the snapshot with its own version: \`${drillCommandText(run, about.id, { ...request, allowOtherVersion: false })}\`.`,
          }
        : {
            hint: `Run \`${drillCommandText(run, about.id, { ...request, allowOtherVersion: true })}\` to start today's version on it.`,
          },
    );
  }
  const hex = version.slice("sha256:".length);
  if (plan.target.provider === "localhost" && plan.target.image === "local-build") {
    return localBuildImage(plan, hex);
  }
  const { owner, repo } = await githubCoordinates(gitClient(deps));
  return `${ghcrImageFor(`${owner}/${repo}`, plan.app.key)}@sha256:${hex}`;
}

/** The copy's env files and `.env.preview`'s values, which the redactor knows from here on. */
async function drillEnv(deps: PhaseDeps, drill: DeployPlan) {
  const dotenvText = await readTextIfExists(join(deps.paths.root, PREVIEW_VALUES_FILE));
  const env = await assembleAppEnv({
    plan: drill,
    ...(dotenvText === undefined ? {} : { dotenvText }),
    previewTemplates: true,
  });
  const own = env.preview?.values ?? {};
  for (const value of Object.values(own)) deps.redactor.addLiteral(value, "preview-value");
  const names = Object.keys(own).sort();
  return {
    templates: { app: env.appEnv, services: serviceEnvFiles(drill, env) },
    values: names.map((name) => `${dotenvLine(name, own[name] as string)}\n`).join(""),
    names,
  };
}

/** The volumes and folders the rendered copy's Compose file makes (`compose.yaml` of `files`). */
function madeByCopy(plan: DeployPlan, files: readonly RenderedFile[]): string[] {
  const project = `${plan.app.name}-drill`;
  const file = files.find((each) => each.path.endsWith("/compose.yaml"));
  const document = parse(file?.content ?? "") as {
    services?: Record<string, { volumes?: string[] }>;
    volumes?: Record<string, unknown>;
  };
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
  id: string;
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
      id: input.id,
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

/** Restored services of the stop-only kinds, whose copied files keep production's logins. */
function ownLogins(parts: readonly SnapshotPart[]): string[] {
  return parts
    .filter((part) => !part.online && part.kind !== "sqlite" && part.kind !== "files")
    .map((part) => part.name);
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
  const { deps, plan, environment } = run;
  const { id, about, parts, request } = planned;
  const name = `${plan.app.name}-drill`;
  const hash = drillHash(run, planned);
  const local = host.local;
  const compose = parse(
    planned.files.find((file) => file.path.endsWith("/compose.yaml"))?.content ?? "",
  ) as { services?: Record<string, { healthcheck?: unknown }> };
  const checked = compose.services?.app?.healthcheck !== undefined;
  const databases = parts.filter((part) =>
    ["postgres", "mysql", "mariadb", "mongodb"].includes(part.kind),
  );
  const limits = [
    { name: "the app", mb: plan.app.memoryMb },
    ...plan.services
      .filter((service) => parts.some((part) => part.name === service.name))
      .map((service) => ({ name: service.name, mb: service.memoryMb })),
  ];
  const total = limits.reduce((sum, limit) => sum + limit.mb, 0);
  const prefix = `${drillDir(id)}/`;
  const logins = ownLogins(parts);
  const kept = request.keep === true;
  const lines = [
    `The drill restores the snapshot ${id} (${KIND_WORDS[about.kind]}, ${formatUtc(about.taken)}) ${host.where} into a throwaway copy, starts the app on it and checks it${kept ? ", then keeps the copy for you to look at" : ", then removes the copy"}.`,
    `  Snapshot: ${id}${about.version === "" ? "" : `, version ${shortDigest(about.version)}`}: ${listText(parts.map(partWords))}, read in place and read-only.`,
    `  Project: ${name}, in ${local ? `${prefix} of the app's folder on this computer` : `${appDir(plan)}/${prefix}`} (${listText([...planned.files.map((file) => file.path.slice(prefix.length)), ...(planned.valueNames.length === 0 ? [] : [DRILL_VALUES_FILE])])}).`,
    `  It creates and removes: ${listText(["the project's containers and network", ...madeByCopy(plan, planned.files)])}${kept ? "; with --keep they stay until `opscrew restore --drill --remove`" : ""}.`,
    `  Memory: ${listText(limits.map((limit) => `${limit.name} ${limit.mb} MB`))} (${total} MB in all); with less free memory the drill is skipped.`,
    "  Network: one network with no internet (internal), no published port, no hostname, record or site; the machine checks it before any data goes in, and removes the copy at once if it isn't so.",
    `  Image: ${planned.image}, ${request.allowOtherVersion === true ? "the version that runs now (--allow-other-version)" : "the snapshot's version"}${planned.imageHere ? "" : `; it is not ${host.where}, so the drill pulls it first with the machine's own login`}.`,
    `  Health check: ${checked ? `the app's own health check (${plan.app.healthPath}) until healthy, at most 5 minutes` : "the app has none, so it must still run after 60 seconds"}${databases.length === 0 ? "" : `; then ${listText(databases.map((part) => part.name))} must answer and hold at least one table`}.`,
    "The copy runs with no internet and without your production `.env`. The app may need some values to start; add them to `.env.preview` with test values.",
    planned.valueNames.length === 0
      ? "There are no values in .env.preview: the app gets only its plain settings and the copy's own new passwords."
      : `Values from .env.preview (names only): ${listText(planned.valueNames)}.`,
    ...(logins.length === 0
      ? []
      : [
          `${listText(logins)} ${logins.length === 1 ? "is" : "are"} restored from a copy of ${logins.length === 1 ? "its" : "their"} files, which keeps production's logins, so the copy can't sign in to ${logins.length === 1 ? "it" : "them"}.`,
        ]),
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
  throw new OpsCrewError(
    "APPROVAL_REFUSED",
    `The drill of the snapshot ${id} did not run${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
    {
      hint: `Run \`${drillCommandText(run, id, request)}\` again and type ${name} (in a script: --confirm ${name} --approve ${hash}).`,
    },
  );
}

/** The one-time approval of the drill, written in the app's folder as the deploy user's. */
function approvalCommand(line: string): string {
  const file = DRILL_APPROVAL_FILE;
  return `umask 077 && printf '%s\\n' ${shellQuote(line)} > ${file} && chmod 600 ${file}`;
}

/** A machine that threw, as one that did not answer. */
function unanswered(error: unknown): CommandResult {
  return { exitCode: 255, stdout: "", stderr: String(error) };
}

/**
 * `snapshot.sh drill <args>` on `host` after its one-time approval for `action`, `input` on its
 * stdin, audited as `audit` (`<id>: <parts>: <outcome>`); the approval file goes when the drill did
 * not end well, should it not have been read.
 */
async function runDrill(
  run: SnapshotRun,
  host: ScriptHost,
  o: {
    id?: string;
    action: DrillAction;
    only?: string;
    args: string[];
    input?: string;
    audit: (result: CommandResult) => string;
  },
): Promise<CommandResult> {
  const { deps } = run;
  const expiresAt = Math.floor(deps.clock.now().getTime() / 1000) + APPROVAL_SECONDS;
  const line = drillApprovalLine({
    ...(o.id === undefined ? {} : { id: o.id }),
    action: o.action,
    expiresAt,
    ...(o.only === undefined ? {} : { only: o.only }),
  });
  let result: CommandResult | undefined;
  try {
    const written = await host.run(approvalCommand(line), READ_TIMEOUT_MS);
    result =
      written.exitCode === 0
        ? await host
            .run(scriptCommand(["drill", ...o.args]), DRILL_TIMEOUT_MS, o.input)
            .catch(unanswered)
        : written;
  } finally {
    if (result?.exitCode !== 0) {
      await host.run(`rm -f ${DRILL_APPROVAL_FILE}`, READ_TIMEOUT_MS).catch(() => undefined);
    }
  }
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
  const name = `${plan.app.name}-drill`;
  // 1. What the machine holds and runs, read-only.
  const read = await probe(run, host, request.allowOtherVersion === true);
  if (read.kept !== undefined) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `A kept copy of the snapshot ${read.kept} is still ${host.where}, from a drill with --keep, so OpsCrew starts no other drill. ${NOTHING_CHANGED}`,
      {
        hint: `Remove it with \`opscrew restore --drill --remove${flags}\`, then run the drill again.`,
      },
    );
  }
  const { about, text } = chooseSnapshot(run, host, read, request.id);
  const parts = chooseParts(run, about, snapshotParts(plan), request.only);
  const image = await drillImage(run, about, read.running, request);
  const here = await imageHere(run, host, image);
  if (!here && image.startsWith("opscrew-local/")) {
    throw new OpsCrewError(
      "PHASE_PRECONDITION",
      `That snapshot's version of the app is gone from this computer: its local build (image ${shortDigest(about.version)}) was removed, so OpsCrew can't start a copy of it. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`${drillCommandText(run, about.id, { ...request, allowOtherVersion: true })}\` to start today's build on it.`,
      },
    );
  }
  // 2. The copy, rendered here; its plan approved by its hash.
  const snapshot = { id: about.id, parts: parts.map((part) => part.name) };
  const env = await drillEnv(deps, drillPlan(plan, snapshot));
  const files = renderDrill(plan, snapshot, {
    image,
    env: env.templates,
    previewValues: env.values !== "",
  });
  const planned: DrillPlanned = {
    id: about.id,
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
    args: [
      about.id,
      ...(request.only === undefined ? [] : ["--only", request.only]),
      ...(request.keep === true ? ["--keep"] : []),
    ],
    input: drillInput(about.id, image, files, env.values),
    audit: (done) => {
      const record = recordIn(done);
      return `${about.id}: ${names.join(", ")}: ${record?.result ?? `exit code ${done.exitCode}`}`;
    },
  });
  const record = recordIn(result);
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
  if (record.removal === "kept") {
    deps.reporter.info(
      `The copy stays ${host.where} as the Compose project ${name}, in ${drillProject(plan, about.id).file.replace(/\/compose\.yaml$/, "/")} of the app's folder: \`opscrew restore --drill --remove${flags}\` removes it.`,
    );
  }
  if (record.removal === "failed") {
    deps.reporter.warn(
      `OpsCrew could not remove every part of the copy ${host.where}: run \`opscrew restore --drill --remove${flags}\`.`,
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

/** Each part's words by its name. */
function partWordsOf(parts: readonly SnapshotPart[]): (name: string) => string {
  return (name) => {
    const part = parts.find((each) => each.name === name);
    return part === undefined ? name : partWords(part);
  };
}

/** The drill's record on the machine's stdout, if it printed one. */
function recordIn(result: CommandResult) {
  const line = result.stdout
    .split(/\r?\n/)
    .find((each) => each.startsWith(DRILL_RECORD_PREFIX))
    ?.slice(DRILL_RECORD_PREFIX.length);
  return line === undefined ? undefined : drillRecord(line);
}

/** `opscrew restore --drill --remove` on a server or this computer: a kept copy goes. */
async function removeOn(run: SnapshotRun, host: ScriptHost): Promise<DrillReport> {
  const { deps, plan, environment, flags } = run;
  const name = `${plan.app.name}-drill`;
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
    throw new OpsCrewError(
      "APPROVAL_REFUSED",
      `The drill's copy was not removed${approval.reason === undefined ? "" : `: ${approval.reason}`}. ${NOTHING_CHANGED}`,
      {
        hint: `Run \`opscrew restore --drill --remove${flags}\` again and type ${name} (in a script: --confirm ${name} --approve ${hash}).`,
      },
    );
  }
  deps.reporter.step(`Removing the drill's copy ${host.where}`);
  const result = await runDrill(run, host, {
    action: "remove",
    args: ["--remove"],
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
  if (id !== undefined) requireSnapshotId(id);
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
    return drillOnHosting(run, services, request);
  }
  const target = snapshotTarget(run);
  if (target === "portainer") return drillInPortainer(run, services, request);
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
