import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BuiltinTool, CommandRunner } from "@opscrew/contracts";
import { findExecutable, isSecretPath, nodeRealpath, sanitizeAgentEnv } from "@opscrew/core";
import type { FunctionTool } from "openai/resources/responses/responses";

const MAX_OUTPUT_CHARS = 64_000;
const MAX_READ_LINES = 2_000;
const MAX_GLOB_RESULTS = 500;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 120_000;
const MAX_BASH_TIMEOUT_MS = 300_000;

const SKIP_DIRS = new Set([".git", "node_modules", ".opscrew"]);

/** Anthropic credentials that `sanitizeAgentEnv` keeps for Claude, never needed under OpenAI. */
const ANTHROPIC_CREDENTIAL_NAMES = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);

const TOOL_SCHEMAS: Readonly<Record<BuiltinTool, FunctionTool>> = {
  Read: {
    type: "function",
    name: "Read",
    description:
      "Read a text file inside the project root. Returns numbered lines. Use offset (1-based line number) and limit to read sections of large files.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file (relative to project root)." },
        offset: { type: "integer", description: "1-based starting line number." },
        limit: { type: "integer", description: "Maximum number of lines to return." },
      },
      required: ["file_path"],
      additionalProperties: false,
    },
  },
  Glob: {
    type: "function",
    name: "Glob",
    description:
      "List files inside the project root matching a glob pattern (for example `**/*.ts` or `package.json`).",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern to match relative file paths." },
        path: {
          type: "string",
          description: "Optional subfolder inside the project root to search.",
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  Grep: {
    type: "function",
    name: "Grep",
    description:
      "Search file contents inside the project root using a regular expression. Always supply a `glob` (such as `*.ts` or `*.py`) that limits the search to non-secret source files.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression pattern to search for." },
        path: {
          type: "string",
          description: "Optional file or subfolder inside the project root to search.",
        },
        glob: {
          type: "string",
          description: "Glob filter for files to search (for example `*.ts` or `*.json`).",
        },
        ignore_case: { type: "boolean", description: "Case-insensitive search when true." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  Edit: {
    type: "function",
    name: "Edit",
    description:
      "Replace an exact string in an existing file inside the project root. Fails if `old_string` is not found or matches more than once unless `replace_all` is true.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file to edit." },
        old_string: { type: "string", description: "Exact existing text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences when true; default false.",
        },
      },
      required: ["file_path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  Write: {
    type: "function",
    name: "Write",
    description: "Create or overwrite a text file inside the project root.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file to write." },
        content: { type: "string", description: "Full UTF-8 text content of the file." },
      },
      required: ["file_path", "content"],
      additionalProperties: false,
    },
  },
  Bash: {
    type: "function",
    name: "Bash",
    description:
      "Run a shell command in the project root. Only read-only inspection commands are pre-approved; other commands require user approval and git/network mutations are denied.",
    strict: false,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run (use \\n for newlines)." },
        timeout_ms: { type: "integer", description: "Optional timeout in milliseconds." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
};

/** Returns OpenAI Responses API function tool definitions for the enabled built-in tools. */
export function toolDefinitionsFor(builtins: readonly BuiltinTool[]): FunctionTool[] {
  return builtins.map((name) => TOOL_SCHEMAS[name]);
}

export interface ToolExecutionContext {
  readonly projectRoot: string;
  readonly env: Record<string, string | undefined>;
  readonly runner: CommandRunner;
  readonly signal?: AbortSignal;
  /** Host platform; defaults to `process.platform` (injectable for tests). */
  readonly platform?: NodeJS.Platform;
  /** Checks whether a file exists on disk; defaults to `existsSync` (injectable for tests). */
  readonly fileExists?: (filePath: string) => boolean;
  /** Executable lookup on `PATH`; defaults to `findExecutable` (injectable for tests). */
  readonly findBin?: (name: string, env: Record<string, string | undefined>) => string | undefined;
}

export interface ToolExecResult {
  readonly ok: boolean;
  readonly output: string;
}

/**
 * Sanitizes the environment for a `Bash` subprocess under the OpenAI runtime.
 *
 * Unlike the Claude Agent SDK subprocess (which needs `ANTHROPIC_API_KEY` or cloud-routing
 * credentials), the OpenAI client runs in-process, so child shell commands receive neither
 * OpenAI credentials nor Anthropic/Bedrock/Vertex/Foundry credentials.
 */
export function sanitizeOpenAiBashEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  // Strip Claude cloud-routing flags before calling `sanitizeAgentEnv` so AWS_*, GOOGLE_*,
  // CLOUDSDK_*, AZURE_* and ANTHROPIC_FOUNDRY_API_KEY are always removed too.
  const withoutClaudeRouting: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (
      upper === "CLAUDE_CODE_USE_BEDROCK" ||
      upper === "CLAUDE_CODE_USE_VERTEX" ||
      upper === "CLAUDE_CODE_USE_FOUNDRY" ||
      ANTHROPIC_CREDENTIAL_NAMES.has(upper)
    ) {
      continue;
    }
    withoutClaudeRouting[name] = value;
  }
  return sanitizeAgentEnv(withoutClaudeRouting);
}

