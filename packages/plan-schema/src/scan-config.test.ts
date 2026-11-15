import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactError } from "./io";
import { parseScanConfig, readScanConfig } from "./scan-config";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function issuesOf(source: string): string[] {
  try {
    parseScanConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ArtifactError);
    const artifact = error as ArtifactError;
    expect(artifact.file).toBe("opscrew/scan.yaml");
    expect(artifact.message).toContain("opscrew/scan.yaml is not valid:");
    return artifact.issues.map((issue) => `${issue.path}: ${issue.message}`);
  }
  throw new Error("expected the file to be refused");
}

describe("parseScanConfig", () => {
  it("reads entries with and without rules", () => {
    const config = parseScanConfig(
      [
        "ignore:",
        "  - paths: [e2e/**, 'docs/examples/']",
        "    reason: Example apps never deployed",
        "  - paths: [infra/legacy/Dockerfile]",
        "    rules: [config/dockerfile-root]",
        "    reason: Retired image, kept for reference",
        "",
      ].join("\r\n"),
    );
    expect(config.ignore).toEqual([
      { paths: ["e2e/**", "docs/examples/"], reason: "Example apps never deployed" },
      {
        paths: ["infra/legacy/Dockerfile"],
        rules: ["config/dockerfile-root"],
        reason: "Retired image, kept for reference",
      },
    ]);
  });

  it("requires a reason and at least one path, and names each bad field", () => {
    expect(issuesOf("ignore:\n  - paths: [e2e/**]\n")).toEqual([
      "ignore.0.reason: is missing: say why these findings do not matter",
    ]);
    expect(issuesOf("ignore:\n  - paths: []\n    reason: '  '\n")).toEqual([
      "ignore.0.paths: needs at least one path pattern",
      "ignore.0.reason: is missing: say why these findings do not matter",
    ]);
    expect(issuesOf("ignore:\n  - paths: [a]\n    rule: [x]\n    reason: r\n")).toEqual([
      "ignore.0.rule: is not a known field (check the spelling or remove it)",
    ]);
    expect(issuesOf("")).toEqual(["ignore: is missing: list the ignore rules"]);
    expect(issuesOf("ignore: [")[0]).toMatch(/^\(root\): is not valid YAML/);
  });
});

describe("readScanConfig", () => {
  it("is undefined without the file and reads it from opscrew/ under the root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "opscrew-scan-config-"));
    temps.push(root);
    expect(await readScanConfig(root)).toBeUndefined();
    await mkdir(path.join(root, "opscrew"));
    await writeFile(
      path.join(root, "opscrew", "scan.yaml"),
      "ignore:\n  - paths: [e2e/]\n    reason: Not shipped\n",
    );
    expect(await readScanConfig(root)).toEqual({
      ignore: [{ paths: ["e2e/"], reason: "Not shipped" }],
    });
  });
});
