/**
 * What 047's live pass (`postgres-logins.test.ts`, docs/e2e.md "PostgreSQL's two logins") needs
 * beside the harness: the throwaway copies' extra files, the queries and the PHP script it runs in
 * the containers, and the readers of their answers. A password is never printed: the checks hash
 * or compare values in memory and report names and labels only.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { request } from "node:https";
import { join, relative } from "node:path";
import { NodeCommandRunner } from "@opscrew/core";
import { POSTGRES_OWNER, POSTGRES_RUNTIME } from "@opscrew/iac-templates";
import { z } from "zod";
import { docker } from "../e2e/docker-support";

/** The three logins of an app's PostgreSQL with `logins: separate` (ADR 0037). */
export const SUPERUSER = "app";
export const OWNER = POSTGRES_OWNER;
export const RUNTIME = POSTGRES_RUNTIME;

/** The SHA-256 of `value`, in hex: how the pass compares secrets without showing them. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// The throwaway copies.

/**
 * The Laravel copy's own Dockerfile. The localhost target's first provision with the local runner
 * starts the stack from an image this computer builds as GitHub Actions does (docs/guide/
 * localhost.md), which Railpack's build of the example is not, so the copy brings a Dockerfile
 * of its own: PHP 8.4 with `pdo_pgsql`, Composer's production install, PHP's built-in server.
 */
export const LARAVEL_DOCKERFILE = [
  "# 047's live pass: the Laravel example's own image, which this computer builds for the local",
  "# runner's first deploy as GitHub Actions does afterwards.",
  "FROM php:8.4-cli-alpine",
  "RUN apk add --no-cache postgresql-dev unzip && docker-php-ext-install pdo_pgsql",
  "COPY --from=composer:2 /usr/bin/composer /usr/bin/composer",
  "WORKDIR /app",
  "COPY composer.json composer.lock ./",
  "RUN composer install --no-dev --no-scripts --no-autoloader --no-interaction --prefer-dist",
  "COPY . .",
  "RUN composer dump-autoload --optimize --no-dev \\",
  "  && php artisan package:discover --ansi \\",
  "  && chown -R www-data:www-data storage bootstrap/cache",
  "USER www-data",
  "ENV PORT=8080 PHP_CLI_SERVER_WORKERS=4",
  "EXPOSE 8080",
  'CMD ["sh", "-c", "cd public && exec php -S 0.0.0.0:$PORT ../vendor/laravel/framework/src/Illuminate/Foundation/resources/server.php"]',
  "",
].join("\n");

/** A queued job, so design gives the app its queue worker on the database driver. */
const LARAVEL_JOB = [
  "<?php",
  "",
  "namespace App\\Jobs;",
  "",
  "use Illuminate\\Contracts\\Queue\\ShouldQueue;",
  "use Illuminate\\Foundation\\Queue\\Queueable;",
  "use Illuminate\\Support\\Facades\\Cache;",
  "use Illuminate\\Support\\Facades\\DB;",
  "",
  "/** 047's live pass: the worker records the note and the login it ran as, in the cache table. */",
  "class RecordNote implements ShouldQueue",
  "{",
  "    use Queueable;",
  "",
  "    public function __construct(public string $note) {}",
  "",
  "    public function handle(): void",
  "    {",
  "        $user = DB::selectOne('select current_user as name')->name;",
  "        Cache::forever('e2e-worker', $this->note.' '.$user);",
  "    }",
  "}",
  "",
].join("\n");

/**
 * The Laravel copy's routes: the welcome page, then the pass's own. `whoami` names the web's login,
 * `worker` queues a job and `worker-result` reads what the worker recorded; `write` and `rows`
 * use the tables of the later migration ({@link LARAVEL_MIGRATION}), which they need only after it.
 */
