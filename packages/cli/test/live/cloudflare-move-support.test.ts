import { join } from "node:path";
import { fakeSecret } from "@opscrew/core/testing";
import type { DeployPlan } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import {
  abortProblem,
  bucketEmptiedFirst,
  configuredRegistrars,
  coverageWait,
  currentNameservers,
  dataRecords,
  edgeAnswer,
  type Inventory,
  inventoryChanges,
  inventoryLines,
  keptVersionLeak,
  LEG_VARIABLES,
  leakSearchValues,
  leftoverMatch,
  legOrderProblem,
  legSkip,
  loadFigures,
  MOVE_GATE,
  madeByOpscrew,
  newPass,
  nextMoveCommand,
  nextSteps,
  oneAccount,
  otherLegProblem,
  otherLegsNamed,
  type PassState,
  parsePass,
  passFolder,
  persistedEntries,
  probeFigures,
  rdapRegistrar,
  rdapServers,
  realAppHosts,
  recordAddresses,
  recordKinds,
  registrarFinding,
  sameNameservers,
  switchLegSkip,
  unexpectedNames,
  waitOf,
  withDowntime,
} from "./cloudflare-move-support";

const HASH = "a".repeat(64);
const ZONE = "example.com";

/** Every variable of `names` set to a stand-in, the gate on. */
function envWith(names: readonly string[]): Record<string, string> {
  return {
    [MOVE_GATE]: "1",
    ...Object.fromEntries(names.map((name) => [name, `${name.toLowerCase()}-value`])),
    OPSCREW_E2E_CLOUDFLARE_TOKEN: fakeSecret("cloudflare-token", "a"),
    OPSCREW_E2E_MOVE_TOKEN_B: fakeSecret("cloudflare-token", "b"),
  };
}

describe("the legs' gates", () => {
  it("skips every leg without the gate, then names each missing variable", () => {
    expect(legSkip({}, "L0")).toBe(`set ${MOVE_GATE}=1`);
    expect(legSkip({ [MOVE_GATE]: "1" }, "L0")).toBe(
      "set OPSCREW_E2E_CLOUDFLARE_TOKEN, OPSCREW_E2E_MOVE_TOKEN_B, OPSCREW_E2E_DOMAIN, OPSCREW_TEST_TMP",
    );
    expect(legSkip(envWith(LEG_VARIABLES.L0), "L0")).toBeUndefined();
    expect(legSkip(envWith(LEG_VARIABLES.L0), "L1")).toContain("OPSCREW_E2E_HCLOUD_TOKEN");
    expect(legSkip(envWith(LEG_VARIABLES.L1), "L5")).toBeUndefined();
  });

  it("L4a also needs one registrar's whole credentials", () => {
    const env = envWith(LEG_VARIABLES.L4a);
    expect(legSkip(env, "L4a")).toContain("PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY, or");
    expect(legSkip({ ...env, PORKBUN_API_KEY: "k" }, "L4a")).toContain("PORKBUN_API_KEY");
    const both = { ...env, PORKBUN_API_KEY: "k", PORKBUN_SECRET_API_KEY: "s" };
    expect(legSkip(both, "L4a")).toBeUndefined();
    expect(configuredRegistrars(both)).toEqual(["porkbun"]);
    expect(configuredRegistrars({ ...env, GODADDY_API_TOKEN: " " })).toEqual([]);
  });

  it("runs only the switch leg L0 found, and says why for the other", () => {
    expect(switchLegSkip("L4b", undefined)).toBe("run L0 first: it finds the registrar");
    const cloudflare = registrarFinding({ cloudflare: "holds", configured: [] });
    expect(switchLegSkip("L4b", cloudflare)).toBeUndefined();
    expect(switchLegSkip("L4a", cloudflare)).toBe("L0 found Cloudflare Registrar: run L4b instead");
    const other = registrarFinding({ cloudflare: "absent", publicName: "Gandi", configured: [] });
    expect(switchLegSkip("L4a", other)).toContain("a registrar the pass doesn't drive");
  });

  it("names the other legs a title holds, so -t selects only its own leg", () => {
    expect(otherLegsNamed("L0", "the registrar, and so the switch's leg (L4a or L4b)")).toEqual([
      "L4a",
      "L4b",
    ]);
    expect(otherLegsNamed("L0", "the registrar, and so which switch leg runs")).toEqual([]);
    expect(otherLegsNamed("L4b", "live Cloudflare move, L4b: the switch")).toEqual([]);
    expect(otherLegsNamed("L6", "run L5 first")).toEqual(["L5"]);
  });

  it("keeps the pass's state under OPSCREW_TEST_TMP, never in vitest's run folder", () => {
    expect(passFolder({ OPSCREW_TEST_TMP: "D:/tmp" })).toBe(
      join("D:/tmp", "opscrew-e2e-cloudflare-move"),
    );
    expect(() => passFolder({})).toThrow("OPSCREW_TEST_TMP");
  });
});

