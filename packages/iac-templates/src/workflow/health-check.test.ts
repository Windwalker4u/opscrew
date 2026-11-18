// biome-ignore-all lint/suspicious/noTemplateCurlyInString: bash syntax, not JavaScript templates.
import { spawnSync } from "node:child_process";
import { type DeployPlan, DeployPlanSchema } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { homePlan, testContext, testPlan } from "../__fixtures__/plans";
import { renderWorkflow } from "./index";

/*
 * Runs the generated "Check that the app is healthy" script in bash with a fake `curl` that exits
 * with the codes in CURL_CODES (one per attempt, the last one repeated; `22:525` also answers
 * HTTP 525 to `-w`) and a `sleep` that returns.
 */

type Step = { id?: string; run?: string; env?: Record<string, string> };
const healthScript = (plan: DeployPlan) =>
  (parse(renderWorkflow(plan, testContext()).content).jobs.deploy.steps as Step[]).find(
    (s) => s.id === "health",
  )?.run ?? "";

/** Caddy serves the domain itself: a domain, not proxied by Cloudflare, no tunnel. */
const direct = (() => {
  const plan = testPlan({ provider: "own", domain: "shop.example.com" });
  return { ...plan, dns: { ...plan.dns, proxied: false } };
})();
const proxied = testPlan({ provider: "own", domain: "shop.example.com" });
const tunnel = testPlan({ provider: "own", access: "tunnel", domain: "shop.example.com" });
const noDomain = testPlan({ provider: "own" });

// The attempt counter lives in a file: the script calls `curl` inside `$(…)`, a subshell.
const PRELUDE = [
  'curl_calls="$(mktemp)"',
  'echo 0 > "$curl_calls"',
  "trap 'rm -f \"$curl_calls\"' EXIT",
  "curl() {",
  "  local codes=($CURL_CODES)",
  '  local n; read -r n < "$curl_calls"',
  "  local i=$(( n < ${#codes[@]} ? n : ${#codes[@]} - 1 ))",
  '  echo $(( n + 1 )) > "$curl_calls"',
  '  local code="${codes[$i]%%:*}" status="${codes[$i]#*:}"',
  '  if [ "$status" = "$code" ]; then if [ "$code" -eq 0 ]; then status=200; else status=000; fi; fi',
  '  case " $* " in *" -w "*) printf %s "$status" ;; esac',
  '  return "$code"',
  "}",
  "sleep() { :; }",
].join("\n");

function bashWorks(): boolean {
  try {
    return spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" }).stdout?.trim() === "ok";
  } catch {
    return false;
  }
}

