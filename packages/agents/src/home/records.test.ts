import { CloudflareClient, OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import {
  type FakeCloudflareAccounts,
  fakeCloudflareAccounts,
} from "@opscrew/connector-cloudflare/testing";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { PlanRefusedError } from "../shared";
import { createTestPhaseDeps, ScriptedApprovalHandler, type TestPhaseDeps } from "../testing";
import { deleteUpdaterRecords, planRecordDeletion, UPDATER_RECORD_COMMENT } from "./records";

const TOKEN = fakeSecret("cloudflare-token", "home-records");
const ZONE = "example.com";
const NAME = `shop.${ZONE}`;
const APP = "shop";
const COMMAND = "opscrew destroy";
/** The home's detected addresses, as a proxied app's: never in a plan, a line or an entry. */
const HOME_IPV4 = "203.0.113.77";
const HOME_IPV6 = "2001:db8:5::77";

function setup() {
  const fake = fakeCloudflareAccounts({
    accounts: [{ name: "Home", token: TOKEN }],
    zones: [{ name: ZONE, account: "Home" }],
  });
  const zone = fake.zone(ZONE, "Home");
  const client = new CloudflareClient({ token: TOKEN, fetch: fake.fetch, sleep: async () => {} });
  return { fake, zone, client };
}

/** The updater's A and AAAA at the app's name, beside records that aren't its own. */
function withUpdaterRecords(fake: FakeCloudflareAccounts, zone = fake.zone(ZONE, "Home")) {
  const a = fake.addRecord(zone, {
    type: "A",
    name: NAME,
    content: HOME_IPV4,
    ttl: 1,
    proxied: true,
    comment: UPDATER_RECORD_COMMENT,
  });
  const aaaa = fake.addRecord(zone, {
    type: "AAAA",
    name: NAME,
    content: HOME_IPV6,
    ttl: 1,
    proxied: true,
    comment: UPDATER_RECORD_COMMENT,
  });
  // The root's records, the user's own and another app's updater record: never in the plan.
  fake.addRecord(zone, {
    type: "CNAME",
    name: `www.${NAME}`,
    content: NAME,
    proxied: true,
    comment: OPSCREW_MANAGED_COMMENT,
  });
  fake.addRecord(zone, {
    type: "CAA",
    name: NAME,
    data: { flags: 0, tag: "issue", value: "letsencrypt.org" },
    comment: OPSCREW_MANAGED_COMMENT,
  });
  fake.addRecord(zone, { type: "TXT", name: NAME, content: '"the user\'s own"' });
  fake.addRecord(zone, {
    type: "A",
    name: `blog.${ZONE}`,
    content: HOME_IPV4,
    proxied: true,
    comment: UPDATER_RECORD_COMMENT,
  });
  return { a, aaaa };
}

/** Everything OpsCrew said, recorded, asked and sent in a run. */
function seen(deps: TestPhaseDeps, fake: FakeCloudflareAccounts, ...more: unknown[]): string {
  const handler = deps.approvalHandler as ScriptedApprovalHandler;
  return JSON.stringify([
    deps.reporter.lines,
    deps.audit.entries,
    handler.requests,
    fake.calls,
    ...more.map((value) => (value instanceof OpsCrewError ? [value.message, value.hint] : value)),
  ]);
}

const request = (zoneId: string) => ({
  app: APP,
  zoneId,
  name: NAME,
  command: COMMAND,
  phase: "provision" as const,
});

describe("planRecordDeletion", () => {
  it("lists the updater's A and AAAA at the app's name by id, type and name, hashed, never their content", async () => {
    const { fake, zone, client } = setup();
    const { a, aaaa } = withUpdaterRecords(fake);
    const plan = await planRecordDeletion(client, { app: APP, zoneId: zone.id, name: NAME });
    const records = [
      { id: a.id, type: "A", name: NAME },
      { id: aaaa.id, type: "AAAA", name: NAME },
    ].sort((x, y) => x.id.localeCompare(y.id));
    const body = {
      action: "delete-updater-records",
      app: APP,
      zoneId: zone.id,
      name: NAME,
      records,
    };
    expect(plan).toEqual({ ...body, planHash: sha256Hex(canonicalJson(body)) });
    expect(JSON.stringify(plan)).not.toContain(HOME_IPV4);
    expect(JSON.stringify(plan)).not.toContain(HOME_IPV6);
  });

  it("answers nothing when the name holds no record of the updater's", async () => {
    const { fake, zone, client } = setup();
    fake.addRecord(zone, {
      type: "A",
      name: NAME,
      content: HOME_IPV4,
      comment: OPSCREW_MANAGED_COMMENT,
    });
    expect(
      await planRecordDeletion(client, { app: APP, zoneId: zone.id, name: NAME }),
    ).toBeUndefined();
  });
});

describe("deleteUpdaterRecords", () => {
  it("deletes the records after a cloudflare-apply approval with allowDestroy and the app's name typed", async () => {
    const { fake, zone, client } = setup();
    const { a, aaaa } = withUpdaterRecords(fake);
    const handler = new ScriptedApprovalHandler();
    const deps = await createTestPhaseDeps({ approvalHandler: handler });

    const plan = await deleteUpdaterRecords(deps, client, request(zone.id));

    expect(plan?.records.map((record) => record.id).sort()).toEqual([a.id, aaaa.id].sort());
    expect(handler.requests).toHaveLength(1);
    expect(handler.requests[0]).toMatchObject({
      kind: "cloudflare-apply",
      planHash: plan?.planHash,
      allowDestroy: true,
      confirmPhrase: APP,
    });
    expect(handler.requests[0]?.details).toContain(`A ${NAME}`);
    expect(handler.requests[0]?.details).toContain(`AAAA ${NAME}`);
    // Only the updater's records at the app's name went.
    expect(zone.records.map((record) => record.id)).not.toContain(a.id);
    expect(zone.records.map((record) => record.id)).not.toContain(aaaa.id);
    expect(zone.records.map((record) => `${record.type} ${record.name}`).sort()).toEqual([
      `A blog.${ZONE}`,
      `CAA ${NAME}`,
      `CNAME www.${NAME}`,
      `TXT ${NAME}`,
    ]);
    const deletes = fake.calls.filter((call) => call.method === "DELETE");
    expect(deletes.map((call) => call.path).sort()).toEqual(
      [a.id, aaaa.id].map((id) => `/zones/${zone.id}/dns_records/${id}`).sort(),
    );
    const entry = deps.audit.entries.find((e) => e.action === "updater records deleted");
    expect(entry).toMatchObject({
      kind: "provider-call",
      target: APP,
      decision: "approved",
      phase: "provision",
    });
    expect(entry?.detail).toContain(a.id);
    expect(entry?.detail).toContain(aaaa.id);
    expect(entry?.detail).toContain(plan?.planHash);
    const text = seen(deps, fake, plan);
    expect(text).not.toContain(HOME_IPV4);
    expect(text).not.toContain(HOME_IPV6);
    expect(text).not.toContain(TOKEN);
  });

  it("asks nothing and deletes nothing when there is no record of the updater's", async () => {
    const { fake, zone, client } = setup();
    const handler = new ScriptedApprovalHandler();
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    expect(await deleteUpdaterRecords(deps, client, request(zone.id))).toBeUndefined();
    expect(handler.requests).toEqual([]);
    expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(deps.audit.entries.filter((e) => e.action === "updater records deleted")).toEqual([]);
  });

  it("deletes nothing when the approval is refused, and says how to approve in a script", async () => {
    const { fake, zone, client } = setup();
    withUpdaterRecords(fake);
    const before = zone.records.length;
    const deps = await createTestPhaseDeps({
      approvalHandler: new ScriptedApprovalHandler([false]),
    });
    const plan = await planRecordDeletion(client, { app: APP, zoneId: zone.id, name: NAME });

    const error = await deleteUpdaterRecords(deps, client, request(zone.id)).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(PlanRefusedError);
    expect((error as PlanRefusedError).message).toContain("Nothing in Cloudflare was changed.");
    expect((error as PlanRefusedError).hint).toContain(COMMAND);
    expect((error as PlanRefusedError).hint).toContain(
      `--approve ${plan?.planHash} --confirm ${APP}`,
    );
    expect(zone.records).toHaveLength(before);
    expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    const text = seen(deps, fake, error);
    expect(text).not.toContain(HOME_IPV4);
    expect(text).not.toContain(HOME_IPV6);
  });

  it("reads the records again after the approval and deletes nothing when the hash changed", async () => {
    const { fake, zone, client } = setup();
    withUpdaterRecords(fake);
    // The updater writes a new AAAA while the user approves the plan.
    const handler = new ScriptedApprovalHandler(() => {
      fake.addRecord(zone, {
        type: "AAAA",
        name: NAME,
        content: "2001:db8:5::78",
        proxied: true,
        comment: UPDATER_RECORD_COMMENT,
      });
      return true;
    });
    const deps = await createTestPhaseDeps({ approvalHandler: handler });
    const before = zone.records.length;

    const error = await deleteUpdaterRecords(deps, client, request(zone.id)).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({ code: "PLAN_HASH_MISMATCH" });
    expect((error as OpsCrewError).message).toContain("Nothing in Cloudflare was changed.");
    expect((error as OpsCrewError).hint).toContain(COMMAND);
    expect(zone.records).toHaveLength(before + 1);
    expect(fake.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(deps.audit.entries.filter((e) => e.action === "updater records deleted")).toEqual([]);
    const text = seen(deps, fake, error);
    expect(text).not.toContain(HOME_IPV4);
    expect(text).not.toContain("2001:db8:5::78");
  });
});
