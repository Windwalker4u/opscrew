# Gcore edge proxy and DNS

OpsCrew can serve your app through **Gcore CDN** instead of Cloudflare's proxy — either with Gcore
hosting your DNS (`dns.provider: gcore`) or with an external DNS provider (`dns.provider: none`
with `dns.edge: gcore`).

> **Note:** Interactive selection in `opscrew interview` / `opscrew design` is not wired for Gcore
> yet, and combining `dns.provider: cloudflare` with `dns.edge: gcore` is refused until Cloudflare
> DNS-only readers switch to the active edge provider. Configure Gcore directly in
> `opscrew/plan.yaml` as shown below.

## Prerequisites

1. A Gcore account (Gcore offers a permanent **Free CDN tier of 1 TB/month** and free Managed DNS).
2. A permanent API token from
   [portal.gcore.com/accounts/profile/api-tokens](https://portal.gcore.com/accounts/profile/api-tokens)
   with CDN and DNS permissions, exported as `GCORE_PERMANENT_API_TOKEN`.
3. If `dns.provider: gcore`, create your domain's DNS zone in Gcore Managed DNS before running
   `opscrew provision`.

## Configuration in `opscrew/plan.yaml`

With Gcore hosting both DNS and CDN:

```yaml
dns:
  provider: gcore
  domain: app.example.com
  zone: example.com
  proxied: true
  www: true
security:
  httpAllowedFrom: edge
  wafCustomRules: true
```

With external DNS in front of Gcore CDN:

```yaml
dns:
  provider: none
  edge: gcore
  domain: app.example.com
  proxied: true
security:
  httpAllowedFrom: edge
```

## Origin protection: shared header vs mTLS + CIDR firewall

Cloudflare and Fastly publish compact CIDR lists (~20 ranges) and support origin mTLS client
certificates, so OpsCrew restricts cloud firewall ports 80 and 443 to their CIDRs and enforces
per-app mTLS (`pull.pem`) on the server.

Gcore's global PoP list is large and expands regularly, so Gcore recommends authenticating origin
traffic with an unpredictable custom request header rather than static firewall IP lists:

- **Cloud firewall:** Ports 80 and 443 stay open (`0.0.0.0/0`, `::/0`) so Gcore PoPs can always
  reach your origin over HTTPS (`origin_protocol = "HTTPS"`).
- **Shared origin-verification header (the gate):** OpsCrew generates a per-app 32-byte random hex
  secret (`X-OpsCrew-Origin-Token`), keeps it in local `generated_values.json` (`0600`) and GitHub
  Actions (`OPSCREW_EDGE_ORIGIN_TOKEN`), uploads `/srv/edge/tls/<app>/origin-token.<ext>` (`0600`)
  on every deploy, and applies it to your Gcore CDN resource via a hash-approved API call
  (`PATCH /cdn/resources/{id}` `staticRequestHeaders`), preserving any custom headers you already
  configured.
- **Security trade-off (weaker than mTLS):** A shared secret header is strictly weaker than mTLS
  plus a CIDR firewall. Anyone who learns the `X-OpsCrew-Origin-Token` value can send requests
  directly to your origin server around Gcore. Rotate it immediately with
  `opscrew rotate edge-origin-token` if you ever suspect exposure.
- **Never in Terraform state or git:** OpsCrew intentionally does **not** set
  `gcore_cdn_resource.options.static_request_headers` in Terraform, because Terraform would persist
  the secret in state. SecOps blocks any Terraform plan that enables `static_request_headers` in
  state.
- **Reverse-proxy ordering and client IP semantics:** On Caddy, nginx, and OpenLiteSpeed, every
  request missing the exact `X-OpsCrew-Origin-Token` value receives **HTTP 403** before reaching
  `kamal-proxy` and before trusting `X-Forwarded-For`. After verification, every proxy strips
  `X-OpsCrew-Origin-Token` so your app never sees it. Because Gcore appends the connecting visitor's
  IP to any incoming `X-Forwarded-For` header (rather than exposing a dedicated single-IP header),
  apps that parse `X-Forwarded-For` should use the rightmost Gcore-appended hop rather than blindly
  trusting an arbitrary leftmost client-supplied entry. On OpenLiteSpeed, OpsCrew strips untrusted
  `X-Forwarded-*` headers after verifying the origin token.

## Zero-downtime rotation

Rotate the origin-verification secret at any time with:

```bash
opscrew rotate edge-origin-token
```

OpsCrew approves the rotation plan by its SHA-256 hash first (a refusal changes nothing), configures
the server proxy to accept both tokens, switches Gcore CDN to the new token, and narrows the server
proxy to the new token only. If interrupted mid-flight, re-running resumes with the recorded token
pair.

## Caching and probe blocking

- **Dynamic-safe caching:** OpsCrew creates `gcore_cdn_resource` with
  `edge_cache_settings.enabled = false` and `ignore_query_string.enabled = false` so dynamic pages
  and query-parameterized endpoints are never cached unexpectedly.
- **Automated edge TLS:** Terraform provisions a `gcore_cdn_sslcert` (`automated = true`, Let's
  Encrypt) bound to `gcore_cdn_resource` (`ssl_enabled = true`, TLS 1.2/1.3) and points Gcore DNS
  CNAME records at the account's CDN edge target (`data.gcore_cdn_client.this[0].cname`).
- **Free probe blocking:** When `security.wafCustomRules: true`, Terraform creates a
  `gcore_cdn_rule` using `force_return` (`code = 403`, `Forbidden`) blocking `/.env`, `/.git/`,
  `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, and `/phpmyadmin` at the edge on the Free tier.

## What stays Cloudflare-only

Cloudflare-specific products remain on Cloudflare: Cloudflare Tunnel, Cloudflare Access / Zero
Trust, Cloudflare Workers hosting, R2 object storage, Cloudflare Registrar, Workers uptime checks,
and preview environments (`environment.previews`).

## Live-pass checklist (unverified against a real Gcore account)

1. Export `GCORE_PERMANENT_API_TOKEN` and run `opscrew provision` for a test app with
   `dns.provider: gcore`, `dns.proxied: true`, `security.httpAllowedFrom: edge`.
2. Verify `https://<domain>/.env` returns HTTP `403` at Gcore's edge without hitting the origin.
3. Verify a direct request to `https://<server-ip>` without `X-OpsCrew-Origin-Token` returns HTTP `403`.
4. Run `opscrew rotate edge-origin-token` and verify zero failed requests during and after rotation.
