/**
 * A server at home in a move to another Cloudflare account (plan 15.), with both accounts' fakes
 * (one token each): the address updater's records count as OpsCrew's, the zone plan copies them
 * with their content masked and the switch refreshes them from Old as its updater changes them;
 * the finish gives the updater New's zone and New's updater token through the server's host plan
 * approved by its hash; an abort deletes the copies from New's zone when that zone stays. Old's
 * pieces never change before the finish, and no token or home address goes anywhere it shouldn't.
 */
import { findExecutable, OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATER_RECORD_COMMENT } from "../home/records";
import { HOME_IPV4, HOME_IPV6, ownPlan, type ScriptedApprovalHandler } from "../testing";
import { type AbortHarness, abortHarness, B_PIECES } from "./abort.fakes";
import { otherAppHostnames } from "./checks";
import { deleteUpdaterCopies, updaterToB } from "./home";
import {
  A_UPDATER,
  ALL_BUT_DNS,
  B_UPDATER,
  HOME_NAME,
  homeFinishWorld,
  homePlan,
  sha256,
  updaterRecords,
} from "./home.fakes";
import type { MoveMark } from "./marks";
import { readAppProgress } from "./progress";
import { asScript } from "./record.fakes";
import { type MoveHarness, moveHarness, ZONE } from "./session.fakes";
import { shadowRoots } from "./shadow";
import { BLOG, DOCS, switchHarness } from "./switch.fakes";
import { B_UPDATER_TOKEN_VAR } from "./texts";
import type { MoveResult } from "./types";
import { applyZone, planZone, type ZonePlan } from "./zone";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The home's next IPv4 addresses as its provider gives it others, and an IPv6 address gone. */
const NEXT_IPV4 = "198.51.100.8";
const THIRD_IPV4 = "198.51.100.9";
const FOURTH_IPV4 = "198.51.100.11";
const OLD_IPV6 = "2001:db8:1:2::31";
/** Every home address of these tests: none is ever said, asked, recorded or saved. */
const ADDRESSES = [HOME_IPV4, HOME_IPV6, NEXT_IPV4, THIRD_IPV4, FOURTH_IPV4, OLD_IPV6];

/** Another app at home in the zone, prepared from its own repository. */
const CAM: MoveMark = { app: "cam", envs: ["prod"], hosts: [`cam.${ZONE}`], sites: [], access: [] };

/** The error `run` stops with. */
async function failure(run: Promise<unknown>): Promise<OpsCrewError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  return error as OpsCrewError;
}

/**
 * The home addresses found in anything said, asked or recorded (`texts` too), and in a call to
 * Cloudflare other than those that write the copies in New's zone (which must hold them): its
 * batch of new records and an update of one.
 */
function addressLeaks(h: MoveHarness, ...texts: string[]): string[] {
  const handler = h.deps.approvalHandler as ScriptedApprovalHandler;
  const said = [
    ...texts,
    h.deps.reporter.text(),
    JSON.stringify(h.deps.audit.entries),
    JSON.stringify(handler.requests),
  ].join("\n");
  const fresh = h.cloudflare.account("New").id;
  const sent = JSON.stringify(
    h.cloudflare.calls.filter(
      (call) =>
        !(
          call.accountId === fresh &&
          (call.path.endsWith("/dns_records/batch") ||
            (call.method === "PATCH" && call.path.includes("/dns_records/")))
        ),
    ),
  );
  return ADDRESSES.filter((address) => said.includes(address) || sent.includes(address));
}

/** The address updater's records at `name` in `zone`, as `type content`. */
function updaterAt(
  zone: { records: { type: string; name: string; content: string; comment: string | null }[] },
  name = HOME_NAME,
) {
  return zone.records
    .filter((record) => record.name === name && record.comment === UPDATER_RECORD_COMMENT)
    .map((record) => `${record.type} ${record.content}`)
    .sort();
}

