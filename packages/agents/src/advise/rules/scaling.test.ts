import {
  type Architecture,
  type DeployPlan,
  DeployPlanSchema,
  type ProjectFacts,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { figuresOutput, nextPostgresFacts, offer, portainerPlan, testPlan } from "../../testing";
import { sitePlan } from "../../testing/serverless";
import { deployed, FakeAdviseGitHub, scenario } from "../__fixtures__/environment";
import { runAdvise } from "../run";
import { type PriceList, ProposalSchema } from "../types";
import {
  hetznerTable,
  history,
  MB,
  onThisComputer,
  reading,
  readingsOf,
  server,
  texts,
  validated,
  withServerType,
} from "./__fixtures__/rule-readings";
import { scalingRules } from "./scaling";
import { sizeRules } from "./size";

const plan = testPlan({ deployed: true });
const runScaling = validated(scalingRules);

describe("scalingRules", () => {
  it("proposes adding a second web server when sustained CPU load is high and the app is stateless-ready", async () => {
    const prices = [await hetznerTable()];
    const app = server(reading({ cpus: 2 }), history({ loadOverCpus: 0.35 }));
    const proposals = runScaling(readingsOf(plan, { servers: { app }, prices }));

    expect(proposals).toHaveLength(1);
    const [proposal] = proposals;
    expect(proposal).toMatchObject({
      id: "size.app.scale-out",
      category: "size",
      urgency: "when-convenient",
      server: "app",
      apply: { kind: "manual" },
    });
    expect(ProposalSchema.parse(proposal)).toEqual(proposal);
    const why = texts(proposal);
    expect(why).toContain("15-minute load was above server app's 2 CPUs");
    expect(why).toContain("35% of the time");
    expect(why).toContain("app.servers");
    expect(why).toContain("PgBouncer");
  });

  it("proposes scaling out when web process hits its memory limit on a memory-constrained server", async () => {
    const prices = [await hetznerTable()];
    const app = server(
      reading({ cpus: 2 }),
      history({
        memoryP95: 0.91,
        containers: [{ service: "app", memoryMax: 505 * MB, limit: 512 * MB }],
      }),
    );
    const proposals = runScaling(readingsOf(plan, { servers: { app }, prices }));
    expect(proposals.map((p) => p.id)).toEqual(["size.app.scale-out"]);
    expect(texts(proposals[0])).toContain("web process reached its memory limit");
  });

  it("escalates to urgency soon when the single-server vertical ceiling is reached", async () => {
    const ceilingLine: PriceList = {
      provider: "hetzner",
      location: "nbg1",
      offers: [offer({ id: "cx23", vcpus: 2, memoryGb: 4, diskGb: 40, price: 5.5 })],
      extras: {
        ipv4Monthly: { amount: 0.5, currency: "EUR" },
        backupPercent: 20,
        pricesIncludeVat: false,
        source: "static",
        asOf: "2026-09-01T00:00:00.000Z",
      },
    };
    const app = server(reading({ cpus: 2, load15: 3.1 }));
    const proposals = runScaling(readingsOf(plan, { servers: { app }, prices: [ceilingLine] }));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      id: "size.app.scale-out",
      urgency: "soon",
    });
    expect(texts(proposals[0])).toContain("no larger server type is available");
  });

  it("surfaces concrete local-state blockers (SQLite, local files, statelessIssues) instead of recommending immediate scale-out", async () => {
    const prices = [await hetznerTable()];
    const statefulPlan: DeployPlan = DeployPlanSchema.parse({
      ...plan,
      deploy: { ...plan.deploy, strategy: "recreate" },
      storage: {
        sqlite: { dir: "data" },
        files: { dir: "uploads" },
      },
    });
    const facts: ProjectFacts = {
      ...nextPostgresFacts(),
      statelessIssues: [
        {
          kind: "local-sessions",
          framework: "laravel",
          file: ".env.example",
          evidence: "SESSION_DRIVER=file stores sessions locally",
          remediation: "Set SESSION_DRIVER=redis.",
        },
        {
          kind: "local-uploads",
          framework: "django",
          file: "settings.py",
          evidence: "MEDIA_ROOT uses local FileSystemStorage",
          remediation: "Configure django-storages with S3/R2.",
        },
      ],
    };
    const app = server(reading({ cpus: 2 }), history({ loadOverCpus: 0.4 }));
    const proposals = runScaling({
      ...readingsOf(statefulPlan, { servers: { app }, prices }),
      facts,
    });

    expect(proposals).toHaveLength(1);
    const [blocked] = proposals;
    expect(blocked).toMatchObject({
      id: "size.app.scale-out-blocked",
      category: "size",
      urgency: "when-convenient",
      server: "app",
    });
    const why = texts(blocked);
    expect(why).toContain("Local SQLite database (data)");
    expect(why).toContain("Local persistent files folder (uploads)");
    expect(why).toContain("laravel");
    expect(why).toContain("SESSION_DRIVER=file");
    expect(why).toContain("django");
    expect(why).toContain("MEDIA_ROOT");
  });

  it("stays silent when already multi-copy, under normal load, or on unsupported targets", async () => {
    const prices = [await hetznerTable()];
    const busy = server(reading({ cpus: 2 }), history({ loadOverCpus: 0.5 }));
    const quiet = server(reading({ cpus: 2 }), history({ loadOverCpus: 0.05 }));

    // Quiet single server.
    expect(runScaling(readingsOf(plan, { servers: { app: quiet }, prices }))).toEqual([]);

    // Already running multiple web servers.
    const multiCopy = DeployPlanSchema.parse({
      ...plan,
      app: { ...plan.app, servers: ["web2"] },
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
    });
    expect(runScaling(readingsOf(multiCopy, { servers: { app: busy }, prices }))).toEqual([]);

    // Serverless, Portainer, localhost.
    expect(runScaling(readingsOf(deployed(sitePlan()), { servers: {}, prices }))).toEqual([]);
    expect(
      runScaling(readingsOf(portainerPlan({ deployed: true }), { servers: { app: busy }, prices })),
    ).toEqual([]);
    expect(
      runScaling(readingsOf(onThisComputer(plan), { servers: { app: busy }, prices })),
    ).toEqual([]);
  });
});

