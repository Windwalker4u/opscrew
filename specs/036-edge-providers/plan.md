# Implementation Plan: Edge providers in place of Cloudflare's proxy

**Feature**: `036-edge-providers` | **Issue**: `#29` | **ADR**: [0038](../../docs/adr/0038-edge-provider-contract.md)

## Recorded Lead Decisions (`#29`, 2026-11-26)

1. **`plan.yaml` DNS & edge fields:**
   - `dns.provider` stays the DNS host (`"cloudflare" | "none"` in PR 1; `"cloudflare" | "bunny" | "gcore" | "none"` once Bunny/Gcore land).
   - `dns.edge?: "bunny" | "gcore" | "fastly"` (added when non-Cloudflare edges land; no `"cloudflare"` value). Absent + `proxied: true` means the DNS host's own proxy. `dns.edge` without `proxied: true` is refused; `dns.edge: "fastly"` with `dns.provider: "none"` is refused.
   - `security.httpAllowedFrom: "any" | "edge"` (renamed from `"cloudflare"`, no alias; explicit one-line refusal for `"cloudflare"`: `set security.httpAllowedFrom to "edge"`). Rendered output stays byte-for-byte identical for Cloudflare users.
2. **Origin protection & secret storage:**
   - `originAuth: "cloudflare-aop" | "mtls-client-cert" | "shared-header"` and `originIpFiltering: "compact-cidrs" | "dynamic-ips"`.
   - Origin auth secrets (shared header tokens for Bunny/Gcore; origin mTLS private keys for Cloudflare/Fastly) **never** enter Terraform state or the repo; where a provider's Terraform resource would persist them in state, they are applied via a typed connector call approved by plan hash.
   - Shared-header secrets are rotatable via `opscrew rotate` (edge updated first, server accepts old+new during swap, then only new).
   - Server reverse proxies reject missing/wrong origin header before `kamal-proxy` and before trusting `realIpHeader` (whose name comes from the edge definition).
3. **Probe blocking:** Every provider's free-tier probe-blocking rule has unit tests of what it renders and a live-pass check returning 403 at the edge.
4. **Package layout:**
   - `packages/contracts/src/edge-provider.ts` (`EdgeProviderDefinition`, `EDGE_PROVIDER_CONTRACT_VERSION = 1`).
   - `packages/edge-providers/<id>` (`@opscrew/edge-provider-<id>`).
   - `packages/edge-providers/registry` (`@opscrew/edge-providers`).
   - `@opscrew/edge-provider-cloudflare` wraps `@opscrew/connector-cloudflare`; Cloudflare-only features stay Cloudflare's.
   - Do not modify `AGENTS.md` (core lead updates its package list at merge).

## Architecture (PR 1)

### 1. `@opscrew/contracts` (`packages/contracts/src/edge-provider.ts`)
- Export `EDGE_PROVIDER_CONTRACT_VERSION = 1`.
- Export `EdgeOriginAuth`, `EdgeOriginIpFiltering`, `EdgeProviderCapabilities`,
  `EdgeProviderCredentials`, `EdgeIpRanges`, `EdgeProviderConnector`, `EdgeProviderTerraform`,
  `EdgeProviderPricing`, `EdgeProviderTexts`, `EdgeProviderDefinition`.
- Re-export from `packages/contracts/src/index.ts`.

### 2. `@opscrew/edge-provider-cloudflare` (`packages/edge-providers/cloudflare/`)
- Wraps `@opscrew/connector-cloudflare` (`cloudflareConnector`, `CLOUDFLARE_TOKEN_PAGE`,
  `CLOUDFLARE_API`).
