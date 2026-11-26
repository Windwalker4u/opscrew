/**
 * `opscrew rotate dns-updater` (plan 6.): the address updater's token of a server at home joins
 * the user's tokens, its expiry from Cloudflare's verify answer; its one copy, the server's file,
 * is replaced through the host plan approved by its hash after the token's checks, and the output
 * names Cloudflare's token page. The token goes nowhere but the host adapter's standard input.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FakeCloudflarePermission,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import { type HostFacts, HostFactsSchema, type HostStep } from "@opscrew/connector-ssh-host";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import type { ProvisionServices } from "../provision/types";
import { recordOwnServer } from "../shared";
import {
  ACCOUNT_ID,
  CF_V4,
  CF_V6,
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
  ownCloudflare,
  ownPlan,
  ownRunner,
  ScriptedApprovalHandler,
} from "../testing";
import { credentialInventory } from "./inventory";
import { credentialsRecordFile, readCredentialsRecord } from "./record";
import { replaceToken, tokenExpiries } from "./tokens";

const NOW = new Date("2026-11-20T10:00:00.000Z");
const OWN_TOKEN = fakeSecret("cloudflare-token", "rotate-own");
const OLD = fakeSecret("cloudflare-token", "updater-old");
const NEW = fakeSecret("cloudflare-token", "updater-new");
const EXPIRY = "2027-03-01T00:00:00Z";
const SSH_FROM = ["192.168.1.0/24", "fe80::/10"];
const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

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

/** `shop` at home behind Cloudflare's proxy over IPv4, deployed by the server's runner. */
function homePlan(): DeployPlan {
  const base = ownPlan({ proxied: true });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: true } },
    security: { ...base.security, httpAllowedFrom: "edge" },
    environment: { runner: "server" },
  });
}

/** A server at home whose address updater runs with the old token. */
function homeFacts(): HostFacts {
  return HostFactsSchema.parse({
    ...freshFacts({
      addresses: [{ interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false }],
    }),
    sshClient: { address: "192.168.1.10", port: 50022 },
    sshFirewall: { nft: true, table: null, files: { rules: null, unit: null }, enabled: false },
    dnsUpdaters: [
      {
        app: "shop",
        config: null,
        configFile: { mode: "600", owner: "root" },
        token: { present: true, mode: "600", owner: "root", sha256: sha256(OLD) },
        timer: { enabled: true, active: true },
        state: null,
      },
    ],
  });
}

interface Setup {
  plan?: DeployPlan;
  /** `OPSCREW_DNS_UPDATER_TOKEN` (default {@link NEW}); `null` leaves it unset. */
  token?: string | null;
  /** What the new token may not do (default: everything but the zone's DNS). */
  denied?: FakeCloudflarePermission[];
  /** The approvals' answer (default: approved). */
  approve?: boolean;
}

