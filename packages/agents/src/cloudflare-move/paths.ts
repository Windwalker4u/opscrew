import { join } from "node:path";
import { type ProjectPaths, writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import { readValidJson } from "../shared";

/**
 * The environment's move folder, `<state folder>/cloudflare-move/` (data model 3), or the path
 * `parts` name in it: every file of the move that is not in the app's own records is there.
 */
export function moveFolder(paths: Pick<ProjectPaths, "stateDir">, ...parts: string[]): string {
  return join(paths.stateDir, "cloudflare-move", ...parts);
}

/** A file of the move that records a step done by its hash (`{ "sha256": … }`), never a value. */
const RecordedHashSchema = z.strictObject({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });

/** The hash `file` records; `undefined` when there is none (or it is damaged). */
export async function recordedHash(file: string): Promise<string | undefined> {
  return (await readValidJson(file, RecordedHashSchema))?.sha256;
}

/** Records `hash` in `file` (atomically), replacing what it held. */
export async function recordHash(file: string, hash: string): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify({ sha256: hash })}\n`);
}
