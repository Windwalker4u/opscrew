import { canonicalJson, OpsCrewError, sha256Hex } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import { FakeHost } from "./__fixtures__/fake-host";
import {
  applyApproved,
  desiredFor,
  everythingButStdin,
  hostRecord,
  ownServer,
  planFor,
  rejection,
  removeApp,
  SH_AVAILABLE,
  SHOP_PROJECT,
  shSyntax,
  TUNNEL_COMPOSE,
  TUNNEL_ID,
} from "./__fixtures__/helpers";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import {
  DNS_UPDATER_ENDPOINTS,
  DNS_UPDATER_RECORD_COMMENT,
  DNS_UPDATER_SCRIPT,
  DNS_UPDATER_SERVICE_TEXT,
  DNS_UPDATER_SERVICE_UNIT,
  DNS_UPDATER_TIMER_TEXT,
  DNS_UPDATER_TIMER_UNIT,
  dnsUpdaterConfig,
  dnsUpdaterConfigText,
  dnsUpdaterStep,
  renderDnsUpdaterScript,
} from "./dns-updater";
import { inspectHost } from "./inspect";
import { planHost, planTeardown, planUndo } from "./plan";
import { stepScripts } from "./steps";
import type { DesiredDnsUpdater, DesiredHost, HostPlan, HostStep } from "./types";

const ZONE = "0123456789abcdef0123456789abcdef";
const UPDATER: DesiredDnsUpdater = {
  zoneId: ZONE,
  name: "shop.example.com",
  proxied: true,
  ipv4: true,
  ipv6: false,
};
const TOKEN = fakeSecret("cloudflare-token");
const TOKEN_SHA256 = sha256Hex(TOKEN);
const CONFIG = "/etc/opscrew/dns-updater/shop.json";
const TOKEN_FILE = "/etc/opscrew/dns-updater/shop.token";

function homeDesired(fake: FakeHost, updater: DesiredDnsUpdater = UPDATER, app = "shop") {
  return desiredFor(fake, {
    dnsUpdater: updater,
    ...(app === "shop" ? {} : { app, projectId: `${app}-1`, hostnames: [`${app}.example.com`] }),
  });
}

function updaterOf(plan: HostPlan): HostStep {
  const step = plan.steps.find((item) => item.id === "dns-updater");
  if (step === undefined) throw new Error("no dns-updater step");
  return step;
}

/** A server with "shop" set up and its updater installed with the token. */
async function homeServer(): Promise<FakeHost> {
  const fake = await ownServer();
  const plan = await planFor(fake, homeDesired(fake, { ...UPDATER, tokenSha256: TOKEN_SHA256 }));
  await applyApproved(fake, plan, { secrets: { dnsUpdaterToken: TOKEN } });
  return fake;
}

