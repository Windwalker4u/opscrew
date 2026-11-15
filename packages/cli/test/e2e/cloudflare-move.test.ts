/**
 * End-to-end move to another Cloudflare account with fakes (T2824): each step of
 * `opscrew cloudflare move` runs through the real CLI (its flags, its approval handler, its
 * output) against that step's fake world from `@opscrew/agents/testing`: prepare and the abort for
 * a cloud server, the user's own server in tunnel mode and a Workers site, the switch, and the
 * finish's stops. Scripts stop at each plan with the exact command to run next, and the test runs
 * that command; a terminal run asks and the names are typed. No real engine, Cloudflare account,
 * registrar, GitHub or server is reached (the continuous run of the four steps is the live pass's).
 */

import {
  abortHarness,
  finishWorld,
  type PrepareTarget,
  prepareWorld,
  ScriptedRunner,
  sitePlan,
  switchHarness,
} from "@opscrew/agents/testing";
import type { ApprovalHandler } from "@opscrew/contracts";
import { DeployPlanSchema, readArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { InteractiveApprovalHandler } from "../../src/approval";
import type { CliServices } from "../../src/deps";
import { withServices } from "../../src/deps";
import { createTestContext, type TestContext } from "../../src/test-context";
import { GIT, run, ScriptedPrompts } from "../../src/ui/__fixtures__/harness";

const STEP_TIMEOUT = 120_000;
const ZONE = "example.com";
const HASH = /^[0-9a-f]{64}$/;

/** What a world gives the CLI: its project, its environment and its fakes. */
interface World {
  root: string;
  deps: {
    env: Record<string, string | undefined>;
    fetch: NonNullable<CliServices["fetch"]>;
    runner: NonNullable<CliServices["runner"]>;
    clock: NonNullable<CliServices["clock"]>;
  };
  services: NonNullable<CliServices["cloudflareMove"]>;
}

/** A terminal that agrees to every question and types each name it is asked for. */
function agreeingTerminal(): {
  prompts: ScriptedPrompts;
  approvals: ApprovalHandler;
  typed: string[];
} {
  const typed: string[] = [];
  const answers = {
    confirm: async () => true,
    text: async (options: { placeholder?: string }) => {
      typed.push(options.placeholder ?? "");
      return options.placeholder ?? "";
    },
    isCancel: (value: unknown): value is symbol => typeof value === "symbol",
  };
  const approvals = new InteractiveApprovalHandler({
    stdout: () => {},
    prompts: answers,
    runner: new ScriptedRunner(),
    osUserName: () => "tester",
  });
  // The start's question, the only prompt the command asks itself.
  return { prompts: new ScriptedPrompts([true]), approvals, typed };
}

/** Runs `opscrew cloudflare move <args>` in `w`'s project: a script's run, or a terminal's. */
function move(w: World, args: readonly string[], terminal?: ReturnType<typeof agreeingTerminal>) {
  return opscrew(w, ["cloudflare", "move", ...args], terminal);
}

/** Runs `opscrew <args>` in `w`'s project with its fakes. */
async function opscrew(
  w: World,
  args: readonly string[],
  terminal?: ReturnType<typeof agreeingTerminal>,
) {
  const ctx: TestContext = createTestContext({
    cwd: w.root,
    env: w.deps.env,
    isInteractive: terminal !== undefined,
  });
  withServices(ctx, {
    cloudflareMove: w.services,
    fetch: w.deps.fetch,
    runner: w.deps.runner,
    clock: w.deps.clock,
    ...(terminal === undefined
      ? {}
      : { prompts: terminal.prompts, approvalHandler: terminal.approvals }),
  });
  const code = await run(ctx, ...args);
  const text = ctx.output + ctx.errors;
  // The exact command the run says to run next: a stop's next step, or a refused plan's hint.
  const next = /(?:`|run: )opscrew cloudflare move ([^`\n]*?--approve [0-9a-f]{64})/.exec(
    text,
  )?.[1];
  // A stop prints its plan's hash on a line of its own; a refused plan names it in its hint.
  const hash =
    /Plan hash \(SHA-256\): ([0-9a-f]{64})/.exec(ctx.output)?.[1] ?? next?.split(" ").at(-1);
  return { code, text, hash, next: next?.split(" ") };
}

/**
 * Runs `args` as a script, then each command it prints, until the step is done; every stop names
 * the hash it prints. Returns the runs.
 */
async function scripted(w: World, args: readonly string[]) {
  const runs = [await move(w, args)];
  for (let last = runs[0]; last?.code === 1; last = runs.at(-1)) {
    expect(last.hash, last.text).toMatch(HASH);
    expect(last.next, last.text).toBeDefined();
    expect(last.next).toContain(last.hash);
    if (runs.length > 15) throw new Error("the step never ends");
    runs.push(await move(w, last.next ?? []));
  }
  const done = runs.at(-1);
  expect(done?.code, done?.text).toBe(0);
  return runs;
}

const TARGETS: readonly PrepareTarget[] = ["cloud", "own-tunnel", "site"];

