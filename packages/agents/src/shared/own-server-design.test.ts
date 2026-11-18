import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { HostFactsSchema } from "@opscrew/connector-ssh-host";
import { type Architecture, type Requirements, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { runDesign } from "../design";
import { type OwnServerAnswers, recordOwnServerAnswers } from "../interview";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  makeRequirements,
  nextPostgresFacts,
  OWN_IPV4,
  ownRunner,
  type ScriptedRunner,
  type TestPhaseDeps,
} from "../testing";
import { inspectOwnServerForDesign } from "./own-server-design";

const SD = { source: "/dev/mmcblk0p2", disk: "mmcblk0", kind: "sd" } as const;

/** A Raspberry Pi with its data on an SD card, as inspection reports it. */
const PI_FACTS = HostFactsSchema.parse({
  ...freshFacts({
    arch: "arm64",
    user: "pi",
    addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
  }),
  board: "Raspberry Pi 5 Model B Rev 1.0",
  storage: { srv: SD, docker: SD },
});

/** A project for a Postgres app on the user's own server, with the interview's `answers`. */
async function project(
  answers: OwnServerAnswers,
): Promise<{ deps: TestPhaseDeps; runner: ScriptedRunner }> {
  const runner = ownRunner();
  const deps = await createTestPhaseDeps({ runner });
  deps.env.HOME = join(deps.paths.root, "home");
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-11-19T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: nextPostgresFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  const { region: _region, ...base } = makeRequirements();
  const requirements: Requirements = {
    ...base,
    provider: "own",
    dnsProvider: "cloudflare",
    domain: "shop.example.com",
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact("requirements", deps.paths.files.requirements, requirements);
  await recordOwnServerAnswers(deps.paths, answers);
  return { deps, runner };
}

/** Every file under `dir`, as text. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
}

describe("inspectOwnServerForDesign for a server at home", () => {
  it("reads the home's network after inspection, so design serves from home and warns of the Pi's SD card", async () => {
    const { deps, runner } = await project({
      host: LAN_IPV4,
      port: 22,
      user: "pi",
      agent: true,
      home: {},
      serve: "proxy",
    });
    const server = new FakeHostServer(PI_FACTS);
    server.homeNetwork = homeNetworkFacts();
    const input = await inspectOwnServerForDesign(deps, {
      hostKey: ED25519_FINGERPRINT,
      services: { host: server },
    });
    expect(server.inspections).toBe(1);
    expect(server.detections).toBe(1);
    expect(input).toMatchObject({
      homeNetwork: homeNetworkFacts(),
      board: "Raspberry Pi 5 Model B Rev 1.0",
      storage: { srv: SD, docker: SD },
    });

    const result = await runDesign(deps, { ownServer: input });
    expect(result.plan.target).toMatchObject({ access: "public", home: { ipv4: true } });
    expect(result.plan.environment).toMatchObject({ runner: "server" });
    expect(result.warnings).toContainEqual(
      expect.stringContaining(
        "Your server is a Raspberry Pi whose data is on an SD card (/dev/mmcblk0p2), and the app keeps db there.",
      ),
    );
    expect(result.lines).toContain(`On your router, forward TCP 80 and TCP 443 to ${LAN_IPV4}.`);

    // A proxied app's address: in nothing the fakes saw, said or wrote.
    const seen = [
      deps.reporter.text(),
      JSON.stringify(result),
      JSON.stringify(deps.audit.entries),
      JSON.stringify(runner.calls),
      ...(await filesUnder(deps.paths.root)),
    ].join("\n");
    for (const address of [HOME_IPV4, HOME_IPV6]) expect(seen).not.toContain(address);
  });

  it("never reads the network of a server not at home", async () => {
    const { deps } = await project({
      host: OWN_IPV4,
      port: 22,
      user: "root",
      agent: true,
      reachable: true,
      serve: "proxy",
    });
    // Nothing is scripted: a call to detectHomeNetwork would throw.
    const server = new FakeHostServer(freshFacts());
    const input = await inspectOwnServerForDesign(deps, {
      hostKey: ED25519_FINGERPRINT,
      services: { host: server },
    });
    expect(server.inspections).toBe(1);
    expect(server.detections).toBe(0);
    expect(input).not.toHaveProperty("homeNetwork");

    const result = await runDesign(deps, { ownServer: input });
    expect(result.plan.target).toMatchObject({ access: "public" });
    expect(result.plan.target).not.toHaveProperty("home");
  });
});
