import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * A fake program that records its arguments (one per `[…]`), its stdin and the list file after
 * `-L`, prints `$<NAME>_PRINTS` and exits with `$<NAME>_EXIT` (`PSQL_…`, `PG_RESTORE_…`).
 */
function recorder(name: string): string {
  const prefix = name.toUpperCase();
  return [
    "#!/bin/sh",
    `printf '${name}' >> "$WORK/calls"`,
    'for a in "$@"; do printf \' [%s]\' "$a" >> "$WORK/calls"; done',
    'echo >> "$WORK/calls"',
    'prev=; for a in "$@"; do [ "$prev" != -L ] || { cat "$a"; echo ==; } >> "$WORK/lists"; prev="$a"; done',
    `cat >> "$WORK/stdin-${name}"`,
    `[ -z "\${${prefix}_PRINTS:-}" ] || echo "$${prefix}_PRINTS"`,
    `exit "\${${prefix}_EXIT:-0}"`,
  ].join("\n");
}

/**
 * `script` in a file of a new folder: Git Bash's sh, started from Node on Windows, cuts an argument
 * after about 8,190 characters, which these scripts pass.
 */
function scriptFile(script: string): string {
  const file = join(mkdtempSync(join(root, "script-")), "script.sh");
  writeFileSync(file, script);
  return file.replaceAll("\\", "/");
}

