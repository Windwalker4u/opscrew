import { OPSCREW_MANAGED_COMMENT } from "@opscrew/connector-cloudflare";
import { findExecutable, resolveProjectPaths, sha256Hex } from "@opscrew/core";
import { opscrewRecordNames } from "@opscrew/iac-templates";
import { describe, expect, it } from "vitest";
import { appPlan } from "../apps/__fixtures__/sites";
import { ownPlan, type ScriptedApprovalHandler, SERVER_IPV4 } from "../testing";
import {
  appMark,
  coverage,
  deleteMark,
  type MoveMark,
  markContents,
  markLabel,
  markName,
  parseMarks,
  readMarks,
  writeMark,
} from "./marks";
import { readAppProgress } from "./progress";
import { openMoveSession } from "./session";
import { type MoveHarness, moveHarness, serverPlan, ZONE } from "./session.fakes";
import { MOVE_COMMAND } from "./texts";
import type { MoveSession } from "./types";
import { applyZone, MARK_COMMENT, planZone } from "./zone";

const SHOP: MoveMark = {
  app: "shop",
  envs: ["prod", "staging"],
  hosts: [`shop.${ZONE}`, `www.shop.${ZONE}`, `ssh-shop.${ZONE}`, `staging.shop.${ZONE}`],
  sites: [],
  access: [],
};

/** Records as Cloudflare lists them, for {@link parseMarks}. */
const listed = (name: string, contents: readonly string[]) =>
  contents.map((content, i) => ({ id: `r${i}`, type: "TXT", name, content, ttl: 1 }));

/** Everything said, approved or recorded, for the leak check. */
const seen = (h: MoveHarness, ...texts: string[]) =>
  h.leaks(...texts, JSON.stringify((h.deps.approvalHandler as ScriptedApprovalHandler).requests));

/** The harness with the further app `blog` in the repository, and B's zone made by a zone plan. */
async function prepared(): Promise<{ h: MoveHarness; session: MoveSession }> {
  const h = await moveHarness({
    apps: () => ({ blog: appPlan("blog", undefined, serverPlan(`blog.${ZONE}`)) }),
  });
  h.deps.interactive = true;
  const session = await h.open({ to: "New" });
  await applyZone(session, await planZone(session));
  return { h, session };
}

/** The approvals asked so far. */
const asked = (h: MoveHarness) => (h.deps.approvalHandler as ScriptedApprovalHandler).requests;

function blogSession(h: MoveHarness): Promise<MoveSession> {
  const paths = resolveProjectPaths(h.root, { env: h.deps.env, app: "blog" });
  return openMoveSession(
    { ...h.deps, paths },
    { command: MOVE_COMMAND, services: h.services, to: "New" },
  );
}

