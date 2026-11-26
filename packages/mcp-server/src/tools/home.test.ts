/**
 * The MCP tools for a server at the user's home: the interview offers `server.home` and describes
 * `server.sshFrom`, and `opscrew_save_requirements` takes both; `opscrew_status` and
 * `opscrew_verify` return the same lines as the terminal, through the redactor, so no reply holds
 * the home's public address or the updater's token; only `opscrew_verify` starts the outside check.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readOwnServer, recordOwnServer } from "@opscrew/agents";
import {
  CLOUDFLARE_IPV4,
  CLOUDFLARE_RANGES,
  ED25519_FINGERPRINT,
  FakeHostServer,
  freshFacts,
  HOME_IPV4,
  HOME_IPV6,
  homeNetworkFacts,
  LAN_IPV4,
  ownPlan,
  ownRunner,
} from "@opscrew/agents/testing";
import type { FetchLike } from "@opscrew/contracts";
import { findExecutable, NodeCommandRunner, resolveProjectPaths } from "@opscrew/core";
import { fakeSecret, tempDir } from "@opscrew/core/testing";
import { DeployPlanSchema, writeArtifact } from "@opscrew/plan-schema";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpDeps } from "../deps";
import { registerDeployTools } from "./deploy";
import { registerInterviewTools } from "./interview";
import { registerStatusTool } from "./status";

const NOW = "2026-11-20T10:06:00.000Z";
const RUN_URL = "https://github.com/acme/shop/actions/runs/77";
const UPDATER_TOKEN = fakeSecret("cloudflare-token", "mcp-home-updater");

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** `shop` on a server at home behind Cloudflare's proxy, deployed by the server's runner. */
function homePlan() {
  const base = ownPlan({ proxied: true });
  return DeployPlanSchema.parse({
    ...base,
    target: { ...base.target, home: { ipv4: true } },
    dns: { ...base.dns, zone: "example.com" },
    security: { ...base.security, httpAllowedFrom: "edge" },
    environment: { runner: "server" },
    deployment: {
      lastApplyAt: "2026-11-20T09:00:00.000Z",
      firstDeployAt: "2026-11-20T09:30:00.000Z",
    },
  });
}

/** The server at home, its updater's last run at 10:04 having seen {@link HOME_IPV4}. */
function homeFacts(): FakeHostServer["facts"] {
  const seen = { ipv4: HOME_IPV4, ipv6: null };
  return {
    ...freshFacts({
      addresses: [
        { interface: "eth0", family: "ipv4", address: LAN_IPV4, public: false },
        { interface: "eth0", family: "ipv6", address: HOME_IPV6, public: true },
      ],
    }),
    containers: [{ name: "shop-app-1", project: "shop", ports: "", running: true }],
    dnsUpdaters: [
      {
        app: "shop",
        config: {
          schemaVersion: 1,
          app: "shop",
          zoneId: "0123456789abcdef0123456789abcdef",
          name: "shop.example.com",
          proxied: true,
          ipv4: true,
          ipv6: false,
        },
        configFile: { mode: "600", owner: "root" },
        token: { present: true, mode: "600", owner: "root", sha256: "c".repeat(64) },
        timer: { enabled: true, active: true },
        state: {
          schemaVersion: 1,
          version: 1,
          lastRun: "2026-11-20T10:04:12Z",
          lastSuccess: "2026-11-20T10:04:12Z",
          seen,
          records: seen,
          lastWrite: { at: "2026-11-20T09:12:40Z", changed: ["A"] },
        },
      },
    ],
  };
}