describe.skipIf(!findExecutable("git"))("a server at home in a move: its records", () => {
  it("counts the address updater's records as OpsCrew's: another app's at home is named, the app's own is not", async () => {
    const h = await moveHarness({ plans: () => ({ prod: homePlan() }) });
    const aZone = h.cloudflare.zone(ZONE, "Old");
    updaterRecords(h.cloudflare, aZone);
    updaterRecords(h.cloudflare, aZone, { name: `cam.${ZONE}` });
    const others = await otherAppHostnames(await h.open({ to: "New" }));
    expect(others).toContain(`cam.${ZONE}`);
    expect(others).toContain(`blog.${ZONE}`);
    expect(others).not.toContain(HOME_NAME);
    expect(h.readOnly()).toBe(true);
  });

  it("copies the updater's records with their content masked, updates the copies in place as Old's updater changes them, and keeps for the switch one it no longer has", async () => {
    const h = await moveHarness({ plans: () => ({ prod: homePlan() }) });
    const aZone = h.cloudflare.zone(ZONE, "Old");
    const own = updaterRecords(h.cloudflare, aZone, { ipv4: HOME_IPV4, ipv6: HOME_IPV6 });
    const aaaa = own.aaaa as NonNullable<typeof own.aaaa>;
    h.deps.interactive = true;
    const session = await h.open({ to: "New" });

    const first = await planZone(session);
    expect(first.create.map((r) => r.name)).not.toContain(HOME_NAME);
    expect(first.skipped.map((s) => s.record.name)).not.toContain(HOME_NAME);
    expect(first.updater).toEqual({
      create: [
        { from: own.a.id, type: "A", name: HOME_NAME },
        { from: aaaa.id, type: "AAAA", name: HOME_NAME },
      ].sort((x, y) => x.from.localeCompare(y.from)),
      update: [],
      delete: [],
    });
    expect(first.details).toContain(`A ${HOME_NAME} <server address> (proxied)`);
    expect(first.details).toContain(`AAAA ${HOME_NAME} <server address> (proxied)`);
    expect(await applyZone(session, first)).toBeUndefined();
    const bZone = h.cloudflare.zone(ZONE, "New");
    expect(updaterAt(bZone)).toEqual([`A ${HOME_IPV4}`, `AAAA ${HOME_IPV6}`]);
    const copyOf = (type: string) =>
      bZone.records.find((r) => r.name === HOME_NAME && r.type === type);
    const copy = copyOf("A");

    // Old's updater writes the home's new IPv4 address and removes its AAAA, IPv6 being gone.
    own.a.content = NEXT_IPV4;
    aZone.records.splice(aZone.records.indexOf(aaaa), 1);
    const later = await planZone(session);
    expect(later.create).toEqual([]);
    expect(later.updater).toEqual({
      create: [],
      update: [{ id: copy?.id, from: own.a.id, type: "A", name: HOME_NAME }],
      delete: [],
    });
    expect(later.differ).toEqual([]);
    expect(later.onlyInB).toEqual([]);
    expect(later.details).toContain(
      `- Update the new account's copies of the address updater's records in place to what it keeps in the account Old now (it writes there until the move's finish): A ${HOME_NAME}.`,
    );
    expect(later.details).toContain(
      `- Kept until the switch, which deletes them with the zone's name typed: the new account's copies of the address updater's records that it no longer keeps in the account Old: AAAA ${HOME_NAME}.`,
    );
    expect(await applyZone(session, later)).toBeUndefined();
    // Updated in place, the same record; the AAAA is the switch's to delete.
    expect(copyOf("A")).toBe(copy);
    expect(updaterAt(bZone)).toEqual([`A ${NEXT_IPV4}`, `AAAA ${HOME_IPV6}`]);
    const writes = h.cloudflare.calls.filter((call) => call.method !== "GET");
    expect(writes.filter((call) => call.method === "DELETE")).toEqual([]);
    expect(writes.filter((call) => call.method === "PATCH").map((call) => call.path)).toEqual([
      `/zones/${bZone.id}/dns_records/${copy?.id}`,
    ]);
    const entry = h.deps.audit.entries.find((e) => e.action === "updater record copies refreshed");
    expect(entry).toMatchObject({
      kind: "provider-call",
      decision: "approved",
      target: later.planHash,
    });
    expect(entry?.detail).toBe(`${ZONE}: updated A ${copy?.id}; deleted none`);
    // Nothing more to do, and Old saw no write.
    expect(await planZone(session)).toMatchObject({
      create: [],
      updater: { create: [], update: [], delete: [] },
      differ: [],
    });
    expect(
      h.cloudflare.calls.filter(
        (call) => call.method !== "GET" && call.accountId === h.cloudflare.account("Old").id,
      ),
    ).toEqual([]);
    expect(addressLeaks(h, first.details, later.details)).toEqual([]);
    expect(h.leaks(first.details, later.details)).toBe(false);
  });

  it("hashes the updater's records without their content: two home addresses give one plan, and the apply writes the one read then", async () => {
    const h = await moveHarness({ plans: () => ({ prod: homePlan() }) });
    const aZone = h.cloudflare.zone(ZONE, "Old");
    const own = updaterRecords(h.cloudflare, aZone, { ipv4: HOME_IPV4 });
    h.deps.interactive = true;
    const session = await h.open({ to: "New" });
    /** The plan's hashed part: everything but its text and the values read for it. */
    const hashedPart = (plan: ZonePlan) => {
      const { details: _details, values: _values, ...rest } = plan;
      return JSON.stringify(rest);
    };

    // A copy to create.
    const create = await planZone(session);
    own.a.content = NEXT_IPV4;
    expect((await planZone(session)).planHash).toBe(create.planHash);
    expect(hashedPart(create)).not.toContain(HOME_IPV4);
    expect(await applyZone(session, create)).toBeUndefined();
    const bZone = h.cloudflare.zone(ZONE, "New");
    expect(updaterAt(bZone)).toEqual([`A ${NEXT_IPV4}`]);

    // A copy to update in place.
    own.a.content = THIRD_IPV4;
    const update = await planZone(session);
    own.a.content = FOURTH_IPV4;
    expect((await planZone(session)).planHash).toBe(update.planHash);
    expect(hashedPart(update)).not.toContain(THIRD_IPV4);
    expect(hashedPart(update)).not.toContain(NEXT_IPV4);
    expect(await applyZone(session, update)).toBeUndefined();
    expect(updaterAt(bZone)).toEqual([`A ${FOURTH_IPV4}`]);
    expect(addressLeaks(h, create.details, update.details)).toEqual([]);
  });

  it("the switch refuses while an app at home is in no mark, then updates its copies from Old in place and deletes the one Old no longer has, with the zone's name typed", async () => {
    const uncovered = await switchHarness();
    updaterRecords(uncovered.cloudflare, uncovered.aZone, { name: `cam.${ZONE}` });
    uncovered.deps.interactive = true;
    const refused = await failure(uncovered.run());
    expect(refused.message).toContain(
      `cam.${ZONE} in ${ZONE} belongs to OpsCrew apps not prepared`,
    );
    expect(refused.message).toMatch(/Nothing was changed\.$/);
    expect(uncovered.readOnly()).toBe(true);

    const h = await switchHarness({ marks: [BLOG, DOCS, CAM] });
    const cam = `cam.${ZONE}`;
    updaterRecords(h.cloudflare, h.aZone, { name: cam, ipv4: NEXT_IPV4 });
    const copies = updaterRecords(h.cloudflare, h.bZone, {
      name: cam,
      ipv4: HOME_IPV4,
      ipv6: OLD_IPV6,
    });
    h.deps.interactive = true;
    const result = await h.run();
    expect(result).toMatchObject({ step: "switched", done: true });
    const [approval] = h.asked();
    expect(approval).toMatchObject({ kind: "domain-settings", confirmPhrase: ZONE });
    expect(approval?.details).toContain(
      `Update the new account's copies of the address updater's records in place to what it keeps in the account Old now (it writes there until the move's finish): A ${cam}.`,
    );
    expect(approval?.details).toContain(
      `Delete the new account's copies of the address updater's records that it no longer keeps in the account Old: AAAA ${cam}.`,
    );
    expect(updaterAt(h.bZone, cam)).toEqual([`A ${NEXT_IPV4}`]);
    expect(h.bZone.records.find((r) => r.name === cam)).toBe(copies.a);
    const entry = h.deps.audit.entries.find((e) => e.action === "updater record copies refreshed");
    expect(entry?.detail).toBe(
      `${ZONE}: updated A ${copies.a.id}; deleted AAAA ${copies.aaaa?.id}`,
    );
    expect(h.writes("Old")).toEqual([]);
    expect(addressLeaks(h, JSON.stringify(result))).toEqual([]);
    expect(h.leaks(JSON.stringify(result), JSON.stringify(h.asked()))).toBe(false);
  });
});

