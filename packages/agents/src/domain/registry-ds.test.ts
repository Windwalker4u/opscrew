import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dsQuery,
  nodeRegistryNetwork,
  type RegistryNetwork,
  rdapUnsignedSince,
  readDsAnswer,
  registryDsLookup,
} from "./registry-ds";

const ID = 0x1234;
const AA = 0x0400;
const TC = 0x0200;

/** The name `name` in DNS wire format (no compression). */
function wireName(name: string): number[] {
  const out: number[] = [];
  for (const label of name.split(".")) out.push(label.length, ...Buffer.from(label, "ascii"));
  out.push(0);
  return out;
}

/** A DS record: key tag 4108, algorithm 8, digest type 2, digest ABCD. */
const RDATA = [0x10, 0x0c, 0x08, 0x02, 0xab, 0xcd];
const RECORD = { keyTag: 4108, algorithm: 8, digestType: 2, digest: "ABCD" };
const SECOND = { keyTag: 4108, algorithm: 13, digestType: 2, digest: "01EF" };

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

interface Rr {
  /** Wire bytes of the owner name; default a pointer to the question's name (offset 12). */
  owner?: number[];
  type?: number;
  ttl: number;
  /** The record data; default key tag 4108, algorithm 8, digest type 2, digest ABCD. */
  rdata?: number[];
}

/** An answer to the DS query of `name`, as a registry's nameserver sends it. */
function answer(
  name: string,
  rrs: Rr[],
  options: { id?: number; flags?: number; rcode?: number; question?: string } = {},
): Uint8Array {
  const flags = (options.flags ?? 0x8000 | AA) | (options.rcode ?? 0);
  const bytes = [
    ...u16(options.id ?? ID),
    ...u16(flags),
    ...u16(1),
    ...u16(rrs.length),
    ...u16(0),
    ...u16(0),
    ...wireName(options.question ?? name),
    ...u16(43),
    ...u16(1),
  ];
  for (const rr of rrs) {
    const rdata = rr.rdata ?? RDATA;
    bytes.push(
      ...(rr.owner ?? [0xc0, 12]),
      ...u16(rr.type ?? 43),
      ...u16(1),
      ...u32(rr.ttl),
      ...u16(rdata.length),
      ...rdata,
    );
  }
  return Uint8Array.from(bytes);
}

describe("dsQuery", () => {
  it("asks for the DS record of the name, without recursion", () => {
    expect([...dsQuery("opscrew.dev", ID)]).toEqual([
      ...[0x12, 0x34, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
      ...wireName("opscrew.dev"),
      ...[0, 43, 0, 1],
    ]);
  });
});

describe("readDsAnswer", () => {
  it("reads the DS records and the full TTL of their set from an authoritative answer", () => {
    expect(readDsAnswer(answer("opscrew.dev", [{ ttl: 1800 }]), ID, "opscrew.dev")).toEqual({
      kind: "published",
      ttlSeconds: 1800,
      records: [RECORD],
    });
  });

  it("takes the longest TTL, and counts only DS records of the name", () => {
    const rrs = [
      { ttl: 1800 },
      { ttl: 3600, rdata: [0x10, 0x0c, 0x0d, 0x02, 0x01, 0xef] },
      { ttl: 999_999, type: 46 },
      { ttl: 999_999, owner: wireName("other.dev") },
    ];
    expect(readDsAnswer(answer("opscrew.dev", rrs), ID, "OpsCrew.dev")).toEqual({
      kind: "published",
      ttlSeconds: 3600,
      records: [RECORD, SECOND],
    });
  });

  it("reads an owner name spelled out in full", () => {
    const rrs = [{ ttl: 1800, owner: wireName("OPSCREW.dev") }];
    expect(readDsAnswer(answer("opscrew.dev", rrs), ID, "opscrew.dev")).toEqual({
      kind: "published",
      ttlSeconds: 1800,
      records: [RECORD],
    });
  });

  it.each([
    ["no DS record (NOERROR)", 0],
    ["no such domain (NXDOMAIN)", 3],
  ])("says the registry publishes none on %s", (_case, rcode) => {
    expect(readDsAnswer(answer("opscrew.dev", [], { rcode }), ID, "opscrew.dev")).toEqual({
      kind: "none",
    });
  });

  it.each([
    ["another query's id", answer("opscrew.dev", [{ ttl: 1800 }], { id: 0x4321 })],
    ["a truncated answer", answer("opscrew.dev", [{ ttl: 1800 }], { flags: 0x8000 | AA | TC })],
    ["an answer that is not authoritative", answer("opscrew.dev", [], { flags: 0x8000 })],
    ["a query, not an answer", answer("opscrew.dev", [{ ttl: 1800 }], { flags: AA })],
    ["a server failure", answer("opscrew.dev", [], { rcode: 2 })],
    ["a refusal", answer("opscrew.dev", [], { rcode: 5 })],
    ["the answer to another question", answer("opscrew.dev", [], { question: "other.dev" })],
    [
      "a DS record without a digest",
      answer("opscrew.dev", [{ ttl: 1800, rdata: [0x10, 0x0c, 8, 2] }]),
    ],
    ["a cut-off packet", answer("opscrew.dev", [{ ttl: 1800 }]).slice(0, -3)],
    ["a header only", Uint8Array.from([0x12, 0x34, 0x84, 0])],
    // The answer's owner name (at offset 29, after the question) points at itself.
    ["a compression loop", answer("opscrew.dev", [{ ttl: 1800, owner: [0xc0, 29] }])],
  ])("cannot read %s", (_case, packet) => {
    expect(readDsAnswer(packet, ID, "opscrew.dev")).toEqual({ kind: "unreadable" });
  });
});

/** When the .dev registry last changed the domain, as its RDAP record gives it. */
const CHANGED = "2026-11-17T01:21:37Z";

/** A domain's RDAP record (RFC 9083) as a registry answers it: not signed, last changed `CHANGED`. */
function rdapDomain(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    objectClassName: "domain",
    ldhName: "opscrew.dev",
    status: ["client transfer prohibited"],
    secureDNS: { delegationSigned: false },
    events: [
      { eventAction: "registration", eventDate: "2025-03-01T10:00:00Z" },
      { eventAction: "expiration", eventDate: "2027-03-01T10:00:00Z" },
      { eventAction: "last changed", eventDate: CHANGED },
      { eventAction: "last update of RDAP database", eventDate: "2026-11-17T20:04:11Z" },
    ],
    ...overrides,
  };
}

