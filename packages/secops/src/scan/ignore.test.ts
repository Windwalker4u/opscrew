import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { ArtifactError } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { renderScanMarkdown, renderScanSummary } from "../report";
import { createConfigScanner } from "../rules/config";
import { createSecretsScanner } from "../rules/secrets";
import { createFinding } from "./finding";
import { applyIgnores, BUILTIN_RULE_IDS, readScanIgnores } from "./ignore";
import { runScan } from "./run";
import { expectNoFakeValues, failingRunner, noFetch } from "./test-utils";
import { isTestFile } from "./text";

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway project made of `files` (repo-relative path → content). */
async function project(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "opscrew-ignore-"));
  temps.push(dir);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  return dir;
}

function finding(ruleId: string, file: string, category: Finding["category"] = "config"): Finding {
  return createFinding({
    ruleId,
    title: ruleId,
    severity: "high",
    category,
    file,
    line: 1,
    description: "It is a problem.",
    remediation: "Fix it.",
    source: "test",
    rawMatch: `${ruleId}@${file}`,
  });
}

const same = (text: string) => text;

const scan = (dir: string) =>
  runScan(dir, {
    offline: true,
    fetch: noFetch,
    runner: failingRunner,
    scanners: [createSecretsScanner(), createConfigScanner()],
    version: "0.0.0-test",
  });

const FLASK = "from flask import Flask\napp = Flask(__name__)\napp.run(debug=True)\n";

describe("isTestFile", () => {
  it("is true for each default test path", () => {
    for (const file of [
      "tests/app.py",
      "test/app.js",
      "src/__tests__/app.ts",
      "spec/app_spec.rb",
      "src/app.test.ts",
      "src/app.spec.ts",
      "pkg/app_test.go",
      "tests/test_app.py",
      "src/AppTest.php",
      "src/__mocks__/api.ts",
      "mocks/handlers.ts",
      "src/api.mock.ts",
      "src/__fixtures__/user.json",
      "pkg/testdata/config.yaml",
      "tests/fixtures/users.json",
      "packages/web/test/fixtures/app/settings.py",
    ]) {
      expect(isTestFile(file), file).toBe(true);
    }
  });

  it("is false for an app's own fixtures and other app code", () => {
    for (const file of [
      "fixtures/users.json",
      "shop/fixtures/products.json",
      "src/mockup.ts",
      "src/testimonials.ts",
      "src/api.ts",
    ]) {
      expect(isTestFile(file), file).toBe(false);
    }
  });
});

describe("BUILTIN_RULE_IDS", () => {
  it("lists every rule id the built-in rules report", async () => {
    const dir = fileURLToPath(new URL("../rules/", import.meta.url));
    const found = new Set<string>();
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const source = await readFile(path.join(dir, name), "utf8");
      for (const match of source.matchAll(/"((?:config|firebase|secrets|supabase)\/[a-z-]+)"/g)) {
        found.add(match[1] ?? "");
      }
      if (name === "secrets.ts") {
        for (const match of source.matchAll(/^ {4}id: "([a-z-]+)"/gm)) {
          found.add(`secrets/${match[1]}`);
        }
      }
    }
    expect([...found].sort()).toEqual([...BUILTIN_RULE_IDS].sort());
  });
});

