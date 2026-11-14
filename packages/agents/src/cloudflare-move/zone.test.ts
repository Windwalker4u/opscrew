import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import { findExecutable, OpsCrewError, resolveProjectPaths } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { appPlan } from "../apps/__fixtures__/sites";
import { type ScriptedApprovalHandler, SERVER_IPV4 } from "../testing";
import { openMoveSession } from "./session";
import { type MoveHarness, moveHarness, serverPlan, ZONE } from "./session.fakes";
import { MOVE_COMMAND } from "./texts";
import type { MoveSession } from "./types";
import { applyZone, MARK_COMMENT, planZone } from "./zone";

const CAA = { flags: 0, tag: "issue", value: "letsencrypt.org" };

/** The harness with the user's own records in Old's zone, and Cloudflare's for the docs Worker. */
async function harness(options: Parameters<typeof moveHarness>[0] = {}): Promise<MoveHarness> {
  const h = await moveHarness({
    apps: () => ({ blog: appPlan("blog", undefined, serverPlan(`blog.${ZONE}`)) }),
    ...options,
  });
  const zone = h.cloudflare.zone(ZONE, "Old");
  h.cloudflare.addRecord(zone, { type: "A", name: `ftp.${ZONE}`, content: SERVER_IPV4, ttl: 300 });
  h.cloudflare.addRecord(zone, {
    type: "TXT",
    name: ZONE,
    content: '"v=spf1 include:_spf.example.net ~all"',
    comment: "mail",
  });
  h.cloudflare.addRecord(zone, {
    type: "CAA",
    name: ZONE,
    content: '0 issue "letsencrypt.org"',
    data: CAA,
  });
  h.cloudflare.addRecord(zone, { type: "NS", name: ZONE, content: "ns1.example.net" });
  h.cloudflare.addRecord(zone, {
    type: "AAAA",
    name: `docs.${ZONE}`,
    content: "100::",
    proxied: true,
    meta: { read_only: true, origin_worker_id: "docs" },
  });
  return h;
}

/** The records of `account`'s zone, as a copy keeps them. */
function fields(h: MoveHarness, account: string) {
  return h.cloudflare
    .zone(ZONE, account)
    .records.map((r) => ({
      type: r.type,
      name: r.name,
      content: r.content,
      data: r.data,
      ttl: r.ttl,
      proxied: r.proxied,
      priority: r.priority,
      comment: r.comment,
    }))
    .sort((x, y) => `${x.type} ${x.name}`.localeCompare(`${y.type} ${y.name}`));
}

/** True when a call changed something in Old's account. */
const wroteToA = (h: MoveHarness) =>
  h.cloudflare.calls.some(
    (call) => call.method !== "GET" && call.accountId === h.cloudflare.account("Old").id,
  );

/** Everything said, approved or recorded, for the leak check. */
const seen = (h: MoveHarness, ...texts: string[]) =>
  h.leaks(...texts, JSON.stringify((h.deps.approvalHandler as ScriptedApprovalHandler).requests));

/** The session of the repository's further app `blog`. */
function blogSession(h: MoveHarness): Promise<MoveSession> {
  const paths = resolveProjectPaths(h.root, { env: h.deps.env, app: "blog" });
  return openMoveSession(
    { ...h.deps, paths },
    { command: MOVE_COMMAND, services: h.services, to: "New" },
  );
}

