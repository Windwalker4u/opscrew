import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HomeNetwork } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import {
  type Architecture,
  DeployPlanSchema,
  type ProjectFacts,
  type Requirements,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { environmentPaths } from "../environments/paths";
import { HOME_ADDRESS_LABEL } from "../home/network";
import { DNS_ELSEWHERE, ISP_TERMS, LARGE_MEDIA, updaterTokenReach } from "../home/texts";
import { type OwnServerAnswers, recordOwnServerAnswers } from "../interview";
import type { OwnServerFacts } from "../providers";
import { boundHostAdapter, readServerAddresses } from "../shared";
import {
  createTestPhaseDeps,
  FakeHostServer,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  makeRequirements,
  nextPostgresFacts,
  ownPlan,
  sharedPreviewTestPlan,
  staticSpaFacts,
  type TestPhaseDeps,
  unusedRemote,
} from "../testing";
import { designHome, piStorageWarning } from "./home";
import { type OwnServerDesignInput, runDesign } from "./run";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const PI: OwnServerFacts = {
  arch: "arm64",
  vcpus: 4,
  memoryGb: 8,
  diskFreeGb: 50,
  os: "Debian GNU/Linux 12 (bookworm)",
};

/** A server at home on Cloudflare's DNS, served as `serve` says. */
function homeAnswers(
  serve: OwnServerAnswers["serve"] = "proxy",
  sshFrom?: string[],
): OwnServerAnswers {
  return {
    host: LAN_IPV4,
    port: 22,
    user: "pi",
    agent: true,
    home: sshFrom === undefined ? {} : { sshFrom },
    serve,
  };
}

const homeRequirements = (overrides: Partial<Requirements> = {}): Requirements => {
  const { region: _region, ...base } = makeRequirements();
  return {
    ...base,
    provider: "own",
    dnsProvider: "cloudflare",
    domain: "shop.example.com",
    ...overrides,
  };
};

interface SetupOptions {
  facts?: ProjectFacts;
  requirements?: Partial<Requirements>;
  answers?: OwnServerAnswers;
}

async function setup(o: SetupOptions = {}): Promise<TestPhaseDeps> {
  const deps = await createTestPhaseDeps({ clock: { now: () => NOW } });
  const architecture: Architecture = {
    schemaVersion: 1,
    generatedAt: "2026-11-19T10:00:00.000Z",
    generator: { tool: "opscrew", version: "0.0.0-test" },
    facts: o.facts ?? staticSpaFacts(),
    summary: "A test app.",
    risks: [],
    aiEnriched: false,
  };
  await writeArtifact("architecture", deps.paths.files.architecture, architecture);
  await writeArtifact(
    "requirements",
    deps.paths.files.requirements,
    homeRequirements(o.requirements),
  );
  await recordOwnServerAnswers(deps.paths, o.answers ?? homeAnswers());
  return deps;
}

/** The design input the caller gives after inspecting the server and reading its network. */
const inspected = (
  network: HomeNetwork = homeNetworkFacts(),
  extra: Partial<OwnServerDesignInput> = {},
): OwnServerDesignInput => ({ facts: PI, homeNetwork: network, ...extra });

/** Design again on the same project, as a later `opscrew design` does. */
async function again(deps: TestPhaseDeps): Promise<TestPhaseDeps> {
  return createTestPhaseDeps({ root: deps.paths.root, env: deps.env, clock: deps.clock });
}

async function refusal(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** A stop before anything was written: no plan, and the record as the interview left it. */
async function expectNothingWritten(deps: TestPhaseDeps, error: OpsCrewError): Promise<void> {
  expect(error.code).toBe("PHASE_PRECONDITION");
  expect(error.message).toMatch(/Nothing was changed\.$/);
  await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
  expect((await readServerAddresses(deps.paths)).own?.home?.network).toBeUndefined();
}

/** No IPv4 route at all, IPv6 as `ipv6` says. */
const noIpv4 = (ipv6: HomeNetwork["ipv6"] = { state: "present", stable: HOME_IPV6 }) =>
  homeNetworkFacts({ lan: undefined, ipv4: { route: false }, ipv6, hops: [] });

describe("design for a server at home", () => {
  it("serves over IPv4 behind the proxy when the server sees its public IPv4 address", async () => {
    const deps = await setup();
    const result = await runDesign(deps, { ownServer: inspected() });
    expect(result.plan.target).toEqual({
      provider: "own",
      mode: "vps-compose",
      arch: "arm64",
      access: "public",
      home: { ipv4: true },
      edge: "caddy",
    });
    expect(result.plan.dns).toMatchObject({ provider: "cloudflare", proxied: true });
    expect(result.plan.security.httpAllowedFrom).toBe("cloudflare");
    expect(result.plan.environment).toEqual({ deploySource: { from: "main" }, runner: "server" });
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(result.plan);

    expect(result.lines).toEqual(
      expect.arrayContaining([
        "OpsCrew found your home's public IPv4 address from your server. It isn't shown: behind Cloudflare's proxy no visitor sees it.",
        `On your router, forward TCP 80 and TCP 443 to ${LAN_IPV4}.`,
        `Reserve ${LAN_IPV4} for this server in the router's DHCP settings so it stays fixed.`,
        "Don't forward SSH: only 192.168.1.0/24 and fe80::/10 may reach it.",
        ISP_TERMS,
        LARGE_MEDIA,
        "  Permissions: Zone → DNS → Edit",
        "  Zone Resources: Include → Specific zone → example.com",
        "Then set OPSCREW_DNS_UPDATER_TOKEN to it and run `opscrew provision` again.",
        updaterTokenReach("example.com"),
      ]),
    );
    // Behind the proxy with IPv4 there is no AAAA record, so nothing opens IPv6 on the router.
    expect(result.lines.join("\n")).not.toMatch(/IPv6 firewall/);
    expect(deps.reporter.text()).toContain(`info: On your router, forward TCP 80 and TCP 443`);

    // The record: SSH's sources (design's default, written once) and the network, no address.
    const own = (await readServerAddresses(deps.paths)).own;
    expect(own?.home).toEqual({
      sshFrom: ["192.168.1.0/24", "fe80::/10"],
      network: {
        detectedAt: NOW.toISOString(),
        lan: {
          address: LAN_IPV4,
          network: "192.168.1.0/24",
          interface: "eth0",
          gateway: "192.168.1.1",
        },
        ipv4: "seen",
        noNat: false,
        ipv6: "present",
      },
    });
  });

  it("prints a DNS-only app's address, with the AAAA and the router's IPv6 rule", async () => {
    const deps = await setup({ answers: homeAnswers("dns-only") });
    const result = await runDesign(deps, { ownServer: inspected() });
    expect(result.plan.target).toMatchObject({ access: "public", home: { ipv4: true } });
    expect(result.plan.dns).toMatchObject({ provider: "cloudflare", proxied: false });
    expect(result.plan.security.httpAllowedFrom).toBe("any");
    expect(result.lines).toEqual(
      expect.arrayContaining([
        `Your home's public address is ${HOME_IPV4} and ${HOME_IPV6}: the site's DNS records point there, so anyone can look it up.`,
        "Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.",
        ISP_TERMS,
      ]),
    );
    // Large media is about Cloudflare's proxy, which a DNS-only app doesn't go through.
    expect(result.lines).not.toContain(LARGE_MEDIA);
    expect(deps.redactor.redact(HOME_IPV4)).toBe(HOME_IPV4);
  });

  it("warns of a carrier-grade NAT hop and goes on, offering the tunnel and IPv6 behind the proxy", async () => {
    const deps = await setup();
    const network = homeNetworkFacts({ hops: ["192.168.1.1", "100.64.0.1", "203.0.113.9"] });
    const result = await runDesign(deps, { ownServer: inspected(network) });
    expect(result.plan.target).toMatchObject({ home: { ipv4: true } });
    const text = result.lines.join("\n");
    expect(text).toContain(
      "! Your connection looks like it has no public IPv4 address: a router after yours has a carrier-grade NAT address (100.64.0.0/10).",
    );
    expect(text).toContain("answer server.serve tunnel");
    expect(text).toContain("set target.home.ipv4: false in opscrew/plan.yaml");
    // The kind of address, never the hop's.
    expect(text).not.toContain("100.64.0.1");
    expect((await readServerAddresses(deps.paths)).own?.home?.network).toMatchObject({
      ipv4: "seen",
      warning: "cgnat-hop",
    });
  });

  it("serves over IPv6 behind the proxy without an IPv4 route, with the tunnel as the alternative", async () => {
    const deps = await setup({ answers: homeAnswers("proxy", ["2001:db8:1:2::/64"]) });
    const result = await runDesign(deps, { ownServer: inspected(noIpv4()) });
    expect(result.plan.target).toMatchObject({ access: "public", home: { ipv4: false } });
    expect(result.plan.dns).toMatchObject({ proxied: true });
    expect(result.lines).toEqual(
      expect.arrayContaining([
        "Your server has no IPv4 connection to the internet, but it has IPv6: OpsCrew serves the site over IPv6 behind Cloudflare's proxy (target.home.ipv4: false), and Cloudflare still answers visitors over IPv4. A Cloudflare Tunnel works on any connection too (answer server.serve tunnel).",
        "Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.",
      ]),
    );
    // Without IPv4 there are no forwards to set.
    expect(result.lines.join("\n")).not.toMatch(/forward TCP/);
    expect((await readServerAddresses(deps.paths)).own?.home).toMatchObject({
      sshFrom: ["2001:db8:1:2::/64"],
      network: { ipv4: "none", noNat: false, ipv6: "present" },
    });
  });

  it("stops with DNS only over IPv6 alone, unless the plan accepts it with ipv4: false", async () => {
    const answers = homeAnswers("dns-only", ["2001:db8:1:2::/64"]);
    const deps = await setup({ answers });
    const error = await refusal(runDesign(deps, { ownServer: inspected(noIpv4()) }));
    expect(error.message).toBe(
      "Your server at home has no IPv4 connection to the internet, only IPv6, so with DNS only visitors without IPv6 couldn't reach the site. Nothing was changed.",
    );
    expect(error.hint).toContain("answer server.serve proxy");
    expect(error.hint).toContain("set target.home.ipv4: false in opscrew/plan.yaml");
    await expectNothingWritten(deps, error);

    // Designed behind the proxy first, then DNS only: the plan's ipv4: false is the acceptance.
    await recordOwnServerAnswers(deps.paths, homeAnswers("proxy", ["2001:db8:1:2::/64"]));
    await runDesign(await again(deps), { ownServer: inspected(noIpv4()) });
    await recordOwnServerAnswers(deps.paths, answers);
    const later = await again(deps);
    const accepted = await runDesign(later, { ownServer: inspected(noIpv4()) });
    expect(accepted.plan.target).toMatchObject({ home: { ipv4: false } });
    expect(accepted.plan.dns).toMatchObject({ proxied: false });
    expect(accepted.lines).toContain(
      `opscrew/plan.yaml says target.home.ipv4: false, so the site is served over IPv6 only, at ${HOME_IPV6}: visitors without IPv6 can't reach it.`,
    );
  });

  it("stops without IPv4 and IPv6: use the tunnel", async () => {
    for (const ipv6 of [{ state: "absent" }, { state: "unknown" }] as const) {
      const deps = await setup({ answers: homeAnswers("proxy", ["192.168.1.0/24"]) });
      const error = await refusal(runDesign(deps, { ownServer: inspected(noIpv4(ipv6)) }));
      expect(error.message).toBe(
        "Your server at home has no IPv4 connection to the internet and no IPv6 address, so visitors couldn't reach it at your home's address. Nothing was changed.",
      );
      expect(error.hint).toContain("answer server.serve tunnel");
      await expectNothingWritten(deps, error);
    }
  });

  it("stops when the server can't see its public address: check its outbound HTTPS", async () => {
    for (const ipv4 of [
      { route: true },
      { route: true, cloudflare: HOME_IPV4, aws: "198.51.100.8" },
    ]) {
      const deps = await setup();
      const error = await refusal(
        runDesign(deps, { ownServer: inspected(homeNetworkFacts({ ipv4 })) }),
      );
      expect(error.message).toBe(
        "Your server at home couldn't see its public IPv4 address: the two address checks over HTTPS didn't answer, or gave different addresses. Nothing was changed.",
      );
      expect(error.hint).toContain("outgoing HTTPS connections");
      await expectNothingWritten(deps, error);
    }
  });

  it("serves through the tunnel as today, without target.home or the network's reading", async () => {
    const deps = await setup({ answers: homeAnswers("tunnel") });
    const result = await runDesign(deps, { ownServer: inspected() });
    expect(result.plan.target).toMatchObject({ access: "tunnel" });
    expect(result.plan.target).not.toHaveProperty("home");
    expect(result.plan.environment).toBeUndefined();
    expect((await readServerAddresses(deps.paths)).own?.home).toEqual({});
  });

  it("keeps a user's home.ipv4: false even when the server sees IPv4", async () => {
    const deps = await setup();
    const first = await runDesign(deps, { ownServer: inspected() });
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({
        ...first.plan,
        target: { ...first.plan.target, home: { ipv4: false } },
      }),
    );
    const later = await again(deps);
    const result = await runDesign(later, { ownServer: inspected() });
    expect(result.plan.target).toMatchObject({ home: { ipv4: false } });
    expect(result.lines).toContain(
      "opscrew/plan.yaml says target.home.ipv4: false, so OpsCrew serves the site over IPv6 behind Cloudflare's proxy.",
    );
    expect(result.lines).toContain(
      "Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.",
    );
    // The carrier-NAT warning is about IPv4, which the site isn't served on then.
    const cgnat = homeNetworkFacts({ hops: ["192.168.1.1", "100.64.0.1"] });
    const quiet = await runDesign(await again(deps), { ownServer: inspected(cgnat) });
    expect(quiet.lines.join("\n")).not.toMatch(/no public IPv4 address/);

    // Without IPv6, nothing would serve the site: design stops.
    const error = await refusal(
      runDesign(await again(deps), {
        ownServer: inspected(homeNetworkFacts({ ipv6: { state: "absent" } })),
      }),
    );
    expect(error.message).toBe(
      "opscrew/plan.yaml says target.home.ipv4: false, so the site would be served over IPv6 only, but your server at home has no IPv6 address: visitors couldn't reach it. Nothing was changed.",
    );
  });

  it("stops when the server holds its public IPv4 address and server.sshFrom isn't answered", async () => {
    const noNat = homeNetworkFacts({
      lan: { address: HOME_IPV4, prefix: 24, interface: "eth0", gateway: "198.51.100.1" },
      ipv4: { route: true, cloudflare: HOME_IPV4, aws: HOME_IPV4, interface: HOME_IPV4 },
      hops: ["198.51.100.1"],
    });
    const deps = await setup();
    const error = await refusal(runDesign(deps, { ownServer: inspected(noNat) }));
    expect(error.message).toBe(
      "Your server at home has its public IPv4 address itself, so there is no home network OpsCrew can keep SSH to. Nothing was changed.",
    );
    expect(error.hint).toContain("server.sshFrom");
    await expectNothingWritten(deps, error);

    // Answered: no forwards are needed, and the record keeps no LAN (its address is public).
    await recordOwnServerAnswers(deps.paths, homeAnswers("proxy", ["203.0.113.0/24"]));
    const result = await runDesign(await again(deps), { ownServer: inspected(noNat) });
    expect(result.plan.target).toMatchObject({ home: { ipv4: true } });
    expect(result.lines).toContain(
      "Your server has its public IPv4 address itself, so your router needs no forwards.",
    );
    expect((await readServerAddresses(deps.paths)).own?.home).toEqual({
      sshFrom: ["203.0.113.0/24"],
      network: { detectedAt: NOW.toISOString(), ipv4: "seen", noNat: true, ipv6: "present" },
    });
  });

  it("keeps a runner machine the plan names, and puts the deploys on the server's runner otherwise", async () => {
    const deps = await setup();
    const first = await runDesign(deps, { ownServer: inspected() });
    const host = { runner: "host", runnerHost: { name: "laptop", arch: "arm64" } } as const;
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({
        ...first.plan,
        environment: { ...first.plan.environment, ...host },
      }),
    );
    const kept = await runDesign(await again(deps), { ownServer: inspected() });
    expect(kept.plan.environment).toMatchObject(host);

    // GitHub's machines can't reach a server at home: a plan saying github is moved to the server.
    const { target } = first.plan;
    if (target.provider !== "own") throw new Error("not own");
    const { home: _home, ...away } = target;
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({ ...first.plan, target: away, environment: { runner: "github" } }),
    );
    const moved = await runDesign(await again(deps), { ownServer: inspected() });
    expect(moved.plan.environment).toMatchObject({ runner: "server" });
  });

  it("says that only a fixed address keeps working with DNS elsewhere, without the token", async () => {
    const deps = await setup({ requirements: { dnsProvider: "none" }, answers: homeAnswers() });
    const result = await runDesign(deps, { ownServer: inspected() });
    expect(result.plan.dns).toMatchObject({ provider: "none", domain: "shop.example.com" });
    expect(result.plan.target).toMatchObject({ home: { ipv4: true } });
    expect(result.lines).toContain(DNS_ELSEWHERE);
    expect(result.lines.join("\n")).not.toMatch(/Zone → DNS → Edit|OPSCREW_DNS_UPDATER_TOKEN/);
  });

  it("refuses a plan that can't go with a server at home, before writing anything", async () => {
    const deps = await setup({ requirements: { domain: undefined, dnsProvider: "none" } });
    const error = await refusal(runDesign(deps, { ownServer: inspected() }));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toMatch(
      /^OpsCrew can't serve this app from your server at home: dns\.domain /,
    );
    expect(error.message).toMatch(/Nothing was changed\.$/);
    await expect(readFile(deps.paths.files.plan, "utf8")).rejects.toThrow();
  });

  it("needs the caller's reading of the network", async () => {
    const deps = await setup();
    await expect(runDesign(deps, { ownServer: { facts: PI } })).rejects.toThrow(
      /needs what detectHomeNetwork read/,
    );
  });

  it("refuses while a preview environment runs, or is set up to run, on this environment's server (M5)", async () => {
    const prod = await createTestPhaseDeps({ clock: { now: () => NOW } });
    await writeArtifact("plan", prod.paths.files.plan, ownPlan());
    const previews = environmentPaths(prod.paths, "preview").files.plan;
    await writeArtifact("plan", previews, sharedPreviewTestPlan());
    const dev = await createTestPhaseDeps({
      root: prod.paths.root,
      env: prod.env,
      environment: "dev",
    });
    await recordOwnServerAnswers(dev.paths, homeAnswers());
    const designDev = () =>
      refusal(
        designHome(dev, {
          serving: "proxy",
          network: homeNetworkFacts(),
          previous: undefined,
          requirements: homeRequirements(),
        }),
      );
    const running = await designDev();
    expect(running.message).toBe(
      "The previews of the preview environment run on dev's server, and serving it at home would break them. Nothing was changed.",
    );
    expect(running.hint).toContain("`opscrew destroy --env preview`");

    // Not provisioned yet: the environment that names the server goes first.
    await writeArtifact(
      "plan",
      previews,
      DeployPlanSchema.parse({ ...sharedPreviewTestPlan(), deployment: {} }),
    );
    const named = await designDev();
    expect(named.message).toBe(
      "The previews of the preview environment are set up to run on dev's server, and serving it at home would break them. Nothing was changed.",
    );
    expect(named.hint).toBe(
      "Remove that environment first with `opscrew env remove preview`, then run `opscrew design --env dev` again.",
    );
    expect((await readServerAddresses(dev.paths)).own?.home?.network).toBeUndefined();
  });
});

