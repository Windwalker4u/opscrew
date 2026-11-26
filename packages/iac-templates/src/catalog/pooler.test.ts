import { fakeSecret } from "@opscrew/core/testing";
import {
  type DeployPlan,
  type PlanService,
  poolerName,
  postgresPooler,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testCloudflareAccount, testContext, testPlan } from "../__fixtures__/plans";
import { IMAGES } from "../pins";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { fillPortainerStack, renderPortainerStack } from "../portainer-target/stack";
import { renderDeployment } from "../render";
import { publishedOnNetwork } from "../runtime/components";
import { renderCompose, renderServerCompose } from "../runtime/index";
import { localhostPlan, splitPlan, withPlan, withProcesses } from "../workflow/__fixtures__/plans";
import { withAppEnv, withLogins, withPooler } from "./__fixtures__/plans";
import {
  appVariables,
  releaseVariables,
  serviceSecrets,
  serviceSpec,
  splitDatabaseSettings,
  workerVariables,
} from "./index";
import { POOLER_HEALTHCHECK, POOLER_MEMORY_MB, POOLER_PORT, poolerStart } from "./pooler";
import type { ServiceContext } from "./types";

type ComposeService = Record<string, unknown> & {
  env_file?: string[];
  environment?: Record<string, string>;
  depends_on?: Record<string, { condition: string }>;
  entrypoint?: string[];
  ports?: string[];
};

/** The plan's service `name`. */
function serviceOf(plan: DeployPlan, name = "db"): PlanService {
  const service = plan.services.find((s) => s.name === name);
  if (service === undefined) throw new Error(`no service ${name}`);
  return service;
}

/** The context of the plan's service `name`, its secrets as `<name>`. */
function ctx(plan: DeployPlan, name = "db", variable?: string): ServiceContext {
  return {
    plan,
    service: serviceOf(plan, name),
    secretRef: (secret) => `<${secret}>`,
    ...(variable === undefined ? {} : { variable }),
  };
}

/** A release's secret reference: `<service:secret>`. */
const secretOf = (service: PlanService, name: string) => `<${service.name}:${name}>`;

/** The services of a Compose document. */
function composeServices(content: string): Record<string, ComposeService> {
  return (parse(content) as { services: Record<string, ComposeService> }).services;
}

/** `plan` with a release command, a worker and a cron job: every container of the app's image. */
function full(plan: DeployPlan): DeployPlan {
  return withProcesses(withPlan(plan, { releaseCommand: "php artisan migrate --force" }), {
    workers: [{ name: "jobs", command: "php artisan queue:work" }],
    cron: [{ name: "nightly", schedule: "0 3 * * *", command: "php artisan schedule:run" }],
  });
}

/** The pooler's start script, from its entrypoint `/bin/sh -c <script>`. */
function script(service: PlanService): string {
  const [shell, flag, text] = poolerStart(service);
  expect([shell, flag]).toEqual(["/bin/sh", "-c"]);
  return text ?? "";
}

/** The app's image, as a Portainer stack's deploy fills it in. */
const IMAGE = `ghcr.io/acme/shop@sha256:${"ab".repeat(32)}`;

const POOLED = "postgresql://app_runtime:<runtime-password>@db-pooler:6432/app";

/** A Laravel app's database names: the split settings and an alias of the URL. */
const LARAVEL = ["DB_HOST", "DB_PORT", "DB_USERNAME", "DB_PASSWORD", "POSTGRES_URL"];

