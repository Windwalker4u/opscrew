/**
 * Provision on a server at the user's home (plan 9., 10.): before any change the server reads its
 * home network, the address updater's token is checked, and the mixing and previews refusals and
 * Cloudflare's IPv6 ranges stop a run plainly; the host plan limits SSH to the home network, keeps
 * the app record's `home`, sets up the address updater (its token on standard input only) and the
 * IPv6 web filter behind the proxy; no address reaches the engine, GitHub or any file; the output
 * names the router's settings and the outside check.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  type FakeCloudflarePermission,
  FakeZone,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import {
  type HomeNetwork,
  type HostFacts,
  HostFactsSchema,
  type HostStep,
} from "@opscrew/connector-ssh-host";
import type { ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { checkReachesOverSsh } from "../check/provision";
import { environmentPaths } from "../environments/paths";
import { ROUTER_IPV6_RULE } from "../home/forwards";
import {
  type OwnServerConnectionInput,
  readServerAddresses,
  recordOwnServer,
  recordServerAddress,
} from "../shared";
import {
  ACCOUNT_ID,
  CF_V4,
  CF_V6,
  createProject,
  createTestPhaseDeps,
  ED25519,
  ED25519_FINGERPRINT,
  FakeGitHub,
  FakeHostServer,
  FakeRunnerGitHub,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  ScriptedApprovalHandler,
  sharedPreviewTestPlan,
  withOtherApp,
} from "../testing";
import {
  homeProvisionLines,
  type OwnHomeRun,
  ownDeployTarget,
  ownEngineEnv,
  ownTarget,
  ownWebSources,
} from "./own";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const OWN_TOKEN = fakeSecret("cloudflare-token", "own");
const UPDATER = fakeSecret("cloudflare-token", "updater");
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];
/** The address this computer connects from, on the home network. */
const CLIENT = "192.168.1.10";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** Every permission the fake knows but the zone's DNS: the updater's token as the recipe makes it. */
const ALL_BUT_DNS: FakeCloudflarePermission[] = [
  "zone",
  "ssl",
  "settings",
  "http_config_settings",
  "http_request_firewall_custom",
  "http_request_dynamic_redirect",
  "page-rules",
  "email-routing",
  "tunnel",
  "access-apps",
  "access-service-tokens",
  "access-organization",
  "r2",
  "workers",
  "pages",
  "turnstile",
  "web-analytics",
];

/** The home root's plan: the CAA record (the updater keeps the A and AAAA records). */
const HOME_CHANGES: ResourceChange[] = [
  {
    address: 'module.dns.cloudflare_dns_record.caa["letsencrypt.org"]',
    type: "cloudflare_dns_record",
    name: "caa",
    provider: "registry.opentofu.org/cloudflare/cloudflare",
    action: "create",
  },
];

/** `shop` on a server at home, deployed by the server's runner. */
function homePlan(o: { ipv4?: boolean; proxied?: boolean } = {}): DeployPlan {
  const proxied = o.proxied ?? true;
  const base = ownPlan({ proxied });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: o.ipv4 ?? true } },
    security: { ...base.security, httpAllowedFrom: proxied ? "cloudflare" : "any" },
    environment: { runner: "server" },
  });
}

/** A fresh server at home ({@link LAN_IPV4}), reached from {@link CLIENT}, with nft. */
function homeFacts(over: Partial<HostFacts> = {}): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    sshClient: { address: CLIENT, port: 50022 },
    sshFirewall: { nft: true, table: null, files: { rules: null, unit: null }, enabled: false },
    ...over,
  });
}

interface HomeSetup {
  plan?: DeployPlan;
  facts?: HostFacts;
  network?: HomeNetwork;
  /** `OPSCREW_DNS_UPDATER_TOKEN` (default {@link UPDATER}); `null` leaves it unset. */
  token?: string | null;
  /** What the updater's token may not do (default: everything but the zone's DNS). */
  denied?: FakeCloudflarePermission[];
  /** Cloudflare's IPv6 ranges (default {@link CF_V6}). */
  ipv6Ranges?: string[];
  own?: Partial<OwnServerConnectionInput>;
}

