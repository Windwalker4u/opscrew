import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";
import { changeCodex } from "./codex-file";
import { CREDENTIAL_VARIABLES, codexEntry, codexTable } from "./entry";

const VERSION = "1.2.3";
const INLINE =
  'has "mcp_servers" in a form OpsCrew can\'t change without touching the rest (an inline table or dotted keys)';

/** The user's own file: comments, other tables, and a comment that belongs to the next table. */
const USER_TEXT = [
  "# Codex settings",
  'model = "gpt-5" # the default model',
  "",
  "[mcp_servers.other]",
  'command = "other" # keep me',
  "",
  "# My profiles",
  "[profiles.fast]",
  'model = "small"',
  "",
].join("\n");

/** The data of `text` as plain objects. */
const data = (text: string) => structuredClone(parse(text));

describe("changeCodex", () => {
  it("creates a missing file with OpsCrew's table: npx, the start limit and the names only", () => {
    const change = changeCodex(undefined, VERSION);
    expect(change).toEqual({ kind: "write", replaced: false, text: codexTable(VERSION) });
    expect(data(codexTable(VERSION))).toEqual({ mcp_servers: { opscrew: codexEntry(VERSION) } });
    expect(codexEntry(VERSION)).toEqual({
      command: "npx",
      args: ["-y", `opscrew@${VERSION}`, "mcp"],
      startup_timeout_sec: 120,
      env_vars: CREDENTIAL_VARIABLES,
    });
  });

  it("keeps the user's text byte for byte and appends the table after a blank line", () => {
    const change = changeCodex(USER_TEXT, VERSION);
    expect(change).toEqual({
      kind: "write",
      replaced: false,
      text: `${USER_TEXT}\n${codexTable(VERSION)}`,
    });
    const noNewline = changeCodex('model = "x"', VERSION);
    expect(noNewline.kind === "write" && noNewline.text).toBe(
      `model = "x"\n\n${codexTable(VERSION)}`,
    );
  });

  it("changes nothing on a second install with the same version", () => {
    const once = changeCodex(USER_TEXT, VERSION);
    if (once.kind !== "write") throw new Error("expected a write");
    expect(changeCodex(once.text, VERSION)).toEqual({ kind: "same" });
  });

  it("replaces OpsCrew's tables of another version, keeping the comments around them", () => {
    const older = [
      "# Codex settings",
      "",
      "[mcp_servers.opscrew]",
      'command = "npx"',
      "# an old note inside OpsCrew's table",
      'args = ["-y", "opscrew@1.0.0", "mcp"]',
      "",
      "# My other server",
      "[mcp_servers.other]",
      'command = "other"',
      "",
      '[ mcp_servers . "opscrew" . env ]',
      'X = "1"',
      "",
      "[profiles.fast]",
      'model = "small"',
      "",
    ].join("\n");
    const change = changeCodex(older, VERSION);
    expect(change.kind === "write" && change.replaced).toBe(true);
    if (change.kind !== "write") return;
    expect(change.text).toBe(
      [
        "# Codex settings",
        "",
        "# My other server",
        "[mcp_servers.other]",
        'command = "other"',
        "",
        "[profiles.fast]",
        'model = "small"',
        "",
        codexTable(VERSION),
      ].join("\n"),
    );
    expect(data(change.text).mcp_servers).toEqual({
      other: { command: "other" },
      opscrew: codexEntry(VERSION),
    });
  });

  it("removes only OpsCrew's tables, and says when there are none", () => {
    const installed = changeCodex(USER_TEXT, VERSION);
    if (installed.kind !== "write") throw new Error("expected a write");
    const removed = changeCodex(installed.text, undefined);
    expect(removed).toEqual({ kind: "write", replaced: true, text: `${USER_TEXT}\n` });
    expect(changeCodex(USER_TEXT, undefined)).toEqual({ kind: "same" });
    expect(changeCodex(undefined, undefined)).toEqual({ kind: "same" });
    expect(changeCodex(codexTable(VERSION), undefined)).toEqual({
      kind: "write",
      replaced: true,
      text: "",
    });
  });

  it("refuses an inline table, dotted keys and a file that isn't TOML, for install and uninstall", () => {
    const inline = 'mcp_servers = { opscrew = { command = "npx" } }\n';
    const dotted = '[mcp_servers]\nopscrew.command = "npx"\n';
    const otherInline = 'mcp_servers = { other = { command = "x" } }\n';
    for (const text of [inline, dotted]) {
      expect(changeCodex(text, VERSION)).toEqual({ kind: "refused", reason: INLINE });
      expect(changeCodex(text, undefined)).toEqual({ kind: "refused", reason: INLINE });
    }
    expect(changeCodex(otherInline, VERSION)).toEqual({ kind: "refused", reason: INLINE });
    expect(changeCodex("this is = = not toml", VERSION)).toEqual({
      kind: "refused",
      reason: "isn't valid TOML",
    });
  });
});
