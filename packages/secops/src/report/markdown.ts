import {
  type Finding,
  type IgnoredFindings,
  type ScanReport,
  SEVERITIES,
  type Severity,
} from "@opscrew/contracts";

/** A severity as a heading or table label: `Critical`, `High`, … */
export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  info: "Info",
};

/** Text for a Markdown table cell: one line, pipes escaped. */
export function tableCell(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

/** Inline code span that stays valid when the text itself contains backticks. */
export function inlineCode(text: string): string {
  const oneLine = text.replace(/\r?\n/g, " ");
  const longestRun = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longestRun + 1);
  const pad = longestRun > 0 || oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}

/** Prose from a scanner: keep it on one paragraph and neutralise raw HTML. */
export function prose(text: string): string {
  return text
    .replace(/\r?\n+/g, " ")
    .replace(/</g, "&lt;")
    .trim();
}

/** Where a finding is: `file:line`, the file alone, or `""` when it names no file. */
export function findingLocation(finding: Finding): string {
  if (finding.file === undefined) return "";
  return finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`;
}

/** `2026-10-11 14:03 UTC` from an ISO timestamp. */
export function formatUtc(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function renderFinding(finding: Finding): string {
  const where = findingLocation(finding);
  const lines = [
    `### ${prose(finding.title)}${where ? ` — ${inlineCode(where)}` : ""}`,
    "",
    prose(finding.description),
    "",
  ];
  if (finding.evidence !== undefined && finding.evidence.length > 0) {
    lines.push(`- **Evidence:** ${inlineCode(finding.evidence)}`);
  }
  lines.push(`- **Fix:** ${prose(finding.remediation)}`);
  lines.push(`- **Rule:** ${inlineCode(finding.ruleId)} (${prose(finding.source)})`);
  if (finding.references !== undefined && finding.references.length > 0) {
    lines.push(
      `- **References:** ${finding.references.map((ref) => `<${ref.replace(/[<>\s]/g, "")}>`).join(", ")}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderIgnored(ignored: IgnoredFindings): string[] {
  const byFile = ignored.total - ignored.testCode;
  const out = [
    "## Ignored",
    "",
    `${ignored.total} finding${ignored.total === 1 ? " is" : "s are"} left out of this report: ${ignored.testCode} in test code and ${byFile} in paths ${inlineCode("opscrew/scan.yaml")} ignores. A secret the scan recognises is never left out: it keeps its severity wherever it sits.`,
    "",
    "| Rule | Findings |",
    "|---|---|",
    ...Object.entries(ignored.byRule).map(([rule, count]) => `| ${inlineCode(rule)} | ${count} |`),
    "",
  ];
  if (ignored.entries.length > 0) {
    out.push(
      "| Paths | Rules | Reason | Findings |",
      "|---|---|---|---|",
      ...ignored.entries.map(
        (entry) =>
          `| ${entry.paths.map((p) => tableCell(inlineCode(p))).join(", ")} | ${entry.rules ? entry.rules.map((r) => tableCell(inlineCode(r))).join(", ") : "all"} | ${tableCell(prose(entry.reason))} | ${entry.count} |`,
      ),
      "",
    );
  }
  return out;
}

/**
 * The shareable report written to `opscrew/SECURITY_SCAN.md`. Deterministic for a given report,
 * contains only masked evidence and repo-relative paths.
 */
export function renderScanMarkdown(report: ScanReport): string {
  const out: string[] = [
    `# OpsCrew security scan: ${prose(report.project)}`,
    "",
    `Scanned on ${formatUtc(report.finishedAt)} with OpsCrew ${report.version}.`,
    "",
    "| Severity | Findings |",
    "|---|---|",
    ...SEVERITIES.map(
      (severity) => `| ${SEVERITY_LABEL[severity]} | ${report.counts[severity] ?? 0} |`,
    ),
    "",
  ];

  if (report.findings.length === 0) {
    out.push("No problems found by the scanners that ran.", "");
  } else {
    for (const severity of SEVERITIES) {
      const findings = report.findings.filter((f) => f.severity === severity);
      if (findings.length === 0) continue;
      out.push(`## ${SEVERITY_LABEL[severity]}`, "");
      for (const finding of findings) out.push(renderFinding(finding));
    }
  }

  if (report.ignored !== undefined) out.push(...renderIgnored(report.ignored));

  out.push("## Scanners", "", "| Scanner | Status | Notes |", "|---|---|---|");
  for (const scanner of report.scanners) {
    const notes = [
      scanner.reason,
      scanner.durationMs !== undefined ? `${scanner.durationMs} ms` : undefined,
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join("; ");
    out.push(`| ${tableCell(scanner.id)} | ${scanner.status} | ${tableCell(notes)} |`);
  }
  out.push(
    "",
    "---",
    "",
    `Generated by OpsCrew ${report.version}. Evidence is masked: no secret values are included in this report.`,
    "",
  );
  return out.join("\n");
}
