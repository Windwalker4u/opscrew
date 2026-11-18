/**
 * `opscrew status` for a server at home (plan 13., research R11): SSH's sources, this app's
 * address updater from inspection, and the last outside check; away from home, the last outside
 * check from this computer's record. A proxied app's addresses never show.
 */
import { type DnsUpdaterState, type HostFacts, HostFactsSchema } from "@opscrew/connector-ssh-host";
import { OpsCrewError } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { recordOwnServer } from "../shared";
import type { OwnHome } from "../shared/server-record";
import {
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  LAN_IPV4,
  ownPlan,
  ownRunner,
} from "../testing";
import { homeStatusLines, outsideCheckText, sshTableSources, utcText } from "./home";
import { componentStatusReport } from "./run";

const NOW = new Date("2026-11-20T10:35:00Z");
const ZONE_ID = "0123456789abcdef0123456789abcdef";
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

/** `shop` on a server at home, served over IPv4, deployed. */
function homePlan(o: { proxied?: boolean; dnsElsewhere?: boolean } = {}): DeployPlan {
  const proxied = o.proxied ?? true;
  const base = ownPlan({ proxied });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: true } },
    security: { ...base.security, httpAllowedFrom: proxied ? "cloudflare" : "any" },
    environment: { runner: "server" },
    deployment: {
      lastApplyAt: "2026-11-19T09:00:00.000Z",
      firstDeployAt: "2026-11-19T09:30:00.000Z",
    },
    ...(o.dnsElsewhere
      ? { dns: { provider: "none", domain: "shop.example.com", proxied: false } }
      : {}),
  });
}

/** The updater's state after a run that saw {@link HOME_IPV4} and no IPv6. */
function updaterState(over: Partial<DnsUpdaterState> = {}): DnsUpdaterState {
  return {
    schemaVersion: 1,
    version: 1,
    lastRun: "2026-11-20T10:04:12Z",
    lastSuccess: "2026-11-20T10:04:12Z",
    seen: { ipv4: HOME_IPV4, ipv6: null },
    records: { ipv4: HOME_IPV4, ipv6: null },
    lastWrite: { at: "2026-11-20T09:12:40Z", changed: ["A"] },
    lastError: { at: "2026-11-19T22:00:02Z", code: "rate-limited", http: 429, cloudflare: [10000] },
    ...over,
  };
}

/** A server at home with OpsCrew's SSH table and this app's updater (`state`, a timer running). */
function homeFacts(
  o: {
    state?: unknown;
    proxied?: boolean;
    table?: string | null;
    timer?: { enabled: boolean; active: boolean };
    updater?: boolean;
  } = {},
): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [
        { interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false },
        { interface: "eth0", family: "ipv6", address: HOME_IPV6, public: true },
      ],
    }),
    sshFirewall: {
      nft: true,
      table: o.table === undefined ? TABLE : o.table,
      files: { rules: "a".repeat(64), unit: "b".repeat(64) },
      enabled: true,
    },
    dnsUpdaters:
      o.updater === false
        ? []
        : [
            {
              app: "shop",
              config: {
                schemaVersion: 1,
                app: "shop",
                zoneId: ZONE_ID,
                name: "shop.example.com",
                proxied: o.proxied ?? true,
                ipv4: true,
                ipv6: !(o.proxied ?? true),
              },
              configFile: { mode: "600", owner: "root" },
              token: { present: true, mode: "600", owner: "root", sha256: "c".repeat(64) },
              timer: o.timer ?? { enabled: true, active: true },
              state: o.state === undefined ? updaterState() : o.state,
            },
            // Another app's updater on the same server is never shown.
            {
              app: "blog",
              config: null,
              configFile: { mode: "600", owner: "root" },
              token: { present: false, mode: "", owner: "", sha256: null },
              timer: { enabled: false, active: false },
              state: { lastRun: "2026-11-20T10:00:00Z" },
            },
          ],
  });
}