describe("the address updater's files", () => {
  it("renders the script with its version on line 2 and its endpoints and comment as constants", () => {
    const script = renderDnsUpdaterScript();
    const lines = script.split("\n");
    expect(lines.slice(0, 2)).toEqual(["#!/bin/sh", "# opscrew-dns-updater version 1"]);
    expect(lines).toContain(`API='${DNS_UPDATER_ENDPOINTS.api}'`);
    expect(lines).toContain(`TRACE='${DNS_UPDATER_ENDPOINTS.trace}'`);
    expect(lines).toContain(`CHECKIP='${DNS_UPDATER_ENDPOINTS.checkip}'`);
    expect(lines).toContain(`COMMENT='${DNS_UPDATER_RECORD_COMMENT}'`);
    expect(DNS_UPDATER_RECORD_COMMENT).toBe("Managed by OpsCrew (address updater)");
    // Other endpoints (the Docker-gated test's) change those three lines only.
    const other = renderDnsUpdaterScript({
      endpoints: {
        api: "http://127.0.0.1:8080/client/v4",
        trace: "http://127.0.0.1:8080/cdn-cgi/trace",
        checkip: "http://127.0.0.1:8080/checkip",
      },
    }).split("\n");
    expect(lines.filter((line, i) => other[i] !== line)).toEqual([
      `API='${DNS_UPDATER_ENDPOINTS.api}'`,
      `TRACE='${DNS_UPDATER_ENDPOINTS.trace}'`,
      `CHECKIP='${DNS_UPDATER_ENDPOINTS.checkip}'`,
    ]);
  });

  it("gives curl the token on standard input only, and never runs curl without -K - for Cloudflare", () => {
    const script = renderDnsUpdaterScript();
    const bearer = script.split("\n").filter((line) => line.includes("Bearer"));
    expect(bearer).toEqual([`    printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN_Q"`]);
    const curls = script.split("\n").filter((line) => /\bcurl -/.test(line));
    expect(curls.filter((line) => line.includes("$API"))).toEqual([]);
    expect(
      curls.filter((line) => !/curl -4 -fsS --max-time 10 "\$(TRACE|CHECKIP)"/.test(line)),
    ).toEqual(["  } | curl -sS --max-time 15 -K - -w '\\n%{http_code}' 2>/dev/null) || out=''"]);
  });

  it.skipIf(!SH_AVAILABLE)("is valid sh", () => {
    expect(shSyntax(renderDnsUpdaterScript())?.ok).toBe(true);
  });

  it("has the units and the config as the contract", () => {
    expect(DNS_UPDATER_SERVICE_TEXT).toMatchSnapshot("service");
    expect(DNS_UPDATER_TIMER_TEXT).toMatchSnapshot("timer");
    for (const line of [
      "Type=oneshot",
      "DynamicUser=yes",
      "LoadCredential=config:/etc/opscrew/dns-updater/%i.json",
      "LoadCredential=token:/etc/opscrew/dns-updater/%i.token",
      "StateDirectory=opscrew-dns-updater/%i",
      `ExecStart=${DNS_UPDATER_SCRIPT}`,
      "CapabilityBoundingSet=",
      "NoNewPrivileges=yes",
    ]) {
      expect(DNS_UPDATER_SERVICE_TEXT.split("\n")).toContain(line);
    }
    expect(DNS_UPDATER_TIMER_TEXT).toContain("OnUnitActiveSec=2min\n");
    expect(dnsUpdaterConfigText(dnsUpdaterConfig("shop", UPDATER))).toBe(`{
  "schemaVersion": 1,
  "app": "shop",
  "zoneId": "${ZONE}",
  "name": "shop.example.com",
  "proxied": true,
  "ipv4": true,
  "ipv6": false
}
`);
  });
});

