// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell syntax, not JavaScript templates.
// Feature 029, restore drills (T2933; plan.md 19., research R15–R19, R29): `snapshot.sh drill`
// keeps its bounds itself, whatever asks it.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withServices } from "../catalog/__fixtures__/plans";
import {
  DRILL_APPROVAL_FILE,
  DRILL_LIMIT_SECONDS,
  DRILLS_LOG,
  drillApprovalLine,
  drillRecord,
  renderDrill,
} from "../drill";
import { onThisComputer } from "../edge/__fixtures__/localhost";
import { withBuild, withSqlite } from "./__fixtures__/plans";
import { FAKE_DF, fakeBin, shWorks, write } from "./__fixtures__/sh";
import { snapshotScript } from "./snapshot-script";
import { snapshotParts } from "./snapshots";

const A = "a".repeat(64);
const IMAGE = `ghcr.io/acme/shop@sha256:${A}`;
const ID = "20261118T120000Z";
const OLDER = "20261111T120000Z";
const windows = process.platform === "win32";

/** `shop` on Node with PostgreSQL `db`, the stop-only RabbitMQ `mq` and the app's SQLite volume. */
const PLAN = DeployPlanSchema.parse(
  withSqlite(
    withBuild(
      withServices([
        { kind: "postgres", name: "db" },
        { kind: "rabbitmq", name: "mq" },
      ]),
      "railpack",
      { language: "node", version: "22" },
    ),
  ),
);
const DRILL = `${PLAN.app.name}-drill`;

/** The real `date` and `sleep`, which the fakes run for what they don't play. */
const real = (name: string) =>
  spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout?.trim();
const REAL_DATE = real("date");
const REAL_SLEEP = real("sleep");

/**
 * The fake `docker` for the drill's project (`-p <app>-drill`), logging every call to
 * $WORK/docker.log. In $WORK/drill: `containers/<service>` exists once `create` made it,
 * `running/<service>` while it runs, `network` holds the network's `internal` (NET_INTERNAL,
 * default true), `volumes/<name>` each volume (DRILL_VOLUMES), `data/<part>` what each restore put
 * in. DRILL_SERVICES names the project's services. NO_IMAGE: the app's image is not here (until a
 * pull, which PULL_FAIL fails); CREATE_FAIL, UP_FAIL fail `create` and the services' `up`;
 * RESTORE_FAIL names a part whose restore fails; PORTS names a container with a published port;
 * NO_HEALTH: the app has no health check; APP_HEALTH its health (default healthy); APP_EXITS: it
 * stops; TABLES the restored database's table count (default 3). With DRILL_TIMEOUT, `create`
 * waits for the time limit's mark, then fails, as when its containers are killed.
 */
