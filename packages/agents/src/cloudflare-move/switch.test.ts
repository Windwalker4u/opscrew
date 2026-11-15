import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import { errorText, OpsCrewError } from "@opscrew/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLD_DS } from "../testing";
import { readMarks } from "./marks";
import { ZONE } from "./session.fakes";
import { BLOG, DOCS, OPS, type SwitchHarness, switchHarness } from "./switch.fakes";
import type { MoveResult } from "./types";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The error a run stops with, checked to say nothing was changed. */
async function refused(run: Promise<unknown>): Promise<OpsCrewError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OpsCrewError);
  expect((error as OpsCrewError).message).toMatch(/Nothing was changed\.$/);
  return error as OpsCrewError;
}

/** Everything said, approved, recorded and sent, for the leak check. */
const leaks = (h: SwitchHarness, ...results: unknown[]) =>
  h.leaks(JSON.stringify(results), JSON.stringify(h.asked()));

/** The zone's records in New of `type` named `name`. */
const inB = (h: SwitchHarness, type: string, name: string) =>
  h.bZone.records.filter((r) => r.type === type && r.name === name);

describe("switchMove: Porkbun", () => {
  it("plans and approves the switch with the zone typed, copies A's records, sets New's nameservers and measures the gap; the marks stay", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    const result = await h.run();
    expect(result).toEqual(expect.objectContaining({ step: "switched", done: true }));

    const [approval] = h.asked();
    expect(h.asked()).toHaveLength(1);
    expect(approval).toEqual(
      expect.objectContaining({ kind: "domain-settings", confirmPhrase: ZONE }),
    );
    expect(approval?.planHash).toMatch(/^[0-9a-f]{64}$/);
    for (const words of [
      "HTTPS visitors may get certificate errors",
      "A site on Cloudflare's hosting answers once its custom domains are attached",
      "may answer 526 from activation until its finish",
      `mail.${ZONE}`,
      "set at Porkbun through its API now",
    ]) {
      expect(approval?.details).toContain(words);
    }
    // A's user record copied; New's nameservers at Porkbun; the site's custom domain in New.
    expect(inB(h, "MX", ZONE)).toHaveLength(1);
    expect([...(h.api.nameservers.get(ZONE) ?? [])].sort()).toEqual(
      [...h.bZone.nameServers].sort(),
    );
    expect(h.b.workerDomains.map((d) => [d.hostname, d.service])).toEqual([
      [`docs.${ZONE}`, "docs"],
    ]);
    expect(h.bZone.status).toBe("active");
    expect(new Set(h.web.probes)).toEqual(
      new Set([`shop.${ZONE}`, `blog.${ZONE}`, `docs.${ZONE}`]),
    );
    // The marks stay; the switch file is gone.
    const session = await h.open();
    expect((await readMarks(session)).marks).toHaveLength(3);
    expect(await h.progress()).toBeUndefined();
    const actions = h.deps.audit.entries
      .filter((e) => e.phase === "cloudflare-move")
      .map((e) => e.action);
    for (const action of [
      "cloudflare records created",
      "set nameservers",
      "activation check",
      "custom domains attached",
      "switch measured",
    ]) {
      expect(actions).toContain(action);
    }
    expect(h.deps.reporter.text()).toContain("switched: active in the new account");
    expect(result.next.some((line) => line.includes("--finish` here for shop"))).toBe(true);
    // A saw no write.
    expect(h.writes("Old")).toEqual([]);
    expect(leaks(h, result)).toBe(false);
  });

  it("goes on after an interruption past the nameserver change with the same time, asking nothing again", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    h.sleeps.onSleep = () => {
      throw new Error("interrupted");
    };
    await expect(h.run()).rejects.toThrow("interrupted");
    const first = await h.progress();
    expect(first?.nameserversSetAt).toBeDefined();
    h.sleeps.onSleep = undefined;
    h.time.ms += 60_000;
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.asked()).toHaveLength(1);
    expect(inB(h, "MX", ZONE)).toHaveLength(1);
    expect(h.api.count("setNameservers")).toBe(1);
  });

  it("with DNSSEC: the first approved plan removes the DS record and stops; after the wait a new plan and approval; DNSSEC on in New", async () => {
    const h = await switchHarness({ dsAtStart: true });
    h.deps.interactive = true;
    h.api.dsRecords.set(ZONE, [OLD_DS]);
    h.web.ds = [OLD_DS];

    const removed = await h.run();
    expect(removed).toEqual(expect.objectContaining({ done: false, step: "prepared" }));
    expect(h.asked()).toHaveLength(1);
    expect(h.asked()[0]?.details).toContain("Remove the DNSSEC (DS) records");
    expect(h.api.dsRecords.get(ZONE)).toEqual([]);
    expect(h.api.count("setNameservers")).toBe(0);
    expect(inB(h, "MX", ZONE)).toEqual([]);
    expect(removed.next.join(" ")).toMatch(/again after 2026-11-2\d/);

    // Gone from the public DNS too, but resolvers may still hold it: a wait, nothing asked.
    h.web.ds = [];
    const waiting = await h.run();
    expect(waiting.done).toBe(false);
    expect(h.asked()).toHaveLength(1);
    expect(h.api.count("setNameservers")).toBe(0);

    h.time.ms += 50 * 3600_000;
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.asked()).toHaveLength(2);
    expect(h.asked()[1]?.planHash).not.toBe(h.asked()[0]?.planHash);
    expect(h.api.count("setNameservers")).toBe(1);
    // DNSSEC on in New, and its DS record published at Porkbun.
    expect(h.bZone.dnssec.status).not.toBe("disabled");
    expect(h.api.dsRecords.get(ZONE)).toHaveLength(1);
    expect(h.deps.audit.entries.map((e) => e.action)).toContain("DNSSEC on (B)");
    expect(h.writes("Old")).toEqual([]);
    expect(leaks(h, removed, waiting, result)).toBe(false);
  });

  it("reads everything again after the approval and refuses the switch when A changed meanwhile", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    const handler = h.deps.approvalHandler;
    const ask = handler.request.bind(handler);
    handler.request = async (request) => {
      h.cloudflare.addRecord(h.aZone, { type: "TXT", name: ZONE, content: '"v=spf1 -all"' });
      return ask(request);
    };
    const error = await refused(h.run());
    expect(error.code).toBe("PLAN_HASH_MISMATCH");
    expect(h.writes("New")).toEqual([]);
    expect(h.api.count("setNameservers")).toBe(0);
  });

  it("saves the plan in a run nobody can answer and stops with the exact command; that command applies it", async () => {
    const h = await switchHarness();
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    const hash = stopped.pendingPlanHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stopped.next[0]).toContain(
      `opscrew cloudflare move --switch --confirm ${ZONE} --approve ${hash}`,
    );
    expect((await h.progress())?.pending?.planHash).toBe(hash);
    expect(h.asked()).toEqual([]);
    expect(h.writes("New")).toEqual([]);

    const result = await h.run({ approvePlanHash: hash });
    expect(result.done).toBe(true);
    expect(h.asked()[0]?.planHash).toBe(hash);
  });
});

