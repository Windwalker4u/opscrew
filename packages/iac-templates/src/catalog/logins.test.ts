import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { splitPlan } from "../workflow/__fixtures__/plans";
import { withAppEnv, withLogins, withServices } from "./__fixtures__/plans";
import {
  appVariables,
  initStepsFor,
  releaseVariables,
  serviceRotation,
  serviceSecrets,
  serviceSpec,
  splitDatabaseSettings,
} from "./index";
import { loginPassword, loginsCheck, loginsSetup } from "./postgres-logins";
import type { ServiceContext } from "./types";

const POSTGRES = serviceSpec("postgres");

/** The plan's service `name`. */
function serviceOf(plan: DeployPlan, name = "db"): PlanService {
  const service = plan.services.find((s) => s.name === name);
  if (service === undefined) throw new Error(`no service ${name}`);
  return service;
}

/** The context of the plan's service `name`, its secrets as `<name>`, recording each it names. */
function ctx(plan: DeployPlan, name = "db", variable?: string) {
  const named: string[] = [];
  const context: ServiceContext = {
    plan,
    service: serviceOf(plan, name),
    secretRef: (secret) => {
      named.push(secret);
      return `<${secret}>`;
    },
    ...(variable === undefined ? {} : { variable }),
  };
  return { context, named };
}

/** A release's secret reference: `<service:secret>`. */
const secretOf = (service: PlanService, name: string) => `<${service.name}:${name}>`;

describe("PostgreSQL with its own logins (047)", () => {
  const plan = withLogins(testPlan());
  const db = serviceOf(plan);

  it("generates the owner's and the runtime's passwords besides the superuser's", () => {
    expect(serviceSecrets(db)).toEqual([
      { name: "password", format: "hex32" },
      { name: "owner-password", format: "hex32" },
      { name: "runtime-password", format: "hex32" },
    ]);
  });

  it("gives the database's container both passwords, its superuser still app", () => {
    expect(POSTGRES.environment(ctx(plan).context)).toEqual({
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: "<password>",
      OPSCREW_OWNER_PASSWORD: "<owner-password>",
      OPSCREW_RUNTIME_PASSWORD: "<runtime-password>",
    });
    expect(POSTGRES.healthcheck(ctx(plan).context)).toEqual(
      POSTGRES.healthcheck(ctx(testPlan()).context),
    );
  });

  it("gives the app the runtime login only, never the superuser's or the owner's password", () => {
    const url = ctx(plan, "db", "PG_URL");
    expect(appVariables(url.context)).toEqual({
      DATABASE_URL: "postgresql://app_runtime:<runtime-password>@db:5432/app",
      PG_URL: "postgresql://app_runtime:<runtime-password>@db:5432/app",
    });
    const split = ctx(plan);
    expect(splitDatabaseSettings(split.context)).toEqual({
      host: "db",
      port: "5432",
      database: "app",
      user: "app_runtime",
      password: "<runtime-password>",
    });
    expect([...new Set([...url.named, ...split.named])]).toEqual(["runtime-password"]);
  });

  it("makes the logins in a setup step in the database's container: its check, then its run", () => {
    expect(initStepsFor(plan)).toEqual([
      { service: "db", check: ["sh", "-c", loginsCheck()], run: ["sh", "-c", loginsSetup("db")] },
    ]);
  });

  it("makes them over 127.0.0.1 in a Portainer stack, whose setup container has no socket", () => {
    const stack = withLogins(portainerTestPlan({ postgres: true }));
    expect(initStepsFor(stack)).toEqual([
      {
        service: "db",
        check: ["sh", "-c", loginsCheck("127.0.0.1")],
        run: ["sh", "-c", `export PGHOST=127.0.0.1; ${loginsSetup("db")}`],
      },
    ]);
  });

  it("makes them on the extra server the database is placed on (ADR 0022), not the app's", () => {
    const split = withLogins(splitPlan());
    const data = initStepsFor(split, "data");
    expect(data.map((step) => step.service)).toEqual(["db", "docs"]);
    expect(data[0]).toEqual({
      service: "db",
      check: ["sh", "-c", loginsCheck()],
      run: ["sh", "-c", loginsSetup("db")],
    });
    expect(initStepsFor(split).map((step) => step.service)).toEqual([]);
  });

  it("rotates each new password as a swap over the socket that restarts nothing", () => {
    const rotation = serviceRotation(db);
    expect(rotation.secrets.flatMap((r) => r.secrets)).toEqual(
      serviceSecrets(db).map((secret) => secret.name),
    );
    expect(rotation.secrets[0]).toBe(POSTGRES.rotation.secrets[0]);
    const logins = { "owner-password": "app_owner", "runtime-password": "app_runtime" } as const;
    for (const [secret, login] of Object.entries(logins)) {
      const row = rotation.secrets.find((r) => r.secrets.includes(secret));
      expect(row, secret).toMatchObject({
        secrets: [secret],
        mode: "swap",
        recreate: false,
        seconds: 1,
      });
      expect(row?.begin(ctx(plan).context)).toEqual([["sh", "-c", loginPassword(login)]]);
      expect(row?.finish(ctx(plan).context)).toEqual([]);
      expect(row?.undo).toBeUndefined();
    }
  });
});

