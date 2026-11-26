# Research: Edge providers in place of Cloudflare's proxy: Bunny.net, Gcore and Fastly

**Feature**: `036-edge-providers` | **Issue**: `#29` | **Date**: 2026-11-26
**Sources**: Official provider documentation, API references, pricing pages, and official Terraform provider registries only.

---

## R1 — Current Cloudflare surface in OpsCrew

Today Cloudflare is wired directly (without a provider contract) across `@opscrew/plan-schema`, `@opscrew/connector-cloudflare`, `@opscrew/iac-templates`, `@opscrew/agents`, and `@opscrew/secops`. Separating what is **generic DNS + edge proxy** from what is **Cloudflare-only** sets the exact boundary for Feature 036's contract:

### Generic DNS + edge proxy capabilities (move behind the contract)
1. **DNS hosting** (`dns.provider`, `dns.domain`, `dns.zone`, `dns.www`):
   - `A` / `AAAA` records for the app domain (or `CNAME` / flattened apex record pointing at the edge), `www` alias, and `CAA` records when DNS-only (`modules/cloudflare-dns`).
   - Recognition of OpsCrew-managed records (e.g. `Managed by OpsCrew` comment on Cloudflare).
   - Zone lookup and credential verification.
2. **Edge reverse proxy & TLS** (`dns.proxied`):
   - Custom hostname attachment and automatic edge TLS certificates (HTTP-01 or DNS-01 ACME validation) covering `<domain>` and optional `www.<domain>`.
   - HTTPS enforcement (HTTP -> HTTPS redirect) and `www` redirect where applicable.
   - Safe caching defaults: never cache dynamic HTML/API responses, authenticated requests, or `Set-Cookie` responses.
3. **Origin protection** (`security.httpAllowedFrom`, server reverse proxy & cloud firewall):
   - Restricting server ports 80/443 to the edge provider (cloud firewall / server filter where edge CIDRs fit firewall limits) AND authenticating edge-to-origin requests (mTLS client cert or shared origin-verification header + verified origin HTTPS).
   - Real visitor IP forwarding header trusted by Caddy (`client_ip_headers`), nginx (`real_ip_header`), and OpenLiteSpeed (`useIpInProxyHeader`) — currently hardcoded to `CF-Connecting-IP` in `packages/iac-templates/src/edge/`.
4. **Probe blocking** (`security.wafCustomRules`):
   - Blocking probes for secrets and admin panels (`/.env`, `/.git`, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, `/phpmyadmin`) at the edge on the free or cheapest tier.
5. **Credentials & scanning**:
   - Credential environment variable(s), token creation URL, secret-scanning rule(s) in `@opscrew/secops`, and 403/auth error pattern.

### Cloudflare-only capabilities (stay Cloudflare-specific; design explains this plainly)
- **Cloudflare Tunnel** (`target.access: "tunnel"` on own server, `target.web.mode: "tunnel"` on Portainer)
- **Cloudflare Access / Zero Trust** (`portainer.access: "subdomain"`, `observability.beszel.access: "subdomain"`, Portainer `redeploy: "cloudflare"`)
- **Cloudflare Workers hosting** (`target.provider: "cloudflare-workers"`)
- **Cloudflare R2** object storage
- **Cloudflare Workers uptime check** (`observability.check.runner: "cloudflare"`, feature 046)
- **Cloudflare Registrar** (`opscrew domain buy`)
- **Preview environments wildcard + Advanced Certificate Manager** (`environment.previews`, feature 022)
- **Cloudflare account move** (`opscrew cloudflare move`, ADR 0032)

---

## R2 — Bunny.net (`bunny`)

Official sources:
- API & docs: `https://docs.bunny.net/` (`https://api.bunny.net`)
- Terraform provider: `BunnyWay/bunnynet` (`https://registry.terraform.io/providers/BunnyWay/bunnynet/latest/docs`, latest release `v0.20.2` on 2026-11-13)
- Pricing: `https://bunny.net/pricing/`

