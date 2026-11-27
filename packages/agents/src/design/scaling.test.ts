import { readFile, writeFile } from "node:fs/promises";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import {
  type Architecture,
  type DeployPlan,
  DeployPlanSchema,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  createTestPhaseDeps,
  euCatalog,
  FakeHostServer,
  freshFacts,
  makeRequirements,
  nextPostgresFacts,
  OWN_IPV4,
  ownRunner,
  type TestPhaseDeps,
  testKeyMaker,
  testPlan,
} from "../testing";
import { runDesign } from "./run";
import {
  copyLatencyWarnings,
  copyServerLimits,
  pgBouncerScaling,
  statelessReadinessWarnings,
} from "./scaling";

async function setup(
  facts: ProjectFacts = nextPostgresFacts(),
  requirements: Requirements = makeRequirements(),
  options: Parameters<typeof createTestPhaseDeps>[0] = {},
): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps(options);
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-10-11T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts,
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  return deps;
}

async function editPlan(
  deps: Pick<TestPhaseDeps, "paths">,
  edit: (raw: Record<string, unknown>) => void,
): Promise<void> {
  const file = deps.paths.files.plan;
  const raw = parse(await readFile(file, "utf8")) as Record<string, unknown>;
  edit(raw);
  await writeFile(file, stringify(raw));
}

function multiCopyPlan(overrides: Partial<DeployPlan> = {}): DeployPlan {
  const base = testPlan();
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, servers: ["web2"] },
    servers: [
      {
        name: "web2",
        target: {
          provider: "hetzner",
          mode: "vps-compose",
          location: "nbg1",
          serverType: "cx23",
          backups: true,
        },
      },
    ],
    network: {
      range: "10.200.4.0/24",
      members: [
        {
          name: "app",
          address: "10.200.4.1",
          port: 51820,
          publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        },
        {
          name: "web2",
          address: "10.200.4.2",
          port: 51820,
          publicKey: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA=",
        },
      ],
    },
    ...overrides,
  });
}

describe("copyServerLimits", () => {
  it("counts the web process plus app-proxy (32 MB) on a web copy server", () => {
    const plan = multiCopyPlan();
    expect(copyServerLimits(plan, "web2")).toEqual([
      { name: "the web process", memoryMb: 512 },
      { name: "app-proxy", memoryMb: 32 },
    ]);
    expect(copyServerLimits(plan, "app")).toEqual([]);
  });

  it("counts enabled placed workers multiplied by count and skips disabled workers", () => {
    const base = testPlan();
    const plan = multiCopyPlan({
      processes: {
        workers: [
          {
            name: "jobs",
            command: "node worker.js",
            source: "procfile",
            count: 2,
            single: false,
            stopGraceSeconds: 30,
            memoryMb: 256,
            enabled: true,
            servers: ["web2"],
          },
          {
            name: "disabled",
            command: "node disabled.js",
            source: "procfile",
            count: 1,
            single: false,
            stopGraceSeconds: 30,
            memoryMb: 512,
            enabled: false,
            servers: ["web2"],
          },
        ],
        cron: [],
      },
    });
    expect(copyServerLimits(plan, "web2")).toEqual([
      { name: "the web process", memoryMb: 512 },
      { name: "app-proxy", memoryMb: 32 },
      { name: "worker jobs (×2)", memoryMb: 512 },
    ]);
    expect(copyServerLimits({ app: base.app, processes: plan.processes }, "web2")).toEqual([
      { name: "worker jobs (×2)", memoryMb: 512 },
    ]);
  });
});

