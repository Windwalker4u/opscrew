# ADR 0003: Apache-2.0 for the whole repository

- Status: accepted (2026-10-11); amended 2026-11-14: `ee/` retired, the whole repository is
  Apache-2.0

## Context

OpsCrew is open source to earn trust (it holds the keys to users' infrastructure) and to spread
through the developer community; a hosted control plane funds it. Comparables: Dokploy (Apache +
directory-scoped source-available), Cal.com (AGPL, went closed in 2026), HashiCorp (relicensed,
forked as OpenTofu), Sentry (FSL).

## Decision

The whole repository is Apache-2.0. Public commitment: anything primarily useful to an individual
developer stays free.

The `ee/` directory, first reserved for team and enterprise features under the Functional Source
License 1.1 with an Apache-2.0 future license, is retired (founder, 2026-11-14): those features
won't be built in this repository, `ee/` never held code, and the repository has no
source-available part.

## Consequences

- No AGPL or non-commercial dependency may be linked into the CLI (optional external binaries only).
- Contributors need no CLA: every contribution is Apache-2.0.
