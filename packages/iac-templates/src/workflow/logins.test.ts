// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax in expected lines, not JavaScript templates.
import type { DeployPlan, PlanService } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse, parseDocument } from "yaml";
import { testContext, testPlan } from "../__fixtures__/plans";
import { GRAFANA_CLOUD, observabilityPlan } from "../addons/__fixtures__/plans";
import { renderContext, serviceRotation } from "../catalog";
import { withLogins } from "../catalog/__fixtures__/plans";
import { loginsCheck, loginsLoad } from "../catalog/postgres-logins";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { previewPlan } from "../previews/__fixtures__/plans";
import { shellQuote } from "../runtime/services";
import { inEnvironment, localhostPlan, serverPlan, splitPlan } from "./__fixtures__/plans";
import { DEPLOY_SECRETS, deploySecretNamesFor, maskFileScript, renderWorkflow } from "./index";
import { renderPreviewWorkflow } from "./preview";
import { type RotateStep, renderRotateScript, rotateEnvFiles } from "./rotate";
import { RELEASE_DB_ENV } from "./shared";
import { snapshotScript } from "./snapshot-script";
import { databaseCount, partRestore, snapshotParts } from "./snapshots";

const ctx = { ...testContext(), localhost: { hostname: "shop.localhost" } };
const workflow = (plan: DeployPlan) => renderWorkflow(plan, ctx).content;

describe("the release's env file, release.db.env (047)", () => {
  it("is a deploy secret for a plan with a PostgreSQL's own logins only", () => {
    for (const base of [serverPlan(), localhostPlan()]) {
      const before = deploySecretNamesFor(base);
      const after = deploySecretNamesFor(withLogins(base));
      expect(before).not.toContain(RELEASE_DB_ENV.secret);
      const at = after.indexOf(DEPLOY_SECRETS.appEnv) + 1;
      expect(after[at]).toBe("OPSCREW_RELEASE_DB_ENV");
      expect([...after.slice(0, at), ...after.slice(at + 1)]).toEqual(before);
    }
    // A Portainer stack's release reads the owner's password from the stack's own variables.
    const portainer = portainerTestPlan({ postgres: true });
    expect(deploySecretNamesFor(withLogins(portainer))).toEqual(deploySecretNamesFor(portainer));
  });

  it("is written owner-only next to app.env, from its deploy secret", () => {
    const content = workflow(withLogins(serverPlan()));
    const lines = content.split("\n");
    const app = lines.findIndex((line) => line.includes("cat > /srv/apps/shop/app.env"));
    expect(lines[app + 1]?.trim()).toBe(
      `printf '%s\\n' "\${OPSCREW_RELEASE_DB_ENV:-}" | ssh "\${ssh_opts[@]}" "deploy@\${HOST}" 'umask 077 && cat > /srv/apps/shop/release.db.env'`,
    );
    expect(content).toContain(
      "    OPSCREW_RELEASE_DB_ENV: ${{ secrets.OPSCREW_RELEASE_DB_ENV }}\n",
    );
    // Another environment's own secret.
    const staging = workflow(withLogins(inEnvironment(serverPlan(), { name: "staging" })));
    expect(staging).toContain(
      "    OPSCREW_RELEASE_DB_ENV: ${{ secrets.OPSCREW_STAGING_RELEASE_DB_ENV }}\n",
    );
  });

  it("is written by the deploy on this computer too", () => {
    const content = workflow(withLogins(inEnvironment(localhostPlan(), { runner: "local" })));
    expect(content).toContain(
      `printf '%s\\n' "\${OPSCREW_RELEASE_DB_ENV:-}" | (umask 077 && cat > "$dir"/release.db.env)`,
    );
  });

  it("is nowhere in a workflow without logins", () => {
    for (const plan of [serverPlan(), inEnvironment(localhostPlan(), { runner: "local" })]) {
      expect(workflow(plan)).not.toMatch(/release\.db\.env|RELEASE_DB_ENV/);
    }
  });

  it("joins app.env in Grafana Alloy's masking file, so the owner's password is masked too", () => {
    const plan = withLogins(observabilityPlan({ grafanaCloud: GRAFANA_CLOUD }));
    expect(workflow(plan)).toContain(
      `done <<< "$(printf '%s\\n' "\${OPSCREW_APP_ENV:-}" "\${OPSCREW_RELEASE_DB_ENV:-}")"`,
    );
    expect(maskFileScript(plan)).toContain(
      'OPSCREW_RELEASE_DB_ENV="$(cat /srv/apps/shop/release.db.env)"',
    );
    const without = observabilityPlan({ grafanaCloud: GRAFANA_CLOUD });
    expect(maskFileScript(without)).not.toContain("release.db.env");
  });
});

/** `rotate.sh`'s step for each rotation of the plan's PostgreSQL `db`, as `opscrew rotate` would. */
function dbSteps(plan: DeployPlan): RotateStep[] {
  const db = plan.services.find((service) => service.name === "db") as PlanService;
  const ctx = renderContext(plan, db);
  return serviceRotation(db).secrets.map((rotation) => ({
    service: db.name,
    envFile: `${db.name}.env`,
    mode: rotation.mode,
    begin: rotation.begin(ctx),
    finish: rotation.finish(ctx),
    recreate: rotation.recreate,
    secrets: rotation.secrets,
  }));
}

