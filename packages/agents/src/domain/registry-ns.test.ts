import { describe, expect, it } from "vitest";
import { rdapNameservers, registryNsLookup } from "./registry-ns";

/** An RDAP domain record (RFC 9083) naming these nameservers, as a registry answers it. */
const record = (...names: string[]) => ({
  objectClassName: "domain",
  ldhName: "example.dev",
  nameservers: names.map((ldhName) => ({ objectClassName: "nameserver", ldhName })),
});

describe("rdapNameservers", () => {
  it("reads the nameservers' names lower case, without a trailing dot, sorted and once each", () => {
    expect(
      rdapNameservers(
        record("RANDY.NS.CLOUDFLARE.COM.", "grannbo.ns.cloudflare.com", "randy.ns.cloudflare.com"),
      ),
    ).toEqual(["grannbo.ns.cloudflare.com", "randy.ns.cloudflare.com"]);
  });

  it("can't tell from a record without nameservers, with none, with a nameless one, or not a record", () => {
    expect(rdapNameservers({ objectClassName: "domain" })).toBeUndefined();
    expect(rdapNameservers(record())).toBeUndefined();
    expect(rdapNameservers({ nameservers: [{ objectClassName: "nameserver" }] })).toBeUndefined();
    expect(rdapNameservers({ nameservers: [{ ldhName: " " }] })).toBeUndefined();
    expect(rdapNameservers("not found")).toBeUndefined();
    expect(rdapNameservers(undefined)).toBeUndefined();
  });
});

describe("registryNsLookup", () => {
  it("asks the registry's RDAP record of the domain, its name normalised", async () => {
    const asked: string[] = [];
    const lookup = registryNsLookup({
      rdapRecord: async (domain) => {
        asked.push(domain);
        return record("kira.ns.cloudflare.com", "leland.ns.cloudflare.com");
      },
    });
    expect(await lookup("Example.DEV.")).toEqual([
      "kira.ns.cloudflare.com",
      "leland.ns.cloudflare.com",
    ]);
    expect(asked).toEqual(["example.dev"]);
  });

  it("answers undefined, never throwing, when the record can't be read or there is no way to ask", async () => {
    const rejecting = registryNsLookup({
      rdapRecord: async () => {
        throw new Error("RDAP answered 404");
      },
    });
    expect(await rejecting("example.dev")).toBeUndefined();
    expect(await registryNsLookup({})("example.dev")).toBeUndefined();
    expect(await registryNsLookup({ rdapRecord: async () => ({}) })("example.dev")).toBeUndefined();
  });
});
