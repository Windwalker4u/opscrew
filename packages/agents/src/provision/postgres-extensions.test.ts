import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeZone } from "@opscrew/connector-cloudflare/testing";
import type { ApprovalRequest } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, type PostgresExtension } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { generatedValuesFile } from "../shared/app-secrets";
import {
  createProject,
  createTestPhaseDeps,
  FakeEngine,
  FakeGitHub,
  fakeSharedCloudflare,
  projectRunner,
  readyRemote,
  ScriptedApprovalHandler,
  testPlan,
} from "../testing";
import { noOtherApps } from "../testing/other-apps";
import { postgresExtensionsStep, requireExtensionsArch } from "./postgres-extensions";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const HCLOUD = fakeSecret("hcloud-token");
const STRIPE = fakeSecret("stripe-live-key");
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
    logins?: "separate" | undefined;
    arch?: "amd64" | "arm64";
    provider?: "hetzner" | "own" | "portainer" | "localhost";
    serverType?: string;
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
        : opts.provider === "localhost"
          ? {
              provider: "localhost" as const,
              mode: "local-compose" as const,
              arch: opts.arch ?? "amd64",
              ports: { http: 80, https: 443 },
              image: "local-build" as const,
              edge: "caddy" as const,
            }
          : {
              ...base.target,
              ...(opts.serverType === undefined ? {} : { serverType: opts.serverType }),
            };
  return DeployPlanSchema.parse({
    ...base,
    target,
    ...(opts.provider === "portainer"
      ? { dns: { ...base.dns, provider: "cloudflare", domain: "shop.example.com" } }
      : opts.provider === "localhost"
        ? { dns: { provider: "none" } }
        : {}),
    services: base.services.map((service) =>
      service.kind === "postgres"
        ? {
            ...service,
            options: {
              ...(opts.logins === undefined ? {} : { logins: opts.logins }),
              ...(opts.extensions === undefined ? {} : { extensions: [...opts.extensions] }),
            },
          }
        : service,
    ),
  });
}

async function makeDeps(root: string) {
  return createTestPhaseDeps({
    root,
    env: { ...process.env, OPSCREW_HOME: join(root, ".home") },
  });
}

async function provisionProject(
  plan: DeployPlan,
  kept?: Record<string, unknown>,
  empty: string[] = [],
) {
  const created = await createProject(plan);
  await created.git(created.root, "add", "opscrew/plan.yaml");
  await created.git(created.root, "commit", "-q", "-m", "plan");
  await writeFile(join(created.root, "production.env"), `STRIPE_SECRET_KEY=${STRIPE}\n`);
  const handler = new ScriptedApprovalHandler(() => true);
  const deps = await createTestPhaseDeps({
    root: created.root,
    env: {
      ...process.env,
      OPSCREW_HOME: join(created.root, ".home-opscrew"),
      HCLOUD_TOKEN: HCLOUD,
      OPSCREW_APP_ENV_FILE: "production.env",
    },
    runner: projectRunner(),
    approvalHandler: handler,
  });
  const keptText = kept === undefined ? undefined : `${JSON.stringify(kept)}\n`;
  if (keptText !== undefined) {
    await mkdir(dirname(generatedValuesFile(deps)), { recursive: true });
    await writeFile(generatedValuesFile(deps), keptText);
  }
  const github = new FakeGitHub();
  let snapshotsTaken = 0;
  const services: ProvisionServices = {
    otherApps: { inspect: noOtherApps },
    engine: async () => new FakeEngine(),
    provider: { configured: true, verify: async () => ({ ok: true, message: "ok" }) },
    github,
    tcpConnect: async () => true,
    remote: readyRemote,
    sleep: async () => undefined,
    sharedCloudflare: fakeSharedCloudflare(new FakeZone()),
    snapshot: {
      neverRan: async (names) => names.filter((name) => empty.includes(name)),
      take: async () => {
        snapshotsTaken++;
      },
    },
  };
  return {
    ...created,
    deps,
    handler,
    github,
    services,
    keptText,
    snapshotsTaken: () => snapshotsTaken,
  };
}