describe("switchMove: refusals", () => {
  it("refuses before any change while an OpsCrew name in A's zone is in no mark", async () => {
    const h = await switchHarness({ marks: [BLOG] });
    h.deps.interactive = true;
    const error = await refused(h.run());
    expect(error.message).toContain(`docs.${ZONE}`);
    expect(error.hint).toContain("opscrew cloudflare move --to");
    expect(h.readOnly()).toBe(true);
    expect(h.asked()).toEqual([]);
  });

  it("refuses before any change while a mark can't be read, though every name is covered", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    h.cloudflare.addRecord(h.bZone, {
      type: "TXT",
      name: `_opscrew-move.wiki-0123abcd.${ZONE}`,
      content: '"opscrew-move=1; part=1/2; app=wiki; hosts=wiki.example.com"',
    });
    const error = await refused(h.run());
    expect(error.message).toContain("_opscrew-move.wiki-0123abcd");
    expect(h.readOnly()).toBe(true);
  });

  it("refuses before any change when New's zone has A's nameservers", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    h.bZone.nameServers = [...h.aZone.nameServers];
    const error = await refused(h.run());
    expect(error.message).toContain("would change nothing");
    expect(error.hint).toContain("opscrew cloudflare move --abort");
    expect(h.readOnly()).toBe(true);
    expect(h.cloudflare.calls.some((c) => c.path.endsWith("/activation_check"))).toBe(false);
    expect(await h.progress()).toBeUndefined();
  });

  it("refuses an app that is not prepared yet", async () => {
    const h = await switchHarness({ step: "started" });
    const error = await refused(h.run());
    expect(error.hint).toContain("opscrew cloudflare move");
    expect(h.readOnly()).toBe(true);
  });
});