const LARAVEL_ROUTES = [
  "<?php",
  "",
  "use App\\Jobs\\RecordNote;",
  "use Illuminate\\Support\\Facades\\Cache;",
  "use Illuminate\\Support\\Facades\\DB;",
  "use Illuminate\\Support\\Facades\\Route;",
  "",
  "Route::get('/', function () {",
  "    return view('welcome');",
  "});",
  "",
  "// 047's live pass.",
  "Route::get('/e2e/whoami', function () {",
  "    return ['user' => DB::selectOne('select current_user as name')->name];",
  "});",
  "",
  "Route::get('/e2e/worker/{note}', function (string $note) {",
  "    RecordNote::dispatch($note);",
  "",
  "    return ['queued' => $note];",
  "});",
  "",
  "Route::get('/e2e/worker-result', function () {",
  "    return ['result' => Cache::get('e2e-worker')];",
  "});",
  "",
  "Route::get('/e2e/write/{note}', function (string $note) {",
  "    return [",
  "        'identity' => DB::table('e2e_identity')->insertGetId(['note' => $note]),",
  "        'serial' => DB::table('e2e_serial')->insertGetId(['note' => $note]),",
  "        'user' => DB::selectOne('select current_user as name')->name,",
  "    ];",
  "});",
  "",
  "Route::get('/e2e/rows/{note}', function (string $note) {",
  "    return [",
  "        'identity' => DB::table('e2e_identity')->where('note', $note)->count(),",
  "        'serial' => DB::table('e2e_serial')->where('note', $note)->count(),",
  "    ];",
  "});",
  "",
].join("\n");

/**
 * `envExample`, the example's `.env.example`, as `laravel new --database=pgsql` writes it:
 * `DB_CONNECTION=pgsql` and the database's settings no longer commented out, so the app reads
 * them one by one and gets OpsCrew's split settings.
 */
export function pgsqlEnvExample(envExample: string): string {
  if (!/^DB_CONNECTION=sqlite$/m.test(envExample)) {
    throw new Error("examples/laravel-app/.env.example no longer says DB_CONNECTION=sqlite.");
  }
  return envExample
    .replace(/^DB_CONNECTION=sqlite$/m, "DB_CONNECTION=pgsql")
    .replace(/^# (DB_(?:HOST|PORT|DATABASE|USERNAME|PASSWORD)=.*)$/gm, "$1")
    .replace(/^DB_PORT=3306$/m, "DB_PORT=5432");
}

/**
 * The files the pass writes over `examples/laravel-app` in its throwaway copy: PostgreSQL as the
 * app's database ({@link pgsqlEnvExample}), a queued job, the pass's routes and the copy's own
 * Dockerfile.
 */
export function laravelFiles(envExample: string): Record<string, string> {
  return {
    ".env.example": pgsqlEnvExample(envExample),
    Dockerfile: LARAVEL_DOCKERFILE,
    "app/Jobs/RecordNote.php": LARAVEL_JOB,
    "routes/web.php": LARAVEL_ROUTES,
  };
}

/**
 * Stand-in values for the variables the Laravel copy's plan leaves to the user (`source: user`,
 * not optional): mail, Redis and S3 settings the app never uses here. `null` is Laravel's own
 * word for no value.
 */
export function standInValues(names: readonly string[]): string {
  const known: Record<string, string> = {
    AWS_DEFAULT_REGION: "us-east-1",
    MAIL_FROM_NAME: "Laravel",
    VITE_APP_NAME: "Laravel",
  };
  return names.map((name) => `${name}=${known[name] ?? "null"}\n`).join("");
}

/** Quickstart "2.": the later migration, a table with an `IDENTITY` id and one with `serial`. */
export const LARAVEL_MIGRATION = {
  path: "database/migrations/2026_11_26_000000_create_e2e_tables.php",
  text: [
    "<?php",
    "",
    "use Illuminate\\Database\\Migrations\\Migration;",
    "use Illuminate\\Support\\Facades\\DB;",
    "",
    "return new class extends Migration",
    "{",
    "    public function up(): void",
    "    {",
    "        DB::statement('CREATE TABLE e2e_identity (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text NOT NULL)');",
    "        DB::statement('CREATE TABLE e2e_serial (id serial PRIMARY KEY, note text NOT NULL)');",
    "    }",
    "",
    "    public function down(): void",
    "    {",
    "        DB::statement('DROP TABLE e2e_serial');",
    "        DB::statement('DROP TABLE e2e_identity');",
    "    }",
    "};",
    "",
  ].join("\n"),
} as const;

/** Quickstart "5.": the second app's migration after the rotation, which its next deploy runs. */
export const KNEX_MIGRATION = {
  path: "migrations/20261126000000_create_after_rotation.js",
  text: [
    "/**",
    ' * @param { import("knex").Knex } knex',
    " * @returns { Promise<void> }",
    " */",
    "exports.up = function (knex) {",
    '  return knex.schema.createTable("after_rotation", (table) => {',
    '    table.increments("id");',
    '    table.text("note");',
    "  });",
    "};",
    "",
    "/**",
    ' * @param { import("knex").Knex } knex',
    " * @returns { Promise<void> }",
    " */",
    "exports.down = function (knex) {",
    '  return knex.schema.dropTable("after_rotation");',
    "};",
    "",
  ].join("\n"),
} as const;

// ---------------------------------------------------------------------------------------------
// What the pass asks PostgreSQL and the app's container.

/** The two logins' attributes, one `|`-separated line each (`psql -At`). */
export const ROLES_SQL = `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolcanlogin, (SELECT count(*) FROM pg_auth_members m WHERE m.member = r.oid) FROM pg_roles r WHERE rolname IN ('${OWNER}', '${RUNTIME}') ORDER BY rolname`;

/** The owner of every table, view, sequence and schema of the app's (`public`), one per line. */
export const OWNERS_SQL = [
  "SELECT c.relkind::text || ' ' || c.relname || ' ' || pg_get_userbyid(c.relowner) FROM pg_class c",
  "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'",
  "AND c.relkind IN ('r', 'p', 'v', 'm', 'S')",
  // PostgreSQL 15's `pg_database_owner` owning `public` is the database's owner: named as such.
  "UNION ALL SELECT 'schema public ' || CASE WHEN nspowner = 'pg_database_owner'::regrole",
  "THEN (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database())",
  "ELSE pg_get_userbyid(nspowner) END FROM pg_namespace WHERE nspname = 'public'",
  "UNION ALL SELECT 'database app ' || pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'app'",
  "ORDER BY 1",
].join(" ");

/** One login's attributes as {@link ROLES_SQL} reads them. */
export interface RoleRow {
  name: string;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  inherit: boolean;
  replication: boolean;
  bypassrls: boolean;
  login: boolean;
  memberships: number;
}

/** The rows of {@link ROLES_SQL}'s `psql -At` output. */
export function parseRoles(text: string): RoleRow[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const [name = "", ...flags] = line.trim().split("|");
      const flag = (index: number) => flags[index] === "t";
      return {
        name,
        superuser: flag(0),
        createdb: flag(1),
        createrole: flag(2),
        inherit: flag(3),
        replication: flag(4),
        bypassrls: flag(5),
        login: flag(6),
        memberships: Number(flags[7] ?? "NaN"),
      };
    });
}