async function setup(o: HomeSetup = {}) {
  const plan = o.plan ?? homePlan();
  const project = await createProject(plan);
  // OpsCrew's token and the updater's, both in the account of the zone.
  const cloudflare = fakeCloudflareAccounts({
    accounts: [{ name: "home", id: ACCOUNT_ID, token: OWN_TOKEN }],
    zones: [{ name: "example.com", account: "home" }],
  });
  cloudflare.tokens.set(UPDATER, {
    accounts: [ACCOUNT_ID],
    denied: new Set(o.denied ?? ALL_BUT_DNS),
  });
  const zoneId = cloudflare.zone("example.com", "home").id;
  const engine = new OwnEngine(HOME_CHANGES, {
    url: "https://shop.example.com",
    address_updater: true,
  });
  const host = new FakeHostServer(o.facts ?? homeFacts());
  host.homeNetwork = o.network ?? homeNetworkFacts();
  const github = new FakeGitHub();
  const handler = new ScriptedApprovalHandler(() => true);
  const homeDir = await mkdtemp(join(tmpdir(), "opscrew-own-home-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: OWN_TOKEN,
    OPSCREW_DNS_UPDATER_TOKEN: UPDATER,
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  if (o.token === null) delete env.OPSCREW_DNS_UPDATER_TOKEN;
  else if (o.token !== undefined) env.OPSCREW_DNS_UPDATER_TOKEN = o.token;
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    approvalHandler: handler,
    fetch: cloudflare.fetch,
  });
  const proxied = plan.dns.proxied;
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    serve: proxied ? "proxy" : "dns-only",
    home: { sshFrom: SSH_FROM },
    ...o.own,
  });
  const ipRanges = { ipv4: CF_V4, ipv6: o.ipv6Ranges ?? CF_V6 };
  const zone = new FakeZone({ zoneId });
  const runnerGitHub = new FakeRunnerGitHub();
  const services: ProvisionServices = {
    engine: async () => engine,
    github,
    cloudflare: {
      ...ownCloudflare(),
      findZone: async () => ({
        id: zoneId,
        name: "example.com",
        status: "active",
        nameServers: [],
        accountId: ACCOUNT_ID,
      }),
      getIpRanges: async () => ipRanges,
    },
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir },
    sharedCloudflare: new CloudflareClient({
      token: fakeSecret("cloudflare-token", "shared"),
      fetch: zone.fetch,
      sleep: async () => undefined,
    }),
    runnerGitHub,
  };
  const fakes = { engine, host, github, handler, cloudflare, zone, runnerGitHub };
  return { ...project, ...fakes, deps, services, zoneId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const provision = (s: Setup) =>
  runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT });

