import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandResult, CommandRunner } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UiPrompts } from "../ui/prompts";
import { CREDENTIAL_VARIABLES, codexEntry, codexTable } from "./entry";
import { type McpClientsOptions, runMcpClients } from "./run";
import type { McpClientsAction } from "./types";

const VERSION = "1.2.3";
const ARGS = ["-y", `opscrew@${VERSION}`, "mcp"];
const JSON_ENTRY = { command: "npx", args: ARGS };
const VSCODE_ENTRY = { type: "stdio", command: "npx", args: ARGS, tools: ["*"] };
const TOKEN_NOTE =
  "No token was written: OpsCrew reads your tokens from the environment each app starts in. How to set them: https://docs.opscrew.dev/mcp-clients/";

/** Where each OS keeps the apps' folders, under a temporary home. */
interface Layout {
  platform: NodeJS.Platform;
  env(home: string): Record<string, string>;
  desktop(home: string): string;
  /** The Microsoft Store Claude Desktop's folder (Windows only). */
  store?(home: string): string;
  vscodeUser(home: string): string;
}

const LAYOUTS: Layout[] = [
  {
    platform: "win32",
    env: (home) => ({
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
    }),
    desktop: (home) => path.join(home, "AppData", "Roaming", "Claude"),
    store: (home) =>
      path.join(
        home,
        "AppData",
        "Local",
        "Packages",
        "Claude_pzs8sxrjxfjjc",
        "LocalCache",
        "Roaming",
        "Claude",
      ),
    vscodeUser: (home) => path.join(home, "AppData", "Roaming", "Code", "User"),
  },
  {
    platform: "darwin",
    env: () => ({}),
    desktop: (home) => path.join(home, "Library", "Application Support", "Claude"),
    vscodeUser: (home) => path.join(home, "Library", "Application Support", "Code", "User"),
  },
  {
    platform: "linux",
    env: () => ({}),
    desktop: (home) => path.join(home, ".config", "Claude"),
    vscodeUser: (home) => path.join(home, ".config", "Code", "User"),
  },
];
const LINUX = LAYOUTS[2] as Layout;

/** Claude Code's `claude`, as far as `opscrew mcp` uses it; every call is recorded. */
class FakeClaude implements CommandRunner {
  readonly calls: string[] = [];
  installed: string | undefined;
  readonly marketplaces: string[];

  constructor(
    private readonly options: {
      missing?: boolean;
      installed?: string;
      marketplaces?: string[];
      failInstall?: boolean;
      /** `plugin list --json` fails, as in a Claude Code without it. */
      noList?: boolean;
    } = {},
  ) {
    this.installed = options.installed;
    this.marketplaces = [...(options.marketplaces ?? [])];
  }

  async run(command: string, args: readonly string[]): Promise<CommandResult> {
    const name = path.basename(command).replace(/\.(?:exe|cmd)$/i, "");
    this.calls.push([name, ...args].join(" "));
    // As the real runner does when the program isn't on PATH.
    if (name !== "claude" || this.options.missing === true) {
      throw new OpsCrewError("COMMAND_FAILED", `Could not run ${command}: it is not installed.`);
    }
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    const plugin = (version: string) => ({ id: "opscrew@opscrew", version, scope: "user" });
    switch (args.join(" ")) {
      case "--version":
        return ok("2.1.0 (Claude Code)\n");
      case "plugin list --json":
        if (this.options.noList === true) {
          return { exitCode: 1, stdout: "", stderr: "error: unknown option '--json'" };
        }
        return ok(JSON.stringify(this.installed === undefined ? [] : [plugin(this.installed)]));
      case "plugin marketplace list --json":
        return ok(JSON.stringify(this.marketplaces.map((m) => ({ name: m, source: "github" }))));
      case "plugin marketplace add opscrew-hub/opscrew":
        if (this.marketplaces.includes("opscrew")) {
          return { exitCode: 1, stdout: "", stderr: "Marketplace 'opscrew' is already added." };
        }
        this.marketplaces.push("opscrew");
        return ok("Added the marketplace.\n");
      case "plugin install opscrew@opscrew":
      case "plugin update opscrew@opscrew":
        if (this.options.failInstall === true) {
          return { exitCode: 1, stdout: "", stderr: "Could not reach github.com." };
        }
        this.installed = "0.9.0";
        return ok();
      case "plugin uninstall opscrew@opscrew":
        this.installed = undefined;
        return ok();
      default:
        throw new Error(`Unexpected call: claude ${args.join(" ")}`);
    }
  }
}

