import { type DeployPlan, DeployPlanSchema, type PostgresExtension } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { testPlan } from "../__fixtures__/plans";
import { renderDrill } from "../drill";
import { renderPortainerDrill } from "../drill/portainer";
import { IMAGES } from "../pins";
import { portainerTestPlan } from "../portainer-target/__fixtures__/plans";
import { portainerSnapshotParts } from "../portainer-target/snapshots";
import { renderPortainerStack } from "../portainer-target/stack";
import { renderCompose } from "../runtime";
import { snapshotParts } from "../workflow/snapshots";
import { withLogins } from "./__fixtures__/plans";
import { initStepsFor, serviceImageKey, serviceImageRef } from "./index";
import { extensionsCheck, extensionsSetup } from "./postgres-extensions";
import { loginsCheck, loginsSetup } from "./postgres-logins";

const APP_IMAGE = `ghcr.io/example/app@sha256:${"a".repeat(64)}`;

function withExtensions(plan: DeployPlan, extensions: readonly PostgresExtension[]): DeployPlan {
  return DeployPlanSchema.parse({
    ...plan,
    services: plan.services.map((service) =>
      service.kind === "postgres"
        ? { ...service, options: { ...service.options, extensions: [...extensions] } }
        : service,
    ),
  });
}

function dbOf(plan: DeployPlan) {
  const db = plan.services.find((service) => service.kind === "postgres");
  if (db === undefined) throw new Error("expected a postgres service in test plan");
  return db;
}

