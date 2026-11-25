import { randomBytes } from "node:crypto";
import type { CommandResult, RemoteExec, RemoteRunOptions } from "@opscrew/contracts";
import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import { ownServer, SH_AVAILABLE, SHOP_PROJECT, shSyntax } from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { applyHostPlan } from "./apply";
import type { HostFacts, UptimeReportFacts } from "./facts";
import { hostPlanHash } from "./hash";
import { inspectHost, inspectUptimeReport } from "./inspect";
import { planTeardown, planUndo, planUptimeReport } from "./plan";
import { stepScripts } from "./steps";
import type { DesiredUptimeReport, HostPlan, HostStep } from "./types";
import {
  parseUptimeReport,
  renderUptimeReportScript,
  UPTIME_REPORT_CONFIG_DIR,
  UPTIME_REPORT_SCRIPT,
  UPTIME_REPORT_SERVICE_TEXT,
  UPTIME_REPORT_SERVICE_UNIT,
  UPTIME_REPORT_SNIPPET,
  UPTIME_REPORT_TIMER_TEXT,
  UPTIME_REPORT_TIMER_UNIT,
  uptimeReportConfigText,
  uptimeReportFileHashes,
  uptimeReportInstance,
} from "./uptime-report";

const KEY = randomBytes(32).toString("hex");
const KEY_SHA256 = sha256Hex(KEY);
const ENTRY = "acme/shop/shop/prod";
const INSTANCE = uptimeReportInstance(ENTRY);
const CONFIG = `${UPTIME_REPORT_CONFIG_DIR}/${INSTANCE}.conf`;
const KEY_FILE = `${UPTIME_REPORT_CONFIG_DIR}/${INSTANCE}.key`;
const REPORT: DesiredUptimeReport = {
  url: "https://opscrew-uptime.acme.workers.dev/report",
  entry: ENTRY,
  server: "app",
  drill: "weekly",
  hosts: ["shop.example.com", "www.shop.example.com"],
  thresholds: { diskWarn: 85, diskHigh: 95, certDays: 14 },
  credentials: {
    maxAgeDays: 365,
    dates: [
      { name: "deploy-key", at: "2026-01-10T09:00:00Z", source: "rotated" },
      { name: "POSTGRES_PASSWORD", at: "2025-12-01T08:00:00.000Z", source: "first-deploy" },
    ],
  },
  keySha256: KEY_SHA256,
};

const NO_FACTS: UptimeReportFacts = {
  version: null,
  script: null,
  service: null,
  timer: null,
  dir: null,
  tools: { curl: true, openssl: true },
  instances: [],
};

/** The facts of a server where `report` of "shop" is installed as planned. */
function installed(report: DesiredUptimeReport = REPORT, app = "shop"): UptimeReportFacts {
  const hashes = uptimeReportFileHashes();
  return {
    version: 1,
    script: { mode: "755", owner: "root", sha256: hashes.script },
    service: { mode: "644", owner: "root", sha256: hashes.service },
    timer: { mode: "644", owner: "root", sha256: hashes.timer },
    dir: { mode: "700", owner: "root" },
    tools: { curl: true, openssl: true },
    instances: [
      {
        instance: uptimeReportInstance(report.entry),
        app,
        config: {
          mode: "600",
          owner: "root",
          sha256: sha256Hex(uptimeReportConfigText(app, report)),
        },
        key: { mode: "600", owner: "root", sha256: report.keySha256 },
        timer: { enabled: true, active: true },
      },
    ],
  };
}

function stepOf(plan: HostPlan): HostStep {
  expect(plan.steps).toHaveLength(1);
  return plan.steps[0] as HostStep;
}