describe.skipIf(!findExecutable("git"))("a server at home in a move: the finish's updater", () => {
  it("gives the updater New's zone and token through the host plan approved by its hash, the token on the server only", async () => {
    const w = await homeFinishWorld();
    expect(await updaterToB(w.session, w.environment)).toBeUndefined();

    // The token's checks only read; one approval, the host plan's, bound to its hash.
    expect(w.cloudflare.calls.every((call) => call.method === "GET")).toBe(true);
    expect(w.handler.requests.map((r) => r.kind)).toEqual(["host-apply"]);
    const [apply] = w.host.applies;
    expect(w.host.applies).toHaveLength(1);
    expect(apply?.options.approvedHash).toBe(w.handler.requests[0]?.planHash);
    expect(apply?.plan.steps.find((step) => step.id === "dns-updater")).toMatchObject({
      state: "change",
      params: {
        app: "shop",
        zoneId: w.bZone.id,
        name: HOME_NAME,
        tokenSha256: sha256(B_UPDATER),
      },
    });
    expect(apply?.options.secrets?.dnsUpdaterToken).toBe(B_UPDATER);
    // Audited under the move's own phase.
    const applied = w.deps.audit.entries.filter((e) => e.action === "host apply started");
    expect(applied.map((e) => e.phase)).toEqual(["cloudflare-move"]);
    expect(await w.leaksOf(w.secrets)).toEqual([]);

    // The next run finds the updater on New's zone: nothing asked, and no token needed.
    delete w.session.deps.env[B_UPDATER_TOKEN_VAR];
    expect(await updaterToB(w.session, w.environment)).toBeUndefined();
    expect(w.handler.requests).toHaveLength(1);
    expect(w.host.applies).toHaveLength(1);
    expect(w.deps.reporter.text()).toContain(
      `The address updater on your server keeps ${HOME_NAME} in the account New already; nothing on it changes.`,
    );
  });

  it("asks for New's updater token once in a terminal when the variable is not set, and keeps no copy", async () => {
    const w = await homeFinishWorld({ token: null });
    w.session.services.askUpdaterToken = async (question) => {
      w.asked.push(question);
      return B_UPDATER;
    };
    expect(await updaterToB(w.session, w.environment)).toBeUndefined();
    expect(w.asked).toHaveLength(1);
    expect(w.asked[0]?.zone).toBe(ZONE);
    expect(w.asked[0]?.prompt).toContain(`Zone → DNS → Edit and Include → Specific zone → ${ZONE}`);
    expect(w.host.applies[0]?.options.secrets?.dnsUpdaterToken).toBe(B_UPDATER);
    expect(await w.leaksOf(w.secrets)).toEqual([]);
  });

  it("refuses, before any change, without the token in a script, and with OpsCrew's own, Old's or a wider one", async () => {
    const unset = await homeFinishWorld({ token: null });
    unset.session.services.askUpdaterToken = async () => {
      throw new Error("a script has no terminal");
    };
    const missing = await failure(updaterToB(asScript(unset), unset.environment));
    expect(missing.code).toBe("CREDENTIALS_MISSING");
    expect(missing.message).toMatch(/Nothing was changed\.$/);
    expect(missing.hint).toContain(`Then set ${B_UPDATER_TOKEN_VAR} to it`);
    expect(missing.hint).toContain(`Include → Specific zone → ${ZONE}`);
    expect(unset.host.applies).toEqual([]);
    expect(unset.handler.requests).toEqual([]);

    const cases: [string, (w: Awaited<ReturnType<typeof homeFinishWorld>>) => string, string][] = [
      ["OpsCrew's own", (w) => w.tokens.b, "is OpsCrew's own Cloudflare token"],
      ["Old's", () => A_UPDATER, `can't read ${ZONE}'s DNS records`],
      [
        "a wider one",
        (w) => {
          w.cloudflare.tokens.set(B_UPDATER, {
            accounts: [w.fresh.id],
            denied: new Set(ALL_BUT_DNS.filter((permission) => permission !== "ssl")),
          });
          return B_UPDATER;
        },
        "it can also read the zone's SSL and certificates",
      ],
    ];
    for (const [, token, words] of cases) {
      const w = await homeFinishWorld();
      w.session.deps.env[B_UPDATER_TOKEN_VAR] = token(w);
      const error = await failure(updaterToB(w.session, w.environment));
      expect(error.code).toBe("CREDENTIALS_INVALID");
      expect(error.message).toContain(words);
      expect(error.message).toMatch(/Nothing was changed\.$/);
      expect(w.host.applies).toEqual([]);
      expect(w.handler.requests).toEqual([]);
      expect(await w.leaksOf(w.secrets, error.message, error.hint ?? "")).toEqual([]);
    }
  });

  it("in a script, stops at the host plan with its hash, and applies exactly that plan with --approve", async () => {
    const w = await homeFinishWorld();
    const stop = await updaterToB(asScript(w), w.environment);
    const hash = stop?.pendingPlanHash ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stop?.next[0]).toContain(`opscrew cloudflare move --finish --approve ${hash}\``);
    expect(w.host.applies).toEqual([]);
    expect(w.handler.requests).toEqual([]);
    expect((await readAppProgress(w.environment.paths)).pending).toMatchObject({
      action: "updater",
      environment: "prod",
      planHash: hash,
    });

    const again = asScript(w, hash);
    expect(await updaterToB(again, w.environment)).toBeUndefined();
    expect(again.approve).toBeUndefined();
    expect(w.host.applies.map((apply) => apply.options.approvedHash)).toEqual([hash]);
    expect((await readAppProgress(w.environment.paths)).pending).toBeUndefined();
    expect(await w.leaksOf(w.secrets, JSON.stringify(stop))).toEqual([]);
  });

  it("keeps New's tunnel in the host plan of a server at home with Portainer on a subdomain, from New's state", async () => {
    const base = homePlan();
    const subdomain = ownPlan({ proxied: true, deployed: true, portainer: "subdomain" });
    const w = await homeFinishWorld({
      plan: DeployPlanSchema.parse({
        ...base,
        dns: { ...base.dns, zone: subdomain.dns.zone ?? ZONE },
        portainer: subdomain.portainer,
      }),
    });
    const tunnelId = "7a2e1d3f-2222-4b6c-8d4e-123456789abc";
    const token = fakeSecret("cloudflare-token", "b-home-tunnel");
    const [main] = await shadowRoots(w.session, w.environment);
    if (main === undefined) throw new Error("the app has a main root");
    w.engine.stateOutputs.set(main.statePath, { tunnel_id: tunnelId, tunnel_token: token });
    expect(await updaterToB(w.session, w.environment)).toBeUndefined();
    const [apply] = w.host.applies;
    expect(apply?.plan.steps.find((step) => step.id === "tunnel-connector")?.params).toMatchObject({
      tunnelId,
    });
    expect(apply?.plan.steps.find((step) => step.id === "dns-updater")?.params).toMatchObject({
      zoneId: w.bZone.id,
    });
    expect(apply?.options.secrets).toMatchObject({
      tunnelToken: token,
      dnsUpdaterToken: B_UPDATER,
    });
    expect(await w.leaksOf([...w.secrets, token])).toEqual([]);
  });

  it("does nothing for an app whose server is not at home", async () => {
    const w = await homeFinishWorld();
    const plan = ownPlan({ proxied: true, deployed: true });
    expect(await updaterToB(w.session, { ...w.environment, plan })).toBeUndefined();
    expect(w.host.inspections).toBe(0);
    expect(w.handler.requests).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("a server at home in a move: the abort", () => {
  /** The app at home prepared in New, with its updater's copies and cam's in New's zone. */
  async function homeAbort(marks: MoveMark[] = [BLOG]): Promise<AbortHarness> {
    const h = await abortHarness({
      plan: homePlan(),
      marks,
      shadow: { main: [B_PIECES.certificates] },
    });
    const bZone = h.bZone;
    if (bZone === undefined) throw new Error("New has the zone");
    updaterRecords(h.cloudflare, bZone, { ipv4: HOME_IPV4, ipv6: HOME_IPV6 });
    updaterRecords(h.cloudflare, bZone, { name: `cam.${ZONE}`, ipv4: NEXT_IPV4 });
    return h;
  }

  /** Each approval asked: its kind, whether it allows a deletion, and the name typed. */
  const asked = (h: AbortHarness) =>
    h.handler.requests.map((r) => [r.kind, r.allowDestroy === true, r.confirmPhrase]);

  it("deletes the updater's copies from New's zone while another app keeps it there, with the app's name typed", async () => {
    const h = await homeAbort();
    h.deps.interactive = true;
    const result = await h.run();
    expect(result).toMatchObject({ step: "aborted", done: true });
    expect(asked(h)).toEqual([
      ["cloudflare-apply", false, undefined],
      ["iac-apply", true, "shop"],
      ["cloudflare-apply", true, "shop"],
    ]);
    const bZone = h.bZone as NonNullable<AbortHarness["bZone"]>;
    expect(h.cloudflare.zones).toContain(bZone);
    expect(updaterAt(bZone)).toEqual([]);
    // Another app's copy, and the rest of New's zone, stay.
    expect(updaterAt(bZone, `cam.${ZONE}`)).toEqual([`A ${NEXT_IPV4}`]);
    expect(h.deps.audit.entries.map((e) => e.action)).toContain("updater records deleted");
    expect(h.writes("Old")).toEqual([]);
    expect(h.aUnchanged()).toBe(true);
    expect(await h.leaks(ADDRESSES, JSON.stringify(result))).toBe(false);
  });

  it("asks nothing of the copies when New's zone goes with them", async () => {
    const h = await homeAbort([]);
    h.deps.interactive = true;
    const result = await h.run();
    expect(result).toMatchObject({ step: "aborted", done: true });
    expect(asked(h).at(-1)).toEqual(["cloudflare-apply", true, ZONE]);
    expect(asked(h).filter(([, , name]) => name === "shop")).toHaveLength(1);
    expect(h.cloudflare.zones.some((zone) => zone.accountId === h.fresh.id)).toBe(false);
    expect(await h.leaks(ADDRESSES, JSON.stringify(result))).toBe(false);
  });

  it("in a script, stops at the copies' deletion with its hash and the app's name, refuses it once they changed, and deletes them with the new hash", async () => {
    const h = await homeAbort();
    const bZone = h.bZone as NonNullable<AbortHarness["bZone"]>;
    const stops: MoveResult[] = [];
    let result = await h.run();
    while (
      !result.done &&
      (await readAppProgress(h.deps.paths)).pending?.action !== "abort-updater"
    ) {
      stops.push(result);
      result = await h.run({ approvePlanHash: result.pendingPlanHash as string });
    }
    const hash = result.pendingPlanHash as string;
    expect(result.next[0]).toContain(`--confirm shop --approve ${hash}\``);
    expect(h.deps.reporter.text()).toContain(
      `Delete the address updater's records of shop that the move copied into ${ZONE} in the Cloudflare account New, which stays there for other apps (hash ${hash}):`,
    );
    expect(updaterAt(bZone)).toHaveLength(2);

    // The copies change before the approved run: nothing is deleted, and the next run shows them.
    h.cloudflare.addRecord(bZone, {
      type: "AAAA",
      name: HOME_NAME,
      content: OLD_IPV6,
      proxied: true,
      comment: UPDATER_RECORD_COMMENT,
    });
    const changed = await failure(h.run({ approvePlanHash: hash }));
    expect(changed.code).toBe("PLAN_HASH_MISMATCH");
    expect(changed.message).toContain("Nothing in Cloudflare was changed.");
    expect(updaterAt(bZone)).toHaveLength(3);
    const shown = await h.run();
    const next = shown.pendingPlanHash as string;
    expect(next).not.toBe(hash);
    expect(await h.run({ approvePlanHash: next })).toMatchObject({ step: "aborted", done: true });
    expect(updaterAt(bZone)).toEqual([]);
    expect(updaterAt(bZone, `cam.${ZONE}`)).toEqual([`A ${NEXT_IPV4}`]);
    expect(h.writes("Old")).toEqual([]);
    expect(await h.leaks(ADDRESSES, JSON.stringify([stops, result, shown]), changed.message)).toBe(
      false,
    );
  });

  it("deletes nothing for an app whose server is not at home", async () => {
    const h = await homeAbort();
    const session = await h.open();
    const [environment] = session.environments;
    if (environment === undefined) throw new Error("prod is covered");
    environment.plan = ownPlan({ proxied: true, deployed: true });
    expect(await deleteUpdaterCopies(session)).toBeUndefined();
    expect(h.cloudflare.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