const FAKE_DOCKER = [
  "#!/bin/sh",
  'echo "docker $*" >> "$WORK/docker.log"',
  'd="$WORK/drill"',
  'mkdir -p "$d/containers" "$d/running" "$d/volumes" "$d/data"',
  'project=""',
  'if [ "$1" = compose ]; then',
  "  shift",
  '  while [ "$1" = -p ] || [ "$1" = -f ]; do',
  '    if [ "$1" = -p ]; then project="$2"; fi',
  "    shift 2",
  "  done",
  '  set -- compose "$@"',
  `  if [ "$project" != ${DRILL} ]; then echo "not the drill's project: $project" >&2; exit 99; fi`,
  "fi",
  'for last in "$@"; do :; done',
  'case "$1 $2" in',
  '  "image inspect") if [ -n "${NO_IMAGE:-}" ] && [ ! -f "$WORK/pulled" ]; then exit 1; fi ;;',
  '  "pull "*) if [ -n "${PULL_FAIL:-}" ]; then echo "pull failed" >&2; exit 1; fi; : > "$WORK/pulled" ;;',
  '  "compose create")',
  '    if [ -n "${DRILL_TIMEOUT:-}" ]; then',
  '      n=0; while [ ! -f .drill/.timed-out ] && [ "$n" -lt 100 ]; do n=$((n + 1)); "$REAL_SLEEP" 0.1; done',
  "      exit 1",
  "    fi",
  '    if [ -n "${CREATE_FAIL:-}" ]; then exit 1; fi',
  '    for s in $DRILL_SERVICES; do : > "$d/containers/$s"; done',
  '    for v in ${DRILL_VOLUMES:-}; do : > "$d/volumes/$v"; done',
  '    echo "${NET_INTERNAL:-true}" > "$d/network" ;;',
  '  "compose up")',
  '    case " $* " in *" app "*) [ -z "${APP_START_FAIL:-}" ] || exit 1 ;; *) [ -z "${UP_FAIL:-}" ] || exit 1 ;; esac',
  '    for s in "$@"; do [ -f "$d/containers/$s" ] && : > "$d/running/$s"; done',
  "    true ;;",
  '  "compose stop") rm -f "$d/running/$last" ;;',
  '  "compose ps") if [ -f "$d/containers/$last" ]; then echo "c-$last"; fi ;;',
  '  "compose run")',
  '    snap=""; p1=""; service=""; p2=""',
  '    for arg in "$@"; do',
  '      if [ "$p1" = -v ]; then snap="${arg%%:/snapshot*}"; fi',
  '      if [ "$p2" = --entrypoint ] && [ "$p1" = sh ]; then service="$arg"; fi',
  '      p2="$p1"; p1="$arg"',
  "    done",
  '    case " ${RESTORE_FAIL:-} " in *" $service "*) echo "restore failed at $SECRET_ROW" >&2; exit 1 ;; esac',
  '    cp "$snap/$service.dump" "$d/data/$service" ;;',
  '  "compose exec") echo "${TABLES:-3}" ;;',
  '  "run --rm")',
  '    case " $* " in',
  '      *" --entrypoint rm "*) ;;',
  '      *" --volumes-from "*) p1=""; for arg in "$@"; do if [ "$p1" = --volumes-from ]; then service="${arg#c-}"; service="${service%%:*}"; fi; p1="$arg"; done; cat > "$d/data/$service" ;;',
  '      *) cat > "$d/data/sqlite" ;;',
  "    esac",
  '    case " ${RESTORE_FAIL:-} " in *" sqlite "*) exit 1 ;; esac ;;',
  '  "volume inspect") [ -f "$d/volumes/$last" ] ;;',
  '  "network inspect") if [ -f "$d/network" ]; then cat "$d/network"; else exit 1; fi ;;',
  '  "ps -aq") for c in "$d"/containers/*; do [ -f "$c" ] && echo "c-${c##*/}"; done; true ;;',
  '  "ps -q") for c in "$d"/running/*; do [ -f "$c" ] && echo "c-${c##*/}"; done; true ;;',
  '  "network ls") if [ -f "$d/network" ]; then echo net-1; fi ;;',
  '  "volume ls") for v in "$d"/volumes/*; do [ -f "$v" ] && echo "${v##*/}"; done; true ;;',
  '  "rm -f") rm -f "$d"/containers/* "$d"/running/* ;;',
  '  "network rm") rm -f "$d/network" ;;',
  '  "volume rm") rm -f "$d"/volumes/* ;;',
  '  "kill "*) rm -f "$d"/running/* ;;',
  '  "inspect --format")',
  '    s="${last#c-}"',
  '    case "$3" in',
  `      *NetworkSettings*) if [ "$s" = "\${PORTS:-}" ]; then echo "${DRILL}_internal port "; else echo "${DRILL}_internal "; fi ;;`,
  '      "{{if .State.Health}}yes{{end}}") [ -n "${NO_HEALTH:-}" ] || echo yes ;;',
  '      "{{.State.Health.Status}}") echo "${APP_HEALTH:-healthy}" ;;',
  '      "{{.State.Status}}") if [ -z "${APP_EXITS:-}" ] && [ -f "$d/running/$s" ]; then echo running; else echo exited; fi ;;',
  "    esac ;;",
  "esac",
].join("\n");