describe("switchMove: Cloudflare Registrar and another registrar", () => {
  it("Cloudflare Registrar: shows the dashboard steps of the move between accounts, then a later run finds the delegation and goes on", async () => {
    const h = await switchHarness({ registrar: "cloudflare" });
    h.deps.interactive = true;
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    const steps = stopped.next.join("\n");
    expect(steps).toContain("Domain Registration");
    expect(steps).toContain("within five days");
    expect(h.asked()[0]?.details).toContain("Cloudflare Registrar's move between accounts");
    expect(inB(h, "MX", ZONE)).toHaveLength(1);

    // The registration moved; the registry names New's nameservers.
    h.holder.accountId = h.b.id;
    h.web.ns = [...h.bZone.nameServers];
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.asked()).toHaveLength(1);
    expect(h.deps.reporter.text()).toContain("measured from this run");
    expect(h.writes("Old")).toEqual([]);
    expect(leaks(h, stopped, result)).toBe(false);
  });

  it("Cloudflare Registrar with DNSSEC: stops while it is on or being turned off in A, waits once the DS record is gone, then plans", async () => {
    const h = await switchHarness({ registrar: "cloudflare", dsAtStart: true });
    h.deps.interactive = true;
    h.aZone.dnssec.status = "active";
    h.web.ds = [OLD_DS];
    const on = await h.run();
    expect(on.done).toBe(false);
    expect(on.next[0]).toContain("Disable DNSSEC");
    (h.aZone.dnssec as { status: string }).status = "pending-disabled";
    const turningOff = await h.run();
    expect(turningOff.next[0]).toContain("removes the DS record from the registry on its own");
    // Still pending-disabled in A, but the registry no longer publishes it: the wait from now.
    h.web.ds = [];
    const waiting = await h.run();
    expect(waiting.next[0]).toMatch(/again after 2026-11-2\d/);
    expect(h.asked()).toEqual([]);
    expect(h.writes("New")).toEqual([]);

    h.time.ms += 30 * 3600_000;
    const planned = await h.run();
    expect(planned.done).toBe(false);
    expect(h.asked()).toHaveLength(1);
    expect(planned.next.join(" ")).toContain("Domain Registration");

    // Once the registration is in New, Cloudflare Registrar publishes New's DS record itself.
    h.holder.accountId = h.b.id;
    h.web.ns = [...h.bZone.nameServers];
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.bZone.dnssec.status).toBe("pending");
    expect(result.next.join(" ")).not.toContain("DS record");
    expect(h.writes("Old")).toEqual([]);
  });

  it("Namecheap with DNSSEC at the start: waits as after a removal, then lists the finishes first and the DS record to add last, auditing only what it wrote", async () => {
    const h = await switchHarness({ registrar: "namecheap", dsAtStart: true });
    h.deps.interactive = true;
    const waiting = await h.run();
    expect(waiting.done).toBe(false);
    expect(waiting.next[0]).toMatch(/again after 2026-11-2\d/);
    expect(h.asked()).toEqual([]);

    h.time.ms += 30 * 3600_000;
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.api.count("setNameservers")).toBe(1);
    expect(result.next[0]).toContain("--finish");
    expect(result.next.at(-1)).toContain("Add this DS record");
    const actions = h.deps.audit.entries.map((e) => e.action);
    expect(actions).toContain("enable DNSSEC");
    expect(actions).not.toContain("DNSSEC on (B)");
  });

  it("another registrar: shows the nameservers to set, and goes on once the public DNS shows them", async () => {
    const h = await switchHarness({ registrar: "other" });
    h.deps.interactive = true;
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    expect(stopped.next[0]).toContain(h.bZone.nameServers[0]);
    // This repository approved the switch: the run after the user's change asks nothing again.
    expect((await h.progress())?.approved).toBe(h.asked()[0]?.planHash);
    h.web.ns = [...h.bZone.nameServers];
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.asked()).toHaveLength(1);
  });
});

