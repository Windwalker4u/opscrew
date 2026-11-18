/**
 * The web filter's renders: the script on the server and the `web-filter` step's scripts, pinned
 * by snapshot so a change to them shows in review (servers already set up keep their hashes).
 * With IPv6 ranges the script also loads OpsCrew's nftables table `inet opscrew-web`.
 */
import { sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { SH_AVAILABLE, scriptsFor, shSyntax } from "./__fixtures__/helpers";
import {
  sortedIpv6Networks,
  WEB_FILTER_NFT_DROP_IN,
  WEB_FILTER_NFT_DROP_IN_TEXT,
  webFilterFileHashes,
  webFilterScript,
  webFilterTable6Hash,
} from "./web-filter";

const IPV4 = ["103.21.244.0/22", "173.245.48.0/20"];
const IPV6 = ["2400:cb00::/32", "2606:4700::/32"];

describe("the web filter's renders", () => {
  it("IPv4 only: the script and its files keep their hashes", () => {
    // The unit's nftables drop-in is new in this mode (the same file as with IPv6).
    expect(webFilterFileHashes({ ipv4: IPV4 })).toEqual({
      script: "7041f46b3e89fd34e397c4bfda5053ef8c22c52a80f69a6919c0cc96405a962a",
      unit: "5ba0c4e7fc47da79c43dd085a0191a240f49e8b3499c4ca253bad677b4893782",
      dropIn: "97c2a952b4f120ec2d2868592b8fc4fc5e02ce2bc7109fff45f5ce1d4df9ef0a",
      nftDropIn: sha256Hex(WEB_FILTER_NFT_DROP_IN_TEXT),
    });
    expect(webFilterScript({ ipv4: IPV4 })).toMatchSnapshot();
  });

  it("IPv4 only: the step's scripts match their snapshot", () => {
    expect(scriptsFor({ id: "web-filter", params: { ipv4: IPV4.join(" ") } })).toMatchSnapshot();
  });

  it("IPv4 only: the step writes and checks the unit's nftables drop-in, and nothing else is new", () => {
    const scripts = scriptsFor({ id: "web-filter", params: { ipv4: IPV4.join(" ") } });
    expect(scripts.apply).toContain(
      `printf '%s' "$DROPIN_B64" | base64 -d | write_file "$DROP_IN" 0644\n# nftables.service flushes every table`,
    );
    expect(scripts.apply).toContain(
      `printf '%s' "$NFTDROPIN_B64" | base64 -d | write_file "$NFT_DROP_IN" 0644\nsystemctl daemon-reload\n`,
    );
    expect(scripts.verify).toContain(
      '  file_is "$DROP_IN" "$DROPIN_SHA256" || return 1\n  file_is "$NFT_DROP_IN" "$NFTDROPIN_SHA256" || return 1\n',
    );
    for (const text of [scripts.check, scripts.apply, scripts.verify]) {
      expect(text).toContain(`NFTDROPIN_SHA256='${sha256Hex(WEB_FILTER_NFT_DROP_IN_TEXT)}'`);
      expect(text).not.toMatch(/nft |table6_ok|IPV6=/);
    }
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
    expect(scripts.verify).toContain('  file_is "$NFT_DROP_IN" "$NFTDROPIN_SHA256" || return 1\n');
    expect(scripts.apply).toContain(
      `printf '%s' "$NFTDROPIN_B64" | base64 -d | write_file "$NFT_DROP_IN" 0644\nsystemctl daemon-reload\n`,
    );
    expect(scripts.preApply).toBeUndefined();
    expect(scripts).toMatchSnapshot();
  });

  it("with IPv6 on a server without nft: nftables is installed before any change", () => {
    const scripts = scriptsFor({
      id: "web-filter",
      params: { ipv4: IPV4.join(" "), ipv6: IPV6.join(" "), install: "nftables" },
    });
    expect(scripts.preApply).toContain("if ! command -v nft >/dev/null 2>&1; then\n");
    expect(scripts.preApply).toContain("apt_get install --no-install-recommends nftables ||");
    const without = scriptsFor({
      id: "web-filter",
      params: { ipv4: IPV4.join(" "), ipv6: IPV6.join(" ") },
    });
    expect(scripts.apply).toBe(without.apply);
  });

  it("back to IPv4 alone with the IPv6 filter left: the table goes, the drop-in stays; the snapshot pins it", () => {
    const scripts = scriptsFor({
      id: "web-filter",
      params: { ipv4: IPV4.join(" "), removeIpv6: true },
    });
    expect(scripts.apply).toContain(
      "nft delete table inet opscrew-web\nfi\nsystemctl daemon-reload\n",
    );
    expect(scripts.apply).not.toContain('rm -f "$NFT_DROP_IN"');
    expect(scripts.apply).toContain(
      `printf '%s' "$NFTDROPIN_B64" | base64 -d | write_file "$NFT_DROP_IN" 0644\n`,
    );
    expect(scripts.verify).toContain('  file_is "$NFT_DROP_IN" "$NFTDROPIN_SHA256" || return 1\n');
    expect(scripts.verify).toContain("nft list table inet opscrew-web >/dev/null 2>&1; then\n");
    expect(scripts.verify).not.toContain("table6_ok");
    // The script on the server is the IPv4 one.
    const ipv4 = scriptsFor({ id: "web-filter", params: { ipv4: IPV4.join(" ") } });
    const b64 = (text: string) => /SCRIPT_B64='([^']*)'/.exec(text)?.[1];
    expect(b64(scripts.apply)).toBe(b64(ipv4.apply));
    expect(scripts).toMatchSnapshot();
  });

  it("refuses removeIpv6 with IPv6 ranges, and an install without them", () => {
    for (const extra of [
      { ipv6: IPV6.join(" "), removeIpv6: true } as Record<string, string | boolean>,
      { install: "nftables" },
      { ipv6: IPV6.join(" "), install: "apt" },
    ]) {
      expect(
        () => scriptsFor({ id: "web-filter", params: { ipv4: IPV4.join(" "), ...extra } }),
        JSON.stringify(extra),
      ).toThrow(/invalid parameters/);
    }
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
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 80 ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 443 ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat meta l4proto udp ct original proto-dst 443 ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 80 ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 443 ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat meta l4proto udp ct original proto-dst 443 ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 80 meta nfproto ipv6 drop
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 443 meta nfproto ipv6 drop
\t\tct direction original ct status dnat meta l4proto udp ct original proto-dst 443 meta nfproto ipv6 drop
\t}
}
NFT`);
  });

  it("the forward chain never puts a set after `ct original proto-dst` (nft 1.0.2 refuses it, 1.0.6 lists it as [invalid type])", () => {
    expect(script).not.toMatch(/proto-dst \{/);
    expect(script).not.toMatch(/l4proto \{/);
  });

  it("changes the script's hash, so a server with the IPv4 filter alone gets it", () => {
    expect(webFilterFileHashes({ ipv4: IPV4, ipv6: IPV6 }).script).not.toBe(
      webFilterFileHashes({ ipv4: IPV4 }).script,
    );
  });

  it("webFilterTable6Hash: the SHA-256 of the table as nft 1.0.2, 1.0.6, 1.0.9 and 1.1.3 list it (indentation gone, |-joined)", () => {
    // What `nft list table inet opscrew-web` printed, the same byte for byte, on ubuntu:22.04,
    // debian:12, ubuntu:24.04 and debian:13 after the script loaded it.
    const listing = `table inet opscrew-web {
\tchain input {
\t\ttype filter hook input priority filter; policy accept;
\t\tiifname "lo" accept
\t\tip6 saddr 2400:cb00::/32 tcp dport { 80, 443 } accept
\t\tip6 saddr 2400:cb00::/32 udp dport 443 accept
\t\tip6 saddr 2606:4700::/32 tcp dport { 80, 443 } accept
\t\tip6 saddr 2606:4700::/32 udp dport 443 accept
\t\tmeta nfproto ipv6 tcp dport { 80, 443 } drop
\t\tmeta nfproto ipv6 udp dport 443 drop
\t}

\tchain forward {
\t\ttype filter hook forward priority filter; policy accept;
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 80 ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 443 ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat meta l4proto udp ct original proto-dst 443 ip6 saddr 2400:cb00::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 80 ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 443 ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat meta l4proto udp ct original proto-dst 443 ip6 saddr 2606:4700::/32 accept
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 80 meta nfproto ipv6 drop
\t\tct direction original ct status dnat meta l4proto tcp ct original proto-dst 443 meta nfproto ipv6 drop
\t\tct direction original ct status dnat meta l4proto udp ct original proto-dst 443 meta nfproto ipv6 drop
\t}
}
`;
    const normalized = listing
      .split("\n")
      .map((line) => line.trimStart())
      .filter((line) => line !== "")
      .map((line) => `${line}|`)
      .join("");
    expect(webFilterTable6Hash(IPV6)).toBe(sha256Hex(normalized));
    expect(webFilterTable6Hash([IPV6[0] as string])).not.toBe(webFilterTable6Hash(IPV6));
  });

  it("the unit's nftables drop-in: the unit follows nftables.service, which flushes every table", () => {
    expect(WEB_FILTER_NFT_DROP_IN).toBe(
      "/etc/systemd/system/opscrew-web-filter.service.d/nftables.conf",
    );
    expect(WEB_FILTER_NFT_DROP_IN_TEXT).toContain(
      "[Unit]\nPartOf=nftables.service\nReloadPropagatedFrom=nftables.service\n\n[Service]\nExecReload=/usr/local/sbin/opscrew-web-filter\n",
    );
    // It names no IPv6 table: the same file in both modes.
    expect(WEB_FILTER_NFT_DROP_IN_TEXT).not.toContain("opscrew-web ");
    expect(WEB_FILTER_NFT_DROP_IN_TEXT).toContain("iptables-nft");
    expect(webFilterFileHashes({ ipv4: IPV4, ipv6: IPV6 }).nftDropIn).toBe(
      sha256Hex(WEB_FILTER_NFT_DROP_IN_TEXT),
    );
    // The unit and the drop-ins are the same in both modes.
    const { script: _v6, ...ipv6Files } = webFilterFileHashes({ ipv4: IPV4, ipv6: IPV6 });
    const { script: _v4, ...ipv4Files } = webFilterFileHashes({ ipv4: IPV4 });
    expect(ipv6Files).toEqual(ipv4Files);
  });

  it("sortedIpv6Networks: as nft prints them, sorted, without duplicates; IPv4 refused", () => {
    expect(sortedIpv6Networks(["2606:4700::/32", "2400:CB00:0::/32", "2400:cb00::/32"])).toEqual(
      IPV6,
    );
    expect(() => sortedIpv6Networks(["173.245.48.0/20"])).toThrow("not an IPv6 network");
    expect(() => sortedIpv6Networks(["2001:db8::/0"])).toThrow("not an IPv6 network");
  });
});
