# Bunny.net edge proxy and DNS

OpsCrew can serve your app through **Bunny.net** instead of Cloudflare's proxy — either with Bunny
hosting your DNS (`dns.provider: bunny`) or with an external DNS provider (`dns.provider: none`
with `dns.edge: bunny`).

> **Note:** Interactive selection in `opscrew interview` / `opscrew design` is not wired for
> Bunny.net yet, and combining `dns.provider: cloudflare` with `dns.edge: bunny` is refused until
> Cloudflare DNS-only readers switch to the active edge provider. Configure Bunny directly in
> `opscrew/plan.yaml` as shown below.

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

With external DNS in front of Bunny's edge:

```yaml
dns:
  provider: none
  edge: bunny
  domain: app.example.com
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
  secret (`X-OpsCrew-Origin-Token`), keeps it in local `generated_values.json` (`0600`) and GitHub
  Actions (`OPSCREW_EDGE_ORIGIN_TOKEN`), uploads `/srv/edge/tls/<app>/origin-token.<ext>` (`0600`)
  on every deploy, and configures Bunny's Pull Zone via a hash-approved Bunny API call
  (`POST /pullzone/{id}/edgerules/addOrUpdate`).
- **Security trade-off (weaker than mTLS):** A shared secret header is strictly weaker than mTLS
  plus a CIDR firewall. Anyone who learns the `X-OpsCrew-Origin-Token` value can send requests
  directly to your origin server around Bunny.net. Rotate it immediately with
  `opscrew rotate edge-origin-token` if you ever suspect exposure.
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

OpsCrew approves the rotation plan by its SHA-256 hash first (a refusal changes nothing), then
rotates the token without dropping in-flight traffic:
1. Configures the server's reverse proxy (and `OPSCREW_EDGE_ORIGIN_TOKEN`) to accept both the new
   and previous tokens.
2. Switches Bunny's Pull Zone Edge Rule to the new token.
3. Narrows the server's reverse proxy and deploy secret to accept only the new token.

If an interrupted rotation stops mid-flight, re-running `opscrew rotate edge-origin-token` resumes
with the recorded token pair so live traffic is never dropped.

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

## Live-pass checklist (unverified against a real Bunny.net account)

The following behaviors are based on official `BunnyWay/bunnynet` documentation and need a live
pass with a real Bunny.net account to confirm end-to-end:

1. Export `BUNNYNET_API_KEY` and run `opscrew provision` for a test app with `dns.provider: bunny`,
   `dns.proxied: true`, `security.httpAllowedFrom: edge`.
2. Confirm how `origin.verify_ssl = true` validates the origin certificate when `origin.url` is
   `https://<server-ip>` with `forward_host_header = true`, and verify Caddy's first HTTP-01
   certificate issuance behind Bunny with `tls_enabled = true` and `force_ssl = true`.
3. If testing an IPv6-only origin server, verify Bunny reaches `https://[<ipv6>]`.
4. Verify `https://<domain>/.env` returns HTTP `403` at Bunny's edge without hitting the origin.
5. Verify a direct request to `https://<server-ip>` without `X-OpsCrew-Origin-Token` returns HTTP `403`.
6. Run `opscrew rotate edge-origin-token` and verify zero failed requests during and after rotation.
