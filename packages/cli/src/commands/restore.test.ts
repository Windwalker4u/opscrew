import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { PhaseDeps } from "@opscrew/agents";
import type { ApprovalRequest } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withServices } from "../deps";
import { auditText, run } from "../ui/__fixtures__/harness";
import { type AgentCall, asking, lastCall, stagingProjects } from "../ui/__fixtures__/snapshots";

/** Each call of a restore, and the answer a test gives instead of the real agent's. */
const fake = vi.hoisted(() => ({
  calls: [] as AgentCall[],
  answers: {} as Record<
    string,
    ((deps: PhaseDeps, ...args: unknown[]) => Promise<unknown>) | undefined
  >,
}));

vi.mock("@opscrew/agents", async (importOriginal) => {
  const agents = await importOriginal<typeof import("@opscrew/agents")>();
  const faked = <K extends keyof typeof agents>(name: K) =>
    ((deps: PhaseDeps, ...args: unknown[]) => {
      fake.calls.push({ name, deps, args });
      const answer = fake.answers[name];
      return answer === undefined
        ? (agents[name] as (...all: unknown[]) => unknown)(deps, ...args)
        : answer(deps, ...args);
    }) as (typeof agents)[K];
  return {
    ...agents,
    restoreServerSnapshot: faked("restoreServerSnapshot"),
    restoreSnapshot: faked("restoreSnapshot"),
    drillSnapshot: faked("drillSnapshot"),
  };
});

const { setup, project } = stagingProjects();
beforeEach(() => {
  fake.calls.length = 0;
  fake.answers = {};
});

/** What a refused approval says, as the agent does. */
const REFUSED = "The server shop-staging was not rebuilt. Nothing was changed.";

const HASH = "c".repeat(64);
const OTHER = "d".repeat(64);

const ID = "20261106T190000Z";

/** A data restore, as `restoreSnapshot` asks it: destroy-grade, the app's name, its hash. */
const RESTORE: ApprovalRequest = {
  kind: "remote-exec",
  title: `Restore the snapshot ${ID} of staging on the app's server`,
  details: `What is lost: everything written to db since 2026-11-06 19:00 UTC.\nRestore hash: ${HASH}`,
  planHash: HASH,
  allowDestroy: true,
  confirmPhrase: "shop-staging",
};

const RESTORED = {
  id: ID,
  where: "on the app's server",
  services: [{ name: "db", server: "app" }],
  saved: { app: "20261107T080000Z" },
};

/** A whole-server restore, as `restoreServerSnapshot` asks it: destroy-grade, bound to its hash. */
const REBUILD: ApprovalRequest = {
  kind: "remote-exec",
  title: "Rebuild the server shop-staging of staging from the snapshot 9001",
  details: `Everything written on it since is lost for good.\nRestore hash: ${HASH}`,
  planHash: HASH,
  allowDestroy: true,
  confirmPhrase: "shop-staging",
};

const REBUILT = {
  id: "9001",
  where: "at Hetzner Cloud (server shop-staging)",
  server: { provider: "hetzner", id: "4711", name: "shop-staging" },
  checked: true,
};

describe("opscrew restore: the flags, checked before any work", () => {
  it.each([
    [["--server", "9001", "--approve", "abc"], "--approve expects the 64-character SHA-256"],
    [["--server", "9001", "--yes"], "unknown option '--yes'"],
    [[ID, "--yes"], "unknown option '--yes'"],
    [["--server", "9001", "--only", "db"], "--server takes no --only: the provider rebuilds"],
    [
      ["--server", "9001", "--allow-other-version", "--from", "offsite"],
      "--server takes no --allow-other-version, --from",
    ],
    [[ID, "--key-file", "age.txt"], "--key-file goes only with --from offsite"],
    [[ID, "--from", "bucket"], "Allowed choices are offsite."],
    [
      [ID, "--from", "offsite"],
      "--from offsite needs --key-file <path>: the age key file that opens the encrypted copy.",
    ],
    [[ID, "--from", "offsite", "--key-file", "missing-key.txt"], "could not read the key file"],
  ])("refuses %j", async (flags, message) => {
    const ctx = await setup();
    expect(await run(ctx, "restore", ...flags, "--env", "staging")).toBe(2);
    expect(ctx.errors).toContain(message);
    expect(fake.calls).toEqual([]);
  });

  it("prints its help with every flag", async () => {
    const ctx = await setup();
    expect(await run(ctx, "restore", "--help")).toBe(0);
    for (const flag of [
      "<id>",
      "--only <service>",
      "--allow-other-version",
      "--from <where>",
      "--key-file <path>",
      "--server",
      "--confirm <name>",
      "--approve <hash>",
      "--app <key>",
      "--env <name>",
    ]) {
      expect(ctx.output).toContain(flag);
    }
  });
});