describe("switchMove: nameservers changed by hand, without the switch's approval", () => {
  it("while New's zone is pending: writes nothing unasked, warns of A's DS record, and asks one approval before the zone copy and the steps after activation", async () => {
    const h = await switchHarness({ registrar: "other" });
    h.web.ns = [...h.bZone.nameServers];
    h.web.ds = [OLD_DS];
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    const hash = stopped.pendingPlanHash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(h.writes("New")).toEqual([]);
    expect(h.cloudflare.calls.some((c) => c.path.endsWith("/activation_check"))).toBe(false);
    expect(h.deps.reporter.text()).toContain("still publishes a DNSSEC (DS) record");

    const result = await h.run({ approvePlanHash: hash });
    expect(result.done).toBe(true);
    expect(h.asked()).toHaveLength(1);
    expect(h.asked()[0]).toEqual(
      expect.objectContaining({ kind: "domain-settings", confirmPhrase: ZONE, planHash: hash }),
    );
    expect(h.asked()[0]?.details).toContain("already point at the new account");
    expect(inB(h, "MX", ZONE)).toHaveLength(1);
    expect(h.b.workerDomains.map((d) => d.hostname)).toEqual([`docs.${ZONE}`]);
    expect(h.writes("Old")).toEqual([]);
  });

  it("once New's zone is active: makes nothing before the approval, then measures without a nameserver time", async () => {
    const h = await switchHarness();
    // A run nobody answered saved a plan; then the nameservers were changed at Porkbun by hand.
    const saved = await h.run();
    expect(saved.pendingPlanHash).toBeDefined();
    h.api.nameservers.set(ZONE, [...h.bZone.nameServers]);
    h.cloudflare.activate(h.bZone);

    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    const hash = stopped.pendingPlanHash as string;
    expect(hash).not.toBe(saved.pendingPlanHash);
    expect(h.writes("New")).toEqual([]);
    expect(h.b.workerDomains).toEqual([]);

    const result = await h.run({ approvePlanHash: hash });
    expect(result.done).toBe(true);
    expect(h.b.workerDomains.map((d) => d.hostname)).toEqual([`docs.${ZONE}`]);
    expect(h.api.count("setNameservers")).toBe(0);
    expect(h.deps.reporter.text()).toContain("time of the nameserver change is unknown");
    const audit = h.deps.audit.entries.find((e) => e.action === "switch measured");
    expect(audit?.detail).not.toContain("NaN");
  });
});