const CHECK: NonNullable<OwnHome["outsideCheck"]> = {
  at: "2026-11-20T10:30:00Z",
  host: "shop.example.com",
  mode: "proxied",
  http: "ok",
  https: "ok",
  runUrl: "https://github.com/acme/shop/actions/runs/123",
};

const HOME: OwnHome = { sshFrom: SSH_FROM, outsideCheck: CHECK };

describe("the pieces", () => {
  it("writes times in UTC, without the day when it is today", () => {
    expect(utcText("2026-11-20T10:04:12Z", NOW)).toBe("10:04 UTC");
    expect(utcText("2026-11-19T22:00:02Z", NOW)).toBe("19 Nov 22:00 UTC");
    expect(utcText("2026-11-20T10:04:12Z")).toBe("20 Nov 10:04 UTC");
  });

  it("reads the SSH table's sources", () => {
    expect(sshTableSources(TABLE)).toEqual(SSH_FROM);
    expect(sshTableSources("")).toEqual([]);
  });

  it("says the outside check by port, with the run's link when a port failed", () => {
    expect(outsideCheckText(CHECK)).toBe("20 Nov 10:30 UTC: 443 ok; 80: Cloudflare answered");
    expect(outsideCheckText({ ...CHECK, mode: "direct", https: "failed" }, NOW)).toBe(
      "10:30 UTC: 443 didn't answer; 80 ok (https://github.com/acme/shop/actions/runs/123)",
    );
  });
});