describe("the dns-updater step", () => {
  it("installs the updater after the app's record, with the token on standard input only", async () => {
    const fake = await ownServer();
    const desired = homeDesired(fake, { ...UPDATER, tokenSha256: TOKEN_SHA256 });
    const plan = await planFor(fake, desired);
    const step = updaterOf(plan);
    expect(step).toMatchObject({
      state: "change",
      scope: "app",
      params: {
        app: "shop",
        zoneId: ZONE,
        name: "shop.example.com",
        proxied: true,
        ipv4: true,
        ipv6: false,
        version: 1,
        packages: "jq",
        tokenSha256: TOKEN_SHA256,
      },
    });
    const ids = plan.steps.map((item) => item.id);
    expect(ids.indexOf("dns-updater")).toBe(ids.indexOf("app-record") + 1);
    expect(step.title).toContain("every 2 minutes");
    expect(step.title).toContain("the A record of shop.example.com");
    for (const text of [
      "this server's own address only",
      "behind Cloudflare's proxy",
      DNS_UPDATER_RECORD_COMMENT,
      "the token can change any record in its zone",
      "Anything with root on your server can use it, the deploy runner included",
    ]) {
      expect(step.reason).toContain(text);
    }

    await applyApproved(fake, plan, { secrets: { dnsUpdaterToken: TOKEN } });
    expect(fake.files.get(TOKEN_FILE)).toBe(TOKEN);
    expect(fake.files.get(DNS_UPDATER_SCRIPT)).toBe(renderDnsUpdaterScript());
    expect(fake.files.get(DNS_UPDATER_SERVICE_UNIT)).toBe(DNS_UPDATER_SERVICE_TEXT);
    expect(fake.files.get(DNS_UPDATER_TIMER_UNIT)).toBe(DNS_UPDATER_TIMER_TEXT);
    expect(fake.files.get(CONFIG)).toBe(dnsUpdaterConfigText(dnsUpdaterConfig("shop", UPDATER)));
    expect(fake.packages.has("jq")).toBe(true);
    // The token reached only the apply's standard input: never a command, the plan or the record.
    expect(everythingButStdin(fake, plan)).not.toContain(TOKEN);
    expect(
      fake.calls.filter((call) => call.input?.includes(TOKEN)).map((call) => call.name),
    ).toEqual(["dns-updater.apply"]);
    expect(JSON.stringify(hostRecord(fake))).not.toContain(TOKEN_SHA256);
    expect(hostRecord(fake).changes.find((entry) => entry.step === "dns-updater")).toMatchObject({
      purpose: "setup",
      previous: { installed: false, instance: false },
    });
  });

  it("is in place on an unchanged server, and a change when it is proxied or keeps IPv6", async () => {
    const fake = await homeServer();
    expect(
      updaterOf(await planFor(fake, homeDesired(fake, { ...UPDATER, tokenSha256: TOKEN_SHA256 })))
        .state,
    ).toBe("in-place");
    // Without the token, the server's file is kept.
    const kept = updaterOf(await planFor(fake, homeDesired(fake)));
    expect(kept.state).toBe("in-place");
    expect(kept.params).not.toHaveProperty("tokenSha256");
    expect(
      updaterOf(await planFor(fake, homeDesired(fake, { ...UPDATER, proxied: false }))).state,
    ).toBe("change");
    expect(
      updaterOf(await planFor(fake, homeDesired(fake, { ...UPDATER, ipv6: true }))).state,
    ).toBe("change");
    // Another token is a change too.
    const other = sha256Hex(fakeSecret("cloudflare-token", "rotated"));
    expect(
      updaterOf(await planFor(fake, homeDesired(fake, { ...UPDATER, tokenSha256: other }))).state,
    ).toBe("change");
  });

  it("is a change when a file's mode or the timer differs, and the apply puts them back", async () => {
    const fake = await homeServer();
    fake.updaterModes.set(TOKEN_FILE, "644 root");
    const plan = await planFor(fake, homeDesired(fake));
    expect(updaterOf(plan).state).toBe("change");
    // Without the token on stdin, the file there stays: nothing secret is sent.
    await applyApproved(fake, plan);
    const applies = fake.calls.filter((call) => call.name === "dns-updater.apply");
    expect(applies).toHaveLength(2);
    expect(applies.at(-1)?.input).toBeUndefined();
    expect(fake.files.get(TOKEN_FILE)).toBe(TOKEN);
    expect(updaterOf(await planFor(fake, homeDesired(fake))).state).toBe("in-place");

    fake.dnsUpdaterTimers.clear();
    expect(updaterOf(await planFor(fake, homeDesired(fake))).state).toBe("change");
  });

  it("is blocked without a token on the server or given", async () => {
    const fake = await ownServer();
    const plan = await planFor(fake, homeDesired(fake));
    expect(updaterOf(plan)).toMatchObject({ state: "blocked" });
    expect(updaterOf(plan).reason).toContain("OPSCREW_DNS_UPDATER_TOKEN");
    expect(plan.findings).toEqual([
      {
        code: "dns-updater-token-missing",
        message: 'The address updater of "shop" has no token on this server, and none was given.',
        hint: "Set OPSCREW_DNS_UPDATER_TOKEN (the guide's recipe) and run opscrew provision again.",
      },
    ]);
    const error = await rejection(applyApproved(fake, plan));
    expect(error.code).toBe("PHASE_PRECONDITION");
  });

  it("keeps a newer script and units on the server", async () => {
    const fake = await homeServer();
    const newer = renderDnsUpdaterScript().replace(
      "# opscrew-dns-updater version 1\n",
      "# opscrew-dns-updater version 2\n",
    );
    fake.files.set(DNS_UPDATER_SCRIPT, newer);
    fake.files.set(DNS_UPDATER_SERVICE_UNIT, "a newer unit\n");
    expect(updaterOf(await planFor(fake, homeDesired(fake))).state).toBe("in-place");
    const plan = await planFor(fake, homeDesired(fake, { ...UPDATER, proxied: false }));
    expect(updaterOf(plan).state).toBe("change");
    await applyApproved(fake, plan);
    expect(fake.files.get(DNS_UPDATER_SCRIPT)).toBe(newer);
    expect(fake.files.get(DNS_UPDATER_SERVICE_UNIT)).toBe("a newer unit\n");
    expect(JSON.parse(fake.files.get(CONFIG) ?? "{}")).toMatchObject({ proxied: false });
  });

  it("refuses a token that is not the plan's, and fails when the first run fails", async () => {
    const fake = await ownServer();
    const plan = await planFor(fake, homeDesired(fake, { ...UPDATER, tokenSha256: TOKEN_SHA256 }));
    const other = fakeSecret("cloudflare-token", "other");
    const error = await rejection(
      applyApproved(fake, plan, { secrets: { dnsUpdaterToken: other } }),
    );
    expect(error.message).toContain("is not the one the plan names, so it was not written");
    expect(error.message).not.toContain(other);
    expect(fake.files.has(TOKEN_FILE)).toBe(false);

    // Without the token the plan needs, nothing is sent at all.
    const missing = await rejection(applyApproved(fake, plan));
    expect(missing.message).toContain("the address updater's Cloudflare token");

    fake.dnsUpdaterRunError = "token-refused";
    const failed = await rejection(
      applyApproved(fake, plan, { secrets: { dnsUpdaterToken: TOKEN } }),
    );
    expect(failed.message).toContain("token-refused");
  });

  it("checks its parameters and the token's shape before anything is sent", async () => {
    const fake = await ownServer();
    const plan = await planFor(fake, homeDesired(fake, { ...UPDATER, tokenSha256: TOKEN_SHA256 }));
    const step = updaterOf(plan);
    const bad = (params: HostStep["params"], app = "shop") =>
      stepScripts({ ...plan, app }, { ...step, params });
    expect(() => bad({ ...step.params, version: 2 })).toThrow(OpsCrewError);
    expect(() => bad({ ...step.params, ipv4: false })).toThrow(/must keep an A or an AAAA/);
    expect(() => bad(step.params, "blog")).toThrow(/invalid parameters \(app\)/);
    const error = await rejection(
      applyApproved(fake, plan, { secrets: { dnsUpdaterToken: "short token" } }),
    );
    expect(error.message).toBe(
      "The address updater's token must be 40 to 255 printable characters without spaces.",
    );
    expect(fake.calls.some((call) => call.name === "dns-updater.apply")).toBe(false);
    const tunnel: DesiredHost = {
      ...homeDesired(fake),
      access: "tunnel",
      tunnel: { compose: TUNNEL_COMPOSE, tunnelId: TUNNEL_ID },
    };
    const facts = await inspectHost(fake);
    expect(() => planHost(facts, tunnel, "opscrew provision")).toThrow(
      /the address updater is only for a site served directly/,
    );
  });

  it("is planned from older facts without the updater's as a change", async () => {
    const fake = await ownServer();
    const { dnsUpdaters: _d, dnsUpdaterFiles: _f, ...older } = await inspectHost(fake);
    const planned = dnsUpdaterStep(older, "shop", { ...UPDATER, tokenSha256: TOKEN_SHA256 }, "x");
    expect(planned?.step.state).toBe("change");
  });
});