describe("rdapUnsignedSince", () => {
  it("gives the domain's last change when its RDAP record says it is not signed", () => {
    expect(rdapUnsignedSince(rdapDomain())).toBe(CHANGED);
  });

  it.each([
    ["the domain is signed", rdapDomain({ secureDNS: { delegationSigned: true } })],
    ["the record says nothing about DNSSEC", rdapDomain({ secureDNS: undefined })],
    [
      "the record has no `last changed` event",
      rdapDomain({ events: [{ eventAction: "registration", eventDate: CHANGED }] }),
    ],
    ["the record has no events", rdapDomain({ events: undefined })],
    [
      "the change's date cannot be read",
      rdapDomain({ events: [{ eventAction: "last changed", eventDate: "yesterday-ish" }] }),
    ],
    ["the record is not an object", "<html>Not found</html>"],
    ["there is no record", undefined],
    ["the record is null", null],
  ])("gives nothing when %s", (_case, record) => {
    expect(rdapUnsignedSince(record)).toBeUndefined();
  });
});

/**
 * A network whose nameservers answer as `replies` says, logging every call; `rdap` (when given)
 * answers the registry's RDAP record.
 */
function network(
  replies: Record<string, (query: Uint8Array) => Uint8Array>,
  addresses: string[] | Error = Object.keys(replies),
  rdap?: (domain: string) => Promise<unknown>,
) {
  const calls: string[] = [];
  const net: RegistryNetwork = {
    nameserverAddresses: async (zone) => {
      calls.push(`ns ${zone}`);
      if (addresses instanceof Error) throw addresses;
      return addresses;
    },
    exchange: async (address, query) => {
      calls.push(`ask ${address}`);
      const reply = replies[address];
      if (reply === undefined) throw new Error("timed out");
      return reply(query);
    },
    randomId: () => ID,
    ...(rdap === undefined
      ? {}
      : {
          rdapRecord: (domain: string) => {
            calls.push(`rdap ${domain}`);
            return rdap(domain);
          },
        }),
  };
  return { net, calls };
}

