/**
 * `opscrew secure` for a server at home (plan 13., research R11): the server-side checks through
 * the admin login (the SSH table and its sources, the web filter's families, the updater's token
 * file and timer, the power supply), and this computer's probes, which run from inside the home
 * network and so never fail. Nothing it shows or writes names the home's addresses.
 */
import { readFile } from "node:fs/promises";
import { type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import type { CheckResult, RemoteExec, Scanner } from "@opscrew/contracts";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import type { TcpConnect } from "@opscrew/secops";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared";
import type { OwnHome } from "../shared/server-record";
import {
  CF_V4,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  filteredFacts,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  LAN_IPV4,
  ownPlan,
  ownRunner,
} from "../testing";
import { fromInside, homeServerChecks, insideLabel, NOT_CHECKED_AWAY } from "./home";
import { runSecure } from "./run";

const NOW = "2026-11-20T12:00:00.000Z";
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];
const TABLE = [
  "table inet opscrew {",
  "chain input {",
  "type filter hook input priority filter; policy accept;",
  "ip saddr 192.168.1.0/24 tcp dport 22 accept",
  "ip6 saddr fe80::/10 tcp dport 22 accept",
  "tcp dport 22 drop",
  "}",
  "}",
  "",
].join("|");
const CHECK: NonNullable<OwnHome["outsideCheck"]> = {
  at: "2026-11-20T10:30:00Z",
  host: "shop.example.com",
  mode: "proxied",
  http: "ok",
  https: "ok",
  runUrl: "https://github.com/acme/shop/actions/runs/123",
};
const HOME: OwnHome = { sshFrom: SSH_FROM, outsideCheck: CHECK };

/** `shop` on a server at home, deployed; behind the proxy over IPv4 unless `ipv4` is false. */
function homePlan(o: { proxied?: boolean; ipv4?: boolean; dnsElsewhere?: boolean } = {}) {
  const proxied = o.proxied ?? true;
  const base = ownPlan({ proxied });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: o.ipv4 ?? true } },
    security: { ...base.security, httpAllowedFrom: proxied ? "cloudflare" : "any" },
    environment: { runner: "server" },
    ...(o.dnsElsewhere
      ? { dns: { provider: "none", domain: "shop.example.com", proxied: false } }
      : {}),
  });
}

type Updater = NonNullable<HostFacts["dnsUpdaters"]>[number];

/** A server at home as it should be: the SSH table, the web filter, the updater, no under-voltage. */
function homeFacts(
  o: Partial<Pick<HostFacts, "webFilter" | "power">> & {
    sshFirewall?: Partial<HostFacts["sshFirewall"]>;
    updater?: Partial<Updater> | null;
  } = {},
): HostFacts {
  const updater: Updater = {
    app: "shop",
    config: null,
    configFile: { mode: "600", owner: "root" },
    token: { present: true, mode: "600", owner: "root", sha256: "c".repeat(64) },
    timer: { enabled: true, active: true },
    state: {
      schemaVersion: 1,
      version: 1,
      lastRun: "2026-11-20T10:04:12Z",
      seen: { ipv4: HOME_IPV4, ipv6: HOME_IPV6 },
      records: { ipv4: HOME_IPV4, ipv6: HOME_IPV6 },
    },
    ...o.updater,
  };
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [
        { interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false },
        { interface: "eth0", family: "ipv6", address: HOME_IPV6, public: true },
      ],
    }),
    sshFirewall: {
      nft: true,
      table: TABLE,
      files: { rules: "a".repeat(64), unit: "b".repeat(64) },
      enabled: true,
      ...o.sshFirewall,
    },
    webFilter: o.webFilter ?? filteredFacts(CF_V4),
    power: o.power === undefined ? null : o.power,
    dnsUpdaters: o.updater === null ? [] : [updater],
  });
}

function find(checks: readonly CheckResult[], id: string): CheckResult {
  const check = checks.find((c) => c.id === id);
  if (!check) throw new Error(`no check ${id}`);
  return check;
}

