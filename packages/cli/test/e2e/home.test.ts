/**
 * End-to-end flow for a server at the user's home (feature 029, quickstart "A user hosts an app at
 * home"): `examples/nextjs-postgres` is driven through the real CLI program in-process, with fakes
 * and no network: `interview --answers` (`server.home yes`, served behind Cloudflare's proxy) →
 * `design --host-key` (the server reads its home network) → `adapt` → `provision --plan-only`,
 * then `--approve` with every hash (the SSH firewall, the address updater with its own token, the
 * server's runner) → `verify` (the outside check on GitHub's machines) → `status` →
 * `rotate dns-updater` → `destroy --confirm <app>` (the updater's records deleted at Cloudflare).
 * The last check scans every output, file, commit and pull request for the tokens and the home's
 * public address, and the repository, its commits and pull requests for the server's address on
 * the home network (the terminal names that one in the router's settings, by design).
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readOwnServer } from "@opscrew/agents";
import {
  CF_V4,
  CF_V6,
  CLOUDFLARE_IPV4,
  CLOUDFLARE_RANGES,
  ED25519_FINGERPRINT,
  FakeGitHub,
  FakeHostServer,
  FakeRunnerGitHub,
  fakeSharedCloudflare,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  OwnEngine,
  ownCloudflare,
} from "@opscrew/agents/testing";
import {
  type FakeCloudflarePermission,
  FakeZone,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import {
  DNS_UPDATER_RECORD_COMMENT,
  type HostFacts,
  HostFactsSchema,
} from "@opscrew/connector-ssh-host";
import type { FetchLike, ResourceChange } from "@opscrew/contracts";
import { resolveProjectPaths } from "@opscrew/core";
import { FakeAgentRuntime, fakeSecret } from "@opscrew/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withServices } from "../../src/deps";
import {
  EXAMPLES_DIR,
  GIT,
  git,
  projectContext,
  run,
  type TempProject,
  tempProject,
} from "../../src/ui/__fixtures__/harness";
import { fakeHome, OwnRunner, ownServices } from "../../src/ui/__fixtures__/own";
import {
  findLeaks,
  initRepoWithBareOrigin,
  listFiles,
  plantedSecrets,
  readPlan,
  ScriptedApprovals,
  snapshotFiles,
} from "./support";

const EXAMPLE = "nextjs-postgres";
const APP = "nextjs-postgres-demo";
const DOMAIN = "shop.example.com";
const NOW = "2026-10-11T12:00:00.000Z";
const RUN_URL = "https://github.com/acme/nextjs-postgres/actions/runs/77";
/** The address this computer connects from, on the home network. */
const CLIENT = "192.168.1.10";
const OWN_TOKEN = fakeSecret("cloudflare-token", "home-e2e-own");
const UPDATER = fakeSecret("cloudflare-token", "home-e2e-updater");
const NEW_UPDATER = fakeSecret("cloudflare-token", "home-e2e-updater-new");
const GITHUB_TOKEN = fakeSecret("github-pat", "home-e2e");
const STEP_TIMEOUT = 120_000;

const ANSWERS = {
  provider: "own",
  expectedMonthlyUsers: "<1k",
  budgetMonthly: "30 EUR",
  uptime: "standard",
  // Data that matters would get scheduled snapshots and their copy off the server, which this
  // flow does not cover.
  dataCriticality: "none",
  domain: DOMAIN,
  dnsProvider: "cloudflare",
  "server.host": LAN_IPV4,
  "server.user": "root",
  "server.key": "agent",
  "server.home": "yes",
  "server.serve": "proxy",
};

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

/** A fresh server at home ({@link LAN_IPV4}), reached from {@link CLIENT}, with nft. */
function homeFacts(): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    sshClient: { address: CLIENT, port: 50022 },
    sshFirewall: { nft: true, table: null, files: { rules: null, unit: null }, enabled: false },
  });
}

