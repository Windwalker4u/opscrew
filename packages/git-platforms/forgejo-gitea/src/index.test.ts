import type { FetchLike } from "@opscrew/contracts";
import { OpsCrewError } from "@opscrew/core";
import { fakeSecret } from "@opscrew/core/testing";
import { describe, expect, it } from "vitest";
import {
  forgeContainerImage,
  forgejoDefinition,
  giteaDefinition,
  parseForgejoRemote,
  parseGiteaRemote,
} from "./index";

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFakeFetch(
  handler: (req: RecordedRequest) => {
    status: number;
    body?: unknown;
    headers?: Record<string, string | undefined>;
  },
): { fetch: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers)) {
      for (const [k, v] of Object.entries(init.headers)) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
    }
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let parsedBody: unknown;
    if (rawBody) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }
    const req: RecordedRequest = { method, url, headers, body: parsedBody };
    requests.push(req);
    const res = handler(req);
    const resHeaders: Record<string, string> = { "content-type": "application/json" };
    for (const [k, v] of Object.entries(res.headers ?? {})) {
      if (v !== undefined) resHeaders[k] = v;
    }
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: resHeaders,
    });
  };
  return { fetch, requests };
}

describe("parseForgejoRemote & parseGiteaRemote", () => {
  it("parses Codeberg, self-hosted Forgejo, Gitea.com, and self-hosted Gitea URLs", () => {
    expect(parseForgejoRemote("https://codeberg.org/alice/demo.git")).toEqual({
      host: "codeberg.org",
      owner: "alice",
      repo: "demo",
      fullPath: "alice/demo",
    });
    expect(parseForgejoRemote("git@forgejo.example.internal:team/app.git")?.host).toBe(
      "forgejo.example.internal",
    );
    expect(
      parseForgejoRemote("git@git.company.internal:team/app.git", {
        FORGEJO_HOST: "https://git.company.internal/",
      })?.fullPath,
    ).toBe("team/app");
    expect(parseGiteaRemote("ssh://git@gitea.com:2222/bob/web.git")?.fullPath).toBe("bob/web");
    expect(
      parseGiteaRemote("https://code.internal/bob/web.git", { GITEA_HOST: "code.internal" })
        ?.fullPath,
    ).toBe("bob/web");
    expect(parseForgejoRemote("https://github.com/octo/repo.git")).toBeUndefined();
    expect(parseGiteaRemote("https://gitlab.com/group/repo.git")).toBeUndefined();
    // Substring-only matches must not match; detection requires a DNS label boundary.
    expect(parseForgejoRemote("https://myforgejohost.example.com/team/app.git")).toBeUndefined();
    expect(parseGiteaRemote("https://notgitea.example.com/team/app.git")).toBeUndefined();
    expect(parseGiteaRemote("https://code.gitea.internal/team/app.git")?.host).toBe(
      "code.gitea.internal",
    );
  });

  it("formats container image names for default and custom registry hosts", () => {
    expect(forgeContainerImage({ host: "codeberg.org", fullPath: "Alice/Demo" })).toBe(
      "codeberg.org/alice/demo",
    );
    expect(
      forgeContainerImage(
        { host: "gitea.example.com", fullPath: "Org/App" },
        "docs",
        "registry.example.com",
      ),
    ).toBe("registry.example.com/org/app/docs");
  });
});