describe("the pass's state", () => {
  const state = (): PassState =>
    newPass("run1", { a: "account-a", b: "account-b" }, new Date("2026-11-15T10:00:00Z"));

  it("reads back what it wrote, and refuses another file", () => {
    const pass = state();
    pass.legs.L0 = { startedAt: pass.startedAt, outcome: "passed" };
    expect(parsePass(JSON.stringify(pass))).toEqual(pass);
    expect(() => parsePass(JSON.stringify({ runId: 1 }))).toThrow("not the pass's state");
  });

  it("starts each leg only after the one before it passed; L4a and L4b count as one", () => {
    expect(legOrderProblem(undefined, "L1")).toBe("run L0 first");
    expect(legOrderProblem(undefined, "L0")).toBeUndefined();
    expect(legOrderProblem(undefined, "L6")).toBeUndefined();
    const pass = state();
    expect(legOrderProblem(pass, "L1")).toBe("run L0 to its end first");
    pass.legs.L0 = { startedAt: pass.startedAt, outcome: "passed" };
    expect(legOrderProblem(pass, "L1")).toBeUndefined();
    pass.legs.L3 = { startedAt: pass.startedAt, outcome: "passed" };
    expect(legOrderProblem(pass, "L4b")).toBeUndefined();
    expect(legOrderProblem(pass, "L5")).toBe("run L4a or L4b to its end first");
    pass.legs.L4b = { startedAt: pass.startedAt, outcome: "waiting", note: "later" };
    expect(legOrderProblem(pass, "L5")).toBe("run L4a or L4b to its end first");
    pass.legs.L4b = { startedAt: pass.startedAt, outcome: "passed" };
    expect(legOrderProblem(pass, "L5")).toBeUndefined();
  });

  it("never runs a leg again once a later one ran, apart from L6", () => {
    const pass = state();
    pass.legs.L0 = { startedAt: pass.startedAt, outcome: "passed" };
    pass.legs.L1 = { startedAt: pass.startedAt, outcome: "passed" };
    pass.legs.L2 = { startedAt: pass.startedAt, outcome: "failed" };
    expect(legOrderProblem(pass, "L0")).toBe(
      "L1 and L2 ran already, so L0 doesn't run again: go on from there, or run L6",
    );
    expect(legOrderProblem(pass, "L1")).toContain("L2 ran already");
    expect(legOrderProblem(pass, "L2")).toBeUndefined();
    pass.legs.L4b = { startedAt: pass.startedAt, outcome: "waiting" };
    expect(legOrderProblem(pass, "L4a")).toBe("run L3 to its end first");
    expect(legOrderProblem(pass, "L3")).toContain("L4b ran already");
    pass.legs.L6 = { startedAt: pass.startedAt, outcome: "failed" };
    expect(legOrderProblem(pass, "L4b")).toBe("run L3 to its end first");
  });

  it("opens one leg in a process", () => {
    expect(otherLegProblem(undefined, "L2")).toBeUndefined();
    expect(otherLegProblem("L2", "L2")).toBeUndefined();
    expect(otherLegProblem("L2", "L3")).toBe(
      'this run has L2 too: run one leg at a time with -t "<leg>" (docs/e2e.md)',
    );
  });

  it("lets L6 abort a move by itself only before any switch leg and while A's nameservers serve", () => {
    const pass = state();
    pass.legs.L3 = { startedAt: pass.startedAt, outcome: "failed" };
    expect(abortProblem(pass, false)).toBeUndefined();
    expect(abortProblem(pass, true)).toContain(
      "the switch may have begun (the delegation names the new account's nameservers)",
    );
    pass.legs.L4b = { startedAt: pass.startedAt, outcome: "waiting" };
    const refused = abortProblem(pass, false);
    expect(refused).toContain("(L4b ran)");
    expect(refused).toContain("run L4 again");
    expect(refused).toContain("abort by hand in a terminal");
  });

  it("keeps the masks and the generated values between legs, never a token or an R2 key", () => {
    const entries = [
      "hetzner-token",
      "github-token",
      "github-basic-auth",
      "cloudflare-token",
      "cloudflare-token-b",
      "r2-key-id-a",
      "r2-secret-b",
      "mask-zone",
      "server-ipv4",
      "deploy-private-key",
      "tunnel-token",
    ].map((label) => ({ label, value: `${label}-value` }));
    expect(persistedEntries(entries).map(({ label }) => label)).toEqual([
      "mask-zone",
      "server-ipv4",
      "deploy-private-key",
      "tunnel-token",
    ]);
  });
});

