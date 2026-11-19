// Feature 029 (T2950): the agent's report needs the database engine's own tools, PostgreSQL's
// pg_dump and psql in mysqldump's place.
import type { HostingFiles } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { reportMisfit, waitForReport } from "./provision-report";

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKfakeagentkeyfortestsonlyopscrewhostingagent opscrew-notes-prod";

/** The agent's report with these database tools, as `yes` or `no`. */
async function parsed(tools: Record<string, "yes" | "no">) {
  const text = [
    `public_key=${KEY}`,
    ...["git", "openssl", "flock", "tar", "curl", "ssh", "ssh-keygen"].map((t) => `tool.${t}=yes`),
    ...Object.entries(tools).map(([tool, found]) => `tool.${tool}=${found}`),
    "github.22=yes",
    "github.443=yes",
    "",
  ].join("\n");
  const files = { readFile: async () => text } as unknown as HostingFiles;
  return waitForReport(files, "opscrew/notes-prod", { sleep: async () => {} });
}

describe("the agent's report and the app's database", () => {
  it("needs mysqldump for a MySQL or MariaDB database, and nothing without one", async () => {
    const mysql = await parsed({ mysqldump: "yes" });
    expect(reportMisfit(mysql, { database: "mysql" })).toBeUndefined();
    expect(reportMisfit(mysql, { database: undefined })).toBeUndefined();
    const without = await parsed({ mysqldump: "no" });
    expect(reportMisfit(without, { database: undefined })).toBeUndefined();
    expect(reportMisfit(without, { database: "mariadb" })?.reason).toBe(
      "the account has no mysqldump, which OpsCrew's agent needs to deploy",
    );
  });

  it("needs pg_dump and psql for a PostgreSQL database, and says what to do", async () => {
    const postgres = await parsed({ pg_dump: "yes", psql: "yes" });
    expect(reportMisfit(postgres, { database: "postgres" })).toBeUndefined();
    expect(
      reportMisfit(await parsed({ pg_dump: "no", psql: "yes" }), { database: "postgres" }),
    ).toEqual({
      reason: "the account has no pg_dump, which OpsCrew's agent needs to deploy",
      fix: "Ask your host to add PostgreSQL's client tools (pg_dump and psql) to the account's shell and cron jobs, then run `opscrew provision` again; or use MySQL in the app, then run `opscrew analyze`, `opscrew design` and `opscrew provision` again.",
    });
    expect(
      reportMisfit(await parsed({ pg_dump: "no", psql: "no" }), { database: "postgres" })?.reason,
    ).toBe("the account has no pg_dump and psql, which OpsCrew's agent needs to deploy");
    // A MySQL database needs mysqldump, which a report for PostgreSQL doesn't list.
    expect(reportMisfit(postgres, { database: "mysql" })?.reason).toBe(
      "the account has no mysqldump, which OpsCrew's agent needs to deploy",
    );
  });
});
