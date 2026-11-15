import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SHARED_RULES, type SharedChange, type SharedRecord } from "@opscrew/connector-cloudflare";
import type { FakeCloudflareZone } from "@opscrew/connector-cloudflare/testing";
import { portainerClient } from "@opscrew/connector-portainer";
import { findExecutable, fingerprintSha256 } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { PORTAINER_STACK_VARIABLES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  edgeReadCommand,
  keepCertificateRequest,
  type OriginTlsStep,
  originTlsApply,
  planOriginTls,
  portainerOriginTls,
  promoteNextOriginTls,
  readOriginTlsValues,
} from "../provision/origin-tls";
import { applySharedCloudflare, planSharedCloudflare } from "../provision/shared-cloudflare";
import { recordPortainerConnection } from "../shared/server-record";
import {
  fakeCertificate,
  fakePortainer,
  ownPlan,
  PORTAINER_URL,
  portainerPlan,
  type ScriptedApprovalHandler,
  sitePlan,
} from "../testing";
import { appProgressFile, readAppProgress, writePending } from "./progress";
import { type MoveHarness, moveHarness, serverPlan, unencrypted, ZONE } from "./session.fakes";
import {
  aSharedRecordPath,
  bSharedRecordPath,
  planBShared,
  removeBShared,
  revokeAOrigin,
} from "./shared";
import type { MoveEnvironment, MoveSession, StepStop } from "./types";

const PROBES = SHARED_RULES["opscrew-block-probes"].phase;
const STRICT = SHARED_RULES["opscrew-strict-tls"].phase;
const REDIRECT = SHARED_RULES["opscrew-www-redirect"].phase;
const PORTAINER_TOKEN = fakeSecret("generic-password", "move portainer token");

/** A Portainer stack whose Caddy is the origin behind Cloudflare's proxy. */
function portainerCaddy(): DeployPlan {
  const plan = portainerPlan({ web: { mode: "caddy" }, deployed: true });
  return unencrypted(DeployPlanSchema.parse({ ...plan, dns: { ...plan.dns, proxied: true } }));
}

const TARGETS = {
  "a proxied cloud server": () => serverPlan(),
  "Portainer in Caddy mode": portainerCaddy,
  "an own server in tunnel mode": () => unencrypted(ownPlan({ access: "tunnel", deployed: true })),
  "an own server with Portainer on a subdomain": () =>
    unencrypted(ownPlan({ access: "tunnel", portainer: "subdomain", deployed: true })),
  "a Workers site with www": () =>
    unencrypted(sitePlan({ domain: ZONE, www: true, deployed: true })),
} as const;
type Target = keyof typeof TARGETS;

interface Moving {
  h: MoveHarness;
  session: MoveSession;
  env: MoveEnvironment;
  handler: ScriptedApprovalHandler;
  a: FakeCloudflareZone;
  b: FakeCloudflareZone;
}

/**
 * A move of `target`'s app from Old to New's pending zone, with the app deployed in Old as
 * provision leaves it: its shared plan applied there, with its origin TLS when it has one.
 */
async function moving(target: Target): Promise<Moving> {
  const plan = TARGETS[target]();
  const h = await moveHarness({ bZone: true, plans: () => ({ prod: plan }) });
  const session = await h.open({ to: "New" });
  const env = session.environments[0] as MoveEnvironment;
  const deps = { ...h.deps, paths: env.paths };
  const { a } = session.accounts;
  const tls =
    plan.target.provider === "cloudflare-workers"
      ? undefined
      : await planOriginTls(deps, { plan, record: undefined, served: undefined });
  const planned = await planSharedCloudflare(deps, {
    services: {},
    plan,
    cloudflare: { zoneId: a.zoneId, zoneName: ZONE, accountId: a.accountId },
    command: "opscrew provision",
    tls: { ...(tls !== undefined ? { tls: tls.desired } : {}) },
    client: a.client,
  });
  await applySharedCloudflare(deps, planned as NonNullable<typeof planned>, {
    app: plan.app.name,
    planOnly: false,
    command: "opscrew provision",
    phase: "provision",
    ...originTlsApply(deps, tls, { sleep: async () => undefined }),
  });
  const handler = h.deps.approvalHandler as ScriptedApprovalHandler;
  handler.requests.length = 0;
  h.cloudflare.calls.length = 0;
  h.deps.reporter.lines.length = 0;
  return {
    h,
    session,
    env,
    handler,
    a: h.cloudflare.zone(ZONE, "Old"),
    b: h.cloudflare.zone(ZONE, "New"),
  };
}