describe("removing the address updater", () => {
  it("removes the app's instance in a teardown, and the script and units with the last one", async () => {
    const fake = await homeServer();
    const blog = homeDesired(fake, { ...UPDATER, name: "blog.example.com" }, "blog");
    const blogPlan = await planFor(fake, {
      ...blog,
      dnsUpdater: { ...UPDATER, name: "blog.example.com", tokenSha256: TOKEN_SHA256 },
      deploy: {
        user: "deploy",
        publicKey: blog.deploy.publicKey.replace("opscrew-deploy", "blog"),
      },
    });
    await applyApproved(fake, blogPlan, { secrets: { dnsUpdaterToken: TOKEN } });
    expect(fake.files.has("/etc/opscrew/dns-updater/blog.json")).toBe(true);

    const facts = await inspectHost(fake);
    const teardown = planTeardown(
      facts,
      { deleteData: true, app: "shop", projectId: SHOP_PROJECT },
      "opscrew destroy",
    );
    expect(updaterOf(teardown)).toMatchObject({
      state: "change",
      scope: "app",
      params: { remove: true, apps: "shop", shared: false },
    });
    await removeApp(fake, "shop");
    expect(fake.files.has(CONFIG)).toBe(false);
    expect(fake.files.has(TOKEN_FILE)).toBe(false);
    expect(fake.dnsUpdaterTimers.has("shop")).toBe(false);
    expect(fake.files.has(DNS_UPDATER_SCRIPT)).toBe(true);
    expect(fake.files.has("/etc/opscrew/dns-updater/blog.token")).toBe(true);

    const last = planTeardown(
      await inspectHost(fake),
      { deleteData: true, app: "blog", projectId: "blog-1" },
      "opscrew destroy",
    );
    expect(updaterOf(last).params).toEqual({ remove: true, apps: "blog", shared: true });
    expect(updaterOf(last).title).toBe(
      'Remove the address updater of "blog" and the updater\'s script and units',
    );
    await removeApp(fake, "blog");
    for (const path of [DNS_UPDATER_SCRIPT, DNS_UPDATER_SERVICE_UNIT, DNS_UPDATER_TIMER_UNIT]) {
      expect(fake.files.has(path)).toBe(false);
    }
    expect(fake.madeDirs.has("/etc/opscrew/dns-updater")).toBe(false);
    // Nothing is left for an undo to remove.
    expect(
      planUndo(await inspectHost(fake), {}, "opscrew destroy --undo-host").steps.map((s) => s.id),
    ).not.toContain("dns-updater");
  });

  it("removes the app's instance from a setup that no longer has it", async () => {
    const fake = await homeServer();
    const plan = await planFor(fake, desiredFor(fake));
    expect(updaterOf(plan).params).toEqual({ remove: true, apps: "shop", shared: true });
    await applyApproved(fake, plan);
    expect(fake.files.has(DNS_UPDATER_SCRIPT)).toBe(false);
    expect(fake.files.has(TOKEN_FILE)).toBe(false);
  });

  it("removes what was left in an undo, the instances and the shared files", async () => {
    const fake = new FakeHost();
    fake.files.set(DNS_UPDATER_SCRIPT, renderDnsUpdaterScript());
    fake.files.set("/etc/opscrew/dns-updater/old.json", "{}");
    fake.files.set(
      "/etc/opscrew/host.json",
      JSON.stringify({ schemaVersion: 1, apps: [], opscrewVersion: "0.2.10", changes: [] }),
    );
    const undo = planUndo(await inspectHost(fake), {}, "opscrew destroy --undo-host");
    expect(updaterOf(undo)).toMatchObject({
      scope: "shared",
      params: { remove: true, apps: "old", shared: true },
    });
    const ids = undo.steps.map((item) => item.id);
    expect(ids.indexOf("dns-updater")).toBeLessThan(ids.lastIndexOf("app-record"));
    expect(canonicalJson(undo)).not.toContain(TOKEN);
  });
});