describe("statelessReadinessWarnings", () => {
  const issues: NonNullable<ProjectFacts["statelessIssues"]> = [
    {
      kind: "local-sessions",
      framework: "laravel",
      file: ".env.example",
      evidence: "SESSION_DRIVER=file stores sessions on local disk",
      remediation: "Set SESSION_DRIVER=redis or database.",
    },
    {
      kind: "local-uploads",
      framework: "express",
      file: "src/upload.ts",
      evidence: "multer.diskStorage() writes uploads to local disk",
      remediation: "Stream uploads to S3-compatible object storage.",
    },
  ];

  it("warns on each detected stateless issue when app.servers is non-empty", () => {
    const plan = multiCopyPlan();
    const warnings = statelessReadinessWarnings(plan, { statelessIssues: issues });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("local sessions");
    expect(warnings[0]).toContain("laravel");
    expect(warnings[0]).toContain(".env.example");
    expect(warnings[0]).toContain("SESSION_DRIVER=file");
    expect(warnings[0]).toContain("Set SESSION_DRIVER=redis");
    expect(warnings[0]).toContain("2 web servers");
    expect(warnings[1]).toContain("local file uploads");
    expect(warnings[1]).toContain("express");
    expect(warnings[1]).toContain("src/upload.ts");
    expect(warnings[1]).toContain("multer.diskStorage()");
  });

  it("stays silent on single-copy plans", () => {
    expect(statelessReadinessWarnings(testPlan(), { statelessIssues: issues })).toEqual([]);
  });
});