/**
 * What is wrong with the two logins (ADR 0037, D1): each must exist and log in, with every other
 * attribute off and no memberships. Empty when both are as OpsCrew makes them.
 */
export function roleProblems(rows: readonly RoleRow[]): string[] {
  const problems: string[] = [];
  for (const name of [OWNER, RUNTIME]) {
    const row = rows.find((candidate) => candidate.name === name);
    if (row === undefined) {
      problems.push(`${name} is missing`);
      continue;
    }
    if (!row.login) problems.push(`${name} can't log in`);
    for (const key of [
      "superuser",
      "createdb",
      "createrole",
      "inherit",
      "replication",
      "bypassrls",
    ] as const) {
      if (row[key]) problems.push(`${name} has ${key}`);
    }
    if (row.memberships !== 0) problems.push(`${name} is a member of ${row.memberships} role(s)`);
  }
  return problems;
}

/** The lines of {@link OWNERS_SQL} whose owner is not `owner` (`r visits app`). */
export function notOwnedBy(text: string, owner: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.split(" ").at(-1) !== owner);
}

/**
 * Quickstart "3.": the PHP script the pass runs in the app's container with `php -r`. It logs in
 * as the container's own `DATABASE_URL` (the split settings `DB_*` when there is none) and prints
 * JSON: the login, where it came from, and each statement's SQLSTATE (`ok` when it ran).
 */
export const LIMITS_SCRIPT = [
  "$url = getenv('DATABASE_URL');",
  "if ($url !== false && $url !== '') {",
  "  $u = parse_url($url); $from = 'DATABASE_URL';",
  "  $host = $u['host']; $port = $u['port'] ?? 5432; $db = ltrim($u['path'], '/');",
  "  $user = rawurldecode($u['user']); $pass = rawurldecode($u['pass']);",
  "} else {",
  "  $from = 'DB_*';",
  "  $host = getenv('DB_HOST'); $port = getenv('DB_PORT') ?: 5432; $db = getenv('DB_DATABASE');",
  "  $user = getenv('DB_USERNAME'); $pass = getenv('DB_PASSWORD');",
  "}",
  '$pdo = new PDO("pgsql:host=$host;port=$port;dbname=$db", $user, $pass, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);',
  "$out = ['from' => $from, 'user' => $pdo->query('select current_user')->fetchColumn(), 'statements' => []];",
  "foreach (['CREATE TABLE x (id int)', 'CREATE ROLE x', 'SELECT * FROM pg_authid', 'CREATE TEMP TABLE t (i int)'] as $sql) {",
  "  try { $pdo->query($sql); $out['statements'][$sql] = 'ok'; }",
  "  catch (PDOException $e) { $out['statements'][$sql] = (string) $e->getCode(); }",
  "}",
  "echo json_encode($out), PHP_EOL;",
].join("\n");

