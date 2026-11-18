/**
 * What feature 024's live passes (`snapshots.test.ts`) need on top of the harness that reaches
 * servers, providers or GitHub:
 * - the example's data seeded, changed and read in the containers of the app's target;
 * - `opscrew snapshot list --json` and `opscrew restore` as a script runs them;
 * - the app named after the run, so every resource and the bucket are the run's own;
 * - the off-server copies' bucket read with the pinned rclone image in local Docker, and deleted
 *   explicitly at the end (deleting it is the user's job, not OpsCrew's); the user's own bucket
 *   created first; the user's SFTP machine read as root there;
 * - the whole-server snapshots OpsCrew took of the run's server at Hetzner, deleted if a run left
 *   any;
 * - the deploy jobs' logs in the leak search.
 * Nothing here prints a secret, a dumped value or an address: everything logged goes through the
 * run's scrubber.
 */
import { rm } from "node:fs/promises";
import {
  offsiteRclone,
  type ProviderBucket,
  RCLONE_NOT_FOUND,
  r2Endpoint,
  STORAGE_ENDPOINTS,
} from "@opscrew/agents";
import {
  appDir,
  DRILL_RECIPE_DIR,
  DRILL_RECIPE_SCHEDULE,
  DRILL_SLOT_AFTER_HOURS,
  DRILLS_LOG,
  type DrillRecord,
  drillRecord,
  drillScheduleHours,
  OFFSITE_LOG,
  OFFSITE_PREFIX,
  PORTAINER_VERSION_PATH,
  portainerSnapshotsVolume,
  RESTORED_IMAGE_FILE,
} from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { expect } from "vitest";
import { z } from "zod";
import {
  api,
  HETZNER_API,
  httpRequest,
  minutes,
  type RootShell,
  retryDelete,
  sleep,
  waitFor,
} from "./cloud";
import type { BucketPass, ServerExec } from "./component-checks";
import type { AppEnvironments } from "./environment-checks";
import type { CliRun, LiveRun } from "./harness";
import { jobLog } from "./portainer-cloud";
import { BUSYBOX_IMAGE } from "./portainer-support";
import { readData as readMovedData, seedData as seedMovedData } from "./retarget-anywhere-checks";
import { inContainer, MOVE_SERVICES, seedScripts } from "./retarget-anywhere-support";
import {
  changeScripts,
  copyWatchScript,
  drillTestDir,
  KAFKA_READ_SCRIPT,
  KAFKA_SERVICE,
  kafkaDigest,
  kafkaSeedScript,
  type ListedSnapshot,
  listedSnapshots,
  type OffsiteProvider,
  plantedFileScript,
  SFTP_MACHINE,
  SFTP_MACHINE_LABEL,
  type SnapshotData,
  SQLITE_CONTENT_SCRIPT,
  scheduledDrillScript,
  shownRestore,
  watchedCopy,
} from "./snapshots-support";
import { approveHashes, leakedLabels, printedHash, SERVER_DEPLOY_JOB } from "./support";

// ---------------------------------------------------------------------------------------------
// The run's own app name.

/**
 * After `analyze` (and the interview): the project's name in `opscrew/architecture.json` set to
 * the run's own, `e2e-snap-<run id>`, as design names the app after it, then `design`, which
 * must plan that name; then the zone's snapshot for the cleanup, taken under that name (the app's
 * hostname and `www.`). Returns prod's plan. The bucket, the snapshots' labels and every resource
 * are then the run's alone (examples/flask-sqlite has no project name, so OpsCrew would name it
 * after the checkout folder, the same in every run).
 */
