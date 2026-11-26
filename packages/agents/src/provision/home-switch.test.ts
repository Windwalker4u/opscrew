/**
 * Switching a server the user owns into and out of home (plan 14., H4; research R12): from public
 * mode nothing is removed first; from the tunnel the removal goes first, its host change without
 * the address updater; leaving home, a host plan approved by its hash removes the updater, then
 * its records are deleted at Cloudflare through their own approved plan, then for a tunnel the
 * home root's records go in the removal, then the new setup. No address of the home goes anywhere.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareClient } from "@opscrew/connector-cloudflare";
import {
  type FakeCloudflarePermission,
  FakeZone,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import {
  DNS_UPDATER_RECORD_COMMENT,
  type HostFacts,
  HostFactsSchema,
  type HostStep,
  tunnelOf,
} from "@opscrew/connector-ssh-host";
import type { ApprovalRequest, ResourceChange } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { renderOutsideCheckWorkflow } from "@opscrew/iac-templates";
import {
  type DeployPlan,
  DeployPlanSchema,
  readArtifact,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { type OwnServerConnectionInput, recordOwnServer } from "../shared";
import { deleteTunnelIn, fakeTunnelApi } from "../shared/__fixtures__/tunnel";
import {
  ACCOUNT_ID,
  createProject,
  createTestPhaseDeps,
  ED25519_FINGERPRINT,
  FakeGitHub,
  FakeHostServer,
  FakeRunnerGitHub,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  OWN_IPV4,
  OwnEngine,
  ownCloudflare,
  ownPlan,
  ownRunner,
  PUBLIC_CHANGES,
  publicOutputs,
  ScriptedApprovalHandler,
  TUNNEL_CHANGES,
  TUNNEL_ID,
  tunnelOutputs,
} from "../testing";
import { runProvision } from "./run";
import type { ProvisionServices } from "./types";

const OWN_TOKEN = fakeSecret("cloudflare-token", "switch-own");
const UPDATER = fakeSecret("cloudflare-token", "switch-updater");
const SERVICE_SECRET = fakeSecret("generic-password", "switch-access");
const TUNNEL_TOKEN = `eyJ${fakeSecret("cloudflare-token", "switch-tunnel")}`;
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];
const NAME = "shop.example.com";

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

/** The outputs of an applied home root with its DNS on Cloudflare. */
const HOME_OUTPUTS = { url: `https://${NAME}`, address_updater: true };

const dnsRecord = (address: string, action: ResourceChange["action"]): ResourceChange => ({
  address: `module.dns.cloudflare_dns_record.${address}`,
  type: "cloudflare_dns_record",
  name: address.replace(/\[.*$/, ""),
  provider: "registry.opentofu.org/cloudflare/cloudflare",
  action,
});

/** What the home root's plan changes from public mode: the A record goes, the CAA stays. */
const FROM_PUBLIC = [dnsRecord("a[0]", "delete")];

/** What the home root's plan changes after the tunnel's removal: the CAA record comes. */
const FROM_NOTHING = [dnsRecord('caa["letsencrypt.org"]', "create")];

/** `shop` at home behind the proxy over IPv4, deployed by the server's runner. */
function homePlan(): DeployPlan {
  const base = ownPlan();
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: true } },
    security: { ...base.security, httpAllowedFrom: "edge" },
    environment: { runner: "server" },
  });
}

/** The app's address updater as inspection reads it on the server. */
function updaterOn(zoneId: string): NonNullable<HostFacts["dnsUpdaters"]>[number] {
  return {
    app: "shop",
    config: {
      schemaVersion: 1,
      app: "shop",
      zoneId,
      name: NAME,
      proxied: true,
      ipv4: true,
      ipv6: false,
    },
    configFile: { mode: "600", owner: "root" },
    token: { present: true, mode: "600", owner: "root", sha256: sha256(UPDATER) },
    timer: { enabled: true, active: true },
    state: null,
  };
}

interface SwitchSetup {
  /** The new plan (`opscrew/plan.yaml` after design). */
  plan: DeployPlan;
  /** The outputs the last apply left in the state. */
  last: Record<string, unknown>;
  /** What the new plan changes, and the outputs its apply leaves. */
  changes: ResourceChange[];
  next: Record<string, unknown>;
  /** The server before the run (its zone id given). */
  facts: (zoneId: string) => HostFacts;
  /** The login this computer keeps (`.opscrew/server.json` → `own`). */
  own: OwnServerConnectionInput;
  /** The last setup had the tunnel: its connector runs, and the removal deletes it. */
  fromTunnel?: boolean;
  /** Which approvals the user gives (default all). */
  answer?: (request: ApprovalRequest) => boolean;
  /** No state on this computer: the last setup's root never needed an apply. */
  noState?: boolean;
}

