import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PUBLIC_KEY } from "../__fixtures__/plans";
import { renderCloudInit } from "./cloud-init";
import { FIRST_BOOT_SCRIPT, renderFirstBootScript } from "./first-boot";
import { MODULE_FILES, serverModuleFiles } from "./modules";
import {
  renderServerFirewall,
  SERVER_FIREWALL_FILE,
  SERVER_FIREWALL_MARKER,
  type ServerFirewallRules,
  serverFirewallTable,
} from "./server-firewall";

/** A provider's module, as the contract carries it. */
const module = { name: "example-server", files: { "main.tf": "" } } as const;

/** The rules of an app's server behind Cloudflare, with SSH from two networks and WireGuard. */
const RULES: ServerFirewallRules = {
  sshSources: ["203.0.113.7/32", "2001:db8::/48"],
  webSources: ["173.245.48.0/20", "2400:cb00::/32"],
  wireguardPort: 51820,
};

/** Bash, to run the rendered step's rules with, or undefined when none is here. */
const bash = (() => {
  const candidates = [
    "bash",
    // Git for Windows installs its shell off PATH, where a Windows session usually finds it.
    ...(process.platform === "win32"
      ? [`${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\bash.exe`]
      : []),
  ];
  return candidates.find((candidate) => spawnSync(candidate, ["-c", "true"]).status === 0);
})();
const bashSkip = bash === undefined ? "no bash is here" : undefined;
if (bashSkip !== undefined) console.warn(`[iac-templates] skipping the shell runs: ${bashSkip}`);

/** A POSIX shell (dash on Ubuntu) to check the script's syntax with too, or undefined. */
const sh = [
  "sh",
  ...(process.platform === "win32"
    ? [`${process.env.ProgramFiles ?? "C:\\Program Files"}\\Git\\bin\\sh.exe`]
    : []),
].find((candidate) => spawnSync(candidate, ["-n", "-c", "true"]).status === 0);

/**
 * nft, to check the rules file's syntax with: as root, or without root in a user and network
 * namespace of its own (`unshare -rn`), since `nft -c` needs the rights to change the rules.
 */
const nft = ((): { command: string[] } | { skip: string } => {
  if (spawnSync("nft", ["--version"]).status !== 0) return { skip: "no nft is here" };
  if (process.getuid?.() === 0) return { command: ["nft"] };
  return spawnSync("unshare", ["-rn", "nft", "list", "ruleset"]).status === 0
    ? { command: ["unshare", "-rn", "nft"] }
    : { skip: "nft -c needs root, and `unshare -rn` doesn't work here" };
})();
const nftSkip = "skip" in nft ? nft.skip : undefined;
if (nftSkip !== undefined) {
  console.warn(`[iac-templates] checking the nft rules by their lines only: ${nftSkip}`);
}

/**
 * Runs the rendered step as the first boot does (`set -euo pipefail`, stderr with stdout, as in
 * its log), then `after`, with its files under a folder of its own instead of `/etc`, on an image
 * without nft (so it installs it), and `systemctl`, `apt-get` and `nft` replaced by functions that
 * print their arguments to stderr, `apt-get` or `nft` failing as `fail` says. Returns the run, its
 * lines and the folder.
 */
async function runStep(rules: ServerFirewallRules, fail: "apt-get" | "nft" | "none", after = "") {
  const root = (await mkdtemp(join(tmpdir(), "opscrew-first-boot-"))).replaceAll("\\", "/");
  const stub = (name: string) =>
    `${name}() { echo "${name} $*" >&2; ${fail === name ? "return 100" : "true"}; }`;
  const script = [
    "set -euo pipefail",
    "exec 2>&1",
    'command() { if [ "$*" = "-v nft" ]; then return 1; fi; builtin command "$@"; }',
    'systemctl() { echo "systemctl $*" >&2; }',
    stub("apt-get"),
    stub("nft"),
    renderServerFirewall(rules).replaceAll("/etc/", `${root}/etc/`),
    after,
  ].join("\n");
  const run = spawnSync(bash ?? "bash", [], { input: script, encoding: "utf8" });
  return { ...run, root, lines: run.stdout.split("\n").filter((line) => line !== "") };
}

/** The line the step logs before it powers the server off. */
const POWER_OFF =
  /^opscrew: the server firewall could not be set up, so the server powers off rather than stay reachable without it /;

/**
 * Runs the rendered step with `-eu` (as the first boot does) up to the rules file, which it prints
 * instead of applying it.
 */
