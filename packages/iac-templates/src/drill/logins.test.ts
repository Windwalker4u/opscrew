import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { withLogins, withServices } from "../catalog/__fixtures__/plans";
import { loginsCheck, loginsLoad } from "../catalog/postgres-logins";
import { shellQuote } from "../runtime/services";
import { withBuild, withPlan } from "../workflow/__fixtures__/plans";
import { snapshotScript } from "../workflow/snapshot-script";
import { databaseCount, partRestore, snapshotParts } from "../workflow/snapshots";
import { type DrillOptions, renderDrill } from "./index";
import { drillCommand } from "./script";

const ID = "20261118T120000Z";
const DIGEST = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;

/** `shop` on Node with PostgreSQL `db` and its own logins, a release command and drills. */
const shop: DeployPlan = withLogins(
  DeployPlanSchema.parse({
    ...withPlan(
      withBuild(withServices([{ kind: "postgres", name: "db" }]), "railpack", {
        language: "node",
        version: "22",
      }),
      { releaseCommand: "npx prisma migrate deploy" },
    ),
    snapshots: { schedule: { every: "daily", keep: 4 }, drills: { schedule: "weekly" } },
  }),
);

/** The copy's env files as provision builds them: placeholders for every generated value. */
const ENV: DrillOptions["env"] = {
  app: "DATABASE_URL=postgresql://app_runtime:@SECRET:db-runtime-password:hex32@@db:5432/app\n",
  services: {
    db: [
      "POSTGRES_USER=app",
      "POSTGRES_DB=app",
      "POSTGRES_PASSWORD=@SECRET:db-password:hex32@",
      "OPSCREW_OWNER_PASSWORD=@SECRET:db-owner-password:hex32@",
      "OPSCREW_RUNTIME_PASSWORD=@SECRET:db-runtime-password:hex32@",
      "",
    ].join("\n"),
  },
};

describe("a restore drill of a PostgreSQL with its own logins (047)", () => {
  const files = Object.fromEntries(
    renderDrill(shop, { id: ID, parts: ["db"] }, { image: DIGEST, env: ENV }).map((file) => [
      file.path.slice(`.drill/${ID}/`.length),
      file.content,
    ]),
  );
  const compose = parse(files["compose.yaml"] ?? "") as {
    services: Record<string, { env_file?: string[] }>;
  };

  it("runs no release, so its copy needs no owner's env file", () => {
    expect(Object.keys(compose.services)).toEqual(["app", "db"]);
    expect(compose.services.app?.env_file).toEqual(["app.env"]);
    expect(compose.services.db?.env_file).toEqual(["db.env"]);
    expect(Object.keys(files)).not.toContain("release.db.env");
  });

  it("keeps the two logins' passwords as placeholders the drill fills with values of its own", () => {
    expect(files["db.env"]).toBe(ENV.services.db);
    expect(files["app.env"]).toBe(ENV.app);
  });

  it("restores with the logins made in the copy's database, then counts once they hold", () => {
    const script = [...snapshotScript(shop), ...drillCommand(shop)].join("\n");
    const [part] = snapshotParts(shop);
    const load = part === undefined ? undefined : partRestore(part).load?.("/snapshot/db.dump");
    expect(load).toContain(loginsLoad({ host: "db", file: "/snapshot/db.dump", setup: true }));
    expect(script).toContain(`ro db ${shellQuote(load ?? "")}`);
    const count = part === undefined ? undefined : databaseCount(part);
    expect(count).toContain(loginsCheck("db"));
    expect(drillCommand(shop).join("\n")).toContain(`sh -c ${shellQuote(count ?? "")} < /dev/null`);
  });
});
