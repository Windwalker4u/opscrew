/**
 * The web filter under a real systemd, in both modes, on every supported Debian and Ubuntu
 * release: in a privileged container whose init is systemd (no nft at first, iptables-nft as on
 * a fresh server, a stand-in for Docker that creates DOCKER-USER as dockerd does), the step
 * installs nftables, loads the IPv6 filter and the unit's nftables drop-in, and the inspection
 * reads the table's hash as the plan expects it. A flushed table is seen by the inspection;
 * `systemctl restart nftables` (which flushes every table) and `systemctl reload nftables` bring
 * it back through the drop-in, a restart restarts Docker with the filter, and stopping nftables
 * stops both. Back to IPv4 alone, the table goes and the drop-in stays: a flush wipes the IPv4
 * filter too (iptables-nft), and `systemctl restart nftables` puts it back and restarts Docker. It
 * pulls the images and installs packages, so it runs only with OPSCREW_DOCKER_TESTS=1.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scriptsFor } from "./__fixtures__/helpers";
import { factsFromOutput, inspectScript } from "./inspect";
import { webFilterFileHashes, webFilterTable6Hash } from "./web-filter";

function skipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const info = spawnSync("docker", ["info", "--format", "{{.OSType}}"], { encoding: "utf8" });
  return info.status === 0 && info.stdout.trim() === "linux"
    ? undefined
    : "no Docker engine for Linux containers is running";
}

const reason = skipReason();
if (reason) console.warn(`[connector-ssh-host] skipping the web filter under systemd: ${reason}`);

/** The supported releases, each with its systemd and nft. */
const IMAGES = ["ubuntu:22.04", "debian:12", "ubuntu:24.04", "debian:13"];

const IPV4 = ["203.0.113.0/24"];
const IPV6 = ["2001:db8:1:0:cf::/80", "2001:db8:ff::/48"];
const PARAMS = { ipv4: IPV4.join(" "), ipv6: IPV6.join(" "), install: "nftables" };

/** Starts systemd once the packages are in (nftables comes from the step). */
const BOOT = `export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends systemd iptables iproute2 >/dev/null 2>&1 || exit 1
exec /lib/systemd/systemd`;

const WAIT = `for i in $(seq 1 150); do
  case "$(systemctl is-system-running 2>/dev/null)" in running | degraded) exit 0 ;; esac
  sleep 2
done
exit 1`;

const SCRIPT = `set -u
# The table holds five rules for each of the two ranges once it is loaded.
table_back() {
  for i in $(seq 1 30); do
    [ "$(nft list table inet opscrew-web 2>/dev/null | grep -c 'ip6 saddr')" -eq 10 ] && return 0
    sleep 1
  done
  return 1
}
# OpsCrew's IPv4 chain, and its jumps first in DOCKER-USER.
chain_back() {
  for i in $(seq 1 30); do
    iptables -w -S OPSCREW-WEB 2>/dev/null | grep -q -- '-A OPSCREW-WEB -j DROP' &&
      iptables -w -S DOCKER-USER 2>/dev/null | grep -q -- '-j OPSCREW-WEB' && return 0
    sleep 1
  done
  return 1
}
docker_run() { systemctl show -p InvocationID --value docker.service; }
echo "iptables: $(iptables -V)"
# A stand-in for Docker: it creates DOCKER-USER when it starts, as dockerd does.
cat > /etc/systemd/system/docker.service <<'UNIT'
[Unit]
Description=A stand-in for Docker
[Service]
ExecStartPre=/bin/sh -c 'iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || iptables -w -N DOCKER-USER'
ExecStart=/bin/sleep infinity
UNIT
systemctl daemon-reload && systemctl start docker && echo "docker: started"
if command -v nft >/dev/null 2>&1; then echo "nft before: yes"; else echo "nft before: no"; fi
sh /t/install.sh && echo "install: ok"
sh /t/apply.sh && echo "apply: ok"
sh /t/verify.sh && echo "verify: ok"
systemd-analyze verify /etc/systemd/system/opscrew-web-filter.service && echo "unit: ok"
echo "@@inspect1"; sh /t/inspect.sh; echo "@@end1"
nft flush table inet opscrew-web
echo "@@inspect2"; sh /t/inspect.sh; echo "@@end2"
sh /t/verify.sh 2>/dev/null || echo "verify flushed: failed"
before=$(docker_run)
systemctl restart nftables
table_back && echo "restart: table back"
sh /t/verify.sh && echo "verify after restart: ok"
[ "$(docker_run)" != "$before" ] && echo "restart: docker restarted"
echo "@@inspect3"; sh /t/inspect.sh; echo "@@end3"
systemctl reload nftables
sleep 1
table_back && echo "reload: table back"
systemctl stop nftables
sleep 2
echo "after stop: $(systemctl is-active opscrew-web-filter.service), docker $(systemctl is-active docker.service)"
systemctl start nftables && systemctl start docker && echo "started again: $(systemctl is-active opscrew-web-filter.service)"
# Back to IPv4 alone: the table goes, the unit's drop-in stays.
sh /t/back-apply.sh && echo "back: ok"
sh /t/back-verify.sh && echo "back verify: ok"
systemd-analyze verify /etc/systemd/system/opscrew-web-filter.service && echo "back unit: ok"
echo "@@inspect4"; sh /t/inspect.sh; echo "@@end4"
# With iptables-nft a flush of the ruleset wipes the IPv4 filter (and Docker's chains) too.
nft flush ruleset
sh /t/back-verify.sh 2>/dev/null || echo "ipv4 flushed: failed"
before=$(docker_run)
systemctl restart nftables
chain_back && echo "ipv4 restart: filter back"
sh /t/back-verify.sh && echo "ipv4 verify after restart: ok"
[ "$(docker_run)" != "$before" ] && echo "ipv4 restart: docker restarted"
echo "ipv4 docker: $(systemctl is-active docker.service)"
`;