describe("homeStatusLines", () => {
  it("proxied: the sources, the updater with its addresses hidden, and the outside check", () => {
    const lines = homeStatusLines({
      plan: homePlan(),
      home: HOME,
      read: { facts: homeFacts() },
      now: NOW,
      flags: "",
    });
    expect(lines).toEqual([
      "SSH          only from your home network (192.168.1.0/24, fe80::/10)",
      "Updater      every 2 minutes · last run 10:04 UTC, ok",
      "  sees       IPv4 (hidden: behind Cloudflare's proxy), no IPv6",
      "  records    match",
      "  last write 09:12 UTC (A changed)",
      "  last error 19 Nov 22:00 UTC: Cloudflare limited the requests for a while (retried)",
      "Outside      checked 10:30 UTC: 443 ok; 80: Cloudflare answered",
    ]);
    expect(lines.join("\n")).not.toContain(HOME_IPV4);
  });

  it("DNS only: the addresses the updater sees, which are public in DNS anyway", () => {
    const state = updaterState({
      seen: { ipv4: HOME_IPV4, ipv6: HOME_IPV6 },
      records: { ipv4: HOME_IPV4, ipv6: HOME_IPV6 },
    });
    const lines = homeStatusLines({
      plan: homePlan({ proxied: false }),
      home: { ...HOME, outsideCheck: { ...CHECK, mode: "direct" } },
      read: { facts: homeFacts({ proxied: false, state }) },
      now: NOW,
      flags: "",
    });
    expect(lines).toContain(`  sees       IPv4 ${HOME_IPV4}, IPv6 ${HOME_IPV6}`);
    expect(lines).toContain("Outside      checked 10:30 UTC: 443 ok; 80 ok");
  });

  it("names the records that differ and the error's next step, with the command's flags", () => {
    const state = updaterState({
      lastSuccess: "2026-11-20T09:00:00Z",
      records: { ipv4: "198.51.100.9", ipv6: null },
      lastError: { at: "2026-11-20T10:04:12Z", code: "token-refused", http: 403 },
    });
    const lines = homeStatusLines({
      plan: homePlan(),
      home: HOME,
      read: { facts: homeFacts({ state }) },
      now: NOW,
      flags: " --env staging",
    });
    expect(lines).toContain("Updater      every 2 minutes · last run 10:04 UTC, failed");
    expect(lines).toContain(
      "  records    differ from what your server sees (A): the next run puts them right",
    );
    expect(lines).toContain(
      "  last error 10:04 UTC: Cloudflare refused the updater's token: make a new token as the guide says, set `OPSCREW_DNS_UPDATER_TOKEN`, and run `opscrew rotate dns-updater --env staging`",
    );
    expect(lines.join("\n")).not.toContain("198.51.100.9");
  });

  it("each error code says what to do next", () => {
    const words = (code: NonNullable<DnsUpdaterState["lastError"]>["code"]) =>
      homeStatusLines({
        plan: homePlan(),
        home: HOME,
        read: {
          facts: homeFacts({
            state: updaterState({
              lastError: { at: "2026-11-20T10:04:12Z", code, http: 500, cloudflare: [1000] },
            }),
          }),
        },
        now: NOW,
        flags: "",
      }).find((line) => line.startsWith("  last error"));
    expect(words("address-unknown")).toContain("reach the internet over HTTPS");
    expect(words("sources-disagree")).toContain("wait a few minutes");
    expect(words("cloudflare-unreachable")).toContain("internet connection");
    expect(words("cloudflare-error")).toContain(
      "(HTTP 500, code 1000): run `opscrew verify` again, and report it if it stays",
    );
    expect(words("foreign-record")).toContain("holds shop.example.com: remove that record");
    expect(words("cname-at-name")).toContain("finish the mode switch with `opscrew provision`");
    expect(words("config-invalid")).toContain("run `opscrew provision`");
  });

  it("a missing table, a stopped timer, no run yet, a state it can't read, no updater", () => {
    const line = (facts: HostFacts, prefix: string) =>
      homeStatusLines({ plan: homePlan(), home: HOME, read: { facts }, now: NOW, flags: "" }).find(
        (l) => l.startsWith(prefix),
      );
    expect(line(homeFacts({ table: null }), "SSH")).toBe(
      "SSH          not limited on your server: OpsCrew's SSH table is missing (`opscrew drift` shows it, `opscrew provision` puts it back)",
    );
    expect(line(homeFacts({ timer: { enabled: true, active: false } }), "Updater")).toBe(
      "Updater      stopped: its timer isn't running (`opscrew provision` starts it again) · last run 10:04 UTC, ok",
    );
    expect(line(homeFacts({ state: null }), "Updater")).toBe(
      "Updater      every 2 minutes · no run yet",
    );
    expect(line(homeFacts({ state: { schemaVersion: 2 } }), "Updater")).toBe(
      "Updater      every 2 minutes · its state on your server can't be read: run `opscrew provision`",
    );
    expect(line(homeFacts({ updater: false }), "Updater")).toBe(
      "Updater      not on your server: `opscrew provision` sets it up",
    );
  });

  it("with the DNS elsewhere there is no updater; without an outside check, how to run it", () => {
    const lines = homeStatusLines({
      plan: homePlan({ dnsElsewhere: true }),
      home: { sshFrom: SSH_FROM },
      read: { facts: homeFacts({ updater: false }) },
      now: NOW,
      flags: "",
    });
    expect(lines).toEqual([
      "SSH          only from your home network (192.168.1.0/24, fe80::/10)",
      "Outside      not checked yet: `opscrew verify` checks from GitHub's machines",
    ]);
  });

  it("away from home: SSH answers only there, and the last outside check from this computer", () => {
    const away = { away: new OpsCrewError("COMMAND_FAILED", "unreachable") };
    expect(
      homeStatusLines({ plan: homePlan(), home: HOME, read: away, now: NOW, flags: "" }),
    ).toEqual([
      "Your server answers SSH only on your home network, so its updater can't be read from here. Last outside check: 10:30 UTC: 443 ok; 80: Cloudflare answered.",
    ]);
    expect(
      homeStatusLines({
        plan: homePlan(),
        home: { sshFrom: SSH_FROM },
        read: away,
        now: NOW,
        flags: "",
      }),
    ).toEqual([
      "Your server answers SSH only on your home network, so its updater can't be read from here. No check from outside your home yet: `opscrew verify` runs it.",
    ]);
  });

  it("not read for another reason: the sources and the outside check from this computer", () => {
    const lines = homeStatusLines({
      plan: homePlan(),
      home: HOME,
      read: { unread: new OpsCrewError("PHASE_PRECONDITION", "not confirmed") },
      now: NOW,
      flags: "",
    });
    expect(lines).toEqual([
      "SSH          only from your home network (192.168.1.0/24, fe80::/10)",
      "Outside      checked 10:30 UTC: 443 ok; 80: Cloudflare answered",
    ]);
  });
});