describe("markContents and parseMarks", () => {
  it("writes one TXT record as the data model shows it, and reads it back", () => {
    const contents = markContents(SHOP);
    expect(contents).toEqual([
      `"opscrew-move=1; app=shop; envs=prod,staging; hosts=${SHOP.hosts.join(",")}"`,
    ]);
    const site: MoveMark = {
      app: "docs",
      envs: ["prod"],
      hosts: [`docs.${ZONE}`],
      sites: [{ worker: "docs", domains: [`docs.${ZONE}`] }],
      access: [],
    };
    expect(markContents(site)).toEqual([
      `"opscrew-move=1; app=docs; envs=prod; hosts=docs.${ZONE}; worker=docs; domains=docs.${ZONE}"`,
    ]);
    const name = `_opscrew-move.docs-0123abcd.${ZONE}`;
    expect(parseMarks(listed(name, markContents(site)))).toEqual({
      marks: [{ name, ids: ["r0"], mark: site }],
      damaged: [],
    });
  });

  it("splits a long mark in parts of at most 2,048 characters, each in 255-character strings", () => {
    const hosts = Array.from({ length: 120 }, (_, i) => `host-${i}.shop.${ZONE}`);
    const mark: MoveMark = { ...SHOP, hosts, sites: [{ worker: "shop", domains: [] }] };
    const contents = markContents(mark);
    expect(contents.length).toBeGreaterThan(1);
    contents.forEach((content, i) => {
      expect(content.length).toBeLessThanOrEqual(2048);
      expect(content).toContain(`part=${i + 1}/${contents.length}`);
      for (const piece of content.split('" "'))
        expect(piece.replace(/"/g, "").length).toBeLessThanOrEqual(255);
      // Every string but the last is a full 255 characters, quoted as it is (no escape in it).
      const strings = content.slice(1, -1).split('" "');
      expect(strings.slice(0, -1).every((one) => one.length === 255)).toBe(true);
      expect(content).not.toContain("\\");
    });
    const name = `_opscrew-move.shop-0123abcd.${ZONE}`;
    // Read back in any order.
    expect(parseMarks(listed(name, [...contents].reverse())).marks[0]?.mark).toEqual(mark);
    // A part missing, or a damaged one: the mark is named, not read.
    const unreadable = { marks: [], damaged: [name] };
    expect(parseMarks(listed(name, contents.slice(1)))).toEqual(unreadable);
    expect(parseMarks(listed(name, [contents[0] as string, '"opscrew-move=1; part=2/9"']))).toEqual(
      unreadable,
    );
  });

  it("lists the hostnames behind Cloudflare Access, with their kind and environment", async () => {
    const plan = ownPlan({ access: "tunnel", portainer: "subdomain" });
    const session = {
      zone: ZONE,
      environments: [{ environment: "prod", plan }],
    } as unknown as MoveSession;
    const mark = await appMark(session);
    expect(mark.access).toEqual([
      { hostname: `ssh-shop.${ZONE}`, kind: "service", environment: "prod" },
      { hostname: `portainer.${ZONE}`, kind: "portainer", environment: "prod" },
    ]);
    const [content] = markContents(mark);
    expect(content).toContain(
      `; access=service:prod:ssh-shop.${ZONE},portainer:prod:portainer.${ZONE}"`,
    );
    const name = `_opscrew-move.shop-0123abcd.${ZONE}`;
    expect(parseMarks(listed(name, markContents(mark))).marks[0]?.mark).toEqual(mark);
    // No e-mail, no id: hostnames, kinds and environment names only.
    expect(content).not.toMatch(/@|[0-9a-f]{32}/);
    const damaged = (content as string).replace("access=service:prod:", "access=service:");
    expect(parseMarks(listed(name, [damaged])).damaged).toEqual([name]);
  });

  it("stops plainly when the first part can't hold the sites and the hostnames behind Access", () => {
    const access = Array.from({ length: 60 }, (_, i) => ({
      hostname: `access-${i}-with-a-long-name.shop.${ZONE}`,
      kind: "service" as const,
      environment: "prod",
    }));
    expect(() => markContents({ ...SHOP, access })).toThrow(
      expect.objectContaining({ code: "PHASE_PRECONDITION" }),
    );
  });

  it("labels the app by its name and a hash of its repository and key", () => {
    const repository = { owner: "acme", repo: "shop" };
    expect(markLabel("shop", repository)).toBe(`shop-${sha256Hex("acme/shop#").slice(0, 8)}`);
    expect(markLabel("blog", repository, "blog")).toBe(
      `blog-${sha256Hex("acme/shop#blog").slice(0, 8)}`,
    );
  });
});

describe.skipIf(!findExecutable("git"))("the marks in B's zone", () => {
  it("writes the app's mark through a zone plan, reads it, and deletes only its own", async () => {
    const { h, session } = await prepared();
    const name = await markName(session);
    expect(name).toBe(
      `_opscrew-move.${markLabel("shop", { owner: "acme", repo: "shop" })}.${ZONE}`,
    );
    const mark = await appMark(session);
    expect(mark).toEqual({
      app: "shop",
      envs: ["prod"],
      hosts: opscrewRecordNames(session.environments[0]?.plan as never, ZONE),
      sites: [],
      access: [],
    });
    expect(await writeMark(session)).toBeUndefined();
    const fresh = h.cloudflare.zone(ZONE, "New");
    expect(fresh.records.filter((r) => r.name === name)).toMatchObject([
      {
        type: "TXT",
        ttl: 1,
        proxied: false,
        comment: MARK_COMMENT,
        content: markContents(mark)[0],
      },
    ]);
    const requests = asked(h);
    expect(requests.at(-1)).toMatchObject({ kind: "cloudflare-apply" });
    expect(requests.at(-1)?.details).toContain(`Write the app's mark of the move, ${name}`);
    // Written already: nothing to do, nothing asked.
    const count = requests.length;
    expect(await writeMark(session)).toBeUndefined();
    expect(requests).toHaveLength(count);

    const blog = await blogSession(h);
    await writeMark(blog);
    const apps = async () => (await readMarks(session)).marks.map((read) => read.mark.app);
    expect(await apps()).toEqual(["blog", "shop"]);
    // A mark is never copied or listed as B's own record.
    const plan = await planZone(session);
    expect(plan).toMatchObject({ create: [], differ: [], onlyInB: [] });

    expect(await deleteMark(session)).toBeUndefined();
    expect(requests.at(-1)?.details).toContain(`Delete the app's mark of the move, ${name}`);
    expect(await apps()).toEqual(["blog"]);
    const after = requests.length;
    await deleteMark(session);
    expect(requests).toHaveLength(after);
    expect(seen(h)).toBe(false);
  });

  it("rewrites a mark that says something else in one plan", async () => {
    const { h, session } = await prepared();
    const name = await markName(session);
    const earlier = markContents({ ...SHOP, hosts: [`old.shop.${ZONE}`] });
    await applyZone(
      session,
      await planZone(session, { marks: { name, create: earlier, delete: [] } }),
    );
    const count = asked(h).length;
    await writeMark(session);
    expect(asked(h)).toHaveLength(count + 1);
    expect(asked(h).at(-1)?.details).toContain("Delete the mark's earlier records");
    const records = h.cloudflare.zone(ZONE, "New").records.filter((r) => r.name === name);
    expect(records.map((r) => r.content)).toEqual(markContents(await appMark(session)));
  });

  it("stops a run that doesn't apply the mark's plan now, recorded as the mark's", async () => {
    const { h, session } = await prepared();
    h.deps.interactive = false;
    const stop = await writeMark(session);
    expect(stop?.pendingPlanHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readAppProgress(h.deps.paths)).toMatchObject({
      pending: { action: "mark", planHash: stop?.pendingPlanHash },
    });
    expect((await readMarks(session)).marks).toEqual([]);
  });
});

describe.skipIf(!findExecutable("git"))("coverage", () => {
  it("lists A's OpsCrew names no mark holds, until every app in the zone has its mark", async () => {
    const { h, session } = await prepared();
    const old = h.cloudflare.zone(ZONE, "Old");
    // The shop's GitHub Pages verification record counts as the shop's.
    h.cloudflare.addRecord(old, {
      type: "TXT",
      name: `_github-pages-challenge-acme.shop.${ZONE}`,
      content: '"0123456789"',
      comment: OPSCREW_MANAGED_COMMENT,
    });
    // A hostname only OpsCrew's rules name.
    old.data.entrypoints.set("http_request_firewall_custom", {
      id: "waf",
      name: "default",
      kind: "zone",
      phase: "http_request_firewall_custom",
      version: "1",
      rules: [
        {
          id: "r1",
          ref: "opscrew-block-probes",
          expression:
            '(http.host in {"api.example.com"}) and (http.request.uri.path contains "/.env" or starts_with(http.request.uri.path, "/.git") or http.request.uri.path contains "/wp-admin" or http.request.uri.path contains "/wp-login.php" or http.request.uri.path contains "/xmlrpc.php" or http.request.uri.path contains "/phpmyadmin")',
          action: "block",
          enabled: true,
        },
      ],
    });
    const none = await coverage(session);
    expect(none.marks).toEqual([]);
    expect(none.unread).toEqual([]);
    expect(none.uncovered).toEqual([
      `_github-pages-challenge-acme.shop.${ZONE}`,
      `api.${ZONE}`,
      `blog.${ZONE}`,
      `docs.${ZONE}`,
      `shop.${ZONE}`,
    ]);

    await writeMark(session);
    await writeMark(await blogSession(h));
    const two = await coverage(session);
    expect(two.marks.map((read) => read.mark.app)).toEqual(["blog", "shop"]);
    // The docs site and the rule's api hostname have no app's mark yet.
    expect(two.uncovered).toEqual([`api.${ZONE}`, `docs.${ZONE}`]);
    expect(
      h.cloudflare.calls.some((c) => c.method !== "GET" && c.accountId === old.accountId),
    ).toBe(false);
    expect(seen(h)).toBe(false);
  });

  it("says the custom domains were not read when A's token may not read the account's Workers", async () => {
    const { h, session } = await prepared();
    h.cloudflare.tokens.get(h.tokens.a)?.denied.add("workers");
    const result = await coverage(session);
    expect(result.uncovered).not.toContain(`docs.${ZONE}`);
    expect(result.unread).toEqual([
      "the zone's Workers custom domains, since CLOUDFLARE_API_TOKEN may not read the account's Workers",
    ]);
    expect(seen(h, ...result.unread)).toBe(false);
    expect(result.uncovered.join(" ")).not.toContain(SERVER_IPV4);
  });

  it("names a rule phase A's token may not read", async () => {
    const { h, session } = await prepared();
    h.cloudflare.tokens.get(h.tokens.a)?.denied.add("http_request_firewall_custom");
    const result = await coverage(session);
    expect(result.unread).toEqual([
      "the hostnames in OpsCrew's rules of the phases http_request_firewall_custom, which CLOUDFLARE_API_TOKEN may not read",
    ]);
    expect(seen(h, ...result.unread)).toBe(false);
  });

  it("names a mark that can't be read, and counts none of its hostnames", async () => {
    const { h, session } = await prepared();
    const name = `_opscrew-move.blog-0123abcd.${ZONE}`;
    h.cloudflare.addRecord(h.cloudflare.zone(ZONE, "New"), {
      type: "TXT",
      name,
      content: `"opscrew-move=1; part=1/2; app=blog; envs=prod; hosts=blog.${ZONE}"`,
      comment: MARK_COMMENT,
    });
    const result = await coverage(session);
    expect(result.unread).toEqual([`the mark ${name}, which can't be read`]);
    expect(result.uncovered).toContain(`blog.${ZONE}`);
    expect(seen(h, ...result.unread)).toBe(false);
  });
});