describe("what the move printed", () => {
  it("reads the next step, alone or in a list", () => {
    expect(nextSteps("done\n\nNext: run `opscrew cloudflare move --switch`\n")).toEqual([
      "run `opscrew cloudflare move --switch`",
    ]);
    expect(nextSteps("x\nNext:\n  - one\n  - two\nafter\n")).toEqual(["one", "two"]);
    expect(nextSteps("no steps")).toEqual([]);
  });

  it("reads the command a stop prints, with its typed names", () => {
    const text = `Plan hash (SHA-256): ${HASH}\n\nNext: Review the plan above, then run \`opscrew cloudflare move --abort --confirm shop --approve ${HASH}\` to apply it and continue.\n`;
    const args = nextMoveCommand(text);
    expect(args).toEqual(["--abort", "--confirm", "shop", "--approve", HASH]);
    expect(unexpectedNames(args ?? [], ["shop"])).toEqual([]);
    expect(unexpectedNames(args ?? [], [ZONE])).toEqual(["shop"]);
    expect(nextMoveCommand("Next: wait")).toBeUndefined();
  });

  it("adds --allow-downtime once", () => {
    expect(withDowntime(["--finish"])).toEqual(["--finish", "--allow-downtime"]);
    expect(withDowntime(["--finish", "--allow-downtime"])).toEqual([
      "--finish",
      "--allow-downtime",
    ]);
  });

  it("tells the switch's waits apart", () => {
    expect(
      waitOf([
        "Run `opscrew cloudflare move --switch` again after 2026-11-17 10:00 UTC; it plans the switch again and asks before changing anything.",
      ]),
    ).toEqual({ kind: "time", after: "2026-11-17 10:00 UTC" });
    expect(
      waitOf([
        "In the account A's dashboard (https://dash.cloudflare.com): Domain Registration, …",
        "Then run `opscrew cloudflare move --switch` again: it finds the new nameservers, waits until the new account's zone is active and its certificate issued, and finishes the switch.",
      ]),
    ).toEqual({ kind: "registrar" });
    expect(
      waitOf([
        "Run `opscrew cloudflare move --switch` again to go on: it keeps the times measured so far.",
      ]),
    ).toEqual({ kind: "measuring" });
    expect(waitOf(["Fix it."])).toEqual({ kind: "other" });
  });

  it("tells L3 a DNSSEC wait from coverage that names hostnames", () => {
    expect(
      coverageWait(
        `Plan hash (SHA-256): ${HASH}\n\nNext: run: opscrew cloudflare move --switch --confirm ${ZONE} --approve ${HASH}\n`,
      ),
    ).toBeUndefined();
    const dnssec = coverageWait(
      "DNSSEC is off.\n\nNext:\n  - Run `opscrew cloudflare move --switch` again after 2026-11-17 10:00 UTC; it plans the switch again and asks before changing anything.\n",
    );
    expect(dnssec).toBe("DNSSEC's wait: after 2026-11-17 10:00 UTC.");
    expect(dnssec).not.toContain("coverage");
    expect(
      coverageWait(
        `Error: shop.${ZONE} in ${ZONE} belongs to OpsCrew apps not prepared in the new Cloudflare account yet, so ${ZONE} can't switch.\nNext: Run \`opscrew cloudflare move --to b1\` in the repository that deploys them.\n`,
      ),
    ).toContain("the switch's coverage names hostnames no prepared app holds");
  });
});