describe("registryDsLookup", () => {
  const ttl1800 = () => answer("opscrew.dev", [{ ttl: 1800 }]);

  it("asks the parent zone's nameservers directly for the DS record", async () => {
    const asked: Uint8Array[] = [];
    const { net, calls } = network({
      "192.0.2.1": (query) => {
        asked.push(query);
        return ttl1800();
      },
    });

    expect(await registryDsLookup(net)("opscrew.dev.")).toEqual({
      kind: "published",
      ttlSeconds: 1800,
      records: [RECORD],
    });
    expect(calls).toEqual(["ns dev", "ask 192.0.2.1"]);
    expect(asked).toEqual([dsQuery("opscrew.dev", ID)]);
  });

  it("asks the next nameserver when one times out or answers what it cannot read", async () => {
    const { net, calls } = network(
      {
        "192.0.2.2": () => answer("opscrew.dev", [], { flags: 0x8000 | AA | TC }),
        "192.0.2.3": ttl1800,
      },
      ["192.0.2.1", "192.0.2.2", "192.0.2.3"],
    );

    expect(await registryDsLookup(net)("opscrew.dev")).toEqual({
      kind: "published",
      ttlSeconds: 1800,
      records: [RECORD],
    });
    expect(calls).toEqual(["ns dev", "ask 192.0.2.1", "ask 192.0.2.2", "ask 192.0.2.3"]);
  });

  it("says the registry publishes none when its nameserver answers so", async () => {
    const { net } = network({ "192.0.2.1": () => answer("example.com", []) });
    expect(await registryDsLookup(net)("example.com")).toEqual({ kind: "none" });
  });

  describe("when the registry publishes none", () => {
    const none = { "192.0.2.1": () => answer("opscrew.dev", []) };

    it("adds the registry's change time from the domain's RDAP record", async () => {
      const { net, calls } = network(none, undefined, async () => rdapDomain());

      expect(await registryDsLookup(net)("OpsCrew.dev.")).toEqual({
        kind: "none",
        changedAt: CHANGED,
      });
      expect(calls).toEqual(["ns dev", "ask 192.0.2.1", "rdap opscrew.dev"]);
    });

    it("says none without a change time when the network cannot read RDAP records", async () => {
      const { net } = network(none);
      expect(net.rdapRecord).toBeUndefined();
      expect(await registryDsLookup(net)("opscrew.dev")).toEqual({ kind: "none" });
    });

    it("says none without a change time when the RDAP lookup fails", async () => {
      const { net, calls } = network(none, undefined, () =>
        Promise.reject(new Error("RDAP answered 503")),
      );

      expect(await registryDsLookup(net)("opscrew.dev")).toEqual({ kind: "none" });
      expect(calls.at(-1)).toBe("rdap opscrew.dev");
    });

    it("says none without a change time when the RDAP record says the domain is signed", async () => {
      const signed = async () => rdapDomain({ secureDNS: { delegationSigned: true } });
      const { net } = network(none, undefined, signed);
      expect(await registryDsLookup(net)("opscrew.dev")).toEqual({ kind: "none" });
    });

    it("reads no RDAP record while the registry publishes the DS record", async () => {
      const { net, calls } = network({ "192.0.2.1": ttl1800 }, undefined, async () => rdapDomain());

      expect(await registryDsLookup(net)("opscrew.dev")).toMatchObject({ kind: "published" });
      expect(calls).toEqual(["ns dev", "ask 192.0.2.1"]);
    });
  });

  it.each([
    ["every nameserver times out (UDP 53 blocked)", network({}, ["192.0.2.1", "192.0.2.2"])],
    ["the parent zone has no nameserver address", network({}, [])],
    ["the parent zone's nameservers cannot be looked up", network({}, new Error("ENOTFOUND"))],
  ])("cannot read the TTL when %s", async (_case, { net }) => {
    expect(await registryDsLookup(net)("opscrew.dev")).toEqual({ kind: "unreadable" });
  });

  it("asks at most three nameservers", async () => {
    const { net, calls } = network({}, ["192.0.2.1", "192.0.2.2", "192.0.2.3", "192.0.2.4"]);
    expect(await registryDsLookup(net)("opscrew.dev")).toEqual({ kind: "unreadable" });
    expect(calls.filter((c) => c.startsWith("ask"))).toHaveLength(3);
  });

  it("cannot read the TTL of a name without a parent zone", async () => {
    const { net, calls } = network({ "192.0.2.1": ttl1800 });
    expect(await registryDsLookup(net)("dev")).toEqual({ kind: "unreadable" });
    expect(calls).toEqual([]);
  });
});

describe("nodeRegistryNetwork's RDAP record", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads IANA's bootstrap file once for the network's lifetime, and again after a failed read", async () => {
    const BOOTSTRAP = "https://data.iana.org/rdap/dns.json";
    const asked: string[] = [];
    let down = true;
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = String(input);
      asked.push(url);
      if (url !== BOOTSTRAP) return Response.json({ ldhName: url });
      if (down) {
        down = false;
        throw new TypeError("fetch failed");
      }
      return Response.json({
        services: [[["dev"], ["http://rdap.example/", "https://rdap.example/"]]],
      });
    });
    const network = nodeRegistryNetwork();
    await expect(network.rdapRecord?.("a.dev")).rejects.toThrow("fetch failed");
    expect(await network.rdapRecord?.("a.dev")).toEqual({
      ldhName: "https://rdap.example/domain/a.dev",
    });
    await network.rdapRecord?.("b.dev");
    expect(asked).toEqual([
      BOOTSTRAP,
      BOOTSTRAP,
      "https://rdap.example/domain/a.dev",
      "https://rdap.example/domain/b.dev",
    ]);
  });
});
