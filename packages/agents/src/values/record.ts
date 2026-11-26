/**
 * The record of the app's values in OpsCrew's home (048 plan.md 1.): what provision last stored in
 * GitHub for the environment, by name, so `opscrew values` can change one value and render the
 * secrets again without asking for the others. Owner-only, in the recovery copy, never shown. The
 * key of a bucket at a provider is never in it: OpsCrew keeps that like a provider token (FR-1318).
 */
import { join } from "node:path";
import { writeFileAtomic } from "@opscrew/core";
import { providerBucket } from "@opscrew/iac-templates";
import type { DeployPlan } from "@opscrew/plan-schema";
import { z } from "zod";
import type { PhaseDeps } from "../context";
import { readDotenvLine, storageVariableKind } from "../shared/app-env";
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

/**
 * True for a variable of `plan` that holds the key of its bucket at a provider (the app's
 * `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`), which the record never holds.
 */
export function bucketKeyVariable(plan: Pick<DeployPlan, "storage">, name: string): boolean {
  return providerBucket(plan) !== undefined && storageVariableKind(name) === "key";
}

/** Writes the record (0600), without the bucket's key. */
export async function writeAppValues(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "storage">,
  values: RecordedValues,
): Promise<void> {
  const kept = (part: Record<string, string>) =>
    Object.fromEntries(Object.entries(part).filter(([name]) => !bucketKeyVariable(plan, name)));
  const record = { app: kept(values.app), build: kept(values.build) };
  await writeFileAtomic(appValuesFile(deps), `${JSON.stringify(record)}\n`);
}

/** The values of an app env file OpsCrew wrote (`dotenvLine`s), by name. */
function appEnvValues(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const pair = readDotenvLine(line);
      return pair === undefined ? [] : [pair];
    }),
  );
}

/** The values of build lines (`NAME=value`), by name. */
function buildValues(text: string | undefined): Record<string, string> {
  return Object.fromEntries(
    (text ?? "").split("\n").flatMap((line) => {
      const at = line.indexOf("=");
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
    }),
  );
}

/**
 * Records what provision just stored in GitHub: the app env file `appEnv` and the build lines
 * (`buildEnv`, `buildSecrets`, when the workflow reads them).
 */
export async function recordStoredValues(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "storage">,
  stored: { appEnv: string; buildEnv?: string; buildSecrets?: string },
): Promise<void> {
  await writeAppValues(deps, plan, {
    app: appEnvValues(stored.appEnv),
    build: { ...buildValues(stored.buildEnv), ...buildValues(stored.buildSecrets) },
  });
}

/**
 * Records `text`, the app's env file another flow stored as `OPSCREW_APP_ENV` (a rotation, a
 * service's move, a Cloudflare move), as the record's `app` values, keeping the build's; nothing
 * when this computer has no record.
 */
export async function recordAppEnvText(
  deps: Pick<PhaseDeps, "paths">,
  plan: Pick<DeployPlan, "storage">,
  text: string,
): Promise<void> {
  const record = await readAppValues(deps);
  if (record === undefined) return;
  await writeAppValues(deps, plan, { ...record, app: appEnvValues(text) });
}