describe("homeServerChecks", () => {
  it("passes a server at home as provision left it, behind the proxy over IPv4", () => {
    const checks = homeServerChecks(homePlan(), homeFacts(), HOME);
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ["home-ssh-table", "pass"],
      ["home-web-filter-ipv4", "pass"],
      ["dns-updater-token", "pass"],
      ["dns-updater-timer", "pass"],
    ]);
    // The committed report never gets a source, an address or the token's hash.
    const text = JSON.stringify(checks);
    for (const value of [...SSH_FROM, HOME_IPV4, HOME_IPV6, "c".repeat(64)]) {
      expect(text).not.toContain(value);
    }
  });

  it("fails without the SSH table, with other sources, without the drop, or a unit that's off", () => {
    const table = (sshFirewall: Partial<HostFacts["sshFirewall"]>) =>
      find(homeServerChecks(homePlan(), homeFacts({ sshFirewall }), HOME), "home-ssh-table");
    expect(table({ table: null })).toMatchObject({ status: "fail", severity: "high" });
    expect(table({ table: null }).message).toContain("isn't on your server");
    expect(table({ table: TABLE.replace("192.168.1.0/24", "192.168.2.0/24") }).message).toContain(
      "other sources than the ones recorded on this computer",
    );
    expect(table({ table: TABLE.replace("tcp dport 22 drop|", "") }).message).toContain(
      "doesn't drop SSH from other addresses",
    );
    expect(table({ enabled: false })).toMatchObject({ status: "fail", severity: "medium" });
    expect(table({ table: null }).remediation).toContain("`opscrew provision`");
  });

  it("checks each family of the web filter the site is served on, and none with DNS only", () => {
    const broken = {
      ...filteredFacts(CF_V4),
      rules4: { ...filteredFacts(CF_V4).rules4, chain: null },
    };
    expect(
      find(
        homeServerChecks(homePlan(), homeFacts({ webFilter: broken }), HOME),
        "home-web-filter-ipv4",
      ),
    ).toMatchObject({ status: "fail", severity: "high" });
    // Over IPv6 behind the proxy, the IPv6 table too.
    const ipv6 = homePlan({ ipv4: false });
    expect(find(homeServerChecks(ipv6, homeFacts(), HOME), "home-web-filter-ipv6").status).toBe(
      "fail",
    );
    const withTable = homeFacts({ webFilter: { ...filteredFacts(CF_V4), table6: "d".repeat(64) } });
    expect(find(homeServerChecks(ipv6, withTable, HOME), "home-web-filter-ipv6").status).toBe(
      "pass",
    );
    const direct = homeServerChecks(homePlan({ proxied: false }), homeFacts(), HOME);
    expect(direct.some((c) => c.id.startsWith("home-web-filter"))).toBe(false);
  });

  it("the token file must be root's with 0600, and the timer enabled and running", () => {
    const checks = (updater: Partial<Updater> | null) =>
      homeServerChecks(homePlan(), homeFacts({ updater }), HOME);
    const open = find(
      checks({ token: { present: true, mode: "644", owner: "root", sha256: "c".repeat(64) } }),
      "dns-updater-token",
    );
    expect(open).toMatchObject({ status: "fail", severity: "high" });
    expect(open.message).toContain("mode 644");
    expect(open.remediation).toContain("`opscrew rotate dns-updater`");
    expect(
      find(
        checks({ token: { present: true, mode: "600", owner: "ana", sha256: "c".repeat(64) } }),
        "dns-updater-token",
      ).status,
    ).toBe("fail");
    expect(
      find(
        checks({ token: { present: false, mode: "", owner: "", sha256: null } }),
        "dns-updater-token",
      ).remediation,
    ).toContain("OPSCREW_DNS_UPDATER_TOKEN");
    expect(
      find(checks({ timer: { enabled: true, active: false } }), "dns-updater-timer").message,
    ).toContain("enabled but not running");
    const missing = checks(null);
    expect(find(missing, "dns-updater-token").status).toBe("fail");
    expect(find(missing, "dns-updater-timer").message).toContain("isn't on your server");
    // With the DNS elsewhere there is no updater to check.
    const elsewhere = homeServerChecks(homePlan({ dnsElsewhere: true }), homeFacts(), HOME);
    expect(elsewhere.some((c) => c.id.startsWith("dns-updater"))).toBe(false);
  });

  it("under-voltage: a failure now, a warning since boot, a pass without, nothing unread", () => {
    const power = (now: boolean, since: boolean) =>
      homeServerChecks(
        homePlan(),
        homeFacts({
          power: { underVoltageNow: now, underVoltageSinceBoot: since, source: "vcgencmd" },
        }),
        HOME,
      ).find((c) => c.id === "pi-power");
    expect(power(true, true)).toMatchObject({ status: "fail", severity: "high" });
    expect(power(true, true)?.remediation).toContain("power supply made for your board");
    expect(power(false, true)).toMatchObject({ status: "warn" });
    expect(power(false, false)).toMatchObject({ status: "pass" });
    expect(homeServerChecks(homePlan(), homeFacts(), HOME).some((c) => c.id === "pi-power")).toBe(
      false,
    );
  });
});

describe("this computer's probes of a server at home", () => {
  it("are labelled from inside the network, with the last outside check, and never fail", () => {
    expect(insideLabel(HOME)).toBe(
      "(from inside your network: not proof; see the outside check of 20 Nov 10:30 UTC)",
    );
    expect(insideLabel({ sshFrom: SSH_FROM })).toBe(
      "(from inside your network: not proof; `opscrew verify` checks from outside your home)",
    );
    const failed: CheckResult = {
      id: "port-443-cloudflare-only",
      title: "Web port 443 only accepts Cloudflare",
      severity: "medium",
      status: "fail",
      message: "Port 443 answers from this machine.",
    };
    expect(fromInside(failed, insideLabel(HOME))).toMatchObject({
      status: "warn",
      severity: "info",
      message:
        "Port 443 answers from this machine. (from inside your network: not proof; see the outside check of 20 Nov 10:30 UTC)",
    });
  });
});