/** The fake `flock`: logged; with FLOCK_BUSY, `-n` finds the lock held. */
const FAKE_FLOCK = [
  "#!/bin/sh",
  'echo "flock $*" >> "$WORK/docker.log"',
  'if [ "$1" = -n ] && [ -n "${FLOCK_BUSY:-}" ]; then exit 1; fi',
].join("\n");

/** The fake `date +%s` reads $WORK/clock; anything else is the real `date`. */
const FAKE_DATE = [
  "#!/bin/sh",
  'if [ "$1" = +%s ]; then cat "$WORK/clock"; exit 0; fi',
  `exec "${REAL_DATE}" "$@"`,
].join("\n");

/**
 * The fake `sleep` moves $WORK/clock on at once; the time limit's sleep really waits (until the
 * drill stops it), or with DRILL_TIMEOUT ends at once.
 */
const FAKE_SLEEP = [
  "#!/bin/sh",
  `if [ "$1" = ${DRILL_LIMIT_SECONDS} ]; then`,
  '  if [ -n "${DRILL_TIMEOUT:-}" ]; then exit 0; fi',
  `  exec "${REAL_SLEEP}" "$1"`,
  "fi",
  'echo $(( $(cat "$WORK/clock") + $1 )) > "$WORK/clock"',
].join("\n");

let work = "";
const appDir = (plan: DeployPlan = PLAN) => `${work}/srv/apps/${plan.app.name}`;
const at = (name: string, plan: DeployPlan = PLAN) => `${appDir(plan)}/${name}`;
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
const calls = () => (read(`${work}/docker.log`) ?? "").split("\n").filter(Boolean);
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
/** The fake `date +%s` of the run, in Unix seconds. */
const now = () => Number(readFileSync(`${work}/clock`, "utf8").trim());

/** The parts of `plan`'s snapshot `id` taken `taken`, each file `<part> rows`. */
function snapshot(id: string, taken: string, plan: DeployPlan = PLAN): void {
  const parts = snapshotParts(plan);
  for (const part of parts) write(at(`.snapshots/${id}/${part.file}`, plan), `${part.name} rows`);
  write(at(`.snapshots/${id}/taken`, plan), `${taken}\n`);
  const services = parts.map((part) => ({
    name: part.name,
    kind: part.kind,
    file: part.file,
    size: `${part.name} rows`.length,
  }));
  write(
    at(`.snapshots/${id}/about.json`, plan),
    `${JSON.stringify({ id, kind: "manual", taken, version: `sha256:${A}`, services })}\n`,
  );
}

/** `plan`'s app folder with its snapshot script, a `.env` and two snapshots, {@link ID} the latest. */
function machine(plan: DeployPlan = PLAN): void {
  write(at("snapshot.sh", plan), `${snapshotScript(plan).join("\n")}\n`);
  write(at(".env", plan), `APP_IMAGE=${IMAGE}\nSECRET_KEY=${fakeSecret("generic-password")}\n`);
  snapshot(OLDER, "2026-11-11T12:00:00Z", plan);
  snapshot(ID, "2026-11-18T12:00:00Z", plan);
}

/** The env files of the drill: generated values as the preview server's placeholders. */
const ENV = {
  app: "DATABASE_URL=postgres://app:@SECRET:db-password:hex32@@db:5432/app\nNODE_ENV=production\n",
  services: {
    db: "POSTGRES_PASSWORD=@SECRET:db-password:hex32@\n",
    mq: "RABBITMQ_DEFAULT_PASS=@SECRET:mq-password:hex32@\n",
  },
};

/** The preview values the drill's app reads first. */
const VALUES = `STRIPE_KEY=${fakeSecret("generic-password")}\n`;

