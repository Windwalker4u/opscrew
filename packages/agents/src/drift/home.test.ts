/**
 * Drift on a server at home (plan 13., M10): drift reads the server as provision does without a
 * zone (the home network, SSH's sources, the updater as the server has it, its token left there),
 * then reports the address updater and the IPv6 web filter like the other steps: a changed config,
 * unit, token file mode or table. No token or address in its report; read-only.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DNS_UPDATER_VERSION,
  dnsUpdaterConfig,
  dnsUpdaterFileHashes,
  type HostFacts,
  HostFactsSchema,
  webFilterFileHashes,
  webFilterTable6Hash,
} from "@opscrew/connector-ssh-host";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type OwnServerConnectionInput, recordOwnServer } from "../shared";
import {
  CF_V4,
  CF_V6,
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeHostServer,
  filteredFacts,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  hostKeyBlob,
  LAN_IPV4,
  ownPlan,
  ownRunner,
} from "../testing";
import { type HostDifference, ownHostDrift } from "./host";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The token on the server (only its SHA-256 is in the facts); never given to drift. */
const SERVER_TOKEN = fakeSecret("cloudflare-token", "updater-on-server");
/** `OPSCREW_DNS_UPDATER_TOKEN` in the environment of one test: drift must never use it. */
const ENV_TOKEN = fakeSecret("cloudflare-token", "updater-in-env");
const ZONE_ID = "a".repeat(32);
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];
const V4 = [...CF_V4].sort();
const V6 = [...CF_V6].sort();

/** `shop` at home behind Cloudflare's proxy, over IPv6 (`ipv4: false`) unless `ipv4`. */
function homePlan(o: { ipv4?: boolean } = {}): DeployPlan {
  const base = ownPlan({ proxied: true });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: o.ipv4 ?? false } },
    security: { ...base.security, httpAllowedFrom: "edge" },
    environment: { runner: "server" },
  });
}

/**
 * A server at home whose address updater for `shop` and web filter are as OpsCrew sets them up for
 * `plan` (the rest of the server is fresh: drift reports it, the tests look at their two areas).
 */
function homeFacts(plan: DeployPlan): HostFacts {
  const ipv4 = plan.target.provider === "own" && plan.target.home?.ipv4 === true;
  const ipv6 = !plan.dns.proxied || !ipv4;
  const proxied6 = !ipv4;
  const ranges = { ipv4: V4, ...(proxied6 ? { ipv6: V6 } : {}) };
  const hashes = dnsUpdaterFileHashes();
  const root = (mode: string) => ({ mode, owner: "root" });
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    sshClient: { address: "192.168.1.10", port: 50022 },
    sshFirewall: { nft: true, table: null, files: { rules: null, unit: null }, enabled: false },
    webFilter: {
      ...filteredFacts(V4),
      files: { ...filteredFacts(V4).files, script: webFilterFileHashes(ranges).script },
      ...(proxied6 ? { table6: webFilterTable6Hash(V6) } : {}),
    },
    dnsUpdaters: [
      {
        app: "shop",
        config: dnsUpdaterConfig("shop", {
          zoneId: ZONE_ID,
          name: "shop.example.com",
          proxied: plan.dns.proxied,
          ipv4,
          ipv6,
        }),
        configFile: root("600"),
        token: { present: true, ...root("600"), sha256: sha256(SERVER_TOKEN) },
        timer: { enabled: true, active: true },
        state: null,
      },
    ],
    dnsUpdaterFiles: {
      version: DNS_UPDATER_VERSION,
      script: { ...root("755"), sha256: hashes.script },
      service: { ...root("644"), sha256: hashes.service },
      timer: { ...root("644"), sha256: hashes.timer },
      dir: root("700"),
    },
  });
}

interface Setup {
  plan?: DeployPlan;
  facts?: HostFacts;
  own?: Partial<OwnServerConnectionInput>;
  env?: Record<string, string>;
}