async function setup(o: SwitchSetup) {
  const events: string[] = [];
  const project = await createProject(o.plan);
  const cloudflare = fakeCloudflareAccounts({
    accounts: [{ name: "home", id: ACCOUNT_ID, token: OWN_TOKEN }],
    zones: [{ name: "example.com", account: "home" }],
  });
  cloudflare.tokens.set(UPDATER, { accounts: [ACCOUNT_ID], denied: new Set(ALL_BUT_DNS) });
  const zone = cloudflare.zone("example.com", "home");
  const zoneId = zone.id;
  // The records the updater kept at the home's address, and one of OpsCrew's own that stays.
  for (const [type, content] of [
    ["A", HOME_IPV4],
    ["AAAA", HOME_IPV6],
  ] as const) {
    cloudflare.addRecord(zone, {
      type,
      name: NAME,
      content,
      proxied: true,
      ttl: 1,
      comment: DNS_UPDATER_RECORD_COMMENT,
    });
  }
  cloudflare.addRecord(zone, {
    type: "CAA",
    name: NAME,
    data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
  });
  const engine = deleteTunnelIn(
    new OwnEngine(o.changes, o.next, o.last),
    events,
    (options, summary) =>
      o.fromTunnel === true && options?.destroy === true && summary.changes.length > 0,
  );
  const host = new FakeHostServer(HostFactsSchema.parse(o.facts(zoneId)));
  host.homeNetwork = homeNetworkFacts();
  const apply = host.apply.bind(host);
  host.apply = async (remote, plan, options) => {
    events.push("host");
    const result = await apply(remote, plan, options);
    // The real server has no instance of the app's updater once a step removed it.
    const removed = plan.steps.some(
      (step) => step.id === "dns-updater" && step.params.remove === true,
    );
    if (removed) {
      host.facts = {
        ...host.facts,
        dnsUpdaters: (host.facts.dnsUpdaters ?? []).filter((item) => item.app !== "shop"),
      };
    }
    return result;
  };
  const tunnelApi = fakeTunnelApi({
    events,
    connectorRunning: () => tunnelOf(host.facts, "shop").running,
    closeAfter: 0,
  });
  const fetch = async (url: string | URL, init?: RequestInit) => {
    const text = String(url);
    if (text.includes("/cfd_tunnel/")) return tunnelApi.fetch(url, init);
    if (init?.method === "DELETE" && text.includes("/dns_records/")) events.push("records-delete");
    return cloudflare.fetch(url, init);
  };
  const handler = new ScriptedApprovalHandler((request) => {
    events.push(`approve:${request.kind}`);
    return o.answer?.(request) ?? true;
  });
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: OWN_TOKEN,
    OPSCREW_DNS_UPDATER_TOKEN: UPDATER,
  };
  delete env.TF_VAR_server_ipv4;
  delete env.TF_VAR_server_ipv6;
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    approvalHandler: handler,
    fetch,
  });
  await recordOwnServer(deps.paths, o.own);
  // The last run applied the old setup: its state is on this computer.
  if (o.noState !== true) {
    await mkdir(deps.paths.files.tfstateDir, { recursive: true });
    await writeFile(join(deps.paths.files.tfstateDir, "prod.tfstate"), "{}");
  }
  const github = new FakeGitHub();
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
    },
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir: await mkdtemp(join(tmpdir(), "opscrew-home-switch-")) },
    sharedCloudflare: new CloudflareClient({
      token: fakeSecret("cloudflare-token", "switch-shared"),
      fetch: new FakeZone({ zoneId }).fetch,
      sleep: async () => undefined,
    }),
    runnerGitHub: new FakeRunnerGitHub(),
  };
  /** The updater's records Cloudflare holds now. */
  const updaterRecords = () =>
    zone.records
      .filter((record) => record.comment === DNS_UPDATER_RECORD_COMMENT)
      .map((record) => `${record.type} ${record.name}`)
      .sort();
  const fakes = { engine, host, handler, github, events, zone };
  return { ...project, ...fakes, deps, services, updaterRecords };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const provision = (s: Setup, options: Parameters<typeof runProvision>[1] = {}) =>
  runProvision(s.deps, { services: s.services, hostKey: ED25519_FINGERPRINT, ...options });