### Credentials & API
- **Auth header:** `AccessKey: <api_key>` against `https://api.bunny.net`.
- **Terraform provider:** `BunnyWay/bunnynet` (`version = "~> 0.20.2"`), reads `BUNNYNET_API_KEY` environment variable (or `api_key` provider argument).
- **DNS hosting:** Yes (`bunnynet_dns_zone`, `bunnynet_dns_record`).

### Proxying, hostnames & apex routing
- `bunnynet_pullzone` creates a Pull Zone with `origin { type = "OriginUrl", url = "https://<origin>", verify_ssl = true, forward_host_header = true }` and `routing { tier = "Standard" }`.
- `bunnynet_pullzone_hostname` attaches custom hostnames (`<domain>`, optional `www.<domain>`) with `force_ssl = true`.
- **Apex routing:** Bunny DNS provides a native `PullZone` (`PZ`) record type that flattens CNAME/apex routing directly to the Pull Zone at the zone apex (`name = ""`). With external DNS, subdomains use `CNAME` to `<pullzone>.b-cdn.net` (apex requires an ANAME/ALIAS/CNAME-flattening DNS host).

### Edge TLS & validation
- Free auto-renewing Let's Encrypt certificates for custom hostnames via `bunnynet_pullzone_hostname` once DNS points to the Pull Zone (HTTP-01 validation); custom certificates can also be uploaded.

### Origin protection & real visitor IP
- **Published edge IP lists:** `https://api.bunny.net/system/edgeserverlist` (IPv4) and `https://api.bunny.net/system/edgeserverlist/ipv6` (IPv6), JSON array with `Accept: application/json`.
  - **Important operational constraint:** Bunny's global edge list contains hundreds of individual `/32` / `/128` edge server IPs and changes frequently. That exceeds cloud firewall rule/CIDR limits on several VPS providers (for example Hetzner Cloud Firewalls cap rules and source CIDRs).
- **Origin authentication:** Bunny Pull Zones do **not** offer custom client-certificate mTLS to origin. Instead:
  - `bunnynet_pullzone` verifies the origin's TLS certificate (`origin.verify_ssl = true`).
  - `bunnynet_pullzone_edgerule` with action `SetRequestHeader` injects a per-app shared secret header (e.g. `X-OpsCrew-Origin-Token`) on every upstream request; the server's reverse proxy (Caddy/nginx/OpenLiteSpeed) verifies that header and rejects requests without it before forwarding to `kamal-proxy`.
  - Optional Origin Shield (`EnableOriginShield`) funnels edge fetches through a single shielding region if narrower IP allowlisting is desired (paid add-on).
- **Real visitor IP header:** `X-Real-IP` (and `X-Forwarded-For`).

### Probe blocking & WAF
- **Included free on every Pull Zone:** `bunnynet_pullzone_edgerule` supports action `BlockRequest` with URL triggers matching `/.env`, `/.git`, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, `/phpmyadmin`. No paid WAF tier is required for OpsCrew's probe-blocking rule.
- **Bunny Shield (`bunnynet_pullzone_shield`):** Basic tier is **$0/month** (~71 baseline WAF rules, DDoS protection, ~10 custom WAF rules, basic rate limiting). Advanced is `$9.50/mo`, Business `$99/mo`.

### Cache safety
- Pull Zones cache by default according to origin headers; OpsCrew must ensure dynamic app responses are not cached (`cache_enabled = false` or an Edge Rule `DisableCache` / respecting `Cache-Control` and never stripping/caching cookies or error responses).

### Pricing & free tier
- **CDN:** No permanent free tier (14-day free trial). Pay-as-you-go with a **$1/month account minimum usage**:
  - Standard Network (119+ PoPs): `~$0.01/GB` (EU & NA), `$0.03/GB` (Asia & Oceania), `$0.045/GB` (South America), `$0.06/GB` (Middle East & Africa).
  - Volume Network (10 PoPs): from `$0.005/GB`.
- **Bunny DNS:** Free (up to 500 zones, no per-query charge, subject to the $1/mo account minimum).
- **Bunny Shield:** Basic `$0/mo`; Advanced `$9.50/mo`.

