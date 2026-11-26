# Specification: Edge providers in place of Cloudflare's proxy: Bunny.net, Gcore and Fastly

**Feature**: `036-edge-providers` | **Issue**: `#29` | **ADR**: [0038](../../docs/adr/0038-edge-provider-contract.md) | **Status**: Ready (PR 1 approved)

## Problem

Today OpsCrew supports only Cloudflare as a DNS host and edge proxy, with Cloudflare facts
hardcoded across `@opscrew/plan-schema`, `@opscrew/iac-templates`, `@opscrew/secops`, and
`@opscrew/agents`. Users who want another edge proxy (or to leave Cloudflare entirely for DNS and
CDN) cannot choose Bunny.net, Gcore, or Fastly.

## Scope & delivery order

Feature 036 ships as four pull requests:
1. **PR 1 — Edge provider contract + Cloudflare behind it**:
   - Define `EdgeProviderDefinition` (`EDGE_PROVIDER_CONTRACT_VERSION = 1`) in
     `@opscrew/contracts`.
   - Implement `@opscrew/edge-provider-cloudflare` wrapping `@opscrew/connector-cloudflare`, and
     `@opscrew/edge-providers` registry with load-time validation and conformance tests.
   - Rename `security.httpAllowedFrom` from `"any" | "cloudflare"` to `"any" | "edge"` (no alias;
     explicit one-line error message guiding users with `"cloudflare"` to set `"edge"`).
   - Route generic edge facts (real-visitor-IP header, display name, origin-protection model,
     credentials) through `@opscrew/edge-providers` so rendered files for existing Cloudflare
     users remain **byte-for-byte identical**.
2. **PR 2 — Bunny.net (`@opscrew/edge-provider-bunny`)**:
   - DNS hosting (`bunnynet_dns_zone`, `bunnynet_dns_record`, apex `PullZone` flattening) +
     edge proxy (`bunnynet_pullzone`, `bunnynet_pullzone_hostname` free Let's Encrypt,
     `bunnynet_pullzone_edgerule` probe blocking & cache-off), connector-applied shared origin
     header (never in Terraform state), `X-Real-IP`, `opscrew rotate` support, and guide page.
3. **PR 3 — Gcore (`@opscrew/edge-provider-gcore`)**:
   - DNS hosting (`gcore_dns_zone`, `gcore_dns_zone_record`, apex flattening) + edge proxy
     (`gcore_cdn_origin_group`, `gcore_cdn_resource`, `gcore_cdn_certificate` automated Let's
     Encrypt, `gcore_cdn_resource_rule` `force_return` 403 probe blocking & cache-off),
     connector-applied shared origin header (never in Terraform state), `X-Forwarded-For`,
     `opscrew rotate` support, and guide page.
4. **PR 4 — Fastly (`@opscrew/edge-provider-fastly`)**:
   - Edge proxy only (`dns: false`, paired with Cloudflare DNS-only, Bunny DNS, or Gcore DNS —
     refused with `dns.provider: "none"`), `fastly_service_vcl` + VCL probe blocking (`403`) +
     cache bypass (`pass`) + `fastly_tls_subscription`, compact CIDR firewall (`fastly_ip_ranges`)
     + origin mTLS (`pull.pem`, private key kept out of Terraform state), `Fastly-Client-IP`, and
     guide page.

## Requirements (PR 1)

- **FR-3601 (Contract):** `packages/contracts/src/edge-provider.ts` exports
  `EDGE_PROVIDER_CONTRACT_VERSION = 1` and `EdgeProviderDefinition` using only plain data,
  regular expressions, and functions (no zod schemas or class instances).
- **FR-3602 (Cloudflare package):** `packages/edge-providers/cloudflare`
  (`@opscrew/edge-provider-cloudflare`) exports `definition: EdgeProviderDefinition` declaring
  `id: "cloudflare"`, `displayName: "Cloudflare"`, `originAuth: "cloudflare-aop"`,
  `originIpFiltering: "compact-cidrs"`, `realIpHeader: "CF-Connecting-IP"`,
  `terraform.dnsRecordResourceType: "cloudflare_dns_record"`, and `texts.secops.*`.
- **FR-3603 (Registry):** `packages/edge-providers/registry` (`@opscrew/edge-providers`) exports
  `EDGE_PROVIDERS`, `edgeProvider(id)`, and `validateEdgeProvider(candidate)`. Validation runs at
  load time and fails fast with an `INTERNAL` `OpsCrewError` on invalid definitions; unknown
  provider lookups throw `INVALID_INPUT` naming the known providers.
- **FR-3604 (`httpAllowedFrom: "edge"`):** `plan.security.httpAllowedFrom` accepts `"any" | "edge"`,
  defaulting to `"edge"` when `dns.proxied` is true and `"any"` otherwise. Passing `"cloudflare"`
  fails validation with a plain one-line message telling the user to set
  `security.httpAllowedFrom` to `"edge"`. Preview and own-server validations in `plan-schema`
  name `"edge"`.
- **FR-3605 (Byte-identical rendered output):** For Cloudflare plans (with `httpAllowedFrom: "edge"`),
  Caddyfile, nginx.conf, OpenLiteSpeed conf, Compose files, Terraform HCL, and workflows render
  byte-for-byte identically to before PR 1, while reading `realIpHeader` and edge metadata from
  `@opscrew/edge-providers`.
- **FR-3606 (Safety):** No secrets are logged, printed, committed, or written to Terraform state.
  All existing safety gates, approvals, and SecOps policies remain enforced.