/** The site behind the proxy, and GitHub's API with the outside check's run. */
function fakeWorld() {
  const requests: { method: string; url: string }[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    requests.push({ method: init?.method ?? "GET", url });
    const parsed = new URL(url);
    if (/^[\d.]+$|^\[/.test(parsed.hostname)) throw new Error(`direct request to ${url}`);
    if (parsed.host === "api.github.com") {
      if (parsed.pathname.endsWith("/opscrew-outside-check.yml/dispatches")) {
        return Response.json({ workflow_run_id: 77, html_url: RUN_URL });
      }
      if (parsed.pathname === "/repos/acme/shop/actions/runs/77") {
        return Response.json({
          id: 77,
          status: "completed",
          conclusion: "success",
          html_url: RUN_URL,
          head_sha: "abc123",
          created_at: NOW,
        });
      }
      if (parsed.pathname === "/repos/acme/shop/actions/runs/77/attempts/1/jobs") {
        return Response.json({
          jobs: [
            { name: "http", conclusion: "success" },
            { name: "https", conclusion: "success" },
          ],
        });
      }
      return Response.json({ default_branch: "main", private: true, workflow_runs: [] });
    }
    if (url.startsWith("http://shop.example.com")) {
      return new Response(null, {
        status: 308,
        headers: { location: `https://shop.example.com${parsed.pathname}` },
      });
    }
    if (url === "https://shop.example.com/" || url === "https://shop.example.com/api/health") {
      return new Response("ok", {
        headers: {
          "strict-transport-security": "max-age=31536000; includeSubDomains",
          "x-content-type-options": "nosniff",
          "x-frame-options": "SAMEORIGIN",
          "referrer-policy": "strict-origin-when-cross-origin",
        },
      });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, requests };
}

/** The MCP server over a deployed home app, connected to a client. */
async function connect() {
  const root = await tempDir("opscrew-mcp-home-");
  const git = new NodeCommandRunner();
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", "https://github.com/acme/shop.git"],
  ]) {
    await git.run("git", ["-C", root, ...args]);
  }
  await writeFile(path.join(root, ".gitignore"), ".opscrew/\n");
  await writeArtifact("plan", path.join(root, "opscrew", "plan.yaml"), homePlan());
  const env: Record<string, string | undefined> = {
    OPSCREW_HOME: path.join(root, ".home-opscrew"),
    GITHUB_TOKEN: fakeSecret("github-pat", "mcp-home"),
    OPSCREW_DNS_UPDATER_TOKEN: UPDATER_TOKEN,
  };
  const paths = resolveProjectPaths(root, { env });
  await recordOwnServer(paths, {
    host: LAN_IPV4,
    port: 22,
    user: "root",
    agent: true,
    serve: "proxy",
    hostKey: ED25519_FINGERPRINT,
    home: {
      sshFrom: ["192.168.1.0/24", "fe80::/10"],
      network: {
        detectedAt: "2026-11-20T08:00:00.000Z",
        lan: {
          address: LAN_IPV4,
          network: "192.168.1.0/24",
          interface: "eth0",
          gateway: "192.168.1.1",
        },
        ipv4: "seen",
        noNat: false,
        ipv6: "absent",
      },
    },
  });
  const homeDir = path.join(root, "user");
  await mkdir(homeDir, { recursive: true });
  const host = new FakeHostServer(homeFacts());
  host.homeNetwork = homeNetworkFacts();
  const world = fakeWorld();
  const deps = resolveMcpDeps({
    version: "0.0.0-test",
    env,
    fetch: world.fetch,
    runner: ownRunner(),
    clock: { now: () => new Date(NOW) },
    cwd: root,
  });
  const server = new McpServer({ name: "opscrew", version: "0.0.0-test" });
  registerInterviewTools(server, deps);
  registerStatusTool(server, deps, { services: { own: { host }, deploys: null } });
  registerDeployTools(server, deps, {
    verify: {
      fetch: world.fetch,
      resolver: { resolve4: async () => [CLOUDFLARE_IPV4], resolve6: async () => [] },
      tlsConnect: async () => ({
        subjectCommonName: "shop.example.com",
        subjectAltNames: ["shop.example.com"],
        validFrom: "2026-10-20T00:00:00.000Z",
        validTo: "2027-01-18T00:00:00.000Z",
        issuer: "Let's Encrypt",
      }),
      tcpConnect: async (address, port) => {
        throw new Error(`a probe from this computer: ${address}:${port}`);
      },
      cloudflareRanges: CLOUDFLARE_RANGES,
      own: { host, homeDir },
    },
  });
  const client = new Client({ name: "opscrew-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  const outputs: CallToolResult[] = [];
  return {
    paths,
    world,
    outputs,
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      outputs.push(result);
      return result;
    },
  };
}

const textOf = (result: CallToolResult) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const dispatches = (h: Awaited<ReturnType<typeof connect>>) =>
  h.world.requests.filter((r) => r.url.endsWith("/dispatches"));

describe.skipIf(!findExecutable("git"))(
  "MCP tools for a server at home",
  { timeout: 60_000 },
  () => {
    it("the interview offers server.home, describes server.sshFrom, and saves both", async () => {
      const h = await connect();
      const questions = await h.call("opscrew_interview_questions");
      const text = textOf(questions);
      expect(text).toContain("Is this server at your home, on your home internet connection?");
      expect(text).toContain("don't ask server.reachable");
      expect(text).toContain("server.sshFrom");
      expect(text).toContain("the home network design finds, plus fe80::/10");
      const saved = await h.call("opscrew_save_requirements", {
        answers: {
          provider: "own",
          expectedMonthlyUsers: "<1k",
          budgetMonthly: "10 EUR",
          uptime: "standard",
          dataCriticality: "none",
          domain: "shop.example.com",
          dnsProvider: "cloudflare",
          "server.host": "192.168.1.30",
          "server.user": "ana",
          "server.key": "agent",
          "server.home": true,
          "server.sshFrom": "192.168.1.0/24 10.8.0.0/24",
          "server.serve": "proxy",
        },
      });
      expect(saved.isError, textOf(saved)).toBeFalsy();
      expect(await readOwnServer(h.paths)).toMatchObject({
        host: "192.168.1.30",
        serve: "proxy",
        home: { sshFrom: ["192.168.1.0/24", "10.8.0.0/24"] },
      });
    });

    it("status shows the updater's lines through the redactor and starts no outside check", async () => {
      const h = await connect();
      const result = await h.call("opscrew_status");
      expect(result.isError, textOf(result)).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("Updater      every 2 minutes · last run 10:04 UTC, ok");
      expect(text).toContain("  sees       IPv4 (hidden: behind Cloudflare's proxy), no IPv6");
      expect(dispatches(h)).toEqual([]);
      for (const hidden of [HOME_IPV4, UPDATER_TOKEN]) {
        expect(JSON.stringify(h.outputs)).not.toContain(hidden);
      }
    });

    it("verify starts the outside check and returns its result, with no home address", async () => {
      const h = await connect();
      const result = await h.call("opscrew_verify");
      expect(result.isError, textOf(result)).toBeFalsy();
      expect(dispatches(h)).toHaveLength(1);
      const outside = (
        result.structuredContent as { checks: { id: string; status: string; message: string }[] }
      ).checks.find((check) => check.id === "outside-check");
      expect(outside).toMatchObject({ status: "pass" });
      expect(textOf(result)).toContain("Port 443 answered from outside your home");
      for (const hidden of [HOME_IPV4, UPDATER_TOKEN]) {
        expect(JSON.stringify(h.outputs)).not.toContain(hidden);
      }
    });
  },
);