const CANCEL = Symbol("cancel");

/** Prompts that answer `confirm` from `answers` and record each question. */
function confirmPrompts(...answers: (boolean | symbol)[]): UiPrompts & { asked: string[] } {
  const asked: string[] = [];
  const unexpected = () => Promise.reject(new Error("Unexpected prompt."));
  return {
    asked,
    select: unexpected,
    multiselect: unexpected,
    text: unexpected,
    password: unexpected,
    confirm: async ({ message }) => {
      asked.push(message);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`No answer for "${message}".`);
      return answer;
    },
    isCancel: (value): value is symbol => value === CANCEL,
  };
}

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "opscrew-mcp-clients-"));
  home = path.join(dir, "home");
  await mkdir(home);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

interface RunInput extends Partial<Omit<McpClientsOptions, "system">> {
  layout?: Layout;
  runner?: CommandRunner;
  env?: Record<string, string>;
}

/** Runs `opscrew mcp <action>` against the temporary home; returns the exit code and output. */
async function run(action: McpClientsAction, input: RunInput = {}) {
  const { layout = LINUX, runner = new FakeClaude({ missing: true }), env = {}, ...rest } = input;
  const output: string[] = [];
  const code = await runMcpClients({
    action,
    clients: undefined,
    yes: false,
    interactive: false,
    version: VERSION,
    prompts: confirmPrompts(),
    out: (text) => output.push(text),
    ...rest,
    system: {
      home,
      env: { PATH: "", ...layout.env(home), ...env },
      platform: layout.platform,
      runner,
    },
  });
  return { code, output: output.join("") };
}

const readJson = async (file: string) => JSON.parse(await readFile(file, "utf8"));
const readToml = async (file: string) => structuredClone(parse(await readFile(file, "utf8")));

/** Every file under `folder`, with its text. */
async function filesUnder(folder: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files.set(file, await readFile(file, "utf8"));
  }
  return files;
}

