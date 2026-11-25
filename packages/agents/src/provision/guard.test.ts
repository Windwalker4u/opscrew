import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { OpsCrewError } from "@opscrew/core";
import { cloudTarget } from "@opscrew/iac-templates";
import { type DeployPlan, DeployPlanSchema, type Retarget } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { leaksToken, twoAccounts, withCloudflareMove } from "../cloudflare-move/record.fakes";
import { requireNoDeployOrMove } from "../snapshot/run";
import { createTestPhaseDeps, sitePlan, testPlan } from "../testing";
import {
  inTempFolder,
  moveInProgress,
  requireNoCloudflareMove,
  requireNoMoveInProgress,
} from "./guard";
import { runProvision } from "./run";

/** A plan moving from Hetzner Cloud to DigitalOcean, at `step`, optionally being aborted. */
function moving(abort?: NonNullable<Retarget["abort"]>["step"]): DeployPlan {
  const from = testPlan({ deployed: true });
  return {
    ...testPlan({ provider: "digitalocean", deployed: true }),
    retarget: {
      from: { target: cloudTarget(from.target), deploy: from.deploy },
      step: "deployed",
      empty: [],
      startedAt: "2026-10-12T09:00:00.000Z",
      ...(abort !== undefined ? { abort: { step: abort } } : {}),
    },
  };
}

