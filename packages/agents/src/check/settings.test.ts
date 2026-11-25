import { resolveProjectPaths } from "@opscrew/core";
import {
  ArtifactError,
  type DeployPlan,
  DeployPlanSchema,
  writeArtifact,
} from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { hostingTestPlan } from "../hosting/__fixtures__/account";
import { localPlan } from "../localhost/__fixtures__/computer";
import { createTestPhaseDeps, testPlan } from "../testing";
import {
  checkRunner,
  checksInActions,
  requireCheckSettingsPlace,
  requireUptimeSettings,
  usesUptimeWorker,
  withDesignedCheck,
} from "./settings";

const ROOT = "/work/shop";

/** `testPlan` as `app` (a further app's key) in `environment`, with `check`. */
function plan(
  check: Record<string, unknown> | undefined,
  where: { app?: string; environment?: string } = {},
): DeployPlan {
  const base = testPlan({ domain: "shop.example.com" });
  const name = [where.app ?? "shop", where.environment].filter(Boolean).join("-");
  return DeployPlanSchema.parse({
    ...base,
    app: { ...base.app, name, ...(where.app === undefined ? {} : { key: where.app }) },
    ...(where.environment === undefined ? {} : { environment: { name: where.environment } }),
    ...(check === undefined ? {} : { observability: { check } }),
  });
}

function pathsOf(where: { app?: string; environment?: string } = {}) {
  return resolveProjectPaths(ROOT, {
    env: { OPSCREW_HOME: "/home/user/.opscrew" },
    ...where,
  });
}