describe.each(LAYOUTS)("opscrew mcp install and uninstall on $platform", (layout) => {
  it("sets up every app found, the Microsoft Store Claude Desktop included, then removes them", async () => {
    const desktops = [layout.desktop(home), ...(layout.store ? [layout.store(home)] : [])];
    for (const folder of [
      ...desktops,
      path.join(home, ".codex"),
      path.join(home, ".cursor"),
      layout.vscodeUser(home),
    ]) {
      await mkdir(folder, { recursive: true });
    }
    const claude = new FakeClaude();
    const codex = path.join(home, ".codex", "config.toml");
    const cursor = path.join(home, ".cursor", "mcp.json");
    const vscode = path.join(home, ".copilot", "mcp-config.json");

    const installed = await run("install", { layout, runner: claude, yes: true });
    expect(installed.code).toBe(0);
    for (const folder of desktops) {
      expect(await readJson(path.join(folder, "claude_desktop_config.json"))).toEqual({
        mcpServers: { opscrew: JSON_ENTRY },
      });
    }
    expect(await readToml(codex)).toEqual({ mcp_servers: { opscrew: codexEntry(VERSION) } });
    expect(await readJson(cursor)).toEqual({ mcpServers: { opscrew: JSON_ENTRY } });
    expect(await readJson(vscode)).toEqual({ mcpServers: { opscrew: VSCODE_ENTRY } });
    expect(claude.calls).toEqual([
      "claude --version",
      "claude plugin list --json",
      "claude plugin marketplace add opscrew-hub/opscrew",
      "claude plugin install opscrew@opscrew",
    ]);
    expect(installed.output).toContain(`Codex: creates ${codex} with OpsCrew's entry:\n`);
    expect(installed.output).toContain("Claude Code: installs OpsCrew's plugin");
    expect(installed.output).toContain("Claude Code: installed OpsCrew's plugin.\n");
    expect(installed.output).toContain(`Cursor: wrote ${cursor}.\n`);
    for (const app of ["Claude Code", "Claude Desktop", "Codex", "Cursor", "VS Code"]) {
      expect(installed.output.split(`Restart ${app} to load OpsCrew.\n`)).toHaveLength(2);
    }
    expect(installed.output.endsWith(`${TOKEN_NOTE}\n`)).toBe(true);

    const removed = await run("uninstall", { layout, runner: claude, yes: true });
    expect(removed.code).toBe(0);
    for (const folder of desktops) {
      expect(await readJson(path.join(folder, "claude_desktop_config.json"))).toEqual({
        mcpServers: {},
      });
    }
    expect(await readFile(codex, "utf8")).toBe("");
    expect(await readFile(`${codex}.opscrew-backup`, "utf8")).toBe(codexTable(VERSION));
    expect(await readJson(cursor)).toEqual({ mcpServers: {} });
    expect(await readJson(vscode)).toEqual({ mcpServers: {} });
    expect(claude.calls.slice(4)).toEqual([
      "claude --version",
      "claude plugin list --json",
      "claude plugin uninstall opscrew@opscrew",
    ]);
    expect(removed.output).toContain(`VS Code: removes OpsCrew's entry from ${vscode}.\n`);
    expect(removed.output).toContain(
      `VS Code: wrote ${vscode} (the old file is kept as ${vscode}.opscrew-backup).\n`,
    );
    expect(removed.output).toContain("Restart Cursor to finish removing OpsCrew.\n");
    expect(removed.output).not.toContain("No token");

    const again = await run("uninstall", { layout, runner: claude, yes: true });
    expect(again.code).toBe(0);
    expect(again.output).toContain(`Cursor: not set up (${cursor}).`);
    expect(again.output).toContain("Claude Code: not set up.");
    expect(again.output).not.toContain("Restart");
  });

  it("sets up the apps named with --client even when they aren't there, creating their folders", async () => {
    const claude = new FakeClaude();
    const result = await run("install", {
      layout,
      runner: claude,
      yes: true,
      clients: ["vscode", "cursor", "codex", "claude-desktop", "cursor"],
    });
    expect(result.code).toBe(0);
    expect(claude.calls).toEqual([]);
    const desktop = path.join(layout.desktop(home), "claude_desktop_config.json");
    expect(await readJson(desktop)).toEqual({ mcpServers: { opscrew: JSON_ENTRY } });
    expect(await readToml(path.join(home, ".codex", "config.toml"))).toEqual({
      mcp_servers: { opscrew: codexEntry(VERSION) },
    });
    expect(await readJson(path.join(home, ".cursor", "mcp.json"))).toEqual({
      mcpServers: { opscrew: JSON_ENTRY },
    });
    expect(await readJson(path.join(home, ".copilot", "mcp-config.json"))).toEqual({
      mcpServers: { opscrew: VSCODE_ENTRY },
    });
    expect(result.output.indexOf("Claude Desktop:")).toBeLessThan(result.output.indexOf("Codex:"));
    expect(result.output.indexOf("Cursor:")).toBeLessThan(result.output.indexOf("VS Code:"));
  });

  it("finds nothing, says which apps it looked for and how to name one, and changes nothing", async () => {
    for (const action of ["install", "uninstall"] as const) {
      const claude = new FakeClaude({ missing: true });
      const result = await run(action, { layout, runner: claude, yes: true });
      expect(result.code).toBe(0);
      expect(result.output).toContain(
        "(it looked for Claude Code, Claude Desktop, Codex, Cursor and VS Code), so nothing was changed.",
      );
      expect(result.output).toContain(
        `name it: \`opscrew mcp ${action} --client <id>\`, where <id> is claude-code, claude-desktop, codex, cursor or vscode.`,
      );
      expect(claude.calls).toEqual(["claude --version"]);
      expect(await readdir(home)).toEqual([]);
    }
  });
});