/** The updater the host plan set up, as inspection reads it after its run two minutes ago. */
function withUpdater(facts: HostFacts, zoneId: string): HostFacts {
  const seen = { ipv4: HOME_IPV4, ipv6: null };
  return HostFactsSchema.parse({
    ...facts,
    containers: [{ name: `${APP}-app-1`, project: APP, ports: "", running: true }],
    dnsUpdaters: [
      {
        app: APP,
        config: {
          schemaVersion: 1,
          app: APP,
          zoneId,
          name: DOMAIN,
          proxied: true,
          ipv4: true,
          ipv6: false,
        },
        configFile: { mode: "600", owner: "root" },
        token: { present: true, mode: "600", owner: "root", sha256: "c".repeat(64) },
        timer: { enabled: true, active: true },
        state: {
          schemaVersion: 1,
          version: 1,
          lastRun: "2026-10-11T11:58:12Z",
          lastSuccess: "2026-10-11T11:58:12Z",
          seen,
          records: seen,
          lastWrite: { at: "2026-10-11T11:40:00Z", changed: ["A"] },
        },
      },
    ],
  });
}

/** The labelled hashes a `--plan-only` run on a server at home prints. */
function printedHashes(output: string): string[] {
  const hashes = [
    /Cloudflare plan:\s+([0-9a-f]{64})/,
    /infrastructure \(Cloudflare\):\s+([0-9a-f]{64})/,
    /host plan for your server:\s+([0-9a-f]{64})/,
  ].map((pattern) => pattern.exec(output)?.[1]);
  const found = hashes.filter((hash): hash is string => hash !== undefined);
  if (found.length === 0) throw new Error(`No plan hashes in:\n${output}`);
  return found;
}

/**
 * Cloudflare's API (both tokens' checks and the records), GitHub's API (the outside check's run),
 * the site behind Cloudflare and Docker's registry (unavailable): every request this flow may
 * send, recorded. A request to an address instead of a name fails the run.
 */
function fakeInternet(cloudflare: FetchLike) {
  const urls: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    urls.push(url);
    const parsed = new URL(url);
    if (/^[\d.]+$|^\[/.test(parsed.hostname)) throw new Error(`direct request to ${url}`);
    if (parsed.host === "api.cloudflare.com") return cloudflare(input, init);
    if (parsed.host === "api.github.com") {
      if (parsed.pathname.endsWith("/opscrew-outside-check.yml/dispatches")) {
        return Response.json({ workflow_run_id: 77, html_url: RUN_URL });
      }
      if (parsed.pathname.endsWith("/actions/runs/77")) {
        return Response.json({
          id: 77,
          status: "completed",
          conclusion: "success",
          html_url: RUN_URL,
          head_sha: "abc123",
          created_at: NOW,
        });
      }
      if (parsed.pathname.endsWith("/actions/runs/77/attempts/1/jobs")) {
        return Response.json({
          jobs: [
            { name: "http", conclusion: "success" },
            { name: "https", conclusion: "success" },
          ],
        });
      }
      return Response.json({ default_branch: "main", private: true, workflow_runs: [] });
    }
    if (url.startsWith(`http://${DOMAIN}`)) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://${DOMAIN}${parsed.pathname}` },
      });
    }
    if (parsed.host === DOMAIN) {
      return new Response("ok", {
        headers: {
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
          "referrer-policy": "strict-origin-when-cross-origin",
        },
      });
    }
    return new Response("unavailable in tests", { status: 503 });
  };
  return { fetch, urls };
}

