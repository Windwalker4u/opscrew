import { readFile } from "node:fs/promises";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { RemoteExec } from "@opscrew/contracts";
import { type Architecture, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { PhaseDeps } from "../context";
import { runDesign } from "../design/run";
import type { ServerQuestion } from "../interview/own-server";
import { readOwnServer, serverAddressesFile } from "../shared";
import { inspectOwnServerForDesign } from "../shared/own-server-design";
import {
  createdServerFacts,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  makeRequirements,
  ScriptedRunner,
  SERVER_IPV4,
  secondAppRecord,
  sharedServerProject,
  staticSpaFacts,
} from "../testing";
import { addEnvironment } from "./add";

const NOW = new Date("2026-11-19T12:00:00.000Z");
const STAGING = "staging-landing.example.com";

/** Cloudflare's IP ranges, as its public endpoint answers them. */
const cloudflareRanges: PhaseDeps["fetch"] = async (input) => {
  if (String(input) !== "https://api.cloudflare.com/client/v4/ips") {
    throw new Error(`Unexpected network call in a test: ${String(input)}`);
  }
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result: { ipv4_cidrs: ["173.245.48.0/20"], ipv6_cidrs: ["2400:cb00::/32"] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

/** The project's runner with a GitHub origin and no network: `git ls-remote` fails. */
function withGitHub(base: PhaseDeps["runner"]): ScriptedRunner {
  return new ScriptedRunner(async (command, args, options) => {
    if (command === "git" && args.includes("get-url")) {
      return { exitCode: 0, stdout: "https://github.com/example/landing.git\n", stderr: "" };
    }
    if (command === "git" && args.includes("ls-remote")) {
      return { exitCode: 128, stdout: "", stderr: "no network in tests" };
    }
    return base.run(command, args, options);
  });
}

/** The deploy login's shell on the fake server: every command it runs answers nothing. */
const shell = (connection: { host: string }): RemoteExec => ({
  host: connection.host,
  run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
});

/**
 * Prod of the static site `landing`, designed as a second app beside `shop` on its server, which
 * holds prod's record and `inventory`'s; and its staging environment's deps.
 */
async function prodBesideShop() {
  const project = await sharedServerProject();
  const prod = project.deps;
  prod.runner = withGitHub(prod.runner);
  prod.fetch = cloudflareRanges;
  prod.clock = { now: () => NOW };
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-11-19T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: staticSpaFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", prod.paths.files.architecture, architecture);
  const { region: _region, ...base } = makeRequirements();
  await writeArtifact("requirements", prod.paths.files.requirements, {
    ...base,
    // A second app's interview records no budget of its own: 0 (FR-3026).
    budgetMonthly: { amount: 0, currency: "EUR" },
    provider: "own",
    domain: "landing.example.com",
    dnsProvider: "cloudflare",
  });
  // Prod's record there, written by its provision.
  const landing = { ...secondAppRecord({ app: "landing" }), projectId: prod.paths.projectId };
  const server = new FakeHostServer(
    HostFactsSchema.parse(createdServerFacts([secondAppRecord(), landing])),
  );
  const services = { remote: shell, host: server };
  await runDesign(prod, { ownServer: await inspectOwnServerForDesign(prod, { services }) });
  const staging = await createTestPhaseDeps({
    root: prod.paths.root,
    env: prod.env,
    environment: "staging",
    runner: prod.runner,
    fetch: cloudflareRanges,
    clock: { now: () => NOW },
  });
  return { project, prod, staging, server, services };
}

describe("addEnvironment for a second app", () => {
  it("puts the environment on the same server by default, as one more app there", async () => {
    const { project, prod, staging, server, services } = await prodBesideShop();
    const result = await addEnvironment(staging, {
      answers: { provider: "own", domain: STAGING },
      ownServer: { services },
    });
    // Its own login there: the first app's address and prod's pinned key, its own deploy key.
    expect(await readOwnServer(staging.paths)).toEqual({
      host: SERVER_IPV4,
      port: 22,
      user: "deploy",
      agent: false,
      keyPath: staging.paths.files.deployKey,
      hostKey: ED25519_FINGERPRINT,
      shares: project.ref,
    });
    expect(staging.paths.files.deployKey).not.toBe(prod.paths.files.deployKey);
    const { plan, chosen } = result.design;
    expect(plan.app.name).toBe("landing-staging");
    expect(plan.target).toMatchObject({
      provider: "own",
      shares: { app: "shop", provider: "hetzner" },
    });
    expect(plan.dns).toMatchObject({ domain: STAGING, proxied: true });
    expect(chosen.cost.monthly.amount).toBe(0);
    // Beside the first app, prod and the other app: their memory is counted.
    expect(chosen.summary).toMatch(/"shop" \d+ MB, "inventory" 512 MB, "landing" 512 MB/);
    expect(server.applies).toEqual([]);
    const all = [
      staging.reporter.text(),
      JSON.stringify(staging.audit.entries),
      JSON.stringify((staging.runner as ScriptedRunner).calls),
      await readFile(staging.paths.files.plan, "utf8"),
      await readFile(staging.paths.files.requirements, "utf8"),
      await readFile(serverAddressesFile(staging.paths), "utf8"),
    ].join("\n");
    expect(all).not.toContain(project.firstKey);
    expect(staging.reporter.text()).not.toContain(SERVER_IPV4);
    expect(await readFile(staging.paths.files.plan, "utf8")).not.toContain(SERVER_IPV4);
  });

  it("offers the server prod shares first in a terminal, with prod's reference", async () => {
    const { project, staging } = await prodBesideShop();
    const rounds: ServerQuestion[][] = [];
    const stop = new Error("asked the first rounds");
    const added = addEnvironment(staging, {
      answers: { provider: "own", domain: STAGING },
      askServer: async (questions) => {
        rounds.push(questions);
        if (rounds.length === 1) return { "server.kind": questions[0]?.default };
        throw stop;
      },
    });
    await expect(added).rejects.toBe(stop);
    expect(rounds.map((round) => round.map((q) => q.id))).toEqual([
      ["server.kind"],
      ["server.shares"],
    ]);
    expect(rounds[0]?.[0]?.default).toBe("shares");
    expect(rounds[1]?.[0]?.default).toBe(project.ref.root);
  });
});