describe("PgBouncer beside PostgreSQL (050)", () => {
  const plan = withPooler(testPlan());
  const db = serviceOf(plan);

  it("is the plan's option, and needs no secret of its own", () => {
    expect(postgresPooler(db)).toBe(true);
    expect(serviceSecrets(db)).toEqual(serviceSecrets(serviceOf(withLogins(testPlan()))));
    expect(poolerName(db)).toBe("db-pooler");
    expect(POOLER_PORT).toBe(6432);
    expect(POOLER_MEMORY_MB).toBe(32);
  });

  it("gives the app the pooler's address with the runtime login, by every name", () => {
    expect(appVariables(ctx(plan, "db", "PG_URL"))).toEqual({
      DATABASE_URL: POOLED,
      PG_URL: POOLED,
    });
    expect(splitDatabaseSettings(ctx(plan))).toEqual({
      host: "db-pooler",
      port: "6432",
      database: "app",
      user: "app_runtime",
      password: "<runtime-password>",
    });
  });

  it("keeps the release on PostgreSQL itself, with the owner's login, by every name", () => {
    const laravel = withAppEnv(plan, LARAVEL);
    expect(releaseVariables(laravel, secretOf)).toEqual({
      DATABASE_URL: "postgresql://app_owner:<db:owner-password>@db:5432/app",
      // An app reading DB_HOST (no DB_URL) migrates on PostgreSQL itself too, not on the pooler.
      DB_HOST: "db",
      DB_PORT: "5432",
      DB_USERNAME: "app_owner",
      DB_PASSWORD: "<db:owner-password>",
      POSTGRES_URL: "postgresql://app_owner:<db:owner-password>@db:5432/app",
    });
  });

  it("keeps the long-running workers on PostgreSQL itself, with the runtime login, by every name", () => {
    const laravel = withAppEnv(plan, LARAVEL);
    expect(workerVariables(laravel, secretOf)).toEqual({
      DATABASE_URL: "postgresql://app_runtime:<db:runtime-password>@db:5432/app",
      DB_HOST: "db",
      DB_PORT: "5432",
      DB_USERNAME: "app_runtime",
      DB_PASSWORD: "<db:runtime-password>",
      POSTGRES_URL: "postgresql://app_runtime:<db:runtime-password>@db:5432/app",
    });
  });

  it("gives the workers nothing of their own without the pooler", () => {
    expect(workerVariables(withAppEnv(withLogins(testPlan()), LARAVEL), secretOf)).toEqual({});
  });

  it("reaches the database it sits beside in session mode, as the runtime login", () => {
    const text = script(db);
    for (const line of [
      "[databases]",
      "app = host=db port=5432 dbname=app",
      "[pgbouncer]",
      "listen_addr = 0.0.0.0",
      "listen_port = 6432",
      "auth_type = scram-sha-256",
      "auth_file = /tmp/userlist.txt",
      "pool_mode = session",
      "server_reset_query = DISCARD ALL",
      "default_pool_size = 20",
      "max_client_conn = 100",
      "ignore_startup_parameters = extra_float_digits",
      "log_connections = 0",
      "log_disconnections = 0",
      "admin_users =",
      "stats_users = app_runtime",
    ]) {
      expect(text, line).toContain(`'${line}'`);
    }
    // Session mode keeps the statements a client prepares itself: no tracking of them.
    expect(text).not.toContain("max_prepared_statements");
    expect(text).not.toContain("transaction");
    expect(text).toContain("> /tmp/pgbouncer.ini");
    expect(text.endsWith("exec pgbouncer /tmp/pgbouncer.ini")).toBe(true);
  });

  it("writes the password into a 0600 file from its environment, never into an argument", () => {
    const text = script(db);
    expect(text.startsWith("set -eu; umask 077; ")).toBe(true);
    // printf is the shell's own: the password is in no process's arguments.
    expect(text).toContain(
      `printf '"%s" "%s"\\n' app_runtime "$OPSCREW_RUNTIME_PASSWORD" > /tmp/userlist.txt`,
    );
    // PgBouncer itself keeps none of the database's passwords in its environment.
    expect(text).toContain(
      "unset POSTGRES_PASSWORD OPSCREW_OWNER_PASSWORD OPSCREW_RUNTIME_PASSWORD; exec pgbouncer",
    );
  });

  it("is healthy once it accepts a connection, which needs no password", () => {
    expect(POOLER_HEALTHCHECK).toEqual({
      test: ["CMD", "bash", "-c", "</dev/tcp/127.0.0.1/6432"],
    });
  });
});

