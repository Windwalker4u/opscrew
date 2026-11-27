// Feature 033 (Phase 1): manual web & worker copies across servers (`app.servers`,
// `processes.workers[].servers`, `scaling.loadBalancer`, and `ProjectFacts.statelessIssues`).
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  APP_SERVER,
  ArchitectureSchema,
  appCopyServers,
  DeployPlanSchema,
  hasRemoteAppCopies,
  parseArtifact,
  webServers,
  workerServers,
} from "./index";

const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, FIXTURES), "utf8");
const key = () => randomBytes(32).toString("base64");

async function basePlan() {
  return parseArtifact("plan", await fixture("plan.yaml"), "fixture");
}

function networkFor(extraServers: readonly string[]) {
  return {
    range: "10.200.4.0/24",
    members: [
      { name: APP_SERVER, address: "10.200.4.1", port: 51820, publicKey: key() },
      ...extraServers.map((name, i) => ({
        name,
        address: `10.200.4.${i + 2}`,
        port: 51820,
        publicKey: key(),
      })),
    ],
  };
}

describe("feature 033: scaling across servers (plan-schema)", () => {
  it("accepts web copies across mixed cloud providers and own servers with edge load balancing", async () => {
    const plan = await basePlan();
    const parsed = DeployPlanSchema.parse({
      ...plan,
      app: { ...plan.app, servers: ["web-2", "web-3"] },
      servers: [
        {
          name: "web-2",
          target: {
            provider: "digitalocean",
            mode: "vps-compose",
            location: "fra1",
            serverType: "s-2vcpu-4gb",
            backups: false,
          },
        },
        {
          name: "web-3",
          target: { provider: "own", mode: "vps-compose", arch: "amd64" },
        },
      ],
      scaling: { loadBalancer: { kind: "edge", policy: "least_conn" } },
      network: networkFor(["web-2", "web-3"]),
    });

    expect(webServers(parsed)).toEqual(["app", "web-2", "web-3"]);
    expect(appCopyServers(parsed)).toEqual(["web-2", "web-3"]);
    expect(hasRemoteAppCopies(parsed)).toBe(true);
    expect(parsed.scaling).toEqual({ loadBalancer: { kind: "edge", policy: "least_conn" } });
  });

  it("defaults scaling.loadBalancer.policy to round_robin", async () => {
    const plan = await basePlan();
    const parsed = DeployPlanSchema.parse({
      ...plan,
      app: { ...plan.app, servers: ["web-2"] },
      servers: [
        {
          name: "web-2",
          target: {
            provider: "hetzner",
            mode: "vps-compose",
            location: "nbg1",
            serverType: "cpx22",
            backups: false,
          },
        },
      ],
      scaling: { loadBalancer: { kind: "edge" } },
      network: networkFor(["web-2"]),
    });
    expect(parsed.scaling?.loadBalancer?.policy).toBe("round_robin");
  });

  it("accepts non-single worker copies on extra servers and refuses single-instance schedulers on extra servers", async () => {
    const plan = await basePlan();
    const extraServer = {
      name: "jobs",
      target: {
        provider: "hetzner" as const,
        mode: "vps-compose" as const,
        location: "nbg1",
        serverType: "cpx22",
        backups: false,
      },
    };
    const ok = DeployPlanSchema.parse({
      ...plan,
      servers: [extraServer],
      processes: {
        workers: [
          {
            name: "worker",
            command: "node worker.js",
            source: "procfile",
            count: 2,
            servers: ["jobs"],
          },
        ],
        cron: [],
      },
      network: networkFor(["jobs"]),
    });
    expect(webServers(ok)).toEqual(["app"]);
    const firstWorker = ok.processes.workers[0];
    expect(firstWorker).toBeDefined();
    if (firstWorker !== undefined) expect(workerServers(firstWorker)).toEqual(["app", "jobs"]);
    expect(appCopyServers(ok)).toEqual(["jobs"]);
    expect(hasRemoteAppCopies(ok)).toBe(true);

    const single = DeployPlanSchema.safeParse({
      ...plan,
      servers: [extraServer],
      processes: {
        workers: [
          {
            name: "scheduler",
            command: "celery -A app beat",
            source: "library",
            single: true,
            servers: ["jobs"],
          },
        ],
        cron: [],
      },
      network: networkFor(["jobs"]),
    });
    expect(single.success).toBe(false);
    if (!single.success) {
      expect(single.error.issues.some((i) => i.message.includes("single-instance scheduler"))).toBe(
        true,
      );
    }
  });

  it("refuses app.servers with storage.sqlite or storage.files", async () => {
    const plan = await basePlan();
    const withCopy = {
      ...plan,
      app: { ...plan.app, servers: ["web-2"] },
      servers: [
        {
          name: "web-2",
          target: {
            provider: "hetzner" as const,
            mode: "vps-compose" as const,
            location: "nbg1",
            serverType: "cpx22",
            backups: false,
          },
        },
      ],
      network: networkFor(["web-2"]),
    };

    const sqlite = DeployPlanSchema.safeParse({
      ...withCopy,
      storage: { sqlite: { dir: "data", mount: "/app/data" } },
    });
    expect(sqlite.success).toBe(false);
    if (!sqlite.success) {
      expect(sqlite.error.issues.some((i) => i.message.includes("storage.sqlite"))).toBe(true);
    }

    const files = DeployPlanSchema.safeParse({
      ...withCopy,
      storage: { files: { dir: "uploads", mount: "/app/uploads" } },
    });
    expect(files.success).toBe(false);
    if (!files.success) {
      expect(files.error.issues.some((i) => i.message.includes("storage.files"))).toBe(true);
    }
  });

  it("refuses unknown, duplicate, or monitoring servers in app.servers and worker.servers", async () => {
    const plan = await basePlan();
    const missing = DeployPlanSchema.safeParse({
      ...plan,
      app: { ...plan.app, servers: ["ghost"] },
    });
    expect(missing.success).toBe(false);
    if (!missing.success) {
      expect(
        missing.error.issues.some((i) =>
          i.message.includes('names no server of the plan: "ghost"'),
        ),
      ).toBe(true);
    }

    const dup = DeployPlanSchema.safeParse({
      ...plan,
      app: { ...plan.app, servers: ["web-2", "web-2"] },
      servers: [
        {
          name: "web-2",
          target: {
            provider: "hetzner" as const,
            mode: "vps-compose" as const,
            location: "nbg1",
            serverType: "cpx22",
            backups: false,
          },
        },
      ],
      network: networkFor(["web-2"]),
    });
    expect(dup.success).toBe(false);
    if (!dup.success) {
      expect(dup.error.issues.some((i) => i.message.includes("listed more than once"))).toBe(true);
    }
  });

  it("returns false for hasRemoteAppCopies on single-server plans", async () => {
    const plan = await basePlan();
    expect(webServers(plan)).toEqual(["app"]);
    expect(appCopyServers(plan)).toEqual([]);
    expect(hasRemoteAppCopies(plan)).toBe(false);
  });

  it("accepts ProjectFacts.statelessIssues in ArchitectureSchema", async () => {
    const raw = JSON.parse(await fixture("architecture.json")) as Record<string, unknown>;
    const facts = raw.facts as Record<string, unknown>;
    const parsed = ArchitectureSchema.parse({
      ...raw,
      facts: {
        ...facts,
        statelessIssues: [
          {
            kind: "local-sessions",
            framework: "laravel",
            evidence: "SESSION_DRIVER=file",
            file: ".env.example",
            remediation: "Set SESSION_DRIVER=redis (Valkey) or database before scaling out.",
          },
          {
            kind: "local-uploads",
            framework: "express",
            evidence: "multer diskStorage without S3 SDK",
            file: "src/uploads.ts",
            remediation: "Move uploads to S3-compatible object storage before scaling out.",
          },
        ],
      },
    });
    expect(parsed.facts.statelessIssues).toHaveLength(2);
  });
});