const LimitsSchema = z.object({
  from: z.string(),
  user: z.string(),
  statements: z.record(z.string(), z.string()),
});
export type Limits = z.infer<typeof LimitsSchema>;

/** {@link LIMITS_SCRIPT}'s answer: its last line, as JSON. */
export function parseLimits(stdout: string): Limits {
  const line = stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return LimitsSchema.parse(JSON.parse(line));
}

// ---------------------------------------------------------------------------------------------
// Containers' environments, compared without showing a value.

/** A secret the pass looks for in a container's environment: its label and its value. */
export interface KnownSecret {
  label: string;
  value: string;
}

/**
 * The names of `env`'s variables that hold one of `secrets` (equal by SHA-256, or inside a longer
 * value such as an address), each with the secret's label: `DATABASE_URL (the superuser's
 * password)`. Values are never part of the answer.
 */
export function secretsHeld(
  env: ReadonlyMap<string, string>,
  secrets: readonly KnownSecret[],
): string[] {
  const held: string[] = [];
  for (const [name, value] of env) {
    for (const secret of secrets) {
      if (secret.value === "") continue;
      if (sha256(value) === sha256(secret.value) || value.includes(secret.value)) {
        held.push(`${name} (${secret.label})`);
      }
    }
  }
  return held;
}

/**
 * The names of `env`'s variables that name the login `login`: a user setting (`DB_USERNAME`,
 * `DB_USER`) equal to it, or an address whose user it is (`postgresql://app_runtime:…@db/app`).
 */
export function namesLogin(env: ReadonlyMap<string, string>, login: string): string[] {
  const address = new RegExp(`^postgres(?:ql)?://${login}:`);
  return [...env]
    .filter(
      ([name, value]) =>
        (/(?:^|_)USER(?:NAME)?$/.test(name) && value === login) || address.test(value),
    )
    .map(([name]) => name);
}

