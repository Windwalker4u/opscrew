/**
 * The record of the app's values in OpsCrew's home (048 plan.md 1.): what provision last stored in
 * GitHub for the environment, by name, so `opscrew values` can change one value and render the
 * secrets again without asking for the others. Owner-only, in the recovery copy, never shown.
 */
import { join } from "node:path";
import { writeFileAtomic } from "@opscrew/core";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readDotenvLine } from "../shared/app-env";
import { readValidJson } from "../shared/files";

/** The app's values by name: the running app's (`app`) and the build's (`build`). */
const RecordedValuesSchema = z.strictObject({
  app: z.record(z.string(), z.string()),
  build: z.record(z.string(), z.string()),
});

/** The app's values OpsCrew recorded for an environment. */
export type RecordedValues = z.infer<typeof RecordedValuesSchema>;

/** The record's file (0600), beside the generated values. */
export function appValuesFile(deps: Pick<PhaseDeps, "paths">): string {
  return join(deps.paths.projectHomeDir, "app_values.json");
}

/** The record; `undefined` when there is none, or it is damaged (provision writes it again). */
export function readAppValues(deps: Pick<PhaseDeps, "paths">): Promise<RecordedValues | undefined> {
  return readValidJson(appValuesFile(deps), RecordedValuesSchema);
}

/** Writes the record (0600). */
export async function writeAppValues(
  deps: Pick<PhaseDeps, "paths">,
  values: RecordedValues,
): Promise<void> {
  await writeFileAtomic(appValuesFile(deps), `${JSON.stringify(values)}\n`);
}

/**
 * Records `text`, the app's env file another flow stored as `OPSCREW_APP_ENV` (a rotation, a
 * service's move, a Cloudflare move), as the record's `app` values, keeping the build's; nothing
 * when this computer has no record.
 */
export async function recordAppEnvText(
  deps: Pick<PhaseDeps, "paths">,
  text: string,
): Promise<void> {
  const record = await readAppValues(deps);
  if (record === undefined) return;
  const app = Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const pair = readDotenvLine(line);
      return pair === undefined ? [] : [pair];
    }),
  );
  await writeAppValues(deps, { ...record, app });
}