describe("the zone's records", () => {
  const records = [
    { type: "A", name: `e2e-run1.${ZONE}`, content: "192.0.2.1", comment: "Managed by OpsCrew" },
    { type: "A", name: `app.${ZONE}`, content: "192.0.2.2", comment: "Managed by OpsCrew" },
    { type: "TXT", name: `_acme.${ZONE}`, content: "x", comment: "Managed by OpsCrew" },
    { type: "TXT", name: `_opscrew-move.shop.${ZONE}`, content: "v=1" },
    {
      type: "MX",
      name: ZONE,
      content: "route1.mx.cloudflare.net",
      meta: { read_only: true, email_routing: true },
    },
    {
      type: "AAAA",
      name: ZONE,
      content: "100::",
      meta: { read_only: true, origin_worker_id: "w1" },
    },
    { type: "CNAME", name: `other.${ZONE}`, content: "x.example.net", meta: { read_only: true } },
    { type: "AAAA", name: `mine.${ZONE}`, content: "2001:db8::1", meta: {} },
    {
      type: "TLSA",
      name: `_25._tcp.${ZONE}`,
      content: "",
      data: { usage: 3, selector: 1, matching_type: 1, certificate: "ab" },
    },
    { type: "HTTPS", name: ZONE, content: "1 . alpn=h2", data: { priority: 1 } },
  ];

  it("sorts them by whose they are", () => {
    const kinds = recordKinds(records);
    expect(kinds.opscrew.map((r) => r.name)).toEqual([
      `e2e-run1.${ZONE}`,
      `app.${ZONE}`,
      `_acme.${ZONE}`,
    ]);
    expect(kinds.marks).toHaveLength(1);
    expect(kinds.emailRouting.map((r) => r.type)).toEqual(["MX"]);
    expect(kinds.workersDomains.map((r) => r.type)).toEqual(["AAAA"]);
    expect(kinds.otherManaged.map((r) => r.name)).toEqual([`other.${ZONE}`]);
    expect(kinds.user.map((r) => r.type)).toEqual(["AAAA", "TLSA", "HTTPS"]);
  });

  it("finds the real apps' hostnames, never the pass's own or a _-name", () => {
    expect(realAppHosts(records, "e2e-run1")).toEqual([`app.${ZONE}`, ZONE]);
  });

  it("says whether Cloudflare filled the content of a record made from data", () => {
    expect(dataRecords(records)).toEqual([
      { type: "TLSA", name: `_25._tcp.${ZONE}`, contentFilled: false },
      { type: "HTTPS", name: ZONE, contentFilled: true },
    ]);
  });

  it("masks every address the records hold", () => {
    expect(recordAddresses(records).sort()).toEqual([
      "100::",
      "192.0.2.1",
      "192.0.2.2",
      "2001:db8::1",
    ]);
  });
});

