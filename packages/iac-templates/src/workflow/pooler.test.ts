import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testPlan } from "../__fixtures__/plans";
import { renderContext, serviceRotation } from "../catalog";
import { withLogins, withPooler } from "../catalog/__fixtures__/plans";
import { splitPlan } from "./__fixtures__/plans";
import { type RotateStep, renderRotateScript } from "./rotate";
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

/** `rotate.sh`'s step for each rotation of the plan's PostgreSQL `db`, by its secret's name. */
function dbSteps(plan: DeployPlan): Record<string, RotateStep> {
  const db = plan.services.find((service) => service.name === "db") as PlanService;
  const ctx = renderContext(plan, db);
  return Object.fromEntries(
    serviceRotation(db).secrets.map((rotation) => [
      rotation.secrets.join(" "),
      {
        service: db.name,
        envFile: `${db.name}.env`,
        mode: rotation.mode,
        begin: rotation.begin(ctx),
        finish: rotation.finish(ctx),
        recreate: rotation.recreate,
        secrets: rotation.secrets,
      },
    ]),
  );
}

/** The script's lines, and the index of the first that contains `text`. */
function lines(plan: DeployPlan, steps: readonly RotateStep[], server?: string) {
  const script = renderRotateScript(plan, steps, server);
  return { script, at: (text: string) => script.findIndex((line) => line.includes(text)) };
}

const RECREATE =
  "docker compose up -d --no-deps --wait --force-recreate db-pooler >> .rotate/rotate.log 2>&1";

describe("rotating the runtime login's password with PgBouncer beside PostgreSQL (050)", () => {
  const plan = withPooler(testPlan());
  const steps = dbSteps(plan);
  const runtime = steps["runtime-password"] as RotateStep;

  it("creates the pooler again after db has the new password and db.env holds it, before the app's switch", () => {
    const { script, at } = lines(plan, [runtime]);
    const recreated = script.flatMap((line, i) => (line.includes(RECREATE) ? [i] : []));
    // Once on the way there, and once on the way back.
    expect(recreated).toHaveLength(2);
    const [forward = -1, back = -1] = recreated;
    expect(forward).toBeGreaterThan(at("ALTER ROLE app_runtime"));
    expect(forward).toBeGreaterThan(at("mv -f db.env.new db.env"));
    expect(forward).toBeLessThan(at("rot_what='switching the app to the new values'"));
    expect(script).toContain(
      "    rot_step=4; rot_what='writing the new env files and restarting db-pooler with them'",
    );
    // The undo: after the old env files and db's old password, before the app's switch back.
    expect(back).toBeGreaterThan(at("mv -f db.env.new db.env"));
    const swapped = script.findLastIndex((line) => line.includes("ALTER ROLE app_runtime"));
    expect(back).toBeGreaterThan(swapped);
    expect(back).toBeLessThan(at("rot_what='switching the app back to the old values'"));
  });

  it("creates it again once when the whole service rotates", () => {
    const { script } = lines(plan, Object.values(steps));
    expect(script.filter((line) => line.includes(RECREATE))).toHaveLength(2);
  });

  it("creates it again with begin on the extra server that holds the database", () => {
    const split = withPooler(splitPlan());
    const { at } = lines(split, [dbSteps(split)["runtime-password"] as RotateStep], "data");
    expect(at(RECREATE)).toBeGreaterThan(at("mv -f db.env.new db.env"));
    expect(at(RECREATE)).toBeLessThan(at("rot_what='starting to drop the old values'"));
  });

  it("leaves it alone in the other rotations", () => {
    for (const name of ["password", "owner-password"]) {
      const others = [steps[name] as RotateStep];
      expect(renderRotateScript(plan, others)).toEqual(
        renderRotateScript(withLogins(testPlan()), others),
      );
    }
  });

  it("rotates as before without the pooler", () => {
    const without = withLogins(testPlan());
    const script = renderRotateScript(without, Object.values(dbSteps(without))).join("\n");
    expect(script).not.toContain("pooler");
  });
});
