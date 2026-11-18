/**
 * The web filter's renders: the script on the server and the `web-filter` step's scripts, pinned
 * by snapshot so a change to them shows in review (servers already set up keep their hashes).
 * With IPv6 ranges the script also loads OpsCrew's nftables table `inet opscrew-web`.
 */
import { describe, expect, it } from "vitest";
import { SH_AVAILABLE, scriptsFor, shSyntax } from "./__fixtures__/helpers";
import { sortedIpv6Networks, webFilterFileHashes, webFilterScript } from "./web-filter";

const IPV4 = ["103.21.244.0/22", "173.245.48.0/20"];
const IPV6 = ["2400:cb00::/32", "2606:4700::/32"];

describe("the web filter's renders", () => {
  it("IPv4 only: the script and its files keep their hashes", () => {
    expect(webFilterFileHashes({ ipv4: IPV4 })).toEqual({
      script: "7041f46b3e89fd34e397c4bfda5053ef8c22c52a80f69a6919c0cc96405a962a",
      unit: "5ba0c4e7fc47da79c43dd085a0191a240f49e8b3499c4ca253bad677b4893782",
      dropIn: "97c2a952b4f120ec2d2868592b8fc4fc5e02ce2bc7109fff45f5ce1d4df9ef0a",
    });
    expect(webFilterScript({ ipv4: IPV4 })).toMatchSnapshot();
  });

  it("IPv4 only: the step's scripts match their snapshot", () => {
    expect(scriptsFor({ id: "web-filter", params: { ipv4: IPV4.join(" ") } })).toMatchSnapshot();
  });

  it("the removal's scripts match their snapshot", () => {
    expect(scriptsFor({ id: "web-filter", params: { remove: true } })).toMatchSnapshot();
  });

  it("with IPv6: the step's scripts match their snapshot, and check the table too", () => {
    const scripts = scriptsFor({
      id: "web-filter",
      params: { ipv4: IPV4.join(" "), ipv6: IPV6.join(" ") },
    });
    expect(scripts.verify).toContain("IPV6='2400:cb00::/32 2606:4700::/32'");
    expect(scripts.verify).toContain('  table6_ok "$IPV6" || return 1\n');
    expect(scripts.check).toContain('  table6_ok "$IPV6" || return 1\n');
    expect(scripts).toMatchSnapshot();
  });
});

describe("the web filter's script with IPv6 ranges", () => {
  const script = webFilterScript({ ipv4: IPV4, ipv6: IPV6 });

  it.skipIf(!SH_AVAILABLE)("passes sh -n", () => {
    expect(shSyntax(script)?.ok).toBe(true);
  });

  it("refuses to start without nft before changing anything, and loads the table last", () => {
    const nft = script.indexOf('command -v nft >/dev/null 2>&1 || fail "nft is not installed."');
    expect(nft).toBeGreaterThan(0);
    expect(nft).toBeLessThan(script.indexOf("iptables-restore -w --noflush"));
    expect(script.indexOf("nft -f - <<'NFT'\n")).toBeGreaterThan(
      script.indexOf("iptables -w -I DOCKER-USER 1"),
    );
    expect(script.endsWith("\nNFT\n")).toBe(true);
    // The IPv4 filter is the same as without IPv6.
    expect(script).toContain("IPV4='103.21.244.0/22 173.245.48.0/20'");
    expect(script).not.toMatch(/ip6tables/);
  });

  it("loads inet opscrew-web: input and forward base chains whose policy is accept", () => {
    expect(script).toContain(`add table inet opscrew-web
delete table inet opscrew-web
table inet opscrew-web {
\tchain input {
\t\ttype filter hook input priority 0; policy accept;
\t\tiifname "lo" accept
\t\tip6 saddr 2400:cb00::/32 tcp dport { 80, 443 } accept
\t\tip6 saddr 2400:cb00::/32 udp dport 443 accept
\t\tip6 saddr 2606:4700::/32 tcp dport { 80, 443 } accept
\t\tip6 saddr 2606:4700::/32 udp dport 443 accept
\t\tmeta nfproto ipv6 tcp dport { 80, 443 } drop
\t\tmeta nfproto ipv6 udp dport 443 drop
\t}
\tchain forward {
\t\ttype filter hook forward priority 0; policy accept;
\t\tct direction original ct status dnat ct original proto-dst { 80, 443 } ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat ct original proto-dst { 80, 443 } ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat ct original proto-dst { 80, 443 } meta nfproto ipv6 drop
\t}
}
NFT`);
  });

  it("changes the script's hash, so a server with the IPv4 filter alone gets it", () => {
    expect(webFilterFileHashes({ ipv4: IPV4, ipv6: IPV6 }).script).not.toBe(
      webFilterFileHashes({ ipv4: IPV4 }).script,
    );
  });

  it("sortedIpv6Networks: as nft prints them, sorted, without duplicates; IPv4 refused", () => {
    expect(sortedIpv6Networks(["2606:4700::/32", "2400:CB00:0::/32", "2400:cb00::/32"])).toEqual(
      IPV6,
    );
    expect(() => sortedIpv6Networks(["173.245.48.0/20"])).toThrow("not an IPv6 network");
    expect(() => sortedIpv6Networks(["2001:db8::/0"])).toThrow("not an IPv6 network");
  });
});
