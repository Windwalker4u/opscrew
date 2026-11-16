import type { CommandResult } from "@opscrew/contracts";
import { findExecutable } from "@opscrew/core";
import { z } from "zod";
import type { McpClientsAction, McpSystem, Step } from "./types";

const NAME = "Claude Code";
/** OpsCrew's plugin, from its marketplace (the `opscrew-hub/opscrew` repository on GitHub). */
const PLUGIN = "opscrew@opscrew";
const ADD_MARKETPLACE = ["plugin", "marketplace", "add", "opscrew-hub/opscrew"];
const UNINSTALL = ["plugin", "uninstall", PLUGIN];

const pluginList = z.array(z.object({ id: z.string(), version: z.string().optional() }));
const marketplaceList = z.array(z.object({ name: z.string() }));

/**
 * Claude Code's step: OpsCrew's plugin (its MCP server and skills), through `claude plugin`.
 * Install adds the marketplace (one already added is fine), then installs the plugin, or updates
 * it when another version is installed; uninstall removes the plugin. Without a working `claude`
 * there is no step, or a refused one when the user named Claude Code (`named`).
 */
export async function claudeCodeStep(
  action: McpClientsAction,
  version: string,
  system: McpSystem,
  named: boolean,
): Promise<Step | undefined> {
  const claude = findExecutable("claude", system.env) ?? "claude";
  const run = (args: readonly string[]): Promise<CommandResult | undefined> =>
    system.runner.run(claude, args, { env: { ...system.env } }).catch(() => undefined);

  if ((await run(["--version"]))?.exitCode !== 0) {
    if (!named) return undefined;
    const next =
      action === "install"
        ? "OpsCrew can't add its plugin. Install Claude Code (or add its folder to PATH)"
        : "OpsCrew can't remove its plugin. If Claude Code is installed, add its folder to PATH";
    return {
      app: NAME,
      refused: true,
      show: `${NAME}: the \`claude\` command didn't run, so ${next}, then run this again.`,
    };
  }

  const listed = await run(["plugin", "list", "--json"]);
  const plugins = pluginList.safeParse(parsedJson(listed));
  if (!plugins.success) {
    const commands = action === "install" ? [ADD_MARKETPLACE, installing("install")] : [UNINSTALL];
    return {
      app: NAME,
      refused: true,
      show: `${NAME}: OpsCrew couldn't read its plugins (\`claude plugin list --json\`${detail(listed)}). Run ${commands.length === 1 ? "this" : "these"} in your terminal instead:\n${commandLines(commands)}`,
    };
  }
  const installed = plugins.data.find((plugin) => plugin.id === PLUGIN);

  if (action === "uninstall") {
    if (installed === undefined) return { app: NAME, show: `${NAME}: not set up.` };
    return {
      app: NAME,
      show: `${NAME}: removes OpsCrew's plugin:\n${commandLines([UNINSTALL])}`,
      apply: async () => {
        const removed = await run(UNINSTALL);
        if (removed?.exitCode !== 0) return failed(UNINSTALL, removed);
        return { ok: true, text: `${NAME}: removed OpsCrew's plugin.` };
      },
    };
  }

  if (installed?.version === version) {
    return { app: NAME, show: `${NAME}: already set up with this version.` };
  }
  const verb = installed === undefined ? "install" : "update";
  const install = installing(verb);
  return {
    app: NAME,
    show: `${NAME}: ${verb}s OpsCrew's plugin (its MCP server and skills):\n${commandLines([ADD_MARKETPLACE, install])}`,
    apply: async () => {
      const added = await run(ADD_MARKETPLACE);
      if (added?.exitCode !== 0 && !(await marketplaceAdded())) {
        return failed(ADD_MARKETPLACE, added);
      }
      const done = await run(install);
      if (done?.exitCode !== 0) return failed(install, done);
      const past = verb === "install" ? "installed" : "updated";
      return { ok: true, text: `${NAME}: ${past} OpsCrew's plugin.` };
    },
  };

  /** True when Claude Code lists OpsCrew's marketplace (`add` may refuse one already added). */
  async function marketplaceAdded(): Promise<boolean> {
    const marketplaces = marketplaceList.safeParse(
      parsedJson(await run(["plugin", "marketplace", "list", "--json"])),
    );
    return marketplaces.success && marketplaces.data.some(({ name }) => name === "opscrew");
  }
}

function installing(verb: "install" | "update"): string[] {
  return ["plugin", verb, PLUGIN];
}

function commandLines(commands: readonly (readonly string[])[]): string {
  return commands.map((args) => `  claude ${args.join(" ")}`).join("\n");
}

function failed(args: readonly string[], result: CommandResult | undefined) {
  return {
    ok: false,
    text: `${NAME}: \`claude ${args.join(" ")}\` failed${detail(result)}. Run it in your terminal to see what Claude Code needs.`,
  };
}

/** `: <what the command printed>` without its final period, or nothing. */
function detail(result: CommandResult | undefined): string {
  const text = (result?.stderr.trim() || result?.stdout.trim() || "").replace(/\.$/, "");
  return text === "" ? "" : `: ${text}`;
}

/** The command's output as JSON, when it succeeded and printed JSON. */
function parsedJson(result: CommandResult | undefined): unknown {
  if (result?.exitCode !== 0) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}