async function setup(o: Setup = {}) {
  const plan = o.plan ?? homePlan();
  const project = await createProject(plan);
  const host = new FakeHostServer(o.facts ?? homeFacts(plan));
  host.homeNetwork = homeNetworkFacts();
  const homeDir = await mkdtemp(join(tmpdir(), "opscrew-drift-home-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    ...o.env,
  };
  if (o.env?.OPSCREW_DNS_UPDATER_TOKEN === undefined) delete env.OPSCREW_DNS_UPDATER_TOKEN;
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    interactive: false,
  });
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    serve: "proxy",
    home: { sshFrom: SSH_FROM },
    ...o.own,
  });
  const keyFile = deps.paths.files.deployKeyPub;
  await mkdir(dirname(keyFile), { recursive: true });
  await writeFile(keyFile, `ssh-ed25519 ${hostKeyBlob("ssh-ed25519", "deploy")} opscrew-deploy\n`);
  const drift = () =>
    ownHostDrift(deps, plan, {
      own: { host, homeDir },
      hostKey: ED25519_FINGERPRINT,
      cloudflare: { getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }) },
    });
  return { ...project, plan, host, deps, drift };
}

type Project = Awaited<ReturnType<typeof setup>>;

/** Changes the fake server's facts as someone working on the server would. */
function edit(s: Project, change: (facts: HostFacts) => void): void {
  const facts = structuredClone(s.host.facts);
  change(facts);
  s.host.facts = HostFactsSchema.parse(facts);
}

/** The differences of the updater and the web filter, and the findings that name the updater. */
function homeDifferences(differences: readonly HostDifference[]): HostDifference[] {
  return differences.filter(
    (d) =>
      d.area === "dns-updater" ||
      d.area === "web-filter" ||
      (d.area === "server" && d.detail.includes("address updater")),
  );
}

async function homeDetails(s: Project): Promise<string[]> {
  const { differences } = await s.drift();
  return homeDifferences(differences).map((d) => `${d.area}: ${d.detail}`);
}

/** No token, no hash of it, and no home address in anything the run printed, audited or reported. */
function expectNoLeak(s: Project, report: unknown): void {
  const text = `${s.deps.reporter.text()}\n${JSON.stringify(s.deps.audit.entries)}\n${JSON.stringify(report)}`;
  for (const value of [
    SERVER_TOKEN,
    sha256(SERVER_TOKEN),
    ENV_TOKEN,
    sha256(ENV_TOKEN),
    HOME_IPV4,
    HOME_IPV6,
    LAN_IPV4,
  ]) {
    expect(text).not.toContain(value);
  }
}

