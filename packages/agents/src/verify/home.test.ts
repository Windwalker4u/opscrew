/**
 * verify for a server at home (plan 13.): the outside check from GitHub's machines, the address
 * updater and the Raspberry Pi's power over SSH, a DNS-only app's records against the detected
 * address, hairpin NAT, and away from home. No request from this computer counts as the outside
 * check, and a proxied app's address is in no line, result, audit entry, file or request.
 */
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DnsUpdaterFact,
  type HomeNetwork,
  type HostFacts,
  HostFactsSchema,
} from "@opscrew/connector-ssh-host";
import type { CheckResult, CommandResult, FetchLike } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_RANGES,
  createTestPhaseDeps,
  ED25519,
  ED25519_FINGERPRINT,
  FakeHostServer,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  ownPlan,
  ScriptedRunner,
} from "../testing";
import { AWAY_FROM_HOME, dnsUpdaterCheck, hairpinWarnings, piPowerCheck } from "./home";
import type { DnsResolver, TlsConnect } from "./net";
import { runVerify } from "./run";

const NOW = "2026-11-20T10:06:00.000Z";
const RUN_URL = "https://github.com/acme/shop/actions/runs/77";
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];

const HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** `shop` on a server at home, deployed by the server's runner. */
function homePlan(
  o: { proxied?: boolean; elsewhere?: boolean; arch?: "amd64" | "arm64" } = {},
): DeployPlan {
  const proxied = !o.elsewhere && (o.proxied ?? true);
  const base = ownPlan({ proxied, ...(o.arch ? { arch: o.arch } : {}) });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: true } },
    dns: o.elsewhere
      ? { provider: "none", domain: "shop.example.com", proxied: false, www: false }
      : { ...base.dns, zone: "example.com" },
    security: { ...base.security, httpAllowedFrom: proxied ? "cloudflare" : "any" },
    environment: { runner: "server" },
    deployment: { lastApplyAt: "2026-11-20T09:00:00.000Z" },
  });
}

/** The updater's state after a good run at 10:04 that saw {@link HOME_IPV4}. */
function updaterState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: 1,
    lastRun: "2026-11-20T10:04:12Z",
    lastSuccess: "2026-11-20T10:04:12Z",
    seen: { ipv4: HOME_IPV4, ipv6: null },
    records: { ipv4: HOME_IPV4, ipv6: null },
    lastWrite: { at: "2026-11-20T09:12:40Z", changed: ["A"] },
    ...over,
  };
}

/** The updater of `shop` as inspection reads it. */
function updaterFact(state: unknown = updaterState(), proxied = true): DnsUpdaterFact {
  return {
    app: "shop",
    config: {
      schemaVersion: 1,
      app: "shop",
      zoneId: "0123456789abcdef0123456789abcdef",
      name: "shop.example.com",
      proxied,
      ipv4: true,
      ipv6: false,
    },
    configFile: { mode: "600", owner: "root" },
    token: { present: true, mode: "600", owner: "root", sha256: "0".repeat(64) },
    timer: { enabled: true, active: true },
    state,
  };
}

/** The server at home ({@link LAN_IPV4}), with `over` (board, power, updaters). */
function homeFacts(over: Partial<HostFacts> = {}): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    dnsUpdaters: [updaterFact()],
    ...over,
  });
}

interface World {
  /** This computer can't reach the site (hairpin NAT). */
  siteDown?: boolean;
  /** The outside check's job conclusions (default both `success`). */
  jobs?: { http?: string | null; https?: string | null };
  /** GitHub's answer to the dispatch, when not the run. */
  dispatchStatus?: number;
}

