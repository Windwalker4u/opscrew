import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RemoteExec } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import {
  DNS_UPDATER_SERVICE_TEXT,
  DNS_UPDATER_VERSION,
  renderDnsUpdaterScript,
} from "./dns-updater";
import { HostFactsSchema } from "./facts";
import {
  DNS_UPDATER_FILES_SNIPPET,
  DNS_UPDATERS_SNIPPET,
  inspectHost,
  inspectScript,
  POWER_SNIPPET,
  STORAGE_SNIPPET,
} from "./inspect";
import {
  EXIT_MARK,
  parseBoard,
  parseDnsUpdaterFiles,
  parseDnsUpdaters,
  parsePower,
  parseStorage,
  SECTION_MARK,
  splitSections,
} from "./parse";
import { buildScript } from "./shell";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/home/${name}`, import.meta.url), "utf8");

/** Runs a section's snippet in the harness, with the helper the inspection script defines. */
function runSnippet(sh: ShellHarness, snippet: string) {
  const script = buildScript("snippet", {}, `docker_up() { false; }\n${snippet}`, {
    tolerant: true,
  });
  const result = sh.run(script);
  return { ...result, stdout: result.stdout.replaceAll(sh.root, "") };
}

const CONFIG = {
  schemaVersion: 1,
  app: "shop",
  zoneId: "0123456789abcdef0123456789abcdef",
  name: "shop.example.com",
  proxied: true,
  ipv4: true,
  ipv6: false,
};

describe("inspectHost on a home server", () => {
  it("reads none of the new facts on a server without them, and older facts still parse", async () => {
    const facts = await inspectHost(new FakeHost());
    expect(facts).toMatchObject({
      board: null,
      storage: { srv: null, docker: null },
      power: null,
      dnsUpdaters: [],
      dnsUpdaterFiles: { version: null, script: null, service: null, timer: null, dir: null },
    });
    const {
      board: _b,
      storage: _s,
      power: _p,
      dnsUpdaters: _d,
      dnsUpdaterFiles: _f,
      ...older
    } = facts;
    expect(HostFactsSchema.safeParse(older).success).toBe(true);
  });

  it("reads the board, storage, power and updaters' sections of the inspection", async () => {
    const fake = new FakeHost();
    const extra = [
      ["board", "Raspberry Pi 5 Model B Rev 1.0", 0],
      ["storage", "srv /dev/mmcblk0p2\ndocker /dev/sda1\ntype mmcblk0 SD", 0],
      ["power", `vcgencmd ${fixture("vcgencmd-throttled.txt")}`, 0],
      [
        "dns-updaters",
        `config shop ${JSON.stringify(CONFIG)}\nfile shop 600 root\ntoken shop absent\ntimer shop - -`,
        0,
      ],
    ]
      .map(([name, text, exit]) => `\n${SECTION_MARK}${name}\n${text}\n${EXIT_MARK}${exit}`)
      .join("\n");
    // The fake's inspection, with the sections it does not print.
    const remote: RemoteExec = {
      host: fake.host,
      async run(command, options) {
        const result = await fake.run(command, options);
        return command.includes("# opscrew-host: inspect\n")
          ? { ...result, stdout: result.stdout + extra }
          : result;
      },
    };
    expect(await inspectHost(remote)).toMatchObject({
      board: "Raspberry Pi 5 Model B Rev 1.0",
      storage: {
        srv: { source: "/dev/mmcblk0p2", disk: "mmcblk0", kind: "sd" },
        docker: { source: "/dev/sda1", disk: "sda", kind: "other" },
      },
      power: { underVoltageNow: true, underVoltageSinceBoot: true, source: "vcgencmd" },
      dnsUpdaters: [
        {
          app: "shop",
          config: CONFIG,
          configFile: { mode: "600", owner: "root" },
          token: { present: false, mode: "", owner: "", sha256: null },
          timer: { enabled: false, active: false },
          state: null,
        },
      ],
    });
  });
});

describe("board", () => {
  it("is the device tree's model without its NUL, and none without a device tree", () => {
    expect(parseBoard({ text: "Raspberry Pi 4 Model B Rev 1.5\0", exit: 0 })).toBe(
      "Raspberry Pi 4 Model B Rev 1.5",
    );
    expect(parseBoard({ text: "", exit: 1 })).toBeNull();
    expect(parseBoard({ text: "\x1b[31mred", exit: 0 })).toBeNull();
  });

  it.skipIf(!BASH_AVAILABLE)("is read from /proc/device-tree/model", () => {
    const sh = new ShellHarness();
    try {
      sh.write("/proc/device-tree/model", "Raspberry Pi 5 Model B Rev 1.0\0");
      const sections = splitSections(sh.run(inspectScript()).stdout);
      expect(parseBoard(sections.get("board") ?? { text: "", exit: 1 })).toBe(
        "Raspberry Pi 5 Model B Rev 1.0",
      );
    } finally {
      sh.dispose();
    }
  });
});

describe("storage", () => {
  it.skipIf(!BASH_AVAILABLE)(
    "is the devices of /srv and Docker's root (findmnt), with the SD card's type",
    () => {
      const sh = new ShellHarness();
      try {
        sh.write("/fixtures/findmnt-sd.txt", fixture("findmnt-sd.txt"));
        sh.write("/fixtures/findmnt-nvme.txt", fixture("findmnt-nvme.txt"));
        sh.write("/srv/apps/.keep", "");
        sh.write("/sys/block/mmcblk0/device/type", "SD\n");
        sh.write("/sys/block/mmcblk1/device/type", "MMC\n");
        const dir = sh.posix("/fixtures");
        sh.stub(
          "findmnt",
          `case "$5" in
  */srv) cat '${dir}/findmnt-sd.txt' ;;
  *) cat '${dir}/findmnt-nvme.txt' ;;