describe("pgBouncerScaling", () => {
  it("auto-enables pooler: pgbouncer with logins: separate on PG 15+ when webServers > 1", () => {
    const plan = multiCopyPlan();
    const result = pgBouncerScaling(plan, false);
    const db = result.plan.services.find((s) => s.kind === "postgres");
    expect(db?.kind === "postgres" && db.options.logins).toBe("separate");
    expect(db?.kind === "postgres" && db.options.pooler).toBe("pgbouncer");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toContain("PgBouncer");
    expect(result.lines[0]).toContain("max_connections");
    expect(result.warnings).toEqual([]);

    // Idempotent once enabled.
    const again = pgBouncerScaling(result.plan, false);
    expect(again.lines).toEqual([]);
    expect(again.warnings).toEqual([]);
  });

  it("warns without modifying plan on PostgreSQL < 15 or legacy deployed DB without logins: separate", () => {
    const pg14 = multiCopyPlan({
      services: testPlan().services.map((s) =>
        s.kind === "postgres" ? { ...s, version: "14", options: {} } : s,
      ),
    });
    const oldResult = pgBouncerScaling(pg14, false);
    const oldDb = oldResult.plan.services.find((s) => s.kind === "postgres");
    expect(oldDb?.kind === "postgres" && oldDb.options.pooler).toBeUndefined();
    expect(oldResult.warnings).toHaveLength(1);
    expect(oldResult.warnings[0]).toContain("version 14");
    expect(oldResult.warnings[0]).toContain("max_connections");

    const deployedLegacy = multiCopyPlan({
      services: testPlan().services.map((s) => (s.kind === "postgres" ? { ...s, options: {} } : s)),
    });
    const legacyResult = pgBouncerScaling(deployedLegacy, true);
    expect(legacyResult.warnings).toHaveLength(1);
    expect(legacyResult.warnings[0]).toContain("pooler: pgbouncer");
  });

  it("does nothing on single-server plans", () => {
    const result = pgBouncerScaling(testPlan(), false);
    expect(result.lines).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("copyLatencyWarnings", () => {
  it("stays silent when copy server and database share the same provider and region", () => {
    expect(copyLatencyWarnings(multiCopyPlan())).toEqual([]);
  });

  it("warns when a web copy runs in a different region on the same provider", () => {
    const plan = multiCopyPlan({
      servers: [
        {
          name: "web2",
          target: {
            provider: "hetzner",
            mode: "vps-compose",
            location: "hel1",
            serverType: "cx23",
            backups: true,
          },
        },
      ],
    });
    const warnings = copyLatencyWarnings(plan);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("web2");
    expect(warnings[0]).toContain("hel1");
    expect(warnings[0]).toContain("nbg1");
    expect(warnings[0]).toContain("different regions");
    expect(warnings[0]).toContain("WireGuard");
    expect(warnings[0]).toMatch(/about \d+ ms per round trip/);
  });

  it("warns when a web or worker copy runs on a different provider from the database", () => {
    const plan = multiCopyPlan({
      servers: [
        {
          name: "web2",
          target: {
            provider: "digitalocean",
            mode: "vps-compose",
            location: "fra1",
            serverType: "s-1vcpu-2gb",
            backups: true,
          },
        },
      ],
    });
    const warnings = copyLatencyWarnings(plan);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DigitalOcean (fra1)");
    expect(warnings[0]).toContain("Hetzner Cloud (nbg1)");
    expect(warnings[0]).toContain("different providers");
  });
});

describe("runDesign scaling integration", () => {
  it("preserves app.servers, worker servers, and scaling across re-designs, sizes copy servers, enables PgBouncer, and warns on statelessIssues", async () => {
    const facts: ProjectFacts = {
      ...nextPostgresFacts(),
      statelessIssues: [
        {
          kind: "local-sessions",
          framework: "express",
          file: "src/app.ts",
          evidence: "express-session uses in-memory MemoryStore by default",
          remediation: "Configure connect-redis or connect-pg-simple.",
        },
      ],
      workers: [
        {
          name: "jobs",
          command: "node worker.js",
          source: "procfile",
          single: false,
          evidence: ["Procfile"],
        },
      ],
    };
    const deps = await setup(
      facts,
      makeRequirements({ budgetMonthly: { amount: 100, currency: "EUR" } }),
    );
    const catalog = euCatalog();

    // First design: single server.
    await runDesign(deps, {
      catalog,
      keys: testKeyMaker(),
    });

    // User adds web2 + worker copy + scaling policy + large memory limit so sizing must pick 4 GB+ on web2.
    await editPlan(deps, (raw) => {
      const app = raw.app as Record<string, unknown>;
      app.memoryMb = 2048;
      app.servers = ["web2"];
      const processes = raw.processes as { workers: Record<string, unknown>[] };
      const firstWorker = processes.workers[0];
      if (firstWorker !== undefined) {
        firstWorker.memoryMb = 1024;
        firstWorker.servers = ["web2"];
      }
      raw.servers = [{ name: "web2" }];
      raw.scaling = { loadBalancer: { kind: "edge", policy: "least_conn" } };
    });

    const second = await runDesign(deps, {
      catalog,
      keys: testKeyMaker(),
    });

    expect(second.plan.app.servers).toEqual(["web2"]);
    expect(second.plan.processes.workers[0]?.servers).toEqual(["web2"]);
    expect(second.plan.scaling).toEqual({
      loadBalancer: { kind: "edge", policy: "least_conn" },
    });
    expect(second.plan.network?.members.map((m) => m.name)).toEqual(["app", "web2"]);

    // Sizing: web (2048) + app-proxy (32) + worker (1024) + system reserve (384) = 3488 MB -> needs > 4 GB headroom or 8 GB (cx23), not 4 GB cx13.
    const web2 = second.plan.servers?.find((s) => s.name === "web2");
    expect(web2?.target.provider).toBe("hetzner");
    if (web2?.target.provider === "hetzner") {
      expect(web2.target.serverType).toBe("cx23");
    }

    // PgBouncer enabled automatically on PostgreSQL.
    const db = second.plan.services.find((s) => s.kind === "postgres");
    expect(db?.kind === "postgres" && db.options.pooler).toBe("pgbouncer");
    expect(db?.kind === "postgres" && db.options.logins).toBe("separate");
    expect(second.lines.some((l) => l.includes("Enabled PgBouncer"))).toBe(true);

    // Stateless issue surfaced as a warning.
    expect(second.warnings.some((w) => w.includes("express-session"))).toBe(true);

    // Re-running design is idempotent and keeps all scaling fields.
    const third = await runDesign(deps, {
      catalog,
      keys: testKeyMaker(),
    });
    expect(third.plan.app.servers).toEqual(["web2"]);
    expect(third.plan.processes.workers[0]?.servers).toEqual(["web2"]);
    expect(third.plan.scaling).toEqual({
      loadBalancer: { kind: "edge", policy: "least_conn" },
    });
    const saved = await readArtifact("plan", deps.paths.files.plan);
    expect(saved.app.servers).toEqual(["web2"]);
    expect(saved.scaling).toEqual({ loadBalancer: { kind: "edge", policy: "least_conn" } });
  });

  it("sizes copy servers across mixed cloud providers and an own server, and warns on cross-provider DB latency", async () => {
    const facts: ProjectFacts = {
      ...nextPostgresFacts(),
      workers: [
        {
          name: "jobs",
          command: "node worker.js",
          source: "procfile",
          single: false,
          evidence: ["Procfile"],
        },
      ],
    };
    const deps = await setup(
      facts,
      makeRequirements({ budgetMonthly: { amount: 200, currency: "EUR" } }),
      { interactive: true, runner: ownRunner() },
    );
    const hetzner = euCatalog();

    await runDesign(deps, {
      catalog: hetzner,
      keys: testKeyMaker(),
    });

    await editPlan(deps, (raw) => {
      const app = raw.app as Record<string, unknown>;
      app.servers = ["web2"];
      const processes = raw.processes as { workers: Record<string, unknown>[] };
      const firstWorker = processes.workers[0];
      if (firstWorker !== undefined) {
        firstWorker.servers = ["w2"];
      }
      raw.servers = [
        { name: "web2", target: { provider: "digitalocean", location: "fra1" } },
        { name: "w2", target: { provider: "own" } },
      ];
    });

    const host = new FakeHostServer(HostFactsSchema.parse(freshFacts({ memoryGb: 4 })));
    const result = await runDesign(deps, {
      catalog: hetzner,
      keys: testKeyMaker(),
      askServerLogin: async () => ({
        "server.host": OWN_IPV4,
        "server.port": "22",
        "server.user": "root",
        "server.key": "agent",
      }),
      extraServers: { host },
    });

    const web2 = result.plan.servers?.find((s) => s.name === "web2");
    expect(web2?.target.provider).toBe("digitalocean");
    const w2 = result.plan.servers?.find((s) => s.name === "w2");
    expect(w2?.target.provider).toBe("own");

    // Cross-provider DB latency warnings for both DigitalOcean web2 and own server w2.
    expect(
      result.warnings.some(
        (w) =>
          w.includes("web2") &&
          w.includes("DigitalOcean (fra1)") &&
          w.includes("different providers"),
      ),
    ).toBe(true);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("w2") && w.includes("your own server") && w.includes("different providers"),
      ),
    ).toBe(true);
  });

  it("refuses app.servers when local SQLite storage is configured without overwriting plan.yaml", async () => {
    const facts: ProjectFacts = {
      ...nextPostgresFacts(),
      services: [],
      sqlite: { dir: "data", paths: ["data/app.db"] },
    };
    const deps = await setup(facts);
    const catalog = euCatalog();

    await runDesign(deps, {
      catalog,
      keys: testKeyMaker(),
    });
    const before = await readFile(deps.paths.files.plan, "utf8");

    await editPlan(deps, (raw) => {
      const app = raw.app as Record<string, unknown>;
      app.servers = ["web2"];
      raw.servers = [{ name: "web2" }];
    });
    const edited = await readFile(deps.paths.files.plan, "utf8");

    const error = await runDesign(deps, {
      catalog,
      keys: testKeyMaker(),
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("INVALID_INPUT");
    expect((error as OpsCrewError).message).toContain("SQLite");
    expect(await readFile(deps.paths.files.plan, "utf8")).toBe(edited);
    expect(edited).not.toBe(before);
  });
});
