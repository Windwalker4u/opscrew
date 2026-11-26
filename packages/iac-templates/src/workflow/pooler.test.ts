// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax in expected lines, not JavaScript templates.
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { testContext, testPlan } from "../__fixtures__/plans";
import { GRAFANA_CLOUD, observabilityPlan } from "../addons/__fixtures__/plans";
import { renderContext, serviceRotation } from "../catalog";
import { withLogins, withPooler } from "../catalog/__fixtures__/plans";
import { inEnvironment, localhostPlan, serverPlan, splitPlan } from "./__fixtures__/plans";
import { DEPLOY_SECRETS, deploySecretNamesFor, maskFileScript, renderWorkflow } from "./index";
import { type RotateStep, renderRotateScript, rotateEnvFiles } from "./rotate";
import { WORKER_DB_ENV } from "./shared";
import { switchCommands } from "./switch";

const ctx = { ...testContext(), localhost: { hostname: "shop.localhost" } };
const workflow = (plan: DeployPlan) => renderWorkflow(plan, ctx).content;

describe("the workers' env file, worker.db.env (050)", () => {
  it("is a deploy secret beside the pooler only, after the release's", () => {
    for (const base of [serverPlan(), localhostPlan()]) {
      const before = deploySecretNamesFor(withLogins(base));
      const after = deploySecretNamesFor(withPooler(base));
      expect(before).not.toContain(WORKER_DB_ENV.secret);
      const at = after.indexOf(DEPLOY_SECRETS.appEnv) + 2;
      expect(after[at]).toBe("OPSCREW_WORKER_DB_ENV");
      expect([...after.slice(0, at), ...after.slice(at + 1)]).toEqual(before);
    }
  });

  it("is written owner-only next to app.env and release.db.env, from its deploy secret", () => {
    const content = workflow(withPooler(serverPlan()));
    const lines = content.split("\n");
    const release = lines.findIndex((line) => line.includes("cat > /srv/apps/shop/release.db.env"));
    expect(lines[release + 1]?.trim()).toBe(
      `printf '%s\\n' "\${OPSCREW_WORKER_DB_ENV:-}" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/apps/shop/worker.db.env'`,
    );
    expect(content).toContain("    OPSCREW_WORKER_DB_ENV: ${{ secrets.OPSCREW_WORKER_DB_ENV }}\n");
    const local = workflow(withPooler(inEnvironment(localhostPlan(), { runner: "local" })));
    expect(local).toContain(
      `printf '%s\\n' "\${OPSCREW_WORKER_DB_ENV:-}" | (umask 077 && cat > "$dir"/worker.db.env)`,
    );
  });

  it("is nowhere in a workflow without the pooler", () => {
    expect(workflow(withLogins(serverPlan()))).not.toMatch(/worker\.db\.env|WORKER_DB_ENV/);
  });

  it("joins app.env in Grafana Alloy's masking file, so its password is masked too", () => {
    const plan = withPooler(observabilityPlan({ grafanaCloud: GRAFANA_CLOUD }));
    expect(workflow(plan)).toContain(
      `done <<< "$(printf '%s\\n' "\${OPSCREW_APP_ENV:-}" "\${OPSCREW_RELEASE_DB_ENV:-}" "\${OPSCREW_WORKER_DB_ENV:-}")"`,
    );
    expect(maskFileScript(plan)).toContain(
      'OPSCREW_WORKER_DB_ENV="$(cat /srv/apps/shop/worker.db.env)"',
    );
  });
});

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

  it("rewrites the workers' env file on the app's server, which holds the runtime login's password", () => {
    expect(rotateEnvFiles(plan, [runtime])).toEqual(["app.env", "worker.db.env", "db.env"]);
    const { at } = lines(plan, [runtime]);
    const written = at("mv -f worker.db.env.new worker.db.env");
    expect(written).toBeGreaterThan(at("ALTER ROLE app_runtime"));
    expect(written).toBeLessThan(at("rot_what='switching the app to the new values'"));
    // With the database on an extra server too: the app's server's run has no step of its own.
    const split = withPooler(splitPlan());
    const onData = dbSteps(split)["runtime-password"] as RotateStep;
    expect(rotateEnvFiles(split, [])).toEqual(["app.env", "worker.db.env"]);
    expect(rotateEnvFiles(split, [onData], "data")).toEqual(["db.env"]);
  });

  it("leaves the pooler alone in the other rotations", () => {
    for (const name of ["password", "owner-password"]) {
      const script = renderRotateScript(plan, [steps[name] as RotateStep]).join("\n");
      expect(script, name).not.toContain("db-pooler");
    }
  });

  it("rotates as before without the pooler", () => {
    const without = withLogins(testPlan());
    const script = renderRotateScript(without, Object.values(dbSteps(without))).join("\n");
    expect(script).not.toContain("pooler");
    expect(script).not.toContain("worker.db.env");
    expect(rotateEnvFiles(without, [runtime])).toEqual(["app.env", "db.env"]);
  });
});
