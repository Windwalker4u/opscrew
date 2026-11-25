import { homedir } from "node:os";
import type { Readable } from "node:stream";
import { NodeCommandRunner } from "@opscrew/core";
import { startStdioServer } from "@opscrew/mcp-server";
import type { Command } from "commander";
import type { CliContext } from "../context";
import { promptsOf, servicesOf } from "../deps";
import { CliExit } from "../exit";
import { CLIENT_IDS, type McpClientsAction, runMcpClients } from "../mcp-clients";

/** Resolves when `stdin` ends or closes, or (for the process's stdin) on SIGINT/SIGTERM. */
function untilClosed(stdin: Readable, isProcessStdin: boolean): Promise<void> {
  return new Promise((resolve) => {
    const events = ["end", "close"] as const;
    const signals = isProcessStdin ? (["SIGINT", "SIGTERM"] as const) : [];
    const done = () => {
      for (const event of events) stdin.off(event, done);
      for (const signal of signals) process.off(signal, done);
      resolve();
    };
    if (stdin.readableEnded || stdin.destroyed) {
      resolve();
      return;
    }
    for (const event of events) stdin.once(event, done);
    for (const signal of signals) process.once(signal, done);
  });
}

/**
 * `opscrew mcp install|uninstall`: OpsCrew's server in the AI apps on this computer. The apps start
 * it from npm, so a build between releases (`<version>-dev…`) sets up its release, `<version>`.
 */
async function setUp(
  ctx: CliContext,
  action: McpClientsAction,
  options: { client?: string[]; yes?: boolean },
): Promise<void> {
  const services = servicesOf(ctx);
  const code = await runMcpClients({
    action,
    clients: options.client,
    yes: options.yes === true,
    interactive: ctx.isInteractive,
    version: ctx.version.replace(/-dev(?:\..*)?$/, ""),
    system: {
      home: services.homedir ?? homedir(),
      env: ctx.env,
      platform: process.platform,
      runner: services.runner ?? new NodeCommandRunner(),
    },
    prompts: promptsOf(ctx),
    out: (text) => ctx.stdout(text),
  });
  if (code !== 0) throw new CliExit(code);
}

/**
 * `opscrew mcp`: serves the OpsCrew MCP tools over stdio for the project in the current directory
 * until the client closes the connection. Standard output is the MCP channel, so every message of
 * this command goes to standard error. `opscrew mcp install` and `uninstall` add the server to the
 * AI apps on this computer, or remove it.
 */
export function register(program: Command, ctx: CliContext): void {
  const mcp = program
    .command("mcp")
    .description("Start the OpsCrew MCP server over stdio, or add it to your AI apps")
    .action(async () => {
      const { fetch, runner, clock, mcp } = servicesOf(ctx);
      const streams = mcp ?? {};
      const stdin = streams.stdin ?? process.stdin;
      const running = await startStdioServer({
        version: ctx.version,
        cwd: ctx.cwd,
        env: ctx.env,
        redactor: ctx.redactor,
        log: (message) => ctx.stderr(`[opscrew mcp] ${message}\n`),
        stdin,
        ...(streams.stdout === undefined ? {} : { stdout: streams.stdout }),
        ...(fetch === undefined ? {} : { fetch }),
        ...(runner === undefined ? {} : { runner }),
        ...(clock === undefined ? {} : { clock }),
      });
      try {
        await untilClosed(stdin, streams.stdin === undefined);
      } finally {
        await running.close();
      }
      ctx.stderr("[opscrew mcp] Client disconnected; server stopped.\n");
    });
  const clientOption = `Only these apps, even when they aren't found: ${CLIENT_IDS.join(", ")}`;
  mcp
    .command("install")
    .description(
      "Add OpsCrew's MCP server to Claude Code, Claude Desktop, Codex, Cursor and VS Code (shows each file's change and asks first; writes no token)",
    )
    .option("--client <id...>", clientOption)
    .option("--yes", "Make the changes without asking (a script needs it)")
    .action((options: { client?: string[]; yes?: boolean }) => setUp(ctx, "install", options));
  mcp
    .command("uninstall")
    .description("Remove OpsCrew's MCP server from those apps, leaving the rest of their files")
    .option("--client <id...>", clientOption)
    .option("--yes", "Make the changes without asking (a script needs it)")
    .action((options: { client?: string[]; yes?: boolean }) => setUp(ctx, "uninstall", options));
}