/**
 * Executes one OpsCrew built-in tool inside `projectRoot`. Callers must evaluate `ToolPolicy`
 * (and `ApprovalHandler` on `ask`) before calling this function; path boundary and secret-path
 * checks are repeated here as defence in depth.
 */
export async function executeBuiltinTool(
  tool: BuiltinTool,
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecResult> {
  try {
    switch (tool) {
      case "Read":
        return await runRead(input, ctx.projectRoot);
      case "Write":
        return await runWrite(input, ctx.projectRoot);
      case "Edit":
        return await runEdit(input, ctx.projectRoot);
      case "Glob":
        return await runGlob(input, ctx.projectRoot);
      case "Grep":
        return await runGrep(input, ctx.projectRoot);
      case "Bash":
        return await runBash(input, ctx);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `${tool} failed: ${message}` };
  }
}

type PathCheck =
  | { ok: true; absolute: string; rootReal: string; rel: string }
  | { ok: false; error: string };

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveInsideRoot(
  projectRoot: string,
  rawPath: unknown,
  mode: "read" | "write",
): PathCheck {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, error: "Path argument is missing or empty." };
  }
  let rootReal: string | undefined;
  try {
    rootReal = nodeRealpath(projectRoot);
  } catch {
    rootReal = undefined;
  }
  if (rootReal === undefined) {
    return { ok: false, error: "Project root does not exist." };
  }
  const candidate = path.resolve(projectRoot, rawPath);
  const relInitial = path.relative(projectRoot, candidate);
  if (relInitial.startsWith("..") || path.isAbsolute(relInitial)) {
    return { ok: false, error: `\`${rawPath}\` is outside the project root.` };
  }
  if (relInitial !== "" && isSecretPath(relInitial)) {
    return { ok: false, error: `\`${rawPath}\` may contain secrets and cannot be accessed.` };
  }

  let resolvedReal: string;
  try {
    const direct = nodeRealpath(candidate);
    if (direct !== undefined) {
      resolvedReal = direct;
    } else if (mode === "read") {
      return { ok: false, error: `File or directory not found: ${rawPath}` };
    } else {
      // Walk up to the deepest existing ancestor so symlinks on parent folders are resolved.
      let probe = candidate;
      const tail: string[] = [];
      let ancestorReal: string | undefined;
      while (true) {
        const parent = path.dirname(probe);
        tail.unshift(path.basename(probe));
        if (parent === probe) break;
        const found = nodeRealpath(parent);
        if (found !== undefined) {
          ancestorReal = found;
          break;
        }
        probe = parent;
      }
      if (ancestorReal === undefined) {
        return { ok: false, error: `Could not resolve parent directory for \`${rawPath}\`.` };
      }
      resolvedReal = path.join(ancestorReal, ...tail);
    }
  } catch {
    return { ok: false, error: `\`${rawPath}\` cannot be resolved safely (broken symlink).` };
  }

  if (!isWithin(rootReal, resolvedReal)) {
    return { ok: false, error: `\`${rawPath}\` resolves outside the project root.` };
  }
  const relReal = path.relative(rootReal, resolvedReal);
  if (relReal !== "" && isSecretPath(relReal)) {
    return { ok: false, error: `\`${rawPath}\` leads to a file that may contain secrets.` };
  }
  return { ok: true, absolute: resolvedReal, rootReal, rel: relReal.split(path.sep).join("/") };
}

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const omitted = text.length - MAX_OUTPUT_CHARS;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (${omitted} more characters truncated)`;
}

async function runRead(
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolExecResult> {
  const checked = resolveInsideRoot(projectRoot, input.file_path, "read");
  if (!checked.ok) return { ok: false, output: checked.error };
  const info = await stat(checked.absolute);
  if (!info.isFile()) return { ok: false, output: `${checked.rel} is not a regular file.` };
  if (info.size > MAX_GREP_FILE_BYTES) {
    return {
      ok: false,
      output: `${checked.rel} is too large to read directly (${info.size} bytes).`,
    };
  }
  const raw = await readFile(checked.absolute);
  if (raw.includes(0)) {
    return { ok: false, output: `${checked.rel} appears to be a binary file.` };
  }
  const lines = raw.toString("utf8").split(/\r?\n/);
  const offset =
    typeof input.offset === "number" && Number.isInteger(input.offset) && input.offset > 0
      ? input.offset
      : 1;
  const limit =
    typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit > 0
      ? Math.min(input.limit, MAX_READ_LINES)
      : MAX_READ_LINES;
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const formatted = slice.map((line, i) => `${offset + i}\t${line}`).join("\n");
  const suffix =
    offset - 1 + slice.length < lines.length
      ? `\n… (${lines.length - (offset - 1 + slice.length)} more lines)`
      : "";
  return { ok: true, output: capOutput(formatted + suffix) };
}

async function runWrite(
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolExecResult> {
  const checked = resolveInsideRoot(projectRoot, input.file_path, "write");
  if (!checked.ok) return { ok: false, output: checked.error };
  if (typeof input.content !== "string") {
    return { ok: false, output: "The `content` argument must be a string." };
  }
  await mkdir(path.dirname(checked.absolute), { recursive: true });
  await writeFile(checked.absolute, input.content, "utf8");
  return { ok: true, output: `Wrote ${checked.rel} (${input.content.length} characters).` };
}

async function runEdit(
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolExecResult> {
  const checked = resolveInsideRoot(projectRoot, input.file_path, "read");
  if (!checked.ok) return { ok: false, output: checked.error };
  const oldStr = input.old_string;
  const newStr = input.new_string;
  if (typeof oldStr !== "string" || oldStr === "") {
    return { ok: false, output: "The `old_string` argument must be a non-empty string." };
  }
  if (typeof newStr !== "string") {
    return { ok: false, output: "The `new_string` argument must be a string." };
  }
  const current = await readFile(checked.absolute, "utf8");
  const count = current.split(oldStr).length - 1;
  if (count === 0) {
    return { ok: false, output: `\`old_string\` was not found in ${checked.rel}.` };
  }
  const replaceAll = input.replace_all === true;
  if (!replaceAll && count > 1) {
    return {
      ok: false,
      output: `\`old_string\` matched ${count} times in ${checked.rel}. Provide more surrounding context or set replace_all to true.`,
    };
  }
  const updated = replaceAll
    ? current.split(oldStr).join(newStr)
    : current.replace(oldStr, () => newStr);
  await writeFile(checked.absolute, updated, "utf8");
  return {
    ok: true,
    output: `Updated ${checked.rel} (${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? "s" : ""}).`,
  };
}

