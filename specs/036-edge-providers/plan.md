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

PR 1 carries only what currently has a reader plus the origin-protection fields decided on `#29`
(`originAuth`, `originIpFiltering`, `realIpHeader`, `displayName`, `texts.secops.*`, and
`terraform.dnsRecordResourceType`). Remaining contract fields (`name`, URLs, `apexCnameFlattening`,
`credentials`, Terraform provider/module metadata, `texts.interview`/`design`/`runbook`,
`DNS_PROVIDERS`, `dnsProvider`, `EDGE_CREDENTIALS`, and connector methods) join in PRs 2–4 alongside
their first reader.

### 1. `@opscrew/contracts` (`packages/contracts/src/edge-provider.ts`)
- Export `EDGE_PROVIDER_CONTRACT_VERSION = 1`.
- Export `EdgeOriginAuth`, `EdgeOriginIpFiltering`, `EdgeProviderCapabilities`,
  `EdgeProviderTerraform`, `EdgeProviderTexts`, `EdgeProviderDefinition`.
- Re-export from `packages/contracts/src/index.ts`.

### 2. `@opscrew/edge-provider-cloudflare` (`packages/edge-providers/cloudflare/`)
- Exports `definition: EdgeProviderDefinition` with:
  - `id: "cloudflare"`, `displayName: "Cloudflare"`
  - `capabilities`: `originAuth: "cloudflare-aop"`, `originIpFiltering: "compact-cidrs"`,
    `realIpHeader: "CF-Connecting-IP"`
  - `terraform`: `dnsRecordResourceType: "cloudflare_dns_record"`
  - `texts.secops`: `edgeLabel`, `edgeTlsHint` matching existing Cloudflare phrasing.

### 3. `@opscrew/edge-providers` (`packages/edge-providers/registry/`)
- Mirrors `packages/providers/registry/`:
  - `validate.ts`: zod validation of `EdgeProviderDefinition` (contract version, `dynamic-ips` =>
    `shared-header` invariant, valid `realIpHeader` name, SecOps texts).
  - `index.ts`: exports `EDGE_PROVIDERS`, `edgeProvider(id)`, `validateEdgeProvider`.
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
    and edge display name from `edgeProvider("cloudflare")` in PR 1 (byte-identical output:
    `CF-Connecting-IP` and `Cloudflare`). **PR 2 threads the app's active edge provider through
    from callers that hold the plan**, replacing these PR 1 `"cloudflare"` lookups (and the one in
    `packages/secops/src/deep/testssl.ts`).
- `@opscrew/secops`:
  - `src/policies/plan.ts`: reads `edgeProvider(deployPlan.dns.provider).terraform.dnsRecordResourceType`.
  - `src/deep/testssl.ts`: reads `edgeProvider("cloudflare").texts.secops.*` in PR 1 (threaded from
    the plan in PR 2).
- `@opscrew/agents`, `@opscrew/mcp-server`, `packages/cli`:
  - Update `httpAllowedFrom === "cloudflare"` / `httpAllowedFrom: "cloudflare"` to `"edge"`.
  - Keep rendered Terraform, Compose, Caddyfile, nginx.conf, OpenLiteSpeed conf, and workflow
    outputs byte-for-byte identical.

## Subsequent PRs (tracked in `tasks.md`)
- **PR 2:** `@opscrew/edge-provider-bunny` + `shared-header` server proxy gate + `opscrew rotate` support + `docs/guide/bunny.md`.
- **PR 3:** `@opscrew/edge-provider-gcore` + `docs/guide/gcore.md`.
- **PR 4:** `@opscrew/edge-provider-fastly` + `dns.edge` validation + `docs/guide/fastly.md`.