/** The site, and GitHub's API with the outside check; any request to an address fails the test. */
function fakeWorld(o: World = {}) {
  const requests: { method: string; url: string; body: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : "" });
    const parsed = new URL(url);
    if (/^[\d.]+$|^\[/.test(parsed.hostname)) throw new Error(`direct request to ${url}`);
    if (parsed.host === "api.github.com") {
      if (parsed.pathname.endsWith("/opscrew-outside-check.yml/dispatches")) {
        if (o.dispatchStatus !== undefined) {
          return Response.json({ message: "refused" }, { status: o.dispatchStatus });
        }
        return Response.json({ workflow_run_id: 77, html_url: RUN_URL });
      }
      if (parsed.pathname === "/repos/acme/shop/actions/runs/77") {
        return Response.json({
          id: 77,
          status: "completed",
          conclusion: o.jobs ? "failure" : "success",
          html_url: RUN_URL,
          head_sha: "abc123",
          created_at: NOW,
        });
      }
      if (parsed.pathname === "/repos/acme/shop/actions/runs/77/attempts/1/jobs") {
        return Response.json({
          jobs: [
            { name: "http", conclusion: o.jobs?.http ?? "success" },
            { name: "https", conclusion: o.jobs?.https ?? "success" },
          ],
        });
      }
      // The repository (its default branch) and the deploy workflow's runs, in one answer.
      return Response.json({
        default_branch: "main",
        private: true,
        workflow_runs: [
          {
            id: 42,
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/acme/shop/actions/runs/42",
            head_sha: "abc123",
            created_at: "2026-11-20T09:00:00Z",
          },
        ],
      });
    }
    if (o.siteDown) throw new Error("connect ETIMEDOUT");
    if (url.startsWith("http://shop.example.com")) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://shop.example.com${parsed.pathname}` },
      });
    }
    if (url === "https://shop.example.com/") {
      return new Response("<!doctype html><p>shop</p>", { headers: HEADERS });
    }
    if (url === "https://shop.example.com/api/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

/** DNS: Cloudflare's edge behind the proxy, else `addresses`. */
function resolverFor(addresses: { a: string[]; aaaa: string[] }): DnsResolver {
  return { resolve4: async () => addresses.a, resolve6: async () => addresses.aaaa };
}

const certFor =
  (o: { down?: boolean } = {}): TlsConnect =>
  async (host) => {
    if (/^[\d.]+$/.test(host)) throw new Error(`direct TLS to ${host}`);
    if (o.down) throw new Error("connect ETIMEDOUT");
    return {
      subjectCommonName: "shop.example.com",
      subjectAltNames: ["shop.example.com"],
      validFrom: "2026-10-20T00:00:00.000Z",
      validTo: "2027-01-18T00:00:00.000Z",
      issuer: "Let's Encrypt",
    };
  };

interface Setup extends World {
  plan?: DeployPlan;
  facts?: HostFacts;
  network?: HomeNetwork;
  /** SSH doesn't answer: this computer isn't on the home network. */
  away?: boolean;
  dns?: { a: string[]; aaaa: string[] };
}

async function setup(o: Setup = {}) {
  const plan = o.plan ?? homePlan();
  const root = await mkdtemp(join(tmpdir(), "opscrew-verify-home-"));
  const ssh: string[][] = [];
  const runner = new ScriptedRunner((command, args): CommandResult => {
    if (command === "git" && args.includes("get-url")) {
      return { exitCode: 0, stdout: "https://github.com/acme/shop.git\n", stderr: "" };
    }
    if (command === "ssh-keyscan") {
      // Away from home the server's firewall drops this computer's SSH: no key comes back.
      return o.away
        ? { exitCode: 1, stdout: "", stderr: "" }
        : { exitCode: 0, stdout: `${LAN_IPV4} ssh-ed25519 ${ED25519}\n`, stderr: "" };
    }
    if (command === "ssh") {
      ssh.push([...args]);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: "unexpected command" };
  });
  const deps = await createTestPhaseDeps({
    root,
    env: { OPSCREW_HOME: join(root, ".home-opscrew"), GITHUB_TOKEN: "test-token-not-secret" },
    runner,
    clock: { now: () => new Date(NOW) },
  });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  const proxied = plan.dns.provider === "cloudflare" && plan.dns.proxied;
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    hostKey: ED25519_FINGERPRINT,
    serve: proxied ? "proxy" : "dns-only",
    home: {
      sshFrom: SSH_FROM,
      network: {
        detectedAt: "2026-11-20T08:00:00.000Z",
        lan: {
          address: LAN_IPV4,
          network: "192.168.1.0/24",
          interface: "eth0",
          gateway: "192.168.1.1",
        },
        ipv4: "seen",
        noNat: false,
        ipv6: "absent",
      },
    },
  });
  const host = new FakeHostServer(o.facts ?? homeFacts());
  host.homeNetwork = o.network ?? homeNetworkFacts();
  const world = fakeWorld(o);
  const dns =
    o.dns ?? (proxied ? { a: [CLOUDFLARE_IPV4], aaaa: [] } : { a: [HOME_IPV4], aaaa: [] });
  const probes: string[] = [];
  const verify = () =>
    runVerify(deps, {
      fetch: world.fetch,
      resolver: resolverFor(dns),
      tlsConnect: certFor({ down: o.siteDown ?? false }),
      tcpConnect: async (address, port) => {
        probes.push(`${address}:${port}`);
        throw new Error(`a probe from this computer: ${address}:${port}`);
      },
      cloudflareRanges: CLOUDFLARE_RANGES,
      own: { host, homeDir: root },
    });
  return { deps, host, world, verify, probes, ssh, root };
}