- Exports `definition: EdgeProviderDefinition` with:
  - `id: "cloudflare"`, `displayName: "Cloudflare"`, `name: "Cloudflare"`
  - `capabilities`: `dns: true`, `edge: true`, `apexCnameFlattening: true`,
    `originAuth: "cloudflare-aop"`, `originIpFiltering: "compact-cidrs"`,
    `realIpHeader: "CF-Connecting-IP"`, `cloudflareOnlyFeatures: true`
  - `credentials`: `CLOUDFLARE_API_TOKEN`, `mode: "any"`, `createUrl: CLOUDFLARE_TOKEN_PAGE`,
    `envPrefixes: ["CLOUDFLARE"]`, `apiPattern: /cloudflare/i`
  - `connector(deps)`: returns `EdgeProviderConnector` wrapping `cloudflareConnector`
    (`configured`, `verifyCredentials`, `fetchEdgeIpRanges` via Cloudflare `/ips`)
  - `terraform`: `cloudflare/cloudflare` `~> 5.0`, `dnsModuleName: "cloudflare-dns"`,
    `dnsRecordResourceType: "cloudflare_dns_record"`
  - `pricing` & `texts` matching existing Cloudflare phrasing.

### 3. `@opscrew/edge-providers` (`packages/edge-providers/registry/`)
- Mirrors `packages/providers/registry/`:
  - `validate.ts`: zod validation of `EdgeProviderDefinition` (contract version, credentials
    labels, capabilities invariants such as `dns: false` => `dnsModuleName` absent, non-empty
    `realIpHeader`, global token regexes, HTTPS URLs).
  - `index.ts`: exports `EDGE_PROVIDERS`, `DNS_PROVIDERS`, `EDGE_CREDENTIALS`, `edgeProvider(id)`,
    `dnsProvider(id)`, `validateEdgeProvider`.
  - `index.test.ts` & `validate.test.ts`: conformance tests across every built-in edge provider
    plus validation failure tests.
- Add `"packages/edge-providers/*"` to `pnpm-workspace.yaml`.

### 4. `@opscrew/plan-schema` (`packages/plan-schema/src/plan.ts`)
- Change `security.httpAllowedFrom` to `z.enum(["any", "edge"])` with a custom error map /
  preprocess check so `"cloudflare"` fails specifically with:
  `must be "any" or "edge" (renamed from "cloudflare"): set security.httpAllowedFrom to "edge"`.
- Update default in `DeployPlanSchema` transform: `plan.dns.proxied ? "edge" : "any"`.
- Update preview check (`checkPreviewDns`) and own-server direct-proxy check to require `"edge"`.
- Regenerate `packages/plan-schema/schemas/plan.schema.json`.

### 5. Consumers (`iac-templates`, `secops`, `agents`, `mcp-server`, `cli`)
- `@opscrew/iac-templates`:
  - Depend on `@opscrew/edge-providers`.
  - `src/predicates.ts`: `webOnlyFromEdge(plan)` (and keep `webOnlyFromCloudflare(plan)` delegating
    to it for Cloudflare plans) checking `plan.security.httpAllowedFrom === "edge"`.
  - `src/edge/index.ts`, `src/edge/nginx.ts`, `src/edge/openlitespeed.ts`: resolve real-IP header
    and edge display name from `edgeProvider("cloudflare")` (byte-identical output:
    `CF-Connecting-IP` and `Cloudflare`).
- `@opscrew/secops`, `@opscrew/agents`, `@opscrew/mcp-server`, `packages/cli`:
  - Update `httpAllowedFrom === "cloudflare"` / `httpAllowedFrom: "cloudflare"` to `"edge"`.
  - Keep rendered Terraform, Compose, Caddyfile, nginx.conf, OpenLiteSpeed conf, and workflow
    outputs byte-for-byte identical.

## Subsequent PRs (tracked in `tasks.md`)
- **PR 2:** `@opscrew/edge-provider-bunny` + `shared-header` server proxy gate + `opscrew rotate` support + `docs/guide/bunny.md`.
- **PR 3:** `@opscrew/edge-provider-gcore` + `docs/guide/gcore.md`.
- **PR 4:** `@opscrew/edge-provider-fastly` + `dns.edge` validation + `docs/guide/fastly.md`.