describe("the inventories", () => {
  const before: Inventory = {
    zone: { status: "active", plan: "Free Website", nameServers: ["a.ns", "b.ns"] },
    records: ["A app 192.0.2.2 proxied", "TXT x y"],
    settings: { ssl: "strict", dnssec: "active" },
    pieces: {
      tunnels: ["opscrew-shop"],
      workers: ["site", "my-own"],
      members: { unreadable: "HTTP 403" },
    },
  };

  it("says what changed by part and count, never a value", () => {
    expect(inventoryChanges(before, before)).toEqual([]);
    const after: Inventory = {
      ...before,
      records: ["A app 192.0.2.3 proxied", "TXT x y", "TXT z w"],
      settings: { ssl: "full", dnssec: "active" },
      pieces: { ...before.pieces, tunnels: [] },
    };
    const changes = inventoryChanges(before, after);
    expect(changes).toEqual([
      "records: 2 added, 1 removed",
      "settings: ssl changed",
      "pieces tunnels: 0 added, 1 removed",
    ]);
    expect(changes.join(" ")).not.toContain("192.0.2");
  });

  it("lists each part, and the pieces OpsCrew didn't make apart", () => {
    expect(inventoryLines("A", before)).toEqual([
      "A: the zone is active on the Free Website plan, 2 records",
      "A setting ssl: strict",
      "A setting dnssec: active",
      "A tunnels: 1",
      "A workers: 2, not OpsCrew's: site, my-own",
      "A members: not readable (HTTP 403)",
    ]);
    expect(inventoryLines("B", { records: [], settings: {}, pieces: {} })).toEqual([
      "B: no zone of the move's name",
    ]);
    expect(madeByOpscrew("OpsCrew deploy (shop)")).toBe(true);
    expect(madeByOpscrew("opscrew-shop-portainer")).toBe(true);
    expect(madeByOpscrew("shop")).toBe(false);
  });
});

describe("the accounts and the registrar", () => {
  it("takes the one account a token sees, or the one named", () => {
    expect(oneAccount([{ id: "b1" }], undefined, "V")).toBe("b1");
    expect(oneAccount([{ id: "b1" }, { id: "b2" }], "b2", "V")).toBe("b2");
    expect(() => oneAccount([{ id: "b1" }, { id: "b2" }], undefined, "V")).toThrow(
      "The token sees 2 accounts: set V",
    );
    expect(() => oneAccount([{ id: "b1" }], "b9", "V")).toThrow("V names an account");
  });

  it("finds the RDAP server of the zone's TLD and the registrar it names", () => {
    const bootstrap = {
      services: [
        [["com", "net"], ["https://rdap.example/com/"]],
        [["dev", "app"], ["https://rdap.example/google/"]],
      ],
    };
    expect(rdapServers(bootstrap, "opscrew-e2e.dev")).toEqual(["https://rdap.example/google/"]);
    expect(rdapServers(bootstrap, "x.org")).toEqual([]);
    expect(rdapServers(undefined, "x.dev")).toEqual([]);
    const answer = {
      entities: [
        { roles: ["abuse"], vcardArray: ["vcard", [["fn", {}, "text", "Nobody"]]] },
        {
          roles: ["registrar"],
          vcardArray: [
            "vcard",
            [
              ["version", {}, "text", "4.0"],
              ["fn", {}, "text", "CloudFlare, Inc."],
            ],
          ],
        },
      ],
    };
    expect(rdapRegistrar(answer)).toBe("CloudFlare, Inc.");
    expect(rdapRegistrar({})).toBeUndefined();
  });

  it("chooses L4b at Cloudflare Registrar, L4a at a registrar OpsCrew drives with its keys", () => {
    expect(
      registrarFinding({ cloudflare: "refused", publicName: "CloudFlare, Inc.", configured: [] }),
    ).toEqual({ registrar: "Cloudflare Registrar", leg: "L4b" });
    expect(
      registrarFinding({
        cloudflare: "absent",
        publicName: "Porkbun LLC",
        configured: ["porkbun"],
      }),
    ).toEqual({ registrar: "porkbun", leg: "L4a" });
    const keyless = registrarFinding({
      cloudflare: "absent",
      publicName: "GoDaddy.com, LLC",
      configured: [],
    });
    expect(keyless.leg).toBeUndefined();
    expect(keyless.why).toContain("set GODADDY_API_TOKEN and run L0 again");
    expect(registrarFinding({ cloudflare: "absent", configured: [] }).registrar).toBe(
      "an unknown registrar",
    );
  });

  it("reads the zone's nameservers at the registry first, the public DNS only without them", async () => {
    const b = ["b1.ns.cloudflare.com", "b2.ns.cloudflare.com"];
    const a = ["a1.ns.cloudflare.com", "a2.ns.cloudflare.com"];
    const asked: string[] = [];
    const publicDns = async (zone: string) => {
      asked.push(zone);
      return a;
    };
    expect(await currentNameservers(ZONE, { registry: async () => b, publicDns })).toEqual(b);
    expect(asked).toEqual([]);
    expect(await currentNameservers(ZONE, { registry: async () => undefined, publicDns })).toEqual(
      a,
    );
    expect(asked).toEqual([ZONE]);
    const failing = async () => {
      throw new Error("no answer");
    };
    expect(
      await currentNameservers(ZONE, { registry: async () => undefined, publicDns: failing }),
    ).toEqual([]);
  });
});