/** What `opscrew restore --drill` sends on stdin: the image, then each file of the copy. */
function input(
  o: { id?: string; parts?: string[]; image?: string; extra?: string[] } = {},
  plan: DeployPlan = PLAN,
): string {
  const id = o.id ?? ID;
  const files = renderDrill(
    plan,
    { id, parts: o.parts ?? ["db", "mq", "sqlite"] },
    { image: o.image ?? IMAGE, env: ENV, previewValues: true },
  );
  const prefix = `.drill/${id}/`;
  return [
    `image ${o.image ?? IMAGE}`,
    ...files.map(
      (file) =>
        `file ${file.path.slice(prefix.length)} ${Buffer.from(file.content).toString("base64")}`,
    ),
    `file values.env ${Buffer.from(VALUES).toString("base64")}`,
    ...(o.extra ?? []),
    "",
  ].join("\n");
}

/** The one-time approval of the drill `args` asks, valid for `seconds` more. */
function approve(
  o: { id?: string; action?: "drill" | "keep" | "remove"; only?: string; seconds?: number } = {},
  plan: DeployPlan = PLAN,
): void {
  const line = drillApprovalLine({
    ...(o.action === "remove" ? {} : { id: o.id ?? ID }),
    action: o.action ?? "drill",
    expiresAt: now() + (o.seconds ?? 1800),
    ...(o.only === undefined ? {} : { only: o.only }),
  });
  write(at(DRILL_APPROVAL_FILE, plan), `${line}\n`);
}