describe("rotating the two logins' passwords (047)", () => {
  const plan = withLogins(testPlan());
  const [password, owner, runtime] = dbSteps(plan);
  if (password === undefined || owner === undefined || runtime === undefined) {
    throw new Error("PostgreSQL rotates three passwords with logins.");
  }

  it("rewrites db.env and release.db.env for the owner's, db.env and app.env for the runtime's", () => {
    expect(rotateEnvFiles(plan, [owner])).toEqual(["app.env", "release.db.env", "db.env"]);
    expect(rotateEnvFiles(plan, [runtime])).toEqual(["app.env", "db.env"]);
    expect(rotateEnvFiles(plan, [password])).toEqual(["app.env", "db.env"]);
    expect(rotateEnvFiles(plan, [password, owner, runtime])).toEqual([
      "app.env",
      "release.db.env",
      "db.env",
    ]);
    // On an extra server, only the database's own: the release runs on the app's server.
    expect(rotateEnvFiles(plan, [owner], "data")).toEqual(["db.env"]);
  });

  it("never creates the database again", () => {
    const script = renderRotateScript(plan, [password, owner, runtime]).join("\n");
    expect(script).toContain("> release.db.env.new");
    expect(script).not.toMatch(/docker compose up[^\n]* db\b/);
    for (const step of [password, owner, runtime]) expect(step.recreate).toBe(false);
  });
});

describe("snapshots of a PostgreSQL with its own logins (047)", () => {
  const FILE = "/snapshot/db.dump";
  const [part] = snapshotParts(withLogins(testPlan()));
  const [plain] = snapshotParts(testPlan());
  if (part === undefined || plain === undefined) throw new Error("The plan has PostgreSQL.");

  it("records the logins on the database's part only", () => {
    expect(part).toEqual({ ...plain, logins: true });
    expect(plain).not.toHaveProperty("logins");
  });

  it("restores with the logins made first, the dump's owners kept and the grants after", () => {
    expect(partRestore(part).load?.(FILE)).toBe(
      `umask 077 && export PGPASSWORD="$POSTGRES_PASSWORD" && ${loginsLoad({ host: "db", file: FILE, setup: true })}`,
    );
    expect(partRestore(plain).load?.(FILE)).toBe(
      `umask 077 && export PGPASSWORD="$POSTGRES_PASSWORD" && psql -X -q -h db -U app -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS app WITH (FORCE)" -c "CREATE DATABASE app OWNER app" && pg_restore -h db -U app -d app --no-owner --single-transaction ${FILE}`,
    );
  });

  it("counts a drill's tables only once the logins check passes", () => {
    const tables = `psql -X -q -At -h db -U app -d app -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')"`;
    const ready = 'export PGPASSWORD="$POSTGRES_PASSWORD" && pg_isready -q -h db -U app -d app';
    expect(databaseCount(part)).toBe(`${ready} && ${loginsCheck("db")} && ${tables}`);
    expect(databaseCount(plain)).toBe(`${ready} && ${tables}`);
  });

  it("restores so on the server, on the extra server the database is placed on too", () => {
    for (const [plan, server] of [
      [withLogins(testPlan()), "app"],
      [withLogins(splitPlan()), "data"],
    ] as const) {
      const db = snapshotParts(plan, server).find((each) => each.name === "db");
      const load = db === undefined ? undefined : partRestore(db).load?.(FILE);
      expect(load, server).toContain(loginsLoad({ host: "db", file: FILE, setup: true }));
      expect(snapshotScript(plan, server).join("\n")).toContain(`ro db ${shellQuote(load ?? "")}`);
    }
    expect(snapshotScript(testPlan()).join("\n")).not.toContain("app_owner");
  });
});

describe("the deploy workflow with a PostgreSQL's own logins (047)", () => {
  /** Every step's `run:` script of the workflow `content`, parsed as YAML. */
  const runs = (content: string): string[] => {
    const jobs = (parse(content) as { jobs: Record<string, { steps?: { run?: string }[] }> }).jobs;
    return Object.values(jobs).flatMap((job) => (job.steps ?? []).flatMap((s) => s.run ?? []));
  };

  it("parses, and the snapshot.sh it uploads to each server is the script line for line", () => {
    for (const [where, plan, servers] of [
      ["a server", withLogins(serverPlan()), ["app"]],
      [
        "the local runner",
        withLogins(inEnvironment(localhostPlan(), { runner: "local" })),
        ["app"],
      ],
      ["a database on an extra server", withLogins(splitPlan()), ["app", "data"]],
    ] as const) {
      const content = workflow(plan);
      expect(
        parseDocument(content).errors.map((error) => error.message),
        where,
      ).toEqual([]);
      const uploaded = runs(content).flatMap((run) =>
        [...run.matchAll(/<<'SNAPSHOT'\n([\s\S]*?)\nSNAPSHOT$/gm)].map((match) => match[1]),
      );
      for (const server of servers) {
        expect(uploaded, `${where}: ${server}'s snapshot.sh`).toContain(
          snapshotScript(plan, server).join("\n"),
        );
      }
    }
  });

  it("parses for a Portainer stack and for the previews too", () => {
    const previews = renderPreviewWorkflow(
      withLogins(previewPlan({ secrets: "environment" })),
      ctx,
    );
    for (const [where, content] of [
      ["Portainer", workflow(withLogins(portainerTestPlan({ postgres: true })))],
      ["the previews", previews.content],
    ] as const) {
      expect(
        parseDocument(content).errors.map((error) => error.message),
        where,
      ).toEqual([]);
    }
  });
});
