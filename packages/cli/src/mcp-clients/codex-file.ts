import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import { codexEntry, codexTable, SERVER_NAME } from "./entry";
import type { FileChange } from "./types";

/** Any table header line (`[a.b]` or `[[a.b]]`). */
const HEADER = /^[ \t]*\[/;
/** The header of OpsCrew's table or one of its sub-tables (`[mcp_servers.opscrew.env]`). */
const OPSCREW_HEADER = new RegExp(
  `^[ \\t]*\\[\\[?[ \\t]*mcp_servers[ \\t]*\\.[ \\t]*(?:${SERVER_NAME}|"${SERVER_NAME}"|'${SERVER_NAME}')[ \\t]*(?:\\.[^\\]]*)?\\]\\]?[ \\t]*(?:#.*)?$`,
);
const BLANK = /^[ \t]*\r?\n?$/;
const COMMENT = /^[ \t]*#/;

const INLINE =
  'has "mcp_servers" in a form OpsCrew can\'t change without touching the rest (an inline table or dotted keys)';

type TomlData = Record<string, unknown>;

/**
 * Codex's `config.toml` (`text`, undefined when there is none) with OpsCrew's table for `version`,
 * or without it (`version` undefined). The text outside OpsCrew's tables stays byte for byte,
 * comments included: `[mcp_servers.opscrew]` and its sub-tables are cut out and the new table is
 * appended. The result must parse to the original's data with only `mcp_servers.opscrew` changed;
 * otherwise (an inline table, dotted keys) the file is refused.
 */
export function changeCodex(text: string | undefined, version: string | undefined): FileChange {
  const entry = version === undefined ? undefined : codexEntry(version);
  if (text === undefined) {
    if (version === undefined) return { kind: "same" };
    return { kind: "write", text: codexTable(version), replaced: false };
  }
  let before: TomlData;
  try {
    before = structuredClone(parse(text));
  } catch {
    return { kind: "refused", reason: "isn't valid TOML" };
  }
  const servers = before.mcp_servers;
  const current = isTable(servers) ? servers[SERVER_NAME] : undefined;
  if (entry === undefined ? current === undefined : isDeepStrictEqual(current, entry)) {
    return { kind: "same" };
  }
  const kept = withoutOpsCrewTables(text);
  const next = version === undefined ? kept : appended(kept, codexTable(version));
  let after: TomlData;
  try {
    after = structuredClone(parse(next));
  } catch {
    return { kind: "refused", reason: INLINE };
  }
  if (!isDeepStrictEqual(normalized(after), normalized(withEntry(before, entry)))) {
    return { kind: "refused", reason: INLINE };
  }
  return { kind: "write", text: next, replaced: current !== undefined };
}

/**
 * `text` without OpsCrew's tables: each runs from its header to the next header, except the
 * comments just before that header (with the blank lines between them), which belong to it.
 */
function withoutOpsCrewTables(text: string): string {
  const lines = text.split(/(?<=\n)/);
  const kept = lines.map(() => true);
  let index = 0;
  while (index < lines.length) {
    if (!OPSCREW_HEADER.test((lines[index] ?? "").trimEnd())) {
      index++;
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !HEADER.test(lines[end] ?? "")) end++;
    let last = end;
    while (last > index + 1 && isBlankOrComment(lines[last - 1] ?? "")) last--;
    while (last < end && !COMMENT.test(lines[last] ?? "")) last++;
    for (let line = index; line < last; line++) kept[line] = false;
    index = end;
  }
  return lines.filter((_, line) => kept[line]).join("");
}

function isBlankOrComment(line: string): boolean {
  return BLANK.test(line) || COMMENT.test(line);
}

/** `table` after `text`, which keeps its bytes, with a blank line between them. */
function appended(text: string, table: string): string {
  if (text === "") return table;
  const ended = text.endsWith("\n") ? text : `${text}\n`;
  return /\n[ \t]*\r?\n$/.test(ended) ? `${ended}${table}` : `${ended}\n${table}`;
}

/** `data` with OpsCrew's table set to `entry`, or without it. */
function withEntry(data: TomlData, entry: object | undefined): TomlData {
  const servers = isTable(data.mcp_servers) ? { ...data.mcp_servers } : {};
  if (entry === undefined) delete servers[SERVER_NAME];
  else servers[SERVER_NAME] = entry;
  return { ...data, mcp_servers: servers };
}

/** `data` without an empty `mcp_servers`, which TOML can't tell from none. */
function normalized(data: TomlData): TomlData {
  const { mcp_servers: servers, ...rest } = data;
  return isTable(servers) && Object.keys(servers).length === 0 ? rest : data;
}

function isTable(value: unknown): value is TomlData {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