const byId = (checks: readonly CheckResult[], id: string): CheckResult => {
  const found = checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

/** Every file under `dir` but Git's, with its text. */
async function filesUnder(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })) as string[];
  const texts = await Promise.all(
    names
      .filter((name) => !name.split(/[\\/]/).includes(".git"))
      .map((name) => readFile(join(dir, name), "utf8").catch(() => "")),
  );
  return texts.join("\n");
}

describe("runVerify on a server at home", () => {
  it("behind the proxy: checks from outside on GitHub, reads the updater, and shows no home address", async () => {
    const s = await setup();
    const result = await s.verify();

    expect(result.passed).toBe(true);
    const outside = byId(result.checks, "outside-check");
    expect(outside.status).toBe("pass");
    expect(outside.message).toContain("Port 443 answered from outside your home");
    expect(outside.message).toContain("Cloudflare answered on port 80.");
    expect(byId(result.checks, "dns-updater")).toMatchObject({ status: "pass" });
    expect(byId(result.checks, "dns-updater").message).toContain("2026-11-20 10:04 UTC");
    // Not a Raspberry Pi: no power check.
    expect(result.checks.some((check) => check.id === "pi-power")).toBe(false);

    // The dispatch names the hostname, the health path and the mode, never an address.
    const dispatch = s.world.requests.find((r) => r.url.endsWith("/dispatches"));
    expect(JSON.parse(dispatch?.body ?? "{}")).toMatchObject({
      ref: "main",
      inputs: { host: "shop.example.com", path: "/api/health", mode: "proxied" },
    });
    expect(s.deps.audit.entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining([
        "inspect host (read-only)",
        "dispatch workflow",
        "outside check result",
      ]),
    );
    // The result is kept locally.
    const record = JSON.parse(await readFile(join(s.root, ".opscrew", "server.json"), "utf8"));
    expect(record.own.home.outsideCheck).toMatchObject({
      http: "ok",
      https: "ok",
      runUrl: RUN_URL,
    });
    // No request from this computer to the server or the home.
    expect(s.probes).toEqual([]);

    // The home's address, which the updater's state holds, is nowhere.
    const seen = [
      s.deps.reporter.text(),
      JSON.stringify(result),
      JSON.stringify(s.deps.audit.entries),
      JSON.stringify(s.world.requests),
      await filesUnder(s.root),
    ].join("\n");
    expect(seen).not.toContain(HOME_IPV4);
    expect(seen).not.toContain(HOME_IPV6);
  });

  it("fails when port 443 doesn't answer from outside, naming the forwards and the LAN address", async () => {
    const s = await setup({ jobs: { https: "failure" } });
    const result = await s.verify();

    expect(result.passed).toBe(false);
    const outside = byId(result.checks, "outside-check");
    expect(outside.status).toBe("fail");
    expect(outside.message).toContain("Port 443 didn't answer from outside your home.");
    expect(outside.message).toContain(`forward TCP 80 and TCP 443 to ${LAN_IPV4}`);
    expect(outside.message).toContain("Cloudflare Tunnel");
    expect(outside.message).toContain(RUN_URL);
    // The router line is shown as it is: the LAN address is not hidden as "your server".
    expect(s.deps.reporter.text()).toContain(`forward TCP 80 and TCP 443 to ${LAN_IPV4}`);
  });

  it("an outside check that didn't finish is a warning that says to run verify again", async () => {
    const s = await setup({ jobs: { http: "cancelled", https: "cancelled" } });
    const outside = byId((await s.verify()).checks, "outside-check");
    expect(outside.status).toBe("warn");
    expect(outside.message).toContain("didn't finish");
  });

  it("skips the outside check with GitHub's refusal when the workflow isn't merged yet", async () => {
    const s = await setup({ dispatchStatus: 404 });
    const outside = byId((await s.verify()).checks, "outside-check");
    expect(outside.status).toBe("skip");
    expect(outside.message).toContain("opscrew-outside-check.yml isn't on main yet");
    expect(outside.remediation).toContain("Merge the deploy-setup pull request first");
  });

  it("skips the outside check with GitHub's words when it refuses the token", async () => {
    const s = await setup({ dispatchStatus: 401 });
    const outside = byId((await s.verify()).checks, "outside-check");
    expect(outside.status).toBe("skip");
    expect(outside.message).toContain("GitHub");
  });

  it("away from home: the SSH checks are skipped, and the outside check still runs", async () => {
    const s = await setup({ away: true, plan: homePlan({ arch: "arm64" }) });
    const result = await s.verify();

    for (const id of ["dns-updater", "pi-power"]) {
      expect(byId(result.checks, id)).toMatchObject({ status: "skip" });
      expect(byId(result.checks, id).message).toContain(AWAY_FROM_HOME);
    }
    expect(byId(result.checks, "outside-check").status).toBe("pass");
    expect(s.host.inspections).toBe(0);
    expect(s.deps.reporter.text()).toContain(
      "Your server answers SSH only on your home network, so the updater's state and the power supply weren't checked",
    );
    expect(result.passed).toBe(true);
  });

  it("names the rotate step when Cloudflare refused the updater's token", async () => {
    const state = updaterState({
      lastSuccess: "2026-11-20T09:40:00Z",
      lastError: { at: "2026-11-20T10:04:12Z", code: "token-refused", http: 403, cloudflare: [] },
    });
    const s = await setup({ facts: homeFacts({ dnsUpdaters: [updaterFact(state)] }) });
    const check = byId((await s.verify()).checks, "dns-updater");
    expect(check.status).toBe("fail");
    expect(check.message).toContain("Cloudflare refused the updater's token");
    expect(check.remediation).toContain("`opscrew rotate dns-updater`");
    expect(check.remediation).toContain("https://dash.cloudflare.com/profile/api-tokens");
  });

  it("reports a Raspberry Pi's under-voltage now as a failure naming its supply", async () => {
    const s = await setup({
      facts: homeFacts({
        board: "Raspberry Pi 5 Model B Rev 1.0",
        power: { underVoltageNow: true, underVoltageSinceBoot: true, source: "vcgencmd" },
      }),
    });
    const result = await s.verify();
    const check = byId(result.checks, "pi-power");
    expect(check.status).toBe("fail");
    expect(check.remediation).toContain("5 V / 5 A");
    expect(result.passed).toBe(false);
  });
});

