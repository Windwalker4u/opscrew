import { PlanServiceSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { postgisExtensionsOf, requirePostgisArch } from "./postgres-extensions";

const postgres = (extensions?: string[], enabled = true) =>
  PlanServiceSchema.parse({
    name: "db",
    kind: "postgres",
    version: "17",
    memoryMb: 512,
    enabled,
    options: extensions === undefined ? {} : { extensions },
    reason: "The app uses PostgreSQL.",
    licence: "PostgreSQL",
  });

describe("requirePostgisArch", () => {
  it("extracts PostGIS extensions only", () => {
    expect(postgisExtensionsOf(postgres(["vector", "pg_trgm"]))).toEqual([]);
    expect(postgisExtensionsOf(postgres(["postgis", "postgis_topology", "pgcrypto"]))).toEqual([
      "postgis",
      "postgis_topology",
    ]);
  });

  it("allows PostGIS on amd64 and allows vector/contrib on arm64", () => {
    expect(() =>
      requirePostgisArch([postgres(["postgis", "postgis_topology"])], "amd64", "your server"),
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
      requirePostgisArch([postgres(["postgis", "postgis_topology"])], "arm64", "server data", {
        planFile: "opscrew/plan.yaml",
        command: "opscrew design",
        unchanged: "plan.yaml was not changed.",
      }),
    ).toThrow(/postgis\/postgis.*amd64.*server data is arm64/i);
  });
});