describe("ForgejoGiteaClient protocol behavior (Forgejo vs Gitea)", () => {
  const forgejoToken = fakeSecret("forgejo-token");
  const giteaToken = fakeSecret("gitea-token");

  it("handles Forgejo GET registration-token, dispatch return_run_info, and ActionRun fields", async () => {
    const remote = parseForgejoRemote("https://codeberg.org/alice/demo.git");
    if (!remote) throw new Error("expected Forgejo remote");
    const { fetch, requests } = makeFakeFetch((req) => {
      if (req.method === "GET" && req.url.endsWith("/api/v1/user")) {
        return { status: 200, body: { login: "alice" } };
      }
      if (req.method === "GET" && req.url.endsWith("/actions/runners/registration-token")) {
        return { status: 200, body: { token: "fj-reg-token" } };
      }
      if (
        req.method === "POST" &&
        req.url.includes("/actions/workflows/opscrew-deploy.yml/dispatches")
      ) {
        return { status: 201, body: { id: 42, run_number: 7 } };
      }
      if (req.method === "GET" && req.url.includes("/actions/runs?")) {
        return {
          status: 200,
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 42,
                status: "success",
                prettyref: "main",
                commit_sha: "abc123",
                created: "2026-11-26T10:00:00Z",
                index_in_repo: 7,
                workflow_id: "opscrew-deploy.yml",
              },
            ],
          },
        };
      }
      if (req.method === "PUT" && req.url.includes("/actions/secrets/OPSCREW_HOST")) {
        return { status: 204 };
      }
      if (req.method === "GET" && req.url.includes("/actions/secrets?")) {
        return { status: 200, body: [{ name: "OPSCREW_HOST" }] };
      }
      return { status: 404, body: { message: `unexpected ${req.method} ${req.url}` } };
    });

    const connector = forgejoDefinition.createConnector({
      token: forgejoToken,
      host: "codeberg.org",
      fetch,
    });
    const check = await connector.verifyCredentials();
    expect(check).toMatchObject({ ok: true, identity: "alice" });
    const client = connector.client;
    if (!client) throw new Error("expected Forgejo client");

    const envCap = await client.environmentCapability(remote);
    expect(envCap.available).toBe(false);

    const reg = await client.createRunnerToken(remote);
    expect(reg.token).toBe("fj-reg-token");
    expect(
      requests.find((r) => r.url.endsWith("/actions/runners/registration-token"))?.method,
    ).toBe("GET");

    await expect(client.triggerPipeline(remote, { ref: "main" })).rejects.toThrow(
      /workflowFile is required/,
    );

    const dispatched = await client.triggerPipeline(remote, {
      ref: "main",
      workflowFile: ".forgejo/workflows/opscrew-deploy.yml",
      inputs: { digest: "sha256:aaa" },
    });
    expect(dispatched).toMatchObject({
      id: 42,
      status: "queued",
      url: "https://codeberg.org/alice/demo/actions/runs/7",
    });
    const dispatchReq = requests.find((r) => r.url.includes("/dispatches"));
    expect(dispatchReq?.body).toMatchObject({ ref: "main", return_run_info: true });

    const runs = await client.listPipelineRuns(remote, { ref: "main", limit: 5 });
    expect(runs).toEqual([
      {
        id: 42,
        status: "success",
        url: "https://codeberg.org/alice/demo/actions/runs/7",
        ref: "main",
        sha: "abc123",
        createdAt: "2026-11-26T10:00:00Z",
      },
    ]);

    await client.setSecret(remote, "OPSCREW_HOST", "203.0.113.10");
    expect(await client.secretExists(remote, "OPSCREW_HOST")).toBe(true);
  });

  it("handles Gitea POST registration-token, dispatch query return_run_details, and tasks fallback", async () => {
    const remote = parseGiteaRemote("https://gitea.com/bob/app.git");
    if (!remote) throw new Error("expected Gitea remote");
    const { fetch, requests } = makeFakeFetch((req) => {
      if (req.method === "POST" && req.url.endsWith("/actions/runners/registration-token")) {
        return { status: 200, body: { token: "gt-reg-token" } };
      }
      if (
        req.method === "POST" &&
        req.url.includes("/actions/workflows/opscrew-deploy.yml/dispatches?return_run_details=true")
      ) {
        return {
          status: 200,
          body: { id: 99, html_url: "https://gitea.com/bob/app/actions/runs/99" },
        };
      }
      if (req.method === "GET" && req.url.includes("/actions/runs")) {
        return { status: 404, body: { message: "not supported" } };
      }
      if (req.method === "GET" && req.url.includes("/actions/tasks")) {
        return {
          status: 200,
          body: {
            total_count: 1,
            workflow_runs: [
              {
                id: 99,
                status: "running",
                head_branch: "main",
                head_sha: "def456",
                created_at: "2026-11-26T11:00:00Z",
                url: "https://gitea.com/bob/app/actions/runs/99",
              },
            ],
          },
        };
      }
      if (req.method === "GET" && req.url.includes("/actions/runners")) {
        return {
          status: 200,
          body: {
            total_count: 1,
            runners: [
              { id: 5, name: "srv-1", status: "idle", busy: false, labels: ["opscrew-app-prod"] },
            ],
          },
        };
      }
      return { status: 404 };
    });

    const client = giteaDefinition.createConnector({
      token: giteaToken,
      host: "gitea.com",
      fetch,
    }).client;
    if (!client) throw new Error("expected Gitea client");

    const reg = await client.createRunnerToken(remote);
    expect(reg.token).toBe("gt-reg-token");
    expect(
      requests.find((r) => r.url.endsWith("/actions/runners/registration-token"))?.method,
    ).toBe("POST");

    const dispatched = await client.triggerPipeline(remote, {
      ref: "main",
      workflowFile: ".gitea/workflows/opscrew-deploy.yml",
    });
    expect(dispatched).toEqual({
      id: 99,
      status: "queued",
      url: "https://gitea.com/bob/app/actions/runs/99",
      ref: "main",
    });

    const runs = await client.listPipelineRuns(remote, { ref: "main", limit: 5 });
    expect(runs[0]).toMatchObject({ id: 99, status: "running", sha: "def456" });

    const runners = await client.listRunners(remote);
    expect(runners).toEqual([
      { id: 5, name: "srv-1", online: true, busy: false, labels: ["opscrew-app-prod"] },
    ]);
  });

  it("refuses calls whose remote.host differs from the client's configured host without sending requests", async () => {
    const { fetch, requests } = makeFakeFetch(() => ({ status: 200, body: {} }));
    const client = forgejoDefinition.createConnector({
      token: forgejoToken,
      host: "codeberg.org",
      fetch,
    }).client;
    if (!client) throw new Error("expected Forgejo client");

    const otherRemote = parseForgejoRemote("https://forgejo.example.internal/team/app.git");
    if (!otherRemote) throw new Error("expected self-hosted Forgejo remote");

    await expect(client.getRepo(otherRemote)).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    } satisfies Partial<OpsCrewError>);
    await expect(client.setSecret(otherRemote, "OPSCREW_HOST", "1.2.3.4")).rejects.toMatchObject({
      code: "PHASE_PRECONDITION",
    } satisfies Partial<OpsCrewError>);
    expect(requests).toEqual([]);
  });

  it("wraps unexpected API payloads as redacted OpsCrewError PROVIDER_ERROR instead of ZodError", async () => {
    const { fetch } = makeFakeFetch((req) => {
      if (req.url.endsWith("/api/v1/user")) {
        return { status: 200, body: { unexpected: true } };
      }
      if (req.url.endsWith("/repos/alice/demo")) {
        return { status: 200, body: { id: "not-a-number" } };
      }
      return { status: 404 };
    });
    const client = forgejoDefinition.createConnector({
      token: forgejoToken,
      host: "codeberg.org",
      fetch,
    }).client;
    if (!client) throw new Error("expected Forgejo client");

    await expect(client.whoAmI()).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof OpsCrewError &&
        err.code === "PROVIDER_ERROR" &&
        err.message.includes("unexpected user response"),
    );

    const remote = parseForgejoRemote("https://codeberg.org/alice/demo.git");
    if (!remote) throw new Error("expected Forgejo remote");
    await expect(client.getRepo(remote)).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof OpsCrewError &&
        err.code === "PROVIDER_ERROR" &&
        err.message.includes("unexpected repository response"),
    );
  });
});