describe("the pooler's Compose service (050)", () => {
  for (const [where, base] of [
    ["a server", testPlan()],
    ["this computer", localhostPlan()],
  ] as const) {
    it(`runs beside the database, unpublished, with the database's env file (${where})`, () => {
      const all = composeServices(renderCompose(full(withPooler(base))).content);
      expect(all["db-pooler"]).toEqual({
        image: IMAGES.pgbouncer.ref,
        restart: all.db?.restart,
        entrypoint: poolerStart(serviceOf(withPooler(base))).map((word) =>
          word.replaceAll("$", () => "$$"),
        ),
        env_file: ["db.env"],
        depends_on: { db: { condition: "service_healthy" } },
        healthcheck: {
          test: ["CMD", "bash", "-c", "</dev/tcp/127.0.0.1/6432"],
          interval: "10s",
          timeout: "5s",
          retries: 6,
        },
        mem_limit: "32m",
        memswap_limit: "32m",
        security_opt: ["no-new-privileges:true"],
        logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } },
        cap_drop: ["ALL"],
        networks: ["internal"],
      });
      expect(all["db-pooler"]?.ports).toBeUndefined();
      // The app's web, workers and cron wait for it; the release reads the owner's env file.
      for (const name of ["app", "jobs", "cron"]) {
        expect(all[name]?.depends_on?.["db-pooler"], name).toEqual({
          condition: "service_healthy",
        });
      }
      expect(all.release?.env_file).toEqual(["app.env", "release.db.env"]);
      // Only the web process and cron go through the pooler; a worker reads its direct address.
      expect(all.jobs?.env_file).toEqual(["app.env", "worker.db.env"]);
      expect(all.app?.env_file).toEqual(["app.env"]);
      expect(all.cron?.env_file).toEqual(["app.env"]);
    });
  }

  it("is the only change from separate logins alone", () => {
    const logins = composeServices(renderCompose(full(withLogins(testPlan()))).content);
    const pooled = composeServices(renderCompose(full(withPooler(testPlan()))).content);
    const { "db-pooler": _pooler, ...rest } = pooled;
    // A worker also reads the workers' own env file after app.env.
    const without = (service: ComposeService | undefined) => {
      const { "db-pooler": _p, ...others } = service?.depends_on ?? {};
      const files = service?.env_file?.filter((file) => file !== "worker.db.env");
      return {
        ...service,
        depends_on: others,
        ...(files === undefined ? {} : { env_file: files }),
      };
    };
    expect(Object.keys(rest)).toEqual(Object.keys(logins));
    for (const name of Object.keys(logins)) {
      expect(without(rest[name]), name).toEqual(without(logins[name]));
    }
  });

  it("runs on the extra server the database is placed on, published on its private address", () => {
    const split = withPooler(splitPlan());
    expect(composeServices(renderCompose(split).content)["db-pooler"]).toBeUndefined();
    const data = composeServices(renderServerCompose(split, "data").content);
    expect(Object.keys(data)).toEqual(["db", "db-pooler", "docs"]);
    expect(data["db-pooler"]?.ports).toEqual(["10.200.4.2:6432:6432"]);
    expect(data["db-pooler"]?.env_file).toEqual(["db.env"]);
    expect(publishedOnNetwork(split, "data")).toContainEqual({
      service: "db-pooler",
      port: 6432,
      address: "10.200.4.2",
    });
    expect(appVariables(ctx(split))).toEqual({
      DATABASE_URL: "postgresql://app_runtime:<runtime-password>@10.200.4.2:6432/app",
    });
    expect(releaseVariables(split, secretOf)).toEqual({
      DATABASE_URL: "postgresql://app_owner:<db:owner-password>@10.200.4.2:5432/app",
    });
    expect(workerVariables(split, secretOf)).toEqual({
      DATABASE_URL: "postgresql://app_runtime:<db:runtime-password>@10.200.4.2:5432/app",
    });
    // An app reading DB_HOST: the release and the workers on PostgreSQL's private address.
    const laravel = withAppEnv(split, ["DB_HOST", "DB_PORT", "DB_USERNAME"]);
    expect(releaseVariables(laravel, secretOf)).toMatchObject({
      DB_HOST: "10.200.4.2",
      DB_PORT: "5432",
      DB_USERNAME: "app_owner",
    });
    expect(workerVariables(laravel, secretOf)).toMatchObject({
      DB_HOST: "10.200.4.2",
      DB_PORT: "5432",
      DB_USERNAME: "app_runtime",
    });
  });

  it("renders the same service in a Portainer stack, given only the runtime login's password", () => {
    const stack = withPooler(portainerTestPlan({ postgres: true }));
    const all = composeServices(
      fillPortainerStack(renderPortainerStack(stack, testContext()).content, IMAGE),
    );
    const server = composeServices(renderCompose(withPooler(testPlan())).content)["db-pooler"];
    const { env_file: _file, ...same } = server ?? {};
    const { environment, ...pooler } = all["db-pooler"] ?? {};
    expect(pooler).toEqual(same);
    expect(environment).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose variable, not a JavaScript template.
      OPSCREW_RUNTIME_PASSWORD: "${OPSCREW_SVC_DB_RUNTIME_PASSWORD}",
    });
    expect(all.app?.depends_on?.["db-pooler"]).toEqual({ condition: "service_healthy" });
  });

  it("gives a Portainer stack's workers the direct address, and its web process and cron the pooler", () => {
    const stack = (plan: DeployPlan) =>
      composeServices(fillPortainerStack(renderPortainerStack(plan, testContext()).content, IMAGE));
    const pooled = stack(full(withPooler(portainerTestPlan({ postgres: true }))));
    const direct = (name: string) => pooled[name]?.environment?.DATABASE_URL;
    expect(direct("jobs")).toMatch(/^postgresql:\/\/app_runtime:\$\{\w+\}@db:5432\/app$/);
    for (const name of ["app", "cron"]) {
      expect(direct(name), name).toMatch(/^\$\{DATABASE_URL\}$/);
    }
    // Without the pooler, every process reads the same variables.
    const logins = stack(full(withLogins(portainerTestPlan({ postgres: true }))));
    expect(logins.jobs?.environment).toEqual(logins.app?.environment);
  });
});