esac`,
        );
        const result = runSnippet(sh, STORAGE_SNIPPET);
        expect(sh.calls().filter((call) => call.startsWith("findmnt "))).toEqual([
          `findmnt -n -o SOURCE -T ${sh.root}/srv`,
          expect.stringMatching(/^findmnt -n -o SOURCE -T \/var\/lib(\/docker)?$/),
        ]);
        expect(result.stdout).toContain("type mmcblk1 MMC");
        expect(parseStorage(result.stdout)).toEqual({
          srv: { source: "/dev/mmcblk0p2", disk: "mmcblk0", kind: "sd" },
          docker: { source: "/dev/nvme0n1p2", disk: "nvme0n1", kind: "other" },
        });
      } finally {
        sh.dispose();
      }
    },
  );

  it("tells an SD card from eMMC and an unknown mmc device", () => {
    expect(parseStorage("srv /dev/mmcblk1p1\ndocker /dev/mmcblk2\ntype mmcblk1 MMC")).toEqual({
      srv: { source: "/dev/mmcblk1p1", disk: "mmcblk1", kind: "mmc" },
      docker: { source: "/dev/mmcblk2", disk: "mmcblk2", kind: "mmc-unknown" },
    });
    expect(parseStorage("srv /dev/vda2\ndocker rpool/ROOT/debian")).toEqual({
      srv: { source: "/dev/vda2", disk: "vda", kind: "other" },
      docker: { source: "rpool/ROOT/debian", disk: "rpool/ROOT/debian", kind: "other" },
    });
    expect(parseStorage("srv \ndocker")).toEqual({ srv: null, docker: null });
  });
});

describe("power", () => {
  it("reads under-voltage from vcgencmd's bits", () => {
    expect(parsePower(`vcgencmd ${fixture("vcgencmd-throttled.txt")}`)).toEqual({
      underVoltageNow: true,
      underVoltageSinceBoot: true,
      source: "vcgencmd",
    });
    expect(parsePower(`vcgencmd ${fixture("vcgencmd-clear.txt")}`)).toEqual({
      underVoltageNow: false,
      underVoltageSinceBoot: false,
      source: "vcgencmd",
    });
    expect(parsePower("vcgencmd throttled=0x50000")).toMatchObject({
      underVoltageNow: false,
      underVoltageSinceBoot: true,
    });
    expect(parsePower("")).toBeNull();
  });

  it.skipIf(!BASH_AVAILABLE)(
    "asks vcgencmd first, else this boot's kernel log on a board, else nothing",
    () => {
      const sh = new ShellHarness();
      try {
        sh.write("/fixtures/vcgencmd.txt", fixture("vcgencmd-throttled.txt"));
        sh.write("/fixtures/kernel.txt", fixture("kernel-log-undervoltage.txt"));
        const dir = sh.posix("/fixtures");
        sh.stub("vcgencmd", `cat '${dir}/vcgencmd.txt'`);
        expect(parsePower(runSnippet(sh, POWER_SNIPPET).stdout)?.source).toBe("vcgencmd");

        // Without vcgencmd and not a board (no device tree): the kernel log is not read.
        sh.stub("vcgencmd", "exit 127");
        sh.stub(
          "journalctl",
          `case "$*" in *"-n 0"*) exit 0 ;; esac