/** `NAME=value` lines (a container's `Config.Env`) as a map; nothing is printed. */
export function envMap(lines: readonly string[]): Map<string, string> {
  return new Map(
    lines
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

// ---------------------------------------------------------------------------------------------
// Docker, through the Compose projects of the pass's apps only.

/** What Docker lists with one Compose project label. */
export interface ComposeResources {
  containers: string[];
  networks: string[];
  volumes: string[];
}

/** The containers, networks and volumes Docker lists with the Compose project label `project`. */
export async function composeResources(project: string): Promise<ComposeResources> {
  const list = async (args: string[]) => {
    const listed = await docker([
      ...args,
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]);
    if (listed.exitCode !== 0) throw new Error(`docker ${args[0]} failed: ${listed.stderr.trim()}`);
    return listed.stdout.split(/\s+/).filter((name) => name !== "");
  };
  return {
    containers: await list(["ps", "-a", "--format", "{{.Names}}"]),
    networks: await list(["network", "ls", "--format", "{{.Name}}"]),
    volumes: await list(["volume", "ls", "--format", "{{.Name}}"]),
  };
}

/** A running container of a Compose project's service. */
export interface ServiceContainer {
  id: string;
  /** Compose's container number (`--index` for `docker compose exec`). */
  index: number;
  startedAt: string;
}

/**
 * The running container of `service` in the Compose project `project` (the newest one); with
 * `all`, also a stopped one (a drill's kept copy).
 */
export async function runningContainer(
  project: string,
  service: string,
  all = false,
): Promise<ServiceContainer> {
  const listed = await docker([
    "ps",
    ...(all ? ["-a"] : []),
    "-q",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ]);
  const ids = listed.stdout.split(/\s+/).filter((id) => id !== "");
  const found: ServiceContainer[] = [];
  for (const id of ids) {
    const seen = await docker([
      "inspect",
      "--format",
      '{{.State.StartedAt}} {{index .Config.Labels "com.docker.compose.container-number"}}',
      id,
    ]);
    const [startedAt = "", index = "1"] = seen.stdout.trim().split(" ");
    found.push({ id, index: Number(index), startedAt });
  }
  const newest = found.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (newest === undefined) throw new Error(`No ${service} container of ${project} runs.`);
  return newest;
}

/** A container's environment (`Config.Env`), read into memory only. */
export async function containerEnv(id: string): Promise<Map<string, string>> {
  const seen = await docker(["inspect", "--format", "{{json .Config.Env}}", id]);
  if (seen.exitCode !== 0) throw new Error(`docker inspect of ${id.slice(0, 12)} failed.`);
  return envMap(z.array(z.string()).parse(JSON.parse(seen.stdout)));
}

const RUNNER = new NodeCommandRunner();

/** Where a pass app's Compose project is on this computer: its folder and its name. */
export interface LocalProject {
  folder: string;
  project: string;
}

/**
 * `docker compose exec -T <service> <command>` in the app's folder; with `password`, `PGPASSWORD`
 * reaches the container by name only (`-e PGPASSWORD`), from this process's child environment.
 */
export async function composeExec(
  where: LocalProject,
  service: string,
  command: readonly string[],
  options: { index?: number; password?: string } = {},
) {
  return RUNNER.run(
    "docker",
    [
      "compose",
      "-p",
      where.project,
      "exec",
      "-T",
      ...(options.index === undefined ? [] : ["--index", String(options.index)]),
      ...(options.password === undefined ? [] : ["-e", "PGPASSWORD"]),
      service,
      ...command,
    ],
    {
      cwd: where.folder,
      env: {
        ...process.env,
        ...(options.password === undefined ? {} : { PGPASSWORD: options.password }),
      },
      timeoutMs: 120_000,
    },
  );
}

/**
 * `sql` through `docker compose exec db psql` as the superuser over the container's socket, one
 * row per line (`-At`); throws with psql's error (which holds no value) unless it exits 0.
 */
export async function psql(where: LocalProject, sql: string): Promise<string> {
  const result = await composeExec(where, "db", [
    "psql",
    "-X",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    SUPERUSER,
    "-d",
    "app",
    "-c",
    sql,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`psql failed (exit ${result.exitCode}): ${result.stderr.trim().slice(-400)}`);
  }
  return result.stdout.trim();
}

/**
 * Whether `login` logs in over TCP with `password` (`psql -h db` from the database's own
 * container, so the server's password rule applies, not the socket's trust).
 */
export async function logsIn(
  where: LocalProject,
  login: string,
  password: string,
): Promise<boolean> {
  const result = await composeExec(
    where,
    "db",
    ["psql", "-X", "-At", "-h", "db", "-U", login, "-d", "app", "-c", "select current_user"],
    { password },
  );
  return result.exitCode === 0 && result.stdout.trim() === login;
}

/** The SHA-256 of every file under `dir` but those `skip` names (relative, `/`-separated). */
export async function fileHashes(
  dir: string,
  skip: (path: string) => boolean = () => false,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const name = relative(dir, path).replaceAll("\\", "/");
      if (skip(name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) hashes.set(name, sha256(await readFile(path, "utf8")));
    }
  };
  await walk(dir);
  return hashes;
}

/** The names whose hash differs between `before` and `after`, or that only one of them has. */
export function changedFiles(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((name) => before.get(name) !== after.get(name))
    .sort();
}

// ---------------------------------------------------------------------------------------------
// The app's requests on this computer.

/** What a GET to a local stack got: its status and body, or the error's code. */
export type LocalAnswer = { status: number; body: string } | { error: string };

/**
 * One HTTPS GET of `path` from `https://<hostname>:<port>` through 127.0.0.1, with the hostname as
 * Host header and SNI (Windows and macOS resolve no `*.localhost` for Node), trusting only `ca`.
 */
export function localGet(
  site: { hostname: string; port: number },
  path: string,
  ca: string,
): Promise<LocalAnswer> {
  const host = site.port === 443 ? site.hostname : `${site.hostname}:${site.port}`;
  return new Promise((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: site.port,
        path,
        servername: site.hostname,
        headers: { Host: host, Accept: "application/json" },
        agent: false,
        timeout: 30_000,
        ca,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message }),
    );
    req.end();
  });
}