describe.skipIf(GIT === undefined)(`example ${EXAMPLE} on a server at home`, () => {
  let project: TempProject;
  let inputs: Map<string, string>;
  let host: FakeHostServer;
  let homeDir: string;
  let zoneId: string;
  const runtime = new FakeAgentRuntime();
  const outputs = new Map<string, string>();
  const engine = new OwnEngine(HOME_CHANGES, { url: `https://${DOMAIN}`, address_updater: true });
  const github = new FakeGitHub();
  const runnerGitHub = new FakeRunnerGitHub();
  let shared: FakeZone;
  // OpsCrew's token and the updater's, both in the account of the zone.
  const cloudflare = fakeCloudflareAccounts({
    accounts: [{ name: "home", id: "0123456789abcdef0123456789abcdef", token: OWN_TOKEN }],
    zones: [{ name: "example.com", account: "home" }],
  });
  for (const token of [UPDATER, NEW_UPDATER]) {
    cloudflare.tokens.set(token, {
      accounts: ["0123456789abcdef0123456789abcdef"],
      denied: new Set(ALL_BUT_DNS),
    });
  }
  const internet = fakeInternet(cloudflare.fetch);

  /** Runs `opscrew <args>` offline with the home fakes attached. */
  async function opscrew(args: string[], approvals?: ScriptedApprovals) {
    const ctx = projectContext(project, {
      services: {
        runtime,
        runner: new OwnRunner(),
        fetch: internet.fetch,
        ...(approvals === undefined ? {} : { approvalHandler: approvals }),
      },
    });
    const own = ownServices(host, homeDir);
    withServices(ctx, {
      provision: {
        engine: async () => engine,
        github,
        cloudflare: {
          ...ownCloudflare(),
          findZone: async () => ({
            id: zoneId,
            name: "example.com",
            status: "active",
            nameServers: [],
            accountId: "0123456789abcdef0123456789abcdef",
          }),
          getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }),
        },
        tcpConnect: async () => true,
        sleep: async () => undefined,
        own,
        sharedCloudflare: fakeSharedCloudflare(shared),
        runnerGitHub,
      },
      verify: {
        resolver: { resolve4: async () => [CLOUDFLARE_IPV4], resolve6: async () => [] },
        tlsConnect: async () => ({
          subjectCommonName: DOMAIN,
          subjectAltNames: [DOMAIN],
          validFrom: "2026-09-20T00:00:00.000Z",
          validTo: "2026-12-18T00:00:00.000Z",
          issuer: "Let's Encrypt",
        }),
        tcpConnect: async (address, port) => {
          throw new Error(`a probe from this computer: ${address}:${port}`);
        },
        cloudflareRanges: CLOUDFLARE_RANGES,
        own: { host, homeDir },
      },
      destroy: {
        engine: async () => engine,
        own,
        github: github as never,
        runnerGitHub,
        sharedCloudflare: fakeSharedCloudflare(shared),
      },
    });
    const code = await run(ctx, ...args);
    outputs.set(`${args.join(" ")} (stdout)`, ctx.output);
    outputs.set(`${args.join(" ")} (stderr)`, ctx.errors);
    return { code, ctx, text: ctx.output + ctx.errors };
  }

  beforeAll(async () => {
    project = await tempProject(EXAMPLE);
    inputs = await snapshotFiles(project.root);
    host = new FakeHostServer(homeFacts());
    host.homeNetwork = homeNetworkFacts();
    homeDir = await fakeHome(project);
    zoneId = cloudflare.zone("example.com", "home").id;
    // OpsCrew shared Cloudflare rules, in the same zone.
    shared = new FakeZone({ zoneId });
    Object.assign(project.env, {
      CLOUDFLARE_API_TOKEN: OWN_TOKEN,
      OPSCREW_DNS_UPDATER_TOKEN: UPDATER,
    });
    await initRepoWithBareOrigin(project, "https://github.com/acme/nextjs-postgres.git");
  }, STEP_TIMEOUT);

  afterAll(async () => {
    await project?.cleanup();
  });

  it(
    "interview records the server at home locally; design reads the home network and names the router's settings",
    async () => {
      expect((await opscrew(["analyze", "--no-ai"])).code).toBe(0);
      const answersFile = path.join(project.dir, "answers.yaml");
      await writeFile(answersFile, `${JSON.stringify(ANSWERS, null, 2)}\n`);
      const interview = await opscrew(["interview", "--answers", answersFile]);
      expect(interview.code, interview.text).toBe(0);
      const paths = resolveProjectPaths(project.root, { env: project.env });
      expect(await readOwnServer(paths)).toMatchObject({ host: LAN_IPV4, home: {} });

      const design = await opscrew(["design", "--host-key", ED25519_FINGERPRINT]);
      expect(design.code, design.text).toBe(0);
      expect(host.detections).toBe(1);
      expect(design.text).toContain(`On your router, forward TCP 80 and TCP 443 to ${LAN_IPV4}.`);
      expect(design.text).toContain("Check your internet provider's terms");
      const plan = await readPlan(project.root);
      expect(plan.target).toMatchObject({ provider: "own", home: { ipv4: true } });
      expect(plan.environment?.runner).toBe("server");
    },
    STEP_TIMEOUT,
  );

  it(
    "adapt --no-ai --no-push commits the templated files",
    async () => {
      const { code, text } = await opscrew(
        ["adapt", "--no-ai", "--no-push"],
        new ScriptedApprovals(["repo-write"]),
      );
      expect(code, text).toBe(0);
      expect(existsSync(path.join(project.root, "Dockerfile"))).toBe(true);
    },
    STEP_TIMEOUT,
  );

  it(
    "provision --plan-only shows the plans; --approve with their hashes sets up SSH from home and the updater",
    async () => {
      const { env, root } = project;
      await git(env, root, "checkout", "-q", "main");
      await git(env, root, "merge", "-q", "--ff-only", "opscrew/prepare-deploy");
      await git(env, root, "push", "-q", "origin", "main");

      const planned = await opscrew(["provision", "--plan-only", "--yes"]);
      expect(planned.code, planned.text).toBe(0);
      expect(host.applies).toEqual([]);
      let hashes = printedHashes(planned.ctx.output);
      let applied = await opscrew([
        "provision",
        ...hashes.flatMap((h) => ["--approve", h]),
        "--yes",
      ]);
      // Each run approves what it can and names the next plan's hash.
      for (let round = 0; applied.code !== 0 && round < 4; round++) {
        const next = [...applied.text.matchAll(/--approve ([0-9a-f]{64})/g)].map((m) => m[1]);
        expect(next.length, applied.text).toBeGreaterThan(0);
        hashes = [...new Set([...hashes, ...(next as string[])])];
        applied = await opscrew(["provision", ...hashes.flatMap((h) => ["--approve", h]), "--yes"]);
      }
      expect(applied.code, applied.text).toBe(0);
      const setup = host.applies.find((a) => a.plan.steps.some((s) => s.id === "dns-updater"));
      expect(setup?.plan.steps.find((s) => s.id === "ssh-firewall")?.params).toMatchObject({
        from: CLIENT,
      });
      expect(setup?.plan.steps.find((s) => s.id === "dns-updater")).toMatchObject({
        state: "change",
        params: { app: APP, name: DOMAIN, proxied: true, ipv4: true },
      });
      expect(setup?.options.secrets?.dnsUpdaterToken).toBe(UPDATER);
      expect(applied.text).toContain("forward TCP 80 and TCP 443");
      expect(github.pulls).toEqual([expect.objectContaining({ head: "opscrew/deploy-setup" })]);
      // The deploy-setup pull request is merged.
      await git(env, root, "checkout", "-q", "main");
      await git(env, root, "merge", "-q", "--ff-only", "opscrew/deploy-setup");
      await git(env, root, "push", "-q", "origin", "main");
      // The updater ran on the server: it keeps the site's A record at the home's address.
      host.facts = withUpdater(host.facts, zoneId);
      cloudflare.addRecord(cloudflare.zone("example.com", "home"), {
        type: "A",
        name: DOMAIN,
        content: HOME_IPV4,
        proxied: true,
        comment: DNS_UPDATER_RECORD_COMMENT,
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "verify starts the outside check on GitHub's machines and reads the updater over SSH",
    async () => {
      project.env.GITHUB_TOKEN = GITHUB_TOKEN;
      const verified = await opscrew(["verify"]);
      delete project.env.GITHUB_TOKEN;
      expect(verified.text).toContain("Port 443 answered from outside your home");
      expect(internet.urls.filter((url) => url.endsWith("/dispatches"))).toHaveLength(1);
    },
    STEP_TIMEOUT,
  );

  it(
    "status from the home network shows the updater, its address hidden behind the proxy",
    async () => {
      const status = await opscrew(["status"]);
      expect(status.code, status.text).toBe(0);
      expect(status.text).toContain("Updater      every 2 minutes · last run 11:58 UTC, ok");
      expect(status.text).toContain("IPv4 (hidden: behind Cloudflare's proxy)");
    },
    STEP_TIMEOUT,
  );

  it(
    "rotate dns-updater puts the new token on the server through its host plan",
    async () => {
      project.env.OPSCREW_DNS_UPDATER_TOKEN = NEW_UPDATER;
      const before = host.applies.length;
      const shown = await opscrew(["rotate", "dns-updater"]);
      const hash = /--approve ([0-9a-f]{64})/.exec(shown.text)?.[1];
      expect(hash, shown.text).toBeDefined();
      expect(host.applies).toHaveLength(before);
      const rotated = await opscrew(["rotate", "dns-updater", "--approve", hash as string]);
      expect(rotated.code, rotated.text).toBe(0);
      expect(host.applies.at(-1)?.options.secrets?.dnsUpdaterToken).toBe(NEW_UPDATER);
      expect(rotated.text).toContain("https://dash.cloudflare.com/profile/api-tokens");
    },
    STEP_TIMEOUT,
  );

  it(
    "destroy --confirm <app> removes the app and deletes the updater's records at Cloudflare",
    async () => {
      const zone = cloudflare.zone("example.com", "home");
      expect(zone.records.some((r) => r.comment === DNS_UPDATER_RECORD_COMMENT)).toBe(true);
      const destroyed = await opscrew(["destroy", "--confirm", APP]);
      expect(destroyed.code, destroyed.text).toBe(0);
      expect(zone.records.some((r) => r.comment === DNS_UPDATER_RECORD_COMMENT)).toBe(false);
      expect(destroyed.text).toContain("Deleted the address updater's records");
      expect(destroyed.text).toContain("https://dash.cloudflare.com/profile/api-tokens");
    },
    STEP_TIMEOUT,
  );

  it(
    "never shows or writes a token, the home's public address, or the server's home address in the repository",
    async () => {
      const { env, root } = project;
      const tokens = [OWN_TOKEN, UPDATER, NEW_UPDATER, GITHUB_TOKEN];
      const planted = await plantedSecrets(path.join(EXAMPLES_DIR, EXAMPLE));
      const leaks = await findLeaks({
        secrets: [...planted, ...tokens, HOME_IPV4, HOME_IPV6],
        texts: outputs,
        dir: project.dir,
        inputs,
      });
      expect(leaks).toEqual([]);
      // The server's address on the home network: on this computer only (.opscrew/server.json),
      // never in what the repository, a commit or a pull request holds.
      const branches = (await git(env, root, "branch", "--format=%(refname:short)")).split("\n");
      for (const branch of branches.filter((b) => b !== "")) {
        const files = (await git(env, root, "ls-tree", "-r", "--name-only", branch))
          .split("\n")
          .filter((file) => file !== "");
        for (const file of files) {
          expect(await git(env, root, "show", `${branch}:${file}`), file).not.toContain(LAN_IPV4);
        }
        expect(await git(env, root, "log", "--format=%B", branch)).not.toContain(LAN_IPV4);
      }
      expect(JSON.stringify(github.pulls)).not.toContain(LAN_IPV4);
      for (const file of await listFiles(path.join(root, "opscrew"))) {
        expect(await readFile(file, "utf8"), file).not.toContain(LAN_IPV4);
      }
    },
    STEP_TIMEOUT,
  );
});
