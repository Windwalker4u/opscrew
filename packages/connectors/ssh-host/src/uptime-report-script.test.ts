/**
 * The uptime report's script itself, run in a real shell with the test machine's tools: `df`
 * prints a fixture, `openssl` answers for the hostnames each case gives a certificate, and `curl`
 * keeps each report it is handed and answers with the case's status. The app's folder is a fixture
 * tree. The same trees, read through `CHECK_KEY_COMMAND` and the scheduled check's rules, fail and
 * pass alike.
 */
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BASH_AVAILABLE, ShellHarness } from "./__fixtures__/shell-harness";
import { CHECK_KEY_COMMAND } from "./constants";
import type { DesiredUptimeReport } from "./types";
import {
  renderUptimeReportScript,
  UPTIME_REPORT_READ,
  UPTIME_REPORT_USER_AGENT,
  uptimeReportConfigText,
} from "./uptime-report";

const TOOLS = ["sha256sum", "timeout", "awk", "stat", "flock", "date"];
const missing = BASH_AVAILABLE
  ? TOOLS.filter(
      (tool) => tool !== "flock" && spawnSync("sh", ["-c", `command -v ${tool}`]).status !== 0,
    )
  : [];
const reason = !BASH_AVAILABLE
  ? "no POSIX shell"
  : missing.length > 0
    ? `${missing.join(", ")} not installed`
    : spawnSync("sh", ["-c", "date -u -d '2026-11-25T10:00:00Z' +%s"], {
          encoding: "utf8",
        }).stdout.trim() !== String(Date.parse("2026-11-25T10:00:00Z") / 1000)
      ? "date is not GNU date"
      : undefined;
if (reason) console.warn(`[connector-ssh-host] skipping the uptime report's script: ${reason}`);

const DAY = 86_400;
const KEY = randomBytes(32).toString("hex");
const APP_DIR = "/srv/apps/shop";
/** Two hostnames, for the cases that read certificates (each costs the test a few processes). */
const HOSTS = ["shop.example.com", "www.shop.example.com"];
const REPORT: DesiredUptimeReport = {
  url: "https://opscrew-uptime.acme.workers.dev/report",
  entry: "acme/shop/shop/prod",
  server: "hetzner-shop",
  hosts: [],
  thresholds: { diskWarn: 85, diskHigh: 95, certDays: 14 },
  keySha256: "0".repeat(64),
};

const nowSeconds = () => Math.floor(Date.now() / 1000);
const iso = (seconds: number) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
/** A time as `openssl x509 -enddate` prints it: `Dec  9 10:00:00 2026 GMT`. */
function opensslTime(seconds: number): string {
  const d = new Date(seconds * 1000);
  const time = d.toISOString().slice(11, 19);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${time} ${d.getUTCFullYear()} GMT`;
}

/** `df -P -B1 /`: `used` and `free` in GB, the total a little more (reserved blocks). */
function df(used: number, free: number): string {
  const gb = 1_000_000_000;
  const total = (used + free + 2) * gb;
  return `Filesystem       1-blocks         Used    Available Capacity Mounted on\n/dev/sda1    ${total} ${used * gb} ${free * gb}      ${Math.round((used * 100) / (used + free + 2))}% /\n`;
}

/** openssl: `s_client` answers for a hostname with a certificate file, `x509` prints its end. */
const OPENSSL = `case "$1" in
  s_client)
    host='' prev=''
    for a do
      if [ "$prev" = -servername ]; then host=$a; fi
      prev=$a
    done
    if [ -e "$S/cert-$host" ]; then printf 'CONNECTED(00000003)\\n-----BEGIN CERTIFICATE-----\\nFAKE %s\\n-----END CERTIFICATE-----\\n' "$host"; else exit 1; fi
    ;;
  x509)
    host=$(sed -n 's/^FAKE //p')
    [ -n "$host" ] || exit 1
    echo "notAfter=$(cat "$S/cert-$host")"
    ;;
  *) exit 2 ;;