describe.skipIf(!findExecutable("git"))("planZone and applyZone", () => {
  it("a first prepare adds B's zone and copies A's records that are no OpsCrew app's, every field kept", async () => {
    const h = await harness();
    const session = await h.open({ to: "New" });
    const plan = await planZone(session);
    const old = h.cloudflare.zone(ZONE, "Old");
    expect(plan).toMatchObject({
      zone: ZONE,
      from: { accountId: old.accountId, zoneId: old.id },
      to: { accountId: h.cloudflare.account("New").id },
      createZone: true,
      differ: [],
      onlyInB: [],
    });
    expect(plan.to.zoneId).toBeUndefined();
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.create.map((r) => `${r.type} ${r.name}`).sort()).toEqual([
      `A ftp.${ZONE}`,
      `CAA ${ZONE}`,
      `MX ${ZONE}`,
      `TXT ${ZONE}`,
    ]);
    // OpsCrew's records (this app's and another's), Cloudflare's own and the apex NS are left out.
    expect(plan.skipped.map((s) => `${s.record.type} ${s.record.name}`).sort()).toEqual([
      `A blog.${ZONE}`,
      `A shop.${ZONE}`,
      `AAAA docs.${ZONE}`,
      `NS ${ZONE}`,
    ]);
    // The app's server's address is masked in what is shown, also in the user's own record.
    expect(plan.details).toContain(`A ftp.${ZONE} <server address>`);
    expect(plan.details).not.toContain(SERVER_IPV4);
    expect((await planZone(session)).planHash).toBe(plan.planHash);
    expect(h.readOnly()).toBe(true);

    const zone = await applyZone(session, plan);
    const fresh = h.cloudflare.zone(ZONE, "New");
    expect(zone?.id).toBe(fresh.id);
    expect(session.accounts.b.zone?.id).toBe(fresh.id);
    expect(fresh.status).toBe("pending");
    const copied = fields(h, "Old").filter((r) =>
      plan.create.some((c) => c.type === r.type && c.name === r.name),
    );
    // A record with `data` is created from its data, which Cloudflare words as content.
    expect(fields(h, "New")).toEqual(
      copied.map((r) => (r.type === "CAA" ? { ...r, content: "" } : r)),
    );
    const requests = (h.deps.approvalHandler as ScriptedApprovalHandler).requests;
    expect(requests).toMatchObject([{ kind: "cloudflare-apply", planHash: plan.planHash }]);
    expect(requests[0]?.details).toBe(plan.details);
    expect(wroteToA(h)).toBe(false);
    // Nothing is left to copy, and the same plan finds nothing to change.
    const again = await planZone(session);
    expect(again).toMatchObject({ createZone: false, create: [], differ: [], onlyInB: [] });
    expect(seen(h, plan.details)).toBe(false);
  });

  it("a second app's prepare copies only what is missing, and lists A's changes and B's own records", async () => {
    const h = await harness();
    const first = await h.open({ to: "New" });
    await applyZone(first, await planZone(first));
    const old = h.cloudflare.zone(ZONE, "Old");
    const fresh = h.cloudflare.zone(ZONE, "New");
    // Between the two prepares: a record created in A, one changed in A, one only in B, and the
    // records the first app's own plans and mark made in B.
    h.cloudflare.addRecord(old, { type: "CNAME", name: `cdn.${ZONE}`, content: "cdn.example.net" });
    const ftp = old.records.find((r) => r.name === `ftp.${ZONE}`);
    if (ftp) ftp.content = "198.51.100.7";
    h.cloudflare.addRecord(fresh, { type: "TXT", name: `own.${ZONE}`, content: '"only in B"' });
    h.cloudflare.addRecord(fresh, {
      type: "A",
      name: `shop.${ZONE}`,
      content: SERVER_IPV4,
      proxied: true,
      comment: OPSCREW_MANAGED_COMMENT,
    });
    h.cloudflare.addRecord(fresh, {
      type: "TXT",
      name: `_opscrew-move.shop-12345678.${ZONE}`,
      content: '"opscrew-move=1; app=shop; envs=prod; hosts=shop.example.com"',
      comment: MARK_COMMENT,
    });

    const second = await blogSession(h);
    expect(second.accounts.b.zone?.id).toBe(fresh.id);
    const plan = await planZone(second);
    expect(plan.createZone).toBe(false);
    expect(plan.to.zoneId).toBe(fresh.id);
    expect(plan.create.map((r) => `${r.type} ${r.name} ${r.content}`)).toEqual([
      `CNAME cdn.${ZONE} cdn.example.net`,
    ]);
    expect(plan.differ.map((d) => [d.a.content, d.b.content])).toEqual([
      ["198.51.100.7", SERVER_IPV4],
    ]);
    expect(plan.onlyInB.map((r) => r.name)).toEqual([`own.${ZONE}`]);
    expect(plan.details).toContain(
      `Old has A ftp.${ZONE} 198.51.100.7; New has A ftp.${ZONE} <server address>`,
    );
    const before = fields(h, "New");
    await applyZone(second, plan);
    const after = fields(h, "New");
    expect(after.length).toBe(before.length + 1);
    expect(after.find((r) => r.name === `cdn.${ZONE}`)).toMatchObject({
      content: "cdn.example.net",
    });
    // The record that differs and B's own are as they were.
    expect(after.find((r) => r.name === `ftp.${ZONE}`)?.content).toBe(SERVER_IPV4);
    expect(after.find((r) => r.name === `own.${ZONE}`)).toBeDefined();
    expect(wroteToA(h)).toBe(false);
    expect(seen(h, plan.details)).toBe(false);
  });

  it("asks nothing when there is nothing to change", async () => {
    const h = await harness();
    const session = await h.open({ to: "New" });
    await applyZone(session, await planZone(session));
    const requests = (h.deps.approvalHandler as ScriptedApprovalHandler).requests;
    const writes = h.cloudflare.calls.filter((call) => call.method !== "GET").length;
    await applyZone(session, await planZone(session));
    expect(requests).toHaveLength(1);
    expect(h.cloudflare.calls.filter((call) => call.method !== "GET").length).toBe(writes);
  });

  it("refuses a plan whose zones changed since it was made, before any change", async () => {
    const h = await harness();
    const session = await h.open({ to: "New" });
    const plan = await planZone(session);
    h.cloudflare.addRecord(h.cloudflare.zone(ZONE, "Old"), {
      type: "TXT",
      name: `new.${ZONE}`,
      content: '"added"',
    });
    const error = await applyZone(session, plan).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect((error as OpsCrewError).code).toBe("PLAN_HASH_MISMATCH");
    expect((error as OpsCrewError).message).toMatch(/Nothing was changed\.$/);
    expect(h.readOnly()).toBe(true);
    expect(seen(h, (error as OpsCrewError).message)).toBe(false);
  });

  it("stops when Cloudflare gave B's new zone A's nameservers, before any record", async () => {
    const h = await harness();
    const old = h.cloudflare.zone(ZONE, "Old");
    h.cloudflare.nameServerPairs.push([...old.nameServers]);
    const session = await h.open({ to: "New" });
    const error = (await applyZone(session, await planZone(session)).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.message).toContain("the nameservers it has in the account Old");
    expect(error.message).toContain("The zone was added to the new account; nothing else");
    expect(error.hint).toContain("opscrew cloudflare move --abort");
    expect(h.cloudflare.zone(ZONE, "New").records).toEqual([]);
    expect(wroteToA(h)).toBe(false);
  });

  it("refuses B's zone with A's nameservers before any change when it is there already", async () => {
    const h = await harness({ bZone: true });
    h.cloudflare.zone(ZONE, "New").nameServers = [...h.cloudflare.zone(ZONE, "Old").nameServers];
    const session = await h.open({ to: "New" });
    const error = (await applyZone(session, await planZone(session)).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error.message).toMatch(/Nothing was changed\.$/);
    expect(h.readOnly()).toBe(true);
    expect((h.deps.approvalHandler as ScriptedApprovalHandler).requests).toEqual([]);
  });

  it("names each zone permission B's token lacks, before any record", async () => {
    const h = await harness({ bDenied: ["ssl", "http_config_settings"] });
    const session = await h.open({ to: "New" });
    const error = (await applyZone(session, await planZone(session)).catch(
      (e: unknown) => e,
    )) as OpsCrewError;
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error.code).toBe("CREDENTIALS_INVALID");
    expect(error.message).toContain("Zone → Config Rules → Edit");
    expect(error.message).toContain("Zone → SSL and Certificates → Edit");
    expect(error.message).not.toContain("DNS");
    expect(h.cloudflare.zone(ZONE, "New").records).toEqual([]);
    expect(seen(h, error.message, error.hint ?? "")).toBe(false);
  });
});
