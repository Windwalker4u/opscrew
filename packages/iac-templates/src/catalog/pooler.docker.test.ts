/**
 * PgBouncer beside PostgreSQL (feature 050) on Docker, from the rendered files: the localhost
 * target's `db` and `db-pooler` services as `renderCompose` writes them, in a Compose project of
 * their own with `db.env` as the deploy writes it (the passwords only there and in the docker
 * CLI's environment), and the logins made by the catalog's setup step, run as the deploy runs it.
 * Two PHP CLI containers (the official image, with `pdo_pgsql` installed in it since the image
 * lacks it) on the project's network play the app, its `pdo_pgsql` built against Debian 12's
 * libpq 15 in one and against PostgreSQL's own (17 or later, from apt.postgresql.org) in the other:
 * - the release's address (`db:5432`, `app_owner`) migrates;
 * - PDO with native prepared statements (no emulation) runs a few thousand queries through
 *   `db-pooler:6432` in short connections, as PHP opens one per request, with statements freed
 *   inside transactions as Laravel's query builder frees them, more processes at once than the
 *   pool has backends. In session mode every one succeeds with both libpqs (libpq 15 frees a
 *   statement with SQL `DEALLOCATE <name>`, which transaction mode broke, research 2.), PostgreSQL
 *   never has more than `default_pool_size` backends for `app_runtime`, and a second round of
 *   requests gets the first round's backends, kept warm: none started since;
 * - the runtime login's password rotates through a server's rendered `rotate.sh` units up to its
 *   env files (steps 1 to 4, which create the pooler again), after which the queries succeed on
 *   the new password and the old one is refused;
 * - the pooler's memory stays under its limit.
 *
 * It needs Docker and the network, so it runs only with OPSCREW_DOCKER_TESTS=1. The run removes its
 * project with its volume and network, the PHP containers, and the images it pulled, then lists
 * that nothing of the run is left.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { type PlanService, poolerName } from "@opscrew/plan-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { docker, hasImage } from "../__fixtures__/docker";
import { testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { renderCompose } from "../runtime";
import { localhostPlan } from "../workflow/__fixtures__/plans";
import { skipReason } from "../workflow/__fixtures__/sh";
import {
  type RotateStep,
  renderRotateScript,
  rotateEnvFiles,
  rotateInput,
} from "../workflow/rotate";
import { withPooler } from "./__fixtures__/plans";
import {
  appVariables,
  initStepsFor,
  releaseVariables,
  renderContext,
  serviceRotation,
  serviceSpec,
  workerVariables,
} from "./index";
import { POOLER_MEMORY_MB, POOLER_PORT } from "./pooler";
import { POSTGRES_RUNTIME } from "./postgres-logins";

const reason = skipReason();
if (reason) console.warn(`[iac-templates] skipping PgBouncer on Docker: ${reason}`);

/** The run's id, in every container's, volume's and network's name. */
const RUN = randomBytes(3).toString("hex");
const PROJECT = `opscrew-pooler-${RUN}`;
/** The official PHP CLI image, on Debian 12 like the app images PHP apps build on. */
const PHP_IMAGE = "php:8.5-cli-bookworm";

/** How long starting the project, installing `pdo_pgsql`, a load or removing everything may take. */
const HOOK_MS = 600_000;

/** The pooler's `default_pool_size` (pooler.ts's settings). */
const POOL_SIZE = 20;
/** The app's processes at once, more than the pool, and the short connections each opens. */
const WORKERS = 24;
const REQUESTS = 40;
/** Each request's queries: a read, then a transaction (begin, a write, two reads, commit). */
const QUERIES = 6;

/** A PHP container with `pdo_pgsql`, and how it gets the libpq `pdo_pgsql` is built against. */
interface Client {
  container: string;
  libpq: string;
}

/**
 * `pdo_pgsql` against Debian 12's libpq 15, which frees a statement with SQL `DEALLOCATE` (which
 * transaction pooling broke, research 2.).
 */