describe.skipIf(!findExecutable("git"))("ownHostDrift on a server at home", () => {
  it("a clean server at home: no difference for the updater or the IPv6 filter, read-only, and the token never needed", async () => {
    const s = await setup();
    const report = await s.drift();

    expect(homeDifferences(report.differences)).toEqual([]);
    // The home network was read (as provision reads it); nothing was applied.
    expect(s.host.detections).toBe(1);
    expect(s.host.applies).toEqual([]);
    expect(s.deps.audit.entries.map((e) => e.action)).toContain("detect home network (read-only)");
    // A proxied app's detected addresses are registered as secrets.
    expect(s.deps.redactor.redact(`at ${HOME_IPV6}`)).not.toContain(HOME_IPV6);
    expectNoLeak(s, report);
  });

  it("proxied over IPv4: the updater keeps the A record and the filter has no IPv6 table", async () => {
    const s = await setup({ plan: homePlan({ ipv4: true }) });
    expect(homeDifferences((await s.drift()).differences)).toEqual([]);
  });

  it("OPSCREW_DNS_UPDATER_TOKEN in the environment is ignored: the token stays as the server has it", async () => {
    const s = await setup({ env: { OPSCREW_DNS_UPDATER_TOKEN: ENV_TOKEN } });
    const report = await s.drift();
    expect(homeDifferences(report.differences)).toEqual([]);
    expectNoLeak(s, report);
  });

  it("reports the updater's edited config by field, the config and token files' modes and the stopped timer", async () => {
    const s = await setup();
    edit(s, (f) => {
      const own = f.dnsUpdaters?.[0];
      if (own?.config == null) throw new Error("no updater");
      own.config.proxied = false;
      own.config.ipv4 = true;
      own.configFile = { mode: "644", owner: "root" };
      own.token = { ...own.token, mode: "644", owner: "deploy" };
      own.timer = { enabled: true, active: false };
    });
    const report = await s.drift();
    const updater = report.differences.filter((d) => d.area === "dns-updater");

    expect(updater.map((d) => d.detail)).toEqual([
      "/etc/opscrew/dns-updater/shop.json was edited: its proxied and ipv4 no longer match opscrew/plan.yaml.",
      "/etc/opscrew/dns-updater/shop.json is owned by root with mode 644; OpsCrew set root and 600.",
      "/etc/opscrew/dns-updater/shop.token is owned by deploy with mode 644; OpsCrew set root and 600, so only root can read the updater's token.",
      "The updater's timer opscrew-dns-updater@shop.timer is not enabled and running, so the site's DNS records no longer follow your home's address.",
    ]);
    expect(updater.every((d) => d.restoredByProvision)).toBe(true);
    expect(updater[0]?.title).toBe(
      "The address updater (keeps the app's DNS records at this server's address)",
    );
    expectNoLeak(s, report);
  });

  it("reports an edited unit, a unit's mode, a missing script and a damaged config", async () => {
    const s = await setup();
    edit(s, (f) => {
      const files = f.dnsUpdaterFiles;
      if (files?.service == null || files.timer === null) throw new Error("no units");
      files.service.sha256 = "e".repeat(64);
      files.timer.mode = "666";
    });
    expect(await homeDetails(s)).toEqual([
      "dns-updater: /etc/systemd/system/opscrew-dns-updater@.service was edited.",
      "dns-updater: /etc/systemd/system/opscrew-dns-updater@.timer is owned by root with mode 666; OpsCrew set root and 644.",
    ]);

    edit(s, (f) => {
      if (f.dnsUpdaterFiles === undefined || f.dnsUpdaters?.[0] === undefined) {
        throw new Error("no updater");
      }
      f.dnsUpdaterFiles.script = null;
      f.dnsUpdaters[0].config = null;
    });
    expect(await homeDetails(s)).toEqual([
      "dns-updater: /etc/opscrew/dns-updater/shop.json is no longer the address updater's config (it was edited or damaged).",
      "dns-updater: The updater's script (/usr/local/sbin/opscrew-dns-updater) or its systemd units are missing or older than this OpsCrew's.",
    ]);
  });

  it("an updater gone from the server: provision needs its token, said as what stops provision", async () => {
    const s = await setup();
    edit(s, (f) => {
      f.dnsUpdaters = [];
    });
    const report = await s.drift();
    expect(homeDifferences(report.differences)).toEqual([
      {
        area: "server",
        title: "What OpsCrew found",
        detail:
          'The address updater of "shop" has no token on this server, and none was given. Set OPSCREW_DNS_UPDATER_TOKEN (the guide\'s recipe) and run opscrew provision again.',
        restoredByProvision: false,
      },
    ]);
    expectNoLeak(s, report);
  });

  it("reports the IPv6 table missing, flushed or edited, and the nftables drop-in gone", async () => {
    const s = await setup();
    edit(s, (f) => {
      delete f.webFilter.table6;
    });
    expect(await homeDetails(s)).toEqual([
      "web-filter: OpsCrew's IPv6 filter (the nftables table inet opscrew-web) is missing, so visitors can reach the site over IPv6 around Cloudflare. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
    ]);

    edit(s, (f) => {
      f.webFilter.table6 = "d".repeat(64);
      delete f.webFilter.files.nftDropIn;
    });
    expect(await homeDetails(s)).toEqual([
      "web-filter: The web filter no longer follows nftables.service (its drop-in /etc/systemd/system/opscrew-web-filter.service.d/nftables.conf is missing or edited), so restarting or reloading nftables would leave the web ports unfiltered. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
      "web-filter: OpsCrew's IPv6 filter (the nftables table inet opscrew-web) was flushed or edited, so it may let visitors reach the site over IPv6 around Cloudflare. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
    ]);
  });

  it("from IPv6 to IPv4 behind the proxy: the IPv6 table left on the server is reported", async () => {
    const plan = homePlan({ ipv4: true });
    const facts = homeFacts(plan);
    const s = await setup({
      plan,
      facts: HostFactsSchema.parse({
        ...facts,
        webFilter: { ...facts.webFilter, table6: webFilterTable6Hash(V6) },
      }),
    });
    expect(await homeDetails(s)).toEqual([
      "web-filter: The site is no longer published on IPv6, but OpsCrew's IPv6 filter (the nftables table inet opscrew-web) is still on the server. Run `opscrew provision`: it shows the change and applies it only after you approve it.",
    ]);
  });

  it("stops plainly when this computer doesn't know SSH's sources at home", async () => {
    const s = await setup({ own: { home: {} } });
    const error = await s.drift().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "OpsCrew doesn't know on this computer which networks may reach your server's SSH at home, so it can't compare your server with its setup.",
    );
    expect((error as OpsCrewError).hint).toContain("Run `opscrew design` again");
    expect(s.host.applies).toEqual([]);
  });
});
