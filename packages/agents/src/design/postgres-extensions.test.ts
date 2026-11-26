import {
  PlanServiceSchema,
  type PostgresExtension,
  postgresPostgisExtensions,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { buildLocalhostOption } from "../localhost/design";
import { makeRequirements, nextPostgresFacts, testPlan } from "../testing";
import { designComponents } from "./components";
import { buildPortainerOption } from "./portainer";
import { requirePostgisArch } from "./postgres-extensions";

const postgres = (extensions?: readonly PostgresExtension[], enabled = true) =>
  PlanServiceSchema.parse({
    name: "db",
    kind: "postgres",
    version: "17",
    memoryMb: 512,
    enabled,
    options: extensions === undefined ? {} : { extensions: [...extensions] },
    reason: "The app uses PostgreSQL.",
    licence: "PostgreSQL",
  });

const NOW = new Date("2026-11-26T00:00:00.000Z");

describe("requirePostgisArch and design-level arm64 refusals (045)", () => {
  it("extracts PostGIS extensions from plan-schema's single set", () => {
    expect(postgresPostgisExtensions(postgres(["vector", "pg_trgm"]))).toEqual([]);
    expect(postgresPostgisExtensions(postgres(["postgis", "postgis_raster", "pgcrypto"]))).toEqual([
      "postgis",
      "postgis_raster",
    ]);
  });

  it("allows PostGIS on amd64 and allows vector/contrib on arm64", () => {
    expect(() =>
      requirePostgisArch([postgres(["postgis", "postgis_raster"])], "amd64", "your server"),
    ).not.toThrow();
    expect(() =>
      requirePostgisArch([postgres(["vector", "pgcrypto"])], "arm64", "your server"),
    ).not.toThrow();
    expect(() =>
      requirePostgisArch([postgres(["postgis"], false)], "arm64", "your server"),
    ).not.toThrow();
  });

  it("refuses enabled PostGIS services on arm64 with a plain-English explanation", () => {
    expect(() =>
      requirePostgisArch([postgres(["postgis", "postgis_raster"])], "arm64", "server data"),
    ).toThrow(/postgis\/postgis.*amd64.*server data is arm64/i);
  });

  it("refuses PostGIS in Portainer design on arm64 when extensions come from a previous plan, while allowing vector", () => {
    const facts = nextPostgresFacts();
    const requirements = makeRequirements({
      provider: "portainer",
      region: undefined,
      dnsProvider: "none",
      domain: undefined,
    });
    const prev = testPlan();
    const withPostgis = {
      ...prev,
      services: prev.services.map((s) =>
        s.kind === "postgres"
          ? { ...s, options: { ...s.options, extensions: ["postgis" as const] } }
          : s,
      ),
    };
    const components = designComponents({ facts, requirements, previous: withPostgis }).components;
    const choice = {
      environmentId: 1,
      arch: "arm64" as const,
      redeploy: "updater" as const,
      web: { mode: "proxy" as const, port: 8080 },
    };

    expect(() =>
      buildPortainerOption({ facts, requirements, choice, components, now: NOW }),
    ).toThrow(/postgis\/postgis.*amd64.*your Portainer host is arm64/i);

    expect(() =>
      buildPortainerOption({
        facts,
        requirements,
        choice: { ...choice, arch: "amd64" },
        components,
        now: NOW,
      }),
    ).not.toThrow();

    const withVector = {
      ...prev,
      services: prev.services.map((s) =>
        s.kind === "postgres"
          ? { ...s, options: { ...s.options, extensions: ["vector" as const] } }
          : s,
      ),
    };
    const vectorComponents = designComponents({
      facts,
      requirements,
      previous: withVector,
    }).components;
    expect(() =>
      buildPortainerOption({ facts, requirements, choice, components: vectorComponents, now: NOW }),
    ).not.toThrow();
  });

  it("refuses PostGIS in localhost design on arm64, while allowing amd64 and vector on arm64", () => {
    const facts = nextPostgresFacts();
    const requirements = makeRequirements({
      provider: "localhost",
      region: undefined,
      dnsProvider: "none",
      domain: undefined,
    });
    const prev = testPlan();
    const withPostgis = {
      ...prev,
      services: prev.services.map((s) =>
        s.kind === "postgres"
          ? { ...s, options: { ...s.options, extensions: ["postgis" as const] } }
          : s,
      ),
    };
    const components = designComponents({ facts, requirements, previous: withPostgis }).components;

    expect(() =>
      buildLocalhostOption({ facts, requirements, arch: "arm64", components, now: NOW }),
    ).toThrow(/postgis\/postgis.*amd64.*this computer is arm64/i);

    expect(() =>
      buildLocalhostOption({ facts, requirements, arch: "amd64", components, now: NOW }),
    ).not.toThrow();

    const withVector = {
      ...prev,
      services: prev.services.map((s) =>
        s.kind === "postgres"
          ? { ...s, options: { ...s.options, extensions: ["vector" as const] } }
          : s,
      ),
    };
    const vectorComponents = designComponents({
      facts,
      requirements,
      previous: withVector,
    }).components;
    expect(() =>
      buildLocalhostOption({
        facts,
        requirements,
        arch: "arm64",
        components: vectorComponents,
        now: NOW,
      }),
    ).not.toThrow();
  });
});