describe.skipIf(!GIT)("opscrew cloudflare move --to: prepare", () => {
  it.each(TARGETS)(
    "a script prepares %s in the new account, one printed command after another",
    async (target) => {
      const w = await prepareWorld(target);
      const runs = await scripted(w, ["--to", "New"]);
      expect(runs.length).toBeGreaterThan(2);
      // The first run shows the summary and changes nothing before the first plan's hash.
      expect(runs[0]?.text).toContain(`--approve ${runs[0]?.hash}`);
      const plan = await w.planNow();
      expect(plan.cloudflareMove?.step).toBe("prepared");
      expect(runs.at(-1)?.text).toContain("opscrew cloudflare move --switch");
      expect(w.wroteToA()).toBe(false);
      expect(await w.leaks(...runs.map((one) => one.text))).toBe(false);
    },
    STEP_TIMEOUT,
  );

  it(
    "`opscrew status` shows each environment's step, and the apps prepared only with the new account's token",
    async () => {
      const w = await prepareWorld("site");
      await scripted(w, ["--to", "New"]);
      const status = await opscrew(w, ["status"]);
      expect(status.code, status.text).toBe(0);
      expect(status.text).toContain(`cloudflare  moving ${ZONE} to another Cloudflare account`);
      expect(status.text).toContain("prod  prepared in the new account");
      const app = (await w.planNow()).app.name;
      expect(status.text).toContain(`apps prepared in the new account: ${app} (prod)`);
      expect(status.text).toContain("`opscrew cloudflare move --switch` once every app");

      const withoutB = { ...w.deps.env, OPSCREW_NEW_CLOUDFLARE_API_TOKEN: undefined };
      const reads = w.cloudflare.calls.length;
      const plain = await opscrew({ ...w, deps: { ...w.deps, env: withoutB } }, ["status"]);
      expect(plain.text).toContain("prod  prepared in the new account");
      expect(plain.text).not.toContain("apps prepared in the new account");
      // Nothing is read from the new account's zone without its token.
      const bZone = w.cloudflare.zone(ZONE, "New").id;
      expect(w.cloudflare.calls.slice(reads).filter((call) => call.path.includes(bZone))).toEqual(
        [],
      );
      // `opscrew status` shows the server's address by design; no token ever.
      for (const token of Object.values(w.tokens))
        expect(status.text + plain.text).not.toContain(token);
    },
    STEP_TIMEOUT,
  );

  it(
    "in a terminal: the start asked once, each plan approved there",
    async () => {
      const w = await prepareWorld("site");
      const terminal = agreeingTerminal();
      const done = await move(w, ["--to", "New"], terminal);
      expect(done.code, done.text).toBe(0);
      expect(terminal.prompts.calls.map((call) => call.message)).toEqual([
        `Start moving ${ZONE} to the Cloudflare account New?`,
      ]);
      expect((await w.planNow()).cloudflareMove?.step).toBe("prepared");
      expect(await w.leaks(done.text)).toBe(false);
    },
    STEP_TIMEOUT,
  );

  it(
    "refuses --to with another step, and --env, before anything is read",
    async () => {
      const w = await prepareWorld("cloud");
      const both = await move(w, ["--to", "New", "--finish"]);
      expect(both.code).toBe(2);
      expect(both.text).toContain("--to only applies when preparing the move, not with --finish.");
      const env = await move(w, ["--to", "New", "--env", "prod"]);
      expect(env.code).toBe(2);
      expect(env.text).toContain("The move takes no --env");
      expect(w.cloudflare.calls).toEqual([]);
    },
    STEP_TIMEOUT,
  );
});

describe.skipIf(!GIT)("opscrew cloudflare move --switch", () => {
  it(
    "a script stops with the exact command, which types the zone and applies the plan",
    async () => {
      const w = await switchHarness();
      const stopped = await move(w, ["--switch"]);
      expect(stopped.code, stopped.text).toBe(1);
      expect(stopped.hash).toMatch(HASH);
      expect(stopped.next).toEqual(["--switch", "--confirm", ZONE, "--approve", stopped.hash]);
      expect(w.writes("New")).toEqual([]);

      // The hash alone is not enough: the zone must be typed.
      const untyped = await move(w, ["--switch", "--approve", stopped.hash ?? ""]);
      expect(untyped.code, untyped.text).toBe(1);
      expect(untyped.text).toContain(`--confirm ${ZONE}`);
      expect(w.writes("Old")).toEqual([]);

      const done = await move(w, stopped.next ?? []);
      expect(done.code, done.text).toBe(0);
      expect(done.text).toContain(`approved with --confirm ${ZONE} --approve`);
      expect(w.bZone.status).toBe("active");
      expect(done.text).toContain("opscrew cloudflare move --finish");
      expect(w.writes("Old")).toEqual([]);
      expect(w.leaks(stopped.text, untyped.text, done.text)).toBe(false);
    },
    STEP_TIMEOUT,
  );

  it(
    "in a terminal: the zone typed at the prompt",
    async () => {
      const w = await switchHarness();
      const terminal = agreeingTerminal();
      const done = await move(w, ["--switch"], terminal);
      expect(done.code, done.text).toBe(0);
      expect(terminal.typed).toEqual([ZONE]);
      expect(w.bZone.status).toBe("active");
    },
    STEP_TIMEOUT,
  );
});