/** A deployed proxied home app on this computer, its server a fake host adapter. */
async function homeProject(o: { facts?: HostFacts; reachable?: boolean } = {}) {
  const plan = homePlan();
  const reachable = o.reachable ?? true;
  const runner = reachable ? ownRunner() : ownRunner([]);
  const deps = await createTestPhaseDeps({ runner, clock: { now: () => NOW } });
  await writeArtifact("plan", deps.paths.files.plan, plan);
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    serve: "proxy",
    hostKey: ED25519_FINGERPRINT,
    home: HOME,
  });
  const host = new FakeHostServer(
    o.facts ?? {
      ...homeFacts(),
      containers: [{ name: "shop-app-1", project: "shop", ports: "", running: true }],
    },
  );
  return { plan, deps, host, runner };
}

/** Everything a run showed or recorded: its lines, the reporter's output, the audit log. */
function everything(
  lines: readonly string[],
  deps: Awaited<ReturnType<typeof homeProject>>["deps"],
) {
  return `${lines.join("\n")}\n${deps.reporter.text()}\n${JSON.stringify(deps.audit.entries)}`;
}

describe("componentStatusReport for a server at home", () => {
  it("reads the server once for its components and its section; the home's addresses never show", async () => {
    const { plan, deps, host } = await homeProject();
    const report = await componentStatusReport(deps, plan, {
      services: { own: { host }, deploys: null },
    });
    expect(host.inspections).toBe(1);
    expect(report.status?.components.find((c) => c.service === "app")?.running).toBe(1);
    expect(report.lines).toEqual(
      expect.arrayContaining([
        "SSH          only from your home network (192.168.1.0/24, fe80::/10)",
        "Updater      every 2 minutes · last run 10:04 UTC, ok",
        "  sees       IPv4 (hidden: behind Cloudflare's proxy), no IPv6",
        "Outside      checked 10:30 UTC: 443 ok; 80: Cloudflare answered",
      ]),
    );
    // Leak check: neither of the home's public addresses in anything shown or recorded, and
    // the redactor masks the address the updater read wherever it would appear.
    const shown = everything(report.lines, deps);
    expect(shown).not.toContain(HOME_IPV4);
    expect(shown).not.toContain(HOME_IPV6);
    expect(deps.redactor.redact(`at ${HOME_IPV4}`)).not.toContain(HOME_IPV4);
  });

  it("away from home: one try, the away line with the last outside check, no component read", async () => {
    const { plan, deps, host, runner } = await homeProject({ reachable: false });
    const report = await componentStatusReport(deps, plan, {
      services: { own: { host }, deploys: null },
    });
    expect(host.inspections).toBe(0);
    expect(runner.calls.filter((call) => call.command === "ssh-keyscan")).toHaveLength(1);
    expect(report.status).toBeUndefined();
    expect(report.lines).toContain(
      "Your server answers SSH only on your home network, so its updater can't be read from here. Last outside check: 10:30 UTC: 443 ok; 80: Cloudflare answered.",
    );
    const shown = everything(report.lines, deps);
    expect(shown).not.toContain(HOME_IPV4);
    expect(shown).not.toContain(HOME_IPV6);
  });
});
