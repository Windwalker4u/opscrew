/**
 * What the scan leaves out: findings in test code, and findings in the paths `opscrew/scan.yaml`
 * ignores. A secret is never left out: there it is reported as info, saying why.
 */
import type { Finding, IgnoredFindings } from "@opscrew/contracts";
import {
  ArtifactError,
  readScanConfig,
  SCAN_CONFIG_FILE,
  type ScanIgnoreEntry,
} from "@opscrew/plan-schema";
import ignore, { type Ignore } from "ignore";
import { isTestFile } from "./text";

/** Every rule id the built-in scanners report. */
export const BUILTIN_RULE_IDS: readonly string[] = [
  "config/client-exposed-secret",
  "config/cors-wildcard-credentials",
  "config/django-debug",
  "config/dockerfile-latest-tag",
  "config/dockerfile-root",
  "config/dockerfile-secret-arg",
  "config/dockerfile-secret-env",
  "config/dockerfile-unpinned-digest",
  "config/env-not-gitignored",
  "config/flask-debug",
  "firebase/open-rules",
  "firebase/public-read",
  "firebase/rtdb-open",
  "firebase/test-mode-rules",
  "secrets/anthropic-api-key",
  "secrets/aws-access-key-id",
  "secrets/aws-secret-access-key",
  "secrets/cloudflare-api-token",
  "secrets/committed-env",
  "secrets/env-not-ignored",
  "secrets/generic-high-entropy",
  "secrets/github-token",
  "secrets/google-api-key",
  "secrets/openai-api-key",
  "secrets/private-key",
  "secrets/slack-token",
  "secrets/stripe-secret-key",
  "secrets/url-credentials",
  "supabase/anon-write-grant",
  "supabase/permissive-write-policy",
  "supabase/public-bucket",
  "supabase/public-read-sensitive",
  "supabase/rls-disabled",
  "supabase/secret-key-in-source",
  "supabase/service-role-env-exposed",
  "supabase/service-role-in-client",
];

/** Rule id prefixes of the dependency check and the external scanners, whose ids are open-ended. */
const OPEN_RULE_PREFIXES = ["deps/", "gitleaks/", "trivy/"];

/** Not of category `secret`, but it carries the key itself. */
const SECRET_VALUE_RULES = new Set(["supabase/service-role-in-client"]);

const isSecret = (finding: Finding) =>
  finding.category === "secret" || SECRET_VALUE_RULES.has(finding.ruleId);

const isKnownRule = (id: string) =>
  BUILTIN_RULE_IDS.includes(id) || OPEN_RULE_PREFIXES.some((prefix) => id.startsWith(prefix));

/**
 * The ignore entries of `opscrew/scan.yaml` under `root` (none without the file).
 * @throws ArtifactError when the file is invalid or names a rule the scan does not know.
 */
export async function readScanIgnores(root: string): Promise<ScanIgnoreEntry[]> {
  const entries = (await readScanConfig(root))?.ignore ?? [];
  const issues = entries.flatMap((entry, index) =>
    (entry.rules ?? []).flatMap((rule, at) =>
      isKnownRule(rule)
        ? []
        : [{ path: `ignore.${index}.rules.${at}`, message: `"${rule}" is not a rule of the scan` }],
    ),
  );
  if (issues.length === 0) return entries;
  throw new ArtifactError({
    code: "ARTIFACT_INVALID",
    file: SCAN_CONFIG_FILE,
    issues,
    hint: `Use the rule id a finding shows in opscrew/SECURITY_SCAN.md: ${BUILTIN_RULE_IDS.join(", ")}, or one starting with ${OPEN_RULE_PREFIXES.join(", ")} (the dependency check, gitleaks and trivy).`,
  });
}

interface Matcher {
  entry: ScanIgnoreEntry;
  paths: Ignore;
  count: number;
}

/** What {@link applyIgnores} keeps, and the count of what it left out. */
export interface IgnoreResult {
  findings: Finding[];
  ignored?: IgnoredFindings;
}

function asInfo(finding: Finding, why: string): Finding {
  if (finding.severity === "info") return finding;
  return {
    ...finding,
    severity: "info",
    description: `${finding.description} ${why}, so it is reported as info; if it is a real secret, rotate it.`,
  };
}

/**
 * Leaves out every finding in test code and every finding an `entries` entry matches (its paths,
 * and its rules when it names some), counting them per rule and per entry. A secret finding there
 * stays, as info with why. `sanitize` masks the user's reason before it goes into a finding.
 */
export function applyIgnores(
  findings: readonly Finding[],
  entries: readonly ScanIgnoreEntry[],
  sanitize: (text: string) => string,
): IgnoreResult {
  const matchers: Matcher[] = entries.map((entry) => ({
    entry,
    paths: ignore().add(entry.paths),
    count: 0,
  }));
  const kept: Finding[] = [];
  const byRule: Record<string, number> = {};
  let testCode = 0;
  for (const finding of findings) {
    const file = finding.file;
    const inTests = file !== undefined && isTestFile(file);
    const matcher =
      file === undefined || inTests
        ? undefined
        : matchers.find(
            ({ entry, paths }) =>
              (entry.rules === undefined || entry.rules.includes(finding.ruleId)) &&
              paths.ignores(file),
          );
    if (!inTests && matcher === undefined) {
      kept.push(finding);
    } else if (isSecret(finding)) {
      kept.push(
        asInfo(
          finding,
          matcher === undefined
            ? "It is in test code, so it is most likely a made-up value for the tests"
            : sanitize(`${SCAN_CONFIG_FILE} ignores this path ("${matcher.entry.reason}")`),
        ),
      );
    } else {
      byRule[finding.ruleId] = (byRule[finding.ruleId] ?? 0) + 1;
      if (matcher === undefined) testCode++;
      else matcher.count++;
    }
  }
  const total = findings.length - kept.length;
  if (total === 0) return { findings: kept };
  return {
    findings: kept,
    ignored: {
      total,
      byRule: Object.fromEntries(Object.entries(byRule).sort(([a], [b]) => (a < b ? -1 : 1))),
      testCode,
      entries: matchers.map(({ entry, count }) => ({
        paths: entry.paths.map(sanitize),
        ...(entry.rules === undefined ? {} : { rules: [...entry.rules] }),
        reason: sanitize(entry.reason),
        count,
      })),
    },
  };
}
