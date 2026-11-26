/** Offline checks of 047's live pass's pure helpers (`postgres-logins-support.ts`). No network. */
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  changedFiles,
  envMap,
  laravelFiles,
  namesLogin,
  notOwnedBy,
  parseLimits,
  parseRoles,
  pgsqlEnvExample,
  roleProblems,
  secretsHeld,
  standInValues,
} from "./postgres-logins-support";

const LARAVEL_ENV = [
  "APP_NAME=Laravel",
  "DB_CONNECTION=sqlite",
  "# DB_HOST=127.0.0.1",
  "# DB_PORT=3306",
  "# DB_DATABASE=laravel",
  "# DB_USERNAME=root",
  "# DB_PASSWORD=",
  "",
  "SESSION_DRIVER=database",
].join("\n");

describe("the Laravel copy", () => {
  it("chooses PostgreSQL as `laravel new --database=pgsql` does: its settings uncommented", () => {
    expect(pgsqlEnvExample(LARAVEL_ENV)).toBe(
      [
        "APP_NAME=Laravel",
        "DB_CONNECTION=pgsql",
        "DB_HOST=127.0.0.1",
        "DB_PORT=5432",
        "DB_DATABASE=laravel",
        "DB_USERNAME=root",
        "DB_PASSWORD=",
        "",
        "SESSION_DRIVER=database",
      ].join("\n"),
    );
  });

  it("stops when the example no longer uses SQLite, rather than writing something else", () => {
    expect(() => pgsqlEnvExample("DB_CONNECTION=mysql\n")).toThrow(/DB_CONNECTION=sqlite/);
  });

  it("brings a job, the routes and a Dockerfile that installs pdo_pgsql", () => {
    const files = laravelFiles(LARAVEL_ENV);
    expect(Object.keys(files).sort()).toEqual([
      ".env.example",
      "Dockerfile",
      "app/Jobs/RecordNote.php",
      "routes/web.php",
    ]);
    expect(files.Dockerfile).toContain("docker-php-ext-install pdo_pgsql");
    expect(files["routes/web.php"]).toContain("/e2e/write/{note}");
  });

  it("gives stand-in values, Laravel's null where nothing is known", () => {
    expect(standInValues(["MAIL_PASSWORD", "VITE_APP_NAME"])).toBe(
      "MAIL_PASSWORD=null\nVITE_APP_NAME=Laravel\n",
    );
    expect(standInValues([])).toBe("");
  });
});

describe("the logins as PostgreSQL lists them", () => {
  const rows = (owner: string, runtime: string) => parseRoles(`${owner}\n${runtime}\n`);

  it("finds nothing wrong with the logins OpsCrew makes", () => {
    expect(roleProblems(rows("app_owner|f|f|f|f|f|f|t|0", "app_runtime|f|f|f|f|f|f|t|0"))).toEqual(
      [],
    );
  });

  it("names a missing login, each right too many and a membership", () => {
    expect(roleProblems(parseRoles("app_runtime|t|f|t|t|f|t|f|2\n"))).toEqual([
      "app_owner is missing",
      "app_runtime can't log in",
      "app_runtime has superuser",
      "app_runtime has createrole",
      "app_runtime has inherit",
      "app_runtime has bypassrls",
      "app_runtime is a member of 2 role(s)",
    ]);
  });

  it("lists the objects another login owns", () => {
    const owners = "S visits_id_seq app_owner\nr visits app\nschema public app_owner\n";
    expect(notOwnedBy(owners, "app_owner")).toEqual(["r visits app"]);
    expect(notOwnedBy("", "app_owner")).toEqual([]);
  });

  it("reads the limits script's answer from its last line", () => {
    const answer =
      '{"from":"DATABASE_URL","user":"app_runtime","statements":{"CREATE ROLE x":"42501"}}';
    expect(parseLimits(`a warning\n${answer}\n`)).toEqual({
      from: "DATABASE_URL",
      user: "app_runtime",
      statements: { "CREATE ROLE x": "42501" },
    });
  });
});

describe("a container's environment", () => {
  const superuser = fakeSecret("generic-password", "superuser");
  const runtime = fakeSecret("generic-password", "runtime");
  const env = envMap([
    `DATABASE_URL=postgresql://app_runtime:${runtime}@db:5432/app`,
    "DB_USERNAME=app_runtime",
    "DB_DATABASE=app",
    `DB_PASSWORD=${runtime}`,
    "PORT=8080",
  ]);

  it("names the variables that name a login, never a database called the same", () => {
    expect(namesLogin(env, "app_runtime")).toEqual(["DATABASE_URL", "DB_USERNAME"]);
    expect(namesLogin(env, "app")).toEqual([]);
  });

  it("names the variables that hold a secret, equal or inside an address, by label only", () => {
    const secrets = [
      { label: "the superuser's password", value: superuser },
      { label: "the runtime password", value: runtime },
    ];
    expect(secretsHeld(env, secrets)).toEqual([
      "DATABASE_URL (the runtime password)",
      "DB_PASSWORD (the runtime password)",
    ]);
    expect(secretsHeld(env, [{ label: "empty", value: "" }])).toEqual([]);
  });

  it("keeps a value with `=` in it whole", () => {
    expect(envMap(["A=b=c", "noise"]).get("A")).toBe("b=c");
  });
});

describe("the generated files", () => {
  it("names the files that changed, appeared or went", () => {
    const before = new Map([
      ["compose.yaml", "1"],
      ["app.env", "2"],
      ["db.env", "3"],
    ]);
    const after = new Map([
      ["compose.yaml", "1"],
      ["app.env", "9"],
      ["release.db.env", "4"],
    ]);
    expect(changedFiles(before, after)).toEqual(["app.env", "db.env", "release.db.env"]);
    expect(changedFiles(before, before)).toEqual([]);
  });
});