describe("runVerify on a DNS-only server at home", () => {
  const dnsOnly = homePlan({ proxied: false });

  it("compares the records with the address the server detects", async () => {
    const s = await setup({
      plan: dnsOnly,
      facts: homeFacts({ dnsUpdaters: [updaterFact(updaterState(), false)] }),
    });
    const result = await s.verify();
    expect(byId(result.checks, "dns-records")).toMatchObject({ status: "pass" });
    expect(s.host.detections).toBe(1);
    const dispatch = s.world.requests.find((r) => r.url.endsWith("/dispatches"));
    expect(JSON.parse(dispatch?.body ?? "{}").inputs.mode).toBe("direct");
    expect(result.passed).toBe(true);
  });

  it("fails when the records point somewhere else than the home", async () => {
    const s = await setup({ plan: dnsOnly, dns: { a: ["203.0.113.99"], aaaa: [] } });
    const check = byId((await s.verify()).checks, "dns-records");
    expect(check.status).toBe("fail");
    expect(check.message).toContain(HOME_IPV4);
  });

  it("with DNS elsewhere: no updater, and the records are compared with the detected address", async () => {
    const s = await setup({
      plan: homePlan({ elsewhere: true }),
      facts: homeFacts({ dnsUpdaters: [] }),
      dns: { a: ["203.0.113.99"], aaaa: [] },
    });
    const result = await s.verify();
    expect(result.checks.some((check) => check.id === "dns-updater")).toBe(false);
    const check = byId(result.checks, "dns-records");
    expect(check.status).toBe("fail");
    expect(check.remediation).toContain(
      `At your DNS provider, point shop.example.com at your home's address (${HOME_IPV4}`,
    );
  });

  it("this computer's failed site request is a warning while the outside check passes (hairpin)", async () => {
    const s = await setup({
      plan: dnsOnly,
      siteDown: true,
      facts: homeFacts({ dnsUpdaters: [updaterFact(updaterState(), false)] }),
    });
    const result = await s.verify();
    const site = byId(result.checks, "site-reachable");
    expect(site.status).toBe("warn");
    expect(site.message).toContain("hairpin NAT");
    expect(byId(result.checks, "health-endpoint").status).toBe("warn");
    expect(byId(result.checks, "outside-check").status).toBe("pass");
    expect(result.passed).toBe(true);
  });

  it("the failed site request stays a failure when the outside check failed too", async () => {
    const s = await setup({
      plan: dnsOnly,
      siteDown: true,
      jobs: { https: "failure" },
      facts: homeFacts({ dnsUpdaters: [updaterFact(updaterState(), false)] }),
    });
    const result = await s.verify();
    expect(byId(result.checks, "site-reachable").status).toBe("fail");
    expect(result.passed).toBe(false);
  });

  it("away from home: the records can't be compared, so the DNS check is skipped too", async () => {
    const s = await setup({ plan: dnsOnly, away: true });
    const result = await s.verify();
    expect(byId(result.checks, "dns-records")).toMatchObject({ status: "skip" });
    expect(byId(result.checks, "dns-records").message).toContain(AWAY_FROM_HOME);
    expect(byId(result.checks, "outside-check").status).toBe("pass");
  });
});

