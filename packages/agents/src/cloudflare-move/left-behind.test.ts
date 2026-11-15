import { findExecutable } from "@opscrew/core";
import { DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leftBehind, leftBehindLines } from "./left-behind";
import { type MoveHarness, moveHarness, serverPlan, ZONE } from "./session.fakes";

/** The app backed up to the R2 bucket shop-backups, which the move copies. */
const backedUp = () =>
  DeployPlanSchema.parse({
    ...serverPlan(),
    snapshots: { offsite: { provider: "r2", bucket: "shop-backups" } },
  });

/** Everything OpsCrew doesn't move, in Old: one of each kind, beside what OpsCrew made. */
function seedEverything(h: MoveHarness) {
  const zone = h.cloudflare.zone(ZONE, "Old").data;
  Object.assign(zone.emailRouting, { enabled: true, rules: ["a", "b", "c"], catchAll: true });
  zone.settings.ssl = "strict";
  zone.minTls.value = "1.2";
  zone.settings.security_level = "under_attack";
  zone.seedRule("http_request_cache_settings", {
    description: "cache the images",
    expression: 'http.request.uri.path contains "/img/"',
    action: "set_cache_settings",
  });
  zone.seedRule("http_config_settings", {
    description: "mine",
    expression: "true",
    action: "set_config",
  });
  // OpsCrew's own rules: never listed.
  for (const [phase, ref] of [
    ["http_config_settings", "opscrew-strict-tls"],
    ["http_request_firewall_custom", "opscrew-block-probes"],
  ] as const) {
    zone.seedRule(phase, { description: "OpsCrew", expression: "true", action: "block" });
    const rules = zone.entrypoints.get(phase)?.rules ?? [];
    (rules.at(-1) as Record<string, unknown>).ref = ref;
  }
  zone.pageRules = 2;
  const old = h.cloudflare.account("Old");
  // docs serves docs.example.com, another OpsCrew app's: its own prepare moves it.
  old.workers.set("docs", {});
  old.workers.set("hello", {});
  old.buckets.push({ name: "shop-backups" }, { name: "photos" });
  old.pagesProjects.push("landing");
  old.turnstileWidgets.push("signup");
  old.webAnalyticsSites.push(ZONE);
}

describe.skipIf(!findExecutable("git"))("leftBehind", () => {
  it("lists each kind OpsCrew doesn't move, by names and counts, with where to redo it; read only", async () => {
    const h = await moveHarness({ plans: () => ({ prod: backedUp() }) });
    seedEverything(h);
    const session = await h.open({ to: "New" });
    const items = await leftBehind(session);
    expect(items).toEqual([
      {
        kind: "Email Routing",
        found: "on, 3 rules and a catch-all",
        where: "Email > Email Routing",
      },
      {
        kind: "Zone settings",
        found:
          "SSL/TLS mode Full (strict), minimum TLS 1.2, Always Use HTTPS off, security level under attack, cache level aggressive",
        where: "SSL/TLS, Security > Settings and Caching > Configuration",
      },
      {
        kind: "Configuration Rules",
        found: "1 rule of your own",
        where: "Rules > Configuration Rules",
      },
      { kind: "Cache Rules", found: "1 rule of your own", where: "Caching > Cache Rules" },
      { kind: "Page Rules", found: "2 page rules", where: "Rules > Page Rules" },
      { kind: "Workers", found: "hello", where: "Workers & Pages" },
      { kind: "Pages projects", found: "landing", where: "Workers & Pages" },
      { kind: "R2 buckets", found: "photos", where: "R2 Object Storage" },
      { kind: "Turnstile widgets", found: "signup", where: "Turnstile" },
      { kind: "Web Analytics sites", found: ZONE, where: "Analytics & Logs > Web Analytics" },
    ]);
    const lines = leftBehindLines(session, items);
    expect(lines[0]).toBe(
      `What OpsCrew doesn't move, read in the Cloudflare account Old (none of it is moved or changed): redo in New what should go with ${ZONE}, or leave it:`,
    );
    expect(lines).toContain(
      "  - Email Routing: on, 3 rules and a catch-all. In New: Email > Email Routing.",
    );
    expect(h.readOnly()).toBe(true);
    expect(h.leaks(lines.join("\n"))).toBe(false);
  });

  it("lists only the zone's settings when nothing else is found", async () => {
    const h = await moveHarness();
    const session = await h.open({ to: "New" });
    const items = await leftBehind(session);
    expect(items.map((item) => item.kind)).toEqual(["Zone settings"]);
    expect(leftBehindLines(session, [])).toEqual([
      `What OpsCrew doesn't move: nothing found in the Cloudflare account Old beyond what OpsCrew made.`,
    ]);
    expect(h.readOnly()).toBe(true);
  });

  it("lists each kind A's token can't read (HTTP 403) as not read, and goes on", async () => {
    const h = await moveHarness();
    seedEverything(h);
    h.cloudflare.zone(ZONE, "Old").data.seedRule("http_request_dynamic_redirect", {
      description: "old blog",
      expression: "true",
      action: "redirect",
    });
    const session = await h.open({ to: "New" });
    const denied = h.cloudflare.tokens.get(h.tokens.a)?.denied;
    for (const permission of [
      "email-routing",
      "settings",
      "http_request_dynamic_redirect",
      "page-rules",
      "workers",
      "pages",
      "r2",
      "turnstile",
      "web-analytics",
    ] as const) {
      denied?.add(permission);
    }
    const items = await leftBehind(session);
    const unread = items.filter((item) => item.found === undefined).map((item) => item.kind);
    expect(unread).toEqual([
      "Email Routing",
      "Zone settings",
      "Redirect Rules",
      "Page Rules",
      "Workers",
      "Pages projects",
      "R2 buckets",
      "Turnstile widgets",
      "Web Analytics sites",
    ]);
    // The rules it could read are still listed.
    expect(items.map((item) => item.kind)).toContain("Cache Rules");
    expect(leftBehindLines(session, items)).toContain(
      "  - Pages projects: couldn't read: check in the dashboard. In New: Workers & Pages.",
    );
    expect(h.readOnly()).toBe(true);
  });

  it("lists an answer it can't read, and the rules when their list is refused, as not read", async () => {
    const h = await moveHarness();
    const session = await h.open({ to: "New" });
    const zone = h.cloudflare.zone(ZONE, "Old");
    h.cloudflare.faults.push(
      { match: `GET /zones/${zone.id}/pagerules`, reply: { body: { success: true, result: 3 } } },
      {
        match: `GET /zones/${zone.id}/rulesets`,
        reply: {
          status: 403,
          body: { success: false, errors: [{ code: 10000, message: "Authentication error" }] },
        },
      },
    );
    const items = await leftBehind(session);
    expect(items.filter((item) => item.found === undefined).map((item) => item.kind)).toEqual([
      "Rules",
      "Page Rules",
    ]);
  });
});
