/**
 * Feature 033 (T3309) real-Docker proof:
 * 1. Caddy load balancing across 2 real `kamal-proxy` backends (`shop-kamal-proxy:80` + a simulated
 *    remote copy proxy on `18090`):
 *    - Distributes HTTP requests across both copies (`copy-1` and `copy-2`).
 *    - When `copy-2` stops, Caddy fails over automatically and keeps serving HTTP 200 from `copy-1`.
 * 2. nginx load balancing across the same 2 real `kamal-proxy` backends:
 *    - Distributes HTTP requests across both copies.
 *    - When `copy-2` stops, nginx fails over (`proxy_next_upstream` + `max_fails=2`) and keeps
 *      serving HTTP 200 from `copy-1`.
 * 3. OpenLiteSpeed multi-copy `type loadbalancer` config validates cleanly inside the real
 *    OpenLiteSpeed container (`openlitespeed -t`).
 *
 * Gated by `OPSCREW_DOCKER_TESTS=1` with a running Docker daemon. Every container and network is
 * removed in `afterAll`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMAGES } from "../pins";
import { caddySite } from "../runtime/services";
import { appProxyAlias } from "./index";
import { NGINX_CONF, NGINX_PORTS, nginxSite } from "./nginx";
import {
  OPENLITESPEED_CATCH_ALL,
  OPENLITESPEED_CHECK,
  OPENLITESPEED_ERROR_PAGE,
  OPENLITESPEED_INPUT,
  openlitespeedConf,
  openlitespeedSite,
} from "./openlitespeed";

function dockerSkipReason(): string | undefined {
  if (process.env.OPSCREW_DOCKER_TESTS !== "1") return "set OPSCREW_DOCKER_TESTS=1 to run it";
  const check = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 30_000,
    stdio: "ignore",
  });
  return check.status === 0 ? undefined : "the Docker daemon is not running";
}

const SKIP = dockerSkipReason();
if (SKIP !== undefined) console.warn(`Skipping 033 scaling Docker tests: ${SKIP}.`);

const LABEL = "opscrew.test=033-scaling";
const TIMEOUT = 300_000;

function unique(prefix: string): string {
  return `opscrew-033-${prefix}-${randomBytes(4).toString("hex")}`;
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
}

function dockerQuiet(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() =>
        typeof addr === "object" && addr !== null
          ? resolve(addr.port)
          : reject(new Error("no free port")),
      );
    });
  });
}

function httpGet(
  port: number,
  host: string,
  reqPath = "/",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        headers: { host },
        agent: false,
        timeout: 10_000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function until<T>(label: string, fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${label} timed out (${String(last)})`);
}

function copyAppScript(copyId: string): string {
  return [
    'const http = require("node:http");',
    'process.on("SIGTERM", () => process.exit(0));',
    "http.createServer((req, res) => {",
    '  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }',
    '  res.setHeader("Content-Type", "application/json");',
    `  res.end(JSON.stringify({ copy: ${JSON.stringify(copyId)} }));`,
    "}).listen(3000);",
  ].join("\n");
}

describe.skipIf(SKIP !== undefined)(
  "033 multi-copy load balancing & failover on Docker (T3309)",
  () => {
    let work = "";
    const createdContainers = new Set<string>();
    const createdNetworks = new Set<string>();

    function trackContainer(name: string): string {
      createdContainers.add(name);
      return name;
    }

    function createNet(prefix: string): string {
      const net = unique(prefix);
      createdNetworks.add(net);
      docker(["network", "create", "--label", LABEL, net]);
      return net;
    }

    function startCopyApp(net: string, alias: string, copyId: string): string {
      const container = trackContainer(unique(`app-${copyId}`));
      docker([
        "run",
        "-d",
        "--name",
        container,
        "--label",
        LABEL,
        "--network",
        net,
        "--network-alias",
        alias,
        IMAGES.nodeAlpine.ref,
        "node",
        "-e",
        copyAppScript(copyId),
      ]);
      return container;
    }

    function startKamalProxy(edgeNet: string, alias: string, internalNet: string): string {
      const container = trackContainer(unique(`kp-${alias}`));
      docker([
        "run",
        "-d",
        "--name",
        container,
        "--label",
        LABEL,
        "--network",
        edgeNet,
        "--network-alias",
        alias,
        IMAGES.kamalProxy.ref,
      ]);
      docker(["network", "connect", "--alias", "kamal-proxy", internalNet, container]);
      return container;
    }

    function deployRoute(proxyContainer: string, service: string, target: string, host: string) {
      docker([
        "exec",
        proxyContainer,
        "kamal-proxy",
        "deploy",
        service,
        "--target",
        target,
        "--host",
        host,
        "--health-check-path",
        "/health",
      ]);
    }

    beforeAll(async () => {
      work = await mkdtemp(path.join(tmpdir(), "opscrew-033-docker-"));
    });

    afterAll(async () => {
      for (const c of createdContainers) dockerQuiet(["rm", "-f", "-v", c]);
      for (const n of createdNetworks) dockerQuiet(["network", "rm", n]);
      if (work !== "") await rm(work, { recursive: true, force: true });
    }, TIMEOUT);

    it(
      "balances across 2 real kamal-proxy backends behind Caddy and fails over when copy 2 stops",
      async () => {
        const edgeNet = createNet("caddy-edge");
        const net1 = createNet("caddy-c1");
        const net2 = createNet("caddy-c2");

        const app1 = startCopyApp(net1, "app", "copy-1");
        const app2 = startCopyApp(net2, "app", "copy-2");
        const proxy1 = startKamalProxy(edgeNet, appProxyAlias("shop"), net1);
        const proxy2 = startKamalProxy(edgeNet, "copy-web-2-proxy", net2);

        deployRoute(proxy1, "shop", `${app1}:3000`, "shop.test");
        deployRoute(proxy2, "shop", `${app2}:3000`, "shop.test");

        const dir = path.join(work, "caddy");
        await mkdir(dir, { recursive: true });
        const siteLines = caddySite({
          mode: "tunnel",
          hosts: ["shop.test"],
          upstream: `${appProxyAlias("shop")}:80`,
          loadBalance: {
            upstreams: ["copy-web-2-proxy:80"],
            policy: "round_robin",
            healthPath: "/health",
          },
        });
        await writeFile(
          path.join(dir, "Caddyfile"),
          ["{", "\tauto_https off", "}", "", ...siteLines].join("\n"),
        );

        const port = await freePort();
        const caddy = trackContainer(unique("caddy"));
        docker([
          "run",
          "-d",
          "--name",
          caddy,
          "--label",
          LABEL,
          "--network",
          edgeNet,
          "-p",
          `127.0.0.1:${port}:80`,
          "-v",
          `${dir}/Caddyfile:/etc/caddy/Caddyfile:ro`,
          IMAGES.caddy.ref,
        ]);

        // Wait until Caddy sees both upstreams healthy and serves both copies.
        const seen = new Set<string>();
        await until("caddy round-robin across both copies", async () => {
          const res = await httpGet(port, "shop.test", "/");
          if (res.status === 200) {
            const parsed = JSON.parse(res.body) as { copy: string };
            seen.add(parsed.copy);
          }
          return seen.has("copy-1") && seen.has("copy-2") ? true : undefined;
        });

        // Stop copy 2's proxy and verify Caddy keeps returning 200 from copy-1 (zero 5xx).
        docker(["stop", "-t", "1", proxy2]);
        for (let i = 0; i < 6; i++) {
          const res = await httpGet(port, "shop.test", "/");
          expect(res.status).toBe(200);
          expect((JSON.parse(res.body) as { copy: string }).copy).toBe("copy-1");
        }
      },
      TIMEOUT,
    );

    it(
      "balances across 2 real kamal-proxy backends behind nginx and fails over when copy 2 stops",
      async () => {
        const edgeNet = createNet("nginx-edge");
        const net1 = createNet("nginx-c1");
        const net2 = createNet("nginx-c2");

        const app1 = startCopyApp(net1, "app", "copy-1");
        const app2 = startCopyApp(net2, "app", "copy-2");
        const proxy1 = startKamalProxy(edgeNet, appProxyAlias("shop"), net1);
        const proxy2 = startKamalProxy(edgeNet, "copy-web-2-proxy", net2);

        deployRoute(proxy1, "shop", `${app1}:3000`, "shop.test");
        deployRoute(proxy2, "shop", `${app2}:3000`, "shop.test");

        const dir = path.join(work, "nginx");
        await mkdir(path.join(dir, "sites"), { recursive: true });
        await writeFile(path.join(dir, "nginx.conf"), NGINX_CONF);
        const site = nginxSite({
          app: "shop",
          mode: "tunnel",
          hosts: ["shop.test"],
          maxBodyMb: 10,
          loadBalance: {
            upstreams: ["copy-web-2-proxy:80"],
            policy: "round_robin",
          },
        });
        await writeFile(path.join(dir, "sites", "shop.conf"), `${site.join("\n")}\n`);

        const port = await freePort();
        const nginx = trackContainer(unique("nginx"));
        docker([
          "run",
          "-d",
          "--name",
          nginx,
          "--label",
          LABEL,
          "--network",
          edgeNet,
          "-p",
          `127.0.0.1:${port}:${NGINX_PORTS.http}`,
          "-v",
          `${dir}/nginx.conf:/etc/nginx/nginx.conf:ro`,
          "-v",
          `${dir}/sites:/etc/nginx/sites:ro`,
          IMAGES.nginx.ref,
        ]);

        const seen = new Set<string>();
        await until("nginx round-robin across both copies", async () => {
          const res = await httpGet(port, "shop.test", "/");
          if (res.status === 200) {
            const parsed = JSON.parse(res.body) as { copy: string };
            seen.add(parsed.copy);
          }
          return seen.has("copy-1") && seen.has("copy-2") ? true : undefined;
        });

        docker(["stop", "-t", "1", proxy2]);
        for (let i = 0; i < 6; i++) {
          const res = await httpGet(port, "shop.test", "/");
          expect(res.status).toBe(200);
          expect((JSON.parse(res.body) as { copy: string }).copy).toBe("copy-1");
        }
      },
      TIMEOUT,
    );

    it(
      "validates OpenLiteSpeed multi-copy loadbalancer site syntax with OPENLITESPEED_CHECK",
      async () => {
        const edgeNet = createNet("ols-edge");
        const net1 = createNet("ols-c1");
        const net2 = createNet("ols-c2");
        const app1 = startCopyApp(net1, "app", "copy-1");
        const app2 = startCopyApp(net2, "app", "copy-2");
        const proxy1 = startKamalProxy(edgeNet, appProxyAlias("shop"), net1);
        const proxy2 = startKamalProxy(edgeNet, "copy-web-2-proxy", net2);
        deployRoute(proxy1, "shop", `${app1}:3000`, "shop.test");
        deployRoute(proxy2, "shop", `${app2}:3000`, "shop.test");

        const dir = path.join(work, "ols");
        const sitesDir = path.join(dir, "sites");
        await mkdir(sitesDir, { recursive: true });

        const rendered = openlitespeedSite({
          app: "shop",
          mode: "tunnel",
          hosts: ["shop.test"],
          loadBalance: {
            upstreams: ["copy-web-2-proxy:80"],
          },
        });
        for (const [name, lines] of Object.entries(rendered)) {
          await writeFile(path.join(sitesDir, name), `${lines.join("\n")}\n`);
        }
        await writeFile(path.join(dir, "httpd_config.conf"), openlitespeedConf(false));
        await writeFile(path.join(dir, "catchall.conf"), OPENLITESPEED_CATCH_ALL);
        await writeFile(path.join(dir, "error.html"), OPENLITESPEED_ERROR_PAGE);
        await writeFile(path.join(dir, "check.sh"), OPENLITESPEED_CHECK);

        const res = dockerQuiet([
          "run",
          "--rm",
          "--label",
          LABEL,
          "--network",
          edgeNet,
          "--entrypoint",
          "sh",
          "-v",
          `${dir}/httpd_config.conf:${OPENLITESPEED_INPUT.conf}:ro`,
          "-v",
          `${dir}/catchall.conf:${OPENLITESPEED_INPUT.catchAll}:ro`,
          "-v",
          `${dir}/error.html:${OPENLITESPEED_INPUT.errorPage}:ro`,
          "-v",
          `${dir}/check.sh:${OPENLITESPEED_INPUT.check}:ro`,
          "-v",
          `${sitesDir}:${OPENLITESPEED_INPUT.sites}:ro`,
          IMAGES.openlitespeed.ref,
          OPENLITESPEED_INPUT.check,
        ]);
        expect(res.status, res.stdout + res.stderr).toBe(0);
      },
      TIMEOUT,
    );
  },
);