describe("PostgreSQL extensions (045)", () => {
  it("picks pgvector for vector, postgis for PostGIS, and keeps postgres for contrib-only or unset", () => {
    const plain = testPlan();
    const contrib = withExtensions(plain, ["pgcrypto", "pg_trgm"]);
    const vec = withExtensions(plain, ["vector", "pg_trgm"]);
    const geo = withExtensions(plain, ["postgis", "postgis_topology"]);

    expect(serviceImageKey(dbOf(plain))).toBe("postgres");
    expect(serviceImageRef(dbOf(plain))).toBe(IMAGES.postgres.ref);

    expect(serviceImageKey(dbOf(contrib))).toBe("postgres");
    expect(serviceImageRef(dbOf(contrib))).toBe(IMAGES.postgres.ref);

    expect(serviceImageKey(dbOf(vec))).toBe("pgvector");
    expect(serviceImageRef(dbOf(vec))).toBe(IMAGES.pgvector.ref);

    expect(serviceImageKey(dbOf(geo))).toBe("postgis");
    expect(serviceImageRef(dbOf(geo))).toBe(IMAGES.postgis.ref);
  });

  it("renders Compose, snapshot parts, and server restore drills with the resolved extension image", () => {
    for (const [extensions, expectedRef] of [
      [["vector"], IMAGES.pgvector.ref],
      [["postgis", "postgis_topology"], IMAGES.postgis.ref],
      [["pgcrypto"], IMAGES.postgres.ref],
    ] as const) {
      const plan = withExtensions(withLogins(testPlan()), extensions);
      const compose = parse(renderCompose(plan).content) as {
        services: Record<string, { image: string }>;
      };
      expect(compose.services.db?.image).toBe(expectedRef);

      const parts = snapshotParts(plan);
      expect(parts.find((part) => part.name === "db")?.image).toBe(expectedRef);

      const drillFiles = renderDrill(
        plan,
        { id: "20261126000000", parts: ["db"] },
        { image: APP_IMAGE, env: { app: "PORT=3000\n", services: { db: "POSTGRES_USER=app\n" } } },
      );
      const drillCompose = parse(
        drillFiles.find((file) => file.path.endsWith("/compose.yaml"))?.content ?? "",
      ) as { services: Record<string, { image: string }> };
      expect(drillCompose.services.db?.image).toBe(expectedRef);
    }
  });

  it("renders Portainer stack, db-init, snapshot parts, and Portainer drills with the resolved extension image", () => {
    const ctx = {
      opscrewVersion: "0.2.12",
      github: { owner: "example", repo: "app" },
      deploySshPublicKey: "ssh-ed25519 AAAA",
    };
    for (const [extensions, expectedRef] of [
      [["vector"], IMAGES.pgvector.ref],
      [["postgis"], IMAGES.postgis.ref],
    ] as const) {
      const plan = withExtensions(withLogins(portainerTestPlan({ postgres: true })), extensions);
      const stack = parse(renderPortainerStack(plan, ctx).content) as {
        services: Record<string, { image: string; entrypoint?: string[] }>;
      };
      expect(stack.services.db?.image).toBe(expectedRef);
      expect(stack.services["db-init"]?.image).toBe(expectedRef);
      const initScript = stack.services["db-init"]?.entrypoint?.[2] ?? "";
      expect(initScript).toContain("CREATE EXTENSION IF NOT EXISTS");
      expect(initScript).toContain("REFRESH COLLATION VERSION");

      const parts = portainerSnapshotParts(plan);
      expect(parts.find((part) => part.name === "db")?.image).toBe(expectedRef);

      const drill = renderPortainerDrill(
        plan,
        { id: "20261126000000", parts: ["db"] },
        { image: APP_IMAGE },
      );
      const drillDoc = parse(drill.services) as { services: Record<string, { image: string }> };
      expect(drillDoc.services.db?.image).toBe(expectedRef);
      expect(drillDoc.services["db-init"]?.image).toBe(expectedRef);
    }
  });

  it("builds superuser setup steps for extensions alone and before logins when separate logins are on", () => {
    const extOnly = withExtensions(testPlan(), ["vector", "uuid-ossp"]);
    expect(initStepsFor(extOnly)).toEqual([
      {
        service: "db",
        check: ["sh", "-c", extensionsCheck(["vector", "uuid-ossp"])],
        run: [
          "sh",
          "-c",
          extensionsSetup("db", ["vector", "uuid-ossp"], { guardEventTriggers: false }),
        ],
      },
    ]);

    const both = withExtensions(withLogins(testPlan()), ["vector"]);
    expect(initStepsFor(both)).toEqual([
      {
        service: "db",
        check: ["sh", "-c", extensionsCheck(["vector"])],
        run: ["sh", "-c", extensionsSetup("db", ["vector"], { guardEventTriggers: true })],
      },
      {
        service: "db",
        check: ["sh", "-c", loginsCheck()],
        run: ["sh", "-c", loginsSetup("db")],
      },
    ]);

    // Check script verifies both pg_extension and collation version match
    const check = extensionsCheck(["vector", "uuid-ossp"]);
    expect(check).toContain("pg_extension");
    expect(check).toContain("vector");
    expect(check).toContain("uuid-ossp");
    expect(check).toContain("pg_database_collation_actual_version");

    // Setup script runs REINDEX + REFRESH COLLATION VERSION outside a transaction, then CREATE EXTENSION
    const setup = extensionsSetup("db", ["vector", "uuid-ossp"], { guardEventTriggers: true });
    expect(setup).toContain("pg_event_trigger");
    expect(setup).toContain("REINDEX DATABASE app;");
    expect(setup).toContain("ALTER DATABASE app REFRESH COLLATION VERSION;");
    expect(setup).toContain('CREATE EXTENSION IF NOT EXISTS "vector" CASCADE;');
    expect(setup).toContain('CREATE EXTENSION IF NOT EXISTS "uuid-ossp" CASCADE;');
    expect(setup).not.toContain("BEGIN;\nSET LOCAL");
  });

  it("produces byte-for-byte identical Compose output when extensions is unset", () => {
    const base = testPlan();
    const withEmpty = withExtensions(base, []);
    expect(renderCompose(withEmpty).content).toBe(renderCompose(base).content);
    expect(initStepsFor(withEmpty)).toEqual([]);
  });
});
