import type { FetchLike } from "@opscrew/contracts";
import { fakeSecret } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { describe, expect, it } from "vitest";
import { createTestPhaseDeps, ScriptedRunner, testPlan } from "../testing";
import { type InitCheck, runInitChecks } from "./index";

const GITHUB = fakeSecret("github-token", "check");

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** GitHub with the token lacking `missing` (`issues`, `actions`, `variables`). */
function github(missing: readonly string[]): FetchLike {
  const refuse = (permission: string) =>
    json(
      403,
      { message: "Resource not accessible by personal access token" },
      { "x-accepted-github-permissions": `${permission}=read` },
    );
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === "/repos/acme/shop") {
      return json(200, { default_branch: "main", private: true, permissions: { push: true } });
    }
    if (path === "/repos/acme/shop/issues") {
      return missing.includes("issues") ? refuse("issues") : json(200, []);
    }
    if (path.startsWith("/repos/acme/shop/actions/workflows/")) {
      return missing.includes("actions") ? refuse("actions") : json(404, { message: "Not Found" });
    }
    if (path.startsWith("/repos/acme/shop/actions/variables/")) {
      return missing.includes("variables")
        ? refuse("actions_variables")
        : json(404, { message: "Not Found" });
    }
    return json(500, { message: `unexpected ${url}` });
  };
}

