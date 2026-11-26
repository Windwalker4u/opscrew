import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import { IMAGES, renderCompose } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type PostgresExtension } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
import { createTestPhaseDeps, ScriptedApprovalHandler, testPlan } from "../testing";
import {
  extensionsSwitch,
  postgresExtensionsStep,
  readCommittedPostgresImages,
  requireExtensionsArch,
} from "./postgres-extensions";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opscrew-pg-ext-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});

function makePlan(
  opts: {
    extensions?: readonly PostgresExtension[];
    arch?: "amd64" | "arm64";
    provider?: "hetzner" | "own" | "portainer";
  } = {},
): DeployPlan {
  const base = testPlan();
  const target =
    opts.provider === "own"
      ? {
          provider: "own" as const,
          mode: "vps-compose" as const,
          arch: opts.arch ?? "amd64",
          access: "public" as const,
        }
      : opts.provider === "portainer"
        ? {
            provider: "portainer" as const,
            mode: "portainer-stack" as const,
            environmentId: 1,
            arch: opts.arch ?? "amd64",
            redeploy: "updater" as const,
            web: { mode: "tunnel" as const },
          }
        : base.target;
  return DeployPlanSchema.parse({
    ...base,
    target,
    ...(opts.provider === "portainer"
      ? { dns: { ...base.dns, provider: "cloudflare", domain: "shop.example.com" } }
      : {}),
    services: base.services.map((service) =>
      service.kind === "postgres"
        ? {
            ...service,
            options: {
              ...service.options,
              logins: "separate",
              ...(opts.extensions === undefined ? {} : { extensions: [...opts.extensions] }),
            },
          }
        : service,
    ),
  });
}

async function makeDeps(root: string, approved: boolean) {
  const handler = new ScriptedApprovalHandler(() => approved);
  const deps = await createTestPhaseDeps({
    root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(root, ".home"),
    },
    approvalHandler: handler,
  });
  return { deps, handler };
}

