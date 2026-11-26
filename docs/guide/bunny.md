# Bunny.net edge proxy and DNS

OpsCrew can serve your app through **Bunny.net** instead of Cloudflare's proxy — either with Bunny
hosting your DNS (`dns.provider: bunny`) or with Bunny's Pull Zone sitting in front of Cloudflare
DNS (`dns.provider: cloudflare` with `dns.edge: bunny`) or an external DNS provider
(`dns.provider: none` with `dns.edge: bunny`).

## Prerequisites

1. A Bunny.net account (pay-as-you-go with a \$1/month account minimum; Bunny DNS is included).
2. Your account API key from [dash.bunny.net/account/api-key](https://dash.bunny.net/account/api-key),
   exported as `BUNNYNET_API_KEY`.
3. If `dns.provider: bunny`, add your domain's zone in Bunny DNS before running `opscrew provision`.

## Configuration in `opscrew/plan.yaml`

With Bunny hosting both DNS and the edge proxy:

```yaml
dns:
  provider: bunny
  domain: app.example.com
  zone: example.com
  proxied: true
  www: true
security:
  httpAllowedFrom: edge
  wafCustomRules: true
```

With Cloudflare (DNS-only) or external DNS in front of Bunny's edge:

```yaml
dns:
  provider: cloudflare # or "none"
  edge: bunny
  domain: app.example.com
  zone: example.com
  proxied: true
security:
  httpAllowedFrom: edge
```

## Origin protection: shared header vs mTLS + CIDR firewall

Cloudflare and Fastly publish compact CIDR lists (~20 ranges) and support origin mTLS client
certificates, so OpsCrew restricts cloud firewall ports 80 and 443 to their CIDRs and enforces
per-app mTLS (`pull.pem`) on the server.

Bunny.net's global edge uses hundreds of individual edge server IP addresses that change
frequently — too many for cloud provider firewalls. Instead:

- **Cloud firewall:** Ports 80 and 443 stay open (`0.0.0.0/0`, `::/0`) so Bunny's edge servers can
  always reach your origin over verified HTTPS (`origin.verify_ssl = true`).
- **Shared origin-verification header (the gate):** OpsCrew generates a per-app 32-byte random hex
  secret (`X-OpsCrew-Origin-Token`), keeps it in local `generated_values.json` (`0600`) and on the
  server in `/srv/edge/tls/<app>/origin-token.<ext>` (`0600`), and configures Bunny's Pull Zone via
  a hash-approved Bunny API call (`POST /pullzone/{id}/edgerules/addOrUpdate`).
- **Never in Terraform state or git:** OpsCrew intentionally does **not** manage `SetRequestHeader`
  in Terraform (`bunnynet_pullzone_edgerule`), because Terraform would persist the secret in state.
  SecOps blocks any Terraform plan that tries to put `SetRequestHeader` in state.
- **Reverse-proxy ordering:** On Caddy, nginx, and OpenLiteSpeed, every request missing the exact
  `X-OpsCrew-Origin-Token` value receives **HTTP 403** before reaching `kamal-proxy` and before
  trusting `X-Real-IP`. After verification, the proxy strips `X-OpsCrew-Origin-Token` so your app
  never sees it and forwards Bunny's `X-Real-IP` as `X-Forwarded-For`.

## Zero-downtime rotation

Rotate the origin-verification secret at any time with:

```bash
opscrew rotate edge-origin-token
```

OpsCrew rotates it without dropping in-flight traffic:
1. Configures the server's reverse proxy (and `OPSCREW_EDGE_ORIGIN_TOKEN`) to accept both the new
   and previous tokens.
2. Asks you to approve the Bunny Pull Zone Edge Rule update by its plan hash and switches Bunny to
   the new token.
3. Narrows the server's reverse proxy and deploy secret to accept only the new token.

## Caching and probe blocking

- **Dynamic-safe caching:** OpsCrew creates the Pull Zone with `cache_enabled = false` so dynamic
  HTML, API responses, and cookies are not cached unexpectedly.
- **Free probe blocking:** When `security.wafCustomRules: true`, Terraform creates a free
  `BlockRequest` Edge Rule on the Pull Zone blocking `/.env`, `/.git/`, `/wp-admin`,
  `/wp-login.php`, `/xmlrpc.php`, and `/phpmyadmin` at the edge.

## What stays Cloudflare-only

Cloudflare-specific products remain on Cloudflare: Cloudflare Tunnel, Cloudflare Access / Zero
Trust, Cloudflare Workers hosting, R2 object storage, Cloudflare Registrar, Workers uptime checks,
and preview environments (`environment.previews`).

## Live-pass checklist (requires a Bunny.net account)

1. Export `BUNNYNET_API_KEY` and verify credentials (`bunnyClient.verifyCredentials()`).
2. Provision a test app with `dns.provider: bunny`, `dns.proxied: true`, `security.httpAllowedFrom: edge`.
3. Verify `https://<domain>/.env` returns HTTP `403` at Bunny's edge without hitting the origin.
4. Verify a direct request to `https://<server-ip>` without `X-OpsCrew-Origin-Token` returns HTTP `403`.
5. Run `opscrew rotate edge-origin-token` and verify zero failed requests during and after rotation.
