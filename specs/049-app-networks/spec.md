# Specification: Each app's own network and proxy on a shared server (Feature 049)

**Feature:** `049-app-networks` | **Issue:** `#35` | **Target Release:** `0.2.13`

## Problem Statement

Before `0.2.13`, every OpsCrew app on a shared server attached its `app` container(s) to the shared
Docker bridge network `opscrew-edge` alongside Caddy (or nginx / OpenLiteSpeed), a single shared
`kamal-proxy`, and every other OpsCrew app on that server. A compromised container of app A could
therefore:

1. Reach app B's web port directly on `opscrew-edge` from a private IP, bypassing TLS and WAF rules
   and forging `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host`.
2. Even with separate networks feeding a single shared `kamal-proxy`, send `Host: b.example.com`
   with forged `X-Forwarded-*` headers to `kamal-proxy:80` and reach app B through the shared proxy.

## User Stories

### US1 — Complete container-network isolation between apps sharing a server
As an operator running two or more OpsCrew apps (or an app plus PR previews) on one server, I want
each app's web container(s) strictly on the app's own private `internal` Docker network behind a
per-app `kamal-proxy`, so a compromised container in app A cannot reach app B's containers directly,
cannot route to app B by sending `Host: b.example.com` to its proxy, cannot reach the shared front
proxy (Caddy / nginx / OpenLiteSpeed), and cannot forge `X-Forwarded-*` headers to app B.

### US2 — Front proxies handle per-app proxies cleanly across reloads and restarts
As an operator running Caddy, nginx, or OpenLiteSpeed in `/srv/edge`, I want each app's site file
to forward to `<app>-kamal-proxy:80` so that stopping or recreating one app's proxy never breaks
config validation, reloads, or routing for other apps on the server.

### US3 — Zero-downtime mixed-version transition for existing servers
As an operator upgrading an existing server from `0.2.12`, I want each app's deploy to bring up its
own `kamal-proxy`, deploy its route there, switch its site file to `<app>-kamal-proxy:80` and
reload the front proxy, and only then remove its legacy route from `/srv/edge`'s shared
`kamal-proxy`, so other unmigrated `0.2.12` apps keep serving throughout with zero downtime and
existing host plan hashes stay unchanged.

### US4 — Accurate sizing, previews, retarget, localhost, and teardown
As an operator sizing shared servers or preview servers, moving an app (`opscrew retarget`), running
on `localhost`, or destroying one app/preview, I want memory sizing to account for each additional
32 MB `kamal-proxy`, retarget health probes to run on `<app>_internal`, and per-app teardown to
remove that app's `kamal-proxy` cleanly without disturbing other apps.

### US5 — Status and drift detect unmigrated apps or missing per-app proxies
As an operator running `opscrew status` or `opscrew drift`, I want any non-proxy container still
attached to `opscrew-edge`, or a missing/stopped per-app `kamal-proxy`, reported clearly with
plain-English remediation guidance (re-run the deploy workflow), while a running per-app
`kamal-proxy` is never reported as an unexpected service.

## Functional Requirements

- **FR-4901 (Per-app `kamal-proxy` in app Compose):** `renderCompose` attaches `app` ONLY to
  `["internal"]` (never `opscrew-edge`), adds a hardened `kamal-proxy` service (`mem_limit: 32m`,
  `memswap_limit: 32m`, pinned `IMAGES.kamalProxy.ref`, `kamal-proxy-config:/home/kamal-proxy/.config/kamal-proxy`)
  attached to `internal: {}` and `opscrew-edge: { aliases: ["<app>-kamal-proxy"] }`, and declares
  the `kamal-proxy-config` volume.
- **FR-4902 (Per-app front-proxy upstreams):**
  - Caddy (`renderCaddyfile`): `reverse_proxy <app>-kamal-proxy:80`.
  - nginx (`nginxSite`): per-site `upstream <app>-kamal-proxy { zone <app>-kamal-proxy 64k; server <app>-kamal-proxy:80 resolve max_fails=0; }` and `proxy_pass http://<app>-kamal-proxy;` (retaining `resolver 127.0.0.11 valid=10s ipv6=off;` and legacy `upstream kamal-proxy` in `nginx.conf`).
  - OpenLiteSpeed (`openLiteSpeedSite`): defines per-app `extprocessor <app>-kamal-proxy` and
    `handler <app>-kamal-proxy` (OpenLiteSpeed shares `extprocessor` names globally across virtual
    hosts) and sets `address <app>-kamal-proxy:80` in both `extprocessor` and `websocket /`. Offline checks
    (`edge-check.ts`, `provision/additions.ts`) add `--add-host <app>-kamal-proxy:127.0.0.1`
    alongside `kamal-proxy:127.0.0.1`.
  - Proxy additions & Vercel routing (`provision/additions.ts`, `design/additions.ts`) use
    `edgeAppUpstream(proxy, app)`.
