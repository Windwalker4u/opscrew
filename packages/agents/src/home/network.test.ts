import type { HomeNetwork } from "@opscrew/connector-ssh-host";
import { Redactor } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { classifyHomeNetwork, HOME_ADDRESS_LABEL, registerHomeAddresses } from "./network";

/** The home's detected addresses, as a proxied app's: never in a line once registered. */
const HOME_IPV4 = "203.0.113.77";
const HOME_IPV6 = "2001:db8:5::77";

function network(over: Partial<HomeNetwork> = {}): HomeNetwork {
  return {
    lan: { address: "192.168.1.30", prefix: 24, interface: "eth0", gateway: "192.168.1.1" },
    ipv4: { route: true, cloudflare: HOME_IPV4, aws: HOME_IPV4 },
    ipv6: { state: "present", stable: HOME_IPV6 },
    hops: ["192.168.1.1", "198.51.100.1", "198.51.100.9"],
    tools: ["curl", "tracepath"],
    ...over,
  };
}

describe("classifyHomeNetwork", () => {
  it("sees the public IPv4 address when both sources agree, or when one answers", () => {
    expect(classifyHomeNetwork(network())).toEqual({ ipv4: "seen", noNat: false, ipv6: "present" });
    expect(classifyHomeNetwork(network({ ipv4: { route: true, aws: HOME_IPV4 } })).ipv4).toBe(
      "seen",
    );
    expect(
      classifyHomeNetwork(network({ ipv4: { route: true, cloudflare: HOME_IPV4 } })).ipv4,
    ).toBe("seen");
  });

  it("knows no public IPv4 address when no source answered or the two disagree", () => {
    expect(classifyHomeNetwork(network({ ipv4: { route: true } }))).toEqual({
      ipv4: "unknown",
      noNat: false,
      ipv6: "present",
    });
    expect(
      classifyHomeNetwork(
        network({ ipv4: { route: true, cloudflare: HOME_IPV4, aws: "203.0.113.78" } }),
      ).ipv4,
    ).toBe("unknown");
  });

  it("has no IPv4 without an IPv4 route, and warns of nothing then", () => {
    expect(
      classifyHomeNetwork(
        network({ lan: undefined, ipv4: { route: false }, hops: ["100.64.0.1"] }),
      ),
    ).toEqual({ ipv4: "none", noNat: false, ipv6: "present" });
  });

  it("needs no NAT when the public IPv4 address is on the server's own interface", () => {
    const found = classifyHomeNetwork(
      network({
        lan: { address: HOME_IPV4, prefix: 24, interface: "eth0", gateway: "203.0.113.1" },
        ipv4: { route: true, cloudflare: HOME_IPV4, aws: HOME_IPV4, interface: HOME_IPV4 },
        hops: ["203.0.113.1", "10.20.0.1"],
      }),
    );
    expect(found).toEqual({ ipv4: "seen", noNat: true, ipv6: "present" });
  });

  it("warns of a carrier-grade NAT address on the server's own interface", () => {
    const found = classifyHomeNetwork(
      network({
        lan: { address: "100.64.3.4", prefix: 10, interface: "eth0", gateway: "100.64.0.1" },
        ipv4: { route: true, cloudflare: HOME_IPV4, interface: "100.64.3.4" },
      }),
    );
    expect(found).toEqual({
      ipv4: "seen",
      noNat: false,
      warning: "cgnat-interface",
      ipv6: "present",
    });
  });

  it("warns of a carrier-grade NAT or private hop after the home router", () => {
    const hops = (...after: string[]) =>
      classifyHomeNetwork(network({ hops: ["192.168.1.1", ...after] })).warning;
    expect(hops("100.64.12.1", "198.51.100.1")).toBe("cgnat-hop");
    expect(hops("10.0.0.1", "198.51.100.1")).toBe("private-hop");
    expect(hops("172.16.5.1")).toBe("private-hop");
    expect(hops("192.168.0.1")).toBe("private-hop");
    expect(hops("10.0.0.1", "100.127.255.1")).toBe("cgnat-hop");
    expect(hops("198.51.100.1", "172.32.0.1")).toBeUndefined();
    expect(hops()).toBeUndefined();
  });

  it("counts every hop on the home network as the home's own, and a missing first hop as none", () => {
    expect(
      classifyHomeNetwork(network({ hops: ["192.168.1.1", "192.168.1.254", "198.51.100.1"] }))
        .warning,
    ).toBeUndefined();
    // The router didn't answer: the first hop seen is already the provider's.
    expect(classifyHomeNetwork(network({ hops: ["100.64.0.1"] })).warning).toBe("cgnat-hop");
  });

  it("takes the first hop as the home router when the home network isn't known", () => {
    const found = (hops: string[]) => classifyHomeNetwork(network({ lan: undefined, hops }));
    expect(found(["192.168.1.1", "198.51.100.1"]).warning).toBeUndefined();
    expect(found(["192.168.1.1", "10.0.0.1"]).warning).toBe("private-hop");
  });

  it("warns of nothing when the public IPv4 address is unknown", () => {
    expect(
      classifyHomeNetwork(network({ ipv4: { route: true }, hops: ["192.168.1.1", "100.64.0.1"] }))
        .warning,
    ).toBeUndefined();
  });

  it("keeps the IPv6 state and never returns an address", () => {
    for (const state of ["present", "absent", "unknown"] as const) {
      const found = classifyHomeNetwork(
        network({ ipv6: state === "present" ? { state, stable: HOME_IPV6 } : { state } }),
      );
      expect(found.ipv6).toBe(state);
    }
    const text = JSON.stringify(
      classifyHomeNetwork(network({ hops: ["192.168.1.1", "100.64.12.1"] })),
    );
    for (const address of [HOME_IPV4, HOME_IPV6, "192.168.1", "100.64.12.1"]) {
      expect(text).not.toContain(address);
    }
  });
});

describe("registerHomeAddresses", () => {
  it("hides a proxied app's detected addresses as the home's address", () => {
    const redactor = new Redactor();
    registerHomeAddresses(redactor, network(), true);
    const shown = redactor.redact(
      `A ${HOME_IPV4} and AAAA ${HOME_IPV6.toUpperCase()} at https://[${HOME_IPV6}]:443/, LAN 192.168.1.30`,
    );
    expect(shown).not.toContain(HOME_IPV4);
    expect(shown.toLowerCase()).not.toContain(HOME_IPV6);
    expect(shown).toContain(`[REDACTED:${HOME_ADDRESS_LABEL}]`);
    expect(shown).toContain("LAN 192.168.1.30");
  });

  it("hides each source's answer, and the address on the server's own interface", () => {
    const redactor = new Redactor();
    registerHomeAddresses(
      redactor,
      network({
        ipv4: {
          route: true,
          cloudflare: HOME_IPV4,
          aws: "203.0.113.78",
          interface: "198.51.100.5",
        },
        ipv6: { state: "absent" },
      }),
      true,
    );
    const shown = redactor.redact(`${HOME_IPV4} 203.0.113.78 198.51.100.5 203.0.113.7`);
    expect(shown).toBe(
      `${Array(3).fill(`[REDACTED:${HOME_ADDRESS_LABEL}]`).join(" ")} 203.0.113.7`,
    );
  });

  it("registers nothing for a DNS-only app, whose address is public in DNS anyway", () => {
    const redactor = new Redactor();
    registerHomeAddresses(redactor, network(), false);
    expect(redactor.redact(`${HOME_IPV4} ${HOME_IPV6}`)).toBe(`${HOME_IPV4} ${HOME_IPV6}`);
  });
});