/** What a zone holds of OpsCrew's: rule hostnames by phase, certificates, settings. */
function holdings(zone: FakeCloudflareZone) {
  const rules = Object.fromEntries(
    [...zone.data.entrypoints].map(([phase, ruleset]) => [
      phase,
      ruleset.rules.filter((rule) => String(rule.ref).startsWith("opscrew-")).length,
    ]),
  );
  return {
    rules,
    origin: zone.data.originCertificates.filter((c) => !c.revoked_at).map((c) => c.id),
    client: zone.data.clientCertificates
      .filter((c) => c.status !== "pending_deletion")
      .map((c) => c.id),
    on: [...zone.data.hostnameAop.values()]
      .filter((s) => s.enabled === true)
      .map((s) => s.hostname),
  };
}

/** Every private key this computer holds for the app: the client's, A's origin's, B's. */
async function keys(m: Moving): Promise<{ client: string[]; origin: string[] }> {
  const deps = { ...m.h.deps, paths: m.env.paths };
  const own = await readOriginTlsValues(deps);
  const next = await readOriginTlsValues(deps, "originTlsNext");
  const defined = (values: (string | undefined)[]) =>
    values.filter((value): value is string => value !== undefined);
  return {
    client: defined([own.ORIGIN_PULL_KEY]),
    origin: defined([own.ORIGIN_TLS_KEY, next.ORIGIN_TLS_KEY, next.ORIGIN_TLS_REQUEST?.key]),
  };
}

/**
 * No token, address or private key in what was said, asked, audited or kept, nor sent to
 * Cloudflare, except the client certificate's key in its one upload.
 */
async function noLeaks(m: Moving, found: { client: string[]; origin: string[] }): Promise<void> {
  const { h } = m;
  const kept = await Promise.all(
    [bSharedRecordPath(m.env), aSharedRecordPath(m.env), appProgressFile(m.session.paths)].map(
      (file) => readFile(file, "utf8").catch(() => ""),
    ),
  );
  const said = JSON.stringify([m.handler.requests, ...kept]);
  expect(h.leaks(said)).toBe(false);
  const sent = (upload: boolean) =>
    JSON.stringify(
      h.cloudflare.calls.filter(
        (call) =>
          (call.method === "POST" &&
            call.path.endsWith("/origin_tls_client_auth/hostnames/certificates")) === upload,
      ),
    );
  const seen = [said, h.deps.reporter.text(), JSON.stringify(h.deps.audit.entries), sent(false)];
  for (const key of [...found.client, ...found.origin]) {
    for (const text of seen) expect(text).not.toContain(key);
  }
  for (const key of found.origin) expect(sent(true)).not.toContain(key);
}

/** Every call that changed something named B's account (`b`) or A's (`a`), never the other. */
function writesOnly(m: Moving, side: "a" | "b"): boolean {
  const { a, b } = m.session.accounts;
  const id = side === "a" ? a.accountId : b.accountId;
  const writes = m.h.cloudflare.calls.filter((call) => call.method !== "GET");
  return writes.length > 0 && writes.every((call) => call.accountId === id);
}

