# Research: Each app's own network and proxy on a shared server (Feature 049)

**Feature:** `049-app-networks` | **Issue:** `#35` | **Decision:** Option B — one `kamal-proxy` per app

## Background & Threat Model

Prior to `0.2.13`, every OpsCrew app on a shared server attached its `app` container directly to
the shared Docker bridge network `opscrew-edge`, alongside the front proxy (Caddy, nginx, or
OpenLiteSpeed), the single shared `kamal-proxy`, and every other OpsCrew app on the same host.

That left two container-network attack paths if one app container (`app-a`) was compromised
(without escaping its container):

1. **Direct app-to-app TCP:** `app-a` could connect directly to `app-b`'s container port on
   `opscrew-edge` (bypassing TLS, WAF/Cloudflare rules, and rate limits) and forge
   `X-Forwarded-For`, `X-Forwarded-Proto`, and `X-Forwarded-Host`.
2. **Cross-app routing through shared `kamal-proxy`:** Even if `app-a` and `app-b` were placed on
   separate Docker networks joined to one shared `kamal-proxy` (Option A), `kamal-proxy` itself
   listens on HTTP port 80 on every network it joins and routes purely by the HTTP `Host:` header.
   Because `kamal-proxy` trusts `X-Forwarded-*` from upstream proxies and forwards requests to any
   service it holds a route for, a compromised `app-a` container could reach `kamal-proxy:80` on
   its own network, send `Host: b.example.com` with forged `X-Forwarded-For` / `X-Forwarded-Proto`
   / `X-Forwarded-Host`, and hit `app-b` while spoofing client identity and TLS state.

## Decision: Option B — One `kamal-proxy` per App

Instead of sharing one `kamal-proxy` across apps on per-app external networks, each app runs its
own lightweight `kamal-proxy` container inside its own Compose project:

```text
Internet / Cloudflare
   │
   ▼
/srv/edge (opscrew-edge network)
   └── Caddy / nginx / OpenLiteSpeed
         ├── <app-a>-kamal-proxy:80  ──▶  app-a's Compose project (app-a_internal)
         │                                  ├── kamal-proxy (opscrew-edge + internal, 32 MB)
         │                                  ├── app (internal ONLY)
         │                                  └── db / cache / workers (internal ONLY)
         └── <app-b>-kamal-proxy:80  ──▶  app-b's Compose project (app-b_internal)
                                            ├── kamal-proxy (opscrew-edge + internal, 32 MB)
                                            ├── app (internal ONLY)
                                            └── db / cache / workers (internal ONLY)
```

### Why Option B beats Option A

- **Complete container-network isolation:** `app-a`'s web container joins ONLY `app-a_internal`.
  It cannot reach `app-b`'s containers directly, cannot reach Caddy/nginx/OpenLiteSpeed on
  `opscrew-edge`, and its own `kamal-proxy` knows only `app-a`'s routes — a request for
  `Host: b.example.com` returns `404` immediately.
- **No dynamic `docker network connect` orchestration:** Option A required labelled external
  networks (`opscrew-app-<app>`), `edge up --no-start`, and reconnecting `kamal-proxy` to every
  app network on every edge recreate. Option B uses standard Docker Compose networking with zero
  extra external networks and zero edge-recreate race conditions.
- **Small, predictable memory cost:** `kamal-proxy` is pinned with `mem_limit: 32m`
  (`KAMAL_PROXY_MEMORY_MB = 32`). Single-app servers see zero net sizing change because
  `edgeMemoryMb(edge)` already includes one 32 MB `kamal-proxy`. Multi-app servers count `+32 MB`
  per additional app and per additional preview.
- **Trust boundary clarity:** Container-level network isolation protects against a compromised app
  container without container escape. All apps on one server still deploy as the shared `deploy`
  user (who can talk to Docker), so sharing a server remains for apps the same people control.

## Technical Choices

### 1. Front Proxy Upstream Resolution

- **Caddy:** `reverse_proxy <app>-kamal-proxy:80`. Caddy resolves upstream hostnames per request
  via Docker's embedded DNS (`127.0.0.11`), so recreating an app's `kamal-proxy` requires no Caddy
  reload and a stopped app never prevents Caddy from starting or reloading.
- **nginx:** Per-site upstream block with dynamic DNS re-resolution (available in open-source nginx
  since 1.27.3; OpsCrew pins nginx `1.29.x`, verified against official nginx `ngx_http_upstream_module`
  docs):
  ```nginx
  upstream <app>-kamal-proxy {
    zone <app>-kamal-proxy 64k;
    server <app>-kamal-proxy:80 resolve max_fails=0;
  }
  ```
  Paired with `resolver 127.0.0.11 valid=10s ipv6=off;` in `/etc/nginx/nginx.conf`, `resolve`
  ensures:
  1. nginx starts and passes `nginx -t` / `nginx -s reload` even if one app's `<app>-kamal-proxy`
     is stopped or not yet created (no single app can break reloads for other sites).
  2. Recreated `<app>-kamal-proxy` container IPs are picked up automatically within 10s without an
     nginx reload.
  3. `/etc/nginx/nginx.conf` retains the legacy `upstream kamal-proxy` block through the transition
     so unmigrated `0.2.12` sites still pointing at `http://kamal-proxy` remain valid.