describe("dnsUpdaterCheck", () => {
  const plan = homePlan();
  const now = new Date(NOW);
  const check = (state: unknown) => dnsUpdaterCheck(plan, [updaterFact(state)], now, "");

  it("fails when the last success is older than 10 minutes", () => {
    const result = check(updaterState({ lastSuccess: "2026-11-20T09:55:00Z" }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("more than 10 minutes ago");
  });

  it("fails when the records don't hold what the server sees", () => {
    const result = check(updaterState({ records: { ipv4: "203.0.113.99", ipv6: null } }));
    expect(result.status).toBe("fail");
    expect(result.message).toContain("don't hold the address your server sees");
    expect(result.message).not.toContain(HOME_IPV4);
  });

  it("warns when a run failed since the last success", () => {
    const result = check(
      updaterState({
        lastSuccess: "2026-11-20T10:02:00Z",
        lastError: { at: "2026-11-20T10:04:12Z", code: "rate-limited", http: 429, cloudflare: [] },
      }),
    );
    expect(result.status).toBe("warn");
    expect(result.message).toContain("Cloudflare limited the requests");
  });

  it("an error before the last success is history", () => {
    const result = check(
      updaterState({ lastError: { at: "2026-11-19T22:00:02Z", code: "rate-limited" } }),
    );
    expect(result.status).toBe("pass");
  });

  it("fails without an updater for the app, or without a state", () => {
    expect(dnsUpdaterCheck(plan, [], now, "").status).toBe("fail");
    expect(check(null).status).toBe("fail");
  });
});

describe("piPowerCheck", () => {
  const pi4 = "Raspberry Pi 4 Model B Rev 1.5";

  it("warns about under-voltage since boot, naming a Pi 4's supply", () => {
    const result = piPowerCheck({
      board: pi4,
      power: { underVoltageNow: false, underVoltageSinceBoot: true, source: "kernel-log" },
    });
    expect(result?.status).toBe("warn");
    expect(result?.remediation).toContain("5 V / 3 A");
  });

  it("passes without under-voltage, and isn't there for another board", () => {
    const power = {
      underVoltageNow: false,
      underVoltageSinceBoot: false,
      source: "vcgencmd" as const,
    };
    expect(piPowerCheck({ board: pi4, power })?.status).toBe("pass");
    expect(piPowerCheck({ board: null, power })).toBeUndefined();
  });
});

describe("hairpinWarnings", () => {
  it("leaves other checks' failures alone", () => {
    const failed = (id: string): CheckResult => ({
      id,
      title: id,
      severity: "high",
      status: "fail",
      message: "failed.",
    });
    const result = hairpinWarnings([failed("site-reachable"), failed("deploy-run")]);
    expect(result.map((check) => check.status)).toEqual(["warn", "fail"]);
  });
});