/** The refusal of a provision run. */
async function refused(s: Setup): Promise<OpsCrewError> {
  const error = await provision(s).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/** Nothing was asked for, applied or stored. */
function expectNothingChanged(s: Setup): void {
  expect(s.handler.requests).toEqual([]);
  expect(s.engine.applies).toEqual([]);
  expect(s.host.applies).toEqual([]);
  expect(s.github.secrets.size).toBe(0);
}

function stepOf(s: Setup, id: string): HostStep | undefined {
  return s.host.applies[0]?.plan.steps.find((step) => step.id === id);
}

/** Every file under `dir`, with its text. */
async function filesUnder(dir: string): Promise<string> {
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const texts = await Promise.all(
    names.map((name) => readFile(join(dir, name), "utf8").catch(() => "")),
  );
  return texts.join("\n");
}

/** The engine variables of an environment the engine got (`TF_VAR_*`). */
const engineVariables = (env: Record<string, string | undefined>) =>
  Object.entries(env).filter(([name]) => name.startsWith("TF_VAR_"));

/**
 * Everything a run's fakes saw or left, by where: the output, the audit log, the approvals, every
 * file this computer keeps for the project (`.opscrew`: `server.json`, saved plans, the deploy
 * secrets' record; and its home folder with the state), the engine's variables, plans and state,
 * the host plans applied, GitHub's secrets and pull requests, the committed files and commit
 * messages, and every call to Cloudflare and GitHub's runner API.
 */
async function everything(s: Setup): Promise<[string, string][]> {
  const committed = (await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD"))
    .split("\n")
    .filter((name) => name !== "");
  const contents = await Promise.all(
    committed.map((name) => readFile(join(s.root, name), "utf8").catch(() => "")),
  );
  const envs = [...s.engine.envs, ...s.engine.plans.map((plan) => plan.env)];
  return [
    ["output", s.deps.reporter.text()],
    ["audit", JSON.stringify(s.deps.audit.entries)],
    ["approvals", JSON.stringify(s.handler.requests)],
    [".opscrew", await filesUnder(join(s.root, ".opscrew"))],
    ["home folder", await filesUnder(join(s.root, ".home-opscrew"))],
    ["engine variables", JSON.stringify(envs.map(engineVariables))],
    ["engine plans", JSON.stringify(s.engine.plans.map((plan) => plan.planFile))],
    ["engine state", JSON.stringify(s.engine.state)],
    ["host plans", JSON.stringify(s.host.applies.map((apply) => apply.plan))],
    ["GitHub secrets", JSON.stringify([...s.github.secrets])],
    [
      "GitHub environments",
      JSON.stringify([...s.github.environments].map(([name, secrets]) => [name, [...secrets]])),
    ],
    ["pull requests", JSON.stringify(s.github.pulls)],
    ["committed files", contents.join("\n")],
    ["commit messages", await s.git(s.root, "log", "--format=%B")],
    ["Cloudflare calls", JSON.stringify(s.cloudflare.calls)],
    ["shared Cloudflare calls", JSON.stringify(s.zone.calls)],
    ["runner GitHub calls", JSON.stringify(s.runnerGitHub.calls)],
  ];
}

/** None of `values` anywhere a run's fakes saw or left: the places that hold one, by name. */
async function expectNowhere(s: Setup, values: readonly string[]): Promise<void> {
  const places = await everything(s);
  for (const value of values) {
    expect(places.filter(([, text]) => text.includes(value)).map(([where]) => where)).toEqual([]);
  }
}

describe.skipIf(!findExecutable("git"))("runProvision on a server at home", () => {
  it("proxied over IPv4: reads the home network, checks the updater's token, and plans SSH from home, the web filter and the updater, its token on stdin only", async () => {
    const s = await setup();
    const result = await provision(s);

    expect(s.handler.requests.map((r) => r.kind)).toEqual([
      "cloudflare-apply",
      "repo-write",
      "iac-apply",
      "host-apply",
      "github-secrets",
      "git-push",
      "pull-request",
    ]);
    expect(s.host.detections).toBe(1);
    expect(s.deps.audit.entries.map((entry) => entry.action)).toContain(
      "detect home network (read-only)",
    );
    // The token's checks are read-only.
    expect(s.cloudflare.calls.length).toBeGreaterThan(0);
    expect(s.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);

    // The host plan: SSH only from the home network, the record's home, the IPv4 web filter and
    // the updater with the token's hash; its apply gets the token on stdin.
    expect(result.hostApplied).toBe(true);
    expect(stepOf(s, "ssh-firewall")?.params).toMatchObject({
      sources: "192.168.1.0/24 fe80::/10",
      from: CLIENT,
    });
    expect(stepOf(s, "app-record")?.params).toMatchObject({ homeIpv4: true });
    expect(stepOf(s, "web-filter")?.params).not.toHaveProperty("ipv6");
    expect(stepOf(s, "dns-updater")).toMatchObject({
      state: "change",
      params: {
        app: "shop",
        zoneId: s.zoneId,
        name: "shop.example.com",
        proxied: true,
        ipv4: true,
        ipv6: false,
        tokenSha256: sha256(UPDATER),
      },
    });
    expect(s.host.applies[0]?.options.secrets?.dnsUpdaterToken).toBe(UPDATER);

    // No address reaches the engine, and none is recorded.
    for (const env of [...s.engine.envs, ...s.engine.plans.map((plan) => plan.env)]) {
      expect(env).not.toHaveProperty("TF_VAR_server_ipv4");
      expect(env).not.toHaveProperty("TF_VAR_server_ipv6");
    }
    const record = await readServerAddresses(s.deps.paths);
    expect(record.deployment).toBeUndefined();
    expect(record.own).not.toHaveProperty("publicIpv4");
    // The server's runner deploys in place: GitHub holds no host, key or known hosts for it.
    const names = [...s.github.secrets.keys()];
    expect(names).toContain("OPSCREW_APP_ENV");
    expect(names).not.toContain("OPSCREW_HOST");
    expect(names).not.toContain("OPSCREW_KNOWN_HOSTS");

    const text = s.deps.reporter.text();
    expect(text).toContain("Your router's settings (so Cloudflare reaches your server):");
    expect(text).toContain(`  On your router, forward TCP 80 and TCP 443 to ${LAN_IPV4}.`);
    expect(text).toContain(
      "Merge, then run `npx opscrew verify`, which checks from outside your home.",
    );
    expect(text).not.toContain(ROUTER_IPV6_RULE);

    // The home's addresses go nowhere; the token only to the host adapter, on stdin.
    await expectNowhere(s, [HOME_IPV4, HOME_IPV6, UPDATER]);
    expect(s.deps.redactor.redact(`the home at ${HOME_IPV4}`)).not.toContain(HOME_IPV4);
  });

  it("over IPv6 behind the proxy: Cloudflare's IPv6 ranges in the web filter, the updater keeps the AAAA, and the router's IPv6 rule", async () => {
    const s = await setup({ plan: homePlan({ ipv4: false }) });
    await provision(s);

    const filter = stepOf(s, "web-filter");
    expect(filter?.params.ipv4).toBe([...CF_V4].sort().join(" "));
    expect(filter?.params.ipv6).toBe(CF_V6.join(" "));
    expect(stepOf(s, "app-record")?.params).toMatchObject({ homeIpv4: false });
    expect(stepOf(s, "dns-updater")?.params).toMatchObject({
      proxied: true,
      ipv4: false,
      ipv6: true,
    });
    const text = s.deps.reporter.text();
    expect(text).toContain("Your router's settings (so Cloudflare reaches your server):");
    expect(text).toContain(`  ${ROUTER_IPV6_RULE}`);
    // Without IPv4 there is nothing to forward.
    expect(text).not.toContain("forward TCP 80 and TCP 443");

    await expectNowhere(s, [HOME_IPV4, HOME_IPV6, UPDATER]);
  });

  it("with DNS only: the updater keeps the A and the AAAA unproxied, and the router's settings go before the merge", async () => {
    const s = await setup({ plan: homePlan({ proxied: false }) });
    await provision(s);

    expect(stepOf(s, "web-filter")).toBeUndefined();
    expect(stepOf(s, "dns-updater")?.params).toMatchObject({
      proxied: false,
      ipv4: true,
      ipv6: true,
    });
    const text = s.deps.reporter.text();
    expect(text).toContain(
      "Your router's settings (set them before you merge: the first deploy fetches its certificate through them):",
    );
    expect(text).toContain(`  ${ROUTER_IPV6_RULE}`);
    await expectNowhere(s, [UPDATER]);
  });

  it("without the variable, keeps the token on the server: no hash in the plan, no token sent and no token check", async () => {
    const facts = homeFacts({
      dnsUpdaters: [
        {
          app: "shop",
          config: null,
          configFile: { mode: "", owner: "" },
          token: { present: true, mode: "600", owner: "root", sha256: sha256(UPDATER) },
          timer: { enabled: false, active: false },
          state: null,
        },
      ],
    });
    const s = await setup({ facts, token: null });
    await provision(s);

    const updater = stepOf(s, "dns-updater");
    expect(updater?.state).toBe("change");
    expect(updater?.params).not.toHaveProperty("tokenSha256");
    expect(s.host.applies[0]?.options.secrets).not.toHaveProperty("dnsUpdaterToken");
    expect(s.cloudflare.calls).toEqual([]);
  });

  it("repeats design's warning of a connection that looks like it has no public IPv4 address", async () => {
    const network = homeNetworkFacts({ hops: ["192.168.1.1", "100.64.12.1", "203.0.113.9"] });
    const s = await setup({ network });
    await provision(s);
    const text = s.deps.reporter.text();
    expect(text).toContain("! Your connection looks like it has no public IPv4 address");
    expect(text).not.toContain("100.64.12.1");
  });
});

describe.skipIf(!findExecutable("git"))("runProvision at home stops before any change", () => {
  it("when a plan served over IPv4 finds no IPv4 on the server: run design again", async () => {
    const s = await setup({ network: homeNetworkFacts({ ipv4: { route: false } }) });
    const error = await refused(s);
    expect(error.code).toBe("PHASE_PRECONDITION");
    expect(error.message).toBe(
      "Your server at home has no IPv4 connection to the internet now, and opscrew/plan.yaml serves the site over IPv4 (target.home.ipv4: true). Nothing was changed.",
    );
    expect(error.hint).toContain("Run `opscrew design` again");
    expectNothingChanged(s);
  });

  it("when the server can't see its public IPv4 address", async () => {
    const s = await setup({ network: homeNetworkFacts({ ipv4: { route: true } }) });
    const error = await refused(s);
    expect(error.message).toMatch(/^Your server at home couldn't see its public IPv4 address/);
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(error.hint).toContain("outgoing HTTPS");
    expectNothingChanged(s);
  });

  it("when a plan served over IPv6 finds no IPv6 on the server", async () => {
    const s = await setup({
      plan: homePlan({ ipv4: false }),
      network: homeNetworkFacts({ ipv6: { state: "absent" } }),
    });
    const error = await refused(s);
    expect(error.message).toBe(
      "Your server at home has no IPv6 address now, and opscrew/plan.yaml serves the site over IPv6 only (target.home.ipv4: false). Nothing was changed.",
    );
    expectNothingChanged(s);
  });

  it("without the updater's token, naming its recipe", async () => {
    const s = await setup({ token: null });
    const error = await refused(s);
    expect(error.code).toBe("CREDENTIALS_MISSING");
    expect(error.message).toBe(
      "Your server's address updater needs a Cloudflare token of its own, limited to example.com's DNS. Nothing was changed.",
    );
    expect(error.hint).toContain("Zone → DNS → Edit");
    expect(error.hint).toContain("run `opscrew provision` again");
    expectNothingChanged(s);
  });

  it("with OpsCrew's own token as the updater's, or one wider than the zone's DNS", async () => {
    const own = await setup({ token: OWN_TOKEN });
    expect((await refused(own)).message).toContain("is OpsCrew's own Cloudflare token");
    expectNothingChanged(own);

    const wide = await setup({ denied: [] });
    expect((await refused(wide)).message).toContain("is wider than example.com's DNS");
    expectNothingChanged(wide);
    await expectNowhere(wide, [UPDATER]);
  });

  it("beside an app that isn't at home", async () => {
    const s = await setup({ facts: withOtherApp({ facts: homeFacts() }) });
    const error = await refused(s);
    expect(error.message).toContain(
      'The OpsCrew app "blog" on this server is not hosted at home, and this app is.',
    );
    expectNothingChanged(s);
  });

  it("when Cloudflare's IPv6 ranges can't be read for the IPv6 web filter", async () => {
    const s = await setup({ plan: homePlan({ ipv4: false }), ipv6Ranges: [] });
    const error = await refused(s);
    expect(error.code).toBe("PROVIDER_ERROR");
    expect(error.message).toMatch(/^OpsCrew could not read Cloudflare's IP ranges/);
    expectNothingChanged(s);
  });

  it("when SSH's sources aren't known on this computer: run design again", async () => {
    const s = await setup({ own: { home: {} } });
    const error = await refused(s);
    expect(error.message).toBe(
      "OpsCrew doesn't know on this computer which networks may reach your server's SSH at home. Nothing was changed.",
    );
    expect(error.hint).toContain("Run `opscrew design` again");
    expectNothingChanged(s);
  });

  it("while a preview environment runs on this environment's server", async () => {
    const prod = await createTestPhaseDeps();
    await writeArtifact("plan", prod.paths.files.plan, ownPlan());
    await writeArtifact(
      "plan",
      environmentPaths(prod.paths, "preview").files.plan,
      sharedPreviewTestPlan(),
    );
    const dev = await createTestPhaseDeps({
      root: prod.paths.root,
      env: prod.env,
      environment: "dev",
    });
    const plan = homePlan();
    await writeArtifact(
      "plan",
      dev.paths.files.plan,
      DeployPlanSchema.parse({
        ...plan,
        app: { ...plan.app, name: "shop-dev" },
        environment: { ...plan.environment, name: "dev" },
      }),
    );
    const error = await runProvision(dev, {}).then(
      () => undefined,
      (e: unknown) => e as OpsCrewError,
    );
    expect(error?.message).toBe(
      "The previews of the preview environment run on dev's server, and serving it at home would break them. Nothing was changed.",
    );
  });
});

describe("a server at home's parts of provision", () => {
  /** What prepareOwnServer reads of a server at home behind NAT with IPv6. */
  const HOME_RUN: OwnHomeRun = {
    network: { ipv4: "seen", noNat: false, ipv6: "present" },
    lanAddress: LAN_IPV4,
    sshFrom: SSH_FROM,
  };

  it("reads Cloudflare's IPv6 ranges only for a site served over IPv6 behind the proxy", async () => {
    const deps = await createTestPhaseDeps();
    const api = { getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }) };
    expect(await ownWebSources(deps, homePlan(), api)).toEqual({ ipv4: CF_V4 });
    expect(await ownWebSources(deps, homePlan({ ipv4: false }), api)).toEqual({
      ipv4: CF_V4,
      ipv6: CF_V6,
    });
    expect(await ownWebSources(deps, homePlan({ proxied: false }), api)).toBeUndefined();
  });

  it("hands the engine no address, not even one recorded or in this computer's environment", async () => {
    const deps = await createTestPhaseDeps();
    await recordServerAddress(deps.paths, { ipv4: HOME_IPV4 });
    const env: Record<string, string | undefined> = { TF_VAR_server_ipv4: HOME_IPV4 };
    const outputs = async () => ({ server_ipv4: HOME_IPV4 });
    await ownEngineEnv(deps, { target: ownTarget(homePlan()) }, env, outputs);
    expect(env).toEqual({});
  });

  it("gives a runner machine the server's address on the home network with its pinned key", async () => {
    const deps = await createTestPhaseDeps();
    const plan = homePlan();
    const session = {
      connection: { host: LAN_IPV4, port: 22, user: "root", agent: true, hostKey: "" },
      hostKey: { type: "ssh-ed25519", key: ED25519 },
    } as unknown as Parameters<typeof ownDeployTarget>[1]["session"];
    const run = { session, target: ownTarget(plan), sshPort: 22 };
    expect(ownDeployTarget(deps, run, { plan, outputs: {} })).toEqual({
      host: LAN_IPV4,
      knownHosts: `${LAN_IPV4} ssh-ed25519 ${ED25519}\n`,
    });
    expect(ownDeployTarget(deps, { ...run, sshPort: 2222 }, { plan, outputs: {} })).toEqual({
      host: LAN_IPV4,
      knownHosts: `[${LAN_IPV4}]:2222 ssh-ed25519 ${ED25519}\n`,
    });
  });

  it("lets the scheduled check read no disk over SSH at home", () => {
    const plan = homePlan();
    const machine = DeployPlanSchema.parse({
      ...plan,
      environment: { runner: "host", runnerHost: { name: "builder", arch: "amd64" } },
    });
    expect(checkReachesOverSsh(machine)).toBe(false);
    const { home: _home, ...target } = ownTarget(machine);
    expect(checkReachesOverSsh({ ...machine, target })).toBe(true);
  });

  it("says no forwards are needed when the server holds its public IPv4 address", () => {
    const noNat: OwnHomeRun = {
      network: { ipv4: "seen", noNat: true, ipv6: "absent" },
      sshFrom: ["203.0.113.0/24"],
    };
    expect(homeProvisionLines(homePlan(), noNat)).toEqual([
      "Your server has its public IPv4 address itself, so your router needs no forwards.",
      "Merge, then run `npx opscrew verify`, which checks from outside your home.",
    ]);
    expect(homeProvisionLines(ownPlan(), HOME_RUN)).toEqual([]);
  });

  it("names the forwards, SSH's sources and the IPv6 rule with DNS only", () => {
    expect(homeProvisionLines(homePlan({ proxied: false }), HOME_RUN)).toEqual([
      "Your router's settings (set them before you merge: the first deploy fetches its certificate through them):",
      `  On your router, forward TCP 80 and TCP 443 to ${LAN_IPV4}.`,
      `  Reserve ${LAN_IPV4} for this server in the router's DHCP settings so it stays fixed.`,
      "  Don't forward SSH: only 192.168.1.0/24 and fe80::/10 may reach it.",
      `  ${ROUTER_IPV6_RULE}`,
      "Merge, then run `npx opscrew verify`, which checks from outside your home.",
    ]);
  });
});