esac`;

/** curl: keeps the report on its stdin and its arguments, then answers with the case's status. */
const CURL = `mkdir -p "$S/sent"
n=$(ls "$S/sent" | grep -c '[.]body$' || true)
cat > "$S/sent/$n.body"
for a do printf '%s\\n' "$a"; done > "$S/sent/$n.args"
if [ -e "$S/unreachable" ]; then printf 000; exit 7; fi
if [ -e "$S/answer" ]; then cat "$S/answer"; else printf 204; fi`;

interface Sent {
  url: string;
  headers: Record<string, string>;
  agent: string | undefined;
  raw: string;
  body: Record<string, unknown>;
  args: string[];
}

interface Run {
  status: number | null;
  journal: string;
  stderr: string;
  state: string | undefined;
  sent: Sent[];
  calls: string[];
}

/** A server with the fixtures every case starts from: a disk at 40%, each hostname's certificate 40 days from its end. */
function server(report: Partial<DesiredUptimeReport> = {}, key = KEY): ShellHarness {
  const sh = new ShellHarness();
  sh.stub("df", `if [ -e "$S/df" ]; then cat "$S/df"; else exit 1; fi`);
  sh.stub("openssl", OPENSSL);
  sh.stub("curl", CURL);
  mkdirSync(sh.native("/statedir"));
  config(sh, report);
  sh.write("/creds/key", key);
  sh.write("/state/df", df(40, 60));
  for (const host of report.hosts ?? []) cert(sh, host, 40);
  return sh;
}

function config(sh: ShellHarness, report: Partial<DesiredUptimeReport>): void {
  sh.write("/creds/config", uptimeReportConfigText("shop", { ...REPORT, ...report }));
}

/** The certificate `host` serves: `days` days left (and an hour), or none (`null`). */
function cert(sh: ShellHarness, host: string, days: number | null): void {
  if (days === null) {
    rmSync(sh.native(`/state/cert-${host}`), { recursive: true, force: true });
    return;
  }
  sh.write(`/state/cert-${host}`, opensslTime(nowSeconds() + days * DAY + 3600));
}

/** Runs the script once, as its service would: the credentials and the state folder set. */
function runReport(sh: ShellHarness): Run {
  rmSync(sh.native("/state/sent"), { recursive: true, force: true });
  sh.clearCalls();
  const result = sh.run(`PATH='${sh.root}/bin:/usr/bin:/bin'