cat '${dir}/kernel.txt'`,
        );
        sh.clearCalls();
        const server = runSnippet(sh, POWER_SNIPPET);
        expect(parsePower(server.stdout)).toBeNull();
        expect(sh.calls().filter((call) => call.startsWith("journalctl "))).toEqual([]);

        // Without vcgencmd on a board: the kernel log, where the voltage came back.
        sh.write("/proc/device-tree/model", "Raspberry Pi 5 Model B Rev 1.0\0");
        expect(parsePower(runSnippet(sh, POWER_SNIPPET).stdout)).toEqual({
          underVoltageNow: false,
          underVoltageSinceBoot: true,
          source: "kernel-log",
        });
        // The last line says it is happening now.
        sh.write(
          "/fixtures/kernel.txt",
          `${fixture("kernel-log-undervoltage.txt")}hwmon hwmon2: Undervoltage detected!\n`,
        );
        expect(parsePower(runSnippet(sh, POWER_SNIPPET).stdout)?.underVoltageNow).toBe(true);
        // No kernel line about it.
        sh.write("/fixtures/kernel.txt", "Booting Linux on physical CPU 0x0\n");
        expect(parsePower(runSnippet(sh, POWER_SNIPPET).stdout)).toEqual({
          underVoltageNow: false,
          underVoltageSinceBoot: false,
          source: "kernel-log",
        });
        // Neither can be read.
        sh.stub("journalctl", "exit 1");
        const none = runSnippet(sh, POWER_SNIPPET);
        expect(none.status).not.toBe(0);
        expect(parsePower(none.stdout)).toBeNull();
      } finally {
        sh.dispose();
      }
    },
  );
});

describe("dnsUpdaters", () => {
  it.skipIf(!BASH_AVAILABLE)(
    "reads each instance's config, token file, timer and state, never the token",
    () => {
      const sh = new ShellHarness();
      try {
        const token = fakeSecret("cloudflare-token");
        const state = {
          schemaVersion: 1,
          version: 1,
          lastRun: "2026-11-20T10:04:12Z",
          lastSuccess: "2026-11-20T10:04:12Z",
          seen: { ipv4: "203.0.113.7", ipv6: null },
          records: { ipv4: "203.0.113.7", ipv6: null },
        };
        sh.write("/etc/opscrew/dns-updater/shop.json", `${JSON.stringify(CONFIG, null, 2)}\n`);
        sh.write("/etc/opscrew/dns-updater/shop.token", token);
        sh.write("/var/lib/opscrew-dns-updater/shop/state.json", JSON.stringify(state));
        // A config that does not parse, with no token and no state; a file that is no app's.
        sh.write("/etc/opscrew/dns-updater/blog.json", "{");
        sh.write("/etc/opscrew/dns-updater/Bad Name.json", "{}");
        // A state file larger than inspection reads.
        sh.write("/etc/opscrew/dns-updater/news.json", JSON.stringify({ ...CONFIG, app: "news" }));
        sh.write(
          "/var/lib/opscrew-dns-updater/news/state.json",
          JSON.stringify({ ...state, padding: "x".repeat(5000) }),
        );
        sh.stub("stat", "echo '600 root'", { log: false });
        sh.stub(
          "systemctl",
          `case "$1 $2" in
  "is-enabled opscrew-dns-updater@shop.timer") echo enabled ;;
  "is-active opscrew-dns-updater@shop.timer") echo active ;;
  is-enabled*) echo disabled; exit 1 ;;
  *) echo inactive; exit 3 ;;
