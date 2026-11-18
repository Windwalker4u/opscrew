import { describe, expect, it } from "vitest";
import {
  carrierNatWarning,
  DNS_ELSEWHERE,
  ISP_TERMS,
  LARGE_MEDIA,
  updaterTokenReach,
} from "./texts";

describe("home texts", () => {
  it("says to check the provider's terms, with no claim about any provider", () => {
    expect(ISP_TERMS).toBe(
      "Check your internet provider's terms: many home plans restrict running servers.",
    );
  });

  it("keeps large media off Cloudflare's proxy", () => {
    expect(LARGE_MEDIA).toBe(
      "Don't serve videos or large downloads through Cloudflare's proxy: its terms limit that without paid services.",
    );
  });

  it("says plainly what the updater's token can reach", () => {
    expect(updaterTokenReach("example.com")).toBe(
      "The updater changes only this app's A/AAAA records, but the token can change any record in example.com. Anything with root on your server can use it, the deploy runner included: it runs your repository's code in the docker group, which is as good as root.",
    );
  });

  it("says only a fixed address keeps working with DNS elsewhere", () => {
    expect(DNS_ELSEWHERE).toContain("only a fixed address keeps working");
    expect(DNS_ELSEWHERE).toContain("isn't on Cloudflare");
  });

  it("warns of carrier-grade NAT with the tunnel and, with IPv6, IPv6 behind the proxy", () => {
    expect(carrierNatWarning("cgnat-hop", { ipv6: true, proxied: true })).toEqual([
      "! Your connection looks like it has no public IPv4 address: a router after yours has a carrier-grade NAT address (100.64.0.0/10).",
      "  Forwards on your router may then never answer from outside. `npx opscrew verify` checks that once the app runs.",
      "  Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel), or, since your server has IPv6, serve over IPv6 behind Cloudflare's proxy (set target.home.ipv4: false in opscrew/plan.yaml).",
    ]);
  });

  it("offers the tunnel alone without IPv6, and the proxy's answer for a DNS-only app", () => {
    expect(carrierNatWarning("cgnat-hop", { ipv6: false, proxied: true }).at(-1)).toBe(
      "  Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel).",
    );
    expect(carrierNatWarning("cgnat-hop", { ipv6: true, proxied: false }).at(-1)).toBe(
      "  Instead: a Cloudflare Tunnel works on any connection (answer server.serve tunnel), or, since your server has IPv6, serve over IPv6 behind Cloudflare's proxy (answer server.serve proxy and set target.home.ipv4: false in opscrew/plan.yaml).",
    );
  });

  it("names what it saw for each warning, and never an address of the home", () => {
    expect(carrierNatWarning("private-hop", { ipv6: false, proxied: true })[0]).toBe(
      "! Your connection looks like it has no public IPv4 address: a router after yours has a private address, so another NAT may stand between your router and the internet.",
    );
    expect(carrierNatWarning("cgnat-interface", { ipv6: false, proxied: true })[0]).toBe(
      "! Your connection looks like it has no public IPv4 address: your server's own address is a carrier-grade NAT address (100.64.0.0/10).",
    );
    const all = [
      ...(["cgnat-hop", "private-hop", "cgnat-interface"] as const).flatMap((warning) =>
        carrierNatWarning(warning, { ipv6: true, proxied: false }),
      ),
      ISP_TERMS,
      LARGE_MEDIA,
      DNS_ELSEWHERE,
      updaterTokenReach("example.com"),
    ].join("\n");
    expect(all).not.toMatch(/\d+\.\d+\.\d+\.\d+(?!\/)/);
    expect(all).not.toMatch(/\bT\d{4}|\b0\d\d\b|feature/);
  });
});
