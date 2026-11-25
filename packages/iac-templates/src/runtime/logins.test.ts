import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { withLogins } from "../catalog/__fixtures__/plans";
import { localhostPlan, NIGHTLY, withPlan, withProcesses } from "../workflow/__fixtures__/plans";
import { RELEASE_DB_ENV } from "../workflow/shared";
import { renderCompose } from "./index";

type ComposeService = {
  image?: string;
  env_file?: string[];
  environment?: Record<string, string>;
};

/** The services of `plan`'s Compose file, with a preview's seed. */
function services(plan: DeployPlan): Record<string, ComposeService> {
  return (
    parse(renderCompose(plan, { seed: "npm run seed" }).content) as {
      services: Record<string, ComposeService>;
    }
  ).services;
}

/** `plan` with a release command, a worker and a cron job: every container of the app's image. */
function full(plan: DeployPlan): DeployPlan {
  return withProcesses(withPlan(plan, { releaseCommand: "npm run migrate" }), {
    workers: [{ name: "jobs", command: "npm run jobs" }],
    cron: [NIGHTLY],
  });
}

const APP_CONTAINERS = ["app", "jobs", "cron", "seed"];

describe("the app's Compose file with PostgreSQL's own logins (047)", () => {
  for (const [where, base] of [
    ["a server", testPlan()],
    ["this computer", localhostPlan()],
  ] as const) {
    it(`gives the release app.env, then release.db.env, which no other service reads (${where})`, () => {
      const all = services(full(withLogins(base)));
      expect(RELEASE_DB_ENV.file).toBe("release.db.env");
      expect(all.release?.env_file).toEqual(["app.env", "release.db.env"]);
      for (const [name, service] of Object.entries(all)) {
        if (name === "release") continue;
        expect(service.env_file ?? [], name).not.toContain("release.db.env");
      }
      // The app's other containers read app.env alone, the database its own env file.
      for (const name of APP_CONTAINERS) expect(all[name]?.env_file, name).toEqual(["app.env"]);
      expect(all.db?.env_file).toEqual(["db.env"]);
    });

    it(`puts no value of the database in any container's own environment (${where})`, () => {
      const all = services(full(withLogins(base)));
      for (const [name, service] of Object.entries(all)) {
        const values = Object.values(service.environment ?? {}).join("\n");
        expect(values, name).not.toMatch(/PASSWORD|app_owner|app_runtime|postgresql:/);
      }
    });

    it(`keeps the release as it was but for its second env file (${where})`, () => {
      const before = services(full(base));
      const after = services(full(withLogins(base)));
      const { env_file: _after, ...release } = after.release ?? {};
      const { env_file: _before, ...was } = before.release ?? {};
      expect(release).toEqual(was);
      expect(before.release?.env_file).toEqual(["app.env"]);
      for (const name of APP_CONTAINERS) expect(after[name], name).toEqual(before[name]);
    });
  }
});