describe("the Raspberry Pi warning", () => {
  const sd = { source: "/dev/mmcblk0p2", disk: "mmcblk0", kind: "sd" } as const;
  const ssd = { source: "/dev/nvme0n1p2", disk: "nvme0n1", kind: "other" } as const;
  const board = "Raspberry Pi 5 Model B Rev 1.0";

  it("warns of a database on an SD card, recommends an SSD, and never refuses", async () => {
    const deps = await setup({ facts: nextPostgresFacts() });
    const result = await runDesign(deps, {
      ownServer: inspected(homeNetworkFacts(), { board, storage: { srv: sd, docker: sd } }),
    });
    expect(result.warnings).toContain(
      "Your server is a Raspberry Pi whose data is on an SD card (/dev/mmcblk0p2), and the app keeps db there. SD cards wear out under a database's writes and can fail without warning, taking the data with them: move the data to a USB or NVMe SSD (boot from it, or mount it at /srv and Docker's data root) before you deploy.",
    );
    expect(await readArtifact("plan", deps.paths.files.plan)).toEqual(result.plan);
  });

  it("warns of a memory card it can't tell from eMMC, and stays quiet otherwise", () => {
    const plan = ownPlan();
    const unknown = { ...sd, kind: "mmc-unknown" } as const;
    expect(piStorageWarning({ board, storage: { srv: ssd, docker: unknown } }, plan)).toContain(
      "on a memory card (an SD card or eMMC: OpsCrew can't tell which) (/dev/mmcblk0p2)",
    );
    // On an SSD, on another board, with no data on the server, or without the facts: nothing.
    expect(piStorageWarning({ board, storage: { srv: ssd, docker: ssd } }, plan)).toBeUndefined();
    const sdCard = { srv: sd, docker: sd };
    expect(piStorageWarning({ board: "Radxa ROCK 5B", storage: sdCard }, plan)).toBeUndefined();
    expect(
      piStorageWarning({ board, storage: sdCard }, ownPlan({ postgres: false })),
    ).toBeUndefined();
    expect(piStorageWarning({}, plan)).toBeUndefined();
  });
});