describe("the pooler's passwords (050)", () => {
  for (const [where, plan] of [
    ["a server", withPooler(full(testPlan()))],
    ["a split plan", withPooler(splitPlan())],
    ["a Portainer stack", withPooler(full(portainerTestPlan({ postgres: true })))],
  ] as const) {
    it(`are in the database's env file and in no rendered file (${where})`, () => {
      const values: Record<string, string> = Object.fromEntries(
        serviceSecrets(serviceOf(plan)).map(({ name }) => [
          name,
          fakeSecret("generic-password", `pooler-${name}`),
        ]),
      );
      const env = serviceSpec("postgres").environment({
        plan,
        service: serviceOf(plan),
        secretRef: (name) => values[name] ?? "",
      });
      const envFile = Object.entries(env)
        .map(([name, value]) => `${name}=${value}`)
        .join("\n");
      const runtime = values["runtime-password"] ?? "";
      expect(runtime).not.toBe("");
      expect(envFile).toContain(`OPSCREW_RUNTIME_PASSWORD=${runtime}`);
      const files = renderDeployment(plan, testContext({ cloudflare: testCloudflareAccount() }));
      expect(files.some((file) => file.content.includes("db-pooler"))).toBe(true);
      for (const file of files) {
        for (const [name, value] of Object.entries(values)) {
          expect(file.content.includes(value), `${name} in ${file.path}`).toBe(false);
        }
      }
    });
  }
});

describe("PostgreSQL without the pooler", () => {
  it("is reached directly by the app, and no pooler is rendered", () => {
    const plan = withLogins(testPlan());
    expect(appVariables(ctx(plan))).toEqual({
      DATABASE_URL: "postgresql://app_runtime:<runtime-password>@db:5432/app",
    });
    const all = composeServices(renderCompose(full(plan)).content);
    expect(all["db-pooler"]).toBeUndefined();
    expect(publishedOnNetwork(withLogins(splitPlan()), "data").map((p) => p.service)).toEqual([
      "db",
      "docs",
    ]);
  });
});
