# Research: Scaling Across Servers (Feature 033)

**Date:** 2026-11-26 | **Issue:** `#46` | **Scope:** Research only (no code) preparing OpsCrew's multi-server scaling design (033).  
**Providers covered (from `packages/providers/registry`):** Hetzner Cloud, DigitalOcean, Contabo, OVHcloud (plus the user's own servers).  
**Honesty rule:** Every answer cites official documentation, pricing pages, or pinned upstream source (`basecamp/kamal-proxy` `v0.10.2`) checked on **2026-11-26**. Any unconfirmed detail is explicitly marked **unverified**.

---

## R1. Load Balancing Across App Servers

### Provider managed load balancers vs. front server (Caddy / `kamal-proxy`) vs. Cloudflare Load Balancing

| Option | Monthly price (2026-11) | Health checks | TLS handling | Cross-provider / own servers? | Trade-offs for OpsCrew 033 |
|---|---|---|---|---|---|
| **Hetzner Cloud Load Balancer (`LB11`)** | **€5.39–€7.49/mo** (region/VAT dependent; hourly billed with monthly cap; 5 services, 25 targets, 10k conn, 1 TB traffic in EU); `LB21` ~€16.40/mo | TCP, HTTP, HTTPS (private network targets supported; note HTTPS health checks against private IPs fail cert hostname validation unless `validate-certificate = false` or plain HTTP is used internally) | Managed Let's Encrypt or uploaded cert (e.g. Cloudflare Origin CA) | Hetzner only (targets in same Hetzner network/project) | Cheap, redundant, zero front-server SPOF for single-provider Hetzner stacks. |
| **DigitalOcean Load Balancer** | **$12.00/mo** per node (hourly billed; scales horizontally by node count) | HTTP, HTTPS, TCP (configurable interval, timeout, healthy/unhealthy thresholds) | Managed Let's Encrypt or uploaded cert; HTTP/3 supported | DigitalOcean only (VPC regional targets) | Clean managed option for DigitalOcean-only stacks. |
| **OVHcloud Load Balancer (OpenStack Octavia)** | **Small (`S`):** **~$6.84 / €6.94/mo** (`~$0.0095/hr`; 200 Mbit/s, 250 conn/s, 10k req/s); `M` ~$17.37/mo, `L` ~$40–$46/mo | HTTP, HTTPS, TCP via Octavia health monitors over private vRack | Terminates TLS via Barbican/uploaded cert or TCP passthrough | OVHcloud Public Cloud only (same region/vRack) | Good managed fit for OVHcloud-only stacks. |
| **Contabo** | **No managed Load Balancer product** | — | — | — | Must use a software front server (Caddy / `kamal-proxy`) or Cloudflare Load Balancing. |
| **Front server with Caddy + `kamal-proxy` over 018 WireGuard** | **$0 extra** (runs on the existing front/app server, or a dedicated ~€4–€5/mo small front VPS) | **Caddy `reverse_proxy`:** active (`health_uri`, `health_interval`, `health_timeout`, `health_status`) + passive circuit breaking (`fail_duration`, `max_fails`) + `lb_policy` (`round_robin`, `least_conn`, `random`, `ip_hash`). **`kamal-proxy` `v0.10.2`:** active HTTP `/up` every 1 s (`--health-check-path`, `--health-check-interval`, `--health-check-timeout`). | OpsCrew's existing Caddy / nginx / OpenLiteSpeed TLS (Let's Encrypt HTTP-01 or Cloudflare Origin CA) | **Yes — works across ANY mix of providers (Hetzner + Contabo + OVHcloud + own servers)** over 018 WireGuard! | **Best universal default for v1:** zero extra monthly cost, works on Contabo & cross-provider setups, reuses 018 WireGuard + existing proxy stack. Downside: single front server is a SPOF (mitigated only by a managed LB or Cloudflare LB). |
| **Cloudflare Load Balancing** | **$5.00/mo base** (includes 2 origins) **+ $5.00/mo per additional origin** (plus usage fees for shorter check intervals / extra check regions / >500k DNS queries — exact 2026-11 per-add-on query rates **unverified**) | Active HTTP/HTTPS/TCP monitors from Cloudflare PoPs; minimum interval: **60 s (Pro)**, **15 s (Business)**, **10 s (Enterprise)** (Free plan minimum interval **unverified**, historically 60 s) | Edge TLS + Full (Strict) to each origin's Origin CA cert | **Yes — works across ANY provider, ANY region, and survives a full provider outage!** | Best **opt-in HA / multi-provider** layer: removes the front-server SPOF completely and integrates cleanly with apps already on Cloudflare. Caveat: 60 s minimum probe interval on Free/Pro means an ungraceful node crash can drop traffic for up to a minute unless origins drain cleanly during deploys. |