describe("the uptime report's files", () => {
  it("renders the units and the script as the contract, with the version on line 2", () => {
    expect(UPTIME_REPORT_SERVICE_TEXT).toMatchSnapshot("service");
    expect(UPTIME_REPORT_TIMER_TEXT).toMatchSnapshot("timer");
    expect(renderUptimeReportScript()).toMatchSnapshot("script");
    expect(renderUptimeReportScript().split("\n").slice(0, 2)).toEqual([
      "#!/bin/sh",
      "# opscrew-uptime-report version 1",
    ]);
    const service = UPTIME_REPORT_SERVICE_TEXT.split("\n");
    for (const line of [
      "Type=oneshot",
      "User=deploy",
      "LoadCredential=config:/etc/opscrew/uptime-report/%i.conf",
      "LoadCredential=key:/etc/opscrew/uptime-report/%i.key",
      "StateDirectory=opscrew-uptime-report/%i",
      `ExecStart=${UPTIME_REPORT_SCRIPT}`,
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
    ]) {
      expect(service).toContain(line);
    }
    for (const line of ["OnBootSec=2min", "OnUnitActiveSec=5min", "RandomizedDelaySec=30"]) {
      expect(UPTIME_REPORT_TIMER_TEXT.split("\n")).toContain(line);
    }
  });

  it("writes the config as data-model.md says: key=value lines, names and dates only", () => {
    expect(
      uptimeReportConfigText("shop", REPORT),
    ).toBe(`# /etc/opscrew/uptime-report/${INSTANCE}.conf
# Managed by OpsCrew: what the uptime report of acme/shop/shop/prod checks on this server.
url=https://opscrew-uptime.acme.workers.dev/report
entry=acme/shop/shop/prod
server=app
app=shop
drill=weekly
disk_warn=85
disk_high=95
cert_days=14
host=shop.example.com
host=www.shop.example.com
max_age_days=365
credential=deploy-key 2026-01-10T09:00:00Z rotated
credential=POSTGRES_PASSWORD 2025-12-01T08:00:00.000Z first-deploy
`);
    const { credentials: _c, drill: _d, ...plain } = REPORT;
    expect(uptimeReportConfigText("shop", { ...plain, hosts: [] })).not.toMatch(
      /^(host|max_age_days|credential)=/m,
    );
    expect(INSTANCE).toBe(sha256Hex(ENTRY).slice(0, 16));
  });

  it.skipIf(!SH_AVAILABLE)("is valid sh, and so is the inspection", () => {
    expect(shSyntax(renderUptimeReportScript())?.ok).toBe(true);
    expect(shSyntax(UPTIME_REPORT_SNIPPET)?.ok).toBe(true);
  });
});