/** A proxied home app on this computer, deployed; its server a fake host adapter. */
async function homeSecureSetup(o: { reachable?: boolean } = {}) {
  const plan: DeployPlan = homePlan();
  // ssh-keyscan answers only when the server is reachable; SSH refuses passwords.
  const runner = ownRunner(o.reachable === false ? [] : undefined, (args) =>
    args.includes("PubkeyAuthentication=no")
      ? { exitCode: 255, stdout: "", stderr: "Permission denied (publickey)." }
      : undefined,
  );
  const deps = await createTestPhaseDeps({ runner, clock: { now: () => new Date(NOW) } });
  await writeArtifact("plan", deps.paths.files.plan, {
    ...plan,
    deployment: { lastApplyAt: NOW },
  });
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    serve: "proxy",
    hostKey: ED25519_FINGERPRINT,
    home: HOME,
  });
  const host = new FakeHostServer(homeFacts({ updater: { state: null } }));
  // The deploy user's shell: every command answers empty.
  const remote: RemoteExec = {
    host: LAN_IPV4,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return { deps, host, remote, runner };
}

const noScanners: Scanner[] = [];

/** From this computer every port answers, the web ports too (as the web filter wouldn't let them). */
const everyPort: TcpConnect = async () => true;

describe("runSecure on a server at home", () => {
  it("adds the server-side checks, labels the probes, and never shows the home's addresses", async () => {
    const { deps, host, remote } = await homeSecureSetup();
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: everyPort,
      remote,
      own: { host },
    });
    expect(host.inspections).toBe(1);
    expect(find(result.hostChecks, "home-ssh-table").status).toBe("pass");
    expect(find(result.hostChecks, "dns-updater-token").status).toBe("pass");
    // From inside, a web port answering is no proof of anything outside: never a failure.
    const web = find(result.probes, "port-443-cloudflare-only");
    expect(web.status).toBe("warn");
    expect(web.message).toContain("(from inside your network: not proof; see the outside check");
    expect(find(result.probes, "ssh-port-open").message).not.toContain("GitHub");
    const ports = result.probes.filter((c) => c.id !== "ssh-password-login-disabled");
    expect(ports.every((c) => c.status !== "fail")).toBe(true);
    expect(ports.every((c) => c.message.includes("from inside your network"))).toBe(true);
    // Leak check over everything shown, recorded and written.
    const report = await readFile(deps.paths.files.securityReport, "utf8");
    const shown = `${report}\n${result.summary}\n${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}\n${JSON.stringify(result)}`;
    expect(shown).not.toContain(HOME_IPV4);
    expect(shown).not.toContain(HOME_IPV6);
    expect(report).not.toContain(LAN_IPV4);
    for (const source of SSH_FROM) expect(report).not.toContain(source);
  });

  it("away from home: SSH is tried once, every check over SSH is a skip with the reason, nothing fails", async () => {
    const { deps, host, remote, runner } = await homeSecureSetup({ reachable: false });
    const used: string[] = [];
    const deploy: RemoteExec = {
      host: remote.host,
      run: async (command) => {
        used.push(command);
        return remote.run(command);
      },
    };
    const result = await runSecure(deps, {
      scanners: noScanners,
      tcpConnect: async () => false,
      remote: deploy,
      own: { host },
    });
    // The admin login tried once; the deploy user's shell and ssh itself never.
    expect(host.inspections).toBe(0);
    expect(runner.calls.filter((call) => call.command === "ssh-keyscan")).toHaveLength(1);
    expect(runner.calls.filter((call) => call.command === "ssh")).toHaveLength(0);
    expect(used).toEqual([]);
    // Each check over SSH, the admin login's and the deploy user's, is a skip with the same reason.
    const overSsh = [...result.hostChecks, find(result.probes, "ssh-password-login-disabled")];
    expect(overSsh.length).toBeGreaterThan(2);
    for (const check of overSsh) {
      expect(check).toMatchObject({ status: "skip", message: NOT_CHECKED_AWAY });
      expect(check.remediation).toBe("Run `opscrew secure` from your home network.");
    }
    expect(find(result.hostChecks, "home-server-checks").message).toContain(
      "answers SSH only on your home network",
    );
    // Nothing fails because SSH didn't answer: SSH's port probe is a warning from inside.
    expect(find(result.probes, "ssh-port-open").status).toBe("warn");
    expect([...result.hostChecks, ...result.probes].some((c) => c.status === "fail")).toBe(false);
    expect(result.passed).toBe(true);
  });
});