describe("opscrew mcp install's questions", () => {
  beforeEach(async () => {
    await mkdir(path.join(home, ".cursor"));
    await mkdir(path.join(home, ".codex"));
  });

  it("shows the changes to a script without --yes, changes nothing and names the rerun", async () => {
    const all = await run("install");
    expect(all.code).toBe(1);
    expect(all.output).toContain(
      `Cursor: creates ${path.join(home, ".cursor", "mcp.json")} with OpsCrew's entry:\n  {\n    "mcpServers": {\n      "opscrew": {\n        "command": "npx",`,
    );
    expect(all.output).toContain(`  [mcp_servers.opscrew]\n  command = "npx"\n`);
    expect(all.output).toContain(
      "Nothing was changed. To make these changes, run `opscrew mcp install --yes`.\n",
    );
    const one = await run("install", { clients: ["cursor"] });
    expect(one.code).toBe(1);
    expect(one.output).not.toContain("Codex");
    expect(one.output).toContain("run `opscrew mcp install --client cursor --yes`.");
    expect(await filesUnder(home)).toEqual(new Map());
  });

  it("asks once for every app in a terminal, and writes nothing when the answer is no", async () => {
    const refused = confirmPrompts(false);
    await expect(run("install", { interactive: true, prompts: refused })).rejects.toMatchObject({
      code: "APPROVAL_REFUSED",
      message: "You cancelled the changes, so nothing was written.",
    });
    const cancelled = confirmPrompts(CANCEL);
    await expect(run("install", { interactive: true, prompts: cancelled })).rejects.toThrow(
      OpsCrewError,
    );
    expect(await filesUnder(home)).toEqual(new Map());

    const yes = confirmPrompts(true);
    const result = await run("install", { interactive: true, prompts: yes });
    expect(result.code).toBe(0);
    expect(yes.asked).toEqual(["Make these changes?"]);
    expect([...(await filesUnder(home)).keys()].sort()).toEqual([
      path.join(home, ".codex", "config.toml"),
      path.join(home, ".cursor", "mcp.json"),
    ]);
  });

  it("changes nothing on a second install with the same version, and replaces another version's entry with a backup", async () => {
    const cursor = path.join(home, ".cursor", "mcp.json");
    const codex = path.join(home, ".codex", "config.toml");
    const original = '{"theme": "dark", "mcpServers": {"other": {"command": "other"}}}';
    await writeFile(cursor, original);
    expect((await run("install", { yes: true })).code).toBe(0);
    expect(await readFile(`${cursor}.opscrew-backup`, "utf8")).toBe(original);
    const first = await filesUnder(home);

    const prompts = confirmPrompts();
    const second = await run("install", { interactive: true, prompts });
    expect(second.code).toBe(0);
    expect(prompts.asked).toEqual([]);
    expect(second.output).toBe(
      `Codex: already set up with this version (${codex}).\n\nCursor: already set up with this version (${cursor}).\n\n`,
    );
    expect(await filesUnder(home)).toEqual(first);

    const newer = await run("install", { yes: true, version: "2.0.0" });
    expect(newer.code).toBe(0);
    expect(newer.output).toContain(`Cursor: replaces OpsCrew's entry in ${cursor} with:\n`);
    expect(newer.output).toContain(
      `Cursor: wrote ${cursor} (the old file is kept as ${cursor}.opscrew-backup).\n`,
    );
    expect(await readFile(`${cursor}.opscrew-backup`, "utf8")).toBe(first.get(cursor));
    expect(await readJson(cursor)).toEqual({
      theme: "dark",
      mcpServers: {
        other: { command: "other" },
        opscrew: { command: "npx", args: ["-y", "opscrew@2.0.0", "mcp"] },
      },
    });
    expect((await readToml(codex)).mcp_servers).toEqual({ opscrew: codexEntry("2.0.0") });
  });
});