const DEBIAN: Client = {
  container: `${PROJECT}-php-libpq15`,
  libpq: "apt-get install -y -qq libpq-dev",
};
/** `pdo_pgsql` against PostgreSQL's own libpq (17 or later), which frees one with Close. */
const PGDG: Client = {
  container: `${PROJECT}-php-pgdg`,
  libpq: [
    "apt-get install -y -qq postgresql-common",
    "/usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y",
    "apt-get install -y -qq libpq-dev",
  ].join(" && "),
};
const CLIENTS = [DEBIAN, PGDG];

/**
 * The app on this computer, whose services keep their data in named volumes, which the run removes
 * (a server's are folders on the host); `rotate.sh` is rendered for the same app on a server, where
 * it runs.
 */
const plan = withPooler(localhostPlan());
const serverPlan = withPooler(testPlan());
const db = plan.services.find((service) => service.name === "db") as PlanService;
const pooler = poolerName(db);

/** The database's generated values, by the catalog's names. */
const values: Record<string, string> = {
  password: fakeSecret("generic-password", `${PROJECT}-superuser`),
  "owner-password": fakeSecret("generic-password", `${PROJECT}-owner`),
  "runtime-password": fakeSecret("generic-password", `${PROJECT}-runtime`),
};
const firstRuntime = values["runtime-password"] as string;

/** The images present before the run, by reference. */
const before = new Map<string, boolean>();

const root = mkdtempSync(join(tmpdir(), "opscrew-pooler-docker-")).replaceAll("\\", "/");

/** Docker's environment: the project's name, without Git Bash's path conversion, plus `env`. */
function dockerEnv(env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: PROJECT,
    MSYS_NO_PATHCONV: "1",
    MSYS2_ARG_CONV_EXCL: "*",
    ...env,
  };
}

interface Result {
  status: number | null;
  output: string;
}

