/**
 * The web filter with IPv6 against a real nft and real packets: in a privileged `ubuntu:24.04`
 * container (network namespaces for a client and an app), the step loads the IPv4 chain and
 * OpsCrew's table `inet opscrew-web`, its check and verify find the table in place, and running
 * the script again (a reboot) adds no second copy. Over IPv6 only Cloudflare's stand-in range
 * reaches ports 80 and 443 on the server (docker-proxy's input path) and a DNAT'd port 443 (the
 * forward path of an edge network with IPv6); IPv4 and `lo` are untouched. Without nft the script
 * fails, so Docker would not start. The removal deletes only OpsCrew's table, and the other
 * address gets through again. systemctl is a stand-in (no init runs in the container). It pulls
 * the image and installs packages, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptsFor } from "./__fixtures__/helpers";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason)
  console.warn(`[connector-ssh-host] skipping the IPv6 web filter on ubuntu:24.04: ${reason}`);

/** Stand-ins for Cloudflare's ranges: the client's first address is in the IPv6 one. */
const PARAMS = { ipv4: "203.0.113.0/24", ipv6: "2001:db8:1:0:cf::/80 2001:db8:ff::/48" };
const ALLOWED = "2001:db8:1:0:cf::2";
const OTHER = "2001:db8:1::99";
const SERVER = "2001:db8:1::1";

const SCRIPT = `set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends nftables iptables iproute2 netcat-openbsd >/dev/null 2>&1 || { echo "apt failed"; exit 1; }
cat > /usr/local/sbin/systemctl <<'STUB'
#!/bin/sh
[ "$1" = --quiet ] && shift
case "$1" in
  enable) touch "/run/enabled.$2" ;;
  disable) rm -f "/run/enabled.$2" ;;
  is-enabled) if [ -e "/run/enabled.$2" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) case "$2" in --quiet) unit=$3 ;; *) unit=$2 ;; esac; [ -e "/run/active.$unit" ] || exit 3 ;;
  start) /usr/local/sbin/opscrew-web-filter || exit 1; touch "/run/active.$2" ;;
  stop) rm -f "/run/active.$2" ;;
  show) exit 1 ;;
esac
exit 0
STUB
chmod 0755 /usr/local/sbin/systemctl
sysctl -qw net.ipv6.conf.all.disable_ipv6=0 net.ipv6.conf.default.disable_ipv6=0 net.ipv6.conf.lo.disable_ipv6=0
# The server's two links: to a client (IPv6 and IPv4) and to an app it DNATs port 443 to.
ip netns add client
ip netns add app
ip link add c0 type veth peer name c1 netns client
ip link add a0 type veth peer name a1 netns app
ip addr add ${SERVER}/64 dev c0 nodad
ip addr add 10.9.0.1/24 dev c0
ip addr add 2001:db8:2::1/64 dev a0 nodad
ip link set c0 up
ip link set a0 up
ip -n client link set lo up
ip -n client link set c1 up
ip -n client addr add ${ALLOWED}/64 dev c1 nodad
ip -n client addr add ${OTHER}/64 dev c1 nodad
ip -n client addr add 10.9.0.2/24 dev c1
ip -n app link set lo up
ip -n app link set a1 up
ip -n app addr add 2001:db8:2::2/64 dev a1 nodad
ip -n app -6 route add default via 2001:db8:2::1
sysctl -qw net.ipv6.conf.all.forwarding=1
nc -6 -lk 80 >/dev/null 2>&1 &
nc -6 -lk 443 >/dev/null 2>&1 &
nc -4 -lk 80 >/dev/null 2>&1 &
ip netns exec app nc -6 -lk 8443 >/dev/null 2>&1 &
sleep 1
reach() {
  if ip netns exec client nc -z -w 2 -s "$1" "$2" "$3" >/dev/null 2>&1; then echo open; else echo closed; fi
}
# The user's own table, which OpsCrew leaves alone.
nft add table inet filter
echo "before: $(reach ${OTHER} ${SERVER} 80)"
echo "check: $(sh /t/check.sh | grep '^state=')"
sh /t/apply.sh && echo "apply: ok"
sh /t/verify.sh && echo "verify: ok"
echo "check again: $(sh /t/check.sh | grep '^state=')"
echo "@@listing"
nft list table inet opscrew-web
echo "@@end"
echo "cloudflare 80: $(reach ${ALLOWED} ${SERVER} 80)"
echo "cloudflare 443: $(reach ${ALLOWED} ${SERVER} 443)"
echo "other 80: $(reach ${OTHER} ${SERVER} 80)"
echo "other 443: $(reach ${OTHER} ${SERVER} 443)"
echo "ipv4 80: $(reach 10.9.0.2 10.9.0.1 80)"
if nc -z -w 2 ::1 80 >/dev/null 2>&1; then echo "lo 80: open"; else echo "lo 80: closed"; fi
# The forward path: port 443 DNAT'd to the app, as Docker does for an edge network with IPv6.
nft add table ip6 testnat
nft add chain ip6 testnat pre '{ type nat hook prerouting priority -100; }'
nft add rule ip6 testnat pre iifname c0 tcp dport 443 dnat to '[2001:db8:2::2]:8443'
echo "dnat cloudflare: $(reach ${ALLOWED} ${SERVER} 443)"
echo "dnat other: $(reach ${OTHER} ${SERVER} 443)"
# A reboot runs the script again: the same table, no second copy.
/usr/local/sbin/opscrew-web-filter && echo "boot again: $(nft list table inet opscrew-web | grep -c 'ip6 saddr')"
mv /usr/sbin/nft /usr/sbin/nft.off
/usr/local/sbin/opscrew-web-filter 2>/tmp/nonft; echo "no nft: $?"
cat /tmp/nonft
mv /usr/sbin/nft.off /usr/sbin/nft
sh /t/remove-apply.sh && echo "remove: ok"
sh /t/remove-verify.sh && echo "removed: ok"
echo "tables: $(nft list tables | tr '\\n' ' ')"
echo "after removal: $(reach ${OTHER} ${SERVER} 443)"
`;