---

## R3 — Gcore (`gcore`)

Official sources:
- API & docs: `https://gcore.com/docs/` (`https://api.gcore.com`)
- Terraform provider: `G-Core/gcore` (`https://registry.terraform.io/providers/G-Core/gcore/latest/docs`, latest release `v0.37.2` on 2026-11-16; v2 plugin-framework provider currently in alpha)
- Pricing: `https://gcore.com/pricing/cdn`, `https://gcore.com/pricing/dns`, `https://gcore.com/pricing/waap`

### Credentials & API
- **Auth header:** `Authorization: APIKey <permanent_api_token>` against `https://api.gcore.com`.
- **Terraform provider:** `G-Core/gcore` (`version = "~> 0.37.2"`), reads `GCORE_PERMANENT_API_TOKEN` (or `permanent_api_token` provider argument).
- **DNS hosting:** Yes (`gcore_dns_zone`, `gcore_dns_zone_record`).

### Proxying, hostnames & apex routing
- `gcore_cdn_origin_group` defines the origin server(s).
- `gcore_cdn_resource` attaches `cname` (primary hostname) and `secondary_hostnames` (e.g. `www.<domain>`), with `origin_protocol = "HTTPS"` and `ssl_enabled = true`.
- **Apex routing:** Gcore Managed DNS supports CNAME flattening at the zone apex and native CDN integration (`A`/`AAAA` records bound to the CDN resource).

### Edge TLS & validation
- Free automated Let's Encrypt certificates (`gcore_cdn_certificate` with `automated = true`, or CDN resource `le_enabled` / HTTP-01 once DNS resolves to Gcore, with `use_dns01_le_challenge` available for DNS-01 validation).

### Origin protection & real visitor IP
- **Published edge IP list:** `https://api.gcore.com/cdn/public-ip-list` returning JSON `{ "addresses": [...], "addresses_v6": [...] }`.
  - Like Bunny.net, Gcore's global PoP list is large and expands regularly; Gcore's own documentation explicitly recommends authenticating origin requests with an unpredictable custom static header rather than relying solely on static firewall IP lists.
- **Origin authentication:** Standard Gcore CDN does **not** offer custom client-cert mTLS to origin. Instead:
  - `gcore_cdn_resource.options.static_request_headers` injects a per-app shared secret header on every origin fetch over HTTPS (`origin_protocol = "HTTPS"`).
  - The server's reverse proxy verifies the shared secret header and rejects unauthenticated direct traffic before `kamal-proxy`.
- **Real visitor IP header:** `X-Forwarded-For` (Gcore CDN sets/appends client IP on `X-Forwarded-For`).

### Probe blocking & WAF
- **Included free on Gcore CDN Free tier:** `gcore_cdn_resource_rule` matches path patterns and supports `options { force_return { enabled = true, status = 403, body = "Forbidden" } }`, blocking `/.env`, `/.git`, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, `/phpmyadmin` at the edge without requiring paid WAAP.
- **Gcore WAAP:** Free tier (`€0/mo`: 1 domain, 0.5M requests/mo, default rules + IP firewall rules); Start `€25/mo` (5 domains, 1M req); Pro `€125/mo`.

### Cache safety
- `gcore_cdn_resource.options.edge_cache_settings` disabled (or `value = "0s"` / respect origin `Cache-Control`) and `ignore_query_string { enabled = false }` by default so dynamic app pages and query-parameterized endpoints are never cached unsafely.

### Pricing & free tier
- **CDN:** Permanent **Free Tier** covering **1 TB/month** traffic (no credit card required), then pay-as-you-go regional pricing.
- **Managed DNS:** Permanent **Free Tier** (basic authoritative DNS, CNAME flattening); Pro/Enterprise add dynamic routing and 10s health checks.
- **WAAP:** Free tier (`€0/mo`, 1 domain, 0.5M requests/mo); Start `€25/mo`.

---

## R4 — Fastly (`fastly`)

