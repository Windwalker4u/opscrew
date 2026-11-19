import type { PhaseDeps } from "@opscrew/agents";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../ui/__fixtures__/harness";
import { type AgentCall, lastCall, stagingProjects } from "../ui/__fixtures__/snapshots";

/** Each call of a phase that looks for other apps on the server; each stops after its options. */
const fake = vi.hoisted(() => ({ calls: [] as AgentCall[] }));

vi.mock("@opscrew/agents", async (importOriginal) => {
  const agents = await importOriginal<typeof import("@opscrew/agents")>();
  const { OpsCrewError } = await import("@opscrew/core");
  const faked = <K extends keyof typeof agents>(name: K) =>
    (async (deps: PhaseDeps, ...args: unknown[]) => {
      fake.calls.push({ name, deps, args });
      throw new OpsCrewError("PHASE_PRECONDITION", "Stopped by the test. Nothing was changed.");
    }) as unknown as (typeof agents)[K];
  return {
    ...agents,
    runDestroy: faked("runDestroy"),
    runRetarget: faked("runRetarget"),
    runProvision: faked("runProvision"),
    runDns: faked("runDns"),
    restoreServerSnapshot: faked("restoreServerSnapshot"),
    closePublicSsh: faked("closePublicSsh"),
    openPublicSsh: faked("openPublicSsh"),
    addonEnable: faked("addonEnable"),
    portainerEnable: faked("portainerEnable"),
    vpnAdd: faked("vpnAdd"),
  };
});

const { setup } = stagingProjects();
beforeEach(() => {
  fake.calls.length = 0;
});

const FLAG = "--skip-other-apps-check";

/** Each command with the flag, the phase it reaches and how it is run (staging's, in a script). */
const COMMANDS: [phase: string, args: string[]][] = [
  ["runDestroy", ["destroy", "--env", "staging", "--confirm", "shop-staging"]],
  ["runRetarget", ["retarget", "--env", "staging", "--to", "digitalocean"]],
  ["runProvision", ["provision", "--env", "staging", "--plan-only"]],
  ["runDns", ["dns", "--env", "staging", "--plan-only"]],
  ["restoreServerSnapshot", ["restore", "--server", "9001", "--env", "staging"]],
  ["closePublicSsh", ["secure", "--close-public-ssh", "--env", "staging"]],
  ["openPublicSsh", ["secure", "--open-public-ssh", "--env", "staging"]],
  ["addonEnable", ["addon", "enable", "beszel", "--env", "staging"]],
  ["portainerEnable", ["portainer", "enable"]],
  ["vpnAdd", ["vpn", "add", "laptop", "--env", "staging"]],
];

/** The options the phase was called with: its last argument. */
function optionsOf(phase: string): { skipOtherAppsCheck?: boolean } {
  return lastCall(fake.calls, phase).args.at(-1) as { skipOtherAppsCheck?: boolean };
}

describe("--skip-other-apps-check", () => {
  it.each(COMMANDS)("reaches %s's option, and only when given", async (phase, args) => {
    const given = await setup();
    expect(await run(given, ...args, FLAG), given.errors).toBe(1);
    expect(given.errors).toContain("Stopped by the test.");
    expect(optionsOf(phase).skipOtherAppsCheck).toBe(true);

    const without = await setup();
    expect(await run(without, ...args), without.errors).toBe(1);
    expect(optionsOf(phase).skipOtherAppsCheck).toBeUndefined();
  });

  it.each([
    "destroy",
    "retarget",
    "provision",
    "dns",
    "restore",
    "secure",
    "addon enable",
    "portainer enable",
    "vpn add",
  ])("is in the help of %s", async (command) => {
    const ctx = await setup();
    expect(await run(ctx, ...command.split(" "), "--help")).toBe(0);
    const help = ctx.output.replace(/\s+/g, " ").toLowerCase();
    expect(help).toContain(FLAG);
    expect(help).toContain(
      "go on when opscrew can't look at the server for other apps, or when only their kept data is there",
    );
  });

  it.each([
    [
      ["restore", "20261106T190000Z", "--env", "staging"],
      "--skip-other-apps-check goes only with --server",
    ],
    [["restore", "--drill", "--env", "staging"], "--skip-other-apps-check goes only with --server"],
    [
      ["secure", "--env", "staging"],
      "--skip-other-apps-check goes with --close-public-ssh or --open-public-ssh",
    ],
    [
      ["retarget", "--finish", "--env", "staging"],
      "option '--skip-other-apps-check' cannot be used with option '--finish'",
    ],
    [
      ["addon", "enable", "monitoring", "--env", "staging"],
      "only writes the plan, so --skip-other-apps-check does not apply to it",
    ],
  ])("is refused where no change can break other apps: %j", async (args, message) => {
    const ctx = await setup();
    expect(await run(ctx, ...args, FLAG)).toBe(2);
    expect(ctx.errors.replace(/\s+/g, " ")).toContain(message);
    expect(fake.calls).toEqual([]);
  });
});