describe("sizeRules copy-server shrink guard", () => {
  it("counts copy-server web memory limits so smallerRule never shrinks a copy server below what design sizes it for", () => {
    const line: PriceList = {
      provider: "hetzner",
      location: "nbg1",
      offers: [
        offer({ id: "big", vcpus: 4, memoryGb: 8, diskGb: 80, price: 20 }),
        offer({ id: "small", vcpus: 2, memoryGb: 4, diskGb: 80, price: 10 }),
      ],
      extras: {
        ipv4Monthly: { amount: 0.5, currency: "EUR" },
        backupPercent: 20,
        pricesIncludeVat: false,
        source: "static",
        asOf: "2026-09-01T00:00:00.000Z",
      },
    };
    const multi = DeployPlanSchema.parse({
      ...withServerType(plan, "big"),
      app: { ...plan.app, memoryMb: 4096, servers: ["web2"] },
      servers: [
        {
          name: "web2",
          target: {
            provider: "hetzner",
            mode: "vps-compose",
            location: "nbg1",
            serverType: "big",
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
    });
    const quiet = server(reading({ cpus: 4 }), history({ cpuP95: 0.1, memoryP95: 0.1 }));
    // web2 runs web (4096 MB) + app-proxy (32 MB) + system reserve (384 MB) = 4512 MB > 4096 MB (small).
    const proposals = validated(sizeRules)(
      readingsOf(multi, { servers: { web2: quiet }, prices: [line] }),
    );
    expect(proposals).toEqual([]);
  });
});

describe("runAdvise reads architecture.json statelessIssues", () => {
  it("loads statelessIssues from architecture.json when checking single-server ceiling pressure", async () => {
    const ceilingPlan = withServerType(plan, "ccx63");
    const s = await scenario({
      plan: ceilingPlan,
      host: {
        figures: figuresOutput("shop", {
          cpus: 48,
          load15: 60,
          memory: 0.5,
        }),
      },
      github: new FakeAdviseGitHub(),
    });
    const arch: Architecture = {
      schemaVersion: 1,
      generatedAt: "2026-10-11T10:00:00.000Z",
      generator: { tool: "opscrew", version: "0.0.0-test" },
      facts: {
        ...nextPostgresFacts(),
        statelessIssues: [
          {
            kind: "local-sessions",
            framework: "express",
            file: "src/server.ts",
            evidence: "express-session MemoryStore detected",
            remediation: "Use Redis session store.",
          },
        ],
      },
      summary: "Test app",
      risks: [],
      aiEnriched: false,
    };
    await writeArtifact("architecture", s.deps.paths.files.architecture, arch);

    const report = await runAdvise(s.deps, ceilingPlan, s.options);
    const blocked = report.proposals.find((p) => p.id === "size.app.scale-out-blocked");
    expect(blocked).toBeDefined();
    expect(blocked?.reasons.some((r) => r.text.includes("express-session MemoryStore"))).toBe(true);
  });
});