describe.skipIf(reason !== undefined)("the IPv6 web filter on ubuntu:24.04 with nft", () => {
  it("lets only Cloudflare's IPv6 ranges reach the web ports, on the input and forward paths", {
    timeout: 300_000,
  }, () => {
    const setup = scriptsFor({ id: "web-filter", params: PARAMS });
    const removal = scriptsFor({ id: "web-filter", params: { remove: true } });
    const dir = mkdtempSync(join(tmpdir(), "opscrew-web6-"));
    try {
      writeFileSync(join(dir, "check.sh"), setup.check);
      writeFileSync(join(dir, "apply.sh"), setup.apply);
      writeFileSync(join(dir, "verify.sh"), setup.verify);
      writeFileSync(join(dir, "remove-apply.sh"), removal.apply);
      writeFileSync(join(dir, "remove-verify.sh"), removal.verify);
      writeFileSync(join(dir, "run.sh"), SCRIPT);
      const run = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--label",
          "opscrew-test=web-filter",
          "--privileged",
          "-v",
          `${dir}:/t:ro`,
          "ubuntu:24.04",
          "sh",
          "/t/run.sh",
        ],
        { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
      );
      const out = run.stdout;
      const all = `${out}\n${run.stderr}`;
      expect(run.status, all).toBe(0);
      expect(out, all).toContain("before: open");
      expect(out, all).toContain("check: state=change");
      expect(out, all).toContain("apply: ok");
      expect(out, all).toContain("verify: ok");
      expect(out, all).toContain("check again: state=in-place");
      expect(out, all).toContain("cloudflare 80: open");
      expect(out, all).toContain("cloudflare 443: open");
      expect(out, all).toContain("other 80: closed");
      expect(out, all).toContain("other 443: closed");
      expect(out, all).toContain("ipv4 80: open");
      expect(out, all).toContain("lo 80: open");
      expect(out, all).toContain("dnat cloudflare: open");
      expect(out, all).toContain("dnat other: closed");
      expect(out, all).toContain("boot again: 6");
      expect(out, all).toContain("no nft: 1");
      expect(out, all).toContain("opscrew-web-filter: nft is not installed.");
      expect(out, all).toContain("remove: ok");
      expect(out, all).toContain("removed: ok");
      expect(out, all).toMatch(/tables: .*table inet filter /);
      expect(out, all).not.toMatch(/tables: .*opscrew-web/);
      expect(out, all).toContain("after removal: open");
      // Both base chains, policy accept.
      const listing = out.slice(out.indexOf("@@listing\n"), out.indexOf("@@end"));
      expect(listing).toMatch(/type filter hook input priority (0|filter); policy accept;/);
      expect(listing).toMatch(/type filter hook forward priority (0|filter); policy accept;/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