/** The step's scripts for "shop", from a plan of the given step params. */
function scriptsOf(
  params: HostStep["params"],
  purpose: HostPlan["purpose"] = "setup",
  app = "shop",
) {
  const step: HostStep = { id: "dns-updater", title: "t", state: "change", scope: "app", params };
  return stepScripts({ schemaVersion: 1, purpose, app, steps: [step], findings: [] }, step);
}

const SETUP_PARAMS = {
  app: "shop",
  zoneId: ZONE,
  name: "shop.example.com",
  proxied: true,
  ipv4: true,
  ipv6: false,
  version: 1,
  packages: "",
};

/**
 * A shell harness with the commands the step's scripts call stubbed: systemctl (timers enabled as
 * files in $S; a restart is the updater's run, which writes `$S/run` as the state), `stat` (each
 * file with the mode OpsCrew writes, `-c %Y` the real one), jq (only what the verify reads), and
 * curl, jq and ip present.
 */
function stepHarness(): ShellHarness {
  const sh = new ShellHarness();
  const state = sh.posix("/var/lib/opscrew-dns-updater/shop/state.json");
  sh.stub(
    "systemctl",
    `case "$1" in
  --version) echo 'systemd 252 (252.30-1~deb12u2)' ;;
  enable) for a do case "$a" in *.timer) touch "$S/enabled-$a" ;; esac; done ;;
  disable) for a do case "$a" in *.timer) rm -f "$S/enabled-$a" ;; esac; done ;;
  is-enabled) if [ -e "$S/enabled-$2" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  is-active) [ -e "$S/enabled-$3" ] ;;
  restart) mkdir -p "$(dirname '${state}')"; sed "s/@NOW@/$(date -u +%Y-%m-%dT%H:%M:%SZ)/g" "$S/run" > '${state}' ;;
esac`,
  );
  sh.stub(
    "stat",
    `if [ "$2" = %Y ]; then exec /usr/bin/stat -c %Y "$3"; fi
case "$3" in
  */opscrew-dns-updater) echo '755 root' ;;
  */dns-updater) echo '700 root' ;;
  *.json | *.token) echo "$(cat "$S/mode" 2>/dev/null || echo 600) root" ;;
  *) echo '644 root' ;;
esac`,
    { log: false },
  );
  sh.stub(
    "jq",
    `case "$2" in
  *lastSuccess*) at=$(sed -n 's/.*"lastSuccess":"\\([^"]*\\)".*/\\1/p' "$3"); [ -z "$at" ] || date -u -d "$at" +%s ;;
  *lastError.code*) sed -n 's/.*"code":"\\([^"]*\\)".*/\\1/p' "$3" ;;
  *lastError.http*) sed -n 's/.*"http":\\([0-9]*\\).*/\\1/p' "$3" ;;
esac`,
    { log: false },
  );
  for (const name of ["curl", "ip", "chmod", "apt-get"]) sh.stub(name, "exit 0");
  sh.write("/state/run", '{"schemaVersion":1,"lastRun":"@NOW@","lastSuccess":"@NOW@"}');
  return sh;
}