describe("applyIgnores", () => {
  it("leaves out findings in test code and counts them per rule", () => {
    const kept = finding("config/flask-debug", "app.py");
    const result = applyIgnores(
      [
        kept,
        finding("config/flask-debug", "tests/test_app.py"),
        finding("trivy/AVD-DS-0002", "src/__mocks__/Dockerfile"),
        finding("config/env-not-gitignored", ".gitignore"),
      ],
      [],
      same,
    );
    expect(result.findings.map((f) => f.file)).toEqual(["app.py", ".gitignore"]);
    expect(result.ignored).toEqual({
      total: 2,
      byRule: { "config/flask-debug": 1, "trivy/AVD-DS-0002": 1 },
      testCode: 2,
      entries: [],
    });
  });

  it("is unset when nothing was left out", () => {
    expect(applyIgnores([finding("config/flask-debug", "app.py")], [], same).ignored).toBe(
      undefined,
    );
  });

  it("keeps a recognisable secret in test code at its severity and leaves out a guessed one", () => {
    const secrets = [
      finding("secrets/github-token", "test/fixtures/repo.json", "secret"),
      finding("secrets/private-key", "tests/keys/id_rsa", "secret"),
      finding("gitleaks/generic-api-key", "src/api.mock.ts", "secret"),
    ];
    const result = applyIgnores(
      [
        ...secrets,
        finding("secrets/generic-high-entropy", "tests/Feature/LoginTest.php", "secret"),
        finding("secrets/generic-high-entropy", "apps/web/src/settings/settings.test.ts", "secret"),
      ],
      [],
      same,
    );
    expect(result.findings).toEqual(secrets);
    expect(result.ignored).toEqual({
      total: 2,
      byRule: { "secrets/generic-high-entropy": 2 },
      testCode: 2,
      entries: [],
    });
  });

  it("leaves out every rule in an entry's paths, or only its rules when it names some", () => {
    const result = applyIgnores(
      [
        finding("config/dockerfile-root", "e2e/app/Dockerfile"),
        finding("config/flask-debug", "e2e/app/app.py"),
        finding("config/dockerfile-root", "infra/legacy/Dockerfile"),
        finding("config/dockerfile-latest-tag", "infra/legacy/Dockerfile"),
        finding("config/flask-debug", "app.py"),
      ],
      [
        { paths: ["e2e/"], reason: "End-to-end apps, never deployed" },
        {
          paths: ["infra/legacy/**"],
          rules: ["config/dockerfile-root"],
          reason: "Retired image",
        },
        { paths: ["docs/**"], reason: "Docs" },
      ],
      same,
    );
    expect(result.findings.map((f) => `${f.ruleId}@${f.file}`)).toEqual([
      "config/dockerfile-latest-tag@infra/legacy/Dockerfile",
      "config/flask-debug@app.py",
    ]);
    expect(result.ignored).toEqual({
      total: 3,
      byRule: { "config/dockerfile-root": 2, "config/flask-debug": 1 },
      testCode: 0,
      entries: [
        { paths: ["e2e/"], reason: "End-to-end apps, never deployed", count: 2 },
        {
          paths: ["infra/legacy/**"],
          rules: ["config/dockerfile-root"],
          reason: "Retired image",
          count: 1,
        },
        { paths: ["docs/**"], reason: "Docs", count: 0 },
      ],
    });
  });

  it("keeps a recognisable secret in an ignored path at its severity and leaves out a guessed one", () => {
    const result = applyIgnores(
      [
        finding("supabase/service-role-in-client", "e2e/app/admin.ts", "supabase"),
        finding("gitleaks/generic-api-key", "e2e/app/config.ts", "secret"),
        finding("secrets/committed-env", "e2e/app/.env", "secret"),
        finding("secrets/generic-high-entropy", "e2e/app/seed.ts", "secret"),
        finding("secrets/generic-high-entropy", "legacy/seed.ts", "secret"),
      ],
      [
        { paths: ["e2e/"], reason: "End-to-end apps" },
        { paths: ["legacy/"], rules: ["config/dockerfile-root"], reason: "Retired image" },
      ],
      same,
    );
    expect(result.findings.map((f) => `${f.ruleId}@${f.file}:${f.severity}`)).toEqual([
      "supabase/service-role-in-client@e2e/app/admin.ts:high",
      "gitleaks/generic-api-key@e2e/app/config.ts:high",
      "secrets/committed-env@e2e/app/.env:high",
      "secrets/generic-high-entropy@legacy/seed.ts:high",
    ]);
    expect(result.ignored).toEqual({
      total: 1,
      byRule: { "secrets/generic-high-entropy": 1 },
      testCode: 0,
      entries: [
        { paths: ["e2e/"], reason: "End-to-end apps", count: 1 },
        {
          paths: ["legacy/"],
          rules: ["config/dockerfile-root"],
          reason: "Retired image",
          count: 0,
        },
      ],
    });
  });
});

describe("readScanIgnores", () => {
  it("is empty without opscrew/scan.yaml", async () => {
    expect(await readScanIgnores(await project({}))).toEqual([]);
  });

  it("takes built-in rule ids and those of the dependency check and external scanners", async () => {
    const dir = await project({
      "opscrew/scan.yaml":
        "ignore:\n  - paths: [e2e/]\n    rules: [config/flask-debug, deps/GHSA-xxxx-yyyy-zzzz, trivy/AVD-DS-0002, gitleaks/generic-api-key]\n    reason: Not shipped\n",
    });
    expect((await readScanIgnores(dir))[0]?.rules).toHaveLength(4);
  });

  it("refuses an unknown rule id, naming the rule ids it knows", async () => {
    const dir = await project({
      "opscrew/scan.yaml":
        "ignore:\n  - paths: [e2e/]\n    rules: [config/flask-debug, docker/root]\n    reason: Not shipped\n",
    });
    const error = await readScanIgnores(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactError);
    const message = (error as ArtifactError).message;
    expect(message).toContain("opscrew/scan.yaml is not valid:");
    expect(message).toContain('ignore.0.rules.1: "docker/root" is not a rule of the scan');
    expect(message).toContain("config/dockerfile-root");
    expect(message).toContain("deps/, gitleaks/, trivy/");
  });
});