describe("planning the uptime-report step", () => {
  it("installs the instance with the key's SHA-256 only, and says what it installs", () => {
    const plan = planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT });
    const step = stepOf(plan);
    expect(plan).toMatchObject({ purpose: "setup", app: "shop", findings: [] });
    expect(step).toMatchObject({ id: "uptime-report", state: "change", scope: "app" });
    expect(step.params).toEqual({
      app: "shop",
      instance: INSTANCE,
      url: REPORT.url,
      entry: ENTRY,
      server: "app",
      drill: "weekly",
      hosts: "shop.example.com www.shop.example.com",
      diskWarn: 85,
      diskHigh: 95,
      certDays: 14,
      maxAgeDays: 365,
      credentials:
        "deploy-key 2026-01-10T09:00:00Z rotated\nPOSTGRES_PASSWORD 2025-12-01T08:00:00.000Z first-deploy",
      version: 1,
      packages: "",
      keySha256: KEY_SHA256,
    });
    expect(canonicalJson(plan)).not.toContain(KEY);
    for (const text of [
      UPTIME_REPORT_SCRIPT,
      "mode 755",
      UPTIME_REPORT_SERVICE_UNIT,
      UPTIME_REPORT_TIMER_UNIT,
      `${CONFIG} (600, root's)`,
      `${KEY_FILE} (600, root's), the report key supplied at apply time, which this plan names by its SHA-256 only`,
      "the hostnames shop.example.com and www.shop.example.com",
      "the credentials deploy-key and POSTGRES_PASSWORD with their 365-day limit, never a value",
      "as deploy",
      "LoadCredential=",
      "127.0.0.1:443",
      "only when a status changes, and once a day",
      "never a log line, an address or a secret",
      "The report key can only send reports for this one environment",
    ]) {
      expect(step.reason).toContain(text);
    }
    expect(hostPlanHash(plan)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("installs curl and openssl when the server lacks them", () => {
    const facts = { ...installed(), tools: { curl: false, openssl: false } };
    const step = stepOf(planUptimeReport({ app: "shop", facts, enable: REPORT }));
    expect(step.state).toBe("change");
    expect(step.params.packages).toBe("curl openssl");
    expect(step.reason).toMatch(/^It installs curl and openssl first\./);
    const scripts = stepScripts(planUptimeReport({ app: "shop", facts, enable: REPORT }), step);
    expect(scripts.preApply).toContain("apt_get install --no-install-recommends $PACKAGES");
    expect(scripts.preApply).toContain("PACKAGES='curl openssl'");
    const curlOnly = { ...installed(), tools: { curl: false, openssl: true } };
    expect(
      stepOf(planUptimeReport({ app: "shop", facts: curlOnly, enable: REPORT })).params.packages,
    ).toBe("curl");
    expect(
      stepScripts(
        planUptimeReport({ app: "shop", facts: installed(), enable: REPORT }),
        stepOf(planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT })),
      ).preApply,
    ).toBeUndefined();
  });

  it("is in place when the facts show all of it as planned, and replaces what differs", () => {
    expect(
      stepOf(planUptimeReport({ app: "shop", facts: installed(), enable: REPORT })),
    ).toMatchObject({
      state: "in-place",
      reason: "Already running.",
    });
    const differs = (edit: (facts: UptimeReportFacts) => void) => {
      const facts = structuredClone(installed());
      edit(facts);
      return stepOf(planUptimeReport({ app: "shop", facts, enable: REPORT })).state;
    };
    const own = (facts: UptimeReportFacts) => {
      const found = facts.instances[0];
      if (found === undefined) throw new Error("no instance");
      return found;
    };
    expect(
      differs((f) => (own(f).key = { mode: "600", owner: "root", sha256: "1".repeat(64) })),
    ).toBe("change");
    expect(differs((f) => (own(f).key = null))).toBe("change");
    expect(differs((f) => (own(f).config.sha256 = "2".repeat(64)))).toBe("change");
    expect(differs((f) => (own(f).config.mode = "644"))).toBe("change");
    expect(differs((f) => (own(f).timer.active = false))).toBe("change");
    expect(differs((f) => (f.dir = { mode: "755", owner: "root" }))).toBe("change");
    expect(
      differs((f) => (f.script = { mode: "755", owner: "root", sha256: "3".repeat(64) })),
    ).toBe("change");
    expect(differs((f) => (f.version = null))).toBe("change");
    // A newer version on the server is never replaced: its files stand.
    expect(
      differs((f) => {
        f.version = 2;
        f.script = { mode: "755", owner: "root", sha256: "4".repeat(64) };
      }),
    ).toBe("in-place");
    // Another credential date (after a rotation) is a new config.
    const rotated = {
      ...REPORT,
      credentials: {
        maxAgeDays: 365,
        dates: [{ name: "deploy-key", at: "2026-11-25T10:00:00Z", source: "rotated" as const }],
      },
    };
    expect(
      stepOf(planUptimeReport({ app: "shop", facts: installed(), enable: rotated })).state,
    ).toBe("change");
  });

  it("refuses settings that are not valid before anything is planned", () => {
    for (const enable of [
      { ...REPORT, url: "https://example.com/report" },
      { ...REPORT, url: "http://opscrew-uptime.acme.workers.dev/report" },
      { ...REPORT, entry: "acme/shop" },
      { ...REPORT, server: "a b" },
      { ...REPORT, hosts: ["Shop.Example.com"] },
      { ...REPORT, keySha256: KEY_SHA256.toUpperCase() },
      { ...REPORT, hosts: Array.from({ length: 41 }, (_, n) => `h${n}.example.com`) },
      { ...REPORT, thresholds: { diskWarn: 96, diskHigh: 95, certDays: 14 } },
      {
        ...REPORT,
        credentials: {
          maxAgeDays: 365,
          dates: [{ name: "a b", at: "2026-01-01T00:00:00Z", source: "made" as const }],
        },
      },
    ]) {
      expect(() => planUptimeReport({ app: "shop", facts: NO_FACTS, enable })).toThrow(
        OpsCrewError,
      );
    }
    expect(() => planUptimeReport({ app: "shop", facts: NO_FACTS })).toThrow(/either on or off/);
    expect(() => planUptimeReport({ app: "Shop", facts: NO_FACTS, enable: REPORT })).toThrow(
      /app name/,
    );
  });

  it("checks the step's parameters when its scripts are made", () => {
    const plan = planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT });
    const step = stepOf(plan);
    const bad =
      (params: HostStep["params"], app = "shop") =>
      () =>
        stepScripts({ ...plan, app }, { ...step, params });
    expect(bad({ ...step.params, version: 2 })).toThrow(/invalid parameters/);
    expect(bad({ ...step.params, instance: "0".repeat(16) })).toThrow(/instance/);
    expect(bad({ ...step.params, url: "https://example.com/report" })).toThrow(/url/);
    expect(bad({ ...step.params, extra: true })).toThrow(/invalid parameters/);
    const { maxAgeDays: _m, ...noLimit } = step.params;
    expect(bad(noLimit)).toThrow(/maxAgeDays/);
    expect(bad(step.params, "blog")).toThrow(/invalid parameters \(app\)/);
  });

  it("removes the entry's instance, and the script and units with the last one", () => {
    const last = stepOf(
      planUptimeReport({ app: "shop", facts: installed(), disable: { entry: ENTRY } }),
    );
    expect(last).toMatchObject({
      state: "change",
      scope: "app",
      params: { remove: true, instances: INSTANCE, shared: true },
    });
    expect(last.title).toBe(
      `Remove the uptime report ${INSTANCE}, and its script and units with the last one`,
    );
    const staging = { ...REPORT, entry: "acme/shop/shop-staging/staging" };
    const two = installed();
    two.instances.push(...installed(staging, "shop-staging").instances);
    const one = stepOf(planUptimeReport({ app: "shop", facts: two, disable: { entry: ENTRY } }));
    expect(one.params).toEqual({ remove: true, instances: INSTANCE, shared: false });
    expect(one.reason).toContain("The other environments' reports stay.");
    // Nothing of the entry's on the server: nothing to do.
    expect(
      stepOf(planUptimeReport({ app: "shop", facts: NO_FACTS, disable: { entry: ENTRY } })),
    ).toMatchObject({ state: "in-place", reason: "Not on this server." });
  });

  it("is removed by the app's teardown, and what is left by an undo", async () => {
    const host = await inspectHost(await ownServer());
    const blog = { ...REPORT, entry: "acme/shop/blog/prod" };
    const report = installed();
    report.instances.push(...installed(blog, "blog").instances);
    const facts: HostFacts = { ...host, uptimeReport: report };
    const teardown = planTeardown(
      facts,
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(teardown.steps.filter((item) => item.id === "uptime-report")).toEqual([
      expect.objectContaining({
        scope: "app",
        params: { remove: true, instances: INSTANCE, shared: false },
      }),
    ]);
    const lone: HostFacts = { ...host, uptimeReport: installed() };
    const last = planTeardown(
      lone,
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(last.steps.find((item) => item.id === "uptime-report")?.params).toEqual({
      remove: true,
      instances: INSTANCE,
      shared: true,
    });
    const fake = new FakeHost();
    fake.files.set(
      "/etc/opscrew/host.json",
      JSON.stringify({ schemaVersion: 1, apps: [], opscrewVersion: "0.2.10", changes: [] }),
    );
    const bare = await inspectHost(fake);
    const undo = planUndo(
      { ...bare, uptimeReport: { ...installed(), instances: [] } },
      {},
      "opscrew destroy --undo-host",
    );
    expect(undo.steps.find((item) => item.id === "uptime-report")).toMatchObject({
      scope: "shared",
      params: { remove: true, instances: "", shared: true },
    });
    expect(
      planUndo({ ...bare, uptimeReport: NO_FACTS }, {}, "x").steps.some(
        (item) => item.id === "uptime-report",
      ),
    ).toBe(false);
    // Older facts, without the uptime report's, plan no removal.
    const { uptimeReport: _u, ...older } = host;
    expect(
      planTeardown(
        older,
        { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
        "x",
      ).steps.some((item) => item.id === "uptime-report"),
    ).toBe(false);
  });
});

/**
 * A shell harness with what the step's scripts call stubbed: systemctl (timers enabled as files in
 * $S, `start` appends `$S/run` to the journal), journalctl (prints the journal), `stat` (each file
 * with the mode the data model gives it, or `$S/mode-<name>`), and `id`, curl and openssl present.
 */
function stepHarness(): ShellHarness {
  const sh = new ShellHarness();
  sh.stub(
    "systemctl",
    `case "$1" in
  --version) echo 'systemd 252 (252.30-1~deb12u2)' ;;
  enable) for a do case "$a" in *.timer) touch "$S/enabled-$a" ;; esac; done ;;
  disable) for a do case "$a" in *.timer) rm -f "$S/enabled-$a" ;; esac; done ;;
  is-enabled) if [ -e "$S/enabled-$2" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) t=$2; [ "$t" != --quiet ] || t=$3; if [ -e "$S/enabled-$t" ]; then echo active; else echo inactive; exit 3; fi ;;
  start) cat "$S/run" >> "$S/journal" ;;
esac`,
  );
  sh.stub("journalctl", `cat "$S/journal" 2>/dev/null || true`);
  sh.stub(
    "stat",
    `n=\${3##*/}
if [ -e "$S/mode-$n" ]; then echo "$(cat "$S/mode-$n") root"; exit 0; fi
case "$3" in
  */uptime-report.sh) echo '755 root' ;;
  */uptime-report) echo '700 root' ;;
  *.conf | *.key) echo '600 root' ;;
  *) echo '644 root' ;;
esac`,
    { log: false },
  );
  sh.stub(
    "id",
    `if [ "$1" = -u ] && [ $# -eq 1 ]; then echo 0; elif [ "$2" = deploy ]; then echo 1000; else exit 1; fi`,
    { log: false },
  );
  for (const name of ["curl", "openssl", "chmod", "apt-get"]) sh.stub(name, "exit 0");
  sh.write("/state/run", "uptime report: disk ok, snapshot ok, drill none; sent a change report\n");
  return sh;
}

/** A RemoteExec that runs each command in `sh`, as root (the harness's `id -u` says 0). */
function harnessRemote(
  sh: ShellHarness,
): RemoteExec & { inputs: (string | undefined)[]; commands: string[] } {
  const inputs: (string | undefined)[] = [];
  const commands: string[] = [];
  return {
    host: "harness",
    inputs,
    commands,
    async run(command: string, options: RemoteRunOptions = {}): Promise<CommandResult> {
      commands.push(command);
      inputs.push(options.input);
      const result = sh.run(command, options.input);
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

describe.skipIf(!BASH_AVAILABLE)("the step's scripts in a real shell (commands stubbed)", () => {
  it("inspects, plans and applies: the files as planned, the key on standard input only, then in place", async () => {
    const sh = stepHarness();
    try {
      const remote = harnessRemote(sh);
      const before = await inspectUptimeReport(remote);
      expect(before).toEqual({ ...NO_FACTS, tools: { curl: true, openssl: true } });
      const plan = planUptimeReport({ app: "shop", facts: before, enable: REPORT });
      await expect(
        applyHostPlan(remote, plan, {
          approvedHash: hostPlanHash(plan),
          command: "opscrew provision",
          verifyLogin: async () => true,
        }),
      ).rejects.toThrow(
        "Applying this plan needs the environment's uptime report key, and none was supplied.",
      );
      const result = await applyHostPlan(remote, plan, {
        approvedHash: hostPlanHash(plan),
        command: "opscrew provision",
        verifyLogin: async () => true,
        secrets: { uptimeReportKey: KEY },
      });
      expect(result).toEqual({ applied: ["uptime-report"], skipped: [] });
      expect(sh.read(UPTIME_REPORT_SCRIPT)).toBe(renderUptimeReportScript());
      expect(sh.read(UPTIME_REPORT_SERVICE_UNIT)).toBe(UPTIME_REPORT_SERVICE_TEXT);
      expect(sh.read(UPTIME_REPORT_TIMER_UNIT)).toBe(UPTIME_REPORT_TIMER_TEXT);
      expect(sh.read(CONFIG)).toBe(uptimeReportConfigText("shop", REPORT));
      expect(sh.read(KEY_FILE)).toBe(KEY);
      expect(sh.calls()).toEqual(
        expect.arrayContaining([
          `systemctl enable --now --quiet opscrew-uptime-report@${INSTANCE}.timer`,
          `systemctl start opscrew-uptime-report@${INSTANCE}.service`,
        ]),
      );
      // The key reached the server only on the apply's standard input.
      expect(remote.commands.join("\n")).not.toContain(KEY);
      expect(sh.calls().join("\n")).not.toContain(KEY);
      expect(remote.inputs.filter((input) => input?.includes(KEY))).toEqual([`${KEY}\n`]);
      expect(sh.read("/etc/opscrew/host.json")).not.toContain(KEY_SHA256);
      // The inspection reads it back, and the same plan is in place.
      const after = await inspectUptimeReport(remote);
      expect(after).toEqual(installed());
      expect(stepOf(planUptimeReport({ app: "shop", facts: after, enable: REPORT })).state).toBe(
        "in-place",
      );
      expect(JSON.stringify(after)).not.toContain(KEY);
    } finally {
      sh.dispose();
    }
  });

  it("refuses another key, or none, before anything is written", () => {
    const sh = stepHarness();
    try {
      const plan = planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT });
      const { apply } = stepScripts(plan, stepOf(plan));
      const other = sh.run(apply, `${randomBytes(32).toString("hex")}\n`);
      expect(other.status).not.toBe(0);
      expect(other.stderr).toBe(
        "opscrew: The report key that arrived on standard input is not the one the plan names, so it was not written. Nothing was changed.\n",
      );
      expect(sh.run(apply).stderr).toContain("No valid report key arrived on standard input");
      expect(sh.run(apply, `${KEY.toUpperCase()}\n`).stderr).toContain("No valid report key");
      expect(sh.exists(UPTIME_REPORT_SCRIPT) || sh.exists(CONFIG) || sh.exists(KEY_FILE)).toBe(
        false,
      );
      sh.stub("systemctl", `[ "$1" = --version ] && echo 'systemd 245 (245.4-4ubuntu3)'`);
      expect(sh.run(apply, `${KEY}\n`).stderr).toContain(
        "needs systemd 247 or newer (for LoadCredential=), and this server has 245",
      );
      sh.stub("systemctl", `[ "$1" = --version ] && echo 'systemd 252'`);
      sh.stub("id", "exit 1", { log: false });
      expect(sh.run(apply, `${KEY}\n`).stderr).toContain(
        "runs as deploy, and this server has no such user",
      );
      expect(sh.exists(KEY_FILE)).toBe(false);
    } finally {
      sh.dispose();
    }
  });

  it("writes each file with the data model's mode, and is a change when one differs", () => {
    const sh = stepHarness();
    try {
      const plan = planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT });
      const scripts = stepScripts(plan, stepOf(plan));
      for (const line of [
        'write_file "$SCRIPT" 0755',
        'write_file "$SERVICE_UNIT" 0644',
        'write_file "$TIMER_UNIT" 0644',
        'install -d -m 0700 "$OPSCREW_DIR" "$CONFIG_DIR"',
        'write_file "$CONFIG" 0600',
        'write_file "$KEY_FILE" 0600',
      ]) {
        expect(scripts.apply).toContain(line);
      }
      expect(sh.run(scripts.check).stdout).toBe(
        "prev.installed=false\nprev.instance=false\nstate=change\n",
      );
      expect(sh.run(scripts.apply, `${KEY}\n`).status).toBe(0);
      expect(sh.run(scripts.check).stdout).toContain("state=in-place");
      expect(sh.run(scripts.verify).status).toBe(0);
      for (const [name, mode] of [
        [`${INSTANCE}.key`, "644"],
        [`${INSTANCE}.conf`, "640"],
        ["uptime-report", "755"],
        ["uptime-report.sh", "775"],
      ] as const) {
        sh.write(`/state/mode-${name}`, mode);
        expect(sh.run(scripts.check).stdout, name).toContain("state=change");
        sh.write(
          `/state/mode-${name}`,
          name.endsWith(".key") || name.endsWith(".conf")
            ? "600"
            : name === "uptime-report"
              ? "700"
              : "755",
        );
      }
      expect(sh.run(scripts.check).stdout).toContain("state=in-place");
    } finally {
      sh.dispose();
    }
  });

  it("verifies with the first run's journal line, and says what failed", () => {
    const sh = stepHarness();
    try {
      const plan = planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT });
      const scripts = stepScripts(plan, stepOf(plan));
      expect(sh.run(scripts.apply, `${KEY}\n`).status).toBe(0);
      expect(sh.run(scripts.verify).status).toBe(0);
      sh.write("/state/run", "uptime report: disk ok, snapshot ok, drill none; no change\n");
      expect(sh.run(scripts.verify).status).toBe(0);
      sh.write(
        "/state/run",
        "uptime report: disk ok, snapshot ok, drill none; the Worker refused the report (HTTP 401), so the next run sends again\n",
      );
      const refused = sh.run(scripts.verify);
      expect(refused.status).toBe(5);
      expect(refused.stderr).toBe(
        "opscrew: The uptime report's first run did not reach the Worker (disk ok, snapshot ok, drill none; the Worker refused the report (HTTP 401), so the next run sends again). Check that this environment's Cloudflare plan was applied, then run the command again.\n",
      );
      sh.write("/state/journal", "");
      sh.write("/state/run", "");
      expect(sh.run(scripts.verify).stderr).toContain("wrote no line to the journal");
    } finally {
      sh.dispose();
    }
  });

  it("keeps a newer script and units, and still writes the instance", () => {
    const sh = stepHarness();
    try {
      const newer = "#!/bin/sh\n# opscrew-uptime-report version 2\n";
      sh.write(UPTIME_REPORT_SCRIPT, newer);
      sh.write(UPTIME_REPORT_SERVICE_UNIT, "newer\n");
      sh.write(UPTIME_REPORT_TIMER_UNIT, "newer\n");
      const plan = planUptimeReport({ app: "shop", facts: NO_FACTS, enable: REPORT });
      const scripts = stepScripts(plan, stepOf(plan));
      expect(sh.run(scripts.apply, `${KEY}\n`).status).toBe(0);
      expect(sh.read(UPTIME_REPORT_SCRIPT)).toBe(newer);
      expect(sh.read(UPTIME_REPORT_SERVICE_UNIT)).toBe("newer\n");
      expect(sh.read(CONFIG)).toBe(uptimeReportConfigText("shop", REPORT));
      expect(sh.run(scripts.check).stdout).toContain("state=in-place");
      // An older one is replaced.
      sh.write(UPTIME_REPORT_SCRIPT, "#!/bin/sh\n# opscrew-uptime-report version 0\n");
      expect(sh.run(scripts.check).stdout).toContain("state=change");
      expect(sh.run(scripts.apply, `${KEY}\n`).status).toBe(0);
      expect(sh.read(UPTIME_REPORT_SCRIPT)).toBe(renderUptimeReportScript());
    } finally {
      sh.dispose();
    }
  });

  it("removes one instance while another stays, then the script and units with the last, and never another app's", () => {
    const sh = stepHarness();
    try {
      const apply = (report: DesiredUptimeReport, app: string) => {
        const plan = planUptimeReport({ app, facts: NO_FACTS, enable: report });
        expect(sh.run(stepScripts(plan, stepOf(plan)).apply, `${KEY}\n`).status).toBe(0);
      };
      const blog = { ...REPORT, entry: "acme/shop/blog/prod" };
      const blogInstance = uptimeReportInstance(blog.entry);
      apply(REPORT, "shop");
      apply(blog, "blog");
      sh.write(`/var/lib/opscrew-uptime-report/${INSTANCE}/state`, "sent 1\n");
      const removal = (app: string, instance: string, purpose: HostPlan["purpose"] = "setup") => {
        const step: HostStep = {
          id: "uptime-report",
          title: "t",
          state: "change",
          scope: "app",
          params: { remove: true, instances: instance, shared: true },
        };
        return stepScripts({ schemaVersion: 1, purpose, app, steps: [step], findings: [] }, step);
      };
      // An app's plan never removes another app's instance.
      const foreign = sh.run(removal("shop", blogInstance).apply);
      expect(foreign.stderr).toBe(
        `opscrew: The uptime report ${blogInstance} on this server is not "shop"'s, so OpsCrew does not remove it. Nothing was changed.\n`,
      );
      expect(sh.exists(`${UPTIME_REPORT_CONFIG_DIR}/${blogInstance}.conf`)).toBe(true);

      const shop = removal("shop", INSTANCE, "teardown");
      expect(sh.run(shop.check).stdout).toContain("state=change");
      expect(sh.run(shop.apply).status).toBe(0);
      expect(sh.exists(CONFIG) || sh.exists(KEY_FILE)).toBe(false);
      expect(sh.exists(`/var/lib/opscrew-uptime-report/${INSTANCE}`)).toBe(false);
      expect(sh.calls()).toContain(
        `systemctl disable --now --quiet opscrew-uptime-report@${INSTANCE}.timer`,
      );
      expect(sh.exists(UPTIME_REPORT_SCRIPT)).toBe(true);
      expect(sh.run(shop.verify).status).toBe(0);

      const last = removal("", blogInstance, "undo");
      expect(sh.run(last.apply).status).toBe(0);
      for (const path of [
        UPTIME_REPORT_SCRIPT,
        UPTIME_REPORT_SERVICE_UNIT,
        UPTIME_REPORT_TIMER_UNIT,
        UPTIME_REPORT_CONFIG_DIR,
      ]) {
        expect(sh.exists(path), path).toBe(false);
      }
      expect(sh.exists("/usr/local/lib/opscrew")).toBe(false);
      expect(sh.run(last.verify).status).toBe(0);
      expect(sh.run(last.check).stdout).toContain("state=in-place");
    } finally {
      sh.dispose();
    }
  });

  it("reads the inspection's lines, and leaves out what is in another form", () => {
    const sha = "a".repeat(64);
    expect(
      parseUptimeReport(
        [
          `script 755 root ${sha}`,
          "service 644 root short",
          "dir 700 root",
          "version 3",
          "tool openssl",
          `config ${INSTANCE} 600 root ${sha}`,
          `app ${INSTANCE} shop`,
          `unit ${INSTANCE} enabled inactive`,
          `key 0123456789abcdef 600 root ${sha}`,
          "config ../../etc 600 root x",
        ].join("\n"),
      ),
    ).toEqual({
      version: 3,
      script: { mode: "755", owner: "root", sha256: sha },
      service: null,
      timer: null,
      dir: { mode: "700", owner: "root" },
      tools: { curl: false, openssl: true },
      instances: [
        {
          instance: INSTANCE,
          app: "shop",
          config: { mode: "600", owner: "root", sha256: sha },
          key: null,
          timer: { enabled: true, active: false },
        },
      ],
    });
  });
});
