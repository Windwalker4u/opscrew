// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash and GitHub Actions syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  OUTSIDE_CHECK_JOBS,
  OUTSIDE_CHECK_WORKFLOW_FILE,
  renderOutsideCheckWorkflow,
} from "./outside-check";

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = { "runs-on": string; "timeout-minutes": number; steps: Step[]; permissions?: unknown };

const file = renderOutsideCheckWorkflow();
const workflow = parse(file.content) as {
  on: { workflow_dispatch: { inputs: Record<string, Record<string, unknown>> } };
  permissions: unknown;
  concurrency: unknown;
  jobs: Record<string, Job>;
};
const script = (job: "http" | "https") => workflow.jobs[job]?.steps[0]?.run ?? "";

describe("the outside check's workflow file", () => {
  it("is one file per repository, at its fixed name", () => {
    expect(OUTSIDE_CHECK_WORKFLOW_FILE).toBe("opscrew-outside-check.yml");
    expect(file.path).toBe(".github/workflows/opscrew-outside-check.yml");
    expect(file.kind).toBe("workflow");
    expect(file.content.endsWith("\n")).toBe(true);
    expect(file.content).toMatchSnapshot();
  });

  it("is started by hand with the hostname, the health path and the mode", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    const { inputs } = workflow.on.workflow_dispatch;
    expect(Object.keys(inputs)).toEqual(["host", "path", "mode"]);
    for (const input of Object.values(inputs)) expect(input.required).toBe(true);
    expect(inputs.mode).toMatchObject({ type: "choice", options: ["proxied", "direct"] });
    expect(workflow.concurrency).toEqual({
      group: "opscrew-outside-check-${{ inputs.host }}",
      "cancel-in-progress": false,
    });
  });

  it("has the two jobs on GitHub's hosted runner, with nothing to use", () => {
    expect(Object.keys(workflow.jobs)).toEqual([...OUTSIDE_CHECK_JOBS]);
    expect(workflow.permissions).toEqual({});
    for (const job of OUTSIDE_CHECK_JOBS) {
      const j = workflow.jobs[job] as Job;
      expect(j["runs-on"]).toBe("ubuntu-24.04");
      expect(j["timeout-minutes"]).toBe(5);
      expect(j.steps).toHaveLength(1);
      expect(j.steps[0]?.uses).toBeUndefined();
      expect(j.steps[0]?.env).toEqual({
        HOST: "${{ inputs.host }}",
        CHECK_PATH: "${{ inputs.path }}",
        MODE: "${{ inputs.mode }}",
      });
    }
    expect(file.content).not.toContain("secrets.");
    expect(file.content).not.toContain("uses:");
  });

  it("puts no expression in any run: the inputs reach the shell only through env", () => {
    for (const job of OUTSIDE_CHECK_JOBS) {
      expect(script(job)).not.toBe("");
      expect(script(job)).not.toContain("${{");
    }
  });
});

