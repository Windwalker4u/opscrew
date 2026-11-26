/**
 * The live pass of feature 047 (docs/e2e.md "PostgreSQL's two logins", quickstart.md "Live",
 * T4792), with `OPSCREW_E2E_POSTGRES_LOGINS=1` and Docker on this computer. Nothing is bought and
 * no server is created: both apps run on the localhost target.
 *
 * - **App A**, a throwaway copy of `examples/laravel-app` on PostgreSQL with a queue worker, in
 *   the private repository `OPSCREW_E2E_GITHUB_REPO`: prod designed at Hetzner and never
 *   provisioned, its `logins` environment on this computer deployed by the local runner, as
 *   `local-runner.test.ts` does. A new database (quickstart "1."), a migration later ("2."), the
 *   runtime login's limits ("3."), a restore ("6.") and the drill ("7."), then its destroy.
 * - **App B**, a copy of `examples/koa-knex` in `OPSCREW_E2E_GITHUB_REPO_C`, on this computer
 *   without a runner: provisioned first with `logins` taken out of its plan, as 0.2.11 made every
 *   database, then switched ("4.") and rotated ("5."), which the local runner's environment
 *   refuses (025: its deploys write the env files from GitHub's secrets).
 * - **Both destroyed** ("8."), and nothing of either left in Docker or at GitHub.
 *
 * Every check is real: PostgreSQL through `docker compose exec`, the apps' requests, the
 * containers' ids and start times. A password is compared by its SHA-256 or in memory, never shown.
 * Docker is touched only through the Compose projects of the two apps, the drill's and OpsCrew's
 * edge, which must be absent before the run.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import {
  caFiles,
  type LocalRunner,
  localRoots,
  localSite,
  parseDotenv,
  startLocalRunner,
} from "@opscrew/agents";
import {
  deploySecretName,
  drillName,
  EDGE_PROJECT,
  localComposeProject,
  OWNER_PASSWORD_ENV,
  RELEASE_DB_ENV,
  RUNTIME_PASSWORD_ENV,
  runnerLabel,
  runtimeDir,
} from "@opscrew/iac-templates";
import { type DeployPlan, readArtifact, writeArtifact } from "@opscrew/plan-schema";
import { afterAll, describe, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { createPhaseDeps } from "../../src/deps";
import { createTestContext, type TestContext } from "../../src/test-context";
import { docker, imageIds, removeNewImages } from "../e2e/docker-support";
import { minutes, type RepoRunner, waitFor } from "./cloud";
import {
  AppEnvironments,
  designProd,
  expectNoRunner,
  jobsOnRunner,
  opscrewUntilApproved,
  type SecretsRecord,
  secretsRecord,
  waitForRunner,
} from "./environment-checks";
import { EXAMPLES, LiveRun, serverSettings } from "./harness";
import { secretNames } from "./portainer-cloud";
import { deployedImage } from "./portainer-support";
import {
  changedFiles,
  composeExec,
  composeResources,
  containerEnv,
  fileHashes,
  KNEX_MIGRATION,
  type KnownSecret,
  LARAVEL_MIGRATION,
  LIMITS_SCRIPT,
  type LocalProject,
  laravelFiles,
  localGet,
  logsIn,
  namesLogin,
  notOwnedBy,
  OWNER,
  OWNERS_SQL,
  parseLimits,
  parseRoles,
  psql,
  ROLES_SQL,
  RUNTIME,
  roleProblems,
  runningContainer,
  SUPERUSER,
  secretsHeld,
  sha256,
  standInValues,
} from "./postgres-logins-support";
import { scriptedRotation } from "./rotation-checks";
import { approvedDrill, approvedRestore, listSnapshots } from "./snapshots-checks";
import { BUILD_JOB, missingVariables } from "./support";

const GATE = "OPSCREW_E2E_POSTGRES_LOGINS";
const MISSING = missingVariables(process.env, GATE, [
  "OPSCREW_E2E_HCLOUD_TOKEN",
  "OPSCREW_E2E_GITHUB_REPO",
  "OPSCREW_E2E_GITHUB_REPO_C",
  "OPSCREW_E2E_GITHUB_TOKEN",
]);
// No domain: both apps answer on this computer only, so nothing touches the zone.
const SETTINGS = {
  ...serverSettings(process.env),
  domain: "",
  app: "laravel-app",
  // The second app needs no runner, so its throwaway repository may be the public one.
  secondRepo: process.env.OPSCREW_E2E_GITHUB_REPO_C?.trim() ?? "",
};
/** The second app: another example than the first (the harness's rule), on PostgreSQL with Knex. */
const SECOND = "koa-knex";
/** Optional: the classic `read:packages` token provision reads GHCR with (docs/e2e.md). */
const GHCR_READ_TOKEN = process.env.OPSCREW_E2E_GHCR_READ_TOKEN?.trim() ?? "";
/**
 * App A's environment on this computer. Not `dev`: GitHub's registry of the throwaway repository
 * keeps the images other passes labelled `opscrew-dev` (another app's), which the first provision
 * would start from.
 */
const DEV = "logins";
/** A's notes: the row the restore brings back, and the one written after it. */
const NOTE = "live-1";

if (process.env[GATE] === "1" && MISSING.length > 0) {
  console.warn(
    `OpsCrew E2E (postgres logins): skipped, set ${MISSING.join(", ")} (see docs/e2e.md, "PostgreSQL's two logins").`,
  );
}

/** The interview's answers for this computer (no region, domain or DNS). */
const LOCALHOST_ANSWERS = {
  provider: "localhost",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: 20,
  uptime: "best-effort",
  dataCriticality: "important",
  keepExternalServices: { s3: false },
};

/** The plan's PostgreSQL. */
function dbOf(plan: DeployPlan) {
  const db = plan.services.find((service) => service.kind === "postgres");
  if (db === undefined) throw new Error(`${plan.app.name}'s plan has no PostgreSQL.`);
  return db;
}

/** `plan` with its PostgreSQL's options replaced by `options`. */
function withDbOptions(plan: DeployPlan, options: Record<string, unknown>): DeployPlan {
  return {
    ...plan,
    services: plan.services.map((service) =>
      service.kind === "postgres" ? ({ ...service, options } as typeof service) : service,
    ),
  };
}

