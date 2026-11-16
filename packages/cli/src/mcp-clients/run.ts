import { copyFile, readFile } from "node:fs/promises";
import { listText, OpsCrewError, orText, writeFileAtomic } from "@opscrew/core";
import { cancelled, type UiPrompts } from "../ui/prompts";
import { FILE_APPS, type FileApp } from "./apps";
import { claudeCodeStep } from "./claude-code";
import {
  CLIENT_IDS,
  type ClientId,
  type McpClientsAction,
  type McpSystem,
  type Step,
} from "./types";

/** The guide page on OpsCrew in other AI apps, and on the tokens they read. */
const MCP_CLIENTS_GUIDE = "https://docs.opscrew.dev/mcp-clients/";

const APP_NAMES = ["Claude Code", ...FILE_APPS.map((app) => app.name)];

/** One run of `opscrew mcp install` or `opscrew mcp uninstall`. */
export interface McpClientsOptions {
  action: McpClientsAction;
  /** The `--client` ids; undefined sets up every app found on this computer. */
  clients: readonly string[] | undefined;
  /** `--yes`: change the files without asking. */
  yes: boolean;
  interactive: boolean;
  /** This CLI's version, which every entry starts. */
  version: string;
  system: McpSystem;
  prompts: UiPrompts;
  /** Writes to standard output (no newline added). */
  out(text: string): void;
}

/**
 * Adds OpsCrew's MCP server to the AI apps found on this computer, or to the ones named, or removes
 * it: shows each app's file and entry first, asks once in a terminal (`--yes` doesn't; a script
 * without `--yes` changes nothing), backs up each file it changes and never writes a token.
 * Returns the exit code: 0 when every app is set up (or nothing was found), 1 when an app was
 * refused or failed, or nothing changed for want of `--yes`. An unknown id throws.
 */
export async function runMcpClients(options: McpClientsOptions): Promise<number> {
  const { action, version, system, out } = options;
  const named = chosenClients(options.clients);
  const steps: Step[] = [];
  if (named === undefined || named.includes("claude-code")) {
    const step = await claudeCodeStep(action, version, system, named !== undefined);
    if (step !== undefined) steps.push(step);
  }
  for (const app of FILE_APPS) {
    if (named !== undefined && !named.includes(app.id)) continue;
    const { found, files } = await app.locate(system);
    if (!found && named === undefined) continue;
    for (const file of files) steps.push(await fileStep(app, file, action, version));
  }
  if (steps.length === 0) {
    out(nothingFound(action));
    return 0;
  }

  out(`${steps.map((step) => `${step.show}\n`).join("\n")}\n`);
  const refused = steps.some((step) => step.refused === true);
  const changes = steps.filter(
    (step): step is Step & Required<Pick<Step, "apply">> => step.apply !== undefined,
  );
  if (changes.length === 0) return refused ? 1 : 0;
  const command = `opscrew mcp ${action}${named === undefined ? "" : ` --client ${named.join(" ")}`}`;
  if (!options.yes) {
    if (!options.interactive) {
      out(`Nothing was changed. To make these changes, run \`${command} --yes\`.\n`);
      return 1;
    }
    const answer = await options.prompts.confirm({
      message: "Make these changes?",
      initialValue: true,
    });
    if (options.prompts.isCancel(answer) || answer !== true) {
      throw cancelled("the changes", command);
    }
  }

  const done = new Set<string>();
  let failed = false;
  for (const step of changes) {
    const result = await step.apply();
    out(`${result.text}\n`);
    if (result.ok) done.add(step.app);
    else failed = true;
  }
  for (const app of done) {
    out(
      action === "install"
        ? `Restart ${app} to load OpsCrew.\n`
        : `Restart ${app} to finish removing OpsCrew.\n`,
    );
  }
  if (action === "install" && done.size > 0) {
    out(
      `No token was written: OpsCrew reads your tokens from the environment each app starts in. How to set them: ${MCP_CLIENTS_GUIDE}\n`,
    );
  }
  return refused || failed ? 1 : 0;
}

/** The named ids in `CLIENT_IDS`' order, once each; throws on an unknown one. */
function chosenClients(ids: readonly string[] | undefined): ClientId[] | undefined {
  if (ids === undefined) return undefined;
  const unknown = ids.filter((id) => !(CLIENT_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new OpsCrewError(
      "INVALID_INPUT",
      `OpsCrew doesn't set up ${orText(unknown.map((id) => `"${id}"`))}.`,
      { hint: `Name one or more of ${listText([...CLIENT_IDS])} with --client.` },
    );
  }
  return CLIENT_IDS.filter((id) => ids.includes(id));
}

/** The step for one of `app`'s files: what changes, shown first, and the write itself. */
async function fileStep(
  app: FileApp,
  file: string,
  action: McpClientsAction,
  version: string,
): Promise<Step> {
  const name = app.name;
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { app: name, refused: true, show: fileError(name, "read", file, error) };
    }
  }
  const change = app.change(text, action === "install" ? version : undefined);
  const entry = indented(app.entryText(version));
  if (change.kind === "same") {
    const state = action === "install" ? "already set up with this version" : "not set up";
    return { app: name, show: `${name}: ${state} (${file}).` };
  }
  if (change.kind === "refused") {
    const what =
      action === "install" ? "Add OpsCrew's entry to it" : "Remove OpsCrew's entry from it";
    return {
      app: name,
      refused: true,
      show: `${name}: ${file} ${change.reason}, so OpsCrew leaves it as it is. ${what} by hand:\n${entry}`,
    };
  }
  const show =
    action === "uninstall"
      ? `${name}: removes OpsCrew's entry from ${file}.`
      : text === undefined
        ? `${name}: creates ${file} with OpsCrew's entry:\n${entry}`
        : change.replaced
          ? `${name}: replaces OpsCrew's entry in ${file} with:\n${entry}`
          : `${name}: adds OpsCrew's entry to ${file}:\n${entry}`;
  return {
    app: name,
    show,
    apply: async () => {
      const backup = `${file}.opscrew-backup`;
      try {
        if (text !== undefined) await copyFile(file, backup);
        await writeFileAtomic(file, change.text);
      } catch (error) {
        return { ok: false, text: fileError(name, "write", file, error) };
      }
      const kept = text === undefined ? "" : ` (the old file is kept as ${backup})`;
      return { ok: true, text: `${name}: wrote ${file}${kept}.` };
    },
  };
}

/**
 * The line for an app's file OpsCrew couldn't read or write (the app may hold it open, or the
 * permissions forbid it); anything but a file-system error is thrown again.
 */
function fileError(name: string, verb: "read" | "write", file: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code !== "string") throw error;
  return `${name}: couldn't ${verb} ${file} (${code}). Close ${name} or check the file's permissions, then run this again.`;
}

function nothingFound(action: McpClientsAction): string {
  const what = action === "install" ? "To set one up anyway" : "To remove OpsCrew from one anyway";
  return `OpsCrew found none of the AI apps it sets up on this computer (it looked for ${listText(APP_NAMES)}), so nothing was changed. ${what}, name it: \`opscrew mcp ${action} --client <id>\`, where <id> is ${orText([...CLIENT_IDS])}.\n`;
}

function indented(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
