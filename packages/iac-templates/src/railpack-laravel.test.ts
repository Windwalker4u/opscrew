// A Laravel app Railpack builds runs its migrations only in OpsCrew's release step: with a release
// command, every container of its image gets RAILPACK_SKIP_MIGRATIONS=true beside app.env, so
// Railpack's start script (the web's) never migrates on its own.
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testContext, testPlan } from "./__fixtures__/plans";
import { renderPortainerStack } from "./portainer-target";
import { portainerTestPlan } from "./portainer-target/__fixtures__/plans";
import { renderCompose } from "./runtime";

const LARAVEL = {
  builder: "railpack",
  chosen: "auto",
  reason: "test",
  runtime: { language: "php", version: "8.5" },
  probe: "php",
} as const;

/** `plan` as a Laravel app with a worker and a cron job, with or without its release command. */
function laravel(
  plan: DeployPlan,
  o: { release?: boolean; build?: Record<string, unknown> } = {},
): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    app: {
      ...plan.app,
      build: o.build ?? LARAVEL,
      ...(o.release === false ? {} : { releaseCommand: "php artisan migrate --force" }),
    },
    processes: {
      workers: [{ name: "horizon", command: "php artisan horizon", source: "library" }],
      cron: [{ name: "report", schedule: "0 * * * *", command: "php artisan report" }],
    },
  });
}

type Services = Record<string, { environment?: Record<string, unknown> }>;

/** The containers of the app's image in a rendered Compose file, with their environment. */
function imageServices(content: string): Record<string, Record<string, unknown> | undefined> {
  const services = (parse(content) as { services: Services }).services;
  const names = ["app", "release", "horizon", "cron"].filter((name) => name in services);
  return Object.fromEntries(names.map((name) => [name, services[name]?.environment]));
}

const server = () => renderCompose(laravel(testPlan())).content;
const portainer = () =>
  renderPortainerStack(laravel(portainerTestPlan()), testContext({ acmeEmail: "ops@example.com" }))
    .content;

describe("a Laravel app Railpack builds, with a release command", () => {
  it.each([
    ["on a server", server],
    ["in a Portainer stack", portainer],
  ])("skips Railpack's own migrations in every container of its image %s", (_, render) => {
    const services = imageServices(render());
    expect(Object.keys(services)).toEqual(["app", "release", "horizon", "cron"]);
    for (const [name, environment] of Object.entries(services)) {
      expect(environment?.RAILPACK_SKIP_MIGRATIONS, name).toBe("true");
    }
  });

  it("leaves Railpack's start to migrate without a release command, and other images alone", () => {
    const { webRoot: _, ...build } = { ...LARAVEL, webRoot: "public" };
    const plans = {
      "no release command": laravel(testPlan(), { release: false }),
      "a plain PHP app": laravel(testPlan(), { build: { ...LARAVEL, webRoot: "public" } }),
      "its own Dockerfile": laravel(testPlan(), {
        build: { ...build, builder: "own-dockerfile", probe: "none" },
      }),
      "a Node.js app": laravel(testPlan(), {
        build: { ...LARAVEL, runtime: { language: "node", version: "24" }, probe: "node" },
      }),
    };
    for (const [what, plan] of Object.entries(plans)) {
      for (const [name, environment] of Object.entries(
        imageServices(renderCompose(plan).content),
      )) {
        expect(environment, `${what}: ${name}`).not.toHaveProperty("RAILPACK_SKIP_MIGRATIONS");
      }
    }
  });
});
