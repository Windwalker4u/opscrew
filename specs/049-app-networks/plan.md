# Implementation Plan: Feature 049 — Per-app `kamal-proxy` and network isolation (Option B)

**Feature:** `049-app-networks` | **Spec:** [spec.md](spec.md) | **Research:** [research.md](research.md)

## Architecture Summary

Each OpsCrew app runs its own `kamal-proxy` container (`mem_limit: 32m`) inside its own Docker
Compose project, bridging only that app's private `internal` network and the shared `opscrew-edge`
network under the alias `<app>-kamal-proxy`. Every app container (`app`, workers, cron, backing
services) attaches ONLY to `internal`. The shared front proxy (Caddy, nginx, or OpenLiteSpeed) in
`/srv/edge` forwards each app's site to `<app>-kamal-proxy:80`. `/srv/edge/compose.yaml` retains
the legacy shared `kamal-proxy` through the `0.2.12 -> 0.2.13` transition so unmigrated apps stay
online until their next deploy.

## Package-by-Package Changes

1. **`packages/iac-templates`**
   - `src/edge/index.ts`: export `KAMAL_PROXY_MEMORY_MB = 32`, `APP_KAMAL_PROXY_SERVICE = "kamal-proxy"`,
     `appProxyAlias(app)`, `appProxyUpstream(app)`, and `edgeAppUpstream(proxy, app)`. Keep shared
     `kamal-proxy` in `renderEdgeCompose`.
   - `src/edge/nginx.ts`: add per-site `upstream <app>-kamal-proxy` (`zone 64k`, `server <app>-kamal-proxy:80 resolve max_fails=0`)
     and `proxy_pass http://<app>-kamal-proxy;`. Keep `resolver 127.0.0.11 valid=10s ipv6=off;` and
     legacy `upstream kamal-proxy` in `NGINX_CONF`.
   - `src/edge/openlitespeed.ts`: use per-app `extprocessor ${appProxyAlias(app)}` and
     `handler ${appProxyAlias(app)}`; set `address` to `appProxyUpstream(app)` in both
     `extprocessor` and `websocket /`.
   - `src/runtime/index.ts`: in `renderCompose`, put `app` on `internal` only, add hardened
     `kamal-proxy` service bridging `internal` and `opscrew-edge` (alias `<app>-kamal-proxy`) with
     `kamal-proxy-config` volume; in `renderCaddyfile`, forward to `appProxyUpstream(app)`.
   - `src/workflow/edge-check.ts`: add `127.0.0.1 <app>-kamal-proxy kamal-proxy` in OpenLiteSpeed's
     offline checker.
   - `src/workflow/switch.ts`: route `kamalProxy()` to `docker compose exec -T kamal-proxy kamal-proxy`,
     add `sharedKamalProxy()` for legacy transition cleanup, start per-app `kamal-proxy` with
     `--no-deps`, reorder `switchCommands` so `install_edge` runs right after deploying the route on
     per-app `kamal-proxy` (and before stopping `$old` / removing the legacy shared route), and
     restore the per-app route before restoring the previous site file on failure.
   - `src/previews/script.ts`: remove route from both per-app and shared `kamal-proxy` on first
     preview failure; on `remove()`, remove Caddy site and reload Caddy before cleaning up any
     legacy shared route and removing the preview Compose project.

2. **`packages/connectors/ssh-host`**
   - `src/facts.ts`, `src/parse.ts`, `src/inspect.ts`, `src/__fixtures__/fake-host.ts`: inspect
     container networks (`{{.Networks}}`) in `INSPECT_SECTIONS["containers"]`, parse strictly as 5
     fields in `parseContainers`, and expose `networks?: string[]` on `HostFacts["containers"]`.
     Existing host plan steps and pinned hashes remain unchanged.

3. **`packages/agents`**
   - `src/design/sizing.ts`, `src/design/previews.ts`, `src/design/run.ts`, `src/previews/host.ts`,
     `src/provision/run.ts`: count `+32 MB` (`KAMAL_PROXY_MEMORY_MB`) per additional app on shared
     servers and per additional preview on preview servers (without double-counting single-app
     servers or synthetic shared-preview entries).
   - `src/provision/additions.ts`, `src/design/additions.ts`: pass `edgeAppUpstream(proxy, app)` to
     `scanProxyAdditions` and `translateVercelRouting`, and add `--add-host <app>-kamal-proxy:127.0.0.1`
     to OpenLiteSpeed's Docker check.
   - `src/status/components.ts`, `src/status/run.ts`, `src/drift/host.ts`: read `{{.Networks}}` in
     `readAppContainers`, ignore `kamal-proxy` in unexpected `others`, and flag `onEdgeNetwork`
     and `missingAppProxy` in both `opscrew status` and `opscrew drift`.
   - `src/retarget/server-ops.ts`, `src/retarget/sides/ssh.ts`, `src/move/window.ts`: probe app
     health on `--network <app>_internal` with `--pull never` using `/srv/edge/compose.yaml`'s
     pinned edge image (falling back to `IMAGES[edge].ref`).

4. **`packages/cli` (e2e harnesses) & Docs**
   - `packages/cli/test/e2e/docker-support.ts`, `edge-support.ts`, `edge.test.ts`,
     `recreate-hold.test.ts`, `monitoring-support.ts`, `monitoring.test.ts`: align local Docker e2e
     harnesses with per-app `kamal-proxy` and `app`-on-`internal` isolation.
   - `docs/guide/shared-server.md`, `docs/guide/own-server.md`, `docs/e2e.md`: document Option B
     isolation, per-app `kamal-proxy` memory accounting, and what remains shared (`deploy` user /
     Docker trust boundary).

## Verification Strategy

- Unit & real-shell tests in `@opscrew/iac-templates`, `@opscrew/connector-ssh-host`,
  `@opscrew/agents`, and `opscrew` (including `app-networks.test.ts`, `status/app-networks.test.ts`,
  `edge-support.test.ts`, and real POSIX `sh` execution of `switch.test.ts` and `previews`).
- Docker integration suite (`packages/iac-templates/src/edge/app-networks.docker.test.ts`, gated by
  `OPSCREW_DOCKER_TESTS=1`) covering Caddy, nginx, and OpenLiteSpeed cross-app TCP + `Host:` /
  `X-Forwarded-*` blocking, mixed-version transition, nginx `zone` + `resolve` resilience when an
  app proxy is down, and OpenLiteSpeed reload after proxy recreate.
- Full `pnpm lint`, `pnpm typecheck`, `pnpm --filter opscrew build`, and targeted Vitest suites.