function bashWorks(): boolean {
  try {
    return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

/*
 * A stubbed curl: each try takes the next of CURL_TRIES (`<http code>:<exit code>[:cf]`, the last
 * repeated), writes the response's headers to the file after `-D` (with a `cf-mitigated` line for
 * `cf`), prints the code for `-w`, and records its arguments in CURL_ARGS. `sleep` records its
 * argument and returns.
 */
const STUB = [
  "curl() {",
  '  local n; n=$(wc -l < "$CURL_ARGS")',
  '  printf "%s\\n" "$*" >> "$CURL_ARGS"',
  "  local tries=($CURL_TRIES)",
  "  local i=$(( n < ${#tries[@]} ? n : ${#tries[@]} - 1 ))",
  "  local code rc cf",
  '  IFS=: read -r code rc cf <<< "${tries[$i]}"',
  '  local header="" previous=""',
  '  for a in "$@"; do [[ $previous == -D ]] && header=$a; previous=$a; done',
  "  if [[ $rc -eq 0 ]]; then",
  '    printf \'HTTP/2 %s\\r\\nserver: cloudflare\\r\\n\' "$code" > "$header"',
  "    [[ $cf == cf ]] && printf 'cf-mitigated: challenge\\r\\n' >> \"$header\"",
  "  fi",
  '  printf %s "$code"',
  '  return "$rc"',
  "}",
  'sleep() { echo "$1" >> "$SLEEPS"; }',
].join("\n");

describe.skipIf(!bashWorks())("the outside check's probe in bash", { timeout: 120_000 }, () => {
  let work = "";
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), "opscrew-outside-check-"));
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  let runs = 0;
  function probe(
    job: "http" | "https",
    tries: string,
    inputs: { HOST?: string; CHECK_PATH?: string; MODE?: string } = {},
  ) {
    const dir = mkdtempSync(join(work, `run-${++runs}-`));
    const args = join(dir, "args");
    const sleeps = join(dir, "sleeps");
    const result = spawnSync(
      "bash",
      ["-e", "-o", "pipefail", "-c", `: > "$CURL_ARGS"; : > "$SLEEPS"\n${STUB}\n${script(job)}`],
      {
        env: {
          ...process.env,
          HOST: "shop.example.com",
          CHECK_PATH: "/api/health",
          MODE: "proxied",
          ...inputs,
          CURL_TRIES: tries,
          CURL_ARGS: args,
          SLEEPS: sleeps,
          RUNNER_TEMP: dir,
          GITHUB_RUN_ID: "4242",
        },
        encoding: "utf8",
      },
    );
    const calls = readFileSync(args, "utf8").split("\n").filter(Boolean);
    const slept = readFileSync(sleeps, "utf8").split("\n").filter(Boolean);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      slept,
      dir,
    };
  }

  it("passes on the first answer, requesting the cache-busted health path on 443 and / on 80", () => {
    const https = probe("https", "200:0");
    expect(https.status).toBe(0);
    expect(https.stdout).toBe("https try 1: code 200, curl 0\n");
    expect(https.stderr).toBe("");
    expect(https.calls).toEqual([
      `-s -o /dev/null -D ${https.dir}/h --max-time 15 -w %{http_code} https://shop.example.com/api/health?opscrew-outside-check=4242`,
    ]);

    const http = probe("http", "301:0", { MODE: "direct" });
    expect(http.status).toBe(0);
    expect(http.stdout).toBe("http try 1: code 301, curl 0\n");
    expect(http.calls[0]?.endsWith(" http://shop.example.com/")).toBe(true);
  });

  it("retries up to six times, 20 seconds apart, and fails after the last", () => {
    const result = probe("https", "000:7");
    expect(result.status).toBe(1);
    expect(result.calls).toHaveLength(6);
    expect(result.slept).toEqual(["20", "20", "20", "20", "20"]);
    expect(result.stdout).toBe(
      [1, 2, 3, 4, 5, 6].map((n) => `https try ${n}: code 000, curl 7\n`).join(""),
    );
    expect(result.stderr).toBe("");
  });

  it("passes on a later try after failures", () => {
    const result = probe("http", "000:28 502:0");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("http try 1: code 000, curl 28\nhttp try 2: code 502, curl 0\n");
  });

  it("fails on every Cloudflare origin error, 520 to 527 and 530", () => {
    for (const code of ["520", "521", "522", "523", "524", "525", "526", "527", "530"]) {
      const result = probe("https", `${code}:0`);
      expect(result.status).toBe(1);
      expect(result.calls).toHaveLength(6);
      expect(result.stdout.split("\n")[0]).toBe(`https try 1: code ${code}, curl 0`);
    }
  });

  it("passes other answers, 528 and 4xx included", () => {
    for (const code of ["200", "404", "503", "528"]) {
      expect(probe("https", `${code}:0`).status).toBe(0);
    }
  });

  it("fails an answer a Cloudflare challenge gave, saying it was challenged", () => {
    const result = probe("https", "403:0:cf");
    expect(result.status).toBe(1);
    expect(result.stdout.split("\n")[0]).toBe("https try 1: code 403, curl 0, challenged");
    const later = probe("https", "403:0:cf 200:0");
    expect(later.status).toBe(0);
    expect(later.stdout).toBe(
      "https try 1: code 403, curl 0, challenged\nhttps try 2: code 200, curl 0\n",
    );
  });

  it("refuses invalid inputs before any request", () => {
    const invalid: Record<string, string>[] = [
      { HOST: "Shop.Example.com" },
      { HOST: "shop" },
      { HOST: "-shop.example.com" },
      { HOST: "shop.example.com/x" },
      { HOST: "shop.example.com; id" },
      { HOST: "203.0.113.9" },
      { HOST: "" },
      {
        HOST: `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.example.com`,
      },
      { CHECK_PATH: "api/health" },
      { CHECK_PATH: "/api/health?x=1" },
      { CHECK_PATH: "/api health" },
      { CHECK_PATH: "/$(id)" },
      { CHECK_PATH: `/${"a".repeat(201)}` },
      { MODE: "both" },
      { MODE: "" },
    ];
    for (const inputs of invalid) {
      for (const job of OUTSIDE_CHECK_JOBS) {
        const result = probe(job, "200:0", inputs);
        expect(result.status, JSON.stringify(inputs)).toBe(1);
        expect(result.stdout).toBe("invalid input\n");
        expect(result.calls).toEqual([]);
      }
    }
  });

  it("accepts the longest valid hostname and path", () => {
    const host = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.io`;
    expect(host).toHaveLength(253);
    const result = probe("https", "200:0", { HOST: host, CHECK_PATH: `/${"a".repeat(200)}` });
    expect(result.status).toBe(0);
  });

  it("never prints the header file", () => {
    const result = probe("https", "403:0:cf");
    expect(result.stdout).not.toContain("server: cloudflare");
    expect(result.stdout).not.toContain("cf-mitigated");
  });
});