/** A server that has the app's updater, as provision at home left it. */
function withUpdater(zoneId: string): HostFacts {
  return HostFactsSchema.parse({ ...freshFacts(), dnsUpdaters: [updaterOn(zoneId)] });
}

/** The public login of a server that leaves home (design asked for its public address). */
const PUBLIC_LOGIN: OwnServerConnectionInput = {
  host: OWN_IPV4,
  port: 22,
  user: "root",
  agent: true,
  reachable: true,
  hostKey: ED25519_FINGERPRINT,
};

/** The login of a server at home, on the home network. */
const HOME_LOGIN: OwnServerConnectionInput = {
  host: LAN_IPV4,
  port: 22,
  user: "root",
  agent: true,
  serve: "proxy",
  hostKey: ED25519_FINGERPRINT,
  home: { sshFrom: SSH_FROM },
};

/** A fresh server at home reached from the home network, with nft. */
function homeFacts(): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    sshClient: { address: "192.168.1.10", port: 50022 },
    sshFirewall: { nft: true, table: null, files: { rules: null, unit: null }, enabled: false },
  });
}

function stepIn(s: Setup, apply: number, id: string): HostStep | undefined {
  return s.host.applies[apply]?.plan.steps.find((step) => step.id === id);
}

/** What the run committed and sent to GitHub: the files, commit messages, pull requests, secrets. */
async function atGitHub(s: Setup): Promise<string> {
  const committed = (await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD"))
    .split("\n")
    .filter((name) => name !== "");
  const files = await Promise.all(
    committed.map((name) => readFile(join(s.root, name), "utf8").catch(() => "")),
  );
  const messages = await s.git(s.root, "log", "--format=%B");
  return JSON.stringify([files, messages, s.github.pulls, [...s.github.secrets]]);
}

/** Everything the run said, recorded and asked, the host plans, and what reached GitHub. */
async function seen(s: Setup): Promise<string> {
  return JSON.stringify([
    s.deps.reporter.text(),
    s.deps.audit.entries,
    s.handler.requests,
    s.host.applies.map((apply) => apply.plan),
    await atGitHub(s),
  ]);
}

describe.skipIf(!findExecutable("git"))("leaving home on one server", () => {
  it("to public mode: the host plan removes the updater, its records go after their own approval, then the new setup without a removal", async () => {
    const s = await setup({
      plan: ownPlan({ access: "public" }),
      last: HOME_OUTPUTS,
      changes: PUBLIC_CHANGES,
      next: publicOutputs(),
      facts: withUpdater,
      own: PUBLIC_LOGIN,
    });
    await provision(s);

    expect(s.events.slice(0, 5)).toEqual([
      "approve:host-apply",
      "host",
      "approve:cloudflare-apply",
      "records-delete",
      "records-delete",
    ]);
    // The new setup's plan, never a removal of the home root.
    expect(s.engine.plans.map((plan) => plan.destroy)).toEqual([false]);
    expect(s.engine.applies.map((apply) => apply.destroy)).toEqual([false]);
    const updater = stepIn(s, 0, "dns-updater");
    expect(updater).toMatchObject({ state: "change", params: { remove: true, apps: "shop" } });
    expect(stepIn(s, 0, "app-record")?.params).not.toHaveProperty("homeIpv4");
    // The deletion is its own Cloudflare plan, approved with the app's name typed.
    const deletion = s.handler.requests[1];
    expect(deletion).toMatchObject({
      kind: "cloudflare-apply",
      title: "Delete the address updater's records of shop at Cloudflare",
      allowDestroy: true,
      confirmPhrase: "shop",
    });
    expect(deletion?.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.updaterRecords()).toEqual([]);
    expect(s.zone.records.map((record) => record.type)).toContain("CAA");
    // The host plan after the new setup's apply finds the server switched already.
    expect(s.events.filter((event) => event === "host")).toHaveLength(1);
    const plan = await readArtifact("plan", s.deps.paths.files.plan);
    expect(plan.approvals.map((approval) => approval.kind)[0]).toBe("host-apply");
    expect(s.deps.reporter.text()).toContain(
      "Your server switches from serving the app from your home to serving the app directly on its public address. OpsCrew first removes the address updater from your server (the host plan below), then deletes the records it kept at Cloudflare, then sets up the new one.",
    );
    const text = await seen(s);
    for (const value of [HOME_IPV4, HOME_IPV6, UPDATER]) expect(text).not.toContain(value);
  });

  it("to the tunnel: the updater and its records first, then the home root's records in the removal, then the tunnel", async () => {
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      last: HOME_OUTPUTS,
      changes: TUNNEL_CHANGES,
      next: tunnelOutputs({
        token: TUNNEL_TOKEN,
        clientId: "client-id",
        clientSecret: SERVICE_SECRET,
      }),
      facts: withUpdater,
      own: PUBLIC_LOGIN,
    });
    await provision(s);

    expect(s.events.slice(0, 7)).toEqual([
      "approve:host-apply",
      "host",
      "approve:cloudflare-apply",
      "records-delete",
      "records-delete",
      "approve:iac-apply",
      "iac-apply",
    ]);
    expect(s.handler.requests[2]?.title).toBe(
      "Remove the DNS records of your server at home before switching your server to serving the app through a Cloudflare Tunnel (first of two applies)",
    );
    expect(s.engine.applies.map((apply) => apply.destroy)).toEqual([true, false]);
    // The first host plan keeps the server served directly, with no connector yet (the tunnel
    // comes with the new setup's apply, whose host plan switches the server).
    expect(stepIn(s, 0, "dns-updater")?.params.remove).toBe(true);
    expect(stepIn(s, 0, "app-record")?.params.access).toBe("public");
    expect(stepIn(s, 0, "tunnel-connector")).toBeUndefined();
    expect(stepIn(s, 1, "app-record")?.params.access).toBe("tunnel");
    expect(s.updaterRecords()).toEqual([]);
    // The last host plan sets up the connector of the tunnel the apply created.
    expect(stepIn(s, 1, "tunnel-connector")?.params.tunnelId).toBe(TUNNEL_ID);
    const text = await seen(s);
    for (const value of [HOME_IPV4, HOME_IPV6, UPDATER]) expect(text).not.toContain(value);
  });

  it("to the tunnel from a home setup whose root never needed an apply: own.home says the server is at home", async () => {
    // At home with its DNS on Cloudflare and no `www`, the home root holds nothing to apply, so
    // no state was ever written (found by the live home pass, H7).
    const s = await setup({
      plan: ownPlan({ access: "tunnel" }),
      last: {},
      changes: TUNNEL_CHANGES,
      next: tunnelOutputs({
        token: TUNNEL_TOKEN,
        clientId: "client-id",
        clientSecret: SERVICE_SECRET,
      }),
      facts: withUpdater,
      own: HOME_LOGIN,
      noState: true,
    });
    await provision(s);

    expect(s.events.slice(0, 5)).toEqual([
      "approve:host-apply",
      "host",
      "approve:cloudflare-apply",
      "records-delete",
      "records-delete",
    ]);
    // Nothing of the home root to remove: the new setup's apply alone, after the records went.
    expect(s.engine.applies.map((apply) => apply.destroy)).toEqual([false]);
    expect(stepIn(s, 0, "dns-updater")?.params.remove).toBe(true);
    expect(s.updaterRecords()).toEqual([]);
  });

  it("a refused deletion of the records stops before the new setup, and a rerun deletes them", async () => {
    let refuse = true;
    const s = await setup({
      plan: ownPlan({ access: "public" }),
      last: HOME_OUTPUTS,
      changes: PUBLIC_CHANGES,
      next: publicOutputs(),
      facts: withUpdater,
      own: PUBLIC_LOGIN,
      answer: (request) => !(refuse && request.title.startsWith("Delete the address updater's")),
    });
    const error = await provision(s).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).message).toBe(
      "The deletion of the address updater's records was not approved. Nothing in Cloudflare was changed.",
    );
    expect(s.updaterRecords()).toEqual([`A ${NAME}`, `AAAA ${NAME}`]);
    expect(s.engine.applies).toEqual([]);

    refuse = false;
    s.events.length = 0;
    await provision(s);
    // The updater is off the server already: no host change goes first this time.
    expect(s.events.slice(0, 3)).toEqual([
      "approve:cloudflare-apply",
      "records-delete",
      "records-delete",
    ]);
    expect(s.updaterRecords()).toEqual([]);
    expect(s.engine.applies.map((apply) => apply.destroy)).toEqual([false]);
  });

  it("--plan-only shows the host plan and the records' deletion with their hashes; approving them applies both", async () => {
    const s = await setup({
      plan: ownPlan({ access: "public" }),
      last: HOME_OUTPUTS,
      changes: PUBLIC_CHANGES,
      next: publicOutputs(),
      facts: withUpdater,
      own: PUBLIC_LOGIN,
    });
    const planned = await provision(s, { planOnly: true });
    // Only the files are written: nothing on the server, in Cloudflare or the state changes.
    expect(s.events).toEqual(["approve:repo-write"]);
    expect(s.updaterRecords()).toEqual([`A ${NAME}`, `AAAA ${NAME}`]);
    const text = s.deps.reporter.text();
    const line = /--approve ([0-9a-f]{64}) --approve ([0-9a-f]{64}) --confirm shop\./.exec(text);
    expect(line).not.toBeNull();
    const [, hostHash, recordsHash] = line as RegExpExecArray;
    expect(text).toContain(
      `Then OpsCrew deletes the address updater's records of shop at Cloudflare (A ${NAME}, AAAA ${NAME}; plan hash ${recordsHash}).`,
    );
    // The new setup's host plan is the same plan: the switch's host change is all it changes.
    expect(planned.hostPlanHash).toBe(hostHash);
    // Both are in the result, so the run's approval command names them, with the app's name for
    // the records' deletion (found by the live home pass, H7).
    expect(planned).toMatchObject({
      leaveHomeHostPlanHash: hostHash,
      homeRecordsPlanHash: recordsHash,
    });

    await provision(s, {
      approveHashes: [
        hostHash as string,
        recordsHash as string,
        planned.planHash as string,
        ...(planned.cloudflarePlanHash !== undefined ? [planned.cloudflarePlanHash] : []),
      ],
    });
    expect(s.host.applies[0]?.options.approvedHash).toBe(hostHash);
    const deletion = s.handler.requests.find((request) =>
      request.title.startsWith("Delete the address updater's"),
    );
    expect(deletion?.planHash).toBe(recordsHash);
    expect(s.updaterRecords()).toEqual([]);
  });

  /** A switch to public mode of a repository whose merged pull request brought the outside check. */
  async function leavingWithOutsideCheck(o: { stagingAtHome?: boolean } = {}) {
    const s = await setup({
      plan: ownPlan({ access: "public" }),
      last: HOME_OUTPUTS,
      changes: PUBLIC_CHANGES,
      next: publicOutputs(),
      facts: withUpdater,
      own: PUBLIC_LOGIN,
    });
    // The deploy workflow is there too, so this run's pull request updates the deployment.
    const workflow = renderOutsideCheckWorkflow();
    const deploy = (await readArtifact("plan", s.deps.paths.files.plan)).cicd.workflowPath;
    await mkdir(join(s.root, ".github", "workflows"), { recursive: true });
    await writeFile(join(s.root, workflow.path), workflow.content);
    await writeFile(join(s.root, deploy), "name: an earlier deploy workflow\n");
    await s.git(s.root, "add", workflow.path, deploy);
    await s.git(s.root, "commit", "-m", "the deployment at home");
    if (o.stagingAtHome === true) {
      // Another environment of the repository is deployed at home.
      const home = homePlan();
      await writeArtifact(
        "plan",
        join(s.root, "opscrew", "environments", "staging", "plan.yaml"),
        DeployPlanSchema.parse({
          ...home,
          app: { ...home.app, name: "shop-staging" },
          dns: { ...home.dns, domain: "staging.example.com" },
          environment: { ...home.environment, name: "staging" },
          deployment: { ...home.deployment, lastApplyAt: "2026-10-14T12:00:00.000Z" },
        }),
      );
    }
    return { s, path: workflow.path };
  }

  it("with the repository's last app at home, the pull request removes the outside check's workflow", async () => {
    const { s, path } = await leavingWithOutsideCheck();
    await provision(s);
    expect(await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD")).not.toContain(path);
    expect(await s.git(s.root, "ls-tree", "-r", "--name-only", "main")).toContain(path);
    expect(s.github.pulls).toHaveLength(1);
    expect(s.github.pulls[0]?.body).toContain(
      `- \`${path}\`: removed, since no app of this repository is at home any more.`,
    );
    expect(s.deps.reporter.text()).toContain(
      "No app of this repository is at home any more, so the pull request removes the outside check's workflow.",
    );
    const text = await seen(s);
    for (const value of [HOME_IPV4, HOME_IPV6, UPDATER]) expect(text).not.toContain(value);
  });

  it("keeps the outside check's workflow while another environment is at home", async () => {
    const { s, path } = await leavingWithOutsideCheck({ stagingAtHome: true });
    await provision(s);
    expect(await s.git(s.root, "ls-tree", "-r", "--name-only", "HEAD")).toContain(path);
    expect(s.deps.reporter.text()).not.toContain("removes the outside check's workflow");
  });
});

