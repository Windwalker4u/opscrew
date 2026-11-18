/**
 * The IPv6 web filter under a real systemd: in a privileged `ubuntu:24.04` container whose init is
 * systemd (no nft at first), the step installs nftables, loads the filter and the unit's nftables
 * drop-in, and the inspection reads the table's hash as the plan expects it. A flushed table is
 * seen by the inspection; `systemctl restart nftables` (which flushes every table) and `systemctl
 * reload nftables` bring it back through the drop-in, and the step's verify holds again; stopping
 * nftables stops the filter. It pulls the image and installs packages, so it runs only with
 * OPSCREW_DOCKER_TESTS=1.
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
if (reason)
  console.warn(`[connector-ssh-host] skipping the IPv6 web filter under systemd: ${reason}`);

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
# The table holds three rules for each of the two ranges once it is loaded.
table_back() {
  for i in $(seq 1 30); do
    [ "$(nft list table inet opscrew-web 2>/dev/null | grep -c 'ip6 saddr')" -eq 6 ] && return 0
    sleep 1
  done
  return 1
}
if command -v nft >/dev/null 2>&1; then echo "nft before: yes"; else echo "nft before: no"; fi
sh /t/install.sh && echo "install: ok"
sh /t/apply.sh && echo "apply: ok"
sh /t/verify.sh && echo "verify: ok"
systemd-analyze verify /etc/systemd/system/opscrew-web-filter.service && echo "unit: ok"
echo "@@inspect1"; sh /t/inspect.sh; echo "@@end1"
nft flush table inet opscrew-web
echo "@@inspect2"; sh /t/inspect.sh; echo "@@end2"
sh /t/verify.sh 2>/dev/null || echo "verify flushed: failed"
systemctl restart nftables
table_back && echo "restart: table back"
sh /t/verify.sh && echo "verify after restart: ok"
echo "@@inspect3"; sh /t/inspect.sh; echo "@@end3"
systemctl reload nftables
sleep 1
table_back && echo "reload: table back"
systemctl stop nftables
sleep 2
echo "after stop: $(systemctl is-active opscrew-web-filter.service)"
`;

/** The inspection between `@@inspect<n>` and `@@end<n>`. */
function inspection(out: string, n: number): string {
  const start = out.indexOf(`@@inspect${n}\n`);
  return out.slice(start + `@@inspect${n}\n`.length, out.indexOf(`@@end${n}`));
}

describe.skipIf(reason !== undefined)("the IPv6 web filter under systemd on ubuntu:24.04", () => {
  it("installs nftables, and the table comes back after nftables restarts or reloads", {
    timeout: 600_000,
  }, () => {
    const setup = scriptsFor({ id: "web-filter", params: PARAMS });
    if (setup.preApply === undefined) throw new Error("no nftables install");
    const dir = mkdtempSync(join(tmpdir(), "opscrew-web6-nft-"));
    const name = `opscrew-test-web6-nft-${process.pid}`;
    const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
    try {
      writeFileSync(join(dir, "install.sh"), setup.preApply);
      writeFileSync(join(dir, "apply.sh"), setup.apply);
      writeFileSync(join(dir, "verify.sh"), setup.verify);
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
          "ubuntu:24.04",
          "sh",
          "-c",
          BOOT,
        ],
        { encoding: "utf8", env },
      );
      expect(started.status, started.stderr).toBe(0);
      const up = spawnSync("docker", ["exec", name, "sh", "-c", WAIT], { encoding: "utf8", env });
      expect(up.status, `systemd did not come up: ${up.stdout}${up.stderr}`).toBe(0);
      const run = spawnSync("docker", ["exec", name, "sh", "/t/run.sh"], {
        encoding: "utf8",
        env,
      });
      const out = run.stdout;
      const all = `${out}\n${run.stderr}`;
      expect(run.status, all).toBe(0);
      expect(out, all).toContain("nft before: no");
      expect(out, all).toContain("install: ok");
      expect(out, all).toContain("apply: ok");
      expect(out, all).toContain("verify: ok");
      expect(out, all).toContain("unit: ok");
      expect(out, all).toContain("verify flushed: failed");
      expect(out, all).toContain("restart: table back");
      expect(out, all).toContain("verify after restart: ok");
      expect(out, all).toContain("reload: table back");
      expect(out, all).toContain("after stop: inactive");

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
    } finally {
      spawnSync("docker", ["rm", "-f", name], { encoding: "utf8", env });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