CREDENTIALS_DIRECTORY='${sh.posix("/creds")}'
STATE_DIRECTORY='${sh.posix("/statedir")}'
export PATH CREDENTIALS_DIRECTORY STATE_DIRECTORY
${renderUptimeReportScript()}`);
  const dir = sh.native("/state/sent");
  const count = (() => {
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".body")).length;
    } catch {
      return 0;
    }
  })();
  const sent = Array.from({ length: count }, (_, n) => {
    const raw = sh.read(`/state/sent/${n}.body`) ?? "";
    const args = (sh.read(`/state/sent/${n}.args`) ?? "").split("\n").slice(0, -1);
    const headers: Record<string, string> = {};
    let agent: string | undefined;
    args.forEach((arg, i) => {
      const value = args[i + 1] ?? "";
      if (arg === "-H") {
        const at = value.indexOf(": ");
        headers[value.slice(0, at)] = value.slice(at + 2);
      }
      if (arg === "-A") agent = value;
    });
    return { url: args.at(-1) ?? "", headers, agent, raw, body: JSON.parse(raw), args };
  });
  return {
    status: result.status,
    journal: result.stdout,
    stderr: result.stderr,
    state: sh.read("/statedir/state"),
    sent,
    calls: sh.calls(),
  };
}

/** Runs `fn` with a fresh server, disposed afterwards. */
function on(report: Partial<DesiredUptimeReport>, fn: (sh: ShellHarness) => void): void {
  const sh = server(report);
  try {
    fn(sh);
  } finally {
    sh.dispose();
  }
}

/** The only report a run sent. */
function only(run: Run): Sent {
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  expect(run.sent).toHaveLength(1);
  return run.sent[0] as Sent;
}

/** The app's scheduled snapshot log. */
function snapshotLog(sh: ShellHarness, lines: readonly string[]): void {
  sh.write(`${APP_DIR}/.snapshots/scheduled.log`, `${lines.join("\n")}\n`);
}

/** A drills log whose last scheduled drill ended at `end` with `result`. */
function drillLog(sh: ShellHarness, end: number, result: string): void {
  sh.write(
    `${APP_DIR}/.snapshots/drills.log`,
    `${iso(end)} scheduled ${result} id=20261101T030000Z version=- start=${iso(end - 600)} parts=- health=- tables=- removal=removed cleaned=no reason=-\n`,
  );
}

/** A drill schedule since `since` (its file and the oldest scheduled snapshot that old). */
function drillSchedule(sh: ShellHarness, since: number): void {
  sh.write(`${APP_DIR}/.drill-recipe/schedule`, "weekly\n");
  utimesSync(sh.native(`${APP_DIR}/.drill-recipe/schedule`), since, since);
  mkdirSync(sh.native(`${APP_DIR}/.snapshots/20261101T030000Z`), { recursive: true });
  utimesSync(sh.native(`${APP_DIR}/.snapshots/20261101T030000Z`), since - 10, since - 10);
}

const TAKEN = ["web was left out", "20261125T030000Z"];

describe.skipIf(reason !== undefined)(
  "the uptime report's script (df, openssl and curl stubbed)",
  () => {
    it("reads the disk as the scheduled check does: 84% ok, 85% warn, 95% high, with its figures", () => {
      on({}, (sh) => {
        for (const [used, free, status, percent] of [
          [84, 16, "ok", 84],
          [85, 15, "warn", 85],
          [95, 5, "high", 95],
        ] as const) {
          rmSync(sh.native("/statedir/state"), { recursive: true, force: true });
          sh.write("/state/df", df(used, free));
          const report = only(runReport(sh));
          expect(report.body.disk).toEqual({
            status,
            percent,
            free: free * 1_000_000_000,
            total: (used + free + 2) * 1_000_000_000,
          });
        }
        sh.write("/state/df", "df: /: no such file\n");
        rmSync(sh.native("/statedir/state"), { recursive: true, force: true });
        expect(only(runReport(sh)).body.disk).toEqual({ status: "unknown" });
      });
    });

    it("reads the last scheduled snapshot: ok, copy-failed, failed, unknown while one is taken, none without a log", () => {
      on({}, (sh) => {
        const snapshot = () => {
          rmSync(sh.native("/statedir/state"), { recursive: true, force: true });
          return only(runReport(sh)).body.snapshot;
        };
        expect(snapshot()).toEqual({ status: "none" });
        snapshotLog(sh, TAKEN);
        expect(snapshot()).toEqual({ status: "ok", id: "20261125T030000Z" });
        snapshotLog(sh, [...TAKEN, "upload failed", "exit 1"]);
        expect(snapshot()).toEqual({ status: "copy-failed", id: "20261125T030000Z" });
        snapshotLog(sh, ["web was left out", "failed: disk full"]);
        expect(snapshot()).toEqual({ status: "failed" });
        // A .partial folder while the app's start lock is held: a snapshot is being taken.
        mkdirSync(sh.native(`${APP_DIR}/.snapshots/20261125T040000Z.partial`), { recursive: true });
        expect(snapshot()).toEqual({ status: "failed" });
        sh.stub("flock", "exit 1", { log: false });
        expect(snapshot()).toEqual({ status: "unknown" });
      });
    });

    it("reads the last scheduled restore drill against twice its schedule and an hour", () => {
      const now = nowSeconds();
      on({ drill: "weekly" }, (sh) => {
        const drill = () => {
          rmSync(sh.native("/statedir/state"), { recursive: true, force: true });
          return only(runReport(sh)).body.drill;
        };
        snapshotLog(sh, TAKEN);
        drillLog(sh, now - 3 * DAY, "healthy");
        expect(drill()).toEqual({ status: "ok", result: "healthy", at: iso(now - 3 * DAY) });
        for (const result of ["unhealthy", "not-restored", "failed"]) {
          drillLog(sh, now - DAY, result);
          expect(drill()).toEqual({ status: "failed", result, at: iso(now - DAY) });
        }
        // Late from the last drill: 14 days and an hour, and a minute.
        drillLog(sh, now - 14 * DAY - 3660, "healthy");
        expect(drill()).toMatchObject({ status: "late", result: "healthy" });
        drillLog(sh, now - 14 * DAY + 600, "healthy");
        expect(drill()).toMatchObject({ status: "ok" });
        // None ran yet: late from since, unknown before.
        rmSync(sh.native(`${APP_DIR}/.snapshots/drills.log`), { recursive: true, force: true });
        expect(drill()).toEqual({ status: "unknown" });
        drillSchedule(sh, now - 2 * DAY);
        expect(drill()).toEqual({ status: "unknown" });
        drillSchedule(sh, now - 15 * DAY);
        expect(drill()).toEqual({ status: "late" });
      });
      on({ drill: "daily" }, (sh) => {
        snapshotLog(sh, TAKEN);
        drillLog(sh, now - 2 * DAY - 3660, "healthy");
        expect(only(runReport(sh)).body.drill).toMatchObject({ status: "late" });
      });
      // No schedule: none, whatever the drills' log says.
      on({}, (sh) => {
        snapshotLog(sh, TAKEN);
        drillLog(sh, now - DAY, "failed");
        expect(only(runReport(sh)).body.drill).toEqual({ status: "none" });
      });
    });

    it("reads each hostname's certificate on 127.0.0.1:443 with it as SNI, and reads no file", () => {
      on({ hosts: ["a.example.com", "b.example.com", "c.example.com", "d.example.com"] }, (sh) => {
        cert(sh, "a.example.com", 15);
        cert(sh, "b.example.com", 13);
        cert(sh, "c.example.com", -1);
        cert(sh, "d.example.com", null);
        const run = runReport(sh);
        expect(only(run).body.certificates).toEqual([
          { hostname: "a.example.com", status: "ok", days: 15 },
          { hostname: "b.example.com", status: "warn", days: 13 },
          { hostname: "c.example.com", status: "expired", days: -1 },
          { hostname: "d.example.com", status: "none" },
        ]);
        // The two run side by side in a pipeline, so their lines may come in either order.
        const openssl = run.calls.filter((call) => call.startsWith("openssl "));
        expect(openssl.filter((call) => !call.startsWith("openssl x509"))).toEqual([
          "openssl s_client -connect 127.0.0.1:443 -servername a.example.com",
          "openssl s_client -connect 127.0.0.1:443 -servername b.example.com",
          "openssl s_client -connect 127.0.0.1:443 -servername c.example.com",
          "openssl s_client -connect 127.0.0.1:443 -servername d.example.com",
        ]);
        expect(openssl.filter((call) => call.startsWith("openssl x509"))).toEqual(
          Array(4).fill("openssl x509 -noout -enddate"),
        );
      });
    });

    it("checks the credentials once a day, keeping the results in its state in between", () => {
      const now = nowSeconds();
      const dates = (age: number) =>
        (["made", "rotated", "first-deploy"] as const).map((source, n) => ({
          name: `credential-${n}`,
          at: iso(now - age * DAY),
          source,
        }));
      const checkedAt = (sh: ShellHarness) =>
        Number(/^checked (\d+)$/m.exec(sh.read("/statedir/state") ?? "")?.[1]);
      const setState = (sh: ShellHarness, edit: (text: string) => string) =>
        sh.write("/statedir/state", edit(sh.read("/statedir/state") ?? ""));
      on({ credentials: { maxAgeDays: 365, dates: dates(10) } }, (sh) => {
        const first = only(runReport(sh));
        expect(first.body.credentials).toEqual([
          { name: "credential-0", status: "ok", days: 10, source: "made" },
          { name: "credential-1", status: "ok", days: 10, source: "rotated" },
          { name: "credential-2", status: "ok", days: 10, source: "first-deploy" },
        ]);
        expect(checkedAt(sh)).toBeGreaterThanOrEqual(now);
        // Within the day, the state's results stand: they are not checked again.
        setState(sh, (text) =>
          text
            .replace(/^checked \d+$/m, `checked ${now - 3600}`)
            .replace(/^(credential credential-0 \S+ made) ok 10$/m, "$1 old 400"),
        );
        const kept = only(runReport(sh));
        expect(kept.body.credentials).toEqual([
          { name: "credential-0", status: "old", days: 400, source: "made" },
          { name: "credential-1", status: "ok", days: 10, source: "rotated" },
          { name: "credential-2", status: "ok", days: 10, source: "first-deploy" },
        ]);
        expect(checkedAt(sh)).toBe(now - 3600);
        expect(runReport(sh).sent).toEqual([]);
        // A day after the last check, they are checked again.
        setState(sh, (text) => text.replace(/^checked \d+$/m, `checked ${now - DAY}`));
        const again = only(runReport(sh));
        expect(again.body.credentials).toMatchObject([{ status: "ok", days: 10 }, {}, {}]);
        expect(checkedAt(sh)).toBeGreaterThanOrEqual(now);
      });
      // A date older than the limit is old, whichever source it comes from.
      on({ credentials: { maxAgeDays: 365, dates: dates(400) } }, (sh) => {
        expect(only(runReport(sh)).body.credentials).toEqual([
          { name: "credential-0", status: "old", days: 400, source: "made" },
          { name: "credential-1", status: "old", days: 400, source: "rotated" },
          { name: "credential-2", status: "old", days: 400, source: "first-deploy" },
        ]);
      });
      // A rotation's new date in the config is checked at the next run.
      on({ credentials: { maxAgeDays: 365, dates: dates(400) } }, (sh) => {
        expect(only(runReport(sh)).body.credentials).toMatchObject([{ status: "old" }, {}, {}]);
        config(sh, { credentials: { maxAgeDays: 365, dates: dates(1) } });
        const rotated = only(runReport(sh));
        expect(rotated.body.credentials).toMatchObject([{ status: "ok", days: 1 }, {}, {}]);
      });
      // Off: no credentials in the report.
      on({}, (sh) => {
        expect(only(runReport(sh)).body).not.toHaveProperty("credentials");
      });
    });

    it("takes the plan's credential names, with : and /, into its report, journal and state", () => {
      const now = nowSeconds();
      // As plan-schema's CredentialNameSchema allows them.
      const names = ["app:SECRET_KEY_BASE", "grant:laptop/cache"];
      const dates = names.map((name) => ({
        name,
        at: iso(now - 400 * DAY),
        source: "made" as const,
      }));
      on({ credentials: { maxAgeDays: 365, dates } }, (sh) => {
        const run = runReport(sh);
        expect(only(run).body.credentials).toEqual(
          names.map((name) => ({ name, status: "old", days: 400, source: "made" })),
        );
        expect(run.journal).toBe(
          "uptime report: disk ok, snapshot none, drill none, credential app:SECRET_KEY_BASE old, credential grant:laptop/cache old; sent a change report\n",
        );
        expect(sh.read("/statedir/state")).toMatch(/^status credential:grant:laptop\/cache old$/m);
        // The next run reads them back from its state: no change, nothing sent.
        expect(runReport(sh).sent).toEqual([]);
      });
      // Anything else in a name is still an invalid config.
      on({}, (sh) => {
        for (const name of ['app:"x"', "grant:laptop\\cache", "POSTGRES_PASSWORD", "app:"]) {
          sh.write(
            "/creds/config",
            `${uptimeReportConfigText("shop", REPORT)}max_age_days=365\ncredential=${name} 2026-01-01T00:00:00Z made\n`,
          );
          expect(runReport(sh).status, name).toBe(2);
        }
      });
    });

    it("sends only on a status change, or 24 hours after its last report", () => {
      on({}, (sh) => {
        const first = only(runReport(sh));
        expect(first.body.kind).toBe("change");
        const state = sh.read("/statedir/state") ?? "";
        expect(state).toMatch(/^sent \d+$/m);
        // Nothing changed: nothing is sent, and the state stays as it was.
        const quiet = runReport(sh);
        expect(quiet.sent).toEqual([]);
        expect(quiet.journal).toMatch(/; no change\n$/);
        expect(sh.read("/statedir/state")).toBe(state);
        // A percentage moving within one status is no change.
        sh.write("/state/df", df(50, 50));
        expect(runReport(sh).sent).toEqual([]);
        // Unknown is no change, and keeps the last known status.
        snapshotLog(sh, TAKEN);
        expect(only(runReport(sh)).body.snapshot).toMatchObject({ status: "ok" });
        mkdirSync(sh.native(`${APP_DIR}/.snapshots/20261125T040000Z.partial`), { recursive: true });
        sh.stub("flock", "exit 1", { log: false });
        expect(runReport(sh).sent).toEqual([]);
        expect(sh.read("/statedir/state")).toMatch(/^status snapshot ok$/m);
        sh.stub("flock", "exit 0", { log: false });
        expect(runReport(sh).sent).toEqual([]);
        // A status change is sent at once.
        sh.write("/state/df", df(90, 10));
        const warn = only(runReport(sh));
        expect(warn.body).toMatchObject({ kind: "change", disk: { status: "warn" } });
        // 24 hours after the last report: one heartbeat.
        const sent = Number(/^sent (\d+)$/m.exec(sh.read("/statedir/state") ?? "")?.[1]);
        sh.write(
          "/statedir/state",
          (sh.read("/statedir/state") ?? "").replace(/^sent \d+$/m, `sent ${sent - DAY + 120}`),
        );
        expect(runReport(sh).sent).toEqual([]);
        sh.write(
          "/statedir/state",
          (sh.read("/statedir/state") ?? "").replace(/^sent \d+$/m, `sent ${sent - DAY}`),
        );
        const heartbeat = only(runReport(sh));
        expect(heartbeat.body).toMatchObject({ kind: "heartbeat", disk: { status: "warn" } });
        expect(heartbeat.raw).not.toContain("\n");
      });
    });

    it("keeps its state unless the Worker answers 2xx, so the next run sends again", () => {
      on({}, (sh) => {
        only(runReport(sh));
        const state = sh.read("/statedir/state");
        sh.write("/state/df", df(96, 4));
        for (const [answer, words] of [
          ["401", "the Worker refused the report (HTTP 401), so the next run sends again"],
          ["502", "the Worker refused the report (HTTP 502), so the next run sends again"],
          ["302", "the Worker refused the report (HTTP 302), so the next run sends again"],
        ] as const) {
          sh.write("/state/answer", answer);
          const refused = runReport(sh);
          expect(refused.sent).toHaveLength(1);
          expect(refused.status).toBe(0);
          expect(refused.journal).toMatch(new RegExp(`; ${words.replace(/[()]/g, "\\$&")}\n$`));
          expect(sh.read("/statedir/state")).toBe(state);
        }
        sh.write("/state/unreachable", "");
        const away = runReport(sh);
        expect(away.journal).toMatch(
          /; the Worker could not be reached, so the next run sends again\n$/,
        );
        expect(sh.read("/statedir/state")).toBe(state);
        rmSync(sh.native("/state/unreachable"), { recursive: true, force: true });
        sh.write("/state/answer", "200");
        const accepted = only(runReport(sh));
        expect(accepted.body).toMatchObject({ kind: "change", disk: { status: "high" } });
        expect(sh.read("/statedir/state")).toMatch(/^status disk high$/m);
        expect(runReport(sh).sent).toEqual([]);
      });
    });

    it("signs each report with HMAC-SHA256 of the time, a newline and the body, sends its own User-Agent", () => {
      on({}, (sh) => {
        const before = nowSeconds();
        const run = runReport(sh);
        const report = only(run);
        const time = report.headers["X-OpsCrew-Time"] ?? "";
        expect(Number(time)).toBeGreaterThanOrEqual(before);
        expect(Number(time)).toBeLessThanOrEqual(nowSeconds());
        const expected = createHmac("sha256", Buffer.from(KEY, "hex"))
          .update(`${time}\n${report.raw}`)
          .digest("hex");
        expect(report.headers).toEqual({
          "Content-Type": "application/json",
          "X-OpsCrew-Entry": "acme/shop/shop/prod",
          "X-OpsCrew-Time": time,
          "X-OpsCrew-Signature": expected,
        });
        expect(report.agent).toBe(UPTIME_REPORT_USER_AGENT);
        expect(report.url).toBe(REPORT.url);
        expect(report.args).toEqual(
          expect.arrayContaining(["--max-time", "20", "--data-binary", "@-"]),
        );
      });
    });

    it("never puts the key in a command line, the journal or the state file", () => {
      on({ hosts: HOSTS }, (sh) => {
        const run = runReport(sh);
        only(run);
        const second = runReport(sh);
        for (const text of [
          run.journal,
          second.journal,
          run.calls.join("\n"),
          run.sent[0]?.args.join("\n") ?? "",
          sh.read("/statedir/state") ?? "",
          sh.read("/calls.log") ?? "",
        ]) {
          expect(text).not.toContain(KEY);
          expect(text.toLowerCase()).not.toContain(KEY.slice(0, 16));
        }
        expect(run.journal).toBe(
          "uptime report: disk ok, snapshot none, drill none, certificate shop.example.com ok, certificate www.shop.example.com ok; sent a change report\n",
        );
      });
    });

    it("sends only data-model.md's fields", () => {
      const now = nowSeconds();
      on(
        {
          drill: "weekly",
          hosts: HOSTS,
          credentials: {
            maxAgeDays: 365,
            dates: [{ name: "deploy-key", at: iso(now), source: "made" }],
          },
        },
        (sh) => {
          snapshotLog(sh, TAKEN);
          drillLog(sh, now - DAY, "unhealthy");
          const { body } = only(runReport(sh));
          expect(Object.keys(body)).toEqual([
            "version",
            "server",
            "kind",
            "disk",
            "snapshot",
            "drill",
            "certificates",
            "credentials",
          ]);
          expect(body).toMatchObject({ version: 1, server: "hetzner-shop", kind: "change" });
          expect(Object.keys(body.disk as object)).toEqual(["status", "percent", "free", "total"]);
          expect(Object.keys(body.snapshot as object)).toEqual(["status", "id"]);
          expect(Object.keys(body.drill as object)).toEqual(["status", "result", "at"]);
          for (const item of body.certificates as object[]) {
            expect(Object.keys(item)).toEqual(["hostname", "status", "days"]);
          }
          expect(body.credentials).toEqual([
            { name: "deploy-key", status: "ok", days: 0, source: "made" },
          ]);
          // No address, no path and no log line.
          expect(JSON.stringify(body)).not.toMatch(/workers\.dev|\/srv|left out|127\.0\.0\.1/);
        },
      );
    });

    it("stops with exit 2 and sends nothing when its config or key is not valid", () => {
      for (const [report, key] of [
        [{ url: "https://example.com/report" }, KEY],
        [{ url: "https://opscrew-uptime.acme.workers.dev/other" }, KEY],
        [{ server: "two words" }, KEY],
        [{}, KEY.slice(1)],
        [{}, KEY.toUpperCase()],
        [{}, ""],
      ] as const) {
        const sh = server(report, key);
        try {
          const run = runReport(sh);
          expect(run.status).toBe(2);
          expect(run.journal).toBe("uptime report: its config or its key is not valid\n");
          expect(run.sent).toEqual([]);
          expect(run.calls.filter((call) => /^(df|openssl|curl) /.test(call))).toEqual([]);
        } finally {
          sh.dispose();
        }
      }
      on({}, (sh) => {
        sh.write("/creds/config", `${sh.read("/creds/config")}rm -rf /\n`);
        expect(runReport(sh).status).toBe(2);
        sh.write(
          "/creds/config",
          `${uptimeReportConfigText("shop", REPORT)}credential=deploy-key 2026-01-01T00:00:00Z made\n`,
        );
        expect(runReport(sh).status).toBe(2);
      });
    });
  },
);

/**
 * The scheduled check's rules (`check.mjs`'s `checkDisk`, `checkSnapshot` and `checkDrill`) on
 * `CHECK_KEY_COMMAND`'s answer: `fail`, `pass`, or undefined where the check knows nothing.
 */
function scheduledCheck(
  output: string,
  app: string,
  every: "weekly" | "daily" | undefined,
  now: number,
) {
  const verdict = (failed: boolean) => (failed ? "fail" : "pass");
  let disk: string | undefined;
  const fields =
    output
      .trim()
      .split("\n")
      .filter((line) => !line.startsWith("scheduled"))
      .at(-1)
      ?.trim()
      .split(/\s+/) ?? [];
  if (fields.length >= 6) {
    const [, used = 0, free = 0] = fields.slice(-5, -2).map(Number);
    if (used + free > 0) disk = verdict(Math.ceil((used * 100) / (used + free)) >= 85);
  }
  const prefix = `scheduled ${app} `;
  const own = output
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  let snapshot: string | undefined;
  if (
    /^at \d+$/.test(own.find((line) => line.startsWith("at ")) ?? "") &&
    !own.includes("running")
  ) {
    const after = /^after (\d+)$/.exec(own.find((line) => line.startsWith("after ")) ?? "")?.[1];
    const id = own.find((line) => line.startsWith("id "))?.slice(3);
    if (after !== undefined && (id === undefined || /^\d{8}T\d{6}Z$/.test(id))) {
      snapshot = verdict(id === undefined || Number(after) > 0);
    }
  }
  let drill: string | undefined;
  const line = output
    .split("\n")
    .find((each) => each === `${prefix}drill` || each.startsWith(`${prefix}drill `));
  if (every !== undefined && line !== undefined) {
    const period = { weekly: 7 * DAY, daily: DAY }[every] * 1000;
    const rest = line.slice(`${prefix}drill`.length).trim();
    if (rest === "") {
      const since = own.find((each) => each.startsWith("since "))?.slice("since ".length);
      const from =
        since !== undefined && /^\d{1,12}$/.test(since) ? Number(since) * 1000 : undefined;
      if (from !== undefined && now - from > 2 * period + 3_600_000) drill = "fail";
    } else {
      const match = /^(\S+Z) (healthy|unhealthy|not-restored|failed)$/.exec(rest);
      if (match?.[1] !== undefined) {
        drill = verdict(
          match[2] !== "healthy" || now - Date.parse(match[1]) > 2 * period + 3_600_000,
        );
      }
    }
  }
  return { disk, snapshot, drill };
}

/** The script's status as the scheduled check's verdict: a failure, a pass, or nothing known. */
function verdictOf(status: unknown): string | undefined {
  if (status === "ok") return "pass";
  if (["warn", "high", "failed", "copy-failed", "late"].includes(String(status))) return "fail";
  return undefined;
}

describe.skipIf(reason !== undefined)("parity with the scheduled check", () => {
  it("reads the app's folder with CHECK_KEY_COMMAND's own reading", () => {
    expect(UPTIME_REPORT_READ).toBe(
      CHECK_KEY_COMMAND.replace("for d in /srv/apps/*/; do", "for d in /srv/apps/$APP/; do"),
    );
    expect(renderUptimeReportScript()).toContain(`answer=$(${UPTIME_REPORT_READ}) || answer=''`);
  });

  const now = nowSeconds();
  const fail = "fail";
  const pass = "pass";
  const FIXTURES: {
    name: string;
    disk: [number, number];
    setup: (sh: ShellHarness) => void;
    verdict: Record<"disk" | "snapshot" | "drill", string | undefined>;
  }[] = [
    {
      name: "all well",
      disk: [84, 16],
      setup: (sh) => {
        snapshotLog(sh, TAKEN);
        drillLog(sh, now - DAY, "healthy");
      },
      verdict: { disk: pass, snapshot: pass, drill: pass },
    },
    {
      name: "a full disk, a failed copy, an unhealthy drill",
      disk: [85, 15],
      setup: (sh) => {
        snapshotLog(sh, [...TAKEN, "upload failed"]);
        drillLog(sh, now - DAY, "unhealthy");
      },
      verdict: { disk: fail, snapshot: fail, drill: fail },
    },
    {
      name: "a fuller disk, no snapshot, a drill that did not restore",
      disk: [95, 5],
      setup: (sh) => {
        snapshotLog(sh, ["failed"]);
        drillLog(sh, now - DAY, "not-restored");
      },
      verdict: { disk: fail, snapshot: fail, drill: fail },
    },
    {
      name: "a snapshot being taken, a failed drill",
      disk: [10, 90],
      setup: (sh) => {
        snapshotLog(sh, TAKEN);
        mkdirSync(sh.native(`${APP_DIR}/.snapshots/20261125T040000Z.partial`), { recursive: true });
        sh.stub("flock", "exit 1", { log: false });
        drillLog(sh, now - DAY, "failed");
      },
      verdict: { disk: pass, snapshot: undefined, drill: fail },
    },
    {
      name: "a drill that is late",
      disk: [10, 90],
      setup: (sh) => {
        snapshotLog(sh, TAKEN);
        drillLog(sh, now - 15 * DAY, "healthy");
      },
      verdict: { disk: pass, snapshot: pass, drill: fail },
    },
    {
      name: "no drill yet, scheduled long ago",
      disk: [10, 90],
      setup: (sh) => {
        snapshotLog(sh, TAKEN);
        drillSchedule(sh, now - 15 * DAY);
      },
      verdict: { disk: pass, snapshot: pass, drill: fail },
    },
    {
      name: "no drill yet, scheduled lately",
      disk: [10, 90],
      setup: (sh) => {
        snapshotLog(sh, TAKEN);
        drillSchedule(sh, now - DAY);
      },
      verdict: { disk: pass, snapshot: pass, drill: undefined },
    },
    {
      name: "no log at all",
      disk: [10, 90],
      setup: (sh) => drillSchedule(sh, now - 15 * DAY),
      verdict: { disk: pass, snapshot: undefined, drill: undefined },
    },
  ];
  for (const fixture of FIXTURES) {
    it(`fails and passes as CHECK_KEY_COMMAND's answer does under check.mjs's rules: ${fixture.name}`, () => {
      on({ drill: "weekly" }, (sh) => {
        sh.write("/state/df", df(...fixture.disk));
        fixture.setup(sh);
        const answer = sh.run(
          `PATH='${sh.root}/bin:/usr/bin:/bin'\nexport PATH\n${CHECK_KEY_COMMAND}`,
        );
        expect(answer.status, answer.stderr).toBe(0);
        expect(scheduledCheck(answer.stdout, "shop", "weekly", Date.now())).toEqual(
          fixture.verdict,
        );
        const { body } = only(runReport(sh));
        expect({
          disk: verdictOf((body.disk as { status: string }).status),
          snapshot: verdictOf((body.snapshot as { status: string }).status),
          drill: verdictOf((body.drill as { status: string }).status),
        }).toEqual(fixture.verdict);
      });
    });
  }
});