/** Converts a glob pattern (supporting `**`, `*`, `?`, `{a,b}`) to a RegExp over POSIX paths. */
function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i] as string;
    if (c === "*") {
      if (normalized[i + 1] === "*") {
        if (normalized[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const close = normalized.indexOf("}", i + 1);
      if (close > i) {
        const parts = normalized
          .slice(i + 1, close)
          .split(",")
          .map((p) => p.replace(/[.+^$|()\\[\]{}]/g, "\\$&"));
        re += `(?:${parts.join("|")})`;
        i = close;
      } else {
        re += "\\{";
      }
    } else if ("^$.|+()[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  re += "$";
  return new RegExp(re, "i");
}

async function walkFiles(
  rootReal: string,
  dir: string,
  out: string[],
  limit: number,
): Promise<void> {
  if (out.length >= limit) return;
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= limit) return;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(rootReal, full).split(path.sep).join("/");
    if (isSecretPath(rel)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walkFiles(rootReal, full, out, limit);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

async function runGlob(
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolExecResult> {
  if (typeof input.pattern !== "string" || input.pattern === "") {
    return { ok: false, output: "The `pattern` argument is missing or not a string." };
  }
  const baseCheck =
    input.path === undefined
      ? resolveInsideRoot(projectRoot, ".", "read")
      : resolveInsideRoot(projectRoot, input.path, "read");
  if (!baseCheck.ok) return { ok: false, output: baseCheck.error };

  const files: string[] = [];
  await walkFiles(baseCheck.rootReal, baseCheck.absolute, files, 10_000);
  const matcher = globToRegExp(input.pattern);
  const basePrefix = baseCheck.rel === "" ? "" : `${baseCheck.rel}/`;
  const matches: string[] = [];
  for (const file of files) {
    const relToBase =
      basePrefix !== "" && file.startsWith(basePrefix) ? file.slice(basePrefix.length) : file;
    if (
      matcher.test(relToBase) ||
      (!input.pattern.includes("/") && matcher.test(path.posix.basename(file)))
    ) {
      matches.push(file);
      if (matches.length >= MAX_GLOB_RESULTS) break;
    }
  }
  if (matches.length === 0) return { ok: true, output: "(no matching files)" };
  const suffix =
    matches.length >= MAX_GLOB_RESULTS ? `\n… (stopped at ${MAX_GLOB_RESULTS} files)` : "";
  return { ok: true, output: capOutput(matches.join("\n") + suffix) };
}

async function runGrep(
  input: Record<string, unknown>,
  projectRoot: string,
): Promise<ToolExecResult> {
  if (typeof input.pattern !== "string" || input.pattern === "") {
    return { ok: false, output: "The `pattern` argument is missing or not a string." };
  }
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input.ignore_case === true ? "i" : "");
  } catch (error) {
    return {
      ok: false,
      output: `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const baseCheck =
    input.path === undefined
      ? resolveInsideRoot(projectRoot, ".", "read")
      : resolveInsideRoot(projectRoot, input.path, "read");
  if (!baseCheck.ok) return { ok: false, output: baseCheck.error };

  const globStr = typeof input.glob === "string" && input.glob !== "" ? input.glob : undefined;
  const globMatcher = globStr !== undefined ? globToRegExp(globStr) : undefined;
  const globHasSlash = globStr?.includes("/") === true;

  const info = await stat(baseCheck.absolute);
  const candidates: string[] = [];
  if (info.isFile()) {
    candidates.push(baseCheck.rel);
  } else if (info.isDirectory()) {
    await walkFiles(baseCheck.rootReal, baseCheck.absolute, candidates, 10_000);
  }

  const hits: string[] = [];
  for (const rel of candidates) {
    if (hits.length >= MAX_GREP_MATCHES) break;
    if (globMatcher !== undefined) {
      const target = globHasSlash ? rel : path.posix.basename(rel);
      if (!globMatcher.test(target)) continue;
    }
    const full = path.join(baseCheck.rootReal, rel);
    let fileInfo: Awaited<ReturnType<typeof stat>>;
    try {
      fileInfo = await stat(full);
    } catch {
      continue;
    }
    if (!fileInfo.isFile() || fileInfo.size > MAX_GREP_FILE_BYTES) continue;
    const raw = await readFile(full);
    if (raw.includes(0)) continue;
    const lines = raw.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (regex.test(line)) {
        hits.push(`${rel}:${i + 1}:${line}`);
        if (hits.length >= MAX_GREP_MATCHES) break;
      }
    }
  }
  if (hits.length === 0) return { ok: true, output: "(no matches)" };
  const suffix =
    hits.length >= MAX_GREP_MATCHES ? `\n… (stopped at ${MAX_GREP_MATCHES} matches)` : "";
  return { ok: true, output: capOutput(hits.join("\n") + suffix) };
}

/** True when a Windows path points into System32, SysWOW64 or WindowsApps (WSL/store shims). */
function isForbiddenWindowsShellPath(candidate: string): boolean {
  const segments = candidate.toLowerCase().split(/[\\/]+/);
  return (
    segments.includes("system32") ||
    segments.includes("syswow64") ||
    segments.includes("windowsapps")
  );
}

/**
 * Finds Git for Windows' `bash.exe` (never WSL's `System32\bash.exe`, never `WindowsApps`, and
 * never `cmd.exe`, whose quoting and `%VAR%` expansion disagree with `DefaultToolPolicy`).
 */
export function resolveGitBashWindows(
  env: Record<string, string | undefined>,
  fileExists: (filePath: string) => boolean = existsSync,
  findBin: (
    name: string,
    env: Record<string, string | undefined>,
  ) => string | undefined = findExecutable,
): string | undefined {
  const explicit = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (explicit && !isForbiddenWindowsShellPath(explicit) && fileExists(explicit)) {
    return explicit;
  }
  const gitBin = findBin("git", env);
  if (gitBin !== undefined && !isForbiddenWindowsShellPath(gitBin)) {
    const dir = path.win32.dirname(gitBin);
    const parent = path.win32.dirname(dir);
    const candidates = [
      path.win32.join(dir, "bash.exe"),
      path.win32.join(parent, "bin", "bash.exe"),
      path.win32.join(parent, "usr", "bin", "bash.exe"),
      path.win32.join(parent, "..", "bin", "bash.exe"),
      path.win32.join(parent, "..", "usr", "bin", "bash.exe"),
    ];
    for (const candidate of candidates) {
      if (!isForbiddenWindowsShellPath(candidate) && fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Resolves the bash executable for the Bash tool so commands are parsed with the same bash grammar
 * as `DefaultToolPolicy`. Returns `{ ok: false, reason }` on Windows when Git Bash is absent.
 */
export function resolveBashCommand(
  script: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
  fileExists: (filePath: string) => boolean = existsSync,
  findBin: (
    name: string,
    env: Record<string, string | undefined>,
  ) => string | undefined = findExecutable,
): { ok: true; command: string; args: string[] } | { ok: false; reason: string } {
  if (platform === "win32") {
    const gitBash = resolveGitBashWindows(env, fileExists, findBin);
    if (gitBash === undefined) {
      return {
        ok: false,
        reason:
          "Bash is not available on Windows without Git for Windows (Git Bash). Install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe.",
      };
    }
    return { ok: true, command: gitBash, args: ["-c", script] };
  }
  const bash = findBin("bash", env) ?? "bash";
  return { ok: true, command: bash, args: ["-c", script] };
}

async function runBash(
  input: Record<string, unknown>,
  ctx: ToolExecutionContext,
): Promise<ToolExecResult> {
  if (typeof input.command !== "string" || input.command.trim() === "") {
    return { ok: false, output: "The `command` argument is missing or empty." };
  }
  const shell = resolveBashCommand(
    input.command,
    ctx.env,
    ctx.platform ?? process.platform,
    ctx.fileExists ?? existsSync,
    ctx.findBin ?? findExecutable,
  );
  if (!shell.ok) {
    return { ok: false, output: `Bash denied: ${shell.reason}` };
  }
  const requestedTimeout =
    typeof input.timeout_ms === "number" &&
    Number.isFinite(input.timeout_ms) &&
    input.timeout_ms > 0
      ? Math.min(input.timeout_ms, MAX_BASH_TIMEOUT_MS)
      : DEFAULT_BASH_TIMEOUT_MS;
  const sanitizedEnv = sanitizeOpenAiBashEnv(ctx.env);
  const result = await ctx.runner.run(shell.command, shell.args, {
    cwd: ctx.projectRoot,
    env: sanitizedEnv,
    timeoutMs: requestedTimeout,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  const parts: string[] = [];
  if (result.stdout.trim() !== "") parts.push(result.stdout.trimEnd());
  if (result.stderr.trim() !== "") parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  if (result.timedOut) parts.push(`(command timed out after ${requestedTimeout}ms)`);
  if (parts.length === 0) parts.push(`(exited with code ${result.exitCode})`);
  const body = capOutput(parts.join("\n"));
  if (result.exitCode !== 0 || result.timedOut) {
    return { ok: false, output: `Exit code ${result.exitCode}\n${body}` };
  }
  return { ok: true, output: body };
}