describe("PostgreSQL without logins", () => {
  const plan = testPlan();
  const db = serviceOf(plan);

  it("is the entry as before: one password, the superuser's login for the app, no setup", () => {
    expect(serviceSecrets(db)).toBe(POSTGRES.secrets);
    expect(serviceRotation(db)).toBe(POSTGRES.rotation);
    expect(POSTGRES.environment(ctx(plan).context)).toEqual({
      POSTGRES_USER: "app",
      POSTGRES_DB: "app",
      POSTGRES_PASSWORD: "<password>",
    });
    expect(appVariables(ctx(plan).context)).toEqual({
      DATABASE_URL: "postgresql://app:<password>@db:5432/app",
    });
    expect(splitDatabaseSettings(ctx(plan).context)?.user).toBe("app");
    expect(initStepsFor(plan)).toEqual([]);
    expect(releaseVariables(plan, secretOf)).toEqual({});
  });

  it("leaves every other kind's secrets and rotation as its entry has them", () => {
    const others = withServices([
      { kind: "mysql", name: "orders" },
      { kind: "valkey", name: "cache" },
    ]);
    for (const service of others.services) {
      expect(serviceSecrets(service)).toBe(serviceSpec(service.kind).secrets);
      expect(serviceRotation(service)).toBe(serviceSpec(service.kind).rotation);
    }
  });
});

describe("the release's database variables (releaseVariables)", () => {
  const OWNER_URL = "postgresql://app_owner:<db:owner-password>@db:5432/app";

  it("gives DATABASE_URL with the owner's login", () => {
    expect(releaseVariables(withLogins(testPlan()), secretOf)).toEqual({ DATABASE_URL: OWNER_URL });
  });

  it("gives the app's own variable for the database the same address", () => {
    const plan = withLogins(
      withServices([{ kind: "postgres", name: "db", variable: "POSTGRES_PRISMA_URL" }]),
    );
    expect(releaseVariables(plan, secretOf)).toEqual({
      DATABASE_URL: OWNER_URL,
      POSTGRES_PRISMA_URL: OWNER_URL,
    });
  });

  it("gives the split user and password the app reads, with the owner's login", () => {
    const laravel = withAppEnv(withLogins(testPlan()), [
      "DB_CONNECTION",
      "DB_HOST",
      "DB_PORT",
      "DB_DATABASE",
      "DB_USERNAME",
      "DB_PASSWORD",
    ]);
    expect(releaseVariables(laravel, secretOf)).toEqual({
      DATABASE_URL: OWNER_URL,
      DB_USERNAME: "app_owner",
      DB_PASSWORD: "<db:owner-password>",
    });
    const short = withAppEnv(withLogins(testPlan()), ["DB_HOST", "DB_USER", "DB_PASS"]);
    expect(releaseVariables(short, secretOf)).toEqual({
      DATABASE_URL: OWNER_URL,
      DB_USER: "app_owner",
      DB_PASS: "<db:owner-password>",
    });
    // Without DB_HOST the app reads no split settings, as app.env then has none.
    const urlOnly = withAppEnv(withLogins(testPlan()), ["DB_USERNAME", "DB_PASSWORD"]);
    expect(releaseVariables(urlOnly, secretOf)).toEqual({ DATABASE_URL: OWNER_URL });
  });

  it("leaves a name to the service app.env takes it from", () => {
    // MongoDB comes first, so DATABASE_URL is its address in app.env; the release keeps that.
    const mongoFirst = withLogins(
      withServices([
        { kind: "mongodb", name: "docs" },
        { kind: "postgres", name: "db", variable: "PG_URL" },
      ]),
    );
    expect(releaseVariables(mongoFirst, secretOf)).toEqual({ PG_URL: OWNER_URL });
    // The split settings are the SQL database's whose variable is DATABASE_URL: MySQL's here.
    const mysqlSplit = withAppEnv(
      withLogins(
        withServices([
          { kind: "postgres", name: "db", variable: "PG_URL" },
          { kind: "mysql", name: "orders", variable: "DATABASE_URL" },
        ]),
      ),
      ["DB_HOST", "DB_USERNAME", "DB_PASSWORD"],
    );
    expect(releaseVariables(mysqlSplit, secretOf)).toEqual({ PG_URL: OWNER_URL });
  });

  it("names the private address of the extra server the database is placed on", () => {
    expect(releaseVariables(withLogins(splitPlan()), secretOf)).toEqual({
      DATABASE_URL: "postgresql://app_owner:<db:owner-password>@10.200.4.2:5432/app",
    });
  });

  it("names only the owner's password, never the superuser's or the runtime's", () => {
    const named: string[] = [];
    const plan = withAppEnv(
      withLogins(withServices([{ kind: "postgres", name: "db", variable: "PG_URL" }])),
      ["DB_HOST", "DB_USERNAME", "DB_PASSWORD"],
    );
    releaseVariables(plan, (service, name) => {
      named.push(`${service.name}:${name}`);
      return "";
    });
    expect([...new Set(named)]).toEqual(["db:owner-password"]);
  });
});
