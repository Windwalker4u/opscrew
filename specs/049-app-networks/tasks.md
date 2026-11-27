# Tasks: Feature 049 — Per-app `kamal-proxy` and network isolation (Option B)

**Feature:** `049-app-networks` | **Plan:** [plan.md](plan.md)

## Wave 1 — Edge, Proxies, Compose, and Deploy Scripts (`@opscrew/iac-templates`)

- [x] **T4901** Export `KAMAL_PROXY_MEMORY_MB`, `APP_KAMAL_PROXY_SERVICE`, `appProxyAlias`, `appProxyUpstream`, and `edgeAppUpstream` from `packages/iac-templates/src/edge/index.ts`; keep legacy shared `kamal-proxy` in `/srv/edge/compose.yaml`.
- [x] **T4902** Update `renderCompose` (`app` on `internal` only; hardened per-app `kamal-proxy` bridging `internal` and `opscrew-edge` with alias `<app>-kamal-proxy` and `kamal-proxy-config` volume) and `renderCaddyfile` (`reverse_proxy <app>-kamal-proxy:80`).
- [x] **T4903** Update `nginx.ts` (per-site `upstream <app>-kamal-proxy` with `zone 64k` + `resolve max_fails=0`, keeping `resolver 127.0.0.11 valid=10s ipv6=off;` and legacy `upstream kamal-proxy`) and `openlitespeed.ts` (`address <app>-kamal-proxy:80` in `extprocessor` and `websocket /`, plus `edge-check.ts` `/etc/hosts` entry).
- [x] **T4904** Update `workflow/switch.ts` and `previews/script.ts` for per-app `kamal-proxy`, zero-downtime mixed-version switch order (`install_edge` after per-app deploy, legacy shared route cleanup last, route restored before previous site on rolling failure), and preview cleanup.

## Wave 2 — Sizing, Additions, Inspection, Status/Drift, Retarget, and E2E Harnesses

- [x] **T4905** Update sizing (`sizing.ts`, `design/previews.ts`, `design/run.ts`, `previews/host.ts`, `provision/run.ts`) to count `+32 MB` per additional app on shared servers and per additional preview.
- [x] **T4906** Update proxy additions (`provision/additions.ts`, `design/additions.ts`) to use `edgeAppUpstream(proxy, app)` and `--add-host <app>-kamal-proxy:127.0.0.1`.
- [x] **T4907** Inspect container Docker networks in `@opscrew/connector-ssh-host` (`facts.ts`, `parse.ts`, `inspect.ts`, `fake-host.ts`) without changing pinned host plan hashes.
- [x] **T4908** Update `status` and `drift` (`status/components.ts`, `status/run.ts`, `drift/host.ts`) to ignore `kamal-proxy` in `others` and flag `onEdgeNetwork` and `missingAppProxy`.
- [x] **T4909** Update `retarget/server-ops.ts` `healthCommand` to probe on `--network <app>_internal` with `--pull never` using `/srv/edge/compose.yaml`'s pinned edge image.
- [x] **T4910** Update CLI e2e harnesses (`docker-support.ts`, `edge-support.ts`, `edge.test.ts`, `recreate-hold.test.ts`, `monitoring-support.ts`, `monitoring.test.ts`).

## Wave 3 — Tests, Docs, and Verification

- [x] **T4911** Update unit tests and snapshots across `@opscrew/iac-templates`, `@opscrew/connector-ssh-host`, `@opscrew/agents`, and `opscrew`; add `app-networks.test.ts`, `status/app-networks.test.ts`, and `edge-support.test.ts`.
- [ ] **T4912** Write Docker integration test suite `packages/iac-templates/src/edge/app-networks.docker.test.ts` (`OPSCREW_DOCKER_TESTS=1`) covering Caddy, nginx, and OpenLiteSpeed cross-app TCP + `Host:` / `X-Forwarded-*` blocking, mixed-version transition, nginx `zone` + `resolve` resilience with a stopped proxy, and OpenLiteSpeed reload after proxy recreate. *(Written & typechecked; run on a host with a Docker daemon — unavailable on this Windows runner.)*
- [x] **T4913** Update user docs (`docs/guide/shared-server.md`, `docs/guide/own-server.md`, `docs/e2e.md`).
- [x] **T4914** Run `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter opscrew build`, and all non-Docker Vitest suites cleanly.