/** Every file under `dir`, as text. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
}

describe("a proxied app's home address", () => {
  it("is never printed or persisted, in any output or file, and is hidden by the redactor", async () => {
    const deps = await setup({ facts: nextPostgresFacts() });
    // The caller reads the network through the host adapter after inspecting the server.
    const server = new FakeHostServer(freshFacts({ arch: "arm64", user: "pi" }));
    server.homeNetwork = homeNetworkFacts({ hops: ["192.168.1.1", "100.64.0.1"] });
    const homeNetwork = await boundHostAdapter(server).detectHomeNetwork(unusedRemote(LAN_IPV4));
    expect(server.detections).toBe(1);
    const board = "Raspberry Pi 4 Model B Rev 1.5";
    const sd = { source: "/dev/mmcblk0p2", disk: "mmcblk0", kind: "sd" } as const;
    const result = await runDesign(deps, {
      ownServer: { facts: PI, homeNetwork, board, storage: { srv: sd, docker: sd } },
    });
    expect(result.plan.dns.proxied).toBe(true);
    expect(result.lines.join("\n")).toContain("It isn't shown");
    expect(result.warnings.join("\n")).toContain("Raspberry Pi");

    const seen = [
      deps.reporter.text(),
      JSON.stringify(result),
      JSON.stringify(deps.audit.entries),
      ...(await filesUnder(deps.paths.root)),
    ].join("\n");
    for (const address of [HOME_IPV4, HOME_IPV6]) {
      expect(seen).not.toContain(address);
      expect(deps.redactor.redact(`at ${address}`)).toBe(`at [REDACTED:${HOME_ADDRESS_LABEL}]`);
    }
  });
});