describe.skipIf(!BASH_AVAILABLE)("the step's scripts in a real shell (commands stubbed)", () => {
  it("writes the files and the token, then is in place and verified, the token on stdin only", () => {
    const sh = stepHarness();
    try {
      const scripts = scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 });
      expect(sh.run(scripts.check).stdout).toBe(
        "prev.installed=false\nprev.instance=false\nstate=change\n",
      );
      const apply = sh.run(scripts.apply, `${TOKEN}\n`);
      expect(apply.stderr).toBe("");
      expect(apply.status).toBe(0);
      expect(sh.read(DNS_UPDATER_SCRIPT)).toBe(renderDnsUpdaterScript());
      expect(sh.read(DNS_UPDATER_SERVICE_UNIT)).toBe(DNS_UPDATER_SERVICE_TEXT);
      expect(sh.read(DNS_UPDATER_TIMER_UNIT)).toBe(DNS_UPDATER_TIMER_TEXT);
      expect(sh.read(CONFIG)).toBe(dnsUpdaterConfigText(dnsUpdaterConfig("shop", UPDATER)));
      expect(sh.read(TOKEN_FILE)).toBe(TOKEN);
      expect(sh.calls()).toEqual(
        expect.arrayContaining([
          "systemctl enable --now --quiet opscrew-dns-updater@shop.timer",
          "systemctl restart opscrew-dns-updater@shop.service",
        ]),
      );
      expect(sh.calls().join("\n")).not.toContain(TOKEN);
      expect(sh.run(scripts.check).stdout).toContain("state=in-place");
      expect(sh.run(scripts.verify).status).toBe(0);
      // Without the token, the file there is enough.
      expect(sh.run(scriptsOf(SETUP_PARAMS).check).stdout).toContain("state=in-place");
    } finally {
      sh.dispose();
    }
  });

  it("refuses another token, or none without one on the server, before anything is written", () => {
    const sh = stepHarness();
    try {
      const scripts = scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 });
      const other = sh.run(scripts.apply, `${fakeSecret("cloudflare-token", "other")}\n`);
      expect(other.status).not.toBe(0);
      expect(other.stderr).toContain(
        "is not the one the plan names, so it was not written. Nothing was changed.",
      );
      const none = sh.run(scriptsOf(SETUP_PARAMS).apply);
      expect(none.stderr).toContain("the server has none for shop");
      expect(sh.exists(DNS_UPDATER_SCRIPT) || sh.exists(CONFIG) || sh.exists(TOKEN_FILE)).toBe(
        false,
      );
    } finally {
      sh.dispose();
    }
  });

  it("refuses a systemd older than 247", () => {
    const sh = stepHarness();
    try {
      sh.stub("systemctl", `[ "$1" = --version ] && echo 'systemd 245 (245.4-4ubuntu3)'`);
      const apply = sh.run(
        scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 }).apply,
        `${TOKEN}\n`,
      );
      expect(apply.stderr).toContain(
        "needs systemd 247 or newer (for LoadCredential=), and this server has 245",
      );
      expect(sh.exists(TOKEN_FILE)).toBe(false);
    } finally {
      sh.dispose();
    }
  });

  it("keeps a newer script and units, and still writes the instance", () => {
    const sh = stepHarness();
    try {
      const newer = "#!/bin/sh\n# opscrew-dns-updater version 2\n";
      sh.write(DNS_UPDATER_SCRIPT, newer);
      sh.write(DNS_UPDATER_SERVICE_UNIT, "newer\n");
      sh.write(DNS_UPDATER_TIMER_UNIT, "newer\n");
      const scripts = scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 });
      expect(sh.run(scripts.apply, `${TOKEN}\n`).status).toBe(0);
      expect(sh.read(DNS_UPDATER_SCRIPT)).toBe(newer);
      expect(sh.read(DNS_UPDATER_SERVICE_UNIT)).toBe("newer\n");
      expect(sh.read(CONFIG)).toBeDefined();
      expect(sh.run(scripts.check).stdout).toContain("state=in-place");
    } finally {
      sh.dispose();
    }
  });

  it("is a change when the token file's mode differs", () => {
    const sh = stepHarness();
    try {
      const scripts = scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 });
      sh.run(scripts.apply, `${TOKEN}\n`);
      sh.write("/state/mode", "644");
      expect(sh.run(scripts.check).stdout).toContain("state=change");
    } finally {
      sh.dispose();
    }
  });

  it("fails its verify with what the first run's error means and what to do", () => {
    const sh = stepHarness();
    try {
      sh.write(
        "/state/run",
        '{"schemaVersion":1,"lastRun":"@NOW@","lastError":{"at":"@NOW@","code":"token-refused","http":403,"cloudflare":[10000]}}',
      );
      const scripts = scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 });
      expect(sh.run(scripts.apply, `${TOKEN}\n`).status).toBe(0);
      const verify = sh.run(scripts.verify);
      expect(verify.status).toBe(5);
      expect(verify.stderr).toBe(
        "opscrew: The address updater's first run failed: Cloudflare refused its token (HTTP 403): the token can't change the DNS of shop.example.com. Give it Zone → DNS → Edit on that zone, set OPSCREW_DNS_UPDATER_TOKEN to it, then run the command again.\n",
      );
      // An earlier success does not count: it was before the config was written.
      sh.write(
        "/var/lib/opscrew-dns-updater/shop/state.json",
        '{"lastSuccess":"2020-01-01T00:00:00Z"}',
      );
      expect(sh.run(scripts.verify).stderr).toContain("did not finish a run within 60 seconds");
    } finally {
      sh.dispose();
    }
  });

  it("removes one instance while another stays, then the shared files with the last", () => {
    const sh = stepHarness();
    try {
      sh.run(scriptsOf({ ...SETUP_PARAMS, tokenSha256: TOKEN_SHA256 }).apply, `${TOKEN}\n`);
      sh.write("/etc/opscrew/dns-updater/blog.json", "{}");
      sh.write("/etc/opscrew/dns-updater/blog.token", "x");
      const shop = scriptsOf({ remove: true, apps: "shop", shared: true }, "teardown");
      expect(sh.run(shop.apply).status).toBe(0);
      expect(sh.exists(CONFIG) || sh.exists(TOKEN_FILE)).toBe(false);
      expect(sh.exists("/var/lib/opscrew-dns-updater/shop")).toBe(false);
      expect(sh.exists(DNS_UPDATER_SCRIPT)).toBe(true);
      expect(sh.calls()).toContain(
        "systemctl disable --now --quiet opscrew-dns-updater@shop.timer",
      );
      expect(sh.run(shop.verify).status).toBe(0);

      const undo = scriptsOf({ remove: true, apps: "blog", shared: true }, "undo", "");
      expect(sh.run(undo.check).stdout).toContain("state=change");
      expect(sh.run(undo.apply).status).toBe(0);
      for (const path of [DNS_UPDATER_SCRIPT, DNS_UPDATER_SERVICE_UNIT, DNS_UPDATER_TIMER_UNIT]) {
        expect(sh.exists(path)).toBe(false);
      }
      expect(sh.exists("/etc/opscrew/dns-updater")).toBe(false);
      expect(sh.run(undo.verify).status).toBe(0);
      // A teardown plan removes only its own app's instance.
      expect(() => scriptsOf({ remove: true, apps: "blog", shared: true }, "teardown")).toThrow(
        /invalid parameters \(apps\)/,
      );
    } finally {
      sh.dispose();
    }
  });
});