async function setup(o: Setup = {}) {
  const plan = o.plan ?? homePlan();
  const project = await createProject(plan);
  const cloudflare = fakeCloudflareAccounts({
    accounts: [{ name: "home", id: ACCOUNT_ID, token: OWN_TOKEN }],
    zones: [{ name: "example.com", account: "home" }],
  });
  for (const token of [OLD, NEW]) {
    cloudflare.tokens.set(token, {
      accounts: [ACCOUNT_ID],
      denied: new Set(token === NEW && o.denied !== undefined ? o.denied : ALL_BUT_DNS),
    });
  }
  const zoneId = cloudflare.zone("example.com", "home").id;
  // Cloudflare's verify answer gives the new token's expiry.
  const fetch: FetchLike = async (input, init) => {
    const answer = await cloudflare.fetch(input, init);
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    if (!String(input).endsWith("/user/tokens/verify") || token !== NEW) return answer;
    const body = (await answer.json()) as { result: Record<string, unknown> };
    return new Response(
      JSON.stringify({ ...body, result: { ...body.result, expires_on: EXPIRY } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const host = new FakeHostServer(homeFacts());
  host.homeNetwork = homeNetworkFacts();
  const handler = new ScriptedApprovalHandler(() => o.approve ?? true);
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPSCREW_HOME: join(project.root, ".home-opscrew"),
    CLOUDFLARE_API_TOKEN: OWN_TOKEN,
  };
  delete env.OPSCREW_DNS_UPDATER_TOKEN;
  if (o.token !== null) env.OPSCREW_DNS_UPDATER_TOKEN = o.token ?? NEW;
  const deps = await createTestPhaseDeps({
    root: project.root,
    env,
    runner: ownRunner(),
    approvalHandler: handler,
    fetch,
    clock: { now: () => NOW },
  });
  await recordOwnServer(deps.paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    hostKey: ED25519_FINGERPRINT,
    serve: "proxy",
    home: { sshFrom: SSH_FROM },
  });
  const runnerGitHub = new FakeRunnerGitHub();
  const services: ProvisionServices = {
    github: new FakeGitHub(),
    cloudflare: {
      ...ownCloudflare(),
      findZone: async () => ({
        id: zoneId,
        name: "example.com",
        status: "active",
        nameServers: [],
        accountId: ACCOUNT_ID,
      }),
      getIpRanges: async () => ({ ipv4: CF_V4, ipv6: CF_V6 }),
    },
    tcpConnect: async () => true,
    sleep: async () => undefined,
    own: { host, homeDir: await mkdtemp(join(tmpdir(), "opscrew-rotate-updater-")) },
    runnerGitHub,
  };
  return { ...project, plan, deps, services, host, handler, cloudflare, runnerGitHub, zoneId };
}

type World = Awaited<ReturnType<typeof setup>>;

const rotate = (w: World) => replaceToken(w.deps, w.plan, "dns-updater", { server: w.services });

async function failure(promise: Promise<unknown>): Promise<OpsCrewError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

function stepOf(w: World, id: string): HostStep | undefined {
  return w.host.applies[0]?.plan.steps.find((step) => step.id === id);
}

/** Every file under `dir`, with its text. */
async function filesUnder(dir: string): Promise<string> {
  const names = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  const texts = await Promise.all(
    names.map((name) => readFile(join(dir, name), "utf8").catch(() => "")),
  );
  return texts.join("\n");
}

/**
 * None of `values` anywhere a run's fakes saw or left (the host adapter's standard input aside):
 * the output, audit log, approvals and error, the project's files (`.opscrew`, `opscrew/` with
 * `credentials.yaml`) and OpsCrew's home, the host plans, and every call to Cloudflare and GitHub's
 * runner API.
 */
async function expectNowhere(w: World, values: readonly string[], error?: unknown): Promise<void> {
  const places: [string, string][] = [
    ["output", w.deps.reporter.text()],
    ["audit", JSON.stringify(w.deps.audit.entries)],
    ["approvals", JSON.stringify(w.handler.requests)],
    ["error", error instanceof OpsCrewError ? `${error.message} ${error.hint ?? ""}` : ""],
    [".opscrew", await filesUnder(join(w.root, ".opscrew"))],
    ["opscrew", await filesUnder(join(w.root, "opscrew"))],
    ["home folder", await filesUnder(join(w.root, ".home-opscrew"))],
    ["host plans", JSON.stringify(w.host.applies.map((apply) => apply.plan))],
    ["Cloudflare calls", JSON.stringify(w.cloudflare.calls)],
    ["runner GitHub calls", JSON.stringify(w.runnerGitHub.calls)],
  ];
  for (const value of values) {
    expect(places.filter(([, text]) => text.includes(value)).map(([where]) => where)).toEqual([]);
  }
}

/** Nothing was asked for or applied, and no rotation recorded. */
async function expectNothingChanged(w: World): Promise<void> {
  expect(w.handler.requests).toEqual([]);
  expect(w.host.applies).toEqual([]);
  expect((await readCredentialsRecord(w.deps)).environments).toEqual({});
}

describe.skipIf(!findExecutable("git"))("opscrew rotate dns-updater", () => {
  it("lists the address updater's token with the user's tokens of a home environment with DNS on Cloudflare, its expiry from Cloudflare", async () => {
    const w = await setup();
    const listed = await credentialInventory(w.deps, w.plan);
    expect(listed.filter((c) => c.kind === "user-token").map((c) => c.name)).toContain(
      "dns-updater",
    );
    const expiries = await tokenExpiries(w.deps, w.plan);
    expect(expiries.find((t) => t.name === "dns-updater")).toEqual({
      name: "dns-updater",
      variable: "OPSCREW_DNS_UPDATER_TOKEN",
      expiresAt: EXPIRY,
    });
    // Listed while unset too: the server holds it.
    const unset = await setup({ token: null });
    const names = (await credentialInventory(unset.deps, unset.plan)).map((c) => c.name);
    expect(names).toContain("dns-updater");

    // Not on a server at home, nor at home with the DNS elsewhere.
    for (const plan of [
      ownPlan({ proxied: true }),
      DeployPlanSchema.parse({
        ...homePlan(),
        dns: { ...homePlan().dns, provider: "none", proxied: false },
        security: { ...homePlan().security, httpAllowedFrom: "any" },
      }),
    ]) {
      const other = await credentialInventory(w.deps, plan);
      expect(other.map((c) => c.name)).not.toContain("dns-updater");
    }
    await expectNowhere(w, [NEW, OLD]);
  });

  it("replaces the server's copy through the host plan approved by its hash, after the token's checks, and names the token page", async () => {
    const w = await setup();
    const result = await rotate(w);

    expect(result).toEqual({
      name: "dns-updater",
      copies: [{ kind: "server-file" }],
      deletePage: TOKEN_PAGE,
    });
    // The token's checks are read-only; one approval, the host plan's, bound to its hash.
    expect(w.cloudflare.calls.length).toBeGreaterThan(0);
    expect(w.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply"]);
    expect(w.host.applies).toHaveLength(1);
    expect(w.host.applies[0]?.options.approvedHash).toBe(w.handler.requests[0]?.planHash);
    // The step names the new token's hash; the token reaches the server on stdin only.
    expect(stepOf(w, "dns-updater")).toMatchObject({
      state: "change",
      params: { app: "shop", zoneId: w.zoneId, name: "shop.example.com", tokenSha256: sha256(NEW) },
    });
    expect(w.host.applies[0]?.options.secrets?.dnsUpdaterToken).toBe(NEW);

    // credentials.yaml: the name and its date, never a value or a fingerprint.
    const record = await readCredentialsRecord(w.deps);
    expect(record.environments.prod?.["dns-updater"]).toEqual({
      rotatedAt: NOW.toISOString(),
      generation: 2,
    });
    const recordText = await readFile(credentialsRecordFile(w.deps.paths), "utf8");
    expect(recordText).not.toContain(sha256(NEW));

    const text = w.deps.reporter.text();
    expect(text).toContain(
      "the address updater's token file on your server (root only), by its host plan, which shows its own hash",
    );
    expect(text).toContain(
      `Delete the old address updater's Cloudflare token at ${TOKEN_PAGE} once every other environment with a copy of it has the new one too`,
    );
    // The proxied app's home addresses are registered as secrets: none goes anywhere either.
    await expectNowhere(w, [NEW, OLD, HOME_IPV4, HOME_IPV6]);

    // The same token again is the one OpsCrew knows now.
    const again = await failure(rotate(w));
    expect(again.code).toBe("INVALID_INPUT");
    expect(again.message).toContain("already knows");
    expect(w.host.applies).toHaveLength(1);
  });

  it("refuses, before any change, without the token, with one wider than the zone's DNS, or with OpsCrew's own", async () => {
    const unset = await setup({ token: null });
    const missing = await failure(rotate(unset));
    expect(missing.code).toBe("CREDENTIALS_MISSING");
    expect(missing.message).toContain("OPSCREW_DNS_UPDATER_TOKEN is not set");
    expect(missing.message).toContain("Nothing was changed.");
    expect(missing.hint).toContain(TOKEN_PAGE);
    expect(unset.host.inspections).toBe(0);
    await expectNothingChanged(unset);

    const wide = await setup({ denied: ALL_BUT_DNS.filter((p) => p !== "ssl") });
    const wider = await failure(rotate(wide));
    expect(wider.code).toBe("CREDENTIALS_INVALID");
    expect(wider.message).toContain(
      "OPSCREW_DNS_UPDATER_TOKEN is wider than example.com's DNS: it can also read the zone's SSL and certificates.",
    );
    expect(wider.message).toContain("Nothing was changed.");
    expect(wider.hint).toContain("Zone → DNS → Edit");
    await expectNothingChanged(wide);
    await expectNowhere(wide, [NEW, HOME_IPV4, HOME_IPV6], wider);

    const own = await setup({ token: OWN_TOKEN });
    const refused = await failure(rotate(own));
    expect(refused.message).toContain("is OpsCrew's own Cloudflare token");
    await expectNothingChanged(own);
    await expectNowhere(own, [OWN_TOKEN], refused);
  });

  it("changes nothing when the host plan is not approved", async () => {
    const w = await setup({ approve: false });
    const error = await failure(rotate(w));
    expect(error.code).toBe("APPROVAL_REFUSED");
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply"]);
    expect(w.host.applies).toEqual([]);
    expect((await readCredentialsRecord(w.deps)).environments).toEqual({});
    await expectNowhere(w, [NEW, HOME_IPV4, HOME_IPV6], error);
  });

  it("refuses an environment without a server at home", async () => {
    const w = await setup({ plan: ownPlan({ proxied: true }) });
    await writeArtifact("plan", w.deps.paths.files.plan, w.plan);
    const error = await failure(rotate(w));
    expect(error.message).toBe(
      "The prod environment does not use an address updater's Cloudflare token, so there is none to replace. Nothing was changed.",
    );
    await expectNothingChanged(w);
  });
});
