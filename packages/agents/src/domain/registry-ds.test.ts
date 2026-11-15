import { describe, expect, it } from "vitest";
import { dsQuery, type RegistryNetwork, readDsAnswer, registryDsLookup } from "./registry-ds";

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

/** A network whose nameservers answer as `replies` says, logging every call. */
function network(
  replies: Record<string, (query: Uint8Array) => Uint8Array>,
  addresses: string[] | Error = Object.keys(replies),
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
