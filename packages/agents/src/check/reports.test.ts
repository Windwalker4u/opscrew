import { planUptimeReport } from "@opscrew/connector-ssh-host";
import { UPTIME_REPORT_MAX_BYTES } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { credentialsRecordFile } from "../rotate/record";
import { recordOwnServer } from "../shared/server-record";
import { ensureDeployKey } from "../shared/ssh-keys";
import { createTestPhaseDeps, ED25519_FINGERPRINT, ownPlan, portainerPlan } from "../testing";
import { ownServerId } from "./files";
import { reportCredentials, reportServers } from "./reports";

/** `base` with the check on in the Cloudflare uptime Worker, and `extra` merged in. */
function worker(base: DeployPlan, extra: Record<string, unknown> = {}): DeployPlan {
  return DeployPlanSchema.parse({
    ...base,
    observability: { check: { enabled: true, runner: "cloudflare", webhook: "slack" } },
    ...extra,
  });
}

describe("reportServers", () => {
  it("lists the app's server by its id in the scheduled check, with its drills, since today", async () => {
    const deps = await createTestPhaseDeps();
    await recordOwnServer(deps.paths, {
      host: "203.0.113.20",
      user: "root",
      agent: true,
      hostKey: ED25519_FINGERPRINT,
    });
    const plan = worker(ownPlan(), {
      snapshots: { schedule: { every: "daily", keep: 2 }, drills: { schedule: "weekly" } },
    });
    expect(await reportServers(deps, plan)).toEqual([
      { id: ownServerId(ED25519_FINGERPRINT), since: "2026-10-11T00:00:00Z", drill: "weekly" },
    ]);
  });

  it("lists none where the scheduled check's key doesn't reach a server, or without the Worker", async () => {
    const deps = await createTestPhaseDeps();
    for (const plan of [
      worker(ownPlan({ access: "tunnel" })),
      worker(portainerPlan()),
      DeployPlanSchema.parse({ ...ownPlan(), observability: { check: { enabled: true } } }),
    ]) {
      expect(await reportServers(deps, plan)).toEqual([]);
    }
  });
});

describe("reportCredentials", () => {
  it("dates each credential the check dates as check.mjs does, with the age limit, never a value", async () => {
    const deps = await createTestPhaseDeps();
    await ensureDeployKey(deps.paths, deps.redactor);
    const base = ownPlan({ postgres: false });
    const plan = worker(base, {
      observability: {
        check: { enabled: true, runner: "cloudflare", webhook: "slack", credentials: true },
      },
      credentials: { maxAgeDays: 90 },
      deployment: { ...base.deployment, firstDeployAt: "2026-01-02T03:04:05Z" },
    });
    expect(await reportCredentials(deps, plan)).toEqual({
      maxAgeDays: 90,
      dates: [{ name: "deploy-key", at: "2026-01-02T03:04:05Z", source: "first-deploy" }],
    });
    await writeArtifact("credentials", credentialsRecordFile(deps.paths), {
      schemaVersion: 1,
      environments: {
        prod: { "deploy-key": { madeAt: "2026-02-01T00:00:00.000Z", generation: 1 } },
      },
    });
    expect((await reportCredentials(deps, plan))?.dates).toEqual([
      { name: "deploy-key", at: "2026-02-01T00:00:00.000Z", source: "made" },
    ]);
    await writeArtifact("credentials", credentialsRecordFile(deps.paths), {
      schemaVersion: 1,
      environments: {
        prod: {
          "deploy-key": {
            madeAt: "2026-02-01T00:00:00.000Z",
            rotatedAt: "2026-09-01T00:00:00.000Z",
            generation: 2,
          },
        },
      },
    });
    expect((await reportCredentials(deps, plan))?.dates).toEqual([
      { name: "deploy-key", at: "2026-09-01T00:00:00.000Z", source: "rotated" },
    ]);
    // With the credentials' ages off, none.
    expect(await reportCredentials(deps, worker(base))).toBeUndefined();
  });
});

describe("the largest report the uptime-report step allows", () => {
  /** A 253-character hostname, the most a name may have, told apart by `i`. */
  const hostname = (i: number) =>
    [`h${i}`.padEnd(63, "a"), "b".repeat(63), "c".repeat(63), "d".repeat(57), "com"].join(".");
  /** A 128-character credential name, the most the step takes, told apart by `i`. */
  const credential = (i: number) => `app:${`N${i}_`.padEnd(124, "X")}`;
  const settings = (hosts: number, credentials: number, name = credential) => ({
    url: "https://opscrew-uptime.acme.workers.dev/report",
    entry: "acme/shop/shop/prod",
    server: `s${"x".repeat(99)}`,
    drill: "weekly" as const,
    hosts: Array.from({ length: hosts }, (_, i) => hostname(i)),
    thresholds: { diskWarn: 85, diskHigh: 95, certDays: 14 },
    credentials: {
      maxAgeDays: 365,
      dates: Array.from({ length: credentials }, (_, i) => ({
        name: name(i),
        at: "2026-01-02T03:04:05.000Z",
        source: "first-deploy" as const,
      })),
    },
    keySha256: "a".repeat(64),
  });
  const plan = (enable: ReturnType<typeof settings>) =>
    planUptimeReport({
      app: "shop",
      facts: {
        version: null,
        script: null,
        service: null,
        timer: null,
        dir: null,
        tools: { curl: true, openssl: true },
        instances: [],
      },
      enable,
    });

  it("is 40 hostnames and 64 credentials of 128 characters, and one more of each is refused", () => {
    expect(() => plan(settings(40, 64))).not.toThrow();
    expect(() => plan(settings(41, 64))).toThrow(/not valid/);
    expect(() => plan(settings(40, 65))).toThrow(/not valid/);
    expect(() => plan(settings(40, 64, (i) => `${credential(i)}Y`))).toThrow(/not valid/);
  });

  it("fits the Worker's body limit, with room to spare", () => {
    const largest = settings(40, 64);
    // As the server's script writes it, with the longest value of each field.
    const body = JSON.stringify({
      version: 1,
      server: largest.server,
      kind: "heartbeat",
      disk: {
        status: "high",
        percent: 100,
        free: 9_007_199_254_740_991,
        total: 9_007_199_254_740_991,
      },
      snapshot: { status: "copy-failed", id: "20261125T030000Z" },
      drill: { status: "failed", result: "not-restored", at: "2026-11-24T03:41:00Z" },
      certificates: largest.hosts.map((name) => ({
        hostname: name,
        status: "expired",
        days: -2_147_483_648,
      })),
      credentials: largest.credentials.dates.map((date) => ({
        name: date.name,
        status: "old",
        days: 2_147_483_647,
        source: date.source,
      })),
    });
    expect(Buffer.byteLength(body)).toBeLessThan(UPTIME_REPORT_MAX_BYTES * 0.8);
  });
});