describe("provision PostgreSQL extensions (045)", () => {
  it("refuses PostGIS on arm64 own servers and Portainer hosts, while allowing vector on arm64", () => {
    expect(() =>
      requireExtensionsArch(
        makePlan({ provider: "own", arch: "arm64", extensions: ["postgis"] }),
        "opscrew provision",
      ),
    ).toThrow(/postgis\/postgis.*amd64.*arm64/i);

    expect(() =>
      requireExtensionsArch(
        makePlan({ provider: "portainer", arch: "arm64", extensions: ["postgis_topology"] }),
        "opscrew provision",
      ),
    ).toThrow(/Portainer host is arm64/i);

    expect(() =>
      requireExtensionsArch(
        makePlan({ provider: "own", arch: "arm64", extensions: ["vector"] }),
        "opscrew provision",
      ),
    ).not.toThrow();
  });

  it("detects Alpine -> pgvector switch (with reindex note), Alpine -> PostGIS switch (no reindex), and ignores contrib-only or new DBs", () => {
    const kept = { dbPassword: fakeSecret("generic-password", "db") };
    const committedPg = { db: IMAGES.postgres.ref };

    // New DB (no dbPassword) -> no switch
    expect(
      extensionsSwitch(makePlan({ extensions: ["vector"] }), {}, committedPg, "prod"),
    ).toBeUndefined();

    // Contrib-only on postgres:17-alpine -> same repo, no switch
    expect(
      extensionsSwitch(
        makePlan({ extensions: ["pgcrypto", "pg_trgm"] }),
        kept,
        committedPg,
        "prod",
      ),
    ).toBeUndefined();

    // Alpine -> pgvector (musl -> glibc)
    const vec = extensionsSwitch(makePlan({ extensions: ["vector"] }), kept, committedPg, "prod");
    expect(vec).toBeDefined();
    expect(vec?.services).toEqual(["db"]);
    expect(vec?.changes[0]?.reindexes).toBe(true);
    expect(vec?.lines.join("\n")).toContain("Take a snapshot of db now.");
    expect(vec?.lines.join("\n")).toContain("pgvector/pgvector:0.8.7-pg17-trixie");
    expect(vec?.lines.join("\n")).toContain("reindexes db and refreshes its collation version");
    expect(vec?.lines.join("\n")).toContain("can take a while on a large database");
    expect(vec?.hash).toMatch(/^[0-9a-f]{64}$/);

    // Alpine -> PostGIS (Alpine -> Alpine, no reindex)
    const geo = extensionsSwitch(
      makePlan({ extensions: ["postgis", "postgis_topology"] }),
      kept,
      committedPg,
      "prod",
    );
    expect(geo).toBeDefined();
    expect(geo?.changes[0]?.reindexes).toBe(false);
    expect(geo?.lines.join("\n")).toContain("postgis/postgis:17-3.7-alpine");
    expect(geo?.lines.join("\n")).not.toContain("reindexes");

    // Switching away from pgvector -> warns never DROP EXTENSION automatically
    const back = extensionsSwitch(makePlan(), kept, { db: IMAGES.pgvector.ref }, "prod");
    expect(back?.changes[0]?.reindexes).toBe(true);
    expect(back?.lines.join("\n")).toContain("never runs DROP EXTENSION automatically");
  });

  it("shows switch plan on --plan-only, approves by hash, snapshots first, skips neverRan, and aborts on snapshot failure", async () => {
    const root = await makeTempRoot();
    const oldPlan = makePlan();
    const newPlan = makePlan({ extensions: ["vector"] });
    const compose = renderCompose(oldPlan);
    await mkdir(join(root, "opscrew/runtime"), { recursive: true });
    await writeFile(join(root, compose.path), compose.content);

    expect(await readCommittedPostgresImages(root, newPlan)).toEqual({ db: IMAGES.postgres.ref });

    const { deps, handler } = await makeDeps(root, true);
    const valuesPath = generatedValuesFile(deps);
    await mkdir(dirname(valuesPath), { recursive: true });
    await writeFile(
      valuesPath,
      JSON.stringify({ dbPassword: fakeSecret("generic-password", "db") }),
    );

    // 1. --plan-only reports hash and takes no snapshot
    let took = 0;
    const planned = await postgresExtensionsStep(deps, newPlan, {
      command: "opscrew provision",
      planOnly: true,
      snapshot: {
        neverRan: async () => [],
        take: async () => {
          took++;
        },
      },
    });
    expect(planned?.services).toEqual(["db"]);
    expect(took).toBe(0);
    expect(handler.requests).toHaveLength(0);
    expect(deps.reporter.text()).toContain(`--approve ${planned?.hash}`);

    // 2. Approved run takes snapshot of db first
    const skipped: (readonly string[])[] = [];
    await postgresExtensionsStep(deps, newPlan, {
      command: "opscrew provision",
      snapshot: {
        neverRan: async () => [],
        take: async (skip) => {
          took++;
          skipped.push(skip);
        },
      },
    });
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]?.planHash).toBe(planned?.hash);
    expect(took).toBe(1);
    expect(skipped).toEqual([[]]);

    // 3. neverRan skips snapshot cleanly
    await postgresExtensionsStep(deps, newPlan, {
      command: "opscrew provision",
      snapshot: {
        neverRan: async () => ["db"],
        take: async () => {
          took++;
        },
      },
    });
    expect(took).toBe(1);
    expect(deps.reporter.text()).toContain("db has no data yet");

    // 4. Snapshot failure aborts with nothing changed
    await expect(
      postgresExtensionsStep(deps, newPlan, {
        command: "opscrew provision",
        snapshot: {
          neverRan: async () => [],
          take: async () => {
            throw new Error("disk full");
          },
        },
      }),
    ).rejects.toThrow(/snapshot of db.*failed.*disk full.*Nothing was changed/i);

    // 5. Refused approval aborts without taking snapshot
    const denied = await makeDeps(root, false);
    await expect(
      postgresExtensionsStep(denied.deps, newPlan, {
        command: "opscrew provision",
        snapshot: {
          neverRan: async () => [],
          take: async () => {
            took++;
          },
        },
      }),
    ).rejects.toThrow(/Nothing was changed/);
    expect(took).toBe(1);
  });
});
