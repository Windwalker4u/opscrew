import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { changeCodex } from "./codex-file";
import { codexTable, SERVER_NAME, serverCommand } from "./entry";
import { changeJson } from "./json-file";
import type { ClientId, FileChange, McpSystem } from "./types";

/** An app OpsCrew sets up through its configuration file. */
export interface FileApp {
  id: Exclude<ClientId, "claude-code">;
  /** The app's name, as people know it. */
  name: string;
  /**
   * The files OpsCrew writes, and whether the app is on this computer: the files in its folders
   * that exist, else where they'd be created.
   */
  locate(system: McpSystem): Promise<{ found: boolean; files: string[] }>;
  /** The file's text with OpsCrew's entry for `version`, or without it (`version` undefined). */
  change(text: string | undefined, version: string | undefined): FileChange;
  /** OpsCrew's entry as it goes into the file, for adding it by hand. */
  entryText(version: string): string;
}

/** An app whose JSON file holds its servers under `key`, OpsCrew's being `entry(version)`. */
function jsonApp(
  app: Pick<FileApp, "id" | "name" | "locate">,
  key: string,
  entry: (version: string) => object,
): FileApp {
  return {
    ...app,
    change: (text, version) =>
      changeJson(text, key, version === undefined ? undefined : entry(version)),
    entryText: (version) => JSON.stringify({ [key]: { [SERVER_NAME]: entry(version) } }, null, 2),
  };
}

/** The apps OpsCrew sets up through a file, in `--client`'s order. */
export const FILE_APPS: readonly FileApp[] = [
  jsonApp(
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      locate: async (system) => {
        const folders = claudeDesktopFolders(system);
        const found: string[] = [];
        for (const folder of [folders.main, ...(await folders.store())]) {
          if (await isFolder(folder)) found.push(folder);
        }
        const files = (found.length > 0 ? found : [folders.main]).map((folder) =>
          path.join(folder, "claude_desktop_config.json"),
        );
        return { found: found.length > 0, files };
      },
    },
    "mcpServers",
    serverCommand,
  ),
  {
    id: "codex",
    name: "Codex",
    locate: async (system) => {
      const folder = system.env.CODEX_HOME || path.join(system.home, ".codex");
      return { found: await isFolder(folder), files: [path.join(folder, "config.toml")] };
    },
    change: changeCodex,
    entryText: (version) => codexTable(version).trimEnd(),
  },
  jsonApp(
    {
      id: "cursor",
      name: "Cursor",
      locate: async (system) => {
        const folder = path.join(system.home, ".cursor");
        return { found: await isFolder(folder), files: [path.join(folder, "mcp.json")] };
      },
    },
    "mcpServers",
    serverCommand,
  ),
  jsonApp(
    {
      id: "vscode",
      name: "VS Code",
      locate: async (system) => {
        const folder = system.env.COPILOT_HOME || path.join(system.home, ".copilot");
        const found = (await isFolder(folder)) || (await isFolder(vscodeUserFolder(system)));
        return { found, files: [path.join(folder, "mcp-config.json")] };
      },
    },
    "mcpServers",
    (version) => ({ type: "stdio", ...serverCommand(version), tools: ["*"] }),
  ),
];

/** Windows' roaming and local application data folders. */
function windowsFolders(system: McpSystem): { roaming: string; local: string } {
  return {
    roaming: system.env.APPDATA || path.join(system.home, "AppData", "Roaming"),
    local: system.env.LOCALAPPDATA || path.join(system.home, "AppData", "Local"),
  };
}

/**
 * Claude Desktop's folder, and on Windows the Microsoft Store copy's folders
 * (`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`, user reports, not Anthropic's docs).
 */
function claudeDesktopFolders(system: McpSystem): {
  main: string;
  store: () => Promise<string[]>;
} {
  const { home, env } = system;
  if (system.platform === "win32") {
    const { roaming, local } = windowsFolders(system);
    const packages = path.join(local, "Packages");
    return {
      main: path.join(roaming, "Claude"),
      store: async () =>
        (await readdir(packages).catch(() => [] as string[]))
          .filter((name) => name.startsWith("Claude_"))
          .map((name) => path.join(packages, name, "LocalCache", "Roaming", "Claude")),
    };
  }
  const main =
    system.platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Claude")
      : path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude");
  return { main, store: async () => [] };
}

/** VS Code's user folder, whose presence means VS Code is installed. */
function vscodeUserFolder(system: McpSystem): string {
  if (system.platform === "win32") return path.join(windowsFolders(system).roaming, "Code", "User");
  if (system.platform === "darwin") {
    return path.join(system.home, "Library", "Application Support", "Code", "User");
  }
  return path.join(system.home, ".config", "Code", "User");
}

async function isFolder(folder: string): Promise<boolean> {
  return stat(folder).then(
    (info) => info.isDirectory(),
    () => false,
  );
}
