import path from "node:path";
import { readTextIfExists, stripBom } from "@opscrew/core";
import { parseDocument } from "yaml";
import { z } from "zod";
import { ArtifactError, type ArtifactIssue } from "./io";

/** Repo-relative location of the scan's ignore rules, written and committed by the user. */
export const SCAN_CONFIG_FILE = "opscrew/scan.yaml";

/** Next step shown when `opscrew/scan.yaml` is invalid. */
export const SCAN_CONFIG_HINT =
  "Fix the field shown above. Each entry under `ignore` needs `paths` (patterns as in .gitignore) and a `reason`; `rules` (rule ids such as config/flask-debug) is optional.";

const text = (missing: string) =>
  z
    .string({ error: (issue) => (issue.input === undefined ? missing : undefined) })
    .trim()
    .min(1, missing);

/** One ignore rule: findings in `paths` (of `rules` only, when given) are left out, for `reason`. */
export const ScanIgnoreEntrySchema = z.strictObject({
  paths: z.array(text("is empty: give a path pattern")).min(1, "needs at least one path pattern"),
  rules: z.array(text("is empty: give a rule id")).min(1, "needs at least one rule id").optional(),
  reason: text("is missing: say why these findings do not matter"),
});

/** `opscrew/scan.yaml`: what `opscrew scan` leaves out. Optional; recognised secrets never are. */
export const ScanConfigSchema = z.strictObject({
  ignore: z.array(ScanIgnoreEntrySchema, {
    error: (issue) => (issue.input === undefined ? "is missing: list the ignore rules" : undefined),
  }),
});

export type ScanIgnoreEntry = z.infer<typeof ScanIgnoreEntrySchema>;
export type ScanConfig = z.infer<typeof ScanConfigSchema>;

function invalid(issues: ArtifactIssue[]): ArtifactError {
  return new ArtifactError({
    code: "ARTIFACT_INVALID",
    file: SCAN_CONFIG_FILE,
    issues,
    hint: SCAN_CONFIG_HINT,
  });
}

/**
 * Parses and validates the text of `opscrew/scan.yaml` (a UTF-8 BOM and CRLF are accepted).
 * @throws ArtifactError with code `ARTIFACT_INVALID`, naming each bad field.
 */
export function parseScanConfig(source: string): ScanConfig {
  const doc = parseDocument(stripBom(source).replace(/\r\n?/g, "\n"));
  if (doc.errors.length > 0) {
    throw invalid(
      doc.errors.map((e) => ({ path: "(root)", message: `is not valid YAML: ${e.message}` })),
    );
  }
  const result = ScanConfigSchema.safeParse(doc.toJS() ?? {});
  if (result.success) return result.data;
  throw invalid(
    result.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => ({
            path: [...issue.path, key].join("."),
            message: "is not a known field (check the spelling or remove it)",
          }))
        : [{ path: issue.path.join(".") || "(root)", message: issue.message }],
    ),
  );
}

/**
 * Reads `opscrew/scan.yaml` under the repository `root`: `undefined` when there is none.
 * @throws ArtifactError with code `ARTIFACT_INVALID` when it cannot be parsed or fails validation.
 */
export async function readScanConfig(root: string): Promise<ScanConfig | undefined> {
  const source = await readTextIfExists(path.join(root, ...SCAN_CONFIG_FILE.split("/")));
  return source === undefined ? undefined : parseScanConfig(source);
}