describe("opscrew mcp install's refusals", () => {
  it("leaves a JSON file with comments, a non-object key and Codex's inline table as they were, printing the entry", async () => {
    const cursor = path.join(home, ".cursor", "mcp.json");
    const desktop = path.join(LINUX.desktop(home), "claude_desktop_config.json");
    const codex = path.join(home, ".codex", "config.toml");
    const texts = new Map([
      [cursor, '{\n  // my servers\n  "mcpServers": {}\n}\n'],
      [desktop, '{"mcpServers": []}'],
      [codex, 'mcp_servers = { opscrew = { command = "old" } }\n'],
    ]);
    for (const [file, text] of texts) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    await mkdir(path.join(home, ".copilot"));

    for (const action of ["install", "uninstall"] as const) {
      const result = await run(action, { yes: true });
      expect(result.code).toBe(1);
      for (const [file, text] of texts) {
        expect(await readFile(file, "utf8")).toBe(text);
        await expect(readFile(`${file}.opscrew-backup`)).rejects.toThrow();
      }
      const what =
        action === "install" ? "Add OpsCrew's entry to it" : "Remove OpsCrew's entry from it";
      expect(result.output).toContain(
        `Cursor: ${cursor} isn't plain JSON (it has comments or a syntax error), so OpsCrew leaves it as it is. ${what} by hand:\n  {\n    "mcpServers": {\n      "opscrew": {`,
      );
      expect(result.output).toContain(
        `Claude Desktop: ${desktop} has a "mcpServers" that isn't an object, so OpsCrew leaves it as it is.`,
      );
      expect(result.output).toContain(
        `Codex: ${codex} has "mcp_servers" in a form OpsCrew can't change without touching the rest (an inline table or dotted keys), so OpsCrew leaves it as it is. ${what} by hand:\n  [mcp_servers.opscrew]\n`,
      );
    }
    expect(await readJson(path.join(home, ".copilot", "mcp-config.json"))).toEqual({
      mcpServers: {},
    });
  });

  it("refuses an unknown id, naming the ids, before anything changes", async () => {
    await mkdir(path.join(home, ".cursor"));
    const result = run("install", { yes: true, clients: ["cursor", "zed"] });
    await expect(result).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: `OpsCrew doesn't set up "zed".`,
      hint: "Name one or more of claude-code, claude-desktop, codex, cursor and vscode with --client.",
    });
    expect(await filesUnder(home)).toEqual(new Map());
  });
});

describe("opscrew mcp install for Claude Code", () => {
  it("goes on when the marketplace is already added", async () => {
    const claude = new FakeClaude({ marketplaces: ["opscrew"] });
    const result = await run("install", { runner: claude, yes: true, clients: ["claude-code"] });
    expect(result.code).toBe(0);
    expect(claude.calls).toEqual([
      "claude --version",
      "claude plugin list --json",
      "claude plugin marketplace add opscrew-hub/opscrew",
      "claude plugin marketplace list --json",
      "claude plugin install opscrew@opscrew",
    ]);
    expect(result.output).toContain("Restart Claude Code to load OpsCrew.");
  });

  it("updates a plugin of another version, and leaves one of this version alone", async () => {
    const older = new FakeClaude({ installed: "0.1.0", marketplaces: ["opscrew"] });
    const updated = await run("install", { runner: older, yes: true, clients: ["claude-code"] });
    expect(updated.code).toBe(0);
    expect(updated.output).toContain(
      "Claude Code: updates OpsCrew's plugin (its MCP server and skills):\n  claude plugin marketplace add opscrew-hub/opscrew\n  claude plugin update opscrew@opscrew\n",
    );
    expect(updated.output).toContain("Claude Code: updated OpsCrew's plugin.");
    expect(older.calls.at(-1)).toBe("claude plugin update opscrew@opscrew");

    const current = new FakeClaude({ installed: VERSION });
    const same = await run("install", { runner: current, yes: true });
    expect(same.code).toBe(0);
    expect(same.output).toBe("Claude Code: already set up with this version.\n\n");
    expect(current.calls).toEqual(["claude --version", "claude plugin list --json"]);
  });

  it("reports a failed install with Claude Code's message", async () => {
    const claude = new FakeClaude({ failInstall: true });
    const result = await run("install", { runner: claude, yes: true });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "Claude Code: `claude plugin install opscrew@opscrew` failed: Could not reach github.com. Run it in your terminal to see what Claude Code needs.\n",
    );
    expect(result.output).not.toContain("Restart");
    expect(result.output).not.toContain("No token");
  });

  it("says when `claude` doesn't run: refused when named, skipped otherwise", async () => {
    const named = await run("install", {
      runner: new FakeClaude({ missing: true }),
      yes: true,
      clients: ["claude-code"],
    });
    expect(named.code).toBe(1);
    expect(named.output).toBe(
      "Claude Code: the `claude` command didn't run, so OpsCrew can't add its plugin. Install Claude Code (or add its folder to PATH), then run this again.\n\n",
    );

    const removing = await run("uninstall", {
      runner: new FakeClaude({ missing: true }),
      yes: true,
      clients: ["claude-code"],
    });
    expect(removing.code).toBe(1);
    expect(removing.output).toContain(
      "so OpsCrew can't remove its plugin. If Claude Code is installed, add its folder to PATH, then run this again.",
    );

    await mkdir(path.join(home, ".cursor"));
    const found = await run("install", { runner: new FakeClaude({ missing: true }), yes: true });
    expect(found.code).toBe(0);
    expect(found.output).not.toContain("Claude Code");
  });

  it("names the commands to run by hand when Claude Code's plugins can't be read", async () => {
    const claude = new FakeClaude({ noList: true });
    const result = await run("install", { runner: claude, yes: true });
    expect(result.code).toBe(1);
    expect(result.output).toBe(
      "Claude Code: OpsCrew couldn't read its plugins (`claude plugin list --json`: error: unknown option '--json'). Run these in your terminal instead:\n  claude plugin marketplace add opscrew-hub/opscrew\n  claude plugin install opscrew@opscrew\n\n",
    );
    expect(claude.calls).toEqual(["claude --version", "claude plugin list --json"]);
  });
});