describe("switchMove: right after activation", () => {
  it("makes the protected apps' Access applications, then their records to the app's tunnel, in New; a rerun makes nothing twice", async () => {
    const h = await switchHarness({
      marks: [BLOG, OPS, { ...OPS, app: "docs", hosts: [`docs.${ZONE}`], access: [] }],
    });
    h.deps.interactive = true;
    h.b.accessPolicies.push(
      { id: "policy-deploy", name: "OpsCrew deploy (ops)" },
      { id: "policy-portainer", name: "OpsCrew Portainer (ops)" },
    );
    h.b.identityProviders.push({ id: "pin-new", name: "One-time PIN", type: "onetimepin" });
    h.b.tunnels.push({ id: "tunnel-ops", name: "opscrew-ops", connections: [] });
    // The first run stops at the limit, so the next goes on measuring with the records there.
    h.web.status.set(`blog.${ZONE}`, 526);
    const stopped = await h.run();
    expect(stopped.done).toBe(false);
    h.web.status.delete(`blog.${ZONE}`);
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.web.probes).not.toContain(`ssh-ops.${ZONE}`);
    expect(h.web.probes).not.toContain(`portainer.ops.${ZONE}`);
    expect(h.b.accessApps).toEqual([
      expect.objectContaining({
        name: "OpsCrew SSH (ops)",
        domain: `ssh-ops.${ZONE}`,
        type: "self_hosted",
        policies: [{ id: "policy-deploy", precedence: 1 }],
        service_auth_401_redirect: true,
        app_launcher_visible: false,
        session_duration: "24h",
      }),
      expect.objectContaining({
        name: "OpsCrew Portainer (ops)",
        domain: `portainer.ops.${ZONE}`,
        policies: [{ id: "policy-portainer", precedence: 1 }],
        allowed_idps: ["pin-new"],
        auto_redirect_to_identity: true,
      }),
    ]);
    for (const name of [`ssh-ops.${ZONE}`, `portainer.ops.${ZONE}`]) {
      expect(inB(h, "CNAME", name)).toEqual([
        expect.objectContaining({
          content: "tunnel-ops.cfargotunnel.com",
          proxied: true,
          comment: OPSCREW_MANAGED_COMMENT,
        }),
      ]);
    }
    // Each application before the records it protects.
    const writes = h.writes("New").map((c) => `${c.method} ${c.path.split("?")[0]}`);
    const lastApp = writes.lastIndexOf(`POST /accounts/${h.b.id}/access/apps`);
    const records = writes.lastIndexOf(`POST /zones/${h.bZone.id}/dns_records/batch`);
    expect(lastApp).toBeGreaterThan(-1);
    expect(records).toBeGreaterThan(lastApp);

    const before = h.writes("New").length;
    const again = await h.run();
    expect(again.done).toBe(true);
    expect(h.writes("New")).toHaveLength(before);
    expect(leaks(h, stopped, result, again)).toBe(false);
  });

  it("goes on after the Access applications were made but not their records: no application twice", async () => {
    const h = await switchHarness({ marks: [BLOG, OPS, { ...DOCS, sites: [] }] });
    h.deps.interactive = true;
    h.b.accessPolicies.push(
      { id: "policy-deploy", name: "OpsCrew deploy (ops)" },
      { id: "policy-portainer", name: "OpsCrew Portainer (ops)" },
    );
    h.b.identityProviders.push({ id: "pin-new", name: "One-time PIN", type: "onetimepin" });
    h.b.tunnels.push({ id: "tunnel-ops", name: "opscrew-ops", connections: [] });
    // After the zone copy's batch: the next batch, the protected records', is refused.
    h.sleeps.onSleep = () => {
      h.sleeps.onSleep = undefined;
      h.cloudflare.faults.push({
        match: `POST /zones/${h.bZone.id}/dns_records/batch`,
        reply: {
          status: 400,
          body: {
            success: false,
            errors: [{ code: 1004, message: "DNS Validation Error" }],
            messages: [],
            result: null,
          },
        },
      });
    };
    await expect(h.run()).rejects.toThrow("DNS Validation Error");
    expect(h.b.accessApps).toHaveLength(2);
    expect(inB(h, "CNAME", `ssh-ops.${ZONE}`)).toEqual([]);

    const result = await h.run();
    expect(result.done).toBe(true);
    const posts = h.cloudflare.calls.filter(
      (c) => c.method === "POST" && c.path === `/accounts/${h.b.id}/access/apps`,
    );
    expect(posts).toHaveLength(2);
    expect(inB(h, "CNAME", `ssh-ops.${ZONE}`)).toHaveLength(1);
    expect(inB(h, "CNAME", `portainer.ops.${ZONE}`)).toHaveLength(1);
  });

  it("goes on after one of a site's two domains was attached: only the other is attached, A's stays", async () => {
    const www = `www.docs.${ZONE}`;
    const site = { ...DOCS, hosts: [`docs.${ZONE}`, www] };
    site.sites = [{ worker: "docs", domains: [`docs.${ZONE}`, www] }];
    const h = await switchHarness({ marks: [BLOG, site] });
    h.deps.interactive = true;
    // A record of its own holds the second domain in New: Cloudflare refuses to attach it there.
    const held = h.cloudflare.addRecord(h.bZone, {
      type: "CNAME",
      name: www,
      content: "elsewhere.example.net",
    });
    await expect(h.run()).rejects.toThrow("externally managed DNS records");
    expect(h.b.workerDomains.map((d) => d.hostname)).toEqual([`docs.${ZONE}`]);
    expect(h.cloudflare.account("Old").workerDomains).toHaveLength(1);

    h.bZone.records.splice(h.bZone.records.indexOf(held), 1);
    const from = h.cloudflare.calls.length;
    const result = await h.run();
    expect(result.done).toBe(true);
    const attaches = h.cloudflare.calls
      .slice(from)
      .filter((c) => c.method === "PUT" && c.path === `/accounts/${h.b.id}/workers/domains`);
    expect(attaches.map((c) => (c.body as { hostname: string }).hostname)).toEqual([www]);
    expect(h.b.workerDomains.map((d) => d.hostname).sort()).toEqual([`docs.${ZONE}`, www]);
    expect(h.cloudflare.account("Old").workerDomains).toHaveLength(1);
  });

  it("detaches a site's custom domain in A first when Cloudflare refuses it in New, and a rerun from another repository finds it attached", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    h.cloudflare.faults.push({
      match: `PUT /accounts/${h.b.id}/workers/domains`,
      reply: {
        status: 409,
        body: {
          success: false,
          // The code is the test's own: the fake answers 100117 for a record holding the hostname.
          errors: [{ code: 100110, message: "Hostname already has an assigned Worker" }],
          messages: [],
          result: null,
        },
      },
    });
    const result = await h.run();
    expect(result.done).toBe(true);
    expect(h.cloudflare.account("Old").workerDomains).toEqual([]);
    expect(h.b.workerDomains.map((d) => d.hostname)).toEqual([`docs.${ZONE}`]);
    expect(h.deps.audit.entries.map((e) => e.action)).toContain("custom domain detached (A)");

    // Another repository's run (no switch file here): it finds the marks and the domains, and
    // gives the finishes without measuring.
    const before = h.writes("New").length;
    const measured = () => h.deps.audit.entries.filter((e) => e.action === "switch measured");
    expect(measured()).toHaveLength(1);
    const reports = h.deps.reporter.lines.filter((l) => l.message.includes(" switched: ")).length;
    const again = await h.run();
    expect(again).toEqual(expect.objectContaining({ step: "switched", done: true }));
    expect(again.next[0]).toContain("--finish");
    expect(h.writes("New")).toHaveLength(before);
    expect(measured()).toHaveLength(1);
    expect(h.deps.reporter.lines.filter((l) => l.message.includes(" switched: "))).toHaveLength(
      reports,
    );
    expect(await h.progress()).toBeUndefined();
  });
});