Official sources:
- API & docs: `https://docs.fastly.com/` (`https://api.fastly.com`)
- Terraform provider: `fastly/fastly` (`https://registry.terraform.io/providers/fastly/fastly/latest/docs`, latest release `v10.4.0` in Nov 2026)
- Pricing: `https://www.fastly.com/pricing/`

### Credentials & API
- **Auth header:** `Fastly-Key: <api_key>` against `https://api.fastly.com` (TLS 1.2+ required).
- **Terraform provider:** `fastly/fastly` (`version = "~> 10.4"`), reads `FASTLY_API_KEY` environment variable (or `api_key` provider argument).
- **DNS hosting:** **None.** A Fastly-fronted domain keeps its DNS at Cloudflare (DNS-only), Bunny DNS, Gcore DNS, or an external DNS provider (`dns.provider: "none"`).

### Proxying, hostnames & apex routing
- `fastly_service_vcl` defines the VCL service, `domain` blocks (`<domain>`, optional `www.<domain>`), and `backend` pointing at the origin.
- **Apex & subdomain DNS routing:**
  - `data "fastly_tls_configuration"` provides Fastly's anycast IPv4 `A` / IPv6 `AAAA` targets for apex domains and the CNAME target (e.g. `t.sni.global.fastly.net`) for subdomains and `www`.
  - When OpsCrew manages DNS (Cloudflare DNS-only, Bunny DNS, or Gcore DNS), OpsCrew can render both the ACME DNS validation records (`fastly_tls_subscription.managed_dns_challenges`) and the routing `A`/`AAAA`/`CNAME` records automatically. When DNS is external (`none`), OpsCrew prints the exact records to add.

### Edge TLS & validation
- `fastly_tls_subscription` + `fastly_tls_subscription_validation` provisions and auto-renews managed TLS certificates via `certainly` (default) or `lets-encrypt` using ACME DNS challenges (`managed_dns_challenges`).
- **Limits:** Up to **5 domains free** on Fastly's developer/free tier; `$20/domain/month` beyond 5.

### Origin protection & real visitor IP
- **Published edge IP CIDRs:** `https://api.fastly.com/public-ip-list` and Terraform `data "fastly_ip_ranges"` — compact CIDR list (~18 IPv4 + 2 IPv6 CIDRs, comparable to Cloudflare), so cloud firewalls and server proxy `trusted_proxies` can restrict ports 80/443 directly to Fastly's CIDRs.
- **True origin mTLS (Fastly -> origin):** `fastly_service_vcl.backend` supports `ssl_check_cert = true`, `ssl_client_cert`, and `ssl_client_key` (sensitive), plus `ssl_ca_cert`. OpsCrew can reuse its existing per-app P-256 self-signed client certificate (`pull.pem`) from `origin-tls` so the server's Caddy/nginx/OpenLiteSpeed requires Fastly's client certificate just like Cloudflare AOP!
  - *(Note: `fastly_tls_mutual_authentication` is for visitor-to-Fastly mTLS and requires a paid contract; backend `ssl_client_cert`/`ssl_client_key` is Fastly-to-origin mTLS on VCL backends.)*
  - A VCL shared secret header can also be set in `vcl_miss`/`vcl_pass` if needed as fallback.
- **Real visitor IP header:** `Fastly-Client-IP`.

### Probe blocking & WAF
- **Included free on every tier:** Fastly's Next-Gen WAF is a paid add-on, so OpsCrew writes the probe-blocking rule natively in VCL (`condition` + `response_object` returning HTTP `403 Forbidden` inside `fastly_service_vcl` for `/.env`, `/.git`, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, `/phpmyadmin`). Works on the Free tier at zero extra cost.

### Cache safety
- VCL `vcl_recv` / `request_setting` (`action = "pass"`) bypasses caching by default for dynamic apps (or respects origin `Cache-Control` and never caches responses with `Set-Cookie` or `Authorization`).

### Pricing & free tier
- **Free developer tier:** **100 GB bandwidth/month** + **1M requests/month** + **5 free managed TLS domains** (credit card verification may be required to prevent abuse).
- **Beyond free tier:** Usage-based bandwidth/requests; additional TLS domains `$20/domain/month`.