/** Runs `step` without an approval (it stops with the hash), then with `--approve <hash>`. */
async function approved(
  m: Moving,
  step: (session: MoveSession, env: MoveEnvironment) => Promise<StepStop | undefined>,
) {
  const stop = (await step(m.session, m.env)) as StepStop;
  const hash = stop?.pendingPlanHash as string;
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(m.handler.requests).toEqual([]);
  expect(m.h.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
  m.session.approve = hash;
  expect(await step(m.session, m.env)).toBeUndefined();
  expect(m.session.approve).toBeUndefined();
  expect(m.handler.requests.map((r) => [r.kind, r.planHash])).toEqual([["cloudflare-apply", hash]]);
  return { stop, hash };
}

describe.skipIf(!findExecutable("git"))(
  "B's shared plan, A's origin certificate, B's removal",
  () => {
    it("plans a proxied cloud server's pieces in B's pending zone with the app's client certificate and no origin certificate, approved by hash, and settles", async () => {
      const m = await moving("a proxied cloud server");
      const aBefore = structuredClone(holdings(m.a));
      const aRecord = await readFile(m.env.paths.files.cloudflareRecord, "utf8");
      const { stop, hash } = await approved(m, planBShared);
      expect(stop.next).toEqual([
        `Review the plan above, then run \`opscrew cloudflare move --approve ${hash}\` to apply it and continue.`,
      ]);
      const text = m.h.deps.reporter.text();
      expect(text).toContain("Upload this app's client certificate to Cloudflare");
      expect(text).not.toContain("Create a Cloudflare origin certificate");
      expect(text).toContain("Cloudflare turns origin pulls on there once it is");
      expect(text).toContain("Cloudflare issues no origin certificate for it before then");
      // In B's pending zone: OpsCrew's rules and the same client certificate, no origin certificate.
      expect(m.b.status).toBe("pending");
      expect(holdings(m.b)).toMatchObject({
        rules: { [PROBES]: 1, [STRICT]: 1 },
        on: ["shop.example.com"],
      });
      expect(holdings(m.b).origin).toEqual([]);
      const bRecord = JSON.parse(await readFile(bSharedRecordPath(m.env), "utf8")) as SharedRecord;
      const own = JSON.parse(aRecord) as SharedRecord;
      expect(bRecord.zoneId).toBe(m.b.id);
      expect(bRecord.tls?.client?.sha256).toBe(own.tls?.client?.sha256);
      expect(bRecord.tls?.origin).toBeUndefined();
      // Nothing kept for B's origin certificate yet; A's, its record and its zone stay as they were.
      const deps = { ...m.h.deps, paths: m.env.paths };
      expect(await readOriginTlsValues(deps, "originTlsNext")).toEqual({});
      expect(await readFile(m.env.paths.files.cloudflareRecord, "utf8")).toBe(aRecord);
      expect(holdings(m.a)).toEqual(aBefore);
      expect(writesOnly(m, "b")).toBe(true);
      expect((await readAppProgress(m.session.paths)).pending).toBeUndefined();

      // The pending zone's plan settles after its first apply: nothing more to approve.
      expect(await planBShared(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toHaveLength(1);
      await noLeaks(m, await keys(m));
    });

    it("keeps the plan's hash between the stop and the --approve run, and records it as waiting", async () => {
      const m = await moving("a proxied cloud server");
      const first = await planBShared(m.session, m.env);
      expect(await readAppProgress(m.session.paths)).toMatchObject({
        pending: { action: "shared", environment: "prod", planHash: first?.pendingPlanHash },
      });
      const again = await planBShared(m.session, m.env);
      expect(again?.pendingPlanHash).toBe(first?.pendingPlanHash);
      expect(m.h.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
    });

    it("plans Portainer's Caddy origin TLS in B without OpsCrew's rules", async () => {
      const m = await moving("Portainer in Caddy mode");
      await approved(m, planBShared);
      expect(holdings(m.b)).toMatchObject({ rules: {}, origin: [], on: ["shop.example.com"] });
      expect(holdings(m.b).client).toHaveLength(1);
      expect(writesOnly(m, "b")).toBe(true);
      await noLeaks(m, await keys(m));
    });

    it("plans an own server in tunnel mode without origin TLS: B's rules and Zero Trust organization", async () => {
      const m = await moving("an own server in tunnel mode");
      await approved(m, planBShared);
      expect(holdings(m.b)).toEqual({ rules: { [PROBES]: 1 }, origin: [], client: [], on: [] });
      expect(m.h.cloudflare.account("New").organization).toBeDefined();
      const next = await readOriginTlsValues({ ...m.h.deps, paths: m.env.paths }, "originTlsNext");
      expect(next).toEqual({});
      expect(writesOnly(m, "b")).toBe(true);
      // No origin certificate in A to revoke.
      await copyRecordAside(m);
      expect(await revokeAOrigin(m.session, m.env)).toBeUndefined();
      await noLeaks(m, await keys(m));
    });

    it("plans a Workers site's rules in B, its www redirect included, without origin TLS", async () => {
      const m = await moving("a Workers site with www");
      await approved(m, planBShared);
      expect(holdings(m.b)).toEqual({
        rules: { [PROBES]: 1, [REDIRECT]: 1 },
        origin: [],
        client: [],
        on: [],
      });
      expect(writesOnly(m, "b")).toBe(true);

      // The abort takes both rules away again, the redirect's phase read from B's record.
      m.handler.requests.length = 0;
      m.h.cloudflare.calls.length = 0;
      await approved(m, removeBShared);
      expect(holdings(m.b).rules).toEqual({});
      expect(writesOnly(m, "b")).toBe(true);
      await noLeaks(m, await keys(m));
    });

    it("removes B's shared pieces at an abort: hostnames, client certificate, origin pulls, originTlsNext", async () => {
      const m = await moving("a proxied cloud server");
      m.session.approve = undefined;
      m.h.deps.interactive = true;
      expect(await planBShared(m.session, m.env)).toBeUndefined();
      const found = await keys(m);
      m.h.deps.interactive = false;
      const aBefore = structuredClone(holdings(m.a));
      const organization = m.h.cloudflare.account("New").organization;
      m.handler.requests.length = 0;
      m.h.cloudflare.calls.length = 0;

      const { stop, hash } = await approved(m, removeBShared);
      expect(stop.next).toEqual([
        `Review the plan above, then run \`opscrew cloudflare move --confirm shop --approve ${hash}\` to apply it and continue.`,
      ]);
      expect(m.handler.requests[0]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
      expect(m.h.deps.reporter.text()).toContain(
        "Delete this app's client certificate from Cloudflare",
      );
      expect(holdings(m.b)).toEqual({ rules: {}, origin: [], client: [], on: [] });
      expect(m.h.cloudflare.account("New").organization).toEqual(organization);
      expect(
        await readOriginTlsValues({ ...m.h.deps, paths: m.env.paths }, "originTlsNext"),
      ).toEqual({});
      // A is never changed by an abort.
      expect(holdings(m.a)).toEqual(aBefore);
      expect(writesOnly(m, "b")).toBe(true);

      // Run again: nothing left in B, nothing asked.
      expect(await removeBShared(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toHaveLength(1);
      await noLeaks(m, found);
    });

    it("forgets originTlsNext at an abort when B never got the app's shared pieces", async () => {
      const m = await moving("a proxied cloud server");
      const deps = { ...m.h.deps, paths: m.env.paths };
      // A request kept for B's origin certificate, as a finish that stopped before its apply leaves it.
      const step = await planOriginTls(deps, {
        plan: m.env.plan,
        record: undefined,
        served: undefined,
        slot: "originTlsNext",
      });
      const create: SharedChange = {
        kind: "create-origin-certificate",
        hostnames: [],
        csrSha256: "",
      };
      await keepCertificateRequest(deps, step as OriginTlsStep, { changes: [create] });
      expect((await readOriginTlsValues(deps, "originTlsNext")).ORIGIN_TLS_REQUEST).toBeDefined();
      m.h.cloudflare.calls.length = 0;
      expect(await removeBShared(m.session, m.env)).toBeUndefined();
      expect(await readOriginTlsValues(deps, "originTlsNext")).toEqual({});
      expect(m.handler.requests).toEqual([]);
      expect(m.h.cloudflare.calls).toEqual([]);
    });

    it("issues B's origin certificate once B's zone is active, kept as originTlsNext", async () => {
      const m = await moving("a proxied cloud server");
      const finish = await finished(m);
      expect(holdings(m.b).origin).toHaveLength(1);
      const record = JSON.parse(await readFile(bSharedRecordPath(m.env), "utf8")) as SharedRecord;
      expect(record.tls?.origin?.sha256).toBe(fingerprintSha256(finish.b));
      expect(finish.b).not.toBe(finish.a);
      await noLeaks(m, finish.keys);
    });

    it("revokes A's origin certificate with A's token once the server serves B's, after the typed name, and leaves A's rules, client certificate and origin pulls", async () => {
      const m = await moving("a proxied cloud server");
      const finish = await finished(m);
      const aBefore = structuredClone(holdings(m.a));
      expect(aBefore.origin).toHaveLength(1);
      serving(m, finish.b);

      const { stop, hash } = await approved(m, revokeAOrigin);
      expect(stop.next).toEqual([
        `Review the plan above, then run \`opscrew cloudflare move --confirm shop --approve ${hash}\` to apply it and continue.`,
      ]);
      expect(m.handler.requests[0]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
      const text = m.h.deps.reporter.text();
      expect(text).toContain("Revoke an origin certificate of this app");
      expect(text).toContain("the server serves the new account's origin certificate");
      expect(holdings(m.a)).toEqual({ ...aBefore, origin: [] });
      expect(holdings(m.b).origin).toHaveLength(1);
      expect(writesOnly(m, "a")).toBe(true);
      expect(
        m.h.cloudflare.calls.filter((call) => call.method !== "GET").map((call) => call.method),
      ).toEqual(["DELETE"]);
      // A's record aside no longer names it; a run again asks nothing.
      const aside = JSON.parse(await readFile(aSharedRecordPath(m.env), "utf8")) as SharedRecord;
      expect(aside.tls?.origin).toBeUndefined();
      expect(await revokeAOrigin(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toHaveLength(1);
      await noLeaks(m, finish.keys);
    });

    it.each([
      ["still serves A's certificate", "a"],
      ["can't be read", "none"],
    ] as const)(
      "keeps A's origin certificate while the server %s, and says so",
      async (_, what) => {
        const m = await moving("a proxied cloud server");
        const finish = await finished(m);
        const aBefore = structuredClone(holdings(m.a));
        serving(m, what === "a" ? finish.a : undefined);
        const stop = await revokeAOrigin(m.session, m.env);
        expect(stop).toEqual({
          next: [
            "Once the deploy has brought the new origin certificate to the server, run `opscrew cloudflare move` again.",
          ],
        });
        expect(m.h.deps.reporter.text()).toContain(
          "The server does not serve the new account's origin certificate yet",
        );
        expect(m.handler.requests).toEqual([]);
        expect(m.h.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
        expect(holdings(m.a)).toEqual(aBefore);
        expect((await readAppProgress(m.session.paths)).pending).toBeUndefined();
        await noLeaks(m, finish.keys);
      },
    );

    it("revokes A's origin certificate once the app's Portainer stack holds B's", async () => {
      const m = await moving("Portainer in Caddy mode");
      const finish = await finished(m);
      const deps = { ...m.h.deps, paths: m.env.paths };
      const values = await readOriginTlsValues(deps);
      const portainer = fakePortainer({
        token: PORTAINER_TOKEN,
        stacks: [
          {
            Id: 7,
            Name: "opscrew-shop",
            Type: 2,
            EndpointId: 3,
            Status: 1,
            Env: [{ name: PORTAINER_STACK_VARIABLES.originTls, value: portainerOriginTls(values) }],
            DeploymentStatus: [],
            file: "",
          },
        ],
      });
      await recordPortainerConnection(m.env.paths, {
        url: PORTAINER_URL,
        certFingerprint: fakeCertificate("move portainer").fingerprint,
        environmentId: 3,
        environmentName: "local",
        arch: "amd64",
        redeploy: "updater",
        web: { mode: "caddy" },
        created: { stacks: [{ id: 7, name: "opscrew-shop", role: "app" }] },
      });
      m.h.deps.env.PORTAINER_API_KEY = PORTAINER_TOKEN;
      m.session.services.portainer = {
        client: (endpoint, token, clientDeps) =>
          portainerClient(endpoint, token, { ...clientDeps, request: portainer.request }),
      };
      const aBefore = structuredClone(holdings(m.a));

      await approved(m, revokeAOrigin);
      expect(holdings(m.a)).toEqual({ ...aBefore, origin: [] });
      expect(writesOnly(m, "a")).toBe(true);
      expect(portainer.mutations()).toEqual([]);
      await noLeaks(m, finish.keys);
      expect(m.h.deps.reporter.text()).not.toContain(PORTAINER_TOKEN);
    });

    it("asks nothing to revoke without A's record aside", async () => {
      const m = await moving("a proxied cloud server");
      expect(await revokeAOrigin(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toEqual([]);
      expect(m.h.cloudflare.calls).toEqual([]);
    });

    it("makes B's one-time PIN login at an Access-using environment's first prepare, and nothing on a run after", async () => {
      const m = await moving("an own server with Portainer on a subdomain");
      const stop = await planBShared(m.session, m.env);
      expect(stop?.pendingPlanHash).toBeDefined();
      m.session.approve = stop?.pendingPlanHash;
      const first = await planBShared(m.session, m.env);
      const login = m.h.cloudflare
        .account("New")
        .identityProviders.find((provider) => provider.type === "onetimepin");
      expect(login).toBeDefined();
      expect(first).toBeUndefined();
      expect(await planBShared(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toHaveLength(1);
      expect(writesOnly(m, "b")).toBe(true);
    });

    it("forgets a waiting plan of B's shared plan once it changes nothing", async () => {
      const m = await moving("a proxied cloud server");
      m.h.deps.interactive = true;
      await planBShared(m.session, m.env);
      const key = { action: "shared", environment: "prod" } as const;
      await writePending(m.h.deps, key, "a".repeat(64));
      expect(await planBShared(m.session, m.env)).toBeUndefined();
      expect((await readAppProgress(m.session.paths)).pending).toBeUndefined();
    });

    it("asks for the typed name when B's shared plan deletes OpsCrew's rule", async () => {
      const m = await moving("a Workers site with www");
      m.h.deps.interactive = true;
      await planBShared(m.session, m.env);
      m.h.deps.interactive = false;
      const plan = m.env.plan;
      m.env.plan = DeployPlanSchema.parse({ ...plan, dns: { ...plan.dns, www: false } });
      const stop = await planBShared(m.session, m.env);
      const hash = stop?.pendingPlanHash as string;
      expect(stop?.next).toEqual([
        `Review the plan above, then run \`opscrew cloudflare move --confirm example-app --approve ${hash}\` to apply it and continue.`,
      ]);
    });

    it("refuses B's shared plan when B's record names a zone that is no longer there", async () => {
      const m = await moving("a proxied cloud server");
      await strayRecord(m);
      const error = await planBShared(m.session, m.env).catch((e: unknown) => e);
      expect(error).toMatchObject({
        code: "PHASE_PRECONDITION",
        message: expect.stringMatching(
          /names a zone that is no longer there\. Nothing was changed\.$/,
        ),
        hint: expect.stringContaining(`Delete ${bSharedRecordPath(m.env)}`),
      });
      expect(m.h.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
    });

    it("deletes B's record at an abort when the zone it names is gone from B", async () => {
      const m = await moving("a proxied cloud server");
      await strayRecord(m);
      expect(await removeBShared(m.session, m.env)).toBeUndefined();
      await expect(readFile(bSharedRecordPath(m.env), "utf8")).rejects.toThrow();
      expect(m.handler.requests).toEqual([]);
      expect(m.h.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
    });
  },
);

/** B's record of a zone B no longer has. */
async function strayRecord(m: Moving): Promise<void> {
  const file = bSharedRecordPath(m.env);
  await mkdir(dirname(file), { recursive: true });
  const record: SharedRecord = { zoneId: "f".repeat(32), hostnames: {}, createdEntrypoints: [] };
  await writeFile(file, JSON.stringify(record));
}

/**
 * The finish as far as A's revocation needs it: B's zone active and its shared plan applied, B's origin certificate
 * promoted to the app's, A's record moved aside, and the deploy login on this computer. Gives both
 * origin certificates (PEM) and every key held before the promotion.
 */
async function finished(m: Moving) {
  const deps = { ...m.h.deps, paths: m.env.paths };
  // B's zone active: its shared plan now issues B's origin certificate (the finish's, plan 13b).
  m.h.cloudflare.activate(m.b);
  m.session.services.sleep = async () => undefined;
  m.h.deps.interactive = true;
  expect(await planBShared(m.session, m.env)).toBeUndefined();
  m.h.deps.interactive = false;
  const found = await keys(m);
  const a = (await readOriginTlsValues(deps)).ORIGIN_TLS_CERT as string;
  const b = (await readOriginTlsValues(deps, "originTlsNext")).ORIGIN_TLS_CERT as string;
  await promoteNextOriginTls(deps);
  const aside = aSharedRecordPath(m.env);
  await mkdir(dirname(aside), { recursive: true });
  await copyFile(m.env.paths.files.cloudflareRecord, aside);
  await mkdir(dirname(m.env.paths.files.deployKey), { recursive: true });
  await writeFile(m.env.paths.files.deployKey, "a placeholder deploy key\n");
  m.handler.requests.length = 0;
  m.h.cloudflare.calls.length = 0;
  return { a, b, keys: found };
}

/** The server's edge serving `pem` as the app's origin certificate (`undefined`: unreadable). */
function serving(m: Moving, pem: string | undefined): void {
  const app = m.env.plan.app.name;
  m.session.services.remote = (host) => ({
    host,
    run: async (command) =>
      pem !== undefined && command === edgeReadCommand(app)
        ? {
            exitCode: 0,
            stdout: `opscrew-edge-read 1\nproxy=caddy\n--origin--\n${pem}--site--\n--end--\n`,
            stderr: "",
          }
        : { exitCode: 255, stdout: "", stderr: "" },
  });
}

/** The finish's swap as far as this needs it: A's record moved aside. */
async function copyRecordAside(m: Moving): Promise<void> {
  const aside = aSharedRecordPath(m.env);
  await mkdir(dirname(aside), { recursive: true });
  await copyFile(m.env.paths.files.cloudflareRecord, aside);
}
