import { describe, expect, it } from "vitest";
import { changeJson } from "./json-file";

const entry = { command: "npx", args: ["-y", "opscrew@1.2.3", "mcp"] };

describe("changeJson", () => {
  it("creates a missing file with OpsCrew's entry only, 2-space indented with a final newline", () => {
    expect(changeJson(undefined, "mcpServers", entry)).toEqual({
      kind: "write",
      replaced: false,
      text: `${JSON.stringify({ mcpServers: { opscrew: entry } }, null, 2)}\n`,
    });
  });

  it("keeps every other key and server, in order, and adds OpsCrew's entry", () => {
    const text = '{"theme":"dark","mcpServers":{"other":{"command":"other"}},"last":[1,2]}';
    const change = changeJson(text, "mcpServers", entry);
    expect(change.kind).toBe("write");
    if (change.kind !== "write") return;
    expect(change.replaced).toBe(false);
    expect(change.text.endsWith("}\n")).toBe(true);
    expect(change.text).toContain('\n  "theme": "dark",\n');
    const data = JSON.parse(change.text);
    expect(Object.keys(data)).toEqual(["theme", "mcpServers", "last"]);
    expect(data).toEqual({
      theme: "dark",
      mcpServers: { other: { command: "other" }, opscrew: entry },
      last: [1, 2],
    });
  });

  it("adds the key when the file has none", () => {
    const change = changeJson('{"theme":"dark"}\n', "mcpServers", entry);
    expect(change.kind === "write" && JSON.parse(change.text)).toEqual({
      theme: "dark",
      mcpServers: { opscrew: entry },
    });
  });

  it("changes nothing when the same entry is there, and replaces an entry of another version", () => {
    const same = JSON.stringify({ mcpServers: { opscrew: entry } });
    expect(changeJson(same, "mcpServers", entry)).toEqual({ kind: "same" });

    const older = JSON.stringify({
      mcpServers: {
        first: { command: "a" },
        opscrew: { command: "npx", args: ["-y", "opscrew@1.0.0", "mcp"], env: { X: "1" } },
        last: { command: "b" },
      },
    });
    const change = changeJson(older, "mcpServers", entry);
    expect(change.kind === "write" && change.replaced).toBe(true);
    if (change.kind !== "write") return;
    const servers = JSON.parse(change.text).mcpServers;
    expect(Object.keys(servers)).toEqual(["first", "opscrew", "last"]);
    expect(servers.opscrew).toEqual(entry);
  });

  it("removes only OpsCrew's entry, and says when there is none", () => {
    const text = JSON.stringify({ a: 1, mcpServers: { other: { command: "x" }, opscrew: entry } });
    const change = changeJson(text, "mcpServers", undefined);
    expect(change.kind === "write" && JSON.parse(change.text)).toEqual({
      a: 1,
      mcpServers: { other: { command: "x" } },
    });
    expect(changeJson('{"mcpServers":{"other":{}}}', "mcpServers", undefined)).toEqual({
      kind: "same",
    });
    expect(changeJson('{"a":1}', "mcpServers", undefined)).toEqual({ kind: "same" });
    expect(changeJson(undefined, "mcpServers", undefined)).toEqual({ kind: "same" });
  });

  it("refuses a file with comments, one that isn't an object, and a key that isn't an object", () => {
    const comments = '{\n  // my servers\n  "mcpServers": {}\n}\n';
    for (const action of [entry, undefined]) {
      expect(changeJson(comments, "mcpServers", action)).toEqual({
        kind: "refused",
        reason: "isn't plain JSON (it has comments or a syntax error)",
      });
      expect(changeJson("[]", "mcpServers", action)).toEqual({
        kind: "refused",
        reason: "doesn't hold a JSON object",
      });
      for (const servers of ["[]", '"x"', "null"]) {
        expect(changeJson(`{"mcpServers":${servers}}`, "mcpServers", action)).toEqual({
          kind: "refused",
          reason: `has a "mcpServers" that isn't an object`,
        });
      }
    }
  });
});