- **OpenLiteSpeed:** Keeps the `extprocessor` handler name `kamal-proxy` (`OPENLITESPEED_UPSTREAM`)
  so user additions referencing `kamal-proxy` remain compatible, and sets `address <app>-kamal-proxy:80`
  in both `extprocessor` and `websocket /`. Because OpenLiteSpeed resolves `extprocessor` addresses
  when loading configuration, `install_edge` and `afterSwitch` reload OpenLiteSpeed under
  `/srv/edge/.lock` whenever an app switches or recreates its proxy. Offline checks (`edge-check.ts`
  and `provision/additions.ts`) add `--add-host <app>-kamal-proxy:127.0.0.1` alongside
  `kamal-proxy:127.0.0.1`.

### 2. Zero-Downtime Mixed-Version Transition (`0.2.12` -> `0.2.13`)

- `/srv/edge/compose.yaml` keeps its shared `kamal-proxy` service during the transition so apps
  deployed by `0.2.12` keep serving without downtime until their next deploy.
- **Switch order (`switchCommands`):**
  1. Pull images (`docker compose pull`).
  2. Ensure `opscrew-edge` exists and start the app's own `kamal-proxy`
     (`docker compose up -d --no-deps kamal-proxy`).
  3. Run backing services, init steps, snapshots, release command, and database steps.
  4. Rolling: start new `app` container on `internal` beside `$old`, then run
     `docker compose exec -T kamal-proxy kamal-proxy deploy <app> --target "$new:<port>" ...`.
     Recreate: pause both per-app `kamal-proxy` and legacy shared `kamal-proxy` (`|| true`),
     replace `app`, then deploy to per-app `kamal-proxy`.
  5. Run `install_edge` (writes the updated site file pointing at `<app>-kamal-proxy:80`, updates
     `/srv/edge/compose.yaml` if newer, reloads the front proxy under `/srv/edge/.lock`).
     If `install_edge` fails on rolling, `restoreFiles` restores the per-app `kamal-proxy` route
     to `$old` and removes `$new` before restoring the previous site file, while `$old` and the
     legacy shared `kamal-proxy` route stay untouched.
  6. Write `.env`, stop/remove `$old` (rolling) or resume per-app `kamal-proxy` (recreate).
  7. Remove the legacy route from `/srv/edge`'s shared `kamal-proxy`
     (`edge exec -T kamal-proxy kamal-proxy remove <app> < /dev/null > /dev/null 2>&1 || true`),
     and run `afterSwitch` (OpenLiteSpeed cache purge + reload).

### 3. Previews, Drills, Retarget, Localhost, and Teardown

- **Previews (`previews/script.ts`):** Each preview (`<app>-pr-<N>`) renders through `renderCompose`,
  getting its own `kamal-proxy` and `internal` network automatically. `remove()` removes the Caddy
  site and reloads Caddy before removing any legacy shared route and tearing down the preview's
  Compose project (`docker compose down -v --remove-orphans`, which removes its `kamal-proxy` and
  `kamal-proxy-config` volume).
- **Restore drills (`snapshot/drill.ts`):** Drills already copy only backing services onto an
  `internal: true` network and exclude `app` and `kamal-proxy`.
- **Retarget (`retarget/server-ops.ts`):** Because `app` is strictly on `<app>_internal`,
  `healthCommand` probes via `docker run --rm --pull never --network <app>_internal --entrypoint wget`
  using the pinned edge image read from `/srv/edge/compose.yaml` (falling back to `IMAGES[edge].ref`).
- **Teardown (`ssh-host` & `localhost`):** `docker compose down` on the app's Compose project
  removes its `kamal-proxy` container and `internal` network automatically; removing the legacy
  route from `/srv/edge`'s `kamal-proxy` (`|| true`) cleans up any pre-migration route while keeping
  all pinned `ssh-host` plan hashes untouched.

### 4. Sizing, Status, and Drift

- **Sizing:** Single-app servers stay unchanged (`edgeMemoryMb` includes 1 × 32 MB). Shared servers
  count `+32 MB` per other app (`ownServerMemory` and resize checks). Dedicated preview servers
  count `32 * max(0, cap - 1)` extra MB; previews sharing another environment's server count
  `32 * cap` extra MB (`previewsMemoryMb` and `requirePreviewsFit`).
- **Status & Drift:** `componentStatus` excludes the app's internal `kamal-proxy` service from
  unexpected `others`, flags any non-proxy app container still attached to `opscrew-edge`
  (`onEdgeNetwork`), and flags a missing or stopped per-app `kamal-proxy` (`missingAppProxy`) on
  both `opscrew status` and `opscrew drift`.