/** The app's Compose project on this computer: its folder and its name. */
function localProject(run: LiveRun, plan: DeployPlan, environment?: string): LocalProject {
  return {
    folder: join(localRoots(run.paths(environment)).apps, plan.app.name),
    project: localComposeProject(plan),
  };
}

/** The env file `name` of the app's folder, parsed in memory. */
async function envFile(where: LocalProject, name: string): Promise<Map<string, string>> {
  return parseDotenv(await readFile(join(where.folder, name), "utf8"));
}

describe.skipIf(MISSING.length > 0)(
  MISSING.length > 0
    ? `live PostgreSQL logins (skipped: set ${MISSING.join(", ")}; see docs/e2e.md)`
    : "live PostgreSQL logins: examples/laravel-app on the local runner, examples/koa-knex switched, on this computer",
  () => {
    const run: LiveRun = new LiveRun({
      label: "postgres logins",
      name: "pglogins",
      settings: SETTINGS,
    });
    const envs = new AppEnvironments(run, SETTINGS.hcloudToken, { restoreMain: true });
    const second = run.second(SECOND);
    const envsB = new AppEnvironments(second, "", { restoreMain: true });
    const { log } = run;
    let plan: DeployPlan | undefined;
    let planB: DeployPlan | undefined;
    let label = "";
    let runner: RepoRunner | undefined;
    let local: LocalRunner | undefined;
    let ctx: TestContext | undefined;
    let images: Set<string> | undefined;
    let record: SecretsRecord | undefined;
    /** The image digest the logins environment ran after its first deploy on the runner. */
    let firstDigest = "";
    /** B's rows before the switch, and its db container then. */
    let rowsBefore = 0;

    const devPlan = () => plan as DeployPlan;
    /** A's deploy secret holding `release.db.env`, by the name its environment gives it. */
    const releaseSecret = () => deploySecretName(devPlan(), RELEASE_DB_ENV.secret);
    const appB = () => planB as DeployPlan;
    const devWhere = () => localProject(run, devPlan(), DEV);
    const whereB = () => localProject(second, appB());
    /** The Compose projects of the pass on this computer: the apps', the drill's, the edge. */
    const projects = () => [
      ...(plan === undefined ? [] : [localComposeProject(plan), drillName(plan.app.name)]),
      ...(planB === undefined ? [] : [localComposeProject(planB), drillName(planB.app.name)]),
      EDGE_PROJECT,
    ];
    /** The runner's folder in the run's own OpsCrew home (`<home>/runners/<app>-logins`). */
    const runnerDir = () => join(run.paths(DEV).homeDir, "runners", label.slice("opscrew-".length));

    /** An app's `.localhost` site here, and the local CA's certificate that trusts it. */
    async function siteOf(app: LiveRun, appPlan: DeployPlan, environment?: string) {
      const paths = app.paths(environment);
      const target = appPlan.target;
      if (target.provider !== "localhost") throw new Error(`${appPlan.app.name} is not here.`);
      const site = { ...(await localSite(paths, appPlan)), port: target.ports.https };
      return { site, ca: await readFile(caFiles(paths).certificate, "utf8") };
    }

    /** The JSON a GET of `path` answers with 200, waiting up to `ms` for it. */
    async function getJson(
      app: LiveRun,
      appPlan: DeployPlan,
      path: string,
      environment?: string,
      ms = minutes(5),
    ): Promise<Record<string, unknown>> {
      const { site, ca } = await siteOf(app, appPlan, environment);
      return waitFor(`${path} answering 200`, ms, async () => {
        const answer = await localGet(site, path, ca);
        if ("status" in answer && answer.status === 200) {
          return JSON.parse(answer.body) as Record<string, unknown>;
        }
        throw new Error(
          `it answered ${"status" in answer ? `HTTP ${answer.status}` : answer.error}`,
        );
      });
    }

    /** Waits until the app's health route answers 200 through the local CA. */
    async function waitForSite(app: LiveRun, appPlan: DeployPlan, environment?: string) {
      const { site, ca } = await siteOf(app, appPlan, environment);
      await waitFor(`${appPlan.app.name}'s health route answering 200`, minutes(10), async () => {
        const answer = await localGet(site, appPlan.app.healthPath, ca);
        if ("status" in answer && answer.status === 200) return true;
        throw new Error(
          `it answered ${"status" in answer ? `HTTP ${answer.status}` : answer.error}`,
        );
      });
    }

    /** The image digest A's stack runs, from its app folder's `.env` on this computer. */
    async function runningDigest(): Promise<string | undefined> {
      const file = join(devWhere().folder, ".env");
      return deployedImage(await readFile(file, "utf8").catch(() => ""))?.digest;
    }

    /**
     * The database container's three passwords (`db`'s env), each added to the scrubber at once:
     * the superuser's, the owner's and the runtime login's.
     */
    async function dbSecrets(
      where: LocalProject,
    ): Promise<{ superuser: string; owner: string; runtime: string }> {
      const env = await containerEnv((await runningContainer(where.project, "db")).id);
      const values = {
        superuser: env.get("POSTGRES_PASSWORD") ?? "",
        owner: env.get(OWNER_PASSWORD_ENV) ?? "",
        runtime: env.get(RUNTIME_PASSWORD_ENV) ?? "",
      };
      for (const [name, value] of Object.entries(values)) {
        run.scrubber.add(value, `db-${name}-password`);
      }
      return values;
    }

    /**
     * Every running app container of `appPlan` (the web and each worker): each names `app_runtime`
     * and holds neither the superuser's nor the owner's password (by SHA-256 or inside an address).
     */
    async function expectAppContainers(where: LocalProject, appPlan: DeployPlan): Promise<void> {
      const secrets = await dbSecrets(where);
      expect(secrets.superuser, "db's POSTGRES_PASSWORD").not.toBe("");
      expect(secrets.owner, `db's ${OWNER_PASSWORD_ENV}`).not.toBe("");
      const forbidden: KnownSecret[] = [
        { label: "the superuser's password", value: secrets.superuser },
        { label: "the owner's password", value: secrets.owner },
      ];
      const services = [
        "app",
        ...appPlan.processes.workers.filter((w) => w.enabled).map((w) => w.name),
      ];
      for (const service of services) {
        const env = await containerEnv((await runningContainer(where.project, service)).id);
        const names = namesLogin(env, RUNTIME);
        expect(names.length, `${service}'s env names ${RUNTIME}`).toBeGreaterThan(0);
        expect(namesLogin(env, SUPERUSER), `${service}'s env naming the superuser`).toEqual([]);
        expect(secretsHeld(env, forbidden), `${service}'s env holding a password`).toEqual([]);
        log(
          `observed: ${service}'s env names ${RUNTIME} in ${names.join(", ")} and holds neither the superuser's nor the owner's password (SHA-256 of ${env.size} values compared)`,
        );
      }
    }

    /** `release.db.env` names `app_owner`, and only Compose's `release` service reads it. */
    async function expectReleaseEnv(where: LocalProject): Promise<void> {
      const release = await envFile(where, RELEASE_DB_ENV.file);
      const secrets = await dbSecrets(where);
      const names = namesLogin(release, OWNER);
      expect(names.length, `${RELEASE_DB_ENV.file} names ${OWNER}`).toBeGreaterThan(0);
      expect(
        secretsHeld(release, [{ label: "the superuser's password", value: secrets.superuser }]),
        `${RELEASE_DB_ENV.file} holding the superuser's password`,
      ).toEqual([]);
      const compose = parseYaml(await readFile(join(where.folder, "compose.yaml"), "utf8")) as {
        services: Record<string, { env_file?: string[] }>;
      };
      const readers = Object.entries(compose.services)
        .filter(([, service]) => (service.env_file ?? []).includes(RELEASE_DB_ENV.file))
        .map(([name]) => name);
      expect(readers, `the services that read ${RELEASE_DB_ENV.file}`).toEqual(["release"]);
      log(
        `observed: ${RELEASE_DB_ENV.file} names ${OWNER} in ${names.join(", ")}, and only the release reads it`,
      );
    }

    /** The two logins are as ADR 0037 makes them, `\du` logged; every object is `owner`'s. */
    async function expectLogins(where: LocalProject, owner = OWNER): Promise<void> {
      log(`observed: \\du:\n${await psql(where, "\\du")}`);
      expect(roleProblems(parseRoles(await psql(where, ROLES_SQL))), "the two logins").toEqual([]);
      const owners = await psql(where, OWNERS_SQL);
      expect(notOwnedBy(owners, owner), `objects not owned by ${owner}`).toEqual([]);
      log(`observed: ${owners.split("\n").length} objects, every one ${owner}'s`);
    }

    /** Keeps the runner's output so far (the CLI's reporter, redacted) for the leak search. */
    function keepRunnerOutput(): void {
      if (ctx !== undefined) {
        run.outputs.set(`opscrew runner start --env ${DEV} (in-process)`, ctx.output + ctx.errors);
      }
    }

    async function stopRunner(): Promise<void> {
      await local?.stop();
      keepRunnerOutput();
    }

    /** Waits until GitHub lists the local runner online. */
    async function runnerOnline(): Promise<RepoRunner> {
      const online = await waitForRunner(run.github, label);
      const file = join(runnerDir(), ".credentials_rsaparams");
      await waitFor("the local runner's key file", minutes(2), async () => {
        const text = await readFile(file, "utf8").catch(() => undefined);
        if (text === undefined) return undefined;
        if (envs.rememberRunnerKey(text) > 0) return true;
        return process.platform === "win32" ? true : undefined;
      }).catch(() => {
        run.findings.push(
          "the local runner's key file was not readable, so the leak search misses it",
        );
      });
      return online;
    }

    /** The jobs of run `id` on the local runner: some, and never the build. */
    async function expectOnRunner(id: number): Promise<void> {
      const jobs = await jobsOnRunner(run.github, id, runner as RepoRunner, label);
      expect(jobs.length, "jobs that ran on the local runner").toBeGreaterThan(0);
      expect(jobs.includes(BUILD_JOB), "the build ran on GitHub's machines").toBe(false);
      log(`observed: run ${id}: ${jobs.join(", ")} on the local runner`);
    }

    /** Stops when Docker has any of the pass's Compose projects, which its cleanup would remove. */
    async function expectNoProjects(): Promise<void> {
      for (const project of projects()) {
        const found = await composeResources(project);
        if (found.containers.length > 0 || found.volumes.length > 0) {
          throw new Error(
            `Docker on this computer already has the Compose project ${project}, which this test would remove. Remove it with \`opscrew destroy\` in its project, then run the test again.`,
          );
        }
      }
    }

    /** The stand-in values of the plan's variables left to the user, in the run's app env file. */
    async function writeStandIns(app: LiveRun, appPlan: DeployPlan): Promise<void> {
      const names = appPlan.app.env
        .filter((entry) => entry.source === "user" && entry.optional !== true)
        .map((entry) => entry.name);
      await writeFile(join(app.work, "production.env"), standInValues(names));
      if (names.length > 0) log(`stand-in values for ${names.join(", ")}`);
    }

    // -------------------------------------------------------------------------------------------
    // App A: the Laravel copy on the local runner.

    run.step(
      "1a. A: the Laravel copy (PostgreSQL, a queue worker, its own Dockerfile) designed at Hetzner (never provisioned) and the logins environment added on this computer with the local runner; both plans say logins: separate",
      minutes(20),
      async () => {
        const info = await docker(["info", "--format", "{{.ServerVersion}}"]);
        if (info.exitCode !== 0) {
          throw new Error(
            "Docker is not running on this computer (`docker info` failed). Start it, then run the test again.",
          );
        }
        const overlay = await mkdtemp(join(tmpdir(), "opscrew-e2e-pglogins-overlay-"));
        const envExample = await readFile(join(EXAMPLES, "laravel-app", ".env.example"), "utf8");
        for (const [path, text] of Object.entries(laravelFiles(envExample))) {
          await mkdir(dirname(join(overlay, path)), { recursive: true });
          await writeFile(join(overlay, path), text);
        }
        await run.prepareRepo({
          commit: "e2e: examples/laravel-app on PostgreSQL with its two logins",
          env: {
            HCLOUD_TOKEN: SETTINGS.hcloudToken,
            ...(GHCR_READ_TOKEN === "" ? {} : { OPSCREW_GHCR_READ_TOKEN: GHCR_READ_TOKEN }),
          },
          overlay,
        });
        run.scrubber.add(GHCR_READ_TOKEN, "ghcr-read-token");
        const visibility = await run.github.call("GET", `/repos/${run.github.name}`);
        if ((visibility.json as { private?: boolean } | undefined)?.private !== true) {
          throw new Error(
            "This test runs a local runner, so OPSCREW_E2E_GITHUB_REPO must be private: a self-hosted runner must never serve a public repository.",
          );
        }
        await envs.snapshotGithub();
        const prod = await designProd(run, envs, SETTINGS.region);
        expect(dbOf(prod).options, "prod's PostgreSQL options").toEqual({ logins: "separate" });
        await writeStandIns(run, prod);
        await run.opscrewOk("env", "add", DEV, "--target", "localhost", "--runner", "local");
        const designed = await envs.designed(DEV);
        label = runnerLabel(designed);
        plan = designed;
        await expectNoProjects();
        // As a user edits the plan: the local runner deploys the image GitHub Actions built, and
        // without the kept folder this computer builds the first image as GitHub Actions does.
        const { files: _files, ...storage } = designed.storage ?? {};
        const file = run.paths(DEV).files.plan;
        const { storage: _storage, ...rest } = designed;
        await writeArtifact("plan", file, {
          ...rest,
          ...(Object.keys(storage).length > 0 ? { storage } : {}),
          target:
            designed.target.provider === "localhost"
              ? { ...designed.target, image: "registry" }
              : designed.target,
        });
        plan = await readArtifact("plan", file);
        expect(plan.environment?.runner, "the logins environment's deploy job runs on").toBe(
          "local",
        );
        expect(dbOf(plan).options, "the logins environment's PostgreSQL options").toEqual({
          logins: "separate",
        });
        expect(
          plan.processes.workers.map((w) => w.name),
          "the queue worker design found",
        ).toContain("queue-worker");
        expect(plan.app.releaseCommand, "the release command").toBe("php artisan migrate --force");
        log(
          `observed: prod's and the logins environment's plans say logins: separate under ${dbOf(plan).name}; the logins environment runs ${plan.app.name} with ${plan.processes.workers.map((w) => w.name).join(", ")}`,
        );
      },
    );

    run.step(
      "1b. A: adapt, then the logins environment provisioned on this computer: the stack running, the logins environment's deploy-setup pull request open",
      minutes(45),
      async () => {
        images = await imageIds();
        await run.adaptAndMerge();
        const output = await envs.provision(DEV, "the logins environment on this computer");
        const image = /[~+] image (.+)/.exec(output)?.[1]?.trim() ?? "(the plan named none)";
        log(`observed: the first provision started the stack from the image ${image}`);
        await envs.rememberLocalCa();
        plan = await run.readPlan(DEV);
        const { containers } = await composeResources(devWhere().project);
        expect(
          containers.length,
          "containers of the logins environment's stack running here",
        ).toBeGreaterThan(0);
        record = await secretsRecord(run.paths(DEV));
        expect(record?.names, "the logins environment's deploy secrets").toContain(releaseSecret());
        log(
          `observed: the logins environment's deploy secrets at GitHub include ${releaseSecret()}`,
        );
      },
    );

    run.step(
      "1c. A (quickstart 1.): the local runner deploys the logins environment's deploy-setup pull request; \\du lists app_owner and app_runtime with no superuser rights, every table is app_owner's, the web and the worker run as app_runtime and hold neither the superuser's nor the owner's password",
      minutes(45),
      async () => {
        ctx = createTestContext({ cwd: run.repo, env: run.env });
        local = await startLocalRunner(createPhaseDeps(ctx, { ai: false, environment: DEV }), {
          environment: DEV,
        });
        local.finished.catch((error: unknown) => {
          log(
            `the local runner stopped: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        runner = await runnerOnline();
        const workflow = posix.basename(devPlan().cicd.workflowPath);
        const id = await run.deploy("the logins environment's first deploy on the local runner", [
          workflow,
        ]);
        if (id === undefined)
          throw new Error(
            "the logins environment's provision opened no deploy-setup pull request.",
          );
        await expectOnRunner(id);
        await waitForSite(run, devPlan(), DEV);
        firstDigest = (await runningDigest()) ?? "";
        expect(firstDigest, "the image the logins environment's stack runs").not.toBe("");
        const where = devWhere();
        await expectLogins(where);
        await expectAppContainers(where, devPlan());
        await expectReleaseEnv(where);
        const whoami = await getJson(run, devPlan(), "/e2e/whoami", DEV);
        expect(whoami.user, "the web's login").toBe(RUNTIME);
        const note = `worker-${run.runId}`;
        await getJson(run, devPlan(), `/e2e/worker/${note}`, DEV);
        const done = await waitFor("the worker's job", minutes(3), async () => {
          const result = (await getJson(run, devPlan(), "/e2e/worker-result", DEV)).result;
          return typeof result === "string" && result.startsWith(note) ? result : undefined;
        });
        expect(done, "what the worker recorded").toBe(`${note} ${RUNTIME}`);
        log(`observed: the web and the queue worker run as ${RUNTIME}`);
      },
    );

    run.step(
      "2. A (quickstart 2.): a migration with an IDENTITY table and a serial table, merged and deployed by the runner as app_owner; a request inserts into both as app_runtime",
      minutes(45),
      async () => {
        runner = await runnerOnline();
        const workflow = posix.basename(devPlan().cicd.workflowPath);
        const sha = await run.merge(
          "e2e: a migration with an IDENTITY id and a serial id",
          LARAVEL_MIGRATION.path,
          LARAVEL_MIGRATION.text,
        );
        expect(
          await run.startsRun(sha, workflow),
          "the migration's push starts the logins environment's deploy",
        ).toBe(true);
        await expectOnRunner(await run.expectRuns(sha, [workflow], "the migration's deploy"));
        await waitFor(
          "the logins environment running the migration's image",
          minutes(10),
          async () => {
            const digest = await runningDigest();
            return digest !== undefined && digest !== firstDigest ? digest : undefined;
          },
        );
        await waitForSite(run, devPlan(), DEV);
        const written = await getJson(run, devPlan(), `/e2e/write/${NOTE}`, DEV);
        expect(written.user, "the login the insert ran as").toBe(RUNTIME);
        expect(typeof written.identity, "the IDENTITY id").toBe("number");
        expect(typeof written.serial, "the serial id").toBe("number");
        const where = devWhere();
        const owners = await psql(where, OWNERS_SQL);
        for (const object of [
          "e2e_identity",
          "e2e_serial",
          "e2e_identity_id_seq",
          "e2e_serial_id_seq",
        ]) {
          expect(
            owners.split("\n").find((line) => line.split(" ")[1] === object),
            `${object}'s owner`,
          ).toMatch(new RegExp(` ${OWNER}$`));
        }
        await expectLogins(where);
        log(
          `observed: the migration made e2e_identity and e2e_serial as ${OWNER}; ${RUNTIME} inserted ids ${String(written.identity)} and ${String(written.serial)}`,
        );
      },
    );

    run.step(
      "3. A (quickstart 3.): from the app's container, as its own DATABASE_URL, CREATE TABLE, CREATE ROLE, SELECT * FROM pg_authid and CREATE TEMP TABLE are each refused",
      minutes(5),
      async () => {
        const where = devWhere();
        const web = await runningContainer(where.project, "app");
        const result = await composeExec(where, "app", ["php", "-r", LIMITS_SCRIPT], {
          index: web.index,
        });
        expect(result.exitCode, `the script's exit (${run.tail(result.stderr, 5)})`).toBe(0);
        const limits = parseLimits(result.stdout);
        expect(limits.user, "the login the app's container uses").toBe(RUNTIME);
        expect(limits.from, "where the script read the login").toBe("DATABASE_URL");
        expect(limits.statements, "each statement's SQLSTATE").toEqual({
          "CREATE TABLE x (id int)": "42501",
          "CREATE ROLE x": "42501",
          "SELECT * FROM pg_authid": "42501",
          "CREATE TEMP TABLE t (i int)": "42501",
        });
        log(
          `observed: as ${limits.user} (its ${limits.from}), each statement was refused with SQLSTATE 42501`,
        );
      },
    );

    run.step(
      "6. A (quickstart 6.): a snapshot, a row deleted, the snapshot restored: the row is back, app_owner owns the tables, and the app writes again",
      minutes(20),
      async () => {
        const where = devWhere();
        await run.opscrewOk("snapshot", "--env", DEV);
        const snapshot = (await listSnapshots(run, ["--env", DEV])).find(
          (s) => s.kind === "manual",
        );
        if (snapshot === undefined) throw new Error("opscrew snapshot list lists no snapshot.");
        const rows = async () =>
          Number(await psql(where, `SELECT count(*) FROM e2e_identity WHERE note = '${NOTE}'`));
        expect(await rows(), "the row before its delete").toBe(1);
        await psql(where, `DELETE FROM e2e_identity WHERE note = '${NOTE}'`);
        expect(await rows(), "the row after its delete").toBe(0);
        const restore = await approvedRestore(run, [snapshot.id, "--env", DEV]);
        expect(restore.confirm, "the name the restore asks to type").toBe(envs.app(DEV));
        expect(await rows(), "the row after the restore").toBe(1);
        await expectLogins(where);
        await waitForSite(run, devPlan(), DEV);
        const written = await getJson(run, devPlan(), "/e2e/write/live-2", DEV);
        expect(written.user, "the login the app writes as after the restore").toBe(RUNTIME);
        log(`observed: snapshot ${snapshot.id} restored; the row is back and ${RUNTIME} writes`);
      },
    );

    run.step(
      "7. A (quickstart 7.): the restore drill, kept to look at: it passes, and its copy holds new passwords, none the app's; then removed",
      minutes(25),
      async () => {
        const where = devWhere();
        const secrets = await dbSecrets(where);
        const drill = await approvedDrill(
          run,
          ["--keep", "--env", DEV],
          "Drill hash",
          envs.app(DEV),
        );
        expect(drill.report.outcome, `the drill's outcome (${drill.report.summary})`).toBe(
          "healthy",
        );
        const copy = drillName(devPlan().app.name);
        const db = await runningContainer(copy, "db", true);
        const env = await containerEnv(db.id);
        const production: KnownSecret[] = [
          { label: "the superuser's password", value: secrets.superuser },
          { label: "the owner's password", value: secrets.owner },
          { label: "the runtime login's password", value: secrets.runtime },
        ];
        for (const name of ["POSTGRES_PASSWORD", OWNER_PASSWORD_ENV, RUNTIME_PASSWORD_ENV]) {
          const value = env.get(name) ?? "";
          expect(value.length, `the copy's ${name}`).toBeGreaterThanOrEqual(16);
          expect(value.includes("@SECRET:"), `the copy's ${name} still a placeholder`).toBe(false);
          run.scrubber.add(value, `drill-${name}`);
        }
        expect(secretsHeld(env, production), "the copy's db env holding the app's").toEqual([]);
        const app = await containerEnv((await runningContainer(copy, "app", true)).id);
        expect(secretsHeld(app, production), "the copy's app env holding the app's").toEqual([]);
        log(
          `observed: the drill was ${drill.report.outcome}; its copy's db and app hold new passwords (SHA-256 differ from production's)`,
        );
        await approvedDrill(run, ["--remove", "--env", DEV], "Removal hash", envs.app(DEV));
        expect(await composeResources(copy), "the drill's copy after --remove").toEqual({
          containers: [],
          networks: [],
          volumes: [],
        });
      },
    );

    run.step(
      "8a. A (quickstart 8.): the runner stopped, the logins environment destroyed: nothing of it left in Docker, and its deploy secrets, OPSCREW_RELEASE_DB_ENV among them, gone from GitHub",
      minutes(20),
      async () => {
        await runnerOnline();
        const stopping = local as LocalRunner;
        await stopRunner();
        await expect(stopping.finished, "the runner's end").resolves.toBeUndefined();
        local = undefined;
        // On Windows the stop ends the runner by force, and GitHub then keeps its registration
        // as running a job for about half an hour: the cleanup deletes it once GitHub lets it.
        await expectNoRunner(run.github, label).then(
          () => log("observed: GitHub lists no runner with the environment's label"),
          async () => {
            const left = (await run.github.runners()).filter((r) => r.labels.includes(label));
            log(
              `observed: GitHub still lists the stopped runner ${left.map((r) => `${r.name} (${r.status})`).join(", ")} 3 minutes after the stop; the cleanup removes it`,
            );
          },
        );
        const kept = record ?? (await secretsRecord(run.paths(DEV)));
        expect(kept?.names, "the logins environment's deploy secrets before the destroy").toContain(
          releaseSecret(),
        );
        await opscrewUntilApproved(run, [
          "destroy",
          "--env",
          DEV,
          "--confirm",
          envs.app(DEV),
          "--delete-data",
        ]);
        envs.destroyed.add(DEV);
        for (const project of [localComposeProject(devPlan()), drillName(devPlan().app.name)]) {
          expect(await composeResources(project), `Docker's ${project} after the destroy`).toEqual({
            containers: [],
            networks: [],
            volumes: [],
          });
        }
        if (kept !== undefined) await envs.expectSecretsGone(DEV, kept);
        const left = [
          ...(await secretNames(run.github)),
          ...(kept?.environment === undefined
            ? []
            : await secretNames(run.github, kept.environment)),
        ];
        expect(left, "GitHub's secrets after the logins environment's destroy").not.toContain(
          releaseSecret(),
        );
        log(
          `observed: the logins environment's ${kept?.names.length ?? 0} deploy secrets are gone from GitHub, ${releaseSecret()} among them`,
        );
      },
    );

    // -------------------------------------------------------------------------------------------
    // App B: a database made as before 047, switched and rotated, on this computer.

    run.step(
      "4a. B (quickstart 4.): koa-knex on this computer, designed (logins: separate), then provisioned with logins taken out, as 0.2.11 made every database; rows added",
      minutes(45),
      async () => {
        await second.prepareRepo({ commit: "e2e: examples/koa-knex, a database from before 047" });
        await second.initFix();
        await second.opscrewOk("analyze", "--no-ai");
        const answers = join(second.work, "answers.json");
        await writeFile(answers, JSON.stringify(LOCALHOST_ANSWERS));
        await second.opscrewOk("interview", "--answers", answers);
        await second.opscrewOk("design");
        let designed = await envsB.designed("prod");
        // No other environment builds B's image, so this computer builds it (as design should say).
        if (designed.target.provider === "localhost" && designed.target.image !== "local-build") {
          log(`B's design said target.image ${designed.target.image}; set to local-build`);
          designed = { ...designed, target: { ...designed.target, image: "local-build" } };
        }
        planB = designed;
        expect(dbOf(designed).options, "B's design").toEqual({ logins: "separate" });
        await expectNoProjects();
        await writeStandIns(second, designed);
        // The plan 0.2.11 wrote: no logins under the database's options.
        await writeArtifact("plan", second.paths().files.plan, withDbOptions(designed, {}));
        await second.git("add", "opscrew/plan.yaml");
        await second.git("commit", "-q", "-m", "e2e: the database as before 047");
        await second.git("push", "-q", "origin", "main");
        await second.adaptAndMerge();
        envsB.provisioned.add("prod");
        await second.provisionUntilDone("B, as before 047");
        await envsB.remember("prod");
        await envsB.rememberLocalCa();
        await waitForSite(second, appB());
        // As provision's next step says: verify records the first deploy, which the notice and the
        // switch need (`deployment.firstDeployAt`).
        await second.opscrewOk("verify");
        planB = await second.readPlan();
        expect(dbOf(appB()).options, "B's PostgreSQL options").toEqual({});
        expect(appB().deployment.firstDeployAt, "the first deploy verify recorded").toBeDefined();
        for (let i = 0; i < 5; i++) await getJson(second, appB(), "/");
        const where = whereB();
        await psql(
          where,
          "INSERT INTO visits (created_at) SELECT now() FROM generate_series(1, 1000)",
        );
        rowsBefore = Number(await psql(where, "SELECT count(*) FROM visits"));
        expect(rowsBefore, "B's rows").toBeGreaterThanOrEqual(1005);
        expect(await psql(where, ROLES_SQL), "logins besides the superuser").toBe("");
        expect(
          notOwnedBy(await psql(where, OWNERS_SQL), SUPERUSER),
          "objects not the superuser's",
        ).toEqual([]);
        const env = await containerEnv((await runningContainer(where.project, "app")).id);
        expect(namesLogin(env, SUPERUSER), "B's app logging in as the superuser").toEqual([
          "DATABASE_URL",
        ]);
        log(`observed: B runs with the superuser alone, ${rowsBefore} rows in visits`);
      },
    );

    run.step(
      "4b. B (quickstart 4.): provision again: the generated files and db's container are unchanged, and it says how to switch",
      minutes(30),
      async () => {
        const where = whereB();
        const db = await runningContainer(where.project, "db");
        // The files provision writes in the app's folder, not the deploy's own records (`.env`
        // naming the image that runs, `.env.previous`, the logs) or the snapshots.
        const skip = (path: string) =>
          (path.startsWith(".") && path !== ".opscrew-project") || path.endsWith(".log");
        const runtime = join(second.repo, runtimeDir(appB()));
        const before = {
          folder: await fileHashes(where.folder, skip),
          repo: await fileHashes(runtime),
        };
        const output = await second.provisionUntilDone("B again");
        expect(output.replace(/\s+/g, " "), "provision's notice").toContain(
          "Your app logs in to PostgreSQL (db) as its superuser. To give it a login that can only read and write data, add `logins: separate`",
        );
        const after = await runningContainer(where.project, "db");
        expect(after.id, "db's container id").toBe(db.id);
        expect(after.startedAt, "db's start time").toBe(db.startedAt);
        const changed = [
          ...changedFiles(before.folder, await fileHashes(where.folder, skip)),
          ...changedFiles(before.repo, await fileHashes(runtime)).map((name) => `repo ${name}`),
        ];
        expect(changed, "B's generated files changed by the second provision").toEqual([]);
        log(
          `observed: db's container ${db.id.slice(0, 12)} started ${db.startedAt} is the same, ${before.folder.size + before.repo.size} generated files unchanged, and provision says how to switch`,
        );
      },
    );

    run.step(
      "4c. B (quickstart 4.): logins: separate added; the plan shows the snapshot, the restart, the logins and the new login, approved by its hash; the rows are all there, the app answers as app_runtime, and app_owner owns its tables",
      minutes(30),
      async () => {
        const where = whereB();
        const db = await runningContainer(where.project, "db");
        const manual = async () =>
          (await listSnapshots(second)).filter((s) => s.kind === "manual").map((s) => s.id);
        const snapshots = await manual();
        await writeArtifact(
          "plan",
          second.paths().files.plan,
          withDbOptions(await second.readPlan(), { logins: "separate" }),
        );
        await second.git("add", "opscrew/plan.yaml");
        await second.git("commit", "-q", "-m", "e2e: logins: separate");
        await second.git("push", "-q", "origin", "main");
        const shown = await second.opscrewOk("provision", "--plan-only", "--yes");
        const plain = shown.output.replace(/\s+/g, " ");
        for (const line of [
          "Take a snapshot of db now.",
          "db restarts once (a few seconds) with two new passwords.",
          "The next deploy creates app_owner and app_runtime and gives app_owner the app's tables, in one transaction.",
          "From that deploy, the release command logs in as app_owner, and the app, workers and cron as app_runtime.",
        ]) {
          expect(plain, "the switch's plan").toContain(line);
        }
        expect(shown.output, "the switch's hash").toMatch(/Switch hash: [0-9a-f]{64}/);
        expect(await runningContainer(where.project, "db"), "db after --plan-only").toEqual(db);
        await second.provisionUntilDone("B's switch");
        await envsB.remember("prod");
        planB = await second.readPlan();
        const taken = (await manual()).filter((id) => !snapshots.includes(id));
        expect(taken.length, "the snapshot the switch took").toBe(1);
        const after = await runningContainer(where.project, "db");
        expect(after.startedAt, "db's start time after the switch").not.toBe(db.startedAt);
        await waitForSite(second, appB());
        const answered = await getJson(second, appB(), "/");
        expect(Number(answered.visits), "B's visits after the switch").toBeGreaterThan(rowsBefore);
        const users = await psql(
          where,
          "SELECT DISTINCT usename FROM pg_stat_activity WHERE datname = 'app' AND backend_type = 'client backend' AND pid <> pg_backend_pid() ORDER BY 1",
        );
        expect(users, "the logins the app's connections use").toBe(RUNTIME);
        await expectLogins(where);
        await expectAppContainers(where, appB());
        await expectReleaseEnv(where);
        log(
          `observed: the switch took a snapshot, db restarted (${db.startedAt} -> ${after.startedAt}), ${String(answered.visits)} visits, the app on ${users}`,
        );
      },
    );

    run.step(
      "5. B (quickstart 5.): opscrew rotate db: each password changes, the old ones are refused and the new ones log in, db's container id and start time unchanged; the app answers, and the next deploy's migration runs as app_owner",
      minutes(30),
      async () => {
        const where = whereB();
        const db = await runningContainer(where.project, "db");
        const old = await envFile(where, "db.env");
        const rotation = await scriptedRotation(second, ["db"]);
        expect(rotation.shown, "the rotation's plan").toContain("a short swap");
        expect(rotation.shown, "the rotation's plan").not.toMatch(/PostgreSQL restarts/);
        await envsB.remember("prod");
        const after = await runningContainer(where.project, "db");
        expect(after.id, "db's container id after the rotation").toBe(db.id);
        expect(after.startedAt, "db's start time after the rotation").toBe(db.startedAt);
        const now = await envFile(where, "db.env");
        for (const [login, name] of [
          [SUPERUSER, "POSTGRES_PASSWORD"],
          [OWNER, OWNER_PASSWORD_ENV],
          [RUNTIME, RUNTIME_PASSWORD_ENV],
        ] as const) {
          const before = old.get(name) ?? "";
          const value = now.get(name) ?? "";
          second.scrubber.add(value, `rotated-${name}`);
          expect(sha256(value), `${name} after the rotation`).not.toBe(sha256(before));
          expect(await logsIn(where, login, value), `${login} with the new password`).toBe(true);
          expect(await logsIn(where, login, before), `${login} with the old password`).toBe(false);
        }
        const visits = Number((await getJson(second, appB(), "/")).visits);
        expect(visits, "B's visits after the rotation").toBeGreaterThan(rowsBefore);
        await mkdir(dirname(join(second.repo, KNEX_MIGRATION.path)), { recursive: true });
        await writeFile(join(second.repo, KNEX_MIGRATION.path), KNEX_MIGRATION.text);
        await second.git("add", KNEX_MIGRATION.path);
        await second.git("commit", "-q", "-m", "e2e: a migration after the rotation");
        await second.git("push", "-q", "origin", "main");
        await second.provisionUntilDone("B's deploy after the rotation");
        expect(
          await psql(
            where,
            "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'after_rotation'",
          ),
          "the new migration's table, and its owner",
        ).toBe(OWNER);
        await expectLogins(where);
        expect(Number((await getJson(second, appB(), "/")).visits), "B's visits").toBeGreaterThan(
          visits,
        );
        log(
          `observed: the three passwords rotated with db's container ${db.id.slice(0, 12)} still started ${db.startedAt}; the next deploy migrated as ${OWNER}`,
        );
      },
    );

    run.step(
      "8b. B (quickstart 8.): destroyed; nothing of either app left in Docker (containers, networks, volumes, images) or at GitHub",
      minutes(20),
      async () => {
        await opscrewUntilApproved(second, [
          "destroy",
          "--confirm",
          appB().app.name,
          "--delete-data",
        ]);
        envsB.destroyed.add("prod");
        second.destroyed = true;
        for (const project of projects()) {
          const left = await composeResources(project);
          expect(left, `Docker's ${project} after both destroys`).toEqual({
            containers: [],
            networks: [],
            volumes: [],
          });
        }
        await removeImages();
        expect(await imagesOfPass(), "images the pass pulled or built, left in Docker").toEqual([]);
        const secrets = [...(await secretNames(run.github)), ...(await secretNames(second.github))];
        expect(
          secrets.filter((name) => name.endsWith(RELEASE_DB_ENV.secret.replace(/^OPSCREW_/, ""))),
          "a release.db.env secret left in either repository",
        ).toEqual([]);
        log(
          `observed: ${projects().join(", ")}: no container, network or volume; neither repository has a secret named *RELEASE_DB_ENV`,
        );
      },
    );

    run.step(
      "9. no token, password, generated value or local CA key in any output, commit, pull request, audit entry or state file",
      minutes(10),
      async () => {
        keepRunnerOutput();
        run.expectNothingLeaked(await envs.leaks({ cloudflare: false, others: [envsB] }));
      },
      { always: true },
    );

    /** The images the pass pulled or built: the apps' from GHCR, the local builds, the stacks'. */
    async function imageRefs(): Promise<string[]> {
      const refs = [`ghcr.io/${SETTINGS.githubRepo.toLowerCase()}`];
      for (const [app, appPlan] of [
        [run, plan],
        [second, planB],
      ] as const) {
        if (appPlan === undefined) continue;
        refs.push(`opscrew-local/${appPlan.app.name}`);
        for (const name of ["compose.yaml", "edge/compose.yaml"]) {
          const file = join(app.repo, runtimeDir(appPlan), name);
          const text = await readFile(file, "utf8").catch(() => "");
          for (const [, ref] of text.matchAll(/^\s+image: (\S+)$/gm)) {
            if (ref !== undefined && !ref.includes("$")) refs.push(ref);
          }
        }
      }
      return refs;
    }

    /** The ids of the images {@link imageRefs} names that Docker did not have before the pass. */
    async function imagesOfPass(): Promise<string[]> {
      const before = images ?? new Set<string>();
      const ids = new Set<string>();
      for (const ref of await imageRefs()) {
        const listed = await docker(["image", "ls", "-q", "--no-trunc", ref]);
        for (const id of listed.stdout.split(/s+/)) {
          if (id.startsWith("sha256:") && !before.has(id)) ids.add(id);
        }
      }
      return [...ids];
    }

    /** Removes the images the pass made that Docker did not have before it. */
    async function removeImages(): Promise<void> {
      if (images !== undefined) await removeNewImages(images, await imageRefs());
    }

    envs.registerCleanup({ others: [envsB] });
    // Registered after the harness's cleanup, so it runs before it: the runner stops before
    // anything is destroyed, and the stacks go before the run's folders do.
    afterAll(async () => {
      const problems: string[] = [];
      const attempt = async (what: string, body: () => Promise<unknown>) => {
        try {
          await body();
        } catch (error) {
          problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      await attempt("stop the local runner", stopRunner);
      if (images !== undefined) {
        if (envs.provisioned.has(DEV) && !envs.destroyed.has(DEV)) {
          log("the logins environment was not destroyed: running opscrew destroy first");
          await attempt("destroy the logins environment", async () => {
            await opscrewUntilApproved(
              run,
              ["destroy", "--env", DEV, "--confirm", envs.app(DEV), "--delete-data"],
              (...args) => run.opscrewWithin(minutes(4), ...args),
            );
            envs.destroyed.add(DEV);
          });
        }
        if (envsB.provisioned.has("prod") && !envsB.destroyed.has("prod") && planB !== undefined) {
          log("B was not destroyed: running opscrew destroy first");
          await attempt("destroy B", async () => {
            await opscrewUntilApproved(
              second,
              ["destroy", "--confirm", appB().app.name, "--delete-data"],
              (...args) => second.opscrewWithin(minutes(4), ...args),
            );
            envsB.destroyed.add("prod");
          });
        }
        for (const project of projects()) {
          await attempt(`remove what is left of ${project} in Docker`, async () => {
            const left = await composeResources(project);
            if (left.containers.length > 0) await docker(["rm", "-f", ...left.containers]);
            for (const network of left.networks) await docker(["network", "rm", network]);
            if (left.volumes.length > 0) await docker(["volume", "rm", "-f", ...left.volumes]);
          });
        }
        await attempt("remove the images this run pulled or built", removeImages);
      }
      if (label !== "") {
        await attempt("remove the stopped runner from GitHub", removeStoppedRunner);
      }
      if (problems.length > 0) {
        throw run.cleanError(
          new Error(`Cleanup left something behind:\n- ${problems.join("\n- ")}`),
        );
      }
    }, minutes(60));

    /**
     * Deletes the runners GitHub still lists with A's label, trying again each minute for up to 40
     * minutes while GitHub refuses with "currently running a job" (it keeps a runner that was
     * ended by force so for about half an hour).
     */
    async function removeStoppedRunner(): Promise<void> {
      const { github } = run;
      await waitFor(
        "GitHub letting the cleanup delete the stopped runner",
        minutes(40),
        async () => {
          const left = (await github.runners()).filter((r) => r.labels.includes(label));
          for (const runner of left) {
            const deleted = await github.call(
              "DELETE",
              `/repos/${github.name}/actions/runners/${runner.id}`,
            );
            if (deleted.status !== 204 && deleted.status !== 404) {
              throw new Error(`GitHub kept the runner ${runner.name} (HTTP ${deleted.status})`);
            }
            log(`removed the stopped runner ${runner.name} from GitHub`);
          }
          return true;
        },
        60_000,
      );
    }
  },
);
