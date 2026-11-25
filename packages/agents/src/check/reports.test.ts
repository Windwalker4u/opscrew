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