describe("opscrew restore <id>", () => {
  it("passes --only, --allow-other-version, --from offsite and the key file's text", async () => {
    const ctx = await setup();
    const identity = `AGE-SECRET-KEY-1${"F".repeat(58)}`;
    await writeFile(path.join(project().root, "age.txt"), `${identity}\n`);
    fake.answers.restoreSnapshot = async () => RESTORED;
    expect(
      await run(
        ctx,
        "restore",
        ` ${ID} `,
        "--env",
        "staging",
        "--only",
        " db ",
        "--allow-other-version",
        "--from",
        "offsite",
        "--key-file",
        "age.txt",
      ),
      ctx.errors,
    ).toBe(0);
    expect(lastCall(fake.calls, "restoreSnapshot").args).toEqual([
      ID,
      { only: "db", allowOtherVersion: true, from: "offsite", identity: `${identity}\n` },
    ]);
    expect(lastCall(fake.calls, "restoreSnapshot").deps.paths.environment).toBe("staging");
    expect(ctx.output).toContain("run `opscrew verify --env staging` to check the app.");
    expect(ctx.output).not.toContain(identity);
  });

  it("passes the machines' fakes, and nothing else by default", async () => {
    const ctx = await setup();
    const docker = () => {
      throw new Error("not used");
    };
    withServices(ctx, { snapshot: { docker } });
    fake.answers.restoreSnapshot = async () => RESTORED;
    expect(await run(ctx, "restore", ID, "--env", "staging"), ctx.errors).toBe(0);
    expect(lastCall(fake.calls, "restoreSnapshot").args).toEqual([ID, { services: { docker } }]);
  });

  it("restores in a script only with --confirm <app> and --approve <hash>, showing what is lost", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.restoreSnapshot = asking(RESTORE, decisions, RESTORED, REFUSED);
    const base = ["restore", ID, "--env", "staging"];
    expect(
      await run(ctx, ...base, "--confirm", "shop-staging", "--approve", HASH),
      ctx.errors,
    ).toBe(0);
    expect(ctx.output).toContain("What is lost: everything written to db since");
    expect(ctx.output).toContain(`✓ ${RESTORE.title} (confirmed with --confirm shop-staging)`);
    expect(await run(ctx, ...base)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop-staging")).toBe(1);
    expect(await run(ctx, ...base, "--approve", HASH)).toBe(1);
    expect(decisions).toEqual([
      "approved",
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging (with --approve and the plan's hash), or run the command in a terminal",
      `--confirm shop-staging approves a restore only together with --approve and that plan's hash ${HASH}`,
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging (with --approve and the plan's hash), or run the command in a terminal",
    ]);
  });

  it("keeps the key file's text out of every output, error and audit entry", async () => {
    const identity = `AGE-SECRET-KEY-1${"G".repeat(58)}`;
    const ctx = await setup();
    await writeFile(path.join(project().root, "age.txt"), identity);
    fake.answers.restoreSnapshot = async (deps) => {
      deps.reporter.info(`Decrypting with ${identity}`);
      throw new OpsCrewError("SECRETS_KEY_REJECTED", `The key ${identity} does not open it.`);
    };
    expect(
      await run(
        ctx,
        "restore",
        ID,
        "--env",
        "staging",
        "--from",
        "offsite",
        "--key-file",
        "age.txt",
      ),
    ).toBe(2);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(identity);
    expect(await auditText(project())).not.toContain(identity);
  });
});

describe("opscrew restore --server", () => {
  it("rebuilds in a script only with --confirm <server name> and --approve <hash>", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.restoreServerSnapshot = asking(REBUILD, decisions, REBUILT, REFUSED);
    const base = ["restore", "--server", " 9001 ", "--env", "staging"];
    expect(
      await run(ctx, ...base, "--confirm", "shop-staging", "--approve", HASH),
      ctx.errors,
    ).toBe(0);
    expect(lastCall(fake.calls, "restoreServerSnapshot").args).toEqual(["9001", {}]);
    expect(ctx.output).toContain(`Restore hash: ${HASH}`);
    expect(ctx.output).toContain(`✓ ${REBUILD.title} (confirmed with --confirm shop-staging)`);
    expect(await run(ctx, ...base, "--confirm", "shop-staging")).toBe(1);
    expect(await run(ctx, ...base, "--approve", HASH)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop-staging", "--approve", OTHER)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop", "--approve", HASH)).toBe(1);
    expect(decisions).toEqual([
      "approved",
      `--confirm shop-staging approves a restore only together with --approve and that plan's hash ${HASH}`,
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging (with --approve and the plan's hash), or run the command in a terminal",
      `--confirm shop-staging approves a restore only together with --approve and that plan's hash ${HASH}`,
      "a restore needs shop-staging typed to confirm: add --confirm shop-staging",
    ]);
  });

  it("asks a terminal, which types the name", async () => {
    const ctx = await setup({ interactive: true });
    let asked: ApprovalRequest | undefined;
    withServices(ctx, {
      approvalHandler: {
        request: async (request) => {
          asked = request;
          return {
            approved: true,
            approver: "test",
            decidedAt: "2026-10-11T12:00:00.000Z",
            ...(request.confirmPhrase === undefined ? {} : { confirmation: request.confirmPhrase }),
          };
        },
      },
    });
    fake.answers.restoreServerSnapshot = asking(REBUILD, [], REBUILT, REFUSED);
    expect(await run(ctx, "restore", "--server", "9001", "--env", "staging"), ctx.errors).toBe(0);
    expect(asked?.confirmPhrase).toBe("shop-staging");
  });

  it("says to verify when this computer could not check the app", async () => {
    const ctx = await setup();
    fake.answers.restoreServerSnapshot = async () => ({ ...REBUILT, checked: false });
    expect(await run(ctx, "restore", "--server", "9001", "--env", "staging"), ctx.errors).toBe(0);
    expect(ctx.output).toContain("run `opscrew verify --env staging` to check the app.");
  });

  it("never shows a secret the agent's text holds", async () => {
    const token = fakeSecret("hcloud-token");
    const ctx = await setup({ env: { HCLOUD_TOKEN: token } });
    fake.answers.restoreServerSnapshot = async (deps) => {
      await deps.approvals.request({ ...REBUILD, details: `Read with ${token}` });
      throw new OpsCrewError("PROVIDER_ERROR", `Hetzner said ${token}.`);
    };
    expect(await run(ctx, "restore", "--server", "9001", "--env", "staging")).toBe(2);
    expect(`${ctx.output}${ctx.errors}`).not.toContain(token);
    expect(await auditText(project())).not.toContain(token);
  });
});

/** A drill's approval, as `drillSnapshot` asks it: destroy-grade, `<app>-drill`, its hash. */
const DRILL: ApprovalRequest = {
  kind: "remote-exec",
  title: `Run a restore drill of the snapshot ${ID} of staging on the app's server`,
  details: `The copy runs with no internet and without your production \`.env\`.\nDrill hash: ${HASH}`,
  planHash: HASH,
  allowDestroy: true,
  confirmPhrase: "shop-staging-drill",
};

/** The same drill in a Portainer, which asks it as a stack plan by its hash. */
const PORTAINER_DRILL: ApprovalRequest = {
  kind: "stack-apply",
  title: `Run a restore drill of the snapshot ${ID} of staging in your Portainer`,
  details: `Typing shop-staging-drill approves it.\nStack plan hash: ${HASH}`,
  planHash: HASH,
  allowDestroy: true,
  confirmPhrase: "shop-staging-drill",
};

/** A drill that ended healthy, as `drillSnapshot` reports it. */
const DRILLED = {
  id: ID,
  where: "on the app's server",
  outcome: "healthy",
  summary: `The snapshot ${ID} restored, and the app became healthy on it in 31 seconds.`,
  proves: "the snapshot restored into a throwaway shop-staging-drill Compose project",
  parts: [{ name: "db", size: 100, seconds: 12 }],
  health: { state: "healthy", seconds: 31 },
  tables: [{ service: "db", count: 42 }],
  removal: "removed",
  ownLogins: [],
};

describe("opscrew restore --drill", () => {
  it.each([
    [["--keep"], "--keep goes only with --drill."],
    [[ID, "--json"], "--json goes only with --drill."],
    [["--drill", "--server"], "--drill restores the snapshot where it is, into a throwaway copy"],
    [
      ["--drill", ID, "--from", "offsite", "--key-file", "age.txt"],
      "so it takes no --server, --from or --key-file",
    ],
    [["--drill", "--remove", ID], "--drill --remove takes no snapshot id"],
    [["--drill", "--remove", "--keep", "--only", "db"], "--drill --remove takes no --only, --keep"],
    [["--drill", "--approve", "abc"], "--approve expects the 64-character SHA-256 drill hash"],
    [[], "opscrew restore needs the snapshot's id."],
  ])("refuses %j", async (flags, message) => {
    const ctx = await setup();
    expect(await run(ctx, "restore", ...flags, "--env", "staging")).toBe(2);
    expect(ctx.errors).toContain(message);
    expect(fake.calls).toEqual([]);
  });

  it("drills the latest by default, or the id given with --only, --keep and --allow-other-version", async () => {
    const ctx = await setup();
    fake.answers.drillSnapshot = async () => DRILLED;
    expect(await run(ctx, "restore", "--drill", "--env", "staging"), ctx.errors).toBe(0);
    expect(lastCall(fake.calls, "drillSnapshot").args).toEqual([undefined, {}]);
    expect(lastCall(fake.calls, "drillSnapshot").deps.paths.environment).toBe("staging");
    const flags = ["--only", " db ", "--keep", "--allow-other-version"];
    expect(await run(ctx, "restore", "--drill", ` ${ID} `, ...flags, "--env", "staging")).toBe(0);
    expect(lastCall(fake.calls, "drillSnapshot").args).toEqual([
      ID,
      { only: "db", keep: true, allowOtherVersion: true },
    ]);
    expect(await run(ctx, "restore", "--drill", "--remove", "--env", "staging")).toBe(0);
    expect(lastCall(fake.calls, "drillSnapshot").args).toEqual([undefined, { remove: true }]);
    expect(fake.calls.map((call) => call.name)).not.toContain("restoreSnapshot");
  });

  it("prints the report with --json, and fails a drill that did not end healthy", async () => {
    const ctx = await setup();
    fake.answers.drillSnapshot = async (deps) => {
      deps.reporter.step("Running the restore drill");
      return DRILLED;
    };
    expect(await run(ctx, "restore", "--drill", "--json", "--env", "staging"), ctx.errors).toBe(0);
    expect(JSON.parse(ctx.output)).toEqual(DRILLED);
    fake.answers.drillSnapshot = async () => ({ ...DRILLED, outcome: "unhealthy" });
    expect(await run(ctx, "restore", "--drill", "--env", "staging")).toBe(1);
    fake.answers.drillSnapshot = async () => ({ ...DRILLED, outcome: "skipped", reason: "locked" });
    expect(await run(ctx, "restore", "--drill", "--env", "staging")).toBe(1);
  });

  it("drills in a script only with --confirm <app>-drill and --approve <hash>", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.drillSnapshot = asking(DRILL, decisions, DRILLED, REFUSED);
    const base = ["restore", "--drill", ID, "--env", "staging"];
    expect(
      await run(ctx, ...base, "--confirm", "shop-staging-drill", "--approve", HASH),
      ctx.errors,
    ).toBe(0);
    expect(ctx.output).toContain(`Drill hash: ${HASH}`);
    expect(ctx.output).toContain(`✓ ${DRILL.title} (confirmed with --confirm shop-staging-drill)`);
    expect(await run(ctx, ...base, "--confirm", "shop-staging", "--approve", HASH)).toBe(1);
    expect(await run(ctx, ...base, "--approve", HASH)).toBe(1);
    expect(decisions[0]).toBe("approved");
    expect(decisions.slice(1).every((decision) => decision !== "approved")).toBe(true);
  });

  it("drills in a Portainer in a script with --confirm <app>-drill and its stack plan's hash", async () => {
    const ctx = await setup();
    const decisions: (string | undefined)[] = [];
    fake.answers.drillSnapshot = asking(PORTAINER_DRILL, decisions, DRILLED, REFUSED);
    const base = ["restore", "--drill", ID, "--env", "staging"];
    expect(
      await run(ctx, ...base, "--confirm", "shop-staging-drill", "--approve", HASH),
      ctx.errors,
    ).toBe(0);
    expect(ctx.output).toContain(`Stack plan hash: ${HASH}`);
    expect(ctx.output).toContain(
      `✓ ${PORTAINER_DRILL.title} (confirmed with --confirm shop-staging-drill)`,
    );
    expect(await run(ctx, ...base, "--approve", HASH)).toBe(1);
    expect(await run(ctx, ...base, "--confirm", "shop-staging-drill", "--approve", OTHER)).toBe(1);
    expect(decisions[0]).toBe("approved");
    expect(decisions.slice(1).every((decision) => decision !== "approved")).toBe(true);
  });

  it("lists the drill's flags in its help", async () => {
    const ctx = await setup();
    expect(await run(ctx, "restore", "--help")).toBe(0);
    for (const flag of ["[id]", "--drill", "--keep", "--remove", "--json", "<app>-drill"]) {
      expect(ctx.output).toContain(flag);
    }
  });
});
