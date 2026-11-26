import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { POOLER_MEMORY_MB } from "../catalog";
import { withLogins, withPooler, withServices } from "../catalog/__fixtures__/plans";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { withBuild, withPlan } from "../workflow/__fixtures__/plans";
import { type DrillOptions, renderDrill, renderPortainerDrill } from "./index";
import { drillCommand } from "./script";

const ID = "20261118T120000Z";
const DIGEST = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;

/** `shop` on PHP with PostgreSQL `db` and its own logins, and drills. */
const BASE: DeployPlan = withLogins(
  DeployPlanSchema.parse({
    ...withPlan(
      withBuild(withServices([{ kind: "postgres", name: "db" }]), "railpack", {
        language: "php",
        version: "8.5",
      }),
      { releaseCommand: "php artisan migrate --force" },
    ),
    snapshots: { schedule: { every: "daily", keep: 4 }, drills: { schedule: "weekly" } },
  }),
);
/** The same with PgBouncer beside `db` (050). */
const POOLED = withPooler(BASE);

/** The copy's env files as provision builds them, the app's through the pooler. */
const ENV: DrillOptions["env"] = {
  app: "DATABASE_URL=postgresql://app_runtime:@SECRET:db-runtime-password:hex32@@db-pooler:6432/app\n",
  services: {
    db: [
      "POSTGRES_PASSWORD=@SECRET:db-password:hex32@",
      "OPSCREW_OWNER_PASSWORD=@SECRET:db-owner-password:hex32@",
      "OPSCREW_RUNTIME_PASSWORD=@SECRET:db-runtime-password:hex32@",
      "",
    ].join("\n"),
  },
};

type Compose = { services: Record<string, Record<string, unknown>> };

/** The drill's `compose.yaml` of `plan`'s snapshot of `db`. */
function compose(plan: DeployPlan): Compose {
  const file = renderDrill(plan, { id: ID, parts: ["db"] }, { image: DIGEST, env: ENV }).find(
    (f) => f.path === `.drill/${ID}/compose.yaml`,
  );
  return parse(file?.content ?? "") as Compose;
}

describe("a restore drill with PgBouncer beside PostgreSQL (050)", () => {
  it("puts the pooler in the copy, on its network, from the database's env file", () => {
    const { services } = compose(POOLED);
    expect(Object.keys(services)).toEqual(["app", "db", "db-pooler"]);
    expect(services["db-pooler"]).toMatchObject({
      restart: "no",
      networks: ["internal"],
      env_file: ["db.env"],
      depends_on: { db: { condition: "service_healthy" } },
    });
    expect(services["db-pooler"]).not.toHaveProperty("ports");
    expect(services.app?.depends_on).toEqual({
      db: { condition: "service_healthy" },
      "db-pooler": { condition: "service_healthy" },
    });
  });

  it("starts the pooler once the database holds its data, before the app", () => {
    const script = drillCommand(POOLED);
    const at = (text: string) => script.findIndex((line) => line.includes(text));
    const start = at("up -d --no-deps --wait $_drill_poolers");
    expect(start).toBeGreaterThan(at('snapshot_restore "$_drill_id" "$_drill_p"'));
    expect(start).toBeLessThan(at("up -d --no-deps app"));
    // Only when the drill restores db.
    expect(script).toContain('      db) _drill_poolers="$_drill_poolers db-pooler" ;;');
    // Its memory limit counts with the database's.
    const db = POOLED.services.find((service) => service.name === "db");
    expect(script).toContain(`      db) echo ${(db?.memoryMb ?? 0) + POOLER_MEMORY_MB} ;;`);
  });

  it("is the copy and the script of today without the pooler", () => {
    expect(Object.keys(compose(BASE).services)).toEqual(["app", "db"]);
    expect(drillCommand(BASE).join("\n")).not.toContain("pooler");
  });

  it("puts the pooler in a Portainer drill's stack, which starts it with the services", () => {
    const plan = (pooled: boolean) => {
      const base = withLogins(portainerTestPlan({ postgres: true }));
      return pooled ? withPooler(base) : base;
    };
    const drill = renderPortainerDrill(plan(true), { id: ID, parts: ["db"] }, { image: DIGEST });
    for (const file of [drill.services, drill.withApp]) {
      const stack = parse(file) as Compose;
      expect(Object.keys(stack.services)).toContain("db-pooler");
      expect(stack.services["db-pooler"]).toMatchObject({ restart: "no", networks: ["internal"] });
      expect(stack.services["db-pooler"]?.profiles).toBeUndefined();
    }
    const without = renderPortainerDrill(plan(false), { id: ID, parts: ["db"] }, { image: DIGEST });
    expect(without.withApp).not.toContain("pooler");
  });
});