/** Runs `script` with sh, fake `psql` and `pg_restore` first on PATH and the passwords in its env. */
function run(script: string, env: Record<string, string> = {}) {
  const work = mkdtempSync(join(root, "run-")).replaceAll("\\", "/");
  fakeBin(work, { psql: recorder("psql"), pg_restore: recorder("pg_restore") });
  const file = scriptFile(`PATH="$(cd "$WORK/bin" && pwd):$PATH"; export PATH; ${script}`);
  const result = spawnSync("sh", [file], {
    input: "",
    env: { ...process.env, ...PASSWORDS, WORK: work, ...env },
    encoding: "utf8",
  });
  const read = (file: string) =>
    existsSync(join(work, file)) ? readFileSync(join(work, file), "utf8") : "";
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: read("calls").split("\n").filter(Boolean),
    psqlStdin: read("stdin-psql"),
    /** The list files given to `pg_restore -L`, in order. */
    lists: read("lists").split("==\n").slice(0, -1),
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
    const parsed = spawnSync("sh", ["-n", scriptFile(script)], { encoding: "utf8" });
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

  it("names the service only in the setup's refusals", () => {
    const [db, other] = [loginsSetup("db"), loginsSetup("cache")];
    const lines = (text: string) => text.split("\n");
    const differ = lines(db).filter((line, i) => line !== lines(other)[i]);
    expect(differ).toEqual([
      expect.stringContaining("PostgreSQL db has event triggers"),
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

  it("gives the runtime login its rights on what exists only before the owner's default privileges", () => {
    const grants = run(loginsGrants()).psqlStdin.split("\n");
    // Granting on everything again would undo a migration's narrowing.
    expect(grants.join("\n")).not.toMatch(/ON ALL (TABLES|SEQUENCES) IN SCHEMA/);
    const first = grants.indexOf("\\if :first_grants");
    const end = grants.indexOf("\\endif", first);
    expect(grants[first - 1]).toContain("NOT EXISTS (SELECT FROM pg_default_acl");
    const inside = grants.slice(first, end).join("\n");
    for (const grant of [
      "GRANT USAGE ON SCHEMA %I TO app_runtime",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO app_runtime",
      "GRANT USAGE, SELECT ON SEQUENCE %s TO app_runtime",
      "GRANT SELECT, UPDATE ON LARGE OBJECT %s TO app_runtime",
    ]) {
      expect(inside).toContain(grant);
    }
    expect(grants.findIndex((line) => line.startsWith("ALTER DEFAULT PRIVILEGES"))).toBeGreaterThan(
      end,
    );
  });

  it("refuses a database with event triggers before anything else", () => {
    const refusal = sql.findIndex((line) => line.includes("pg_event_trigger"));
    expect(refusal).toBeGreaterThan(0);
    expect(refusal).toBeLessThan(sql.findIndex((line) => line.startsWith("\\getenv")));
    expect(ran.psqlStdin).toContain(
      "PostgreSQL db has event triggers, and separate logins cannot run safely with them",
    );
  });

  it("moves the owner of every kind of object the superuser may own", () => {
    for (const statement of [
      "ALTER SCHEMA",
      "ALTER %s %s OWNER",
      "ALTER ROUTINE",
      "ALTER TYPE",
      "ALTER COLLATION",
      "ALTER STATISTICS",
      "ALTER TEXT SEARCH CONFIGURATION",
      "ALTER TEXT SEARCH DICTIONARY",
      "ALTER OPERATOR %s",
      "ALTER OPERATOR CLASS",
      "ALTER OPERATOR FAMILY",
      "ALTER LARGE OBJECT",
    ]) {
      expect(ran.psqlStdin).toContain(`format('${statement}`);
    }
    // Every object of an extension stays its own, its schema too.
    expect(ran.psqlStdin).toContain("d.classid = 'pg_namespace'::regclass");
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
  /** A dump's table of contents, as `pg_restore -l` prints it. */
  const TOC = [
    ";",
    "; Selected TOC Entries:",
    ";",
    "6; 2615 2200 SCHEMA - public app_owner",
    "3466; 0 0 ACL - SCHEMA public app_owner",
    "7; 2615 16439 SCHEMA - shop app_owner",
    "2; 3079 16402 EXTENSION - pgcrypto ",
    "3468; 0 0 COMMENT - EXTENSION pgcrypto ",
    "255; 1255 16449 FUNCTION public ok(integer) app_owner",
    "218; 1259 16441 TABLE shop t app_owner",
    "3469; 0 0 ACL shop TABLE t app_owner",
    "3457; 0 16441 TABLE DATA shop t app_owner",
    // An extension's own table, and the owner's table whose name starts with its name.
    "3366; 0 16458 TABLE DATA public cfg app",
    "3367; 0 16460 TABLE DATA public cfg trap app_owner",
    "3504; 2613 16447 BLOB METADATA - 16447 app_owner",
    "2090; 826 16448 DEFAULT ACL - DEFAULT PRIVILEGES FOR TABLES app_owner",
  ];
  /** The fakes' output: the TOC from `pg_restore -l`, an extension's table from the config query. */
  const DUMP = { PG_RESTORE_PRINTS: TOC.join("\n"), PSQL_PRINTS: "TABLE DATA public cfg app" };
  const entries = (list: string | undefined) =>
    (list ?? "").split("\n").filter((line) => /^\d+;/.test(line));

  it("restores as the owner login, with only the extensions and ACLs as the superuser", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: true }), DUMP);
    expect(ran.status).toBe(0);
    const [toc, roles, database, superuser, moves, config, owner, later, grants] = ran.calls;
    expect(ran.calls).toHaveLength(9);
    expect(toc).toBe(`pg_restore [-l] [${file}]`);
    expect(roles).toContain("[-h] [db] [-U] [app] [-d] [postgres]");
    expect(database).toContain(
      "[-c] [DROP DATABASE IF EXISTS app WITH (FORCE)] [-c] [CREATE DATABASE app]",
    );
    expect(superuser).toMatch(/^pg_restore \[-h\] \[db\] \[-U\] \[app\] .*\[--no-owner\] .*\[-L\]/);
    expect(moves).toContain("[-U] [app] [-d] [app]");
    expect(config).toContain("[-At]");
    // The owner logs in itself: under the superuser's login, `SET ROLE` (`--role`) can be reset.
    expect(owner).toMatch(
      /^pg_restore \[-h\] \[db\] \[-U\] \[app_owner\] .*\[--no-owner\] .*\[-L\]/,
    );
    expect(owner).not.toContain("--role");
    expect(later).toMatch(/^pg_restore \[-h\] \[db\] \[-U\] \[app\] .*\[-L\]/);
    expect(later).not.toContain("--no-owner");
    expect(grants).toContain("[-h] [db] [-U] [app] [-d] [app]");
    expect(ran.lists.map(entries)).toEqual([
      [TOC[3], TOC[5], TOC[6], TOC[7]],
      [TOC[8], TOC[9], TOC[11], TOC[13], TOC[14]],
      [TOC[4], TOC[10], TOC[15], TOC[12]],
    ]);
    expect(ran.psqlStdin).toContain(`getenv owner_password ${OWNER_PASSWORD_ENV}`);
  });

  it("refuses a dump with event triggers before anything changes", () => {
    const toc = [...TOC, "3311; 3466 16450 EVENT TRIGGER - et app"].join("\n");
    const ran = run(loginsLoad({ host: "db", file, setup: true }), { PG_RESTORE_PRINTS: toc });
    expect(ran.status).not.toBe(0);
    expect(ran.calls).toEqual([`pg_restore [-l] [${file}]`]);
    expect(ran.output).toContain(
      "PostgreSQL db has event triggers, and separate logins cannot run safely with them",
    );
  });

  it("without the setup, checks that both logins exist first", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: false }), { ...DUMP, PSQL_PRINTS: "2" });
    expect(ran.status).toBe(0);
    expect(ran.calls).toHaveLength(9);
    expect(ran.calls[1]).toContain("[-d] [postgres]");
    expect(ran.calls[1]).toContain("app_owner");
    expect(ran.psqlStdin).not.toContain("getenv");
  });

  it("without the setup or the logins, refuses with a plain message and drops nothing", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: false }), { PSQL_PRINTS: "0" });
    expect(ran.status).not.toBe(0);
    expect(ran.calls).toHaveLength(2);
    expect(ran.output).toContain(
      "PostgreSQL db has no logins app_owner and app_runtime, so OpsCrew loaded nothing into it.",
    );
  });

  it("stops at the first step that fails", () => {
    const ran = run(loginsLoad({ host: "db", file, setup: true }), { PSQL_EXIT: "3" });
    expect(ran.status).not.toBe(0);
    expect(ran.calls).toHaveLength(2);
  });
});