describe("provision PostgreSQL extensions (045)", () => {
  it("refuses PostGIS on arm64 own, Portainer, localhost, and hand-edited ARM cloud server types (cax11), while allowing vector", async () => {
    await expect(
      requireExtensionsArch(
        makePlan({ provider: "own", arch: "arm64", extensions: ["postgis"] }),
        "opscrew provision",
      ),
    ).rejects.toThrow(/postgis\/postgis.*amd64.*arm64/i);

    await expect(
      requireExtensionsArch(
        makePlan({ provider: "portainer", arch: "arm64", extensions: ["postgis_raster"] }),
        "opscrew provision",
      ),
    ).rejects.toThrow(/Portainer host is arm64/i);

    await expect(
      requireExtensionsArch(
        makePlan({ provider: "localhost", arch: "arm64", extensions: ["postgis"] }),
        "opscrew provision",
      ),
    ).rejects.toThrow(/this computer is arm64/i);

    // Hand-edited Hetzner ARM serverType (cax11) checked against the provider catalogue
    await expect(
      requireExtensionsArch(
        makePlan({ provider: "hetzner", serverType: "cax11", extensions: ["postgis"] }),
        "opscrew provision",
      ),
    ).rejects.toThrow(/cax11.*arm64/i);

    await expect(
      requireExtensionsArch(
        makePlan({ provider: "hetzner", serverType: "cx23", extensions: ["postgis"] }),
        "opscrew provision",
      ),
    ).resolves.toBeUndefined();

    await expect(
      requireExtensionsArch(
        makePlan({ provider: "hetzner", serverType: "cax11", extensions: ["vector"] }),
        "opscrew provision",
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses adding or removing extensions on an existing database with data, while allowing new, unchanged, or never-ran databases", async () => {
    const root = await makeTempRoot();
    const deps = await makeDeps(root);
    const valuesPath = generatedValuesFile(deps);

    // 1. Brand-new database (no generated_values.json yet) -> allowed
    await expect(
      postgresExtensionsStep(deps, makePlan({ extensions: ["vector"] }), {
        command: "opscrew provision",
        snapshot: { neverRan: async () => [] },
      }),
    ).resolves.toBeUndefined();

    // 2. Existing pre-045 database (dbPassword kept, no postgresExtensions) with data -> adding vector refused
    await mkdir(dirname(valuesPath), { recursive: true });
    await writeFile(
      valuesPath,
      JSON.stringify({ dbPassword: fakeSecret("generic-password", "db") }),
    );
    await expect(
      postgresExtensionsStep(deps, makePlan({ extensions: ["vector"] }), {
        command: "opscrew provision",
        snapshot: { neverRan: async () => [] },
      }),
    ).rejects.toThrow(
      /db already has data.*can't add or remove extensions.*keep `extensions` as it was \(none\)/i,
    );

    // 3. Existing database created with ["vector"]: unchanged passes, adding or removing refused
    await writeFile(
      valuesPath,
      JSON.stringify({
        dbPassword: fakeSecret("generic-password", "db"),
        postgresExtensions: { db: ["vector"] },
      }),
    );
    await expect(
      postgresExtensionsStep(deps, makePlan({ extensions: ["vector"] }), {
        command: "opscrew provision",
        snapshot: { neverRan: async () => [] },
      }),
    ).resolves.toBeUndefined();

    await expect(
      postgresExtensionsStep(deps, makePlan({ extensions: ["vector", "pg_trgm"] }), {
        command: "opscrew provision",
        snapshot: { neverRan: async () => [] },
      }),
    ).rejects.toThrow(/db already has data.*keep `extensions` as it was \(vector\)/i);

    await expect(
      postgresExtensionsStep(deps, makePlan({ extensions: [] }), {
        command: "opscrew provision",
        snapshot: { neverRan: async () => [] },
      }),
    ).rejects.toThrow(/db already has data.*keep `extensions` as it was \(vector\)/i);

    // 4. Never-ran database -> change allowed
    await expect(
      postgresExtensionsStep(deps, makePlan({ extensions: ["vector", "pg_trgm"] }), {
        command: "opscrew provision",
        snapshot: { neverRan: async () => ["db"] },
      }),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!findExecutable("git"))("runProvision with PostgreSQL extensions (045)", () => {
  it("creates a new database with extensions and records them in generated_values.json", async () => {
    const s = await provisionProject(
      makePlan({ logins: "separate", extensions: ["vector", "pg_trgm"] }),
    );
    await runProvision(s.deps, { services: s.services });

    const written = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8")) as {
      dbPassword?: string;
      postgresExtensions?: Record<string, string[]>;
    };
    expect(written.dbPassword).toBeTruthy();
    expect(written.postgresExtensions).toEqual({ db: ["pg_trgm", "vector"] });
  });

  it("lets an unchanged existing database with extensions pass through runProvision", async () => {
    const s = await provisionProject(makePlan({ logins: "separate", extensions: ["vector"] }), {
      dbPassword: fakeSecret("generic-password", "db"),
      services: {
        db: {
          "owner-password": fakeSecret("generic-password", "owner"),
          "runtime-password": fakeSecret("generic-password", "runtime"),
        },
      },
      postgresExtensions: { db: ["vector"] },
    });
    await runProvision(s.deps, { services: s.services });

    const written = JSON.parse(await readFile(generatedValuesFile(s.deps), "utf8")) as {
      postgresExtensions?: Record<string, string[]>;
    };
    expect(written.postgresExtensions).toEqual({ db: ["vector"] });
  });

  it("refuses adding extensions to an existing database before anything is written or 047 switches", async () => {
    const kept = { dbPassword: fakeSecret("generic-password", "db") };
    // Also enables logins: separate so we verify 045 refuses BEFORE 047's switch approval/snapshot.
    const s = await provisionProject(
      makePlan({ logins: "separate", extensions: ["vector"] }),
      kept,
    );
    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(
      /db already has data.*can't add or remove extensions/i,
    );

    expect(await readFile(generatedValuesFile(s.deps), "utf8")).toBe(s.keptText);
    expect(s.github.secrets.size).toBe(0);
    expect(s.handler.requests.map((r: ApprovalRequest) => r.kind)).toEqual([]);
    expect(s.snapshotsTaken()).toBe(0);
  });

  it("refuses PostGIS on a hand-edited ARM serverType (cax11) before anything is written or 047 switches", async () => {
    const kept = { dbPassword: fakeSecret("generic-password", "db") };
    const s = await provisionProject(
      makePlan({
        provider: "hetzner",
        serverType: "cax11",
        logins: "separate",
        extensions: ["postgis"],
      }),
      kept,
    );
    await expect(runProvision(s.deps, { services: s.services })).rejects.toThrow(
      /postgis\/postgis.*cax11.*arm64/i,
    );

    expect(await readFile(generatedValuesFile(s.deps), "utf8")).toBe(s.keptText);
    expect(s.github.secrets.size).toBe(0);
    expect(s.handler.requests.map((r: ApprovalRequest) => r.kind)).toEqual([]);
    expect(s.snapshotsTaken()).toBe(0);
  });
});
