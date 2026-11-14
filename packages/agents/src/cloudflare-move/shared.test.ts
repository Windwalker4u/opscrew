import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { SHARED_RULES, type SharedRecord } from "@opscrew/connector-cloudflare";
import type { FakeCloudflareZone } from "@opscrew/connector-cloudflare/testing";
import { findExecutable } from "@opscrew/core";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { originTlsApply, planOriginTls, readOriginTlsValues } from "../provision/origin-tls";
import { applySharedCloudflare, planSharedCloudflare } from "../provision/shared-cloudflare";
import { ownPlan, portainerPlan, type ScriptedApprovalHandler, sitePlan } from "../testing";
import { appProgressFile, readAppProgress } from "./progress";
import { type MoveHarness, moveHarness, serverPlan, unencrypted, ZONE } from "./session.fakes";
import {
  aSharedRecordPath,
  bSharedRecordPath,
  planBShared,
  removeBShared,
  revokeAOrigin,
} from "./shared";
import type { MoveEnvironment, MoveSession } from "./types";

const PROBES = SHARED_RULES["opscrew-block-probes"].phase;
const STRICT = SHARED_RULES["opscrew-strict-tls"].phase;
const REDIRECT = SHARED_RULES["opscrew-www-redirect"].phase;

/** A Portainer stack whose Caddy is the origin behind Cloudflare's proxy. */
function portainerCaddy(): DeployPlan {
  const plan = portainerPlan({ web: { mode: "caddy" }, deployed: true });
  return unencrypted(DeployPlanSchema.parse({ ...plan, dns: { ...plan.dns, proxied: true } }));
}

const TARGETS = {
  "a proxied cloud server": () => serverPlan(),
  "Portainer in Caddy mode": portainerCaddy,
  "an own server in tunnel mode": () => unencrypted(ownPlan({ access: "tunnel", deployed: true })),
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
    [bSharedRecordPath(m.env), appProgressFile(m.session.paths)].map((file) =>
      readFile(file, "utf8").catch(() => ""),
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
  step: (session: MoveSession, env: MoveEnvironment) => Promise<unknown>,
) {
  const stop = (await step(m.session, m.env)) as { pendingPlanHash?: string; next: string[] };
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
    it("plans a proxied cloud server's pieces in B's pending zone with the app's client certificate, approved by hash, and settles", async () => {
      const m = await moving("a proxied cloud server");
      const aBefore = structuredClone(holdings(m.a));
      const aRecord = await readFile(m.env.paths.files.cloudflareRecord, "utf8");
      const { stop, hash } = await approved(m, planBShared);
      expect(stop.next).toEqual([
        `Review the plan above, then run \`opscrew cloudflare move --approve ${hash}\` to apply it and continue.`,
      ]);
      const text = m.h.deps.reporter.text();
      expect(text).toContain("Upload this app's client certificate to Cloudflare");
      expect(text).toContain(
        "Create a Cloudflare origin certificate for shop.example.com (15 years)",
      );
      expect(text).toContain("until the move's finish deploys it");
      expect(text).toContain("Cloudflare turns origin pulls on there once it is");
      // In B's pending zone: OpsCrew's rules, the same client certificate, a new origin certificate.
      expect(m.b.status).toBe("pending");
      expect(holdings(m.b)).toMatchObject({
        rules: { [PROBES]: 1, [STRICT]: 1 },
        on: ["shop.example.com"],
      });
      expect(holdings(m.b).origin).toHaveLength(1);
      const bRecord = JSON.parse(await readFile(bSharedRecordPath(m.env), "utf8")) as SharedRecord;
      const own = JSON.parse(aRecord) as SharedRecord;
      expect(bRecord.zoneId).toBe(m.b.id);
      expect(bRecord.tls?.client?.sha256).toBe(own.tls?.client?.sha256);
      expect(bRecord.tls?.origin?.sha256).not.toBe(own.tls?.origin?.sha256);
      // B's origin certificate is kept apart; A's, its record and its zone stay as they were.
      const deps = { ...m.h.deps, paths: m.env.paths };
      const next = await readOriginTlsValues(deps, "originTlsNext");
      expect(next.ORIGIN_TLS_CERT).toContain("BEGIN CERTIFICATE");
      expect((await readOriginTlsValues(deps)).ORIGIN_TLS_CERT).not.toBe(next.ORIGIN_TLS_CERT);
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
      expect(holdings(m.b)).toMatchObject({ rules: {}, on: ["shop.example.com"] });
      expect(holdings(m.b).origin).toHaveLength(1);
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

    it("removes B's shared pieces at an abort: hostnames, client certificate, origin pulls, B's origin certificate, originTlsNext", async () => {
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
      expect(m.h.deps.reporter.text()).toContain("Revoke an origin certificate of this app");
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
      // A prepare that stopped at B's shared plan, waiting for its approval.
      expect((await planBShared(m.session, m.env))?.pendingPlanHash).toBeDefined();
      expect((await readOriginTlsValues(deps, "originTlsNext")).ORIGIN_TLS_REQUEST).toBeDefined();
      m.h.cloudflare.calls.length = 0;
      expect(await removeBShared(m.session, m.env)).toBeUndefined();
      expect(await readOriginTlsValues(deps, "originTlsNext")).toEqual({});
      expect(m.handler.requests).toEqual([]);
      expect(m.h.cloudflare.calls).toEqual([]);
    });

    it("revokes A's origin certificate with A's token after the typed name, and leaves A's rules, client certificate and origin pulls", async () => {
      const m = await moving("a proxied cloud server");
      const found = await keys(m);
      const aBefore = structuredClone(holdings(m.a));
      expect(aBefore.origin).toHaveLength(1);
      await copyRecordAside(m);

      const { stop, hash } = await approved(m, revokeAOrigin);
      expect(stop.next).toEqual([
        `Review the plan above, then run \`opscrew cloudflare move --confirm shop --approve ${hash}\` to apply it and continue.`,
      ]);
      expect(m.handler.requests[0]).toMatchObject({ allowDestroy: true, confirmPhrase: "shop" });
      const text = m.h.deps.reporter.text();
      expect(text).toContain("Revoke an origin certificate of this app");
      expect(text).toContain("issued in the Cloudflare account the app moved from");
      expect(holdings(m.a)).toEqual({ ...aBefore, origin: [] });
      expect(holdings(m.b).origin).toEqual([]);
      expect(writesOnly(m, "a")).toBe(true);
      expect(
        m.h.cloudflare.calls.filter((call) => call.method !== "GET").map((call) => call.method),
      ).toEqual(["DELETE"]);
      // A's record aside no longer names it; a run again asks nothing.
      const aside = JSON.parse(await readFile(aSharedRecordPath(m.env), "utf8")) as SharedRecord;
      expect(aside.tls?.origin).toBeUndefined();
      expect(await revokeAOrigin(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toHaveLength(1);
      await noLeaks(m, found);
    });

    it("asks nothing to revoke without A's record aside", async () => {
      const m = await moving("a proxied cloud server");
      expect(await revokeAOrigin(m.session, m.env)).toBeUndefined();
      expect(m.handler.requests).toEqual([]);
      expect(m.h.cloudflare.calls).toEqual([]);
    });
  },
);

/** The finish's swap as far as this needs it: A's record moved aside. */
async function copyRecordAside(m: Moving): Promise<void> {
  const aside = aSharedRecordPath(m.env);
  await mkdir(dirname(aside), { recursive: true });
  await copyFile(m.env.paths.files.cloudflareRecord, aside);
}
