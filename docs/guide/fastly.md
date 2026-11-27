# Fastly edge proxy

OpsCrew can serve your app through **Fastly** instead of Cloudflare's proxy. Because Fastly does not
host authoritative DNS zones, you pair `dns.edge: fastly` with a supported DNS host
(`dns.provider`: `bunny` or `gcore`).

> **Note:** Interactive selection in `opscrew interview` / `opscrew design` is not wired for Fastly
> yet, and combining `dns.provider: cloudflare` with `dns.edge: fastly` is refused until Cloudflare
> DNS-only readers switch to the active edge provider. Configure Fastly directly in
> `opscrew/plan.yaml` as shown below.

## Prerequisites

1. A Fastly account (Fastly's free developer tier includes up to 5 managed TLS domains, 100 GB
   egress, and 1M requests/month).
2. A Fastly API token from
   [manage.fastly.com/account/personal/tokens](https://manage.fastly.com/account/personal/tokens)
   with global write scope, exported as `FASTLY_API_KEY`.
3. Authoritative DNS hosted at `bunny` or `gcore` (and that DNS host's API token).
   `dns.provider: none` with `dns.edge: fastly` is refused because someone must host the DNS records
   pointing at Fastly.

## Configuration in `opscrew/plan.yaml`

With Bunny DNS (or Gcore DNS) in front of Fastly:

```yaml
dns:
  provider: bunny # or "gcore"
  edge: fastly
  domain: app.example.com
  zone: example.com
  proxied: true
  www: true
security:
  httpAllowedFrom: edge
  wafCustomRules: true
```

## Origin protection: compact CIDRs + origin mTLS

Like Cloudflare, Fastly gives OpsCrew both layers of origin protection:

- **Compact CIDR cloud firewall:** Fastly publishes ~18 IPv4 and 2 IPv6 CIDRs at
  `https://api.fastly.com/public-ip-list`. OpsCrew restricts cloud firewall ports 80 and 443 to
  Fastly's CIDRs only, configures Caddy and nginx to trust `Fastly-Client-IP` strictly from those
  CIDRs, and configures OpenLiteSpeed (`useIpInProxyHeader 2`) to trust `X-Forwarded-For` from
  those CIDRs.
- **Origin TLS & mTLS (`pull.pem`):** Because the cloud firewall blocks public port 80 (so the
  origin cannot run HTTP-01 ACME), OpsCrew generates a per-app P-256 origin server certificate
  (signed by a per-app CA) and client certificate (`pull.pem`) locally in `generated_values.json`
  (`0600`). The server's reverse proxy serves the origin certificate (`OPSCREW_ORIGIN_TLS`) and
  requires `pull.pem`; after Terraform apply, OpsCrew installs `ssl_ca_cert`, `ssl_client_cert`,
  and `ssl_client_key` on Fastly's `opscrew_origin` backend via a plan-hash-approved Fastly API
  sequence (clone active version -> update backend -> activate).
- **Never in Terraform state or git:** OpsCrew intentionally omits `backend.ssl_client_key` from
  `fastly_service_vcl` in Terraform so the private key never lands in Terraform state. SecOps
  blocks any Terraform plan that puts `ssl_client_key` in state as a `critical` finding.

## Caching, TLS, and free probe blocking

- **Dynamic-safe pass & HTTPS:** OpsCrew creates `fastly_service_vcl` with
  `request_setting { action = "pass", force_ssl = true }` so dynamic responses are not cached by
  default and HTTP visitors are redirected to HTTPS.
- **Verified origin TLS:** The `opscrew_origin` backend uses `use_ssl = true`,
  `ssl_check_cert = true`, and matches `ssl_cert_hostname` / `ssl_sni_hostname` to your domain,
  verified against OpsCrew's per-app origin CA pinned via `ssl_ca_cert`.
- **Managed edge TLS & split DNS routing:** `fastly_tls_subscription` provisions managed HTTPS
  certificates for your domain (and `www.<domain>` when enabled). The paired DNS module (Bunny DNS
  or Gcore DNS) automatically creates the ACME DNS validation records from `managed_dns_challenges`
  plus the routing records pointing at Fastly's edge (`Flatten`/`CNAME` on Bunny; anycast
  `A`/`AAAA` at apex and `CNAME` on subdomains on Gcore), and `fastly_tls_subscription_validation`
  waits for validation to complete.
- **Free VCL probe blocking:** When `security.wafCustomRules: true`, Terraform adds a VCL
  `condition` and `response_object` returning HTTP `403 Forbidden` at Fastly's edge for `/.env`,
  `/.git/`, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, and `/phpmyadmin`.

## What stays Cloudflare-only

Cloudflare-specific products remain on Cloudflare: Cloudflare Tunnel, Cloudflare Access / Zero
Trust, Cloudflare Workers hosting, R2 object storage, Cloudflare Registrar, Workers uptime checks,
and preview environments (`environment.previews`).

## Live-pass checklist (unverified against a real Fastly account)

1. Export `FASTLY_API_KEY` (and your Bunny/Gcore DNS token) and run `opscrew provision` for a test
   app with `dns.provider: bunny` (or `gcore`), `dns.edge: fastly`, `dns.proxied: true`,
   `security.httpAllowedFrom: edge`.
2. Approve the Terraform plan (creates the Fastly VCL service, Bunny/Gcore edge routing + ACME DNS
   validation records, and waits for `fastly_tls_subscription_validation`), then approve the Fastly
   origin mTLS plan (pins `ssl_ca_cert` + `ssl_client_cert` + `ssl_client_key` on `opscrew_origin`).
3. Verify `https://<domain>/.env` returns HTTP `403` at Fastly's edge without hitting the origin.
4. Verify a direct connection to port 443 on the server IP from outside Fastly's CIDRs is blocked by
   the cloud firewall, and a connection without the `pull.pem` client cert fails TLS handshake.
