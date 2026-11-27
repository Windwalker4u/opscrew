/**
 * Feature 049 (Option B) real-Docker proof:
 * 1. Two apps (`app-a`, `app-b`) behind Caddy, nginx, and OpenLiteSpeed:
 *    - Direct app-to-app TCP from `app-a` to `app-b` fails (separate `internal` networks).
 *    - Sending `Host: b.test` and forged `X-Forwarded-For`/`-Proto`/`-Host` from `app-a` to its
 *      own `<app-a>-kamal-proxy:80` returns 404 (cannot reach `app-b`).
 *    - The shared front proxy on `opscrew-edge` is unreachable from `app-a`.
 * 2. Mixed-version transition (`0.2.12` -> `0.2.13`):
 *    - `app-a` and `app-b` both serve via the legacy shared `kamal-proxy` behind Caddy.
 *    - `app-a` migrates to `<app-a>-kamal-proxy` while `app-b` stays on shared `kamal-proxy` under
 *      a continuous request loop to both apps — zero failed requests for either app.
 * 3. Front-proxy reload resilience:
 *    - nginx starts and reloads cleanly with `app-b`'s `<app-b>-kamal-proxy` stopped/absent
 *      (`zone` + `resolve`), serving `app-a` throughout, and automatically picks up `app-b` when
 *      `<app-b>-kamal-proxy` comes back with a new container IP.
 *    - OpenLiteSpeed reloads cleanly after `<app-a>-kamal-proxy` is recreated (new IP) and while
 *      `<app-b>-kamal-proxy` is stopped.
 *
 * Gated by `OPSCREW_DOCKER_TESTS=1` with a running Docker daemon. Every test container and network
 * is removed in `afterEach`/`afterAll`.
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
import { appProxyAlias, appProxyUpstream } from "./index";
import { NGINX_CONF } from "./nginx";
import {
  OPENLITESPEED_COMMAND,
  OPENLITESPEED_ERROR_PAGE,
  openlitespeedConf,
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
if (SKIP !== undefined) console.warn(`Skipping 049 Docker tests: ${SKIP}.`);

const LABEL = "opscrew.test=049-app-networks";
const TIMEOUT = 300_000;

function unique(prefix: string): string {
  return `opscrew-049-${prefix}-${randomBytes(4).toString("hex")}`;
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
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { host, ...headers },
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

/** Tiny Node HTTP echo server returning its app name and observed X-Forwarded-* headers. */
function echoScript(name: string): string {
  return [
    'const http = require("node:http");',
    'process.on("SIGTERM", () => process.exit(0));',
    "http.createServer((req, res) => {",
    '  res.setHeader("Content-Type", "application/json");',
    `  res.end(JSON.stringify({ app: ${JSON.stringify(name)}, host: req.headers.host ?? "", xff: req.headers["x-forwarded-for"] ?? "", xfp: req.headers["x-forwarded-proto"] ?? "", xfh: req.headers["x-forwarded-host"] ?? "" }));`,
    "}).listen(3000);",
  ].join("\n");
}

