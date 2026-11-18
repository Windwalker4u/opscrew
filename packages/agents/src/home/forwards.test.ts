import { describe, expect, it } from "vitest";
import { homeForwards } from "./forwards";

const LAN = "192.168.1.30";

describe("homeForwards", () => {
  it("names the two forwards, the DHCP reservation and SSH staying unforwarded", () => {
    expect(
      homeForwards({
        lanAddress: LAN,
        ipv4: true,
        noNat: false,
        aaaa: false,
        sshFrom: ["192.168.1.0/24"],
      }),
    ).toEqual([
      "On your router, forward TCP 80 and TCP 443 to 192.168.1.30.",
      "Reserve 192.168.1.30 for this server in the router's DHCP settings so it stays fixed.",
      "Don't forward SSH: only 192.168.1.0/24 may reach it.",
    ]);
  });

  it("lists every SSH source, and says only not to forward SSH without them", () => {
    const lines = (sshFrom?: string[]) =>
      homeForwards({
        lanAddress: LAN,
        ipv4: true,
        noNat: false,
        aaaa: false,
        ...(sshFrom ? { sshFrom } : {}),
      });
    expect(lines(["192.168.1.0/24", "fe80::/10"]).at(-1)).toBe(
      "Don't forward SSH: only 192.168.1.0/24 and fe80::/10 may reach it.",
    );
    expect(lines().at(-1)).toBe("Don't forward SSH.");
  });

  it("adds the router's IPv6 firewall rule whenever an AAAA record is published", () => {
    const rule = "Allow inbound TCP 80 and 443 to this server in your router's IPv6 firewall.";
    expect(homeForwards({ lanAddress: LAN, ipv4: true, noNat: false, aaaa: true })).toContain(rule);
    expect(homeForwards({ ipv4: false, noNat: false, aaaa: true })).toEqual([rule]);
    expect(homeForwards({ ipv4: true, noNat: true, aaaa: true })).toContain(rule);
    expect(homeForwards({ lanAddress: LAN, ipv4: true, noNat: false, aaaa: false })).not.toContain(
      rule,
    );
  });

  it("needs no forwards when the server has the public IPv4 address itself", () => {
    const lines = homeForwards({
      ipv4: true,
      noNat: true,
      aaaa: false,
      sshFrom: ["203.0.113.0/24"],
    });
    expect(lines).toEqual([
      "Your server has its public IPv4 address itself, so your router needs no forwards.",
    ]);
    expect(lines.join("\n")).not.toMatch(/forward TCP|DHCP/);
  });

  it("forwards nothing when the site isn't served over IPv4", () => {
    expect(homeForwards({ lanAddress: LAN, ipv4: false, noNat: false, aaaa: false })).toEqual([]);
  });

  it("names the server's address on the home network when it isn't known", () => {
    expect(homeForwards({ ipv4: true, noNat: false, aaaa: false }).slice(0, 2)).toEqual([
      "On your router, forward TCP 80 and TCP 443 to this server's address on your network.",
      "Reserve that address for this server in the router's DHCP settings so it stays fixed.",
    ]);
  });
});