---

## R5 — Cross-provider comparison

| Capability | Cloudflare | Bunny.net | Gcore | Fastly |
|---|---|---|---|---|
| **DNS hosting** | Yes (Free) | Yes (Free, up to 500 zones) | Yes (Free tier) | **No** (use Cloudflare DNS-only, Bunny, Gcore, or external) |
| **Apex routing** | Native CNAME flattening / proxied `A`/`AAAA` | Native `PullZone` (`PZ`) record | Native CNAME flattening / CDN-linked `A`/`AAAA` | Anycast `A`/`AAAA` from `fastly_tls_configuration` |
| **Edge TLS** | Universal SSL (free; 1 level below zone) | Let's Encrypt auto-SSL (free) | Let's Encrypt auto-SSL (free, HTTP-01 or DNS-01) | Managed TLS via Certainly / Let's Encrypt (5 domains free, then $20/mo) |
| **Terraform provider** | `cloudflare/cloudflare` (`~> 5.0`) | `BunnyWay/bunnynet` (`~> 0.20.2`) | `G-Core/gcore` (`~> 0.37.2`) | `fastly/fastly` (`~> 10.4`) |
| **Credential env var** | `CLOUDFLARE_API_TOKEN` | `BUNNYNET_API_KEY` | `GCORE_PERMANENT_API_TOKEN` | `FASTLY_API_KEY` |
| **API auth header** | `Authorization: Bearer` | `AccessKey:` | `Authorization: APIKey` | `Fastly-Key:` |
| **Published IP ranges** | Compact CIDRs (`/client/v4/ips`, ~22 CIDRs) | Dynamic individual IPs (`/system/edgeserverlist`, hundreds) | Dynamic IP/CIDR list (`/cdn/public-ip-list`) | Compact CIDRs (`/public-ip-list` / `fastly_ip_ranges`, ~20 CIDRs) |
| **Origin authentication** | Origin CA + per-host mTLS AOP (`pull.pem`) | Verified HTTPS + `SetRequestHeader` shared secret | Verified HTTPS + `static_request_headers` shared secret | Verified HTTPS + backend mTLS (`ssl_client_cert`/`ssl_client_key`, `pull.pem`) |
| **Real visitor IP header** | `CF-Connecting-IP` | `X-Real-IP` | `X-Forwarded-For` | `Fastly-Client-IP` |
| **Probe blocking (free/cheapest)** | Shared WAF custom rule (`http_request_firewall_custom`, 5 free/zone) | `bunnynet_pullzone_edgerule` (`BlockRequest`, included free) | `gcore_cdn_resource_rule` (`force_return` 403, included on Free tier) | VCL `condition` + `response_object` 403 (included free) |
| **Cache-off default** | Default skips HTML/dynamic | `DisableCache` / `cache_enabled = false` | `edge_cache_settings` disabled + `ignore_query_string = false` | VCL `pass` |
| **Free / entry cost** | Free DNS + CDN + 5 WAF rules | $1/mo minimum, ~$0.01/GB EU/NA (DNS + Shield Basic free) | Free 1 TB/mo CDN + Free DNS + Free WAAP (1 domain) | Free 100 GB + 1M req + 5 TLS domains |

---

## R6 — Proposed Edge & DNS Provider Contract (ADR 0038 sketch)

Following ADR 0029 (`CloudProviderDefinition` in `packages/contracts/src/provider.ts` + registry in `packages/providers/registry`), only plain data, regular expressions, and functions cross the contract:

- **Contract version:** `EDGE_PROVIDER_CONTRACT_VERSION = 1` in `packages/contracts/src/edge-provider.ts`.
- **Capabilities object** (`capabilities`):
  - `dns: boolean` (`true` for Cloudflare, Bunny, Gcore; `false` for Fastly)
  - `edge: boolean` (`true` for all four)
  - `apexCnameFlattening: boolean`
  - `compactOriginCidrs: boolean` (`true` for Cloudflare & Fastly — fits cloud firewalls; `false` for Bunny & Gcore — use shared origin secret header + optional server-side check)
  - `originAuth: "cloudflare-aop" | "mtls-client-cert" | "shared-header"`
  - `realIpHeader: string` (`"CF-Connecting-IP"`, `"X-Real-IP"`, `"X-Forwarded-For"`, `"Fastly-Client-IP"`)
  - `cloudflareOnlyFeatures: boolean` (only `true` for Cloudflare: Tunnel, Access, Workers, R2, Uptime Worker, Previews wildcard)
- **Credentials** (`credentials`): `envVars`, `labels`, `mode`, `createUrl`, `tokenRules` (for `@opscrew/secops`), `envPrefixes`, `apiPattern`.
- **Connector factory** (`createConnector(deps)`): verifies credentials, lists/checks zones (when `capabilities.dns`), fetches edge IP ranges (`fetchEdgeIpRanges()`), inspects/manages DNS or shared edge resources.
- **Terraform** (`terraform`): `provider` requirement (`source`, `version`), `credentialsComment`, `dnsModule` (optional, absent for Fastly), `edgeModule` (when proxied via Terraform), root variables/arguments.
- **Pricing & limits** (`pricing`): plain-English summary, free tier note, domain/rule limits for `design` cost & trade-off reporting.
- **Texts** (`texts`): interview label/description, design caveats (what stays Cloudflare-only), runbook, destroy, SecOps.

---

## R7 — Open decisions for the core's lead (`#29`)

Before modifying shared files (`packages/contracts`, `packages/plan-schema`), the following contract and schema questions are posted on Issue `#29`:

1. **Plan schema representation of DNS host vs edge proxy:**
   - Keep `dns.provider: "cloudflare" | "bunny" | "gcore" | "none"` for DNS hosting, and add optional `dns.edge?: "cloudflare" | "bunny" | "gcore" | "fastly"` (defaulting to `dns.provider` when `dns.proxied: true` and `dns.provider !== "none"`, omitted when `dns.proxied: false` or unchanged for existing Cloudflare plans so existing `plan.yaml` files stay byte-identical).
   - For `security.httpAllowedFrom`: accept `"any" | "cloudflare" | "edge"`, keeping `"cloudflare"` as the default when proxied by Cloudflare (byte-identical for existing plans) and defaulting to `"edge"` when proxied by Bunny, Gcore, or Fastly.
2. **Origin protection for Bunny.net and Gcore (`shared-header`):**
   - Because Bunny and Gcore do not support custom client-cert mTLS to origin and publish large/dynamic edge IP lists that can exceed cloud firewall CIDR limits, use a generated per-app 32-byte hex origin-verification token (`X-OpsCrew-Origin-Token`, stored in `generated_values.json`, passed via `TF_VAR_` to Terraform and rendered into Caddy/nginx/OpenLiteSpeed to reject direct requests with 403/abort) over verified HTTPS (`verify_ssl` / `origin_protocol: "HTTPS"`). Fastly uses compact CIDRs (`fastly_ip_ranges`) + true origin mTLS (`ssl_client_cert` / `ssl_client_key`), reusing OpsCrew's `pull.pem`.
3. **Package layout:**
   - Mirror `packages/providers/*` with `packages/edge-providers/<id>` (`@opscrew/edge-cloudflare`, `@opscrew/edge-bunny`, `@opscrew/edge-gcore`, `@opscrew/edge-fastly`) + `packages/edge-providers/registry` (`@opscrew/edge-providers`), keeping `@opscrew/connector-cloudflare` for Cloudflare's API client and Cloudflare-only features (wrapped by `@opscrew/edge-cloudflare`).
4. **PR 1 scope:**
   - PR 1 adds ADR 0038 + `EdgeProviderDefinition` in `@opscrew/contracts` + `@opscrew/edge-providers` registry + `@opscrew/edge-cloudflare` with zero user-visible or output changes (byte-identical rendered files and schemas for existing Cloudflare users). Subsequent PRs add Bunny.net, Gcore, and Fastly one by one.