### Recommendation for OpsCrew 033
1. **Default (v1, universal):** Front server **Caddy `reverse_proxy`** (or **`kamal-proxy`**) balancing across WireGuard peers (`10.x.y.z:<port>`), because it costs `$0` extra, works identically across Hetzner, DigitalOcean, Contabo, OVHcloud, and own servers, and supports active + passive health checks with sub-second failover.
2. **Opt-in HA (no front-server SPOF):**
   - **Same-provider:** offer the provider's managed LB (`LB11` on Hetzner €5.39+, DigitalOcean LB $12, OVHcloud Octavia S ~$7; unavailable on Contabo).
   - **Cross-provider / Cloudflare apps:** offer **Cloudflare Load Balancing** ($5/mo for 2 origins, +$5/origin) with each copy behind its own Caddy/Origin CA edge.

### Citations (R1)
- Hetzner Cloud Load Balancers & pricing: https://docs.hetzner.com/cloud/load-balancers/overview/ and https://www.hetzner.com/cloud/load-balancer/ (checked 2026-11-26)
- DigitalOcean Load Balancers pricing & docs: https://docs.digitalocean.com/products/networking/load-balancers/ (checked 2026-11-26)
- OVHcloud Public Cloud Load Balancer (Octavia) pricing: https://www.ovhcloud.com/en/public-cloud/prices/#network (checked 2026-11-26)
- Cloudflare Load Balancing pricing & health check intervals: https://developers.cloudflare.com/load-balancing/ and https://developers.cloudflare.com/load-balancing/monitors/ (checked 2026-11-26)
- Caddy `reverse_proxy` load balancing & health checks: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy (checked 2026-11-26)

---

## R2. Rolling Deploys Across Several Servers

### `kamal-proxy` (`v0.10.2`, OpsCrew's pinned image) capabilities verified directly from source
Verified against `github.com/basecamp/kamal-proxy` tag `v0.10.2`:
- **Multiple targets (`internal/cmd/deploy.go`):** `kamal-proxy deploy <service>` accepts a `StringSliceVar` `--target` flag (repeated `--target host1:port --target host2:port` or comma-separated) plus `--read-target` for read-only replicas!
- **Per-target health checks & graceful drain:** On `deploy`, `kamal-proxy` polls each new target's health endpoint (`/up` or `--health-check-path`, every 1 s by default), switches traffic only once healthy, and waits for in-flight requests on replaced targets to drain before returning.
- **Built-in canary / percentage rollouts (`internal/cmd/rollout.go` & `rollout_set.go`):** `kamal-proxy v0.10.2` natively supports `rollout deploy`, `rollout set <service> --percent <N>` (and `--list`), `rollout enable`, `rollout disable`, and `rollout remove` — directly enabling roadmap 033's planned staged traffic splits!

### Zero-downtime rollout order across N servers
To keep the app serving with zero dropped requests and safe database migrations:

1. **Pull image on all N servers first** (in parallel): fail early if any server cannot reach the registry before anything switches.
2. **Database pre-release snapshot & migrations once (expand-first rule):** Run `app.releaseCommand` (and 019's optional pre-release DB snapshot) **once** on the designated primary/app server — never concurrently on N servers. Because copies N−1 still run the old image while copy 1 runs the new image, migrations **must remain backward-compatible** during the rollout window (add before remove).
3. **Roll web copies one server at a time (serial batch = 1):**
   - On server `i`: start the new app container on a fresh local port / container name; wait for local health check; switch server `i`'s local `kamal-proxy` (which drains in-flight requests cleanly while keeping the front load balancer / Caddy / Cloudflare seeing server `i` as healthy the entire time!).
   - Verify server `i` directly over WireGuard (or local health check) before advancing to server `i+1`.
   - **Abort & rollback on first failure:** If server `i` fails its health check, server `i` rolls back its local `kamal-proxy` to the previous container, stops the rollout immediately, and leaves servers `i+1..N` untouched on the known-good version (while rolling back already-updated servers `1..i-1` to keep all copies on one release).
4. **Roll worker copies after web succeeds** (or alongside web once migrations pass), restarting workers with graceful `stop_grace_period` so in-flight jobs finish.
5. **Cron jobs:** Run on **one designated server only** (never duplicated across copies) so scheduled tasks never fire N times.

### Citations (R2)
- `basecamp/kamal-proxy` `v0.10.2` (`README.md`, `internal/cmd/deploy.go`, `internal/cmd/rollout.go`, `internal/cmd/rollout_set.go`): https://github.com/basecamp/kamal-proxy/tree/v0.10.2 (verified 2026-11-26)

---

## R3. Sessions and Uploads (Stateless Check & Detection in `@opscrew/detect`)

An app running on ≥2 servers must keep **no per-request mutable state on local container/server disk**:

### 1. Shared sessions (move off local disk / in-memory store to Valkey or DB)
- **What breaks on 2 servers:** Cookie-stored encrypted sessions (Rails default `cookie_store`, Flask default signed cookies, NextAuth JWT strategy) **already work** across N servers (provided all servers share the same `SECRET_KEY_BASE` / `APP_KEY` / `NEXTAUTH_SECRET`). File-backed or process-memory sessions (`express-session` default `MemoryStore`, PHP `SESSION_DRIVER=file`, Laravel default `file` / `database` without shared DB, Django `django.contrib.sessions.backends.file`) **break** with random logouts unless sticky sessions are forced (which breaks failover and uneven scaling).
- **Fix:** Store sessions in **Valkey** (or the shared PostgreSQL/MySQL database, or encrypted cookies).

### 2. Shared uploads & SQLite (move off local disk to S3-compatible object storage)
- **What breaks on 2 servers:** Uploads written to a local Docker volume (`storage.files`) or a local **SQLite** database (`storage.sqlite`) exist only on the server that received the write — requests landing on server 2 get 404s or stale data.
- **Fix:** Refuse `copies > 1` whenever `plan.storage.sqlite` or `plan.storage.files` is set (unless the user moves uploads to S3-compatible object storage: R2, Hetzner Object Storage, Spaces, S3, or Garage on a shared server, and moves SQLite to PostgreSQL/MySQL).

### 3. How OpsCrew (`packages/detect`) can detect both deterministically
`packages/detect/src/storage.ts` **already detects** SQLite (`detectSqlite`) and S3 SDK presence (`S3_CLIENTS`: `django-storages`, `league/flysystem-aws-s3-v3`, `@aws-sdk/client-s3`, `boto3`, `aws-sdk-s3`, etc.). To gate multi-server scaling cleanly, `@opscrew/detect` only needs small deterministic checks per framework:

| Framework / Ecosystem | Local-session red flag to detect | Local-upload red flag to detect |
|---|---|---|
| **Laravel / PHP** | `.env*` / `config/session.php`: `SESSION_DRIVER=file` (safe: `redis`, `database`, `cookie`) | `FILESYSTEM_DISK=local` or `public` without `league/flysystem-aws-s3-v3` |
| **Express / Node.js** | `express-session` dependency without `connect-redis`, `connect-pg-simple`, `connect-mongo`, or `cookie-session` | `multer` with `diskStorage` / `dest:` without `@aws-sdk/client-s3` or `multer-s3` |
| **Django / Python** | `SESSION_ENGINE` set to `backends.file` (safe: default `backends.db`, `backends.cache` + Redis, `backends.signed_cookies`) | `MEDIA_ROOT` set without `django-storages` / S3 storage backend |
| **Rails / Ruby** | `config.session_store :cache_store` with `:file_store` or `:memory_store` (safe: default `:cookie_store` or Redis/Solid Cache backed by shared DB) | `config/storage.yml` / `production.rb`: `active_storage.service = :local` (safe: `:amazon` / S3 / R2) |
| **Any app** | `plan.storage.sqlite` present (hard block for >1 web server) | `plan.storage.files` present without object storage (hard block unless user confirms read-only/ephemeral) |

### Citations (R3)
- OpsCrew existing detection (`packages/detect/src/storage.ts`) (inspected 2026-11-26)
- Laravel Sessions & Filesystem docs: https://laravel.com/docs/session and https://laravel.com/docs/filesystem (checked 2026-11-26)
- Django Sessions docs: https://docs.djangoproject.com/en/stable/topics/http/sessions/ (checked 2026-11-26)
- Rails Active Storage & Action Dispatch Sessions: https://guides.rubyonrails.org/active_storage_overview.html (checked 2026-11-26)

---

## R4. PostgreSQL Across Servers (Streaming Replica, Failover, Managed Options)

### 1. Self-hosted streaming replica & manual failover (PostgreSQL 17, OpsCrew's pinned version)
PostgreSQL natively supports physical streaming replication over 018's encrypted WireGuard network:
1. **Primary settings:** `wal_level = replica` (default in Postgres 17), dedicated replication role (`CREATE ROLE opscrew_repl WITH REPLICATION LOGIN PASSWORD ...`), `pg_hba.conf` allowing `host replication opscrew_repl <standby_wg_ip>/32 scram-sha-256`, and a **physical replication slot** (`max_slot_wal_keep_size` bounded so a dead standby can never fill the primary's disk!).
2. **Bootstrap standby:** Run `pg_basebackup -h <primary_wg_ip> -U opscrew_repl -D /var/lib/postgresql/data -Fp -Xs -P -R -S <slot_name>`. The `-R` flag automatically writes `standby.signal` and `primary_conninfo` into `postgresql.auto.conf`.
3. **Read scaling:** Read-only queries can hit the standby directly (or via PgBouncer on the standby; Rails/Laravel/Django each support read-replica routing natively).
4. **Failover / promotion:** Promotion is a single command on the standby: `SELECT pg_promote();` (or `pg_ctl promote`), followed by pointing apps/PgBouncer to the new primary.
   - **Critical safety rule (split-brain prevention):** Never auto-promote without a consensus quorum (≥3 nodes, e.g. Patroni + etcd/Raft). On a 2-node primary+standby setup, a network blip would cause **split-brain** (two primaries accepting divergent writes!). Therefore, **manual user-approved promotion** (`opscrew db promote`, approved by plan hash) is the right v1 model — matching the founder's note in `specs/roadmap.md` ("The standby takes over through an approved switch the user starts first; taking over by itself only after research (Patroni and the like)").

### 2. Managed PostgreSQL across `packages/providers/registry`

| Registry provider | Managed PostgreSQL DBaaS? | Entry price (2026-11) | Built-in HA / automatic failover? |
|---|---|---|---|
| **Hetzner Cloud** | **No** (raw VPS / Managed Server OS-only; no native DBaaS) | Self-hosted VPS (~€4–€15/mo) | Self-hosted streaming replica (or 3rd party) |
| **DigitalOcean** | **Yes** (DigitalOcean Managed PostgreSQL) | **$15/mo** single-node (1 vCPU, 1 GiB RAM); **$30/mo** HA (primary + standby) | **Yes** (automatic failover + PITR included) |
| **Contabo** | **No** (self-managed VPS only) | Self-hosted VPS (~$6–$8/mo) | Self-hosted streaming replica |
| **OVHcloud** | **Yes** (OVHcloud Managed Databases for PostgreSQL) | **~$63/mo** (Entry Discovery `DB1-4`, 2 vCPU, 4 GB RAM, 80 GB) | **Yes** (multi-node & 3-AZ Production/Advanced tiers) |

### 3. What a small app actually needs when scaling web servers
1. **First step (required before 2+ web copies):** Put **PgBouncer** (already shipped in **050**!) in front of the single PostgreSQL server so N web copies + workers don't exhaust `max_connections`, and move PostgreSQL onto its own dedicated server (**018** split placement) if it shares the app server.
2. **Second step (only when uptime/read scale demands it):** Add a **single streaming standby** (manual `pg_promote()` switchover for Hetzner/Contabo, or DigitalOcean Managed PostgreSQL HA at `$30/mo` for zero-ops automatic failover). Most small apps scaling web servers from 1 → 3 copies do **not** need Patroni or multi-primary PostgreSQL.

### Citations (R4)
- PostgreSQL 17 Documentation — Streaming Replication, `pg_basebackup`, `primary_conninfo`, `pg_promote`: https://www.postgresql.org/docs/17/warm-standby.html and https://www.postgresql.org/docs/17/app-pgbasebackup.html (checked 2026-11-26)
- DigitalOcean Managed PostgreSQL pricing: https://www.digitalocean.com/pricing/managed-databases (checked 2026-11-26)
- OVHcloud Managed Databases PostgreSQL pricing: https://www.ovhcloud.com/en/public-cloud/prices/#databases (checked 2026-11-26)

---

## R5. Valkey: Replication and Sentinel

### How Valkey replication & Sentinel work
- **Replication (`replicaof <primary_wg_ip> 6379`):** Asynchronous streaming from primary to read-only replicas (`replica-read-only yes`), with partial resync (`PSYNC`) via `repl-backlog-size` and full RDB snapshot sync if a replica falls behind.
- **Valkey Sentinel:** Requires **at least 3 Sentinel processes on 3 independent failure domains (servers)** to establish a quorum (`quorum = 2`) for split-brain-safe automatic failover. Furthermore, **every application client must be configured to connect via Sentinel discovery** (`sentinels: [...]`, `masterName: ...`) rather than a single `REDIS_URL=redis://host:6379`!

### Does a small app need Valkey replication or Sentinel?
- **No — not for v1 scaling of a small app.**
  1. For **caches & sessions**, a single Valkey instance on the DB/data server (018 split placement) handles tens of thousands of ops/sec; a rare restart causes a brief cache cold miss or re-login, not data loss.
  2. For **job queues** (BullMQ, Sidekiq, Celery), enabling **AOF persistence (`appendonly yes`, `appendfsync everysec`)** + `noeviction` + OpsCrew's 024 snapshots protects queued jobs on a single server without forcing the app to rewrite its `REDIS_URL` client for Sentinel (violating OpsCrew's "no app code rewrite" principle!).
  3. **When HA Valkey IS needed later:** Recommend a managed HA Valkey endpoint (DigitalOcean Managed Valkey / AWS ElastiCache Serverless Valkey) that presents a **single stable endpoint** so app code stays unchanged, OR 3-node Sentinel strictly as an opt-in when the app's client explicitly supports Sentinel.

### Citations (R5)
- Valkey official replication docs: https://valkey.io/topics/replication/ (checked 2026-11-26)
- Valkey official Sentinel HA docs: https://valkey.io/topics/sentinel/ (checked 2026-11-26)

---

## R6. Autoscaling: Provider Snapshot APIs, Provisioning Speed, and Rules

### Provider comparison for adding/removing copies automatically

| Provider | Create server from snapshot/image API | Typical boot-to-ready time | Billing model (critical for autoscaling!) | Fits dynamic spin-up / tear-down autoscaling? |
|---|---|---|---|---|
| **Hetzner Cloud** | `POST /v1/servers` with `image: <snapshot_id>` (snapshot billed at €0.011/GB-mo — **unverified** exact 2026-11 €/GB rate) | **~15–30 s** from pre-baked snapshot (+ ~15 s WireGuard join & container start ≈ **<1 min total**) | **Hourly** (monthly cap; billed even when powered off, stops billing immediately on `DELETE`) | **Yes — ideal.** Create on scale-out, delete on scale-in. |
| **DigitalOcean** | `POST /v2/droplets` with `image: <snapshot_id>` (target `size` must have disk ≥ snapshot `min_disk_size`) | **~20–45 s** from snapshot (+ ~15–20 s join & container start ≈ **~1 min total**) | **Hourly** (monthly cap; stops billing immediately on `DELETE`) | **Yes — good.** Keep base snapshot on smallest disk size so any larger Droplet can boot from it. |
| **OVHcloud** | OpenStack Nova `POST /v2.1/servers` with Glance `imageRef: <snapshot_uuid>` | **~30–60 s** from Glance snapshot (+ ~20 s join & container start ≈ **~1–1.5 min total**) | **Hourly** (Public Cloud On-Demand instances stop billing on `DELETE`) | **Yes — good.** |
| **Contabo** | `POST /v1/compute/instances` with `imageId: <custom_image_id>` | **~1–3 min** (heavier virtualization + image checks; **not** instant) | **Monthly term** (cancelling only ends at end of billing month — per roadmap 026/033!) | **NO for ephemeral spin-up/tear-down.** Use Contabo only for the **fixed base copies**, and burst extra copies onto hourly providers (Hetzner / DigitalOcean / OVHcloud) — exactly as roadmap 033 specifies! |

### Prepared snapshot vs. cloud-init from scratch
- Booting a fresh Ubuntu server + cloud-init installing Docker, WireGuard, hardening, and pulling the app image takes **~2.5–4 minutes** — too slow to absorb a sudden traffic spike.
- Booting from a **prepared base snapshot** (OS + Docker + WireGuard + `kamal-proxy` pre-installed, zero secrets baked in; WireGuard keypair & app env injected at boot) cuts ready time to **~45–60 seconds** on Hetzner/DigitalOcean/OVHcloud.

### Is a simple CPU-based rule enough for a first version?
- **CPU alone is good enough for a minimal v1 ONLY if paired with strict anti-flapping guards AND a latency/saturation safety net (optional HTTP metric):**
  - **Why CPU works for most v1 web apps (PHP, Ruby, Python, Node SSR):** request load correlates closely with sustained CPU usage on small 1–4 vCPU servers.
  - **Where CPU alone misses:** I/O-bound Node/Python/Go apps waiting on slow DB queries or external APIs can saturate worker threads/connections and spike p95 latency while CPU stays at 30%!
  - **Recommended v1 autoscaling policy (simple, safe, hard-capped):**
    1. **Primary metric:** 5-minute rolling average **CPU > 70%** (scale out +1 copy) and **CPU < 25%** for **15 consecutive minutes** (scale in -1 copy).
    2. **Optional secondary trigger (from Caddy's own Prometheus metrics, already available under 020!):** p95 request latency > threshold OR in-flight concurrency > threshold (catches I/O-bound saturation).
    3. **Mandatory anti-flapping & cost guardrails (approved once by plan hash under standing recipe, per roadmap 033):**
       - Hard `minCopies` and `maxCopies` bounds + hard **monthly spend ceiling**;
       - **Cooldown timers:** 5 min after scale-out, 15 min after scale-in (asymmetric hysteresis prevents thrashing);
       - **Graceful drain before delete:** remove target from Caddy / LB first, wait for `kamal-proxy` / Caddy to drain active connections (e.g. 30–60 s), then delete the server;
       - **Never autoscale stateful servers** (DB, Valkey, brokers, cron) — stateless web (and optionally worker) copies only.

### Citations (R6)
- Hetzner Cloud API (`POST /v1/servers` with snapshot `image`): https://docs.hetzner.cloud/#servers-create-a-server (checked 2026-11-26)
- DigitalOcean API (`POST /v2/droplets` with snapshot `image` & `min_disk_size`): https://docs.digitalocean.com/reference/api/api-reference/#operation/droplets_create (checked 2026-11-26)
- OVHcloud Public Cloud / OpenStack Nova & Glance snapshots: https://help.ovhcloud.com/csm/en-public-cloud-compute-create-instance-backup (checked 2026-11-26)
- Contabo Compute Instances & Custom Images API: https://api.contabo.com/ (checked 2026-11-26)