describe("requireCheckSettingsPlace", () => {
  it("accepts the interval and the webhook in the first app's prod plan", () => {
    expect(() =>
      requireCheckSettingsPlace(
        pathsOf(),
        plan({ enabled: true, intervalMinutes: 30, webhook: "ntfy" }),
      ),
    ).not.toThrow();
  });

  it("refuses them in another environment's plan, naming the file to edit", () => {
    const staging = { environment: "staging" };
    let error: unknown;
    try {
      requireCheckSettingsPlace(
        pathsOf(staging),
        plan({ enabled: false, intervalMinutes: 30, webhook: "slack" }, staging),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArtifactError);
    const artifact = error as ArtifactError;
    expect(artifact.file).toBe("opscrew/environments/staging/plan.yaml");
    expect(artifact.issues.map((issue) => issue.path)).toEqual([
      "observability.check.intervalMinutes",
      "observability.check.webhook",
    ]);
    expect(artifact.message).toContain("only the first app's prod plan (opscrew/plan.yaml)");
    expect(artifact.hint).toBe(
      "Remove observability.check.intervalMinutes and observability.check.webhook from opscrew/environments/staging/plan.yaml, and set them in opscrew/plan.yaml instead.",
    );
  });

  it("refuses them in a further app's prod plan", () => {
    const api = { app: "api" };
    expect(() =>
      requireCheckSettingsPlace(pathsOf(api), plan({ enabled: true, intervalMinutes: 15 }, api)),
    ).toThrow(/opscrew\/apps\/api\/plan\.yaml/);
  });

  it("accepts `enabled` anywhere", () => {
    const staging = { app: "api", environment: "staging" };
    expect(() =>
      requireCheckSettingsPlace(pathsOf(staging), plan({ enabled: true }, staging)),
    ).not.toThrow();
  });
});

describe("withDesignedCheck", () => {
  it("turns the check on for prod and off for the other environments", () => {
    expect(withDesignedCheck(plan(undefined), "prod").observability).toEqual({
      check: { enabled: true },
    });
    expect(
      withDesignedCheck(plan(undefined, { environment: "staging" }), "staging").observability,
    ).toEqual({ check: { enabled: false } });
  });

  it("keeps the plan's own setting", () => {
    const off = plan({ enabled: false, intervalMinutes: 30 });
    expect(withDesignedCheck(off, "prod")).toBe(off);
  });

  it("gives localhost no check", () => {
    const local = localPlan();
    expect(withDesignedCheck(local, "prod").observability).toBeUndefined();
  });
});

describe("the check's runner", () => {
  it("is GitHub Actions unless the plan chooses the Cloudflare uptime Worker", () => {
    expect(checkRunner(plan({ enabled: true }))).toBe("actions");
    expect(checksInActions(plan({ enabled: true }))).toBe(true);
    expect(checksInActions(plan({ enabled: true, runner: "actions" }))).toBe(true);
    const worker = plan({ enabled: true, runner: "cloudflare" });
    expect(checkRunner(worker)).toBe("cloudflare");
    expect(checksInActions(worker)).toBe(false);
    expect(usesUptimeWorker(worker)).toBe(true);
    // Off, neither runs.
    const off = plan({ enabled: false, runner: "cloudflare" });
    expect(usesUptimeWorker(off)).toBe(false);
    expect(checksInActions(off)).toBe(false);
  });
});

describe("requireUptimeSettings", () => {
  it("refuses the Cloudflare uptime Worker without the repository's webhook, naming opscrew/plan.yaml", async () => {
    const deps = await createTestPhaseDeps();
    let error: unknown;
    try {
      await requireUptimeSettings(deps.paths, plan({ enabled: true, runner: "cloudflare" }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArtifactError);
    const artifact = error as ArtifactError;
    expect(artifact.code).toBe("ARTIFACT_INVALID");
    expect(artifact.file).toBe("opscrew/plan.yaml");
    expect(artifact.issues.map((issue) => issue.path)).toEqual(["observability.check.webhook"]);
    expect(artifact.message).toContain("opens no GitHub issue");
    expect(artifact.hint).toBe(
      'Set observability.check.webhook to slack, discord or ntfy in opscrew/plan.yaml, or set observability.check.runner to "actions", then run the command again.',
    );
  });

  it("takes another environment's webhook from opscrew/plan.yaml", async () => {
    const deps = await createTestPhaseDeps({ environment: "staging" });
    const staging = plan({ enabled: true, runner: "cloudflare" }, { environment: "staging" });
    await expect(requireUptimeSettings(deps.paths, staging)).rejects.toThrow(ArtifactError);
    const prod = resolveProjectPaths(deps.paths.root, { env: deps.env });
    await writeArtifact("plan", prod.files.plan, plan({ enabled: true, webhook: "slack" }));
    await expect(requireUptimeSettings(deps.paths, staging)).resolves.toBeUndefined();
  });

  it("refuses the Worker on a hosting account, saying to use the Actions check", async () => {
    const deps = await createTestPhaseDeps();
    const hosting = DeployPlanSchema.parse({
      ...hostingTestPlan({ cloudflare: true }),
      observability: { check: { enabled: true, runner: "cloudflare", webhook: "slack" } },
    });
    let error: unknown;
    try {
      await requireUptimeSettings(deps.paths, hosting);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ArtifactError);
    const artifact = error as ArtifactError;
    expect(artifact.file).toBe("opscrew/plan.yaml");
    expect(artifact.issues).toEqual([
      {
        path: "observability.check.runner",
        message:
          "can't be \"cloudflare\" on a hosting account: the Cloudflare uptime Worker isn't available for hosting accounts yet",
      },
    ]);
    expect(artifact.hint).toBe(
      'Set observability.check.runner to "actions" in opscrew/plan.yaml, then run the command again.',
    );
  });

  it("asks nothing of the Actions check, nor of a check that is off", async () => {
    const deps = await createTestPhaseDeps();
    await expect(
      requireUptimeSettings(deps.paths, plan({ enabled: true })),
    ).resolves.toBeUndefined();
    await expect(
      requireUptimeSettings(deps.paths, plan({ enabled: false, runner: "cloudflare" })),
    ).resolves.toBeUndefined();
    await expect(
      requireUptimeSettings(
        deps.paths,
        plan({ enabled: true, runner: "cloudflare", webhook: "ntfy" }),
      ),
    ).resolves.toBeUndefined();
  });
});