describe.skipIf(!GIT)("opscrew cloudflare move --abort", () => {
  it(
    "a script removes the cloud server's pieces from the new account: the app's name, then the zone's, each with its hash",
    async () => {
      const w = await abortHarness();
      const runs = await scripted(w, ["--abort"]);
      const commands = runs.flatMap((one) => (one.next === undefined ? [] : [one.next.join(" ")]));
      expect(commands.some((command) => command.includes("--confirm shop --approve"))).toBe(true);
      expect(commands.some((command) => command.includes(`--confirm ${ZONE} --approve`))).toBe(
        true,
      );
      expect(runs.at(-1)?.text).toContain(`${ZONE} goes on serving from the account Old`);
      expect((await readArtifact("plan", w.prodPaths.files.plan)).cloudflareMove).toBeUndefined();
      expect(w.cloudflare.zones.some((z) => z.name === ZONE && z.accountId === w.fresh.id)).toBe(
        false,
      );
      expect(w.writes("Old")).toEqual([]);
      expect(await w.leaks([], ...runs.map((one) => one.text))).toBe(false);
    },
    STEP_TIMEOUT,
  );

  it(
    "a script without the names stops with the --confirm to add, deleting nothing",
    async () => {
      const w = await abortHarness();
      const first = await move(w, ["--abort"]);
      expect(first.code, first.text).toBe(1);
      const second = await move(w, first.next ?? []);
      expect(second.next).toContain("--confirm");
      const withoutName = (second.next ?? []).filter(
        (word, i, all) => word !== "--confirm" && all[i - 1] !== "--confirm",
      );
      const refused = await move(w, withoutName);
      expect(refused.code, refused.text).toBe(1);
      expect(refused.text).toContain("--confirm shop");
      expect(w.engine.applied).toEqual([]);
    },
    STEP_TIMEOUT,
  );

  it(
    "in a terminal: a Workers site's Worker removed from the new account, the names typed",
    async () => {
      const site = sitePlan({ domain: `shop.${ZONE}`, deployed: true });
      const plan = DeployPlanSchema.parse({
        ...site,
        infra: { ...site.infra, stateEncryption: false },
      });
      const w = await abortHarness({
        plan,
        shadow: { main: ["module.worker.cloudflare_workers_script.this"] },
      });
      const terminal = agreeingTerminal();
      const done = await move(w, ["--abort"], terminal);
      expect(done.code, done.text).toBe(0);
      expect(terminal.typed).toEqual([plan.app.name, ZONE]);
      expect((await readArtifact("plan", w.prodPaths.files.plan)).cloudflareMove).toBeUndefined();
      expect(w.writes("Old")).toEqual([]);
    },
    STEP_TIMEOUT,
  );
});

describe.skipIf(!GIT)("opscrew cloudflare move --finish", () => {
  it(
    "refuses while the new account's zone is pending, changing nothing",
    async () => {
      const w = await finishWorld("cloud", { step: "prepared" });
      w.bZone.status = "pending";
      const refused = await move({ ...w, services: w.session.services }, ["--finish"]);
      expect(refused.code, refused.text).toBe(1);
      expect(refused.text).toContain("Nothing was changed.");
      expect(w.aWrites()).toEqual([]);
    },
    STEP_TIMEOUT,
  );

  it.each(["cloud", "site"] as const)(
    "a script finishes %s to its end, its last line naming the files to commit",
    async (target) => {
      const w = await finishWorld(target, { step: "prepared" });
      const runs = await scripted({ ...w, services: w.session.services }, ["--finish"]);
      expect(lastLine(runs.at(-1)?.text)).toContain(
        "Commit and push the files the move changed (opscrew/plan.yaml and opscrew/infra/prod/terraform.tfvars.json)",
      );
      const plan = await readArtifact("plan", w.environment.paths.files.plan);
      expect(plan.cloudflareMove).toBeUndefined();
      expect(w.leaks(...runs.map((one) => one.text))).toBe(false);
    },
    STEP_TIMEOUT,
  );

  it(
    "in a terminal: a Workers site's finish asks there and ends with the files to commit",
    async () => {
      const w = await finishWorld("site", { step: "prepared" });
      const world = { ...w, services: w.session.services };
      const done = await move(world, ["--finish"], agreeingTerminal());
      expect(done.code, done.text).toBe(0);
      expect(lastLine(done.text)).toContain("Commit and push the files the move changed");
      expect(w.leaks(done.text)).toBe(false);
    },
    STEP_TIMEOUT,
  );
});

/** The last line a run printed. */
function lastLine(text: string | undefined): string | undefined {
  return text?.trim().split("\n").at(-1);
}