function rulesFile(rules: ServerFirewallRules) {
  const step = renderServerFirewall(rules);
  const printing = step.replace(/^opscrew_server_firewall$/m, "opscrew_firewall_rules");
  expect(printing).not.toBe(step);
  return spawnSync(bash ?? "bash", ["-eu"], { input: printing, encoding: "utf8" });
}

/** The table block of a rules file, each line without its indentation, as nft lists it. */
function tableLines(file: string): string[] {
  return file
    .slice(file.indexOf("table inet opscrew-firewall {"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

describe("the server firewall's step, for a provider with no cloud firewall", () => {
  it("ships only to a provider whose first boot is a script and whose firewall is the server's", () => {
    const both = serverModuleFiles({ module, firstBoot: "script" }, "server");
    expect(both[SERVER_FIREWALL_FILE]).toContain(SERVER_FIREWALL_MARKER);
    expect(both[FIRST_BOOT_SCRIPT]).toBeTruthy();
    for (const files of [
      serverModuleFiles({ module, firstBoot: "script" }),
      serverModuleFiles({ module, firstBoot: "script" }, "cloud"),
      // No startup script to carry it.
      serverModuleFiles({ module }, "server"),
      serverModuleFiles({ module, firstBoot: "cloud-init" }, "server"),
    ]) {
      expect(files[SERVER_FIREWALL_FILE]).toBeUndefined();
    }
    // Of the registry's providers, only Kamatera's module gets it: the others are as they were.
    expect(Object.keys(MODULE_FILES).filter((path) => path.endsWith(SERVER_FIREWALL_FILE))).toEqual(
      [`kamatera-instance/${SERVER_FIREWALL_FILE}`],
    );
  });

  it("is the first step of the first boot, before anything else runs", () => {
    const config = renderCloudInit({ sshPublicKey: PUBLIC_KEY, web: true });
    const script = renderFirstBootScript(config, renderServerFirewall(RULES));
    const step = script.indexOf(SERVER_FIREWALL_MARKER);
    expect(step).toBeGreaterThan(script.indexOf("first boot already done"));
    for (const later of ["export DEBIAN_FRONTEND", "cloud-init clean", "base64 -d"]) {
      expect(script.indexOf(later), later).toBeGreaterThan(step);
    }
    // Nothing before it changes the server: the log, the start line and the marker's check.
    const before = script
      .slice(0, step)
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(before).toEqual([
      "set -euo pipefail",
      "exec >>/var/log/opscrew-first-boot.log 2>&1",
      'echo "opscrew: first boot started $(date -Is)"',
      "if [ -e /var/lib/opscrew/first-boot.done ]; then",
      '  echo "opscrew: first boot already done"',
      "  exit 0",
      "fi",
    ]);
    expect(script).not.toContain("${");
  });

  it("turns password logins off first, then sets up the firewall, under a trap that powers the server off", () => {
    const config = renderCloudInit({ sshPublicKey: PUBLIC_KEY, web: true });
    const script = renderFirstBootScript(config, renderServerFirewall(RULES));
    const at = (text: string) => {
      const index = script.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    const order = [
      "\nopscrew_server_firewall() {\n",
      "\n  trap 'echo \"opscrew: the server firewall could not be set up, so the server powers off rather than stay reachable without it $(date -Is)\" >&2; systemctl poweroff' EXIT\n",
      ">/etc/ssh/sshd_config.d/00-opscrew-keys-only.conf\n",
      "\n  systemctl try-reload-or-restart ssh.service\n",
      "install -y nftables\n",
      "\n  nft -f /etc/nftables.conf\n",
      "\n  systemctl enable nftables.service\n",
      "\n  trap - EXIT\n",
      "\nopscrew_server_firewall\n",
      "cloud-init clean",
    ].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // The trap is set once, and cleared once the rules are kept: no later step powers it off.
    expect(script.split("systemctl poweroff")).toHaveLength(2);
  });

  it.skipIf(bashSkip !== undefined)(
    "runs the keys-only step before anything that needs the network, and keeps the rules",
    async () => {
      const run = await runStep(RULES, "none", "false");
      // The first boot's later failure doesn't power the server off: the firewall is on.
      expect(run.status).not.toBe(0);
      expect(run.lines.filter((line) => POWER_OFF.test(line) || line.includes("poweroff"))).toEqual(
        [],
      );
      expect(
        run.lines.map((line) => line.replace(/^(opscrew: server firewall on) .*$/, "$1")),
      ).toEqual([
        "systemctl try-reload-or-restart ssh.service",
        "apt-get -o DPkg::Lock::Timeout=600 update",
        "apt-get -o DPkg::Lock::Timeout=600 install -y nftables",
        `nft -f ${run.root}/etc/nftables.conf`,
        "systemctl enable nftables.service",
        "opscrew: server firewall on",
      ]);
      expect(
        readFileSync(join(run.root, "etc/ssh/sshd_config.d/00-opscrew-keys-only.conf"), "utf8"),
      ).toBe("PasswordAuthentication no\nKbdInteractiveAuthentication no\n");
      expect(tableLines(readFileSync(join(run.root, "etc/nftables.conf"), "utf8"))).toEqual(
        serverFirewallTable(RULES),
      );
    },
  );

  it.skipIf(bashSkip !== undefined)(
    "powers the server off when any part of the firewall's step fails, after password logins are off",
    async () => {
      for (const [fail, rules, last] of [
        ["apt-get", RULES, "apt-get -o DPkg::Lock::Timeout=600 update"],
        ["nft", RULES, "nft -f "],
        // Stopped while the rules file is written: the line still reaches the log.
        ["none", { ...RULES, wireguardPort: Number.NaN }, "opscrew: not a port: NaN"],
      ] as const) {
        const run = await runStep(rules, fail, 'echo "opscrew: cloud-init ran"');
        expect(run.status, fail).not.toBe(0);
        expect(run.lines[0], fail).toBe("systemctl try-reload-or-restart ssh.service");
        expect(run.lines.at(-3)?.startsWith(last), `${fail}: ${run.stdout}`).toBe(true);
        expect(run.lines.at(-2), fail).toMatch(POWER_OFF);
        expect(run.lines.at(-1), fail).toBe("systemctl poweroff");
        // Nothing after the step runs, and nothing says the firewall is on.
        expect(run.stdout).not.toContain("server firewall on");
        expect(run.stdout).not.toContain("cloud-init ran");
      }
    },
  );

  it("carries the plan's networks and WireGuard port as the module renders them", () => {
    const step = renderServerFirewall(RULES);
    expect(step).toContain("ssh_sources='203.0.113.7/32 2001:db8::/48'\n");
    expect(step).toContain("web_sources='173.245.48.0/20 2400:cb00::/32'\n");
    expect(step).toContain("wireguard_port='51820'\n");
    const none = renderServerFirewall({ sshSources: [], webSources: [] });
    expect(none).toContain("ssh_sources=''\n");
    expect(none).toContain("web_sources=''\n");
    expect(none).toContain("wireguard_port=''\n");
  });

  it("keeps the rules across reboots and turns password logins off in the same step", () => {
    const step = renderServerFirewall(RULES);
    expect(step).toContain("opscrew_firewall_rules >/etc/nftables.conf.opscrew\n");
    expect(step).toContain("mv /etc/nftables.conf.opscrew /etc/nftables.conf\n");
    expect(step).toContain("nft -f /etc/nftables.conf\n");
    expect(step).toContain("systemctl enable nftables.service\n");
    // Installs nftables when the image lacks it.
    expect(step).toContain("install -y nftables\n");
    // The rules file replaces only OpsCrew's table, never the others' (ufw's, Docker's).
    expect(step).not.toContain("flush ruleset");
    expect(step).toContain(
      "printf 'PasswordAuthentication no\\nKbdInteractiveAuthentication no\\n' >/etc/ssh/sshd_config.d/00-opscrew-keys-only.conf\n",
    );
    expect(step).toContain("systemctl try-reload-or-restart ssh.service\n");
    // The last line runs it.
    expect(step.trimEnd().split("\n").at(-1)).toBe("opscrew_server_firewall");
  });

  it.skipIf(bashSkip !== undefined)(
    "writes a table that drops by default and lets in only what the plan allows",
    () => {
      const result = rulesFile(RULES);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const dnat = (proto: string, port: number, source: string) =>
        `\t\tct direction original ct status dnat meta l4proto ${proto} ct original proto-dst ${port} ${source} accept`;
      expect(result.stdout).toBe(
        [
          "#!/usr/sbin/nft -f",
          "# Managed by OpsCrew: the firewall of this server, which has no cloud firewall. nftables.service",
          "# loads it at every boot; it replaces only the table inet opscrew-firewall.",
          "add table inet opscrew-firewall",
          "delete table inet opscrew-firewall",
          "table inet opscrew-firewall {",
          "\tchain input {",
          "\t\ttype filter hook input priority filter; policy drop;",
          '\t\tiifname "lo" accept',
          "\t\tct state established,related accept",
          '\t\tiifname "docker0" accept',
          '\t\tiifname "br-*" accept',
          '\t\tiifname "wg-opscrew*" accept',
          "\t\tmeta l4proto icmp accept",
          "\t\tmeta l4proto ipv6-icmp accept",
          "\t\tip saddr 203.0.113.7/32 tcp dport 22 accept",
          "\t\tip6 saddr 2001:db8::/48 tcp dport 22 accept",
          "\t\tip saddr 173.245.48.0/20 tcp dport { 80, 443 } accept",
          "\t\tip saddr 173.245.48.0/20 udp dport 443 accept",
          "\t\tip6 saddr 2400:cb00::/32 tcp dport { 80, 443 } accept",
          "\t\tip6 saddr 2400:cb00::/32 udp dport 443 accept",
          "\t\tudp dport 51820 accept",
          "\t}",
          "\tchain forward {",
          "\t\ttype filter hook forward priority filter; policy accept;",
          '\t\tiifname "docker0" accept',
          '\t\tiifname "br-*" accept',
          '\t\tiifname "wg-opscrew*" accept',
          dnat("tcp", 80, "ip saddr 173.245.48.0/20"),
          dnat("tcp", 443, "ip saddr 173.245.48.0/20"),
          dnat("udp", 443, "ip saddr 173.245.48.0/20"),
          dnat("tcp", 80, "ip6 saddr 2400:cb00::/32"),
          dnat("tcp", 443, "ip6 saddr 2400:cb00::/32"),
          dnat("udp", 443, "ip6 saddr 2400:cb00::/32"),
          "\t\tct direction original ct status dnat drop",
          "\t}",
          "}",
          "",
        ].join("\n"),
      );
    },
  );

  it.skipIf(bashSkip !== undefined)(
    "writes the same table OpsCrew expects on the server, for every kind of plan",
    () => {
      const cases: ServerFirewallRules[] = [
        RULES,
        // Open to everyone: each family's every address, without a source.
        { sshSources: ["0.0.0.0/0", "::/0"], webSources: ["0.0.0.0/0", "::/0"] },
        // An extra server: no web, its WireGuard port.
        { sshSources: ["198.51.100.0/24"], webSources: [], wireguardPort: 51821 },
        // Public SSH closed: no SSH rule at all.
        { sshSources: [], webSources: ["0.0.0.0/0", "::/0"], wireguardPort: 51820 },
      ];
      for (const rules of cases) {
        const result = rulesFile(rules);
        expect(result.status, result.stderr).toBe(0);
        expect(tableLines(result.stdout)).toEqual(serverFirewallTable(rules));
      }
      const open = serverFirewallTable(cases[1] as ServerFirewallRules);
      expect(open).toContain("meta nfproto ipv4 tcp dport 22 accept");
      expect(open).toContain("meta nfproto ipv6 tcp dport { 80, 443 } accept");
      expect(open.join("\n")).not.toContain("0/0");
      const closed = serverFirewallTable(cases[3] as ServerFirewallRules);
      expect(closed.filter((line) => line.includes("dport 22"))).toEqual([]);
    },
  );

  it.skipIf(bashSkip !== undefined)(
    "stops the first boot on a value that is not an address range or a port",
    () => {
      for (const rules of [
        { sshSources: ["203.0.113.7/32;", "10.0.0.0/8"], webSources: [] },
        { sshSources: [], webSources: ["0.0.0.0/0", "accept"] },
        { sshSources: [], webSources: [], wireguardPort: Number.NaN },
      ]) {
        const result = rulesFile(rules);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/^opscrew: not an? (address range|port): /m);
      }
    },
  );

  it.skipIf(bashSkip !== undefined)("is a script the shell accepts, with the first boot", () => {
    const script = renderFirstBootScript(
      renderCloudInit({
        sshPublicKey: PUBLIC_KEY,
        checkKeyLine: "ssh-ed25519 AAAA check",
        web: true,
      }),
      renderServerFirewall(RULES),
    );
    for (const shell of [bash ?? "bash", ...(sh === undefined ? [] : [sh])]) {
      const result = spawnSync(shell, ["-n"], { input: script, encoding: "utf8" });
      expect(result.stderr, shell).toBe("");
      expect(result.status, shell).toBe(0);
    }
  });

  it.skipIf(bashSkip !== undefined || nftSkip !== undefined)("is a file nft accepts", () => {
    const result = rulesFile(RULES);
    const [command = "nft", ...args] = "command" in nft ? nft.command : [];
    const check = spawnSync(command, [...args, "-c", "-f", "-"], {
      input: result.stdout,
      encoding: "utf8",
    });
    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
  });
});
