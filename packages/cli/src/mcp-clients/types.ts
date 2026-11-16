import type { CommandRunner } from "@opscrew/contracts";

/** The apps `opscrew mcp install` sets up, by the ids `--client` takes, in order. */
export const CLIENT_IDS = ["claude-code", "claude-desktop", "codex", "cursor", "vscode"] as const;

/** One of {@link CLIENT_IDS}. */
export type ClientId = (typeof CLIENT_IDS)[number];

/** Whether OpsCrew's entry is added (`install`) or removed (`uninstall`). */
export type McpClientsAction = "install" | "uninstall";

/** This computer as the command sees it, injected so tests run every OS's layout. */
export interface McpSystem {
  /** The user's home folder. */
  home: string;
  /** The environment: only folder variables (`APPDATA`, `CODEX_HOME`, …) and `PATH` are read. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  /** Runs `claude` (Claude Code). */
  runner: CommandRunner;
}

/**
 * A configuration file's new text (`replaced` when OpsCrew's entry was in it already), or why it
 * stays as it is.
 */
export type FileChange =
  | { kind: "write"; text: string; replaced: boolean }
  /** Install: already set up with this version; uninstall: not set up. */
  | { kind: "same" }
  /** The file is left untouched; `reason` follows the file's name in a sentence. */
  | { kind: "refused"; reason: string };

/** What the command does for one app's file or plugin. */
export interface Step {
  /** The app's name, as people know it. */
  app: string;
  /** Shown before anything changes. */
  show: string;
  /** True when the app can't be changed safely and the user has to do it by hand. */
  refused?: boolean;
  /** Makes the change and returns the line to print; absent when there is nothing to do. */
  apply?: () => Promise<{ ok: boolean; text: string }>;
}
