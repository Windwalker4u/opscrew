import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { afterAll, describe, expect, it } from "vitest";
import { fakeBin, shWorks } from "../workflow/__fixtures__/sh";
import {
  loginPassword,
  loginsCheck,
  loginsGrants,
  loginsLoad,
  loginsSetup,
  OWNER_PASSWORD_ENV,
  POSTGRES_OWNER,
  POSTGRES_RUNTIME,
  RUNTIME_PASSWORD_ENV,
} from "./postgres-logins";

const root = mkdtempSync(join(tmpdir(), "opscrew-postgres-logins-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The values the scripts' environment holds, as the database's container has them. */
const PASSWORDS = {
  POSTGRES_PASSWORD: fakeSecret("generic-password", "superuser"),
  [OWNER_PASSWORD_ENV]: fakeSecret("generic-password", "owner"),
  [RUNTIME_PASSWORD_ENV]: fakeSecret("generic-password", "runtime"),
  OPSCREW_NEW: fakeSecret("generic-password", "new"),
  OPSCREW_OLD: fakeSecret("generic-password", "old"),
};

/**
 * A fake program that records its arguments (one per `[…]`) and its stdin, prints `$<NAME>_PRINTS`
 * and exits with `$<NAME>_EXIT` (`PSQL_…`, `PG_RESTORE_…`).
 */
function recorder(name: string): string {
  const prefix = name.toUpperCase();
  return [
    "#!/bin/sh",
    `printf '${name}' >> "$WORK/calls"`,
    'for a in "$@"; do printf \' [%s]\' "$a" >> "$WORK/calls"; done',
    'echo >> "$WORK/calls"',
    `cat >> "$WORK/stdin-${name}"`,
    `[ -z "\${${prefix}_PRINTS:-}" ] || echo "$${prefix}_PRINTS"`,
    `exit "\${${prefix}_EXIT:-0}"`,
  ].join("\n");
}

/** Runs `script` with sh, fake `psql` and `pg_restore` first on PATH and the passwords in its env. */
function run(script: string, env: Record<string, string> = {}) {
  const work = mkdtempSync(join(root, "run-")).replaceAll("\\", "/");
  fakeBin(work, { psql: recorder("psql"), pg_restore: recorder("pg_restore") });
  const result = spawnSync(
    "sh",
    ["-c", `PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; ${script}`],
    { input: "", env: { ...process.env, ...PASSWORDS, WORK: work, ...env }, encoding: "utf8" },
  );
  const read = (file: string) =>
    existsSync(join(work, file)) ? readFileSync(join(work, file), "utf8") : "";
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: read("calls").split("\n").filter(Boolean),
    psqlStdin: read("stdin-psql"),
  };
}

/** Every script the module gives, by name. */
const SCRIPTS: Record<string, string> = {
  setup: loginsSetup("db"),
  grants: loginsGrants(),
  "grants over TCP": loginsGrants("db"),
  check: loginsCheck(),
  "check over TCP": loginsCheck("db"),
  "owner's password": loginPassword(POSTGRES_OWNER),
  "runtime's password": loginPassword(POSTGRES_RUNTIME),
  "load with the setup": loginsLoad({ host: "db", file: "/backup/app.dump", setup: true }),
  "load without the setup": loginsLoad({ host: "db", file: "/backup/app.dump", setup: false }),
};

describe("the logins' names", () => {
  it("are fixed", () => {
    expect([POSTGRES_OWNER, POSTGRES_RUNTIME]).toEqual(["app_owner", "app_runtime"]);
    expect([OWNER_PASSWORD_ENV, RUNTIME_PASSWORD_ENV]).toEqual([
      "OPSCREW_OWNER_PASSWORD",
      "OPSCREW_RUNTIME_PASSWORD",
    ]);
  });
});

describe.skipIf(!shWorks())("the logins' scripts", () => {
  it.each(Object.entries(SCRIPTS))("%s is sh", (_name, script) => {
    const parsed = spawnSync("sh", ["-n", "-c", script], { encoding: "utf8" });
    expect(parsed.stderr).toBe("");
    expect(parsed.status).toBe(0);
  });

  it.each(Object.entries(SCRIPTS))("%s puts no password in an argument", (_name, script) => {
    expect(script).not.toMatch(/env\s+-i[^\n]*PGPASSWORD=/);
    const { calls } = run(script, { PSQL_PRINTS: "2", PSQL_EXIT: "1" });
    const ran = run(script, { PSQL_PRINTS: "2" });
    for (const text of [...calls, ...ran.calls, ran.psqlStdin, script]) {
      for (const value of Object.values(PASSWORDS)) expect(text).not.toContain(value);
    }
    expect(ran.calls.length).toBeGreaterThan(0);
  });

  it("names the service only in the setup's refusal", () => {
    const [db, other] = [loginsSetup("db"), loginsSetup("cache")];
    const lines = (text: string) => text.split("\n");
    const differ = lines(db).filter((line, i) => line !== lines(other)[i]);
    expect(differ).toEqual([
      expect.stringContaining(
        "already exists in db with other rights than OpsCrew gives it. Drop or rename it, then deploy again.",
      ),
    ]);
  });
});

describe.skipIf(!shWorks())("the setup", () => {
  const ran = run(loginsSetup("db"));
  const sql = ran.psqlStdin.trim().split("\n");

  it("is one psql transaction as the superuser over the socket, stopping at the first error", () => {
    expect(ran.status).toBe(0);
    expect(ran.calls).toHaveLength(1);
    expect(ran.calls[0]).toMatch(/^psql .*\[-v\] \[ON_ERROR_STOP=1\]/);
    expect(ran.calls[0]).toContain("[-U] [app] [-d] [app]");
    expect(ran.calls[0]).not.toContain("[-h]");
    expect(sql[0]).toBe("BEGIN;");
    expect(sql.at(-1)).toBe("COMMIT;");
    expect(sql.filter((line) => /^(BEGIN|COMMIT|ROLLBACK);$/.test(line))).toHaveLength(2);
  });

  it("binds each password with \\getenv after turning statement logging off", () => {
    const off = sql.indexOf("SET LOCAL log_statement = 'none';");
    expect(off).toBeGreaterThan(0);
    const getenv = sql.flatMap((line, i) => (line.startsWith("\\getenv") ? [i] : []));
    expect(getenv.map((i) => sql[i])).toEqual([
      `\\getenv owner_password ${OWNER_PASSWORD_ENV}`,
      `\\getenv runtime_password ${RUNTIME_PASSWORD_ENV}`,
    ]);
    expect(Math.min(...getenv)).toBeGreaterThan(off);
    expect(ran.psqlStdin).toContain(
      "CREATE ROLE app_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'owner_password';",
    );
    expect(ran.psqlStdin).toContain(
      "CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';",
    );
  });

  it("holds the grants part, which the loads run alone, without a password", () => {
    const grants = run(loginsGrants());
    expect(grants.calls).toHaveLength(1);
    // The SQL without the transaction and its settings.
    const body = (text: string) =>
      text
        .split("\n")
        .filter((line) => !/^(BEGIN|COMMIT);$|^SET LOCAL /.test(line))
        .join("\n");
    expect(body(ran.psqlStdin)).toContain(body(grants.psqlStdin).trim());
    expect(grants.psqlStdin).not.toMatch(/getenv|PASSWORD/);
    expect(grants.psqlStdin.trim().split("\n")[0]).toBe("BEGIN;");
    expect(grants.psqlStdin.trim().split("\n").at(-1)).toBe("COMMIT;");
    for (const line of [
      "ALTER DATABASE app OWNER TO app_owner;",
      "REVOKE TEMPORARY ON DATABASE app FROM PUBLIC;",
      "REVOKE ALL ON SCHEMA public FROM PUBLIC;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE app_owner GRANT USAGE ON SCHEMAS TO app_runtime;",
    ]) {
      expect(grants.psqlStdin).toContain(line);
    }
    expect(grants.psqlStdin).not.toMatch(/REVOKE CONNECT/);
    expect(grants.psqlStdin).not.toMatch(/REASSIGN OWNED/);
  });

  it("gives the runtime login its rights only on what it moves from the superuser", () => {
    const grants = run(loginsGrants()).psqlStdin;
    // Granting on everything again would undo a migration's narrowing.
    expect(grants).not.toMatch(/ON ALL (TABLES|SEQUENCES) IN SCHEMA/);
    for (const grant of [
      "GRANT USAGE ON SCHEMA %I TO app_runtime",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO app_runtime",
      "GRANT USAGE, SELECT ON SEQUENCE %s TO app_runtime",
      "GRANT SELECT, UPDATE ON LARGE OBJECT %s TO app_runtime",
    ]) {
      expect(grants).toContain(grant);
    }
  });
});

describe.skipIf(!shWorks())("the check", () => {
  it("exits 0 only when the query prints t", () => {
    expect(run(loginsCheck(), { PSQL_PRINTS: "t" }).status).toBe(0);
    expect(run(loginsCheck(), { PSQL_PRINTS: "f" }).status).not.toBe(0);
  });

  it("leaves the runtime login's rights on tables and schemas to the app", () => {
    const sql = run(loginsCheck(), { PSQL_PRINTS: "t" }).psqlStdin;
    expect(sql).not.toMatch(/has_(table|sequence)_privilege/);
    expect(sql).not.toContain("has_schema_privilege(to_regrole('app_runtime')");
    expect(sql).toContain("pg_default_acl");
  });

  it("logs in over TCP to the host it is given", () => {
    expect(run(loginsCheck("db"), { PSQL_PRINTS: "t" }).calls[0]).toContain("[-h] [db]");
  });
});

describe.skipIf(!shWorks())("a password's rotation", () => {
  it.each([POSTGRES_OWNER, POSTGRES_RUNTIME] as const)(
    "sets %s's password from OPSCREW_NEW with statement logging off",
    (login) => {
      const ran = run(loginPassword(login), { PSQL_EXIT: "0" });
      // The first psql (the new value's login) succeeded: nothing else runs.
      expect(ran.calls).toHaveLength(1);
      expect(ran.calls[0]).toContain(`[-U] [${login}]`);
      const changed = run(loginPassword(login), { PSQL_EXIT: "1" });
      expect(changed.calls).toHaveLength(2);
      expect(changed.calls[1]).toContain("[-U] [app]");
      expect(changed.psqlStdin.trim().split("\n")).toEqual([
        "BEGIN;",
        "SET LOCAL log_statement = 'none';",
        "SET LOCAL log_min_error_statement = 'panic';",
        "\\getenv password OPSCREW_NEW",
        `ALTER ROLE ${login} PASSWORD :'password';`,
        "COMMIT;",
      ]);
    },
  );
});

describe.skipIf(!shWorks())("the load of a dump", () => {
  const file = "/backup/app.dump";

  it("makes the logins, then the database, restores with the owners and gives the grants", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: true }));
    expect(ran.status).toBe(0);
    expect(ran.calls).toHaveLength(4);
    const [roles, database, restore, grants] = ran.calls;
    expect(roles).toContain("[-h] [db] [-U] [app] [-d] [postgres]");
    expect(database).toContain(
      "[-c] [DROP DATABASE IF EXISTS app WITH (FORCE)] [-c] [CREATE DATABASE app OWNER app_owner]",
    );
    expect(restore).toBe(
      `pg_restore [-h] [db] [-U] [app] [-d] [app] [--single-transaction] [${file}]`,
    );
    expect(grants).toContain("[-h] [db] [-U] [app] [-d] [app]");
    expect(ran.psqlStdin).toContain(`\\getenv owner_password ${OWNER_PASSWORD_ENV}`);
  });

  it("without the setup, checks that both logins exist first", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: false }), { PSQL_PRINTS: "2" });
    expect(ran.status).toBe(0);
    expect(ran.calls).toHaveLength(4);
    expect(ran.calls[0]).toContain("[-d] [postgres]");
    expect(ran.calls[0]).toContain("app_owner");
    expect(ran.psqlStdin).not.toContain("getenv");
  });

  it("without the setup or the logins, refuses with a plain message and drops nothing", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: false }), { PSQL_PRINTS: "0" });
    expect(ran.status).not.toBe(0);
    expect(ran.calls).toHaveLength(1);
    expect(ran.output).toContain(
      "PostgreSQL db has no logins app_owner and app_runtime, so OpsCrew loaded nothing into it.",
    );
  });

  it("stops at the first step that fails", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: true }), { PSQL_EXIT: "3" });
    expect(ran.status).not.toBe(0);
    expect(ran.calls).toHaveLength(1);
  });
});