describe("moveInProgress", () => {
  it("is undefined without a move", () => {
    expect(moveInProgress(testPlan())).toBeUndefined();
    expect(() => requireNoMoveInProgress(testPlan())).not.toThrow();
  });

  it("names continue, finish and abort while a move runs", () => {
    expect(moveInProgress(moving())).toEqual({
      message: "A move to DigitalOcean is in progress.",
      hint: "Run `opscrew retarget` to continue it, `opscrew retarget --finish` after the switch, or `opscrew retarget --abort` before it.",
    });
  });

  it.each(["started", "new-removed", "secrets-restored"] as const)(
    "names only the abort once an abort began (%s)",
    (step) => {
      const move = moveInProgress(moving(step));
      expect(move?.message).toBe("A move to DigitalOcean is being aborted.");
      expect(move?.hint).toContain("Run `opscrew retarget --abort` to finish the abort");
      expect(move?.hint).not.toContain("continue it");
      expect(move?.hint).not.toContain("--finish");
      const error = (() => {
        try {
          requireNoMoveInProgress(moving(step));
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(OpsCrewError);
      expect(error).toMatchObject({ code: "PHASE_PRECONDITION", hint: move?.hint });
    },
  );
});

describe("moveInProgress for a move to the user's own server or Portainer", () => {
  const to = (target: DeployPlan["target"]): DeployPlan => ({ ...moving(), target });
  const own = to({
    provider: "own",
    mode: "vps-compose",
    arch: "amd64",
    access: "public",
    edge: "caddy",
  });
  const portainer = to({
    provider: "portainer",
    mode: "portainer-stack",
    environmentId: 3,
    arch: "amd64",
    redeploy: "updater",
    web: { mode: "caddy" },
  });

  const pages = { ...moving(), target: sitePlan({ provider: "github-pages" }).target };
  const workers = { ...moving(), target: sitePlan({ provider: "cloudflare-workers" }).target };

  it.each([
    [own, "A move to your own server is in progress."],
    [portainer, "A move to your Portainer is in progress."],
    [pages, "A move to GitHub Pages is in progress."],
    [workers, "A move to Cloudflare hosting is in progress."],
  ])("names the target in words and refuses with that notice (%#)", (plan, message) => {
    expect(moveInProgress(plan)?.message).toBe(message);
    expect(() => requireNoMoveInProgress(plan)).toThrow(message);
    expect(JSON.stringify(moveInProgress(plan))).not.toContain("Your own server");
  });
});

describe("requireNoCloudflareMove", () => {
  const accounts = twoAccounts();
  const refusal = (plan: DeployPlan, run = () => requireNoCloudflareMove(plan)) => {
    try {
      run();
    } catch (e) {
      return e as OpsCrewError;
    }
    return undefined;
  };

  it("lets a plan without a move through", () => {
    expect(() => requireNoCloudflareMove(testPlan())).not.toThrow();
  });

  it.each([
    ["started", undefined, ["`opscrew cloudflare move` to go on", "--abort"], ["--switch"]],
    ["prepared", undefined, ["--switch", "--finish", "--abort"], ["go on preparing"]],
    ["adopted", undefined, ["--finish"], ["--switch", "--abort"]],
    ["started", "started", ["--abort` to finish the abort"], ["--switch", "--finish"]],
    ["prepared", "removed", ["--abort` to finish the abort"], ["--switch", "--finish"]],
  ] as const)("refuses at %s (abort %s) with that step's hint", (step, abort, has, hasNot) => {
    const plan = withCloudflareMove(testPlan(), accounts, step, abort);
    const error = refusal(plan);
    expect(error).toBeInstanceOf(OpsCrewError);
    expect(error).toMatchObject({
      code: "PHASE_PRECONDITION",
      message:
        "A move of example.com to another Cloudflare account is in progress. Nothing was changed.",
    });
    for (const text of has) expect(error?.hint).toContain(text);
    for (const text of hasNot) expect(error?.hint).not.toContain(text);
    expect(error?.hint).toContain("Then run this command again.");
    expect(leaksToken(accounts, error?.message ?? "", error?.hint ?? "")).toBe(false);
    expect(accounts.cloudflare.calls).toEqual([]);
  });

  it("names a further app's --app in every command, and no --env", () => {
    const shop = testPlan();
    const api = { ...shop, app: { ...shop.app, key: "api" } };
    const hint = refusal(withCloudflareMove(api, accounts, "prepared"))?.hint ?? "";
    for (const flag of [" --switch", " --finish", " --abort"]) {
      expect(hint).toContain(`\`opscrew cloudflare move --app api${flag}\``);
    }
    expect(hint).not.toContain("--env");
    expect(refusal(withCloudflareMove(shop, accounts, "prepared"))?.hint).not.toContain("--app");
  });

  it("names the plan's own zone", () => {
    const shop = testPlan({ domain: "shop.example.org" });
    const plan = withCloudflareMove(
      { ...shop, dns: { ...shop.dns, zone: "example.org" } },
      twoAccounts("example.org"),
    );
    expect(refusal(plan)?.message).toBe(
      "A move of example.org to another Cloudflare account is in progress. Nothing was changed.",
    );
  });

  it("is part of requireNoMoveInProgress, unless the caller allows a Cloudflare move", () => {
    const plan = withCloudflareMove(testPlan(), accounts, "prepared");
    expect(refusal(plan, () => requireNoMoveInProgress(plan))?.message).toContain(
      "A move of example.com to another Cloudflare account is in progress.",
    );
    expect(() => requireNoMoveInProgress(plan, { allowCloudflareMove: true })).not.toThrow();
    // moveInProgress stays retarget's: snapshot, rollback, advise and status read only it.
    expect(moveInProgress(plan)).toBeUndefined();
  });

  it("still refuses a retarget when a Cloudflare move is allowed", () => {
    expect(() => requireNoMoveInProgress(moving(), { allowCloudflareMove: true })).toThrow(
      "A move to DigitalOcean is in progress.",
    );
  });
});

describe("snapshot during a move to another Cloudflare account", () => {
  it("goes on: its own check stops only for a retarget or a service's move", async () => {
    const deps = await createTestPhaseDeps();
    const local = DeployPlanSchema.parse({
      ...testPlan({ deployed: true }),
      target: {
        provider: "localhost",
        mode: "local-compose",
        arch: "amd64",
        ports: { https: 443, http: 80 },
        image: "registry",
      },
    });
    const plan = withCloudflareMove(local, twoAccounts(), "prepared");
    const run = { deps, plan, environment: "prod", flags: "", services: {} };
    await expect(requireNoDeployOrMove(run, "take a snapshot")).resolves.toBeUndefined();
  });
});

describe("inTempFolder", () => {
  it("tells a project inside the system's temporary folder, by its real path", async () => {
    const base = await mkdtemp(join(tmpdir(), "opscrew-temp-guard-"));
    const temp = join(base, "Temp");
    const project = join(temp, "shop");
    const kept = join(base, "projects", "shop");
    await mkdir(project, { recursive: true });
    await mkdir(kept, { recursive: true });
    expect(await inTempFolder(project, temp)).toBe(true);
    expect(await inTempFolder(temp, temp)).toBe(true);
    expect(await inTempFolder(kept, temp)).toBe(false);
    // A sibling whose name starts like the temporary folder's is not inside it.
    await mkdir(join(base, "Temporary"), { recursive: true });
    expect(await inTempFolder(join(base, "Temporary"), temp)).toBe(false);
    // Windows compares paths without case.
    expect(await inTempFolder(project.toUpperCase(), temp, "win32")).toBe(true);
    // A link into the temporary folder is inside it.
    const link = join(base, "link");
    await symlink(project, link, "junction");
    expect(await inTempFolder(link, temp)).toBe(true);
  });

  it("makes provision warn, and go on, for a project in the temporary folder", async () => {
    const deps = await createTestPhaseDeps();
    await expect(
      runProvision(deps, { services: { tempDir: dirname(deps.paths.root) } }),
    ).rejects.toThrow();
    const warnings = deps.reporter.lines.filter((line) => line.level === "warn");
    expect(warnings.map((line) => line.message)).toEqual([
      expect.stringContaining("is in the system's temporary folder"),
    ]);
    const other = await createTestPhaseDeps();
    await expect(
      runProvision(other, { services: { tempDir: join(other.paths.root, "elsewhere") } }),
    ).rejects.toThrow();
    expect(other.reporter.lines.filter((line) => line.level === "warn")).toEqual([]);
  });
});
