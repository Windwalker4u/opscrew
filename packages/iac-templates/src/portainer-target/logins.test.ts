// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation in expected contents, not JavaScript templates.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext } from "../__fixtures__/plans";
import { withLogins } from "../catalog/__fixtures__/plans";
import { loginsCheck, loginsLoad, loginsSetup } from "../catalog/postgres-logins";
import { composeLiteral, shellQuote } from "../runtime/services";
import { NIGHTLY, withProcesses } from "../workflow/__fixtures__/plans";
import { portainerTestPlan, TEST_ENV } from "./__fixtures__/plans";
import {
  PORTAINER_STACK_VARIABLES,
  portainerSecretVariables,
  portainerServiceEnvironment,
  portainerStackEnvKeys,
  renderPortainerStack,
} from "./index";

type Service = {
  image?: string;
  environment?: Record<string, string>;
  entrypoint?: string[];
  depends_on?: Record<string, { condition: string }>;
  network_mode?: string;
};

const ctx = testContext({ acmeEmail: "ops@example.com" });

/** A stack with PostgreSQL, a release command, a worker and a cron job. */
function plan(o: { logins: boolean }): DeployPlan {
  const base = withProcesses(
    portainerTestPlan({ postgres: true, releaseCommand: "npm run migrate", env: TEST_ENV }),
    { workers: [{ name: "jobs", command: "npm run jobs" }], cron: [NIGHTLY] },
  );
  return o.logins ? withLogins(base) : base;
}

function services(p: DeployPlan): Record<string, Service> {
  return (parse(renderPortainerStack(p, ctx).content) as { services: Record<string, Service> })
    .services;
}

const OWNER = "OPSCREW_SVC_DB_OWNER_PASSWORD";
const RUNTIME = "OPSCREW_SVC_DB_RUNTIME_PASSWORD";

describe("a Portainer stack with PostgreSQL's own logins (047)", () => {
  const all = services(plan({ logins: true }));

  it("keeps the two new passwords in stack variables of their own, the superuser's where it was", () => {
    expect(portainerSecretVariables(plan({ logins: true }))).toEqual([
      { service: "db", secret: "password", variable: PORTAINER_STACK_VARIABLES.dbPassword },
      { service: "db", secret: "owner-password", variable: OWNER },
      { service: "db", secret: "runtime-password", variable: RUNTIME },
    ]);
    expect(portainerStackEnvKeys(plan({ logins: true })).opscrew).toEqual(
      expect.arrayContaining([OWNER, RUNTIME, PORTAINER_STACK_VARIABLES.dbPassword]),
    );
    expect(portainerStackEnvKeys(plan({ logins: false })).opscrew).not.toContain(OWNER);
  });

  it("gives the database's container both passwords, its superuser's as before", () => {
    const db = plan({ logins: true }).services[0];
    if (db === undefined) throw new Error("no db");
    const environment = {
      POSTGRES_USER: "${OPSCREW_DB_USER}",
      POSTGRES_DB: "${OPSCREW_DB_NAME}",
      POSTGRES_PASSWORD: "${OPSCREW_DB_PASSWORD}",
      OPSCREW_OWNER_PASSWORD: `\${${OWNER}}`,
      OPSCREW_RUNTIME_PASSWORD: `\${${RUNTIME}}`,
    };
    expect(all.db?.environment).toEqual(environment);
    expect(portainerServiceEnvironment(plan({ logins: true }), db)).toEqual(environment);
  });

  it("makes the logins in db-init, which the release, the app, the workers and cron wait for", () => {
    const init = all["db-init"];
    expect(init?.network_mode).toBe("service:db");
    expect(init?.environment).toEqual(all.db?.environment);
    expect(init?.depends_on).toEqual({ db: { condition: "service_healthy" } });
    const [, , script] = init?.entrypoint ?? [];
    const words = (script: string) => ["sh", "-c", script].map(shellQuote).join(" ");
    expect(script).toBe(
      composeLiteral(
        [
          "set -e",
          `if ! ${words(loginsCheck("127.0.0.1"))} > /dev/null 2>&1; then ${words(`export PGHOST=127.0.0.1; ${loginsSetup("db")}`)}; fi`,
        ].join("\n"),
      ),
    );
    for (const name of ["release", "app", "jobs", "cron"]) {
      expect(all[name]?.depends_on?.["db-init"], name).toEqual({
        condition: "service_completed_successfully",
      });
    }
  });

  it("gives the release the owner's login, and the app, its workers and cron the app's values", () => {
    expect(all.release?.environment?.DATABASE_URL).toBe(
      `postgresql://app_owner:\${${OWNER}}@db:5432/app`,
    );
    for (const name of ["app", "jobs", "cron"]) {
      expect(all[name]?.environment?.DATABASE_URL, name).toBe("${DATABASE_URL}");
    }
  });

  it("puts no superuser's password in an app container, and the owner's in the release only", () => {
    const image = all.app?.image;
    for (const [name, service] of Object.entries(all)) {
      if (service.image !== image) continue;
      const values = Object.values(service.environment ?? {}).join("\n");
      expect(values, name).not.toContain("OPSCREW_DB_PASSWORD");
      expect(values, name).not.toContain(RUNTIME);
      if (name === "release") expect(values).toContain(OWNER);
      else expect(values, name).not.toContain(OWNER);
    }
  });

  it("leaves a stack without logins as it was: the release has the app's values", () => {
    const before = services(plan({ logins: false }));
    expect(before["db-init"]).toBeUndefined();
    expect(before.release?.environment?.DATABASE_URL).toBe("${DATABASE_URL}");
    const {
      OPSCREW_OWNER_PASSWORD: _owner,
      OPSCREW_RUNTIME_PASSWORD: _runtime,
      ...db
    } = all.db?.environment ?? {};
    expect(before.db?.environment).toEqual(db);
  });
});

describe("a Portainer stack's scheduled drill of a PostgreSQL with its own logins (047)", () => {
  /** The stack's drill loop of `db`, as its shell sees it. */
  function drill(o: { logins: boolean }): string {
    const snapshots = { schedule: { every: "12h", keep: 5 }, drills: { schedule: "weekly" } };
    const base = DeployPlanSchema.parse({ ...plan({ logins: false }), snapshots });
    const text = services(o.logins ? withLogins(base) : base)["drill-db"]?.entrypoint?.[2];
    if (text === undefined) throw new Error("no drill loop for db");
    return text.replaceAll("$$", "$");
  }
  const random = "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \\n')";

  it("makes the logins on its scratch server with new passwords of its own, never the app's", () => {
    const script = drill({ logins: true });
    expect(script).toContain(
      `  { export OPSCREW_OWNER_PASSWORD="${random}" OPSCREW_RUNTIME_PASSWORD="${random}"; } < /dev/null >> "$S"/log 2>&1`,
    );
    expect(script).toContain(
      loginsLoad({ host: "localhost", file: '/snapshots/"$drill_id"/db.dump', setup: true }),
    );
    expect(script).toContain(loginsCheck("localhost"));
    expect(script).not.toMatch(/OPSCREW_SVC_|OPSCREW_DB_PASSWORD/);
  });

  it("is as before without logins", () => {
    const script = drill({ logins: false });
    expect(script).not.toMatch(/OPSCREW_OWNER_PASSWORD|app_owner/);
    expect(script).toContain("--no-owner");
  });
});
