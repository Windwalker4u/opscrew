// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation under test.
import { OpsCrewError } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { withSqlite } from "../workflow/__fixtures__/plans";
import { renderPortainerDrill } from "./index";

const ID = "20261118T120000Z";
const DIGEST = `ghcr.io/acme/shop@sha256:${"a".repeat(64)}`;

/** `shop` in Portainer behind Caddy's ports, with PostgreSQL `db`, Redis and a release command. */
const base = withSqlite(
  portainerTestPlan({
    postgres: true,
    redis: true,
    web: { mode: "caddy" },
    releaseCommand: "npx prisma migrate deploy",
  }),
);
const shop = DeployPlanSchema.parse({
  ...base,
  app: {
    ...base.app,
    build: {
      builder: "railpack",
      chosen: "auto",
      reason: "test",
      runtime: { language: "node", version: "24" },
      probe: "node",
    },
  },
});

interface Stack {
  name: string;
  services: Record<string, Record<string, unknown>>;
  networks: Record<string, unknown>;
  volumes: Record<string, unknown>;
}

describe("renderPortainerDrill", () => {
  it("renders the drill's stack: the app and the snapshot's services only, cut off, no port", () => {
    const drill = renderPortainerDrill(
      shop,
      { id: ID, parts: ["db", "sqlite"] },
      { image: DIGEST },
    );
    expect(drill.name).toBe(`opscrew-${shop.app.name}-drill`);
    const withApp = parse(drill.withApp) as Stack;
    const services = parse(drill.services) as Stack;
    expect(withApp.name).toBe(drill.name);
    expect(Object.keys(withApp.services).sort()).toEqual(["app", "db"]);
    expect(withApp.networks).toEqual({ internal: { internal: true } });
    expect(drill.withApp).not.toMatch(/^\s*ports:/m);
    for (const service of Object.values(withApp.services)) {
      expect(service.restart).toBe("no");
      expect(service.networks).toEqual(["internal"]);
    }
    expect(drill.withApp).toContain('restart: "no"');
    const app = withApp.services.app as Record<string, unknown>;
    expect(app.image).toBe(DIGEST);
    expect(app.depends_on).toEqual({ db: { condition: "service_healthy" } });
    expect(app.profiles).toBeUndefined();
    // A server's health check of the app, which the drill reads (the app's stack has none).
    expect(app.healthcheck).toMatchObject({ test: expect.arrayContaining(["CMD", "node"]) });
    // Before the data is back, Portainer's deploy starts only the services.
    expect(services.services.app?.profiles).toEqual(["app"]);
    expect(services.services.db).toEqual(withApp.services.db);
    // Its own volumes, and the snapshots volume only read.
    expect(drill.volumes).toEqual([`${drill.name}_db_data`, `${drill.name}_sqlite`]);
    expect(drill.external).toEqual([`opscrew-${shop.app.name}_snapshots`]);
    expect(withApp.volumes.snapshots).toEqual({
      external: true,
      name: `opscrew-${shop.app.name}_snapshots`,
    });
    // The secrets stay the stack's variables, which the drill fills with its own values.
    expect(
      (withApp.services.db as { environment: Record<string, string> }).environment,
    ).toMatchObject({
      POSTGRES_PASSWORD: "${OPSCREW_DB_PASSWORD}",
    });
    expect(drill.withApp).not.toContain("prisma migrate");
    expect(drill.withApp).not.toContain("caddy");
  });

  it("never lets Railpack's start migrate a Laravel app's restored copy, with or without a release command", () => {
    for (const release of [true, false]) {
      const { releaseCommand: _, ...app } = shop.app;
      const laravel = DeployPlanSchema.parse({
        ...shop,
        app: {
          ...(release ? shop.app : app),
          build: { ...shop.app.build, runtime: { language: "php", version: "8.5" }, probe: "php" },
        },
      });
      const drill = renderPortainerDrill(laravel, { id: ID, parts: ["db"] }, { image: DIGEST });
      for (const file of [drill.withApp, drill.services]) {
        expect(
          (parse(file) as Stack).services.app?.environment,
          `with a release command: ${release}`,
        ).toMatchObject({ RAILPACK_SKIP_MIGRATIONS: "true" });
      }
    }
    const drill = renderPortainerDrill(shop, { id: ID, parts: ["db"] }, { image: DIGEST });
    expect((parse(drill.withApp) as Stack).services.app?.environment).not.toHaveProperty(
      "RAILPACK_SKIP_MIGRATIONS",
    );
  });

  it("refuses another target, an image not pinned by its digest and a part the plan lacks", () => {
    const server = DeployPlanSchema.parse({ ...shop, target: portainerTestPlan().target });
    expect(() =>
      renderPortainerDrill(
        { ...server, target: { provider: "localhost" } as never },
        { id: ID, parts: ["db"] },
        { image: DIGEST },
      ),
    ).toThrow(OpsCrewError);
    expect(() =>
      renderPortainerDrill(shop, { id: ID, parts: ["db"] }, { image: "ghcr.io/acme/shop:latest" }),
    ).toThrow(OpsCrewError);
    expect(() =>
      renderPortainerDrill(shop, { id: ID, parts: ["nope"] }, { image: DIGEST }),
    ).toThrow(OpsCrewError);
  });
});