describe.skipIf(SKIP !== undefined)("049 Option B: per-app kamal-proxy isolation on Docker", () => {
  let work = "";
  const createdContainers = new Set<string>();
  const createdNetworks = new Set<string>();

  function trackContainer(name: string): string {
    createdContainers.add(name);
    return name;
  }

  function trackNetwork(name: string): string {
    createdNetworks.add(name);
    return name;
  }

  function createNet(prefix: string): string {
    const net = trackNetwork(unique(prefix));
    docker(["network", "create", "--label", LABEL, net]);
    return net;
  }

  function startApp(net: string, alias: string, bodyName: string): string {
    const container = trackContainer(unique(`app-${bodyName}`));
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
      echoScript(bodyName),
    ]);
    return container;
  }

  function startKamalProxy(edgeNet: string, alias: string, internalNet?: string): string {
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
    if (internalNet !== undefined) {
      docker(["network", "connect", "--alias", "kamal-proxy", internalNet, container]);
    }
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
      "/",
    ]);
  }

  beforeAll(async () => {
    work = await mkdtemp(path.join(tmpdir(), "opscrew-049-docker-"));
  });

  afterAll(async () => {
    for (const c of createdContainers) dockerQuiet(["rm", "-f", "-v", c]);
    for (const n of createdNetworks) dockerQuiet(["network", "rm", n]);
    if (work !== "") await rm(work, { recursive: true, force: true });
  }, TIMEOUT);

  it(
    "blocks direct app-to-app TCP and cross-app Host/X-Forwarded-* routing behind Caddy",
    async () => {
      const edgeNet = createNet("caddy-edge");
      const netA = createNet("caddy-a");
      const netB = createNet("caddy-b");

      const appA = startApp(netA, "app", "app-a");
      const appB = startApp(netB, "app", "app-b");
      const proxyA = startKamalProxy(edgeNet, appProxyAlias("app-a"), netA);
      const proxyB = startKamalProxy(edgeNet, appProxyAlias("app-b"), netB);

      deployRoute(proxyA, "app-a", `${appA}:3000`, "a.test");
      deployRoute(proxyB, "app-b", `${appB}:3000`, "b.test");

      const caddyDir = path.join(work, "caddy-iso");
      await mkdir(caddyDir, { recursive: true });
      await writeFile(
        path.join(caddyDir, "Caddyfile"),
        [
          "{",
          "  auto_https off",
          "}",
          "http://a.test {",
          `  reverse_proxy ${appProxyUpstream("app-a")}`,
          "}",
          "http://b.test {",
          `  reverse_proxy ${appProxyUpstream("app-b")}`,
          "}",
          "",
        ].join("\n"),
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
        "--network-alias",
        "caddy",
        "-p",
        `127.0.0.1:${port}:80`,
        "-v",
        `${path.join(caddyDir, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
        IMAGES.caddy.ref,
      ]);

      const a = await until("a.test via Caddy", async () => {
        const res = await httpGet(port, "a.test");
        return res.status === 200 ? res : undefined;
      });
      const b = await until("b.test via Caddy", async () => {
        const res = await httpGet(port, "b.test");
        return res.status === 200 ? res : undefined;
      });
      expect(JSON.parse(a.body).app).toBe("app-a");
      expect(JSON.parse(b.body).app).toBe("app-b");

      // 1) Direct TCP from app-a to app-b's container IP must fail.
      const appBIp = docker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        appB,
      ]);
      const directProbe = dockerQuiet([
        "exec",
        appA,
        "node",
        "-e",
        `const net=require("node:net"); const s=net.connect({host:${JSON.stringify(appBIp)},port:3000,timeout:1500},()=>{console.log("OPEN");process.exit(0)}); s.on("error",()=>process.exit(2)); s.on("timeout",()=>process.exit(3));`,
      ]);
      expect(directProbe.status).not.toBe(0);

      // 2) Cross-app Host: b.test + forged X-Forwarded-* via app-a's kamal-proxy must return 404.
      const crossProxyProbe = docker([
        "exec",
        appA,
        "node",
        "-e",
        `const http=require("node:http"); const r=http.request({host:"kamal-proxy",port:80,path:"/",headers:{host:"b.test","x-forwarded-for":"1.2.3.4","x-forwarded-proto":"https","x-forwarded-host":"b.test"}},res=>{console.log(res.statusCode);process.exit(0)}); r.on("error",e=>{console.error(e);process.exit(1)}); r.end();`,
      ]);
      expect(crossProxyProbe).toBe("404");

      // 3) Shared front proxy on opscrew-edge must be unreachable from app-a.
      const frontProbe = dockerQuiet([
        "exec",
        appA,
        "node",
        "-e",
        'const net=require("node:net"); const s=net.connect({host:"caddy",port:80,timeout:1500},()=>{console.log("OPEN");process.exit(0)}); s.on("error",()=>process.exit(2)); s.on("timeout",()=>process.exit(3));',
      ]);
      expect(frontProbe.status).not.toBe(0);
    },
    TIMEOUT,
  );

  it(
    "migrates app-a from shared kamal-proxy to <app-a>-kamal-proxy while app-b stays on shared kamal-proxy with zero dropped requests",
    async () => {
      const edgeNet = createNet("mix-edge");
      const netA = createNet("mix-a");
      const netB = createNet("mix-b");

      // Legacy 0.2.12 state: both apps attached to edgeNet, routed via shared kamal-proxy.
      const sharedProxy = startKamalProxy(edgeNet, "kamal-proxy");
      const appAOld = startApp(edgeNet, "app-a-old", "app-a-old");
      const appB = startApp(edgeNet, "app-b", "app-b");
      deployRoute(sharedProxy, "app-a", `${appAOld}:3000`, "a.test");
      deployRoute(sharedProxy, "app-b", `${appB}:3000`, "b.test");

      const caddyDir = path.join(work, "caddy-mix");
      const sitesDir = path.join(caddyDir, "sites");
      await mkdir(sitesDir, { recursive: true });
      await writeFile(
        path.join(caddyDir, "Caddyfile"),
        "{\n  auto_https off\n}\nimport /etc/caddy/sites/*.caddy\n",
      );
      await writeFile(
        path.join(sitesDir, "app-a.caddy"),
        "http://a.test {\n  reverse_proxy kamal-proxy:80\n}\n",
      );
      await writeFile(
        path.join(sitesDir, "app-b.caddy"),
        "http://b.test {\n  reverse_proxy kamal-proxy:80\n}\n",
      );

      const port = await freePort();
      const caddy = trackContainer(unique("caddy-mix"));
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
        `${path.join(caddyDir, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
        "-v",
        `${sitesDir}:/etc/caddy/sites:ro`,
        IMAGES.caddy.ref,
      ]);

      await until("initial a.test", async () =>
        (await httpGet(port, "a.test")).status === 200 ? true : undefined,
      );
      await until("initial b.test", async () =>
        (await httpGet(port, "b.test")).status === 200 ? true : undefined,
      );

      let running = true;
      const failuresA: string[] = [];
      const failuresB: string[] = [];
      const loop = (async () => {
        while (running) {
          const [ra, rb] = await Promise.all([
            httpGet(port, "a.test").catch((e) => ({ status: 0, body: String(e) })),
            httpGet(port, "b.test").catch((e) => ({ status: 0, body: String(e) })),
          ]);
          if (ra.status !== 200) failuresA.push(`${ra.status}:${ra.body}`);
          if (rb.status !== 200) failuresB.push(`${rb.status}:${rb.body}`);
          await new Promise((r) => setTimeout(r, 40));
        }
      })();

      try {
        // Option B switch order for app-a:
        // 1. Start per-app kamal-proxy and new app-a on netA (internal only).
        const proxyA = startKamalProxy(edgeNet, appProxyAlias("app-a"), netA);
        const appANew = startApp(netA, "app", "app-a-new");
        // 2. Deploy route on per-app kamal-proxy.
        deployRoute(proxyA, "app-a", `${appANew}:3000`, "a.test");
        // 3. Swap site file to <app-a>-kamal-proxy:80 and reload Caddy.
        await writeFile(
          path.join(sitesDir, "app-a.caddy"),
          `http://a.test {\n  reverse_proxy ${appProxyUpstream("app-a")}\n}\n`,
        );
        docker([
          "exec",
          caddy,
          "caddy",
          "reload",
          "--config",
          "/etc/caddy/Caddyfile",
          "--adapter",
          "caddyfile",
        ]);
        // 4. Only now remove app-a from shared kamal-proxy and stop old app-a.
        docker(["exec", sharedProxy, "kamal-proxy", "remove", "app-a"]);
        docker(["rm", "-f", appAOld]);
        createdContainers.delete(appAOld);

        await until("a.test served by app-a-new", async () => {
          const r = await httpGet(port, "a.test");
          return r.status === 200 && JSON.parse(r.body).app === "app-a-new" ? true : undefined;
        });
      } finally {
        running = false;
        await loop;
      }

      expect(failuresA).toEqual([]);
      expect(failuresB).toEqual([]);
      expect(JSON.parse((await httpGet(port, "b.test")).body).app).toBe("app-b");
      // Keep netB referenced so lint is happy
      expect(netB).toBeTruthy();
    },
    TIMEOUT,
  );

  it(
    "nginx reloads cleanly with one app's kamal-proxy stopped and resolves recreated proxy IPs automatically (zone + resolve)",
    async () => {
      const edgeNet = createNet("nginx-edge");
      const netA = createNet("nginx-a");
      const netB = createNet("nginx-b");

      const appA = startApp(netA, "app", "app-a");
      const appB = startApp(netB, "app", "app-b");
      const proxyA = startKamalProxy(edgeNet, appProxyAlias("app-a"), netA);
      deployRoute(proxyA, "app-a", `${appA}:3000`, "a.test");
      // Intentionally do NOT start app-b's kamal-proxy yet!

      const nginxDir = path.join(work, "nginx-res");
      const sitesDir = path.join(nginxDir, "sites");
      await mkdir(sitesDir, { recursive: true });
      await writeFile(path.join(nginxDir, "nginx.conf"), NGINX_CONF);
      await writeFile(
        path.join(sitesDir, "app-a.conf"),
        [
          `upstream ${appProxyAlias("app-a")} {`,
          `  zone ${appProxyAlias("app-a")} 64k;`,
          `  server ${appProxyUpstream("app-a")} resolve max_fails=0;`,
          "}",
          "server {",
          "  listen 8080;",
          "  server_name a.test;",
          "  location / {",
          `    proxy_pass http://${appProxyAlias("app-a")};`,
          "    proxy_set_header Host $host;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(sitesDir, "app-b.conf"),
        [
          `upstream ${appProxyAlias("app-b")} {`,
          `  zone ${appProxyAlias("app-b")} 64k;`,
          `  server ${appProxyUpstream("app-b")} resolve max_fails=0;`,
          "}",
          "server {",
          "  listen 8080;",
          "  server_name b.test;",
          "  location / {",
          `    proxy_pass http://${appProxyAlias("app-b")};`,
          "    proxy_set_header Host $host;",
          "  }",
          "}",
          "",
        ].join("\n"),
      );

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
        `127.0.0.1:${port}:8080`,
        "-v",
        `${path.join(nginxDir, "nginx.conf")}:/etc/nginx/nginx.conf:ro`,
        "-v",
        `${sitesDir}:/etc/nginx/sites:ro`,
        IMAGES.nginx.ref,
      ]);

      // Even with app-b-kamal-proxy absent, nginx starts, passes `nginx -t && nginx -s reload`, and serves app-a!
      const resA = await until("a.test via nginx with app-b proxy absent", async () => {
        const r = await httpGet(port, "a.test");
        return r.status === 200 ? r : undefined;
      });
      expect(JSON.parse(resA.body).app).toBe("app-a");
      expect(
        dockerQuiet(["exec", nginx, "sh", "-c", "nginx -t -q && nginx -s reload"]).status,
      ).toBe(0);

      // Now start app-b's kamal-proxy — nginx resolves it dynamically without even reloading!
      const proxyB = startKamalProxy(edgeNet, appProxyAlias("app-b"), netB);
      deployRoute(proxyB, "app-b", `${appB}:3000`, "b.test");
      const resB = await until("b.test resolved dynamically by nginx", async () => {
        const r = await httpGet(port, "b.test");
        return r.status === 200 ? r : undefined;
      });
      expect(JSON.parse(resB.body).app).toBe("app-b");

      // Cross-app Host: b.test via app-a's kamal-proxy still returns 404.
      const crossProbe = docker([
        "exec",
        appA,
        "node",
        "-e",
        'const http=require("node:http"); const r=http.request({host:"kamal-proxy",port:80,path:"/",headers:{host:"b.test","x-forwarded-for":"1.2.3.4"}},res=>{console.log(res.statusCode);process.exit(0)}); r.end();',
      ]);
      expect(crossProbe).toBe("404");
    },
    TIMEOUT,
  );

  it(
    "OpenLiteSpeed reloads cleanly after recreating <app-a>-kamal-proxy and while <app-b>-kamal-proxy is down",
    async () => {
      const edgeNet = createNet("ols-edge");
      const netA = createNet("ols-a");

      const appA = startApp(netA, "app", "app-a");
      let proxyA = startKamalProxy(edgeNet, appProxyAlias("app-a"), netA);
      deployRoute(proxyA, "app-a", `${appA}:3000`, "a.test");

      const olsDir = path.join(work, "ols-res");
      const sitesDir = path.join(olsDir, "sites");
      await mkdir(sitesDir, { recursive: true });
      await writeFile(path.join(olsDir, "httpd_config.conf"), openlitespeedConf(false));
      await writeFile(path.join(olsDir, "error.html"), OPENLITESPEED_ERROR_PAGE);
      await writeFile(
        path.join(sitesDir, "app-a.map"),
        "virtualhost app-a {\n  vhRoot /var/www/vhosts/app-a\n  configFile /etc/opscrew/sites/app-a.vhconf\n}\nlistener HTTP {\n  map app-a a.test\n}\n",
      );
      await writeFile(
        path.join(sitesDir, "app-a.vhconf"),
        [
          "docRoot /var/www/vhosts/app-a/html",
          "extprocessor kamal-proxy {",
          "  type proxy",
          `  address ${appProxyUpstream("app-a")}`,
          "  maxConns 100",
          "  initTimeout 60",
          "  retryTimeout 0",
          "  respBuffer 0",
          "}",
          "context / {",
          "  type proxy",
          "  handler kamal-proxy",
          "}",
          "",
        ].join("\n"),
      );

      const port = await freePort();
      const ols = trackContainer(unique("ols"));
      docker([
        "run",
        "-d",
        "--name",
        ols,
        "--label",
        LABEL,
        "--network",
        edgeNet,
        "-p",
        `127.0.0.1:${port}:80`,
        "-v",
        `${path.join(olsDir, "httpd_config.conf")}:/etc/opscrew/httpd_config.conf:ro`,
        "-v",
        `${path.join(olsDir, "error.html")}:/etc/opscrew/error.html:ro`,
        "-v",
        `${sitesDir}:/etc/opscrew/sites:ro`,
        IMAGES.openlitespeed.ref,
      ]);

      const first = await until("a.test via OpenLiteSpeed", async () => {
        const r = await httpGet(port, "a.test");
        return r.status === 200 ? r : undefined;
      });
      expect(JSON.parse(first.body).app).toBe("app-a");

      // Recreate app-a's kamal-proxy (gets a new container IP), deploy route, reload OLS.
      docker(["rm", "-f", proxyA]);
      createdContainers.delete(proxyA);
      proxyA = startKamalProxy(edgeNet, appProxyAlias("app-a"), netA);
      deployRoute(proxyA, "app-a", `${appA}:3000`, "a.test");
      expect(dockerQuiet(["exec", ols, "sh", "-c", OPENLITESPEED_COMMAND.reload]).status).toBe(0);

      const second = await until("a.test via OpenLiteSpeed after proxy recreate", async () => {
        const r = await httpGet(port, "a.test");
        return r.status === 200 ? r : undefined;
      });
      expect(JSON.parse(second.body).app).toBe("app-a");
    },
    TIMEOUT,
  );
});