/** `docker args` in the project's folder, its values from `env` (names only in `args`). */
function attempt(args: string[], env: Record<string, string> = {}, input = ""): Result {
  const result = spawnSync("docker", args, {
    cwd: root,
    env: dockerEnv(env),
    input,
    encoding: "utf8",
    timeout: HOOK_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/** {@link attempt} that must pass: its output, trimmed. */
function ok(args: string[], env: Record<string, string> = {}, input = ""): string {
  const result = attempt(args, env, input);
  expect(result.status, `docker ${args.join(" ")}\n${result.output}`).toBe(0);
  return result.output.trim();
}

/** `docker args` in the background, its values from `env`: its exit status and output. */
function background(args: string[], env: Record<string, string> = {}): Promise<Result> {
  const child = spawn("docker", args, { cwd: root, env: dockerEnv(env), stdio: "pipe" });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  return new Promise((resolve) => child.on("close", (status) => resolve({ status, output })));
}

/** An env file as the deploy writes it: one `NAME=value` line each. */
function envFile(env: Record<string, string>): string {
  return `${Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")}\n`;
}

/** `db.env` from {@link values}. */
function dbEnv(): string {
  return envFile(
    serviceSpec("postgres").environment(renderContext(plan, db, (name) => values[name] ?? "")),
  );
}

/** What the app's runtime processes get: the pooler's address with the runtime login. */
function runtimeUrl(): string {
  const url = appVariables(renderContext(plan, db, (name) => values[name] ?? "")).DATABASE_URL;
  if (url === undefined) throw new Error("no DATABASE_URL");
  return url;
}

/**
 * `worker.db.env` from {@link values}, as the deploy writes it beside the pooler: the workers'
 * direct address with the runtime login, for `on` (this computer's app, or the server's).
 */
function workerEnv(on: typeof plan = plan): string {
  return envFile(workerVariables(on, (_service, name) => values[name] ?? ""));
}

/** The SHA-256 of `text`, to compare env files holding passwords without printing them. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Writes `compose.yaml` (the rendered `db` and its pooler), `db.env`, `app.env` and
 * `worker.db.env`.
 */
function writeProject(): void {
  const rendered = parse(renderCompose(plan).content) as {
    services: Record<string, Record<string, unknown>>;
    networks?: Record<string, unknown>;
    volumes?: Record<string, unknown>;
  };
  const services = Object.fromEntries(
    [db.name, pooler].map((name) => [name, rendered.services[name]]),
  );
  const used = (key: "networks" | "volumes") =>
    new Set(
      Object.values(services).flatMap((service) =>
        ((service?.[key] as string[] | undefined) ?? []).map((entry) => entry.split(":")[0]),
      ),
    );
  const pick = (all: Record<string, unknown> | undefined, keep: Set<string | undefined>) =>
    Object.fromEntries(Object.entries(all ?? {}).filter(([key]) => keep.has(key)));
  writeFileSync(
    join(root, "compose.yaml"),
    stringify({
      services,
      networks: pick(rendered.networks, used("networks")),
      volumes: pick(rendered.volumes, used("volumes")),
    }),
  );
  writeFileSync(join(root, `${db.name}.env`), dbEnv());
  writeFileSync(join(root, "app.env"), envFile({ DATABASE_URL: runtimeUrl() }));
  writeFileSync(join(root, "worker.db.env"), workerEnv());
}

/** The running container of the project's `service`. */
function container(service: string): string {
  return ok(["compose", "ps", "-q", service]);
}

/** `sql` as the superuser over the database's socket, its rows unaligned. */
function superuser(sql: string): string {
  const psql = ["psql", "-X", "-q", "-At", "-U", "app", "-d", "app"];
  return ok(["compose", "exec", "-T", db.name, ...psql], {}, sql);
}

/** PostgreSQL's backends for the runtime login now, in the database's container `id`. */
function runtimeBackends(id: string): number {
  const sql = `SELECT count(*) FROM pg_stat_activity WHERE usename = '${POSTGRES_RUNTIME}';`;
  return Number(ok(["exec", id, "psql", "-X", "-q", "-At", "-U", "app", "-d", "app", "-c", sql]));
}

/** The runtime login's backends now, each as its process id and start time. */
function backendStarts(): string[] {
  const sql = `SELECT pid || ' ' || backend_start FROM pg_stat_activity WHERE usename = '${POSTGRES_RUNTIME}' ORDER BY pid;`;
  return superuser(sql).split("\n").filter(Boolean);
}

/** The pooler's memory use and limit in MiB, as `docker stats --no-stream` reports them. */
function poolerMemory(id = container(pooler)): { used: number; limit: number } {
  const usage = ok(["stats", "--no-stream", "--format", "{{.MemUsage}}", id]);
  const mib = (text: string) => {
    const match = /([\d.]+)\s*([KMG]i?B)/.exec(text);
    if (match === null) throw new Error(`docker stats said ${usage}`);
    const unit = match[2]?.[0];
    return Number(match[1]) * (unit === "K" ? 1 / 1024 : unit === "G" ? 1024 : 1);
  };
  const [used = "", limit = ""] = usage.split("/");
  return { used: mib(used), limit: mib(limit) };
}

/** PHP's connection to the database `DATABASE_URL` names, with native prepared statements. */
const CONNECT = `$url = parse_url(getenv('DATABASE_URL'));
$dsn = sprintf('pgsql:host=%s;port=%d;dbname=%s', $url['host'], $url['port'], ltrim($url['path'], '/'));
$connect = fn () => new PDO($dsn, urldecode($url['user']), urldecode($url['pass']), [
  PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
  PDO::ATTR_EMULATE_PREPARES => false,
]);`;

/**
 * A migration, as a release runs it, with a session-level advisory lock as migration tools take
 * one: the app's tables, made by the owner login.
 */
const MIGRATE = `<?php
${CONNECT}
$pdo = $connect();
$pdo->query('SELECT pg_advisory_lock(42)');
$pdo->exec('CREATE TABLE items (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text NOT NULL)');
$pdo->exec("INSERT INTO items (v) SELECT 'item ' || i FROM generate_series(1, 100) AS i");
$pdo->exec('CREATE TABLE hits (id bigserial PRIMARY KEY, worker int NOT NULL, item bigint NOT NULL)');
$pdo->query('SELECT pg_advisory_unlock(42)');
echo $pdo->query('SELECT current_user')->fetchColumn(), "\\n";
`;

/**
 * The app's requests: each a new connection, as PHP opens one per request; a read whose statement
 * is freed outside a transaction, then a transaction with a write and a read whose statements are
 * freed inside it (Laravel's \`select\` and \`insert\` free theirs when they return), a read of
 * PostgreSQL's prepared statements that must list its own (PDO's, not emulated), and its commit.
 * A backend kept from an earlier request has none of that request's, which `DISCARD ALL` dropped
 * (each connection's PDO names its statements from `pdo_stmt_00000001` again). It prints how many succeeded and failed, and the distinct errors, in one write, since the
 * workers share their output.
 */
const WORK = `<?php
[, $worker, $requests] = $argv;
${CONNECT}
function rows(PDO $pdo, string $sql, array $bindings): array {
  $statement = $pdo->prepare($sql);
  $statement->execute($bindings);
  return $statement->fetchAll(PDO::FETCH_COLUMN);
}
function change(PDO $pdo, string $sql, array $bindings): bool {
  return $pdo->prepare($sql)->execute($bindings);
}
$ok = 0;
$errors = [];
for ($i = 0; $i < (int) $requests; $i++) {
  try {
    $pdo = $connect();
    $item = $i % 100 + 1;
    if (rows($pdo, 'SELECT v FROM items WHERE id = ?', [$item]) !== ["item $item"]) {
      throw new RuntimeException('a read returned another row');
    }
    $pdo->beginTransaction();
    change($pdo, 'INSERT INTO hits (worker, item) VALUES (?, ?)', [(int) $worker, $item]);
    $mine = rows($pdo, 'SELECT count(*) FROM hits WHERE worker = ? AND item = ?', [(int) $worker, $item]);
    if ((int) $mine[0] < 1) throw new RuntimeException('the transaction did not see its own row');
    // This read's own statement is PDO's, prepared by the protocol: PostgreSQL lists it.
    $native = rows($pdo, "SELECT count(*) FROM pg_prepared_statements WHERE name LIKE 'pdo_stmt%' AND NOT from_sql", []);
    if ((int) $native[0] < 1) throw new RuntimeException('PDO emulated its prepared statements');
    $pdo->commit();
    $ok++;
  } catch (Throwable $e) {
    $errors[$e->getMessage()] = true;
  } finally {
    $pdo = null;
  }
}
echo json_encode(['ok' => $ok, 'failed' => (int) $requests - $ok, 'errors' => array_keys($errors)]) . "\\n";
`;

/**
 * Starts `client`'s container on Docker's default network, installs `pdo_pgsql` against its libpq
 * when the image lacks it, then joins it to the project's network with the scripts: its libpq.
 */
async function startClient(client: Client): Promise<string> {
  ok(["run", "-d", "--name", client.container, PHP_IMAGE, "sleep", "infinity"]);
  const modules = () => ok(["exec", client.container, "php", "-m"]).split("\n");
  if (!modules().includes("pdo_pgsql")) {
    const install = `apt-get update -qq && ${client.libpq} && docker-php-ext-install pdo_pgsql`;
    const result = await background([
      ...["exec", client.container, "sh", "-c"],
      `(${install}) > /tmp/install.log 2>&1 || { tail -n 30 /tmp/install.log; exit 1; }`,
    ]);
    expect(result.status, result.output).toBe(0);
  }
  expect(modules()).toContain("pdo_pgsql");
  ok(["network", "connect", `${PROJECT}_internal`, client.container]);
  for (const [file, script] of [
    ["/tmp/migrate.php", MIGRATE],
    ["/tmp/work.php", WORK],
  ] as const) {
    ok(["exec", "-i", client.container, "sh", "-c", `cat > ${file}`], {}, script);
  }
  return ok(["exec", client.container, "pg_config", "--version"]);
}

/** `php args` in `client`'s container with the app's `DATABASE_URL` `url`. */
function php(client: Client, url: string, args: string[]): Result {
  return attempt(["exec", "-e", "DATABASE_URL", client.container, "php", ...args], {
    DATABASE_URL: url,
  });
}

interface Outcome {
  ok: number;
  failed: number;
  errors: string[];
}

/** What {@link load} saw. */
interface Load {
  /** How many requests succeeded and failed, and their distinct errors. */
  ok: number;
  failed: number;
  errors: string[];
  /** The most backends PostgreSQL had for the runtime login, and the pooler's most memory (MiB). */
  backends: number;
  memory: number;
  seconds: number;
}

/**
 * `workers` PHP processes of `client` at once, each `requests` requests through `url`, while
 * PostgreSQL's backends for the runtime login and the pooler's memory are sampled.
 */
async function load(client: Client, url: string, workers: number, requests: number): Promise<Load> {
  const started = Date.now();
  const loop = `i=1; while [ $i -le ${workers} ]; do php /tmp/work.php $i ${requests} & i=$((i + 1)); done; wait`;
  const run = background(["exec", "-e", "DATABASE_URL", client.container, "sh", "-c", loop], {
    DATABASE_URL: url,
  });
  let running = true;
  void run.then(() => {
    running = false;
  });
  const [database, bouncer] = [container(db.name), container(pooler)];
  let backends = 0;
  let memory = 0;
  while (running) {
    backends = Math.max(backends, runtimeBackends(database));
    memory = Math.max(memory, poolerMemory(bouncer).used);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const { status, output } = await run;
  expect(status, output).toBe(0);
  const outcomes = output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Outcome);
  expect(outcomes, output).toHaveLength(workers);
  return {
    ok: outcomes.reduce((sum, outcome) => sum + outcome.ok, 0),
    failed: outcomes.reduce((sum, outcome) => sum + outcome.failed, 0),
    errors: [...new Set(outcomes.flatMap((outcome) => outcome.errors))],
    backends,
    memory,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

/** What the run measured, printed at its end (counts and versions only). */
const measured: Record<string, unknown> = {};

afterAll(() => {
  for (const client of CLIENTS) {
    spawnSync("docker", ["rm", "-fv", client.container], { stdio: "ignore" });
  }
  spawnSync("docker", ["compose", "down", "--volumes", "--remove-orphans", "--timeout", "5"], {
    cwd: root,
    env: dockerEnv(),
    stdio: "ignore",
  });
  for (const [ref, present] of before) {
    if (!present && hasImage(ref)) spawnSync("docker", ["image", "rm", ref], { stdio: "ignore" });
  }
  rmSync(root, { recursive: true, force: true });
  if (reason !== undefined) return;
  const left = (args: string[]) =>
    spawnSync("docker", args, { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  const listing = {
    containers: left(["ps", "-a", "--filter", `name=${PROJECT}`, "--format", "{{.Names}}"]),
    volumes: left(["volume", "ls", "--filter", `name=${PROJECT}`, "--format", "{{.Name}}"]),
    networks: left(["network", "ls", "--filter", `name=${PROJECT}`, "--format", "{{.Name}}"]),
    images: [...before].filter(([ref, present]) => !present && hasImage(ref)).map(([ref]) => ref),
  };
  console.info(`[iac-templates] PgBouncer on Docker: ${JSON.stringify(measured)}`);
  console.info(`[iac-templates] PgBouncer on Docker, left behind: ${JSON.stringify(listing)}`);
  expect(listing).toEqual({ containers: [], volumes: [], networks: [], images: [] });
}, HOOK_MS);

describe.skipIf(reason !== undefined)("PgBouncer beside PostgreSQL on Docker (050)", () => {
  beforeAll(async () => {
    for (const ref of [IMAGES.postgres.ref, IMAGES.pgbouncer.ref, PHP_IMAGE]) {
      before.set(ref, hasImage(ref));
      if (!hasImage(ref)) docker(["pull", ref]);
    }
    writeProject();
    ok(["compose", "up", "-d", "--wait", "--wait-timeout", "300", db.name, pooler]);
    // The catalog's setup steps, as the deploy runs each: `docker compose exec -T <service> …`.
    for (const step of initStepsFor(plan)) {
      const exec = (words: readonly string[]) =>
        attempt(["compose", "exec", "-T", step.service, ...words]);
      if (exec(step.check).status !== 0) {
        const run = exec(step.run);
        expect(run.status, run.output).toBe(0);
      }
      expect(exec(step.check).status).toBe(0);
    }
    const [debian, pgdg] = await Promise.all(CLIENTS.map(startClient));
    measured.libpq = { debian, pgdg };
    expect(debian).toMatch(/^PostgreSQL 15\./);
    expect(Number(/^PostgreSQL (\d+)/.exec(pgdg ?? "")?.[1])).toBeGreaterThanOrEqual(17);
  }, HOOK_MS);

  it("migrates over the release's direct address as the owner login", () => {
    const release = releaseVariables(plan, (_service, name) => values[name] ?? "").DATABASE_URL;
    expect(release?.endsWith(`@${db.name}:5432/app`)).toBe(true);
    const migrate = php(PGDG, release ?? "", ["/tmp/migrate.php"]);
    expect(migrate.status, migrate.output).toBe(0);
    expect(migrate.output.trim()).toBe("app_owner");
    expect(
      superuser(
        "SELECT relowner::regrole FROM pg_class WHERE relname IN ('items', 'hits') ORDER BY relname;",
      ),
    ).toBe("app_owner\napp_owner");
  });

  it.each([
    ["Debian 12's libpq 15", "debian", DEBIAN],
    ["libpq 17 or later", "pgdg", PGDG],
  ] as const)(
    "runs every request's native prepared statements through the pool's kept backends (%s)",
    async (_libpq, key, client) => {
      const url = runtimeUrl();
      expect(url.startsWith(`postgresql://${POSTGRES_RUNTIME}:`)).toBe(true);
      expect(url.endsWith(`@${pooler}:${POOLER_PORT}/app`)).toBe(true);
      const hits = Number(superuser("SELECT count(*) FROM hits;"));
      // Two rounds of short connections, more at once than the pool has backends.
      const first = await load(client, url, WORKERS, REQUESTS);
      const kept = backendStarts();
      const second = await load(client, url, WORKERS, REQUESTS);
      for (const run of [first, second]) {
        expect(run.errors).toEqual([]);
        expect(run.ok).toBe(WORKERS * REQUESTS);
        expect(run.backends).toBeGreaterThan(0);
        expect(run.backends).toBeLessThanOrEqual(POOL_SIZE);
        expect(run.memory).toBeLessThan(POOLER_MEMORY_MB);
      }
      expect(Number(superuser("SELECT count(*) FROM hits;")) - hits).toBe(2 * WORKERS * REQUESTS);
      // The second round's requests got the first round's backends: none started since.
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThanOrEqual(POOL_SIZE);
      expect(backendStarts()).toEqual(kept);
      measured[key] = {
        requests: first.ok + second.ok,
        queries: QUERIES * (first.ok + second.ok),
        seconds: first.seconds + second.seconds,
        mostBackends: Math.max(first.backends, second.backends),
        keptBackends: kept.length,
        poolerMemoryUnderLoadMiB: Math.max(first.memory, second.memory),
      };
    },
    HOOK_MS,
  );

  it("keeps the pooler's memory under its limit", () => {
    const { used, limit } = poolerMemory();
    expect(limit).toBe(POOLER_MEMORY_MB);
    expect(used).toBeGreaterThan(0);
    expect(used).toBeLessThan(POOLER_MEMORY_MB);
    measured.poolerMemoryAfterMiB = used;
  });

  it("rotates the runtime login's password through the rendered steps, then serves on the new one", {
    timeout: HOOK_MS,
  }, async () => {
    const rotation = serviceRotation(db).secrets.find((r) =>
      r.secrets.includes("runtime-password"),
    );
    if (rotation === undefined) throw new Error("no rotation of runtime-password");
    const ctx = renderContext(plan, db);
    const step: RotateStep = {
      service: db.name,
      envFile: `${db.name}.env`,
      mode: rotation.mode,
      begin: rotation.begin(ctx),
      finish: rotation.finish(ctx),
      recreate: rotation.recreate,
      secrets: rotation.secrets,
    };
    const old = runtimeUrl();
    const oldWorkers = sha256(workerEnv(serverPlan));
    const next = fakeSecret("generic-password", `${PROJECT}-runtime-next`);
    values["runtime-password"] = next;
    expect(rotateEnvFiles(serverPlan, [step])).toEqual([
      "app.env",
      "worker.db.env",
      `${db.name}.env`,
    ]);
    const input = rotateInput(serverPlan, [step], {
      envFiles: {
        "app.env": envFile({ DATABASE_URL: runtimeUrl() }),
        "worker.db.env": workerEnv(serverPlan),
        [`${db.name}.env`]: dbEnv(),
      },
      values: [{ old: firstRuntime, new: next }],
    });
    const recreated = container(pooler);
    const units = runUnits(renderRotateScript(serverPlan, [step]), input);
    expect(units.status, units.output).toBe(0);
    expect(units.output).toBe("");
    // The workers' env file now holds the new runtime password, compared by hash only.
    const workers = readFileSync(join(root, "worker.db.env"), "utf8");
    expect(sha256(workers)).toBe(sha256(workerEnv(serverPlan)));
    expect(sha256(workers)).not.toBe(oldWorkers);
    // The pooler is a new container, started from the new env file.
    expect(container(pooler)).not.toBe(recreated);
    const run = await load(PGDG, runtimeUrl(), WORKERS, 10);
    expect(run.errors).toEqual([]);
    expect(run.ok).toBe(WORKERS * 10);
    expect(run.backends).toBeLessThanOrEqual(POOL_SIZE);
    const refused = php(PGDG, old, ["/tmp/work.php", "0", "1"]);
    expect(refused.status).toBe(0);
    expect(JSON.parse(refused.output.trim())).toMatchObject({ ok: 0, failed: 1 });
    // PgBouncer refuses the old password itself, in its SCRAM exchange with the client.
    expect(refused.output).toContain("FATAL:  SASL authentication failed");
    for (const text of [ok(["compose", "logs", pooler]), ok(["compose", "logs", db.name])]) {
      for (const value of [firstRuntime, next]) expect(text.includes(value)).toBe(false);
    }
    measured.rotated = { requests: run.ok, mostBackends: run.backends };
  });
});

/**
 * The rendered `rotate.sh`'s units up to its env files (steps 1 to 4: the hold, the kept env files,
 * the login's new password in PostgreSQL, the new env files and the pooler created again), run with
 * its own functions and its own reading of `input`, in the project's folder. The app's switch
 * (step 5) is the PHP container's next requests with the new `app.env`'s address.
 */
function runUnits(script: string[], input: string): Result {
  const from = (start: string, end: (line: string) => boolean) => {
    const first = script.indexOf(start);
    expect(first, start).toBeGreaterThanOrEqual(0);
    return script.slice(
      first,
      script.findIndex((line, i) => i > first && end(line)),
    );
  };
  const functions = from("rot_save() {", (line) => line.startsWith("case "));
  const reads = script.filter((line) => line.startsWith("IFS= read -r rot_"));
  const firstUnit = script.find((line) => line.startsWith('  if [ "$rot_done" -lt 1 ]')) ?? "";
  const units = from(firstUnit, (line) => line.includes("rot_step=5;")).slice(0, -1);
  expect(units.join("\n")).toContain(`--force-recreate ${pooler}`);
  const last = units.filter((line) => /rot_step=[1-4];/.test(line)).length;
  mkdirSync(join(root, ".rotate"), { recursive: true });
  const runner = [
    "set -eu",
    "umask 077",
    `rot_hash=${"0".repeat(64)}`,
    "rot_done=0",
    "rot_undone=0",
    `rot_last=${last}`,
    ...functions,
    ...reads,
    "exec < /dev/null",
    ...units,
  ];
  writeFileSync(join(root, "units.sh"), `${runner.join("\n")}\n`);
  const result = spawnSync("sh", ["units.sh"], {
    cwd: root,
    env: dockerEnv(),
    input,
    encoding: "utf8",
    timeout: HOOK_MS,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