describe("switchMove: the gap", () => {
  it("stops at two hours while the certificate is slow and a hostname answers 526, listing the origin-protected app's finish first; the next run keeps the times", async () => {
    const h = await switchHarness();
    h.deps.interactive = true;
    h.bZone.data.hostnameAop.set(`blog.${ZONE}`, {
      hostname: `blog.${ZONE}`,
      cert_id: "client-1",
      enabled: true,
    });
    h.web.status.set(`blog.${ZONE}`, 526);
    let slow = true;
    h.sleeps.onSleep = () => {
      for (const pack of h.bZone.certificatePacks) pack.status = slow ? "initializing" : "active";
    };
    const stopped: MoveResult = await h.run();
    expect(stopped.done).toBe(false);
    expect(h.time.ms).toBeGreaterThanOrEqual(2 * 3600_000);
    expect(stopped.next[0]).toContain("for blog");
    expect(stopped.next[0]).toContain("526");
    const kept = await h.progress();
    expect(kept?.activeAt).toBeDefined();
    expect(kept?.certificateAt).toBeUndefined();
    expect(kept?.okAt?.[`shop.${ZONE}`]).toBeDefined();
    expect(kept?.okAt?.[`blog.${ZONE}`]).toBeUndefined();

    slow = false;
    h.web.status.delete(`blog.${ZONE}`);
    const result = await h.run();
    expect(result.done).toBe(true);
    const audit = h.deps.audit.entries.find((e) => e.action === "switch measured");
    expect(audit?.detail).toContain(`blog.${ZONE} answered over HTTPS`);
    expect(errorText(audit?.detail)).not.toContain("NaN");
    expect(kept?.nameserversSetAt).toBeDefined();
  });
});
