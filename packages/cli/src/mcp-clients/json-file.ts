import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { SERVER_NAME } from "./entry";
import type { FileChange } from "./types";

const jsonObject = z.record(z.string(), z.unknown());

/**
 * An app's JSON configuration (`text`, undefined when there is none) with OpsCrew's `entry` under
 * `key`, or without it (`entry` undefined). Every other key and server is kept; an existing
 * `opscrew` entry is replaced in place; the file is written with 2-space indentation and a final
 * newline. A file that isn't plain JSON (comments included), or whose `key` isn't an object, is
 * refused.
 */
export function changeJson(
  text: string | undefined,
  key: string,
  entry: object | undefined,
): FileChange {
  if (text === undefined) {
    if (entry === undefined) return { kind: "same" };
    return { kind: "write", text: formatted({ [key]: { [SERVER_NAME]: entry } }), replaced: false };
  }
  let data: unknown;
  try {
    // Notepad on Windows starts a file with a byte-order mark; it is written back without one.
    data = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { kind: "refused", reason: "isn't plain JSON (it has comments or a syntax error)" };
  }
  const root = jsonObject.safeParse(data);
  if (!root.success) return { kind: "refused", reason: "doesn't hold a JSON object" };
  const servers = jsonObject.safeParse(Object.hasOwn(root.data, key) ? root.data[key] : {});
  if (!servers.success) {
    return { kind: "refused", reason: `has a "${key}" that isn't an object` };
  }
  const current = servers.data[SERVER_NAME];
  const present = Object.hasOwn(servers.data, SERVER_NAME);
  if (entry === undefined) {
    if (!present) return { kind: "same" };
    const rest = { ...servers.data };
    delete rest[SERVER_NAME];
    return { kind: "write", text: formatted({ ...root.data, [key]: rest }), replaced: true };
  }
  if (isDeepStrictEqual(current, entry)) return { kind: "same" };
  const next = { ...root.data, [key]: { ...servers.data, [SERVER_NAME]: entry } };
  return { kind: "write", text: formatted(next), replaced: present };
}

function formatted(data: object): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}