describe("runScan with opscrew/scan.yaml", () => {
  it("leaves out ignored findings and guessed secrets, keeps recognised ones, counts them", async () => {
    const token = fakeSecret("github-token", "ignored");
    const testToken = fakeSecret("github-token", "tests");
    const guess = fakeSecret("generic-password", "ignored");
    const testGuess = fakeSecret("generic-password", "tests");
    const dir = await project({
      ".gitignore": ".env*\n",
      "opscrew/scan.yaml": [
        "ignore:",
        "  - paths: [examples/]",
        "    reason: Example apps, never deployed",
        "  - paths: [legacy/Dockerfile]",
        "    rules: [config/dockerfile-root]",
        "    reason: Retired image",
        "",
      ].join("\n"),
      "app.py": FLASK,
      "tests/test_app.py": FLASK,
      "examples/demo/app.py": FLASK,
      "examples/demo/config.js": `const token = "${token}";\n`,
      "examples/demo/login.php": `$x = ["password" => "${guess}"];\n`,
      "tests/fixtures/repo.js": `const token = "${testToken}";\n`,
      "src/__mocks__/login.php": `$x = ["password" => "${testGuess}"];\n`,
      "legacy/Dockerfile": `FROM node:22@sha256:${"a".repeat(64)}\n`,
    });
    const report = await scan(dir);

    expect(report.findings.map((f) => `${f.ruleId}@${f.file}:${f.severity}`)).toEqual([
      "secrets/github-token@examples/demo/config.js:critical",
      "secrets/github-token@tests/fixtures/repo.js:critical",
      "config/flask-debug@app.py:high",
    ]);
    expect(report.ignored).toEqual({
      total: 5,
      byRule: {
        "config/dockerfile-root": 1,
        "config/flask-debug": 2,
        "secrets/generic-high-entropy": 2,
      },
      testCode: 2,
      entries: [
        { paths: ["examples/"], reason: "Example apps, never deployed", count: 2 },
        {
          paths: ["legacy/Dockerfile"],
          rules: ["config/dockerfile-root"],
          reason: "Retired image",
          count: 1,
        },
      ],
    });
    expectNoFakeValues(report.findings, [token, testToken, guess, testGuess]);

    const summary = renderScanSummary(report);
    expect(summary).toContain(
      "Ignored: 5 (config/dockerfile-root: 1, config/flask-debug: 2, secrets/generic-high-entropy: 2): 2 in test code, 3 by opscrew/scan.yaml\n" +
        "  2  examples/: Example apps, never deployed\n" +
        "  1  legacy/Dockerfile (config/dockerfile-root): Retired image\n",
    );
    const markdown = renderScanMarkdown(report);
    expect(markdown).toContain("## Ignored");
    expect(markdown).toContain("| `config/flask-debug` | 2 |");
    expect(markdown).toContain("| `secrets/generic-high-entropy` | 2 |");
    expect(markdown).toContain("| `examples/` | all | Example apps, never deployed | 2 |");
    expect(markdown).toContain(
      "A secret the scan recognises is never left out: it keeps its severity wherever it sits.",
    );
    for (const text of [summary, markdown]) expect(text).not.toContain(guess);
    expect(JSON.parse(JSON.stringify(report)).ignored.total).toBe(5);
  });

  it("stops before any scanner runs when opscrew/scan.yaml is invalid", async () => {
    const dir = await project({
      "opscrew/scan.yaml": "ignore:\n  - paths: [examples/]\n",
      "app.py": FLASK,
    });
    let ran = false;
    const error = await runScan(dir, {
      offline: true,
      fetch: noFetch,
      runner: failingRunner,
      scanners: [
        {
          id: "probe",
          kind: "builtin",
          isAvailable: async () => true,
          scan: async () => {
            ran = true;
            return [];
          },
        },
      ],
      version: "0.0.0-test",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ArtifactError);
    expect((error as Error).message).toContain(
      "ignore.0.reason: is missing: say why these findings do not matter",
    );
    expect(ran).toBe(false);
  });
});
