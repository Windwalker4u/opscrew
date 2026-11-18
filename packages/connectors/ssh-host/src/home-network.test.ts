import { readFileSync } from "node:fs";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { describe, expect, it } from "vitest";
import { rejection, SH_AVAILABLE, shSyntax } from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import {
  agreedIpv4,
  detectHomeNetwork,
  homeNetworkScript,
  parseHomeNetwork,
  parsePath,
} from "./home-network";
import { EXIT_MARK, SECTION_MARK } from "./parse";
import { asLogin } from "./shell";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/home/${name}`, import.meta.url), "utf8");

/** Output of the script: each probe's section with its exit code. */
function output(sections: Record<string, readonly [string, number] | string>): string {
  return Object.entries(sections)
    .map(([name, value]) => {
      const [text, exit] = typeof value === "string" ? [value, 0] : value;
      return `\n${SECTION_MARK}${name}\n${text}\n${EXIT_MARK}${exit}`;
    })
    .join("\n");
}

/** A home behind one NAT, both sources agreeing, a carrier-NAT hop on the way out. */
const HOME = {
  tools: "curl\ntracepath",
  route4: fixture("ip-route-get.json"),
  route6: fixture("ip-route6-default.json"),
  addresses: fixture("ip-addr.json"),
  cloudflare: fixture("cloudflare-trace.txt"),
  aws: fixture("checkip.txt"),
  path: `tracepath\n${fixture("tracepath-cgnat.txt")}`,
} as const;

/** `ip -j addr show` with eth0's IPv4 address replaced by `address`. */
const addressesWith = (address: string) =>
  HOME.addresses.replace('"local":"192.168.1.30"', `"local":"${address}"`);

describe("parseHomeNetwork", () => {
  it("reads the LAN, both sources, the stable IPv6 address and the first hops", () => {
    expect(parseHomeNetwork(output(HOME))).toEqual({
      lan: { address: "192.168.1.30", prefix: 24, interface: "eth0", gateway: "192.168.1.1" },
      ipv4: { route: true, cloudflare: "203.0.113.7", aws: "203.0.113.7" },
      ipv6: { state: "present", stable: "2001:db8:1:2::30" },
      hops: ["192.168.1.1", "100.64.12.1", "203.0.113.1"],
      tools: ["curl", "tracepath"],
    });
  });

  it("keeps both answers when the sources disagree, and the agreement rule makes it unknown", () => {
    const network = parseHomeNetwork(output({ ...HOME, aws: fixture("checkip-other.txt") }));
    expect(network.ipv4).toEqual({ route: true, cloudflare: "203.0.113.7", aws: "203.0.113.9" });
    expect(agreedIpv4(network.ipv4)).toBeUndefined();
    expect(agreedIpv4(parseHomeNetwork(output(HOME)).ipv4)).toBe("203.0.113.7");
  });

  it("takes the one source that answered", () => {
    const noAws = parseHomeNetwork(output({ ...HOME, aws: ["", 28] }));
    expect(noAws.ipv4).toEqual({ route: true, cloudflare: "203.0.113.7" });
    expect(agreedIpv4(noAws.ipv4)).toBe("203.0.113.7");
    const noTrace = parseHomeNetwork(output({ ...HOME, cloudflare: ["", 6] }));
    expect(noTrace.ipv4).toEqual({ route: true, aws: "203.0.113.7" });
    expect(agreedIpv4(noTrace.ipv4)).toBe("203.0.113.7");
  });

  it("counts a private, carrier-NAT or garbage answer as no answer", () => {
    for (const [cloudflare = "", aws = ""] of [
      ["ip=10.0.0.5\n", "192.168.1.30\n"],
      ["ip=100.64.1.2\n", "<html>blocked</html>\n"],
      ["h=one.one.one.one\n", "2001:db8::1\n"],
      ["ip=203.0.113.07\n", "203.0.113\n"],
    ]) {
      const network = parseHomeNetwork(output({ ...HOME, cloudflare, aws }));
      expect(network.ipv4).toEqual({ route: true });
      expect(agreedIpv4(network.ipv4)).toBeUndefined();
    }
  });

  it("sees no IPv4 route, and gives no LAN without it", () => {
    const network = parseHomeNetwork(
      output({ ...HOME, route4: ["", 2], cloudflare: ["", 7], aws: ["", 7] }),
    );
    expect(network.lan).toBeUndefined();
    expect(network.ipv4).toEqual({ route: false });
  });

  it("finds the public IPv4 on the server's own interface (no NAT), else a carrier-NAT one", () => {
    const route4 = (address: string) => HOME.route4.replace("192.168.1.30", address);
    const noNat = parseHomeNetwork(
      output({ ...HOME, route4: route4("203.0.113.7"), addresses: addressesWith("203.0.113.7") }),
    );
    expect(noNat.ipv4.interface).toBe("203.0.113.7");
    expect(noNat.lan?.address).toBe("203.0.113.7");
    const cgnat = parseHomeNetwork(
      output({ ...HOME, route4: route4("100.72.0.5"), addresses: addressesWith("100.72.0.5") }),
    );
    expect(cgnat.ipv4.interface).toBe("100.72.0.5");
    // A VPN's carrier-NAT range address (tailscale0) and Docker's bridge never count.
    expect(parseHomeNetwork(output(HOME)).ipv4.interface).toBeUndefined();
  });

  it("leaves out temporary, deprecated, tentative, failed and unique-local IPv6 addresses", () => {
    const only = (addresses: string[]) =>
      JSON.stringify([
        {
          ifname: "eth0",
          addr_info: addresses.map((local, i) => ({
            family: "inet6",
            local,
            prefixlen: 64,
            scope: "global",
            ...[{ temporary: true }, { deprecated: true }, { tentative: true }, {}][i % 4],
            preferred_life_time: 3600,
          })),
        },
      ]);
    const network = parseHomeNetwork(
      output({
        ...HOME,
        addresses: only(["2001:db8::a", "2001:db8::b", "2001:db8::c", "fd12:3456::d"]),
      }),
    );
    expect(network.ipv6).toEqual({ state: "absent" });
    expect(network.lan).toBeUndefined();
  });

  it("picks the longest preferred lifetime, then the lowest address, on the default route's interface", () => {
    const addresses = JSON.stringify([
      {
        ifname: "eth0",
        addr_info: [
          {
            family: "inet6",
            local: "2001:db8::9",
            prefixlen: 64,
            scope: "global",
            preferred_life_time: 100,
          },
          {
            family: "inet6",
            local: "2001:db8::5",
            prefixlen: 64,
            scope: "global",
            preferred_life_time: 900,
          },
          {
            family: "inet6",
            local: "2001:db8::3",
            prefixlen: 64,
            scope: "global",
            preferred_life_time: 900,
          },
        ],
      },
      {
        ifname: "wlan0",
        addr_info: [
          {
            family: "inet6",
            local: "2001:db8::1",
            prefixlen: 64,
            scope: "global",
            preferred_life_time: 4294967295,
          },
        ],
      },
    ]);
    expect(parseHomeNetwork(output({ ...HOME, addresses })).ipv6).toEqual({
      state: "present",
      stable: "2001:db8::3",
    });
    // The route with the lowest metric decides the interface, whatever the order ip prints.
    const route6 = JSON.stringify([
      { dst: "default", dev: "eth0", metric: 600 },
      { dst: "default", dev: "wlan0", metric: 100 },
    ]);
    expect(parseHomeNetwork(output({ ...HOME, addresses, route6 })).ipv6.stable).toBe(
      "2001:db8::1",
    );
  });

  it("says absent without an IPv6 default route, and unknown when ip -6 failed", () => {
    expect(parseHomeNetwork(output({ ...HOME, route6: "[]" })).ipv6).toEqual({ state: "absent" });
    expect(parseHomeNetwork(output({ ...HOME, route6: ["", 1] })).ipv6).toEqual({
      state: "unknown",
    });
    expect(parseHomeNetwork(output({ ...HOME, route6: "not json" })).ipv6).toEqual({
      state: "unknown",
    });
    const noAddresses = parseHomeNetwork(output({ ...HOME, addresses: ["", 127] }));
    expect(noAddresses.ipv6).toEqual({ state: "unknown" });
    expect(noAddresses.lan).toBeUndefined();
  });

  it("skips ip's empty placeholders", () => {
    const addresses = HOME.addresses.replace('"addr_info":[', '"addr_info":[{},');
    expect(parseHomeNetwork(output({ ...HOME, addresses: `[{},${addresses.slice(1)}` }))).toEqual(
      parseHomeNetwork(output(HOME)),
    );
  });

  it("gives every probe's unknown value when nothing answered", () => {
    expect(parseHomeNetwork(output({}))).toEqual({
      ipv4: { route: false },
      ipv6: { state: "unknown" },
      hops: [],
      tools: [],
    });
  });
});

describe("parsePath", () => {
  it("reads tracepath's hops: a carrier-NAT one, a private one, or none", () => {
    expect(parsePath(`tracepath\n${fixture("tracepath-cgnat.txt")}`)).toEqual([
      "192.168.1.1",
      "100.64.12.1",
      "203.0.113.1",
    ]);
    expect(parsePath(`tracepath\n${fixture("tracepath-private.txt")}`)).toEqual([
      "192.168.1.1",
      "10.20.0.1",
    ]);
    expect(parsePath(`tracepath\n${fixture("tracepath-none.txt")}`)).toEqual([]);
  });

  it("reads traceroute's, and nothing without either tool", () => {
    expect(parsePath(`traceroute\n${fixture("traceroute.txt")}`)).toEqual([
      "192.168.1.1",
      "203.0.113.1",
    ]);
    expect(parsePath("")).toEqual([]);
    expect(parsePath(fixture("tracepath-cgnat.txt"))).toEqual([]);
  });

  it("keeps at most three hops", () => {
    expect(
      parsePath("traceroute\n 1  192.168.1.1\n 2  10.0.0.1\n 3  100.64.0.1\n 4  203.0.113.1\n"),
    ).toEqual(["192.168.1.1", "10.0.0.1", "100.64.0.1"]);
  });
});

/** A remote that answers every call with `run`, recording each call. */
function scriptedRemote(run: (command: string) => CommandResult | Promise<CommandResult>) {
  const calls: { command: string; options: RemoteRunOptions | undefined }[] = [];
  const remote: RemoteExec = {
    host: "192.168.1.30",
    async run(command, options) {
      calls.push({ command, options });
      return run(command);
    },
  };
  return { remote, calls };
}

describe("homeNetworkScript", () => {
  it("uses no command that changes the server, and bounds each probe in time", () => {
    const script = homeNetworkScript();
    for (const pattern of [
      /\bapt(-get)?\s/,
      /\b(chown|chmod|mkdir|install\s+-|rm\s|mv\s|cp\s|tee\s|touch\s)/,
      /\bsystemctl\s+(start|stop|restart|reload|enable|disable)/,
      /\bip\s+(-\S+\s+)*(addr|route|link)\s+(add|del|change|replace|flush)/,
      /\bsed\s+-i/,
    ]) {
      expect(script).not.toMatch(pattern);
    }
    expect(script.match(/>\s*(\S+)/g)?.filter((r) => !/\/dev\/null|&2|&1/.test(r)) ?? []).toEqual(
      [],
    );
    for (const line of script
      .split("\n")
      .filter((l) => /\b(curl|ip|tracepath|traceroute) -/.test(l))) {
      expect(line).toMatch(/--max-time \d+|^\s*timeout \d+ /);
    }
    expect(script).toContain("https://one.one.one.one/cdn-cgi/trace");
    expect(script).toContain("https://checkip.amazonaws.com");
  });

  it.skipIf(!SH_AVAILABLE)("passes sh -n, alone and as the login's command", () => {
    for (const script of [homeNetworkScript(), asLogin(homeNetworkScript())]) {
      expect(shSyntax(script)).toEqual({ ok: true, stderr: "" });
    }
  });
});

describe("detectHomeNetwork", () => {
  it.skipIf(!BASH_AVAILABLE)(
    "runs the script as the login and reads every probe, a failing one included",
    async () => {
      const sh = new ShellHarness();
      try {
        for (const name of [
          "ip-addr.json",
          "ip-route-get.json",
          "ip-route6-default.json",
          "cloudflare-trace.txt",
          "tracepath-private.txt",
        ]) {
          sh.write(`/fixtures/${name}`, fixture(name));
        }
        const dir = sh.posix("/fixtures");
        sh.stub("timeout", 'shift\nexec "$@"', { log: false });
        sh.stub(
          "ip",
          `case "$*" in
  "-j -4 route get 1.1.1.1") cat '${dir}/ip-route-get.json' ;;
  "-j -6 route show default") cat '${dir}/ip-route6-default.json' ;;
  "-j addr show") cat '${dir}/ip-addr.json' ;;
  *) exit 1 ;;
