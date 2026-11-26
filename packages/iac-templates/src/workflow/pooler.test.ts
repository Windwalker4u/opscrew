import { describe, expect, it } from "vitest";
import { testPlan } from "../__fixtures__/plans";
import { withLogins, withPooler } from "../catalog/__fixtures__/plans";
import { switchCommands } from "./switch";

/** The deploy's start of the services that stay running (`--no-deps` starts no dependency). */
function steady(plan: Parameters<typeof switchCommands>[0]): string | undefined {
  return switchCommands(plan, []).find((line) => line.includes("--no-deps --wait"));
}

describe("the deploy with PgBouncer beside PostgreSQL (050)", () => {
  it("starts the pooler with the services on the app's server", () => {
    expect(steady(withPooler(testPlan()))).toBe(
      "docker compose up -d --no-deps --wait db db-pooler",
    );
  });

  it("starts no pooler without it", () => {
    expect(steady(withLogins(testPlan()))).toBe("docker compose up -d --no-deps --wait db");
    expect(switchCommands(withLogins(testPlan()), []).join("\n")).not.toContain("pooler");
  });
});