/** The inspection between `@@inspect<n>` and `@@end<n>`. */
function inspection(out: string, n: number): string {
  const start = out.indexOf(`@@inspect${n}\n`);
  return out.slice(start + `@@inspect${n}\n`.length, out.indexOf(`@@end${n}`));
}

describe.skipIf(reason !== undefined)(
  "the web filter under systemd, on each supported release",
  () => {
    it.each(IMAGES)(
      "%s: the filter comes back after nftables restarts or reloads, with IPv6 and with IPv4 alone",
      {
        timeout: 600_000,
      },
      (image) => {
        const setup = scriptsFor({ id: "web-filter", params: PARAMS });
        const back = scriptsFor({
          id: "web-filter",
          params: { ipv4: IPV4.join(" "), removeIpv6: true },
        });
        if (setup.preApply === undefined) throw new Error("no nftables install");
        const dir = mkdtempSync(join(tmpdir(), "opscrew-web6-nft-"));
        const name = `opscrew-test-web6-nft-${process.pid}-${image.replace(/[:.]/g, "-")}`;
        const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
        try {
          writeFileSync(join(dir, "install.sh"), setup.preApply);
          writeFileSync(join(dir, "apply.sh"), setup.apply);
          writeFileSync(join(dir, "verify.sh"), setup.verify);
          writeFileSync(join(dir, "back-apply.sh"), back.apply);
          writeFileSync(join(dir, "back-verify.sh"), back.verify);
          writeFileSync(join(dir, "inspect.sh"), inspectScript());
          writeFileSync(join(dir, "run.sh"), SCRIPT);
          const started = spawnSync(
            "docker",
            [
              "run",
              "-d",
              "--rm",
              "--name",
              name,
              "--label",
              "opscrew-test=web-filter-nftables",
              "--privileged",
              "--cgroupns=host",
              "-v",
              "/sys/fs/cgroup:/sys/fs/cgroup:rw",
              "--tmpfs",
              "/run",
              "--tmpfs",
              "/run/lock",
              "-v",
              `${dir}:/t:ro`,
              image,
              "sh",
              "-c",
              BOOT,
            ],
            { encoding: "utf8", env },
          );
          expect(started.status, started.stderr).toBe(0);
          const up = spawnSync("docker", ["exec", name, "sh", "-c", WAIT], {
            encoding: "utf8",
            env,
          });
          expect(up.status, `systemd did not come up: ${up.stdout}${up.stderr}`).toBe(0);
          const run = spawnSync("docker", ["exec", name, "sh", "/t/run.sh"], {
            encoding: "utf8",
            env,
          });
          const out = run.stdout;
          const all = `${out}\n${run.stderr}`;
          expect(run.status, all).toBe(0);
          expect(out, all).toContain("(nf_tables)");
          expect(out, all).toContain("docker: started");
          expect(out, all).toContain("nft before: no");
          expect(out, all).toContain("install: ok");
          expect(out, all).toContain("apply: ok");
          expect(out, all).toContain("verify: ok");
          expect(out, all).toContain("unit: ok");
          expect(out, all).toContain("verify flushed: failed");
          expect(out, all).toContain("restart: table back");
          expect(out, all).toContain("verify after restart: ok");
          expect(out, all).toContain("restart: docker restarted");
          expect(out, all).toContain("reload: table back");
          expect(out, all).toContain("after stop: inactive, docker inactive");
          expect(out, all).toContain("started again: active");
          expect(out, all).toContain("back: ok");
          expect(out, all).toContain("back verify: ok");
          expect(out, all).toContain("back unit: ok");
          expect(out, all).toContain("ipv4 flushed: failed");
          expect(out, all).toContain("ipv4 restart: filter back");
          expect(out, all).toContain("ipv4 verify after restart: ok");
          expect(out, all).toContain("ipv4 restart: docker restarted");
          expect(out, all).toContain("ipv4 docker: active");

          // The inspection reads the table as the plan expects it, a flushed one as another.
          const expected = webFilterTable6Hash(IPV6);
          const loaded = factsFromOutput(inspection(out, 1), "root").webFilter;
          expect(loaded.table6, all).toBe(expected);
          expect(loaded.files.nftDropIn).toBe(
            webFilterFileHashes({ ipv4: IPV4, ipv6: IPV6 }).nftDropIn,
          );
          expect(loaded).toMatchObject({ enabled: true, active: true });
          const flushed = factsFromOutput(inspection(out, 2), "root").webFilter;
          expect(flushed.table6).toMatch(/^[0-9a-f]{64}$/);
          expect(flushed.table6).not.toBe(expected);
          expect(factsFromOutput(inspection(out, 3), "root").webFilter.table6).toBe(expected);
          // Back to IPv4 alone: no table, the IPv4 script, the same drop-in.
          const ipv4 = factsFromOutput(inspection(out, 4), "root").webFilter;
          const hashes = webFilterFileHashes({ ipv4: IPV4 });
          expect(ipv4.table6).toBeUndefined();
          expect(ipv4.files).toEqual({
            script: hashes.script,
            unit: hashes.unit,
            dropIn: hashes.dropIn,
            nftDropIn: hashes.nftDropIn,
          });
          expect(ipv4.rules4.chain).toMatchObject({ sources: IPV4, dropsRest: true, other: 0 });
        } finally {
          spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", env });
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);