describe("the cleanup's matching", () => {
  const p = "e2e-move-run1-p";
  const q = "e2e-move-run1-q";
  const match = leftoverMatch([p, q], "e2e-run1");

  it("takes P's and Q's tunnels, Access pieces, buckets, records and marks", () => {
    for (const name of [
      `opscrew-${q}`,
      `opscrew-${q}-portainer`,
      `OpsCrew SSH (${q})`,
      `OpsCrew deploy (${q})`,
      p,
      `${q}-prod-backups`,
    ]) {
      expect(match.piece(name), name).toBe(true);
    }
    for (const name of [
      `e2e-run1.${ZONE}`,
      `www.e2e-run1.${ZONE}`,
      `e2e-run1-b.${ZONE}`,
      `ssh-${q}.${ZONE}`,
      `_opscrew-move.${p}-0a1b2c3d.${ZONE}`,
    ]) {
      expect(match.record(name), name).toBe(true);
    }
  });

  it("never takes a real app's pieces, records or mark", () => {
    for (const name of [
      "shop",
      "opscrew-shop",
      "OpsCrew SSH (shop)",
      "shop-prod-backups",
      `${p}2`,
    ]) {
      expect(match.piece(name), name).toBe(false);
    }
    for (const name of [
      ZONE,
      `shop.${ZONE}`,
      `ssh-shop.${ZONE}`,
      `e2e-run12.${ZONE}`,
      `_opscrew-move.shop-1234abcd.${ZONE}`,
      `_opscrew-move.${p}.${ZONE}`,
    ]) {
      expect(match.record(name), name).toBe(false);
    }
  });

  it("empties only the app's own R2 bucket before its destroy, which deletes it only empty", () => {
    const withStorage = (provider: string) =>
      ({
        storage: { objectStorage: { provider, bucket: `${p}-uploads`, region: "auto" } },
      }) as Pick<DeployPlan, "storage">;
    expect(bucketEmptiedFirst(withStorage("r2"))).toBe(`${p}-uploads`);
    expect(bucketEmptiedFirst(withStorage("hetzner"))).toBeUndefined();
    expect(bucketEmptiedFirst(withStorage("garage"))).toBeUndefined();
    expect(bucketEmptiedFirst({})).toBeUndefined();
  });

  it("takes nothing without an app", () => {
    const none = leftoverMatch([], "e2e-run1");
    expect(none.piece("opscrew-shop")).toBe(false);
    expect(none.record(`e2e-run1.${ZONE}`)).toBe(false);
    expect(leftoverMatch([""], "").piece("anything")).toBe(false);
  });
});

