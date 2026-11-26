# ADR 0038: One package per DNS and edge provider, behind a versioned contract

**Status**: Accepted (2026-11-26, feature 036; approved by the core's lead in issue #29).

## Context

Until feature 036, Cloudflare was OpsCrew's only DNS and edge proxy provider. Its facts — its
credential variables, token rules, real-visitor-IP header (`CF-Connecting-IP`), origin-protection
model (compact CIDR firewall + Origin CA + per-hostname Authenticated Origin Pulls), Terraform
provider, and wording — were written directly into `@opscrew/plan-schema`,
`@opscrew/iac-templates`, `@opscrew/secops`, and `@opscrew/agents`.

Feature 036 adds three more edge providers: **Bunny.net** (DNS + edge), **Gcore** (DNS + edge),
and **Fastly** (edge only, in front of DNS hosted elsewhere). Following 026's rule (a contract
when the second implementation arrives, mirroring ADR 0029 for cloud server providers), we
introduce the edge and DNS provider contract with Cloudflare moved behind it first, designed with
all four providers in view so the contract is never shaped by one.

## Decision

- **D1: one package per DNS/edge provider exporting one definition.** The definition is
  `EdgeProviderDefinition` in `@opscrew/contracts` (`edge-provider.ts`),
  `EDGE_PROVIDER_CONTRACT_VERSION = 1`. Fields are added with their first reader:
  - PR 1 carries its identity (`id`, `displayName`), origin protection and real-IP capabilities
    (`originAuth`, `originIpFiltering`, `realIpHeader`), DNS record resource type
    (`terraform.dnsRecordResourceType`), and SecOps texts (`texts.secops.*`);
  - PRs 2–4 add credentials, connectors, Terraform provider/module metadata, DNS provider listing
    (`DNS_PROVIDERS`, `dnsProvider`, `EDGE_CREDENTIALS`), and interview/design/runbook texts as
    each reader lands.
- **D2: only plain data, regular expressions, and functions cross the contract.** Matching ADR
  0029 D2, no zod schema or class instance crosses the boundary, and a provider package imports
  only `@opscrew/contracts` and `@opscrew/core` (plus its own connector package when wired).
- **D3: one registry, `@opscrew/edge-providers`, is the single place consumers read edge facts
  from.** It lists the built-in definitions in order (`EDGE_PROVIDERS`), validates each definition
  at load (`validateEdgeProvider`), exports `edgeProvider(id)`, and runs a conformance test over
  every built-in provider. No other code branches on an edge provider's id for generic DNS/edge
  behaviour.
- **D4: package layout mirrors `packages/providers/*`.**
  - `packages/edge-providers/<id>` as `@opscrew/edge-provider-<id>` (starting with
    `@opscrew/edge-provider-cloudflare`, followed by `bunny`, `gcore`, and `fastly`).
  - `packages/edge-providers/registry` as `@opscrew/edge-providers`.
  - `@opscrew/edge-provider-cloudflare` wraps `@opscrew/connector-cloudflare`. Cloudflare-only
    features (Tunnel, Access, Workers hosting, R2, Workers uptime check, Registrar, Previews
    wildcard, and Cloudflare account move) stay Cloudflare-specific and are clearly stated in
    design.
- **D5: DNS host and edge proxy are separate in `opscrew/plan.yaml`, with one way to say each
  thing.**
  - `dns.provider` names the DNS host (`"cloudflare" | "none"` in PR 1; later `"cloudflare" |
    "bunny" | "gcore" | "none"`).
  - `dns.edge` (added with the first non-Cloudflare edge provider) is optional
    `"bunny" | "gcore" | "fastly"` with no `"cloudflare"` value: when absent and `proxied: true`,
    the edge is the DNS host's own proxy (keeping every existing Cloudflare plan unchanged).
    `dns.edge` without `proxied: true` is refused, and `dns.edge: "fastly"` with
    `dns.provider: "none"` is refused.
  - `security.httpAllowedFrom` is `"any" | "edge"` (renamed from `"cloudflare"`, with no alias
    pre-1.0; plans naming `"cloudflare"` are refused with a one-line fix: `set
    security.httpAllowedFrom to "edge"`). Rendered infrastructure and proxy output stays
    byte-for-byte identical for Cloudflare users.
- **D6: origin protection and secret hygiene.**
  - `originAuth`: `"cloudflare-aop" | "mtls-client-cert" | "shared-header"`.
  - `originIpFiltering`: `"compact-cidrs" | "dynamic-ips"`.
  - Secrets used to authenticate edge-to-origin traffic (origin mTLS private keys, shared origin
    header tokens) **never** land in Terraform/OpenTofu state or the repository. Where a
    provider's Terraform resource would persist a secret header or client key in state (Bunny's
    `bunnynet_pullzone_edgerule`, Gcore's `gcore_cdn_resource.options.static_request_headers`,
    Fastly's `fastly_service_vcl.backend.ssl_client_key`), OpsCrew sets that secret through a
    typed connector call after apply, approved by its plan hash like every other change.
  - Shared origin-header tokens are rotatable via `opscrew rotate` (edge updated first while the
    server's reverse proxy accepts both old and new values, then narrowed to the new value).
  - On `shared-header` edges, the server's reverse proxy (Caddy, nginx, OpenLiteSpeed) rejects
    requests missing the exact header before `kamal-proxy` and before trusting `realIpHeader`.
    Because `dynamic-ips` leaves cloud firewall ports 80/443 open, the header is the gate; the
    guide states this plainly beside Cloudflare's and Fastly's mTLS + CIDR firewall.

## Consequences

- PR 1 moves Cloudflare behind `@opscrew/edge-provider-cloudflare` and `@opscrew/edge-providers`
  and renames `security.httpAllowedFrom` to `"edge"`, while keeping every rendered file for
  Cloudflare users byte-for-byte identical.
- Adding Bunny.net, Gcore, and Fastly becomes one package per provider, one line in the registry,
  plan-schema enum additions, and provider-specific docs, with conformance tests guarding every
  invariant at load time.