function run(script: string, codes: string) {
  const result = spawnSync("bash", ["-c", `${PRELUDE}\n${script}`], {
    env: { ...process.env, CURL_CODES: codes, URL: "https://shop.example.com/api/health" },
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const TLS_MESSAGE =
  "::error::The new version did not answer at https://shop.example.com/api/health: every attempt failed the TLS handshake, so the server has no certificate for this domain yet. Let's Encrypt issues at most 5 certificates per week for the same set of names, so a server rebuilt many times can reach that limit. Wait (one more becomes available about every 34 hours) or use another hostname, then deploy again.";
const NO_ANSWER = "::error::The new version did not answer at https://shop.example.com/api/health.";

describe("the health check's rendered script", () => {
  it("keeps today's step where the check does not reach Caddy's own certificate", () => {
    for (const plan of [tunnel, noDomain]) {
      const script = healthScript(plan);
      expect(script).toContain('echo "::error::The new version did not answer at $URL."');
      expect(script).not.toContain("Let's Encrypt");
    }
  });

  it("tells a TLS failure apart when Caddy serves the domain, also behind Cloudflare's proxy", () => {
    for (const plan of [direct, proxied]) {
      const script = healthScript(plan);
      expect(script).toContain("Let's Encrypt issues at most 5 certificates per week");
      expect(script).toContain('echo "::error::The new version did not answer at $URL."');
    }
  });
});

describe("the health check of a server at home", () => {
  const step = (plan: DeployPlan) =>
    (parse(renderWorkflow(plan, testContext()).content).jobs.deploy.steps as Step[]).find(
      (s) => s.id === "health",
    );
  const curl = (resolve: string) =>
    `status="$(curl -fsS --max-time 10 ${resolve} -o /dev/null -w '%{http_code}' "$URL")" || code=$?`;

  it("reaches the edge on the server itself from its runner, DNS only, so hairpin NAT can't fail it", () => {
    for (const plan of [homePlan({ proxied: false }), homePlan({ dnsElsewhere: true })]) {
      expect(healthScript(plan)).toContain(
        curl("--resolve shop.example.com:443:127.0.0.1 --resolve shop.example.com:80:127.0.0.1"),
      );
      expect(step(plan)?.env).toEqual({ URL: "https://shop.example.com/api/health" });
    }
  });

  it("reaches the server's LAN address in the HOST secret from a runner machine, DNS only", () => {
    const health = step(homePlan({ proxied: false, runner: "host" }));
    expect(health?.run).toContain(curl("--resolve shop.example.com:443:$HOST"));
    expect(health?.env).toEqual({
      URL: "https://shop.example.com/api/health",
      HOST: "${{ secrets.OPSCREW_HOST }}",
    });
  });

  it("is unchanged behind the proxy: the check goes out to Cloudflare", () => {
    for (const runner of ["server", "host"] as const) {
      const home = homePlan({ runner });
      const away = DeployPlanSchema.parse({
        ...home,
        target: { ...home.target, home: undefined },
      });
      expect(step(home)).toEqual(step(away));
      expect(step(home)?.run).not.toContain("--resolve");
    }
  });
});

describe.skipIf(!bashWorks())("the health check in bash", { timeout: 180_000 }, () => {
  it("gives curl the LAN address of a server at home from HOST", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `curl() { echo "curl $*" >&2; }\n${healthScript(homePlan({ proxied: false, runner: "host" }))}`,
      ],
      {
        env: { ...process.env, URL: "https://shop.example.com/api/health", HOST: "192.168.1.30" },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "curl -fsS --max-time 10 --resolve shop.example.com:443:192.168.1.30 -o /dev/null",
    );
  });

  it("says the server has no certificate yet when every attempt fails with 35 or 60", () => {
    for (const codes of ["35", "60", "35 60 35"]) {
      const result = run(healthScript(direct), codes);
      expect(result.status).toBe(1);
      expect(result.output.trim()).toBe(TLS_MESSAGE);
    }
  });

  it("says so behind Cloudflare's proxy when every attempt gets 525 or 526 (Cloudflare's handshake with the server)", () => {
    for (const codes of ["22:525", "22:526", "22:525 22:526"]) {
      const result = run(healthScript(proxied), codes);
      expect(result.status).toBe(1);
      expect(result.output.trim()).toBe(TLS_MESSAGE);
    }
  });

  it("says only that it did not answer when any attempt failed otherwise", () => {
    for (const codes of ["7", "35 35 7 35", "22", "28", "22:502", "22:525 22:502"]) {
      const result = run(healthScript(direct), codes);
      expect(result.status).toBe(1);
      expect(result.output.trim()).toBe(NO_ANSWER);
    }
  });

  it("passes as soon as an attempt succeeds, also after TLS failures", () => {
    const result = run(healthScript(direct), "35 35 0");
    expect(result.status).toBe(0);
    expect(result.output.trim()).toBe("Healthy after 3 attempt(s).");
  });

  it("keeps today's message in tunnel mode, also for TLS failures", () => {
    for (const codes of ["35", "22:525"]) {
      const result = run(healthScript(tunnel), codes);
      expect(result.status).toBe(1);
      expect(result.output.trim()).toBe(NO_ANSWER);
    }
  });
});