esac`,
        );
        // checkip does not answer.
        sh.stub(
          "curl",
          `case "$*" in
  *one.one.one.one*) cat '${dir}/cloudflare-trace.txt' ;;
  *) exit 28 ;;
esac`,
        );
        sh.stub("tracepath", `cat '${dir}/tracepath-private.txt'`);
        const script = homeNetworkScript();
        const { remote, calls } = scriptedRemote((command) => {
          expect(command).toBe(asLogin(script));
          const run = sh.run(script);
          return { exitCode: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
        });
        const network = await detectHomeNetwork(remote);
        expect(network).toEqual({
          lan: { address: "192.168.1.30", prefix: 24, interface: "eth0", gateway: "192.168.1.1" },
          ipv4: { route: true, cloudflare: "203.0.113.7" },
          ipv6: { state: "present", stable: "2001:db8:1:2::30" },
          hops: ["192.168.1.1", "10.20.0.1"],
          tools: ["curl", "tracepath"],
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.options?.timeoutMs).toBeGreaterThan(0);
        // Both sources are asked every time.
        expect(sh.calls().filter((call) => call.startsWith("curl "))).toEqual([
          "curl -4 -fsS --connect-timeout 5 --max-time 10 https://one.one.one.one/cdn-cgi/trace",
          "curl -4 -fsS --connect-timeout 5 --max-time 10 https://checkip.amazonaws.com",
        ]);
      } finally {
        sh.dispose();
      }
    },
  );

  it("never throws when the probes fail: each gives its unknown value", async () => {
    const { remote } = scriptedRemote(() => ({
      exitCode: 0,
      stdout: output({
        tools: ["", 1],
        route4: ["Error: ...", 1],
        route6: ["", 1],
        addresses: ["", 1],
        cloudflare: ["", 6],
        aws: ["", 6],
        path: ["", 1],
      }),
      stderr: "",
    }));
    expect(await detectHomeNetwork(remote)).toEqual({
      ipv4: { route: false },
      ipv6: { state: "unknown" },
      hops: [],
      tools: [],
    });
  });

  it("refuses plainly when the server cannot be reached or has no POSIX shell", async () => {
    const down = scriptedRemote(() => {
      throw new Error("connect ETIMEDOUT");
    });
    const error = await rejection(detectHomeNetwork(down.remote));
    expect(error.code).toBe("COMMAND_FAILED");
    expect(error.message).toBe("OpsCrew could not read the home network's state.");
    const noShell = scriptedRemote(() => ({ exitCode: 127, stdout: "", stderr: "" }));
    expect((await rejection(detectHomeNetwork(noShell.remote))).hint).toMatch(/POSIX shell/);
  });
});