describe("the masks, the load and the probes", () => {
  it("compares nameservers whatever their case, order or final dot", () => {
    expect(
      sameNameservers(["B.ns.example.", "a.ns.example"], ["a.ns.example", "b.ns.example"]),
    ).toBe(true);
    expect(sameNameservers(["a.ns.example"], ["a.ns.example", "b.ns.example"])).toBe(false);
    expect(sameNameservers([], [])).toBe(false);
  });

  it("searches for secrets and the servers' addresses, never the masks", () => {
    const token = fakeSecret("cloudflare-token", "a");
    const values = leakSearchValues([
      { label: "cloudflare-token", value: token },
      { label: "server-ipv4", value: "192.0.2.1" },
      { label: "mask-zone", value: ZONE },
      { label: "mask-account-a", value: "account-a" },
      { label: "tester-ipv4", value: "198.51.100.1" },
    ]);
    expect(values.secrets).toEqual([{ label: "cloudflare-token", value: token }]);
    expect(values.addresses).toEqual([{ label: "server-ipv4", value: "192.0.2.1" }]);
  });

  it("names the kept file of a version that leaks, and how to remove one made outside the pass", () => {
    const kept = join("D:/tmp", "opscrew-e2e-cloudflare-move", "kept", "0a1b.txt");
    const line = keptVersionLeak(".opscrew/plans/shop.tfplan.json", kept, [
      "deploy-service-token-client-id",
    ]);
    expect(line).toContain(
      "a kept version of .opscrew/plans/shop.tfplan.json contains: deploy-service-token-client-id",
    );
    expect(line).toContain(`delete ${kept}`);
    expect(line).toContain("a command run by hand outside the pass");
    expect(line).toContain("and run L6 again");
  });

  it("counts a real app's answer as fine unless it is a 5xx", () => {
    expect(edgeAnswer(302)).toBe(200);
    expect(edgeAnswer(404)).toBe(200);
    expect(edgeAnswer(526)).toBe(526);
  });

  it("groups each target's failures by why", () => {
    expect(
      loadFigures([
        {
          label: "P",
          sent: 100,
          failures: [{ what: "HTTP 526" }, { what: "HTTP 526" }, { what: "ECONNRESET" }],
        },
        { label: "real 1", sent: 5, failures: [] },
      ]),
    ).toEqual([
      "P: 100 requests, 3 failed (HTTP 526: 2, ECONNRESET: 1)",
      "real 1: 5 requests, 0 failed",
    ]);
  });

  it("gives each way's first good answer after the change and the nameservers' answers", () => {
    const at = (s: number) => 1_000_000 + s * 1000;
    const figures = probeFigures(
      [
        { at: at(5), host: "P", via: "resolver", ok: false, answer: "HTTP 526" },
        { at: at(10), host: "P", via: "resolver", ok: true, answer: "HTTP 200" },
        { at: at(15), host: "P", via: "resolver", ok: false, answer: "ECONNRESET" },
        { at: at(20), host: "P", via: "resolver", ok: true, answer: "HTTP 200" },
        { at: at(0), host: "P", via: "ns-a", ok: true, answer: "A" },
        { at: at(5), host: "P", via: "ns-a", ok: true, answer: "A" },
        { at: at(30), host: "P", via: "ns-a", ok: false, answer: "SERVFAIL" },
        { at: at(5), host: "Q", via: "doh-edge", ok: false, answer: "ETIMEDOUT" },
      ],
      at(0),
    );
    expect(figures).toEqual([
      "P ns-a: A (0 s) → SERVFAIL (30 s)",
      "P resolver: good from 20 s, 2 of 4 probes failed",
      "Q doh-edge: no good answer yet, 1 of 1 probes failed",
    ]);
  });
});