/** `sh snapshot.sh drill <args>` in the app's folder, `stdin` its input, the fakes first. */
function drill(
  args: string[],
  o: { env?: Record<string, string>; stdin?: string; plan?: DeployPlan } = {},
) {
  const plan = o.plan ?? PLAN;
  const result = spawnSync(
    "sh",
    [
      "-c",
      'PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; exec sh "$0" "$@"',
      at("snapshot.sh", plan),
      "drill",
      ...args,
    ],
    {
      input: o.stdin ?? "",
      env: {
        ...process.env,
        WORK: work,
        REAL_SLEEP: REAL_SLEEP ?? "sleep",
        OPSCREW_APPS_DIR: `${work}/srv/apps`,
        OPSCREW_EDGE_DIR: `${work}/srv/edge`,
        SECRET_ROW: "row-value-from-the-database",
        DRILL_SERVICES: "app db mq",
        DRILL_VOLUMES: `${DRILL}_sqlite`,
        ...o.env,
      },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  const record = result.stdout
    .split("\n")
    .find((line) => line.startsWith("drill-record "))
    ?.slice("drill-record ".length);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
    record: record === undefined ? undefined : drillRecord(record),
  };
}

/** The lines of `.snapshots/drills.log`, as records. */
const logged = (plan: DeployPlan = PLAN) =>
  (read(at(DRILLS_LOG, plan)) ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => drillRecord(line));

/** Production's names, which no command of the drill may carry. */
function noProduction(plan: DeployPlan = PLAN): void {
  for (const call of calls()) {
    expect(call).not.toMatch(new RegExp(`-p ${plan.app.name}(\\s|$)`));
    expect(call).not.toMatch(new RegExp(`${plan.app.name}_`));
    expect(call).not.toMatch(new RegExp(`/srv/data/${plan.app.name}(/|\\s|$)`));
    expect(call).not.toMatch(/(^|[\s/'"=])\.env\b/);
  }
}

describe.skipIf(!shWorks())("snapshot.sh drill", { timeout: 300_000 }, () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-snapshot-drill-")).replaceAll("\\", "/");
    fakeBin(work, {
      docker: FAKE_DOCKER,
      df: FAKE_DF,
      flock: FAKE_FLOCK,
      date: FAKE_DATE,
      sleep: FAKE_SLEEP,
    });
    write(`${work}/clock`, `${Math.floor(Date.now() / 1000)}\n`);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("restores each part into <app>-drill with no internet, finds it healthy, counts its tables and removes it", () => {
    machine();
    approve();
    const result = drill([ID], { stdin: input() });

    expect(result.status, result.output).toBe(0);
    expect(result.record).toMatchObject({
      kind: "manual",
      result: "healthy",
      id: ID,
      version: A.slice(0, 12),
      parts: [
        { name: "db", size: 7, seconds: 0 },
        { name: "mq", size: 7, seconds: 0 },
        { name: "sqlite", size: 11, seconds: 0 },
      ],
      health: { state: "healthy", seconds: 0 },
      tables: [{ service: "db", count: 3 }],
      removal: "removed",
      cleaned: false,
    });
    expect(logged()).toEqual([result.record]);
    // The parts went into the drill's project, read from the snapshot read-only.
    expect(read(`${work}/drill/data/db`)).toBe("db rows");
    expect(read(`${work}/drill/data/mq`)).toBe("mq rows");
    expect(read(`${work}/drill/data/sqlite`)).toBe("sqlite rows");
    const runs = calls().filter((call) => call.includes(" run --rm --no-deps "));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(`/.snapshots/${ID}:/snapshot:ro `);
    // Cut off before any data went in, checked again once the services and the app ran.
    const order = (text: string) => calls().findIndex((call) => call.includes(text));
    expect(order("compose.yaml create")).toBeGreaterThan(-1);
    expect(order("network inspect")).toBeGreaterThan(order("compose.yaml create"));
    expect(order("network inspect")).toBeLessThan(order(" run --rm --no-deps "));
    expect(
      calls().filter((call) =>
        call.includes(`network inspect --format {{.Internal}} ${DRILL}_internal`),
      ),
    ).toHaveLength(3);
    // The stop-only RabbitMQ starts again without waiting for a health check that logs in.
    expect(calls()).toContain(
      `docker compose -p ${DRILL} -f .drill/${ID}/compose.yaml up -d --no-deps --no-recreate mq`,
    );
    // The lock, without waiting; the approval used once; nothing of it left.
    expect(calls()[0]).toBe("flock -n 7");
    expect(existsSync(at(DRILL_APPROVAL_FILE))).toBe(false);
    expect(existsSync(at(".drill"))).toBe(false);
    expect(readdirSync(`${work}/drill/containers`)).toEqual([]);
    expect(readdirSync(`${work}/drill/volumes`)).toEqual([]);
    noProduction();
    expect(result.output).not.toContain(VALUES.trim());
    expect(read(at(DRILLS_LOG))).not.toContain(VALUES.trim());
  });

  it("keeps the copy with --keep, its generated values new and filled in, owner-only, until --remove", () => {
    machine();
    approve({ action: "keep" });
    const result = drill([ID, "--keep"], { stdin: input() });
    expect(result.status, result.output).toBe(0);
    expect(result.record).toMatchObject({ result: "healthy", removal: "kept" });

    const dir = at(`.drill/${ID}`);
    expect(existsSync(`${dir}/kept`)).toBe(true);
    const app = read(`${dir}/app.env`) ?? "";
    const db = read(`${dir}/db.env`) ?? "";
    const password = /^POSTGRES_PASSWORD=([0-9a-f]{64})$/m.exec(db)?.[1];
    expect(password).toBeDefined();
    expect(app).toContain(`postgres://app:${password}@db:5432/app`);
    expect(app).not.toContain("@SECRET:");
    expect(read(`${dir}/mq.env`)).toMatch(/^RABBITMQ_DEFAULT_PASS=[0-9a-f]{64}$/m);
    expect(read(`${dir}/values.env`)).toBe(VALUES);
    expect(existsSync(at(".drill/.secrets.env"))).toBe(false);
    expect(existsSync(at(".drill/.fill.sed"))).toBe(false);
    if (!windows) {
      for (const file of ["app.env", "db.env", "mq.env", "values.env"]) {
        expect(mode(`${dir}/${file}`), file).toBe("600");
      }
      expect(mode(dir)).toBe("700");
    }

    // Another drill waits for the kept copy's removal, changing nothing.
    approve();
    const again = drill([ID], { stdin: input() });
    expect(again.status).toBe(1);
    expect(again.stderr).toContain(
      `A kept copy of the snapshot ${ID} is still here, so OpsCrew started no other drill: nothing was changed.`,
    );
    expect(existsSync(`${dir}/kept`)).toBe(true);

    approve({ action: "remove" });
    const removed = drill(["--remove"]);
    expect(removed.status, removed.output).toBe(0);
    expect(removed.stdout).toContain("drill-removal removed");
    expect(existsSync(at(".drill"))).toBe(false);
    expect(readdirSync(`${work}/drill/containers`)).toEqual([]);
    approve({ action: "remove" });
    expect(drill(["--remove"]).stdout).toContain("drill-removal none");
    noProduction();
  });

  it("refuses without its one-time approval, or one for another drill or expired, and changes nothing", () => {
    machine();
    const cases: [() => void, string[], string][] = [
      [() => undefined, [ID], "A drill needs its one-time approval here (.drill-snapshot)"],
      [() => approve({ id: OLDER }), [ID], "is for another drill"],
      [() => approve(), [ID, "--keep"], "is for another drill"],
      [() => approve(), [ID, "--only", "db"], "is for another drill"],
      [() => approve({ seconds: -5 }), [ID], "expired before it started"],
    ];
    for (const [given, args, said] of cases) {
      given();
      const result = drill(args, { stdin: input() });
      expect(result.status, said).toBe(1);
      expect(result.stderr, said).toContain(said);
      expect(existsSync(at(DRILL_APPROVAL_FILE)), said).toBe(false);
    }
    expect(calls()).toEqual([]);
    expect(existsSync(at(".drill"))).toBe(false);
    expect(read(at(DRILLS_LOG))).toBeUndefined();
    for (const args of [["../x"], ["--remove", ID], ["--only", "nope"], ["--keep", "--remove"]]) {
      expect(drill(args).status, args.join(" ")).toBe(1);
    }
  });

  it("is skipped, never failed, while a deploy or snapshot holds the lock, or with too little disk or memory", () => {
    machine();
    approve();
    const locked = drill([ID], { stdin: input(), env: { FLOCK_BUSY: "1" } });
    expect(locked.status).toBe(3);
    expect(locked.stderr).toContain(
      "OpsCrew skipped this drill: a deploy or a snapshot was running. Nothing was changed.",
    );
    expect(locked.record).toMatchObject({ result: "skipped", reason: "locked", id: ID });

    approve();
    // 2 GiB free of 4 GiB: the snapshot rule leaves too little for the copy.
    const disk = drill([ID], {
      stdin: input(),
      env: { DISK_TOTAL_KB: "4194304", DISK_FREE_KB: "1048576" },
    });
    expect(disk.status).toBe(3);
    expect(disk.record).toMatchObject({ result: "skipped", reason: "disk" });
    // Only the read of what a crashed run left.
    expect(calls().filter((call) => / (create|up|run|rm|pull)( |$)/.test(call))).toEqual([]);
    expect(existsSync(at(".drill"))).toBe(false);
    expect(logged().map((record) => record?.reason)).toEqual(["locked", "disk"]);
  });

  it.skipIf(spawnSync("sh", ["-c", "[ -r /proc/meminfo ]"]).status !== 0)(
    "is skipped when free memory is below the copy's limits",
    () => {
      const big = DeployPlanSchema.parse({ ...PLAN, app: { ...PLAN.app, memoryMb: 65536 } });
      const huge = DeployPlanSchema.parse({
        ...big,
        services: big.services.map((service) => ({ ...service, memoryMb: 65536 })),
      });
      machine(huge);
      approve({}, huge);
      const result = drill([ID], { stdin: input({}, huge), plan: huge });
      expect(result.status, result.output).toBe(3);
      expect(result.record).toMatchObject({ result: "skipped", reason: "memory" });
    },
  );

  it("says the snapshot did not restore when a part fails, and removes the copy", () => {
    machine();
    approve();
    const result = drill([ID], { stdin: input(), env: { RESTORE_FAIL: "db" } });
    expect(result.status).toBe(2);
    expect(result.record).toMatchObject({
      result: "not-restored",
      reason: "db",
      parts: [],
      removal: "removed",
    });
    expect(calls().some((call) => call.includes("up -d --no-deps app"))).toBe(false);
    expect(existsSync(at(".drill"))).toBe(false);
    expect(result.output).not.toContain("row-value-from-the-database");
  });

  it("says not restored when a restored database holds no table", () => {
    machine();
    approve();
    const result = drill([ID], { stdin: input(), env: { TABLES: "0" } });
    expect(result.status).toBe(2);
    expect(result.record).toMatchObject({
      result: "not-restored",
      reason: "db",
      tables: [{ service: "db", count: 0 }],
    });
  });

  it("tells a copy that restored but never became healthy within 5 minutes", () => {
    machine();
    approve();
    const result = drill([ID], { stdin: input(), env: { APP_HEALTH: "unhealthy" } });
    expect(result.status).toBe(2);
    expect(result.record).toMatchObject({
      result: "unhealthy",
      health: { state: "unhealthy", seconds: 300 },
      tables: [{ service: "db", count: 3 }],
      removal: "removed",
    });
    expect(result.record?.parts.map((part) => part.name)).toEqual(["db", "mq", "sqlite"]);
  });

  it("without a health check, passes an app still running after 60 seconds and fails one that stopped", () => {
    machine();
    approve();
    const running = drill([ID], { stdin: input(), env: { NO_HEALTH: "1" } });
    expect(running.record).toMatchObject({
      result: "healthy",
      health: { state: "running", seconds: 60 },
    });
    approve();
    const stopped = drill([ID], { stdin: input(), env: { NO_HEALTH: "1", APP_EXITS: "1" } });
    expect(stopped.record).toMatchObject({
      result: "unhealthy",
      health: { state: "stopped", seconds: 60 },
    });
  });

  it("removes the copy at once, kept or not, when its network is not cut off or a port is published", () => {
    for (const env of [{ NET_INTERNAL: "false" }, { PORTS: "db" }] as Record<string, string>[]) {
      machine();
      approve({ action: "keep" });
      const result = drill([ID, "--keep"], { stdin: input(), env });
      expect(result.status, JSON.stringify(env)).toBe(2);
      expect(result.record).toMatchObject({
        result: "failed",
        reason: "network",
        removal: "removed",
      });
      expect(calls().some((call) => call.includes(" run --rm"))).toBe(false);
      expect(existsSync(at(".drill"))).toBe(false);
      rmSync(`${work}/docker.log`, { force: true });
    }
  });

  it("pulls the snapshot's version when it is not here, and says when it is gone", () => {
    machine();
    approve();
    const pulled = drill([ID], { stdin: input(), env: { NO_IMAGE: "1" } });
    expect(pulled.record?.result, pulled.output).toBe("healthy");
    expect(calls()).toContain(`docker pull ${IMAGE}`);
    rmSync(`${work}/pulled`);
    approve();
    const gone = drill([ID], { stdin: input(), env: { NO_IMAGE: "1", PULL_FAIL: "1" } });
    expect(gone.status).toBe(2);
    expect(gone.record).toMatchObject({ result: "failed", reason: "gone", removal: "removed" });
  });

  it("removes what a crashed run left first, saying so in its line", () => {
    machine();
    write(at(".drill/20261101T000000Z/compose.yaml"), "name: x\n");
    write(`${work}/drill/containers/db`, "");
    approve();
    const result = drill([ID], { stdin: input() });
    expect(result.record).toMatchObject({ result: "healthy", cleaned: true });
    expect(calls().indexOf("docker rm -f c-db")).toBeLessThan(
      calls().findIndex((call) => call.endsWith("compose.yaml create")),
    );
  });

  it("stops at its time limit and removes its copy", () => {
    machine();
    approve({ action: "keep" });
    const result = drill([ID, "--keep"], { stdin: input(), env: { DRILL_TIMEOUT: "1" } });
    expect(result.status).toBe(2);
    expect(result.record).toMatchObject({
      result: "failed",
      reason: "timeout",
      removal: "removed",
    });
    expect(existsSync(at(".drill"))).toBe(false);
  });

  it("drills the latest complete snapshot without an id, and only the part --only names", () => {
    machine();
    write(
      at(DRILL_APPROVAL_FILE),
      `${drillApprovalLine({ action: "drill", expiresAt: now() + 600 })}\n`,
    );
    const latest = drill([], { stdin: input() });
    expect(latest.record).toMatchObject({ result: "healthy", id: ID });
    approve({ id: OLDER, only: "db" });
    const only = drill([OLDER, "--only", "db"], { stdin: input({ id: OLDER, parts: ["db"] }) });
    expect(only.record).toMatchObject({ result: "healthy", id: OLDER });
    expect(only.record?.parts.map((part) => part.name)).toEqual(["db"]);
  });

  it("refuses a file outside its folder and any other line on stdin", () => {
    for (const extra of [`file ../escape ${Buffer.from("x").toString("base64")}`, "run rm -rf /"]) {
      machine();
      approve();
      const result = drill([ID], { stdin: input({ extra: [extra] }) });
      expect(result.record, extra).toMatchObject({ result: "failed", reason: "files" });
      expect(existsSync(at("escape"))).toBe(false);
      expect(existsSync(`${appDir()}/../escape`)).toBe(false);
      expect(calls().some((call) => call.endsWith("compose.yaml create"))).toBe(false);
    }
  });

  it("runs on this computer with a local build's image, which it never pulls", () => {
    const local = DeployPlanSchema.parse(onThisComputer(PLAN));
    const image = `opscrew-local/${local.app.name}:${A.slice(0, 12)}`;
    machine(local);
    approve({}, local);
    const result = drill([ID], {
      stdin: input({ image }, local),
      plan: local,
      env: { DRILL_VOLUMES: `${DRILL}_sqlite ${DRILL}_db_data` },
    });
    expect(result.record?.result, result.output).toBe("healthy");
    approve({}, local);
    const gone = drill([ID], {
      stdin: input({ image }, local),
      plan: local,
      env: { NO_IMAGE: "1" },
    });
    expect(gone.record).toMatchObject({ result: "failed", reason: "gone" });
    expect(calls().some((call) => call.startsWith("docker pull"))).toBe(false);
  });
});

describe("the drill's rendering in snapshot.sh", () => {
  it("is on the app's server only, and holds no expression GitHub Actions would read", () => {
    // One line per entry: the deploy writes it into its workflow one line at a time.
    for (const line of snapshotScript(PLAN)) expect(line).not.toContain("\n");
    const script = snapshotScript(PLAN).join("\n");
    expect(script).toContain("snapshot_cmd_drill() (");
    expect(script).toContain("drill [<id>] [--only <service>] [--keep] | drill --remove");
    expect(script).not.toContain("${{");
    // Every name it removes or creates is the drill's.
    for (const line of script.split("\n").filter((each) => each.includes("_drill"))) {
      expect(line).not.toMatch(/-p shop(\s|$)|shop_|\/srv\/data\/shop(\/|\s|$)/);
    }
  });
});