- **FR-4903 (Shared `kamal-proxy` kept through transition):** `/srv/edge/compose.yaml` keeps its
  shared `kamal-proxy` service so unmigrated `0.2.12` apps remain online until their next deploy.
- **FR-4904 (Zero-downtime deploy, rollback, and rotate switch order):**
  - `switchCommands` pulls images, ensures `opscrew-edge` exists and starts per-app `kamal-proxy`
    (`docker compose up -d --no-deps kamal-proxy`), runs backing services/init/release/db steps,
    starts the new `app` copy and deploys its route on per-app `kamal-proxy`
    (`docker compose exec -T kamal-proxy kamal-proxy deploy ...`), runs `install_edge` (swaps the
    site file to `<app>-kamal-proxy:80` and reloads the front proxy under `/srv/edge/.lock`),
    writes `.env`, stops `$old` (rolling) or resumes per-app `kamal-proxy` (recreate), removes the
    legacy route from `/srv/edge`'s shared `kamal-proxy` (`|| true`), and runs `afterSwitch`
    (OpenLiteSpeed cache purge + reload).
  - On rolling failure after `kamal-proxy deploy`, `restoreFiles` restores the per-app `kamal-proxy`
    route to `$old` and removes `$new` before restoring the previous site file, leaving `$old` and
    any legacy shared route untouched.
  - `rollbackCommands` and `rotate` operate on the per-app `kamal-proxy` and run `afterSwitch`.
- **FR-4905 (Sizing):**
  - Single-app servers are unchanged (`edgeMemoryMb` already includes 32 MB for one `kamal-proxy`).
  - Multi-app servers count `+32 MB` (`KAMAL_PROXY_MEMORY_MB`) per additional app in
    `ownServerMemory` and cloud resize checks.
  - Preview servers count `+32 MB * max(0, cap - 1)` on dedicated servers and `+32 MB * cap` when
    sharing another environment's server (`previewSizing`, `previewCapacity`, `requirePreviewsFit`,
    `previewMemoryText`, `previewsMemoryMb`).
- **FR-4906 (Previews, retarget, localhost, teardown):**
  - Previews automatically get a per-app `kamal-proxy` and `internal` network; `remove()` removes
    the Caddy site and reloads Caddy before removing any legacy shared route and tearing down the
    preview project.
  - `retarget/server-ops.ts` `healthCommand` probes `--network <app>_internal` with `--pull never`
    using the pinned edge image from `/srv/edge/compose.yaml` (falling back to `IMAGES[edge].ref`).
  - `ssh-host` and `localhost` teardowns remove the app's Compose project (removing its
    `kamal-proxy`) and any legacy shared route cleanly without changing pinned host plan hashes.
- **FR-4907 (Status & drift):** `ssh-host` inspects per-container Docker networks (`{{.Networks}}`),
  `readAppContainers` reads `{{.Names}}|{{.State}}|{{.Networks}}`, and `componentStatus` /
  `componentStatusLines` / `containerDifferences` exclude `kamal-proxy` from unexpected `others`,
  report any non-proxy app container still attached to `opscrew-edge`, and report a missing or
  stopped per-app `kamal-proxy`.
- **FR-4908 (Docker verification suite):** `packages/iac-templates/src/edge/app-networks.docker.test.ts`
  (`OPSCREW_DOCKER_TESTS=1`) verifies:
  1. Two apps behind Caddy, nginx, and OpenLiteSpeed: direct app-to-app TCP blocked AND cross-app
     `Host: b.test` + forged `X-Forwarded-For`/`-Proto`/`-Host` through `<app-a>-kamal-proxy`
     returns 404.
  2. Mixed-version transition: app A migrates to `<app-a>-kamal-proxy` while app B remains on
     shared `kamal-proxy`, both serving with zero drop.
  3. nginx starts/reloads cleanly with one app's `<app>-kamal-proxy` stopped/absent (proving
     `zone` + `resolve` isolates reload failures), and OpenLiteSpeed reloads cleanly after a proxy
     recreate and with another app's proxy down.
