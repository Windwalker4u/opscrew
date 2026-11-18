// Feature 029, scheduled restore drills (T2936; plan.md 19., research R28, R29): the copy's files
// the host plan installs for `snapshot.sh drill scheduled`, which reads them.
import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withServices } from "../catalog/__fixtures__/plans";
import { withBuild, withSqlite } from "../workflow/__fixtures__/plans";
import type { DrillOptions } from "./index";
import {
  DRILL_RECIPE_DIGEST,
  DRILL_RECIPE_DIR,
  DRILL_RECIPE_SCHEDULE,
  drillRecipe,
  drillScheduleHours,
} from "./script";

/** `shop` on Node with PostgreSQL `db`, the stop-only RabbitMQ `mq` and SQLite, drilled weekly. */
const BASE = withSqlite(
  withBuild(
    withServices([
      { kind: "postgres", name: "db" },
      { kind: "rabbitmq", name: "mq" },
    ]),
    "railpack",
    { language: "node", version: "22" },
  ),
);
const plan = (snapshots: unknown) => DeployPlanSchema.parse({ ...BASE, snapshots });
const WEEKLY = plan({ schedule: { every: "daily", keep: 4 }, drills: { schedule: "weekly" } });

const ENV: DrillOptions["env"] = {
  app: "DATABASE_URL=postgres://app:@SECRET:db-password:hex32@@db:5432/app\n",
  services: {
    db: "POSTGRES_PASSWORD=@SECRET:db-password:hex32@\n",
    mq: "RABBITMQ_DEFAULT_PASS=@SECRET:mq-password:hex32@\n",
  },
};
const REPOSITORY = "ghcr.io/acme/shop";

describe("drillRecipe", () => {
  it("renders the copy of a scheduled snapshot's parts under .drill-recipe, with the schedule and a placeholder version", () => {
    const files = drillRecipe(WEEKLY, { repository: REPOSITORY, env: ENV, previewValues: true });
    const paths = files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        `${DRILL_RECIPE_DIR}/compose.yaml`,
        `${DRILL_RECIPE_DIR}/app.env`,
        `${DRILL_RECIPE_DIR}/db.env`,
        `${DRILL_RECIPE_DIR}/${DRILL_RECIPE_SCHEDULE}`,
      ]),
    );
    expect(paths.every((path) => path.startsWith(`${DRILL_RECIPE_DIR}/`))).toBe(true);
    // The host plan writes values.env at apply time; the stop-only mq is not on the schedule.
    expect(paths).not.toContain(`${DRILL_RECIPE_DIR}/values.env`);
    expect(paths).not.toContain(`${DRILL_RECIPE_DIR}/mq.env`);
    const content = (path: string) => files.find((file) => file.path === path)?.content ?? "";
    expect(content(`${DRILL_RECIPE_DIR}/${DRILL_RECIPE_SCHEDULE}`)).toBe("weekly\n");
    expect(content(`${DRILL_RECIPE_DIR}/db.env`)).toContain("@SECRET:db-password:hex32@");
    const compose = parse(content(`${DRILL_RECIPE_DIR}/compose.yaml`)) as {
      name: string;
      services: Record<string, { image: string; env_file?: string[] }>;
    };
    expect(compose.name).toBe("shop-drill");
    expect(Object.keys(compose.services).sort()).toEqual(["app", "db"]);
    expect(compose.services.app?.image).toBe(`${REPOSITORY}@${DRILL_RECIPE_DIGEST}`);
    expect(compose.services.app?.env_file).toEqual(["values.env", "app.env"]);
    expect(content(`${DRILL_RECIPE_DIR}/compose.yaml`)).toMatch(
      new RegExp(`^ *image: ${REPOSITORY}@sha256:0{64}$`, "m"),
    );
  });

  it("keeps a stop-only service the snapshot schedule stops, and reads no values without them", () => {
    const stopped = plan({
      schedule: { every: "weekly", keep: 4, stop: ["mq"] },
      drills: { schedule: "daily" },
    });
    const files = drillRecipe(stopped, { repository: REPOSITORY, env: ENV });
    const compose = parse(
      files.find((file) => file.path === `${DRILL_RECIPE_DIR}/compose.yaml`)?.content ?? "",
    ) as { services: Record<string, { env_file?: string[] }> };
    expect(Object.keys(compose.services).sort()).toEqual(["app", "db", "mq"]);
    expect(compose.services.app?.env_file).toEqual(["app.env"]);
    expect(files.find((file) => file.path.endsWith(`/${DRILL_RECIPE_SCHEDULE}`))?.content).toBe(
      "daily\n",
    );
  });

  it("refuses a plan without a drill schedule", () => {
    expect(() =>
      drillRecipe(plan({ schedule: { every: "weekly", keep: 4 }, drills: {} }), {
        repository: REPOSITORY,
        env: ENV,
      }),
    ).toThrow(OpsCrewError);
  });

  it("names the schedule's period in hours", () => {
    expect(drillScheduleHours("weekly")).toBe(168);
    expect(drillScheduleHours("daily")).toBe(24);
  });
});