describe.skipIf(!findExecutable("git"))("coming home on one server", () => {
  it("from public mode: no removal; the home root's plan deletes the A record, then the host plan sets up the updater", async () => {
    const s = await setup({
      plan: homePlan(),
      last: publicOutputs(),
      changes: FROM_PUBLIC,
      next: HOME_OUTPUTS,
      facts: homeFacts,
      own: HOME_LOGIN,
    });
    // Nothing of the updater's is there yet.
    s.zone.records.splice(0, 2);
    await provision(s);

    expect(s.engine.plans.map((plan) => plan.destroy)).toEqual([false]);
    expect(s.deps.reporter.text()).not.toContain("Your server switches from");
    expect(s.events.indexOf("iac-apply")).toBeLessThan(s.events.indexOf("host"));
    expect(stepIn(s, 0, "dns-updater")).toMatchObject({
      state: "change",
      params: { app: "shop", name: NAME, tokenSha256: sha256(UPDATER) },
    });

    // The deploy-setup pull request brings the outside check and names the router's settings.
    const workflow = renderOutsideCheckWorkflow();
    const committed = await s.git(s.root, "show", "--name-only", "--format=", "HEAD");
    expect(committed.split("\n")).toContain(workflow.path);
    expect(await readFile(join(s.root, workflow.path), "utf8")).toBe(workflow.content);
    const body = s.github.pulls[0]?.body ?? "";
    expect(body).toContain(
      "- `.github/workflows/opscrew-outside-check.yml`: the outside check, which `opscrew verify` starts.",
    );
    expect(body).toContain(
      "**Before merging, set your router** (so Cloudflare reaches your server). `opscrew provision` named the server's address on your home network, which is never written here:\n- On your router, forward TCP 80 and TCP 443 to this server's address on your network.",
    );
    // No address of the home, and none of its network, in the repository or at GitHub.
    const published = await atGitHub(s);
    for (const value of [LAN_IPV4, ...SSH_FROM, HOME_IPV4, HOME_IPV6, UPDATER]) {
      expect(published).not.toContain(value);
    }
  });

  it("from the tunnel: the removal's host change goes first without the updater, whose first run would meet the tunnel's record", async () => {
    const tunnelAt = (): HostFacts => {
      const facts = homeFacts();
      return HostFactsSchema.parse({
        ...facts,
        tunnels: [
          {
            app: "shop",
            installed: true,
            composeSha256: "0".repeat(64),
            running: true,
            secretFile: true,
            dataVolume: false,
            tunnelId: TUNNEL_ID,
          },
        ],
      });
    };
    const s = await setup({
      plan: homePlan(),
      last: tunnelOutputs({
        token: TUNNEL_TOKEN,
        clientId: "client-id",
        clientSecret: SERVICE_SECRET,
      }),
      changes: FROM_NOTHING,
      next: HOME_OUTPUTS,
      facts: tunnelAt,
      own: HOME_LOGIN,
      fromTunnel: true,
    });
    s.zone.records.splice(0, 2);
    await provision(s);

    expect(s.events.slice(0, 5)).toEqual([
      "approve:iac-apply",
      "approve:host-apply",
      "host",
      "poll",
      "iac-apply",
    ]);
    expect(s.handler.requests[0]?.title).toBe(
      "Remove the Cloudflare Tunnel, its DNS records and Access before switching your server to serving the app from your home (first of two applies)",
    );
    // The host change before the removal stops the connector and limits SSH, without the updater.
    expect(stepIn(s, 0, "tunnel-connector")?.params.remove).toBe(true);
    expect(stepIn(s, 0, "ssh-firewall")?.state).toBe("change");
    expect(stepIn(s, 0, "dns-updater")).toBeUndefined();
    // The host plan after the new setup's apply sets the updater up, its token on stdin only.
    expect(stepIn(s, 1, "dns-updater")).toMatchObject({
      state: "change",
      params: { tokenSha256: sha256(UPDATER) },
    });
    expect(s.host.applies[1]?.options.secrets?.dnsUpdaterToken).toBe(UPDATER);
    expect(s.engine.applies.map((apply) => apply.destroy)).toEqual([true, false]);
  });
});