esac`,
        );
        const result = runSnippet(sh, DNS_UPDATERS_SNIPPET);
        expect(result.stdout).not.toContain(token);
        const absent = { present: false, mode: "", owner: "", sha256: null };
        const off = { enabled: false, active: false };
        const configFile = { mode: "600", owner: "root" };
        expect(parseDnsUpdaters(result.stdout)).toEqual([
          { app: "blog", config: null, configFile, token: absent, timer: off, state: null },
          {
            app: "news",
            config: { ...CONFIG, app: "news" },
            configFile,
            token: absent,
            timer: off,
            state: null,
          },
          {
            app: "shop",
            config: CONFIG,
            configFile,
            token: {
              present: true,
              mode: "600",
              owner: "root",
              sha256: createHash("sha256").update(token).digest("hex"),
            },
            timer: { enabled: true, active: true },
            state,
          },
        ]);
      } finally {
        sh.dispose();
      }
    },
  );

  it("keeps only a config that parses as the updater's own", () => {
    const line = (config: object) => `config shop ${JSON.stringify(config)}`;
    expect(parseDnsUpdaters(line(CONFIG))[0]?.config).toEqual(CONFIG);
    expect(parseDnsUpdaters(line({ ...CONFIG, token: "x" }))[0]?.config).toBeNull();
    expect(parseDnsUpdaters(line({ ...CONFIG, zoneId: "nope" }))[0]?.config).toBeNull();
    // Without its file line, the config file's mode is unknown.
    expect(parseDnsUpdaters(line(CONFIG))[0]?.configFile).toEqual({ mode: "", owner: "" });
    // An instance is listed by its config: lines without one are left out.
    expect(parseDnsUpdaters("timer blog enabled active\ntoken blog absent")).toEqual([]);
  });

  it.skipIf(!BASH_AVAILABLE)(
    "reads the shared script's version and the script's, units' and folder's mode, owner and hash",
    () => {
      const sh = new ShellHarness();
      try {
        const script = renderDnsUpdaterScript();
        const sum = (text: string) => createHash("sha256").update(text).digest("hex");
        sh.write("/usr/local/sbin/opscrew-dns-updater", script);
        sh.write("/etc/systemd/system/opscrew-dns-updater@.service", DNS_UPDATER_SERVICE_TEXT);
        sh.write("/etc/opscrew/dns-updater/shop.json", "{}");
        sh.stub(
          "stat",
          `case "$3" in
  */opscrew-dns-updater) echo '755 root' ;;
  */dns-updater) echo '700 root' ;;
  *) echo '644 root' ;;
esac`,
          { log: false },
        );
        const { stdout } = runSnippet(sh, DNS_UPDATER_FILES_SNIPPET);
        expect(parseDnsUpdaterFiles(stdout)).toEqual({
          version: DNS_UPDATER_VERSION,
          script: { mode: "755", owner: "root", sha256: sum(script) },
          service: { mode: "644", owner: "root", sha256: sum(DNS_UPDATER_SERVICE_TEXT) },
          timer: null,
          dir: { mode: "700", owner: "root" },
        });
        // Nothing there: every file null.
        sh.write("/usr/local/sbin/opscrew-dns-updater", "#!/bin/sh\n# something else\n");
        expect(parseDnsUpdaterFiles(runSnippet(sh, DNS_UPDATER_FILES_SNIPPET).stdout).version).toBe(
          null,
        );
        expect(parseDnsUpdaterFiles("")).toEqual({
          version: null,
          script: null,
          service: null,
          timer: null,
          dir: null,
        });
      } finally {
        sh.dispose();
      }
    },
  );
});