describe("opscrew mcp install's folders and tokens", () => {
  it("honours CODEX_HOME, COPILOT_HOME and XDG_CONFIG_HOME", async () => {
    const env = {
      CODEX_HOME: path.join(dir, "codex"),
      COPILOT_HOME: path.join(dir, "copilot"),
      XDG_CONFIG_HOME: path.join(dir, "config"),
    };
    for (const folder of [
      env.CODEX_HOME,
      env.COPILOT_HOME,
      path.join(env.XDG_CONFIG_HOME, "Claude"),
    ]) {
      await mkdir(folder, { recursive: true });
    }
    expect((await run("install", { env, yes: true })).code).toBe(0);
    expect(await readToml(path.join(env.CODEX_HOME, "config.toml"))).toEqual({
      mcp_servers: { opscrew: codexEntry(VERSION) },
    });
    expect(await readJson(path.join(env.COPILOT_HOME, "mcp-config.json"))).toEqual({
      mcpServers: { opscrew: VSCODE_ENTRY },
    });
    expect(
      await readJson(path.join(env.XDG_CONFIG_HOME, "Claude", "claude_desktop_config.json")),
    ).toEqual({
      mcpServers: { opscrew: JSON_ENTRY },
    });
    expect(await filesUnder(home)).toEqual(new Map());
  });

  it("writes no value of the environment's variables into any file or output", async () => {
    const env: Record<string, string> = {};
    for (const [index, name] of [
      ...CREDENTIAL_VARIABLES,
      "AWS_SECRET_ACCESS_KEY",
      "ANTHROPIC_API_KEY",
    ].entries()) {
      env[name] = `leak-check-value-${index}-${name.toLowerCase()}`;
    }
    for (const layout of LAYOUTS) {
      for (const folder of [
        layout.desktop(home),
        ...(layout.store ? [layout.store(home)] : []),
        path.join(home, ".codex"),
        path.join(home, ".cursor"),
        layout.vscodeUser(home),
      ]) {
        await mkdir(folder, { recursive: true });
      }
      const output: string[] = [];
      for (const action of ["install", "uninstall"] as const) {
        const result = await run(action, { layout, env, runner: new FakeClaude(), yes: true });
        output.push(result.output);
      }
      const texts = [...output, ...(await filesUnder(home)).values()];
      expect(texts.join("\n")).toContain("OPSCREW_HOSTING_TOKEN");
      for (const value of Object.values(env)) {
        for (const text of texts) expect(text).not.toContain(value);
      }
      await rm(home, { recursive: true });
      await mkdir(home);
    }
  });
});
