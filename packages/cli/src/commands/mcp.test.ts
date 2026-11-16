import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import type { CommandRunner } from "@opscrew/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { withServices } from "../deps";
import { createTestContext } from "../test-context";
import { projectContext, run, type TempProject, tempProject } from "../ui/__fixtures__/harness";

let project: TempProject | undefined;
afterEach(async () => {
  await project?.cleanup();
  project = undefined;
});

/** Collects the newline-delimited JSON-RPC messages written to `stream`. */
function messages(stream: PassThrough) {
  const received: Array<Record<string, unknown>> = [];
  let buffer = "";
  stream.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) received.push(JSON.parse(line));
      index = buffer.indexOf("\n");
    }
  });
  return {
    async waitFor(id: number) {
      for (let i = 0; i < 300; i++) {
        const found = received.find((m) => m.id === id);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`No response with id ${id}`);
    },
  };
}

describe("opscrew mcp", () => {
  it("serves MCP on the given streams, logs to stderr and stops when stdin closes", async () => {
    project = await tempProject();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out = messages(stdout);
    const ctx = projectContext(project);
    withServices(ctx, { mcp: { stdin, stdout } });

    const exit = run(ctx, "mcp");
    const send = (message: unknown) => stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    const init = (await out.waitFor(1)) as {
      result: { serverInfo: { name: string; version: string } };
    };
    expect(init.result.serverInfo).toMatchObject({ name: "opscrew", version: ctx.version });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = (await out.waitFor(2)) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((tool) => tool.name)).toContain("opscrew_scan");

    stdin.end();
    expect(await exit).toBe(0);
    expect(ctx.output).toBe("");
    expect(ctx.errors).toContain("[opscrew mcp] OpsCrew MCP server");
    expect(ctx.errors).toContain(`(project: ${project.root})`);
    expect(ctx.errors).toContain("server stopped");
  });
});

describe("opscrew mcp install and uninstall", () => {
  let home: string | undefined;
  afterEach(async () => {
    if (home !== undefined) await rm(path.dirname(home), { recursive: true, force: true });
    home = undefined;
  });

  /** A context whose home is a temporary folder and on which `claude` isn't installed. */
  async function context(options: { interactive?: boolean } = {}) {
    home = path.join(await mkdtemp(path.join(tmpdir(), "opscrew-mcp-install-")), "home");
    await mkdir(home);
    const calls: string[] = [];
    const runner: CommandRunner = {
      run: async (command, args) => {
        calls.push([path.basename(command), ...args].join(" "));
        return { exitCode: 127, stdout: "", stderr: "not found" };
      },
    };
    const ctx = createTestContext({
      env: { PATH: "" },
      isInteractive: options.interactive ?? false,
    });
    withServices(ctx, { homedir: home, runner });
    return { ctx, home, calls };
  }

  it("adds OpsCrew's server to the apps named with --client, then removes it", async () => {
    const { ctx, home } = await context();
    const cursor = path.join(home, ".cursor", "mcp.json");
    const codex = path.join(home, ".codex", "config.toml");
    expect(await run(ctx, "mcp", "install", "--client", "cursor", "codex", "--yes")).toBe(0);
    expect(JSON.parse(await readFile(cursor, "utf8"))).toEqual({
      mcpServers: { opscrew: { command: "npx", args: ["-y", "opscrew@9.9.9-test", "mcp"] } },
    });
    expect(await readFile(codex, "utf8")).toContain('args = ["-y", "opscrew@9.9.9-test", "mcp"]');
    expect(ctx.output).toContain("Restart Cursor to load OpsCrew.\n");
    expect(ctx.output).toContain("https://docs.opscrew.dev/mcp-clients/");
    expect(ctx.errors).toBe("");

    expect(await run(ctx, "mcp", "uninstall", "--client", "cursor", "--yes")).toBe(0);
    expect(JSON.parse(await readFile(cursor, "utf8"))).toEqual({ mcpServers: {} });
    expect(await readFile(codex, "utf8")).toContain("[mcp_servers.opscrew]");
  });

  it("changes nothing in a script without --yes, and refuses an unknown id", async () => {
    const { ctx, home, calls } = await context();
    expect(await run(ctx, "mcp", "install", "--client", "cursor")).toBe(1);
    expect(ctx.output).toContain("run `opscrew mcp install --client cursor --yes`.");
    expect(await run(ctx, "mcp", "install", "--client", "windsurf", "--yes")).toBe(2);
    expect(ctx.errors).toContain(`OpsCrew doesn't set up "windsurf".`);
    expect(ctx.errors).toContain("claude-code, claude-desktop, codex, cursor and vscode");
    expect(await readdir(home)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("says what it looked for when no app is found", async () => {
    const { ctx, calls } = await context({ interactive: true });
    expect(await run(ctx, "mcp", "install")).toBe(0);
    expect(ctx.output).toContain("OpsCrew found none of the AI apps it sets up on this computer");
    expect(calls).toEqual(["claude --version"]);
  });

  it("lists install and uninstall in its help", async () => {
    const ctx = createTestContext();
    expect(await run(ctx, "mcp", "--help")).toBe(0);
    expect(ctx.output).toMatch(/^\s+install \[options\]/m);
    expect(ctx.output).toMatch(/^\s+uninstall \[options\]/m);
    expect(await run(ctx, "mcp", "install", "--help")).toBe(0);
    expect(ctx.output).toContain("--client <id...>");
    expect(ctx.output).toContain("--yes");
  });
});