export async function designRunApp(run: LiveRun, envs: AppEnvironments): Promise<DeployPlan> {
  const name = `e2e-snap-${run.runId}`;
  const file = run.paths().files.architecture;
  const architecture = await readArtifact("architecture", file);
  await writeArtifact("architecture", file, {
    ...architecture,
    facts: { ...architecture.facts, name },
  });
  // Design keeps an existing plan's app name, so the plan the first design wrote goes first.
  await rm(run.paths().files.plan, { force: true });
  await run.opscrewOk("design");
  const plan = await envs.designed("prod");
  if (plan.app.name !== name) {
    throw new Error(`design named the app ${plan.app.name}, not the run's ${name}.`);
  }
  await run.snapshotCloudflare(() => [run.appHost, `www.${run.appHost}`]);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The example's data.

/** Runs `script` in `service` of `project` until it succeeds, for up to 5 minutes (it may start). */
function inService(exec: ServerExec, project: string, service: string, script: string) {
  return waitFor(
    `${service} in ${project} answering`,
    minutes(5),
    async () => exec(inContainer(project, service, script)),
    10_000,
  );
}

/**
 * Seeds feature 023's data in `project` (rows in both databases, jobs in Valkey, named after the
 * run), and `kafka`'s messages when given. The app's SQLite file is written through the app.
 */
export async function seedData(
  run: LiveRun,
  exec: ServerExec,
  project: string,
  kafka?: readonly string[],
): Promise<void> {
  await seedMovedData(run, exec, project);
  if (kafka !== undefined) await inService(exec, project, KAFKA_SERVICE, kafkaSeedScript(kafka));
}

/**
 * Changes every seeded service in `project` after a snapshot (`marker` names the change): a row
 * deleted and one added in both databases, the jobs replaced, and `kafka`'s messages added when
 * given. The app's SQLite file is changed through the app.
 */
export async function changeData(
  exec: ServerExec,
  project: string,
  marker: string,
  kafka?: readonly string[],
): Promise<void> {
  const changes = changeScripts(marker);
  await inService(exec, project, MOVE_SERVICES.postgres, changes.postgres);
  await inService(exec, project, MOVE_SERVICES.mysql, changes.mysql);
  await inService(exec, project, MOVE_SERVICES.valkey, seedScripts(marker).valkey);
  if (kafka !== undefined) await inService(exec, project, KAFKA_SERVICE, kafkaSeedScript(kafka));
}

/**
 * The data in `project`: feature 023's (the app's SQLite file by content), and with `kafka` the
 * topic's messages; each read tried again for up to 5 minutes while the services start.
 */
export async function readData(
  exec: ServerExec,
  project: string,
  kafka: boolean,
): Promise<SnapshotData> {
  const data = await readMovedData(exec, project, SQLITE_CONTENT_SCRIPT);
  if (!kafka) return data;
  const messages = await waitFor(
    `reading Kafka's messages in ${project}`,
    minutes(5),
    async () => kafkaDigest(await exec(inContainer(project, KAFKA_SERVICE, KAFKA_READ_SCRIPT))),
    10_000,
  );
  return { ...data, kafka: messages };
}

// ---------------------------------------------------------------------------------------------
// The commands, as a script runs them.

/** `opscrew snapshot list --json` with `args` (`--env staging`, `--key-file <path>`). */
export async function listSnapshots(
  run: LiveRun,
  args: readonly string[] = [],
): Promise<ListedSnapshot[]> {
  return listedSnapshots((await run.opscrewOk("snapshot", "list", "--json", ...args)).stdout);
}

/** The listed snapshot `id`; throws with the ids listed when there is none. */
export function snapshotOf(snapshots: readonly ListedSnapshot[], id: string): ListedSnapshot {
  const found = snapshots.find((snapshot) => snapshot.id === id);
  if (found === undefined) {
    throw new Error(
      `opscrew snapshot list does not list ${id}; it lists ${snapshots.map((s) => s.id).join(", ") || "none"}.`,
    );
  }
  return found;
}

/** A restore a script approved: what its first run showed, and the second run that applied it. */
export interface ApprovedRestore {
  shown: string;
  confirm: string;
  applied: CliRun;
}

/**
 * `opscrew restore` with `args` as a script runs it: first without `--approve`, which must stop at
 * the approval (exit 1) and show its hash and the name to type; then with `--confirm <name>` and
 * `--approve <hash>`, which must succeed. The caller checks the name typed.
 */
export async function approvedRestore(
  run: LiveRun,
  args: readonly string[],
): Promise<ApprovedRestore> {
  const shown = await run.opscrew("restore", ...args);
  if (shown.exitCode !== 1) {
    throw new Error(
      `opscrew restore without --approve must stop at its approval (exit 1), but exited with ${shown.exitCode}:\n${run.tail(shown.output)}`,
    );
  }
  const approval = shownRestore(shown.output);
  if (approval === undefined) {
    throw new Error(`opscrew restore showed no restore hash or name:\n${run.tail(shown.output)}`);
  }
  const applied = await run.opscrewOk(
    "restore",
    ...args,
    "--confirm",
    approval.confirm,
    "--approve",
    approval.hash,
  );
  return { shown: shown.output, confirm: approval.confirm, applied };
}

// ---------------------------------------------------------------------------------------------
// Restore drills, as a script runs them.

const DrillReportSchema = z.object({
  outcome: z.string(),
  summary: z.string(),
  parts: z.array(z.object({ name: z.string() })),
  health: z.object({ state: z.string(), seconds: z.number() }).optional(),
  tables: z.array(z.object({ service: z.string(), count: z.number().optional() })),
  removal: z.string().optional(),
});
export type DrillReport = z.infer<typeof DrillReportSchema>;

/** The report `opscrew restore --drill --json` printed: the JSON from its first line with `{`. */
export function drillReportOf(stdout: string): DrillReport {
  const start = stdout.search(/^\{/m);
  if (start < 0) throw new Error("opscrew restore --drill --json printed no report.");
  return DrillReportSchema.parse(JSON.parse(stdout.slice(start)));
}

/** A drill a script approved: what its first run showed, its approving run and its report. */
export interface ApprovedDrill {
  shown: string;
  applied: CliRun;
  report: DrillReport;
}

/**
 * `opscrew restore --drill <args> --json` as a script runs it: first without `--approve`, which
 * must stop at the approval (exit 1) with its hash after `label` (`Drill hash` on a server or a
 * hosting account, `Stack plan hash` in a Portainer, `Removal hash` for `--remove` on a server)
 * and `<app>-drill` to type; then with
 * `--confirm <app>-drill --approve <hash>`. A drill that ran and failed exits non-zero with its
 * report, which is returned all the same; a run with no report throws.
 */
export async function approvedDrill(
  run: LiveRun,
  args: readonly string[],
  label: "Drill hash" | "Removal hash" | "Stack plan hash",
  app = run.app(),
): Promise<ApprovedDrill> {
  const shown = await run.opscrew("restore", "--drill", ...args);
  const hash = printedHash(shown.output, label);
  const confirm = [...shown.output.matchAll(/Typing (\S+) approves it\./g)].at(-1)?.[1];
  if (shown.exitCode !== 1 || hash === undefined || confirm === undefined) {
    throw new Error(
      `opscrew restore --drill without --approve must stop at its approval with its ${label} (exit 1), but exited with ${shown.exitCode}:\n${run.tail(shown.output)}`,
    );
  }
  if (confirm !== `${app}-drill`) {
    throw new Error(`The drill asks to type ${confirm}, not ${app}-drill.`);
  }
  const applied = await run.opscrew(
    "restore",
    "--drill",
    ...args,
    "--confirm",
    confirm,
    "--approve",
    hash,
    "--json",
  );
  if (applied.stdout.search(/^\{/m) < 0) {
    throw new Error(
      `opscrew restore --drill --confirm … --approve … exited with ${applied.exitCode} and no report:\n${run.tail(applied.output)}`,
    );
  }
  return { shown: shown.output, applied, report: drillReportOf(applied.stdout) };
}

/**
 * `opscrew provision <args>` as a script runs it when a plan needs a name typed, as the drills'
 * plans need `<app>-drill`: `--plan-only`, then runs with every hash the runs printed (`--approve
 * <hash>`, `Host plan hash: …`, `Stack plan hash: …`) and every `--confirm <name>` they asked for
 * among `names`, until one exits 0 (with nothing to approve, `provision --yes`). A name outside
 * `names` is never typed. Returns every run's output and the names typed.
 */
export async function provisionTyping(
  run: LiveRun,
  label: string,
  names: readonly string[],
  args: readonly string[] = [],
): Promise<{ output: string; typed: string[] }> {
  const flags = [...args, ...run.provisionFlags, "--yes"];
  const all: string[] = [];
  const hashes = new Set<string>();
  const typed = new Set<string>();
  /** The hashes and names `output` asks for; whether any is new. */
  const take = (output: string): boolean => {
    const before = hashes.size + typed.size;
    for (const hash of [
      ...approveHashes(output),
      printedHash(output, "Host plan hash"),
      printedHash(output, "Stack plan hash"),
    ]) {
      if (hash !== undefined) hashes.add(hash);
    }
    for (const [, name] of output.matchAll(/--confirm (\S+)/g)) {
      const plain = (name ?? "").replace(/[.,;:`)'"]+$/, "");
      if (names.includes(plain)) typed.add(plain);
    }
    return hashes.size + typed.size > before;
  };
  const planned = await run.opscrewOk("provision", "--plan-only", ...flags);
  all.push(planned.output);
  take(planned.output);
  if (hashes.size === 0) {
    all.push((await run.opscrewOk("provision", ...flags)).output);
    return { output: all.join("\n"), typed: [] };
  }
  for (let round = 1; round <= 5; round++) {
    const applied = await run.opscrew(
      "provision",
      ...[...hashes].flatMap((hash) => ["--approve", hash]),
      ...[...typed].flatMap((name) => ["--confirm", name]),
      ...flags,
    );
    all.push(applied.output);
    if (applied.exitCode === 0) return { output: all.join("\n"), typed: [...typed] };
    if (!take(applied.output)) {
      throw new Error(
        `${label}: opscrew provision --approve … exited with ${applied.exitCode}, asking for no other hash or name among ${names.join(", ")}:\n${run.tail(applied.output)}`,
      );
    }
    run.log(`${label}: provision asks for another plan or name; approving what it printed`);
  }
  throw new Error(`${label}: opscrew provision did not finish after 5 rounds of approvals.`);
}

/**
 * A Compose project's containers (id and start) and volumes on a server, sorted, read through
 * `exec`: what a drill must leave as it was.
 */
export async function projectState(exec: ServerExec, project: string): Promise<string> {
  const label = `label=com.docker.compose.project=${project}`;
  return [
    await exec(
      `docker ps -aq --no-trunc --filter ${label} | xargs -r docker inspect -f '{{.Id}} {{.State.StartedAt}}' | sort`,
    ),
    await exec(`docker volume ls -q --filter ${label} | sort`),
  ].join("\n");
}

/** What is left of the Compose project `project` (a drill's copy): its containers, volumes and networks. */
export function projectLeft(exec: ServerExec, project: string): Promise<string> {
  const label = `label=com.docker.compose.project=${project}`;
  return exec(
    `docker ps -aq --filter ${label}; docker volume ls -q --filter ${label}; docker network ls -q --filter ${label}`,
  );
}

/** The drills' log of the app's folder `dir` on its server, each line read as a record. */
export async function drillsLog(exec: ServerExec, dir: string): Promise<DrillRecord[]> {
  const log = `${dir}/${DRILLS_LOG}`;
  const text = await exec(`if [ -f ${log} ]; then cat ${log}; fi`);
  return text
    .split(/\r?\n/)
    .map((line) => drillRecord(line.trim()))
    .filter((record): record is DrillRecord => record !== undefined);
}

/** Whether the scheduled drills' recipe folder is in the app's folder `dir` on its server. */
export async function drillRecipeThere(exec: ServerExec, dir: string): Promise<boolean> {
  const there = await exec(`if [ -e ${dir}/${DRILL_RECIPE_DIR} ]; then echo yes; else echo no; fi`);
  return there.trim() === "yes";
}

/** What the scheduled drill's steps on a server read of their pass. */
export interface ScheduledDrillPass {
  run: LiveRun;
  /** The deploy user's login to the app's server (the crontab's user). */
  shell: () => Promise<RootShell>;
  /** The environment's flags (`--env staging`). */
  env: readonly string[];
  /** The environment's app name, and its plan. */
  app: () => string;
  plan: () => Promise<DeployPlan>;
  /** The app's Compose project: production, which a drill must leave as it was. */
  project: () => string;
  /** Provision and deploy, the plans that need `<app>-drill` approved with it; the names typed. */
  provision: (what: string) => Promise<string[]>;
  /** The deploy user's crontab line of the app's drills, or `""`. */
  crontabLine: () => Promise<string>;
  /** The steps' options (their skip). */
  options: { skip?: string };
}

/**
 * The scheduled restore drill on a server (029 plan.md 19., research R28, R29), for a pass whose
 * app takes scheduled snapshots: SD1 turns the drill schedule on (`--every daily`) and provisions
 * it, the drills host plan approved with `<app>-drill` typed; SD2 runs the crontab's command as the
 * deploy user, once outside its slot (it must do nothing) and once in it, with a clock moved for
 * the script alone ({@link scheduledDrillScript}): the latest scheduled snapshot drilled, the
 * copy watched while it runs (its networks internal, a request from it to the internet failing),
 * its line in `drills.log`, production's containers and volumes as they were, nothing of the copy
 * left, and `status` naming it. The step's own files on the server are removed.
 */
export function scheduledDrillSteps(pass: ScheduledDrillPass): void {
  const { run, env, options } = pass;
  const dir = drillTestDir(run.runId);
  const every = drillScheduleHours("daily");
  const ok = async (command: string, ms = minutes(10)) => (await pass.shell()).ok(command, ms);

  run.step(
    "SD1. snapshot drill schedule on --every daily, then provision (the drills host plan approved by its hash with <app>-drill typed) and deploy: the deploy user's crontab line # opscrew-drill <app> and the copy's files in .drill-recipe/",
    minutes(60),
    async () => {
      await run.opscrewOk("snapshot", "drill", "schedule", "on", ...env, "--every", "daily");
      const typed = await pass.provision("the drill schedule turned on");
      expect(typed, "the names provision's script typed").toContain(`${pass.app()}-drill`);
      expect(await pass.crontabLine(), "the deploy user's drill line").not.toBe("");
      const folder = appDir(await pass.plan());
      expect(
        (await ok(`cat ${folder}/${DRILL_RECIPE_DIR}/${DRILL_RECIPE_SCHEDULE}`)).trim(),
        "the drills' schedule on the server",
      ).toBe("daily");
    },
    options,
  );

  run.step(
    "SD2. the crontab's drill command as the deploy user: outside its slot it does nothing; in its slot (the clock moved for the script alone) it drills the latest scheduled snapshot, the copy's networks internal and a request from it to the internet failing; a scheduled line in drills.log, healthy and removed; production's containers and volumes unchanged, nothing of the copy left; status names it",
    minutes(75),
    async () => {
      const exec: ServerExec = (command) => ok(command);
      const folder = appDir(await pass.plan());
      const copy = `${pass.app()}-drill`;
      const production = pass.project();
      const latest = (await listSnapshots(run, env)).find((s) => s.kind === "scheduled");
      if (latest === undefined) throw new Error("There is no scheduled snapshot to drill yet.");
      // Clear of the scheduled snapshot at minute 0, whose lock would skip the drill.
      const minute = new Date().getUTCMinutes();
      if (minute >= 50 || minute < 5) {
        await sleep(((65 - minute) % 60) * 60_000);
      }
      const before = {
        production: await projectState(exec, production),
        drills: (await drillsLog(exec, folder)).length,
      };
      const script = (slotHour: number, background: boolean) =>
        scheduledDrillScript({ dir, appDir: folder, everyHours: every, slotHour, background });
      try {
        const outside = await ok(script((DRILL_SLOT_AFTER_HOURS + 1) % every, false));
        expect(outside.trim(), "the exit code outside the slot").toBe("0");
        expect(
          (await drillsLog(exec, folder)).length,
          "drills.log's lines after a run outside the slot",
        ).toBe(before.drills);
        expect(await projectLeft(exec, copy), "a copy after a run outside the slot").toBe("");

        await ok(script(DRILL_SLOT_AFTER_HOURS, true));
        const watched = watchedCopy(await ok(copyWatchScript(dir, copy), minutes(45)));
        const code = await waitFor(
          "the scheduled drill's end",
          minutes(35),
          async () => (await ok(`cat ${dir}/exit 2> /dev/null; true`)).trim() || undefined,
          15_000,
        );
        const records = await drillsLog(exec, folder);
        const last = records.at(-1);
        if (code !== "0" || last?.result !== "healthy") {
          throw new Error(
            `The scheduled drill exited with ${code} (${last?.result ?? "no record"}, ${last?.reason ?? "no reason"}); its last lines:\n${run.tail(await ok(`tail -n 40 ${dir}/out.log`))}`,
          );
        }
        if (watched === undefined) throw new Error("The copy's app was never seen running.");
        expect(watched.internal, "the copy's networks' Internal flags").toEqual(["true"]);
        expect(watched.outbound, "a request from the copy to the internet").toBe("failed");
        expect(records.length, "drills.log's lines after the drill in its slot").toBe(
          before.drills + 1,
        );
        expect(last.kind, "the drill's kind").toBe("scheduled");
        expect(last.id, "the snapshot it drilled").toBe(latest.id);
        expect(last.removal, "the copy").toBe("removed");
        expect(
          last.tables.filter((table) => (table.count ?? 0) === 0).map((table) => table.service),
          "the restored databases without a table",
        ).toEqual([]);
        expect(await projectState(exec, production), "production's containers and volumes").toBe(
          before.production,
        );
        expect(await projectLeft(exec, copy), "what is left of the copy").toBe("");
        const status = await run.opscrewOk("status", ...env);
        expect(
          status.output.includes(`Last restore drill: ${latest.id}, scheduled`),
          `status names the scheduled drill:\n${run.tail(status.output)}`,
        ).toBe(true);
        run.log(
          `observed: the scheduled drill of ${latest.id} was healthy after ${last.health?.seconds ?? "?"} s; parts ${last.parts.map((part) => part.name).join(", ")}`,
        );
      } finally {
        await ok(`touch ${dir}/stop 2> /dev/null; rm -rf ${dir}`).catch(() => undefined);
      }
    },
    options,
  );
}

// ---------------------------------------------------------------------------------------------
// The off-server copies' bucket.

/**
 * Where the pass reads the off-server copies: a bucket ({@link BackupsBucket}) or the user's SFTP
 * machine ({@link SftpMachine}), each object's path relative to the copies' `backups/` folder.
 */
export interface CopyStore {
  /** Every object under `backups/`, its path relative to it. */
  objects(): Promise<string[]>;
  /** The object `backups/<path>` read whole (still encrypted), as text. */
  read(path: string): Promise<string>;
  /** Writes an empty object `backups/<path>` dated `at`, as the retention check plants one. */
  plant(path: string, at: Date): Promise<void>;
}

/**
 * The off-server copies' bucket `name` at `provider` (`region` its location; R2's `auto`, in the
 * zone's account `accountId`): read with the pinned rclone image in local Docker with the bucket's
 * key, which stays in rclone's environment; checked and deleted as the components pass's buckets
 * are (`pass`, its `bucketPass`). The copies are under `root` (rclone's path, by default the
 * bucket's `backups/`; in the user's own bucket `<bucket>/<app>-<env>/backups`).
 */
export class BackupsBucket implements CopyStore {
  /** The bucket's S3 endpoint. */
  readonly endpoint: string;
  /** rclone's settings (the bucket's key among them), and `docker`'s arguments that run it. */
  private readonly rclone: { settings: Record<string, string>; docker: string[] };
  /** The bucket as `pass` reads it: its provider, name and region (the rest is the app's only). */
  private readonly bucket: ProviderBucket;

  constructor(
    private readonly run: LiveRun,
    private readonly pass: Pick<BucketPass, "exists" | "deleteThroughApi">,
    readonly provider: Extract<OffsiteProvider, "r2" | "hetzner">,
    readonly name: string,
    region: string,
    key: { accessKeyId: string; secretAccessKey: string },
    accountId: string,
    private readonly root = `${name}/${OFFSITE_PREFIX}`,
  ) {
    const endpoint =
      provider === "r2" ? r2Endpoint(accountId) : STORAGE_ENDPOINTS.hetzner?.(region);
    if (endpoint === undefined) throw new Error("OpsCrew knows no endpoint for Hetzner's buckets.");
    this.endpoint = endpoint;
    this.rclone = offsiteRclone({ provider, region }, endpoint, key);
    this.bucket = { provider, bucket: name, region } as ProviderBucket;
  }

  /**
   * rclone's `args` (with `overrides` of its settings); its exit code 3 (not there) is returned,
   * any other failure thrown.
   */
  private async rcloneIn(
    args: readonly string[],
    what: string,
    overrides: Record<string, string> = {},
  ) {
    const { settings, docker } = this.rclone;
    const result = await this.run.runner.run("docker", [...docker, ...args], {
      env: { ...this.run.env, ...settings, ...overrides },
      timeoutMs: minutes(10),
    });
    if (result.exitCode !== 0 && result.exitCode !== RCLONE_NOT_FOUND) {
      const said = result.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      throw new Error(
        `rclone could not ${what} in the bucket ${this.name} (exit ${result.exitCode}): ${this.run.scrub(said).slice(0, 300)}`,
      );
    }
    return result;
  }

  async objects(): Promise<string[]> {
    const listed = await this.rcloneIn(
      ["lsf", "-R", "--files-only", `offsite:${this.root}`],
      "list the copies",
    );
    if (listed.exitCode === RCLONE_NOT_FOUND) return [];
    return listedLines(listed.stdout);
  }

  async read(path: string): Promise<string> {
    const read = await this.rcloneIn(["cat", `offsite:${this.root}/${path}`], `read ${path}`);
    if (read.exitCode === RCLONE_NOT_FOUND) throw new Error(`The bucket has no ${path}.`);
    return read.stdout;
  }

  /** An empty object, its modification time (rclone's, which `--min-age` reads) `at`. */
  async plant(path: string, at: Date): Promise<void> {
    await this.rcloneIn(
      ["touch", "-t", at.toISOString().slice(0, 19), `offsite:${this.root}/${path}`],
      `write ${path}`,
    );
  }

  /**
   * Creates the bucket, as the user's own (the copies' settings never create one), then waits
   * until 5 listings in a row find it: for about 15 minutes some of Hetzner's nodes answer that a
   * new bucket is not there, and provision's write check would meet one.
   */
  async create(): Promise<void> {
    this.run.log(`creating the bucket ${this.name}, standing in for the user's own`);
    await this.rcloneIn(["mkdir", `offsite:${this.name}`], "create the bucket", {
      RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET: "false",
    });
    let found = 0;
    await waitFor(
      `the new bucket ${this.name} known to Hetzner's nodes`,
      minutes(20),
      async () => {
        const listed = await this.rcloneIn(["lsf", `offsite:${this.name}`], "list the bucket");
        found = listed.exitCode === 0 ? found + 1 : 0;
        return found >= 5 ? true : undefined;
      },
      10_000,
    );
  }

  /** Whether the bucket is there (R2's API, or Hetzner's answer to an unsigned `HEAD`). */
  exists(): Promise<boolean> {
    return this.pass.exists(this.bucket);
  }

  /**
   * Deletes every object (on Hetzner, whose bucket keeps versions, the old versions too) and then
   * the bucket, as the guide tells the user to; throws when the bucket is still there.
   */
  async remove(): Promise<void> {
    if (!(await this.exists())) return;
    const { deleteThroughApi } = this.pass;
    if (deleteThroughApi === undefined) throw new Error(`No way to delete ${this.name} is known.`);
    this.run.log(`deleting the off-server bucket ${this.name}, which OpsCrew leaves to the user`);
    await this.rcloneIn(["delete", `offsite:${this.name}`], "delete the copies");
    if (this.provider === "hetzner") {
      await this.rcloneIn(
        ["backend", "cleanup-hidden", `offsite:${this.name}`],
        "delete the copies' old versions",
      );
    }
    await deleteThroughApi(this.bucket);
    if (await this.exists()) {
      throw new Error(`The off-server bucket ${this.name} is still there after its deletion.`);
    }
  }
}

/** The non-empty lines of a listing, trimmed. */
function listedLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * The copies on the user's SFTP machine (a throwaway server the test set up, {@link SFTP_MACHINE}),
 * read as root there through `shell`: under `root`, the folder `backups/` of the environment's
 * copies as the machine's own disk has it (inside the account's chroot).
 */
export class SftpMachine implements CopyStore {
  constructor(
    private readonly shell: RootShell,
    readonly root: string,
  ) {}

  async objects(): Promise<string[]> {
    const { root } = this;
    return listedLines(
      await this.shell.ok(
        `if [ -d ${root} ]; then cd ${root} && find . -type f | sed 's|^\\./||'; fi`,
      ),
    );
  }

  read(path: string): Promise<string> {
    return this.shell.ok(`cat ${this.root}/${path}`, minutes(5));
  }

  async plant(path: string, at: Date): Promise<void> {
    await this.shell.ok(plantedFileScript(`${this.root}/${path}`, at, SFTP_MACHINE.user));
  }

  /** Whether the folder `backups/<path>` is there. */
  async holds(path: string): Promise<boolean> {
    const dir = `${this.root}/${path}`;
    return (await this.shell.ok(`if [ -d ${dir} ]; then echo yes; else echo no; fi`)) === "yes";
  }
}

// ---------------------------------------------------------------------------------------------
// Hetzner's whole-server snapshots.

/** A snapshot at Hetzner: its id, the server it was taken of, and when. */
interface HetznerImage {
  id: number;
  created: string;
  created_from?: { id: number } | null;
}

/** The snapshots OpsCrew took at Hetzner of `app`'s servers (its labels, never `managed-by`). */
async function serverSnapshots(token: string, app: string): Promise<HetznerImage[]> {
  const selector = encodeURIComponent(`created-by=opscrew,app=${app}`);
  const listed = await api(
    HETZNER_API,
    token,
    "GET",
    `/images?type=snapshot&label_selector=${selector}`,
  );
  if (listed.status !== 200) throw new Error(`Hetzner answered HTTP ${listed.status} for images.`);
  return (listed.json as { images?: HetznerImage[] }).images ?? [];
}

/**
 * The cleanup's: deletes every whole-server snapshot of `app` OpsCrew took at Hetzner that this
 * run left, each a problem (the pass deletes its own with `opscrew snapshot delete`). Only the
 * run's are deleted: taken of the run's server `serverId` (when known), or since `since`. Any
 * other with the app's labels is a problem and stays.
 */
export async function removeServerSnapshots(
  token: string,
  app: string,
  serverId: number | undefined,
  since: Date,
): Promise<string[]> {
  const problems: string[] = [];
  for (const image of await serverSnapshots(token, app)) {
    const { id } = image;
    const ours =
      (serverId !== undefined && image.created_from?.id === serverId) ||
      Date.parse(image.created) >= since.getTime();
    if (!ours) {
      problems.push(
        `Hetzner has the whole-server snapshot ${id} of ${app} from before this run; it is not this run's, so the cleanup left it: check it in the console (Servers → Snapshots)`,
      );
      continue;
    }
    const deleted = await retryDelete(() => api(HETZNER_API, token, "DELETE", `/images/${id}`));
    problems.push(
      deleted
        ? `the run left the whole-server snapshot ${id} of ${app} at Hetzner; the cleanup deleted it`
        : `Hetzner kept the whole-server snapshot ${id} of ${app}: delete it in the console (Servers → Snapshots)`,
    );
  }
  return problems;
}

/** A server at Hetzner as a rebuild must keep it: its id, IPv4 address and protection. */
export interface HetznerServer {
  id: number;
  ipv4: string;
  protection: { delete: boolean; rebuild: boolean };
}

/** The server named `name` at Hetzner (the app's server is named after the app). */
export async function hetznerServer(token: string, name: string): Promise<HetznerServer> {
  const listed = await api(HETZNER_API, token, "GET", `/servers?name=${encodeURIComponent(name)}`);
  const server = (
    listed.json as
      | {
          servers?: {
            id: number;
            public_net: { ipv4?: { ip: string } | null };
            protection: { delete: boolean; rebuild: boolean };
          }[];
        }
      | undefined
  )?.servers?.[0];
  if (listed.status !== 200 || server === undefined) {
    throw new Error(`Hetzner lists no server ${name} (HTTP ${listed.status}).`);
  }
  return {
    id: server.id,
    ipv4: server.public_net.ipv4?.ip ?? "",
    protection: { delete: server.protection.delete, rebuild: server.protection.rebuild },
  };
}

/** Whether Hetzner still has the image `id`. */
export async function hetznerImageExists(token: string, id: string): Promise<boolean> {
  const got = await api(HETZNER_API, token, "GET", `/images/${id}`);
  if (got.status === 404) return false;
  if (got.status === 200) return true;
  throw new Error(`Hetzner answered HTTP ${got.status} for the image ${id}.`);
}

// ---------------------------------------------------------------------------------------------
// Your Portainer: the version its site serves, and the rollback's mark.

/** Waits up to `ms` until the site serves `version` at its version path, through Cloudflare. */
export async function waitForVersion(run: LiveRun, version: string, ms = minutes(15)) {
  const url = `https://${run.appHost}${PORTAINER_VERSION_PATH}`;
  run.log(`waiting for the site to serve version ${version}`);
  await waitFor(`the site serving version ${version}`, ms, async () => {
    const answer = await httpRequest(url);
    if (answer.status !== 200 || answer.body.trim() !== version) {
      throw new Error(`it answered ${answer.status} with ${answer.body.trim() || "(nothing)"}`);
    }
    return true;
  });
}

/**
 * Whether the stack's `snapshots` volume holds the rollback's mark (`.restored`), read as root on
 * the Portainer host with a read-only one-off of busybox that mounts it where the stack does.
 */
export async function restoredMark(exec: ServerExec, plan: DeployPlan): Promise<boolean> {
  const answer = await exec(
    `docker run --rm -v ${portainerSnapshotsVolume(plan)}:/snapshots:ro ${BUSYBOX_IMAGE} sh -c 'if [ -e ${RESTORED_IMAGE_FILE} ]; then echo yes; else echo no; fi'`,
  );
  return answer.trim() === "yes";
}

// ---------------------------------------------------------------------------------------------
// The leak search.

/** A deploy run whose deploy job's log the leak search reads. */
export interface DeployRun {
  what: string;
  id: number;
}

/**
 * The deploy job's log of each of `runs` (they take release snapshots, and the restores read their
 * output) searched for the run's known secrets and dumped values: the problems, by label only.
 * GitHub masks only its own secrets.
 */
export async function deployLogLeaks(run: LiveRun, runs: readonly DeployRun[]): Promise<string[]> {
  // The user's SFTP machine is named in the plan, so the deploy job may name it too.
  const secrets = run.scrubber
    .entries()
    .filter(({ label }) => !label.startsWith("server-") && !label.startsWith(SFTP_MACHINE_LABEL));
  const problems: string[] = [];
  for (const { what, id } of runs) {
    const text = await jobLog(run.github, id, SERVER_DEPLOY_JOB).catch((error: Error) => {
      problems.push(`the deploy job's log of ${what} (run ${id}) is unreadable: ${error.message}`);
      return "";
    });
    const found = leakedLabels(text, secrets);
    if (found.length > 0) {
      problems.push(`the deploy job's log of ${what} (run ${id}) contains: ${found.join(", ")}`);
    }
  }
  run.log(`observed: the leak search read the deploy job's log of ${runs.length} runs`);
  return problems;
}

/**
 * The last 40 lines of the off-server copy's upload log in the app's folder `dir` on the server
 * (`OFFSITE_LOG`), or that there is none, for a failure to show (scrubbed by the caller).
 */
export function offsiteLogTail(exec: ServerExec, dir: string): Promise<string> {
  const log = `${dir}/${OFFSITE_LOG}`;
  return exec(`if [ -f ${log} ]; then tail -n 40 ${log}; else echo "There is no ${log}."; fi`);
}

/**
 * No age private key (`AGE-SECRET-KEY-`, the prefix only, never a key) in the files of the app's
 * folder `dir` on its server (its `.env` files, the bucket's key file) or in its snapshots, read
 * through `exec` (FR-2409: the server holds only the recipient). grep's exit 1 is "none found".
 */
export async function ageKeysOnServer(exec: ServerExec, dir: string): Promise<string[]> {
  const found = await exec(
    `grep -rlI 'AGE-SECRET-KEY-' ${dir}/.snapshots $(find ${dir} -maxdepth 1 -type f); s=$?; [ "$s" -le 1 ]`,
  );
  return found
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((file) => `${file} on the server holds an age private key`);
}