/** The repository's git answers: a repository with a GitHub origin. */
const repo = new ScriptedRunner((command, args) => {
  const sub = args.slice(2);
  if (command.endsWith("git") && sub[0] === "rev-parse") {
    return { exitCode: 0, stdout: "true\n", stderr: "" };
  }
  if (command.endsWith("git") && sub[0] === "remote") {
    return { exitCode: 0, stdout: "git@github.com:acme/shop.git\n", stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `unexpected ${command}` };
});

async function scheduledCheck(
  missing: readonly string[],
  options: { enabled?: boolean; offline?: boolean } = {},
): Promise<InitCheck | undefined> {
  const deps = await createTestPhaseDeps({
    env: { GITHUB_TOKEN: GITHUB },
    runner: repo,
    fetch: github(missing),
  });
  await writeArtifact(
    "plan",
    deps.paths.files.plan,
    DeployPlanSchema.parse({
      ...testPlan(),
      observability: { check: { enabled: options.enabled ?? true } },
    }),
  );
  const checks = await runInitChecks(deps, {
    ...(options.offline === true ? { offline: true } : {}),
    services: { which: (name) => `/usr/bin/${name}`, nodeVersion: "22.12.0" },
  });
  const found = checks.find((check) => check.id === "scheduled-check");
  expect(JSON.stringify(checks)).not.toContain(GITHUB);
  return found;
}

describe("init with the scheduled check on", () => {
  it("passes when the token reads the check's issues, workflow and variables", async () => {
    const check = await scheduledCheck([]);
    expect(check).toMatchObject({
      title: "GitHub permissions for the scheduled check",
      status: "pass",
      message:
        "The GitHub token from GITHUB_TOKEN can read the scheduled check's issues, its workflow's state and the repository's variables.",
    });
  });

  it("names each missing permission and where to add it", async () => {
    const check = await scheduledCheck(["issues", "variables"]);
    expect(check?.status).toBe("fail");
    expect(check?.message).toBe(
      "The GitHub token from GITHUB_TOKEN lacks Issues: Read and Variables: Read and write on acme/shop, which the scheduled check needs: Issues for its open alerts in `opscrew status`, Actions for its workflow's state, Variables for pausing it while OpsCrew moves or tears down an app.",
    );
    expect(check?.fix).toBe(
      "Add Issues: Read and Variables: Read and write under the token's Repository permissions at https://github.com/settings/personal-access-tokens, then run `opscrew init` again. Or turn the check off with observability.check.enabled: false in the plan.",
    );
    const actions = await scheduledCheck(["actions"]);
    expect(actions?.message).toContain("lacks Actions: Read and write on acme/shop");
  });

  it("is not checked offline, and not listed with the check off", async () => {
    const offline = await scheduledCheck(["issues"], { offline: true });
    expect(offline).toMatchObject({ status: "skip" });
    expect(offline?.message).toContain("run `opscrew init` online");
    await expect(scheduledCheck([], { enabled: false })).resolves.toBeUndefined();
  });
});

describe("init with the Cloudflare uptime Worker", () => {
  const CLOUDFLARE = fakeSecret("cloudflare-token", "init-uptime");
  const ACCOUNT = "fedcba9876543210fedcba9876543210";

  /** Cloudflare with the zone example.com, the token lacking `missing` (`workers`, `kv`). */
  function cloudflare(missing: readonly string[]): FetchLike {
    const ok = (result: unknown) => json(200, { success: true, errors: [], messages: [], result });
    const refuse = () =>
      json(403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    return async (input) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/client\/v4/, "");
      if (url.hostname === "api.github.com") return github([])(input);
      if (path === "/user/tokens/verify") return ok({ id: "t", status: "active" });
      if (path === "/zones") {
        const name = url.searchParams.get("name");
        return ok(
          name === "example.com"
            ? [{ id: "0".repeat(32), name, status: "active", account: { id: ACCOUNT } }]
            : [],
        );
      }
      if (path === `/accounts/${ACCOUNT}/workers/scripts`) {
        return missing.includes("workers") ? refuse() : ok([]);
      }
      if (path === `/accounts/${ACCOUNT}/storage/kv/namespaces`) {
        return missing.includes("kv") ? refuse() : ok([]);
      }
      return json(200, { success: true, errors: [], messages: [], result: [] });
    };
  }

  async function uptimeCheck(missing: readonly string[], offline = false) {
    const deps = await createTestPhaseDeps({
      env: { GITHUB_TOKEN: GITHUB, CLOUDFLARE_API_TOKEN: CLOUDFLARE },
      runner: repo,
      fetch: cloudflare(missing),
    });
    await writeArtifact(
      "plan",
      deps.paths.files.plan,
      DeployPlanSchema.parse({
        ...testPlan({ domain: "shop.example.com" }),
        observability: { check: { enabled: true, runner: "cloudflare", webhook: "ntfy" } },
      }),
    );
    const checks = await runInitChecks(deps, {
      ...(offline ? { offline: true } : {}),
      services: { which: (name) => `/usr/bin/${name}`, nodeVersion: "22.12.0" },
    });
    expect(JSON.stringify(checks)).not.toContain(CLOUDFLARE);
    // The GitHub check's issues, workflow and variables don't concern the Worker.
    expect(checks.find((check) => check.id === "scheduled-check")).toBeUndefined();
    return checks.find((check) => check.id === "uptime-check");
  }

  it("passes when the token holds Workers Scripts and Workers KV Storage", async () => {
    expect(await uptimeCheck([])).toMatchObject({
      title: "Cloudflare permissions for the uptime check",
      status: "pass",
      message:
        "CLOUDFLARE_API_TOKEN holds Account → Workers Scripts → Edit and Account → Workers KV Storage → Edit for the account that holds example.com, so OpsCrew can set up the uptime Worker there.",
    });
  });

  it("names a missing Workers Scripts or Workers KV Storage permission", async () => {
    const kv = await uptimeCheck(["kv"]);
    expect(kv?.status).toBe("fail");
    expect(kv?.message).toBe(
      "CLOUDFLARE_API_TOKEN lacks Account → Workers KV Storage → Edit for the account that holds example.com, which the uptime check in the Cloudflare Worker needs.",
    );
    expect(kv?.fix).toContain("Add Account → Workers KV Storage → Edit to CLOUDFLARE_API_TOKEN");
    expect(kv?.fix).toContain('set observability.check.runner to "actions"');
    const both = await uptimeCheck(["workers", "kv"]);
    expect(both?.message).toContain(
      "lacks Account → Workers Scripts → Edit and Account → Workers KV Storage → Edit",
    );
  });

  it("is not checked offline", async () => {
    expect(await uptimeCheck(["kv"], true)).toMatchObject({ status: "skip" });
  });
});
