# ADR 0039: One package per git hosting and CI/CD platform, behind a versioned contract

**Status**: Proposed (2026-11-26, feature 042; scope shaped by the core's lead in #39).

## Context

Until feature 042, GitHub was OpsCrew's only git hosting and CI/CD platform. Its facts — its
credential environment variables (`GITHUB_TOKEN`, `GH_TOKEN`), its token scanning rules in
`@opscrew/secops`, its remote URL parsing, and its `opscrew init` wording — were written directly
into `@opscrew/secops` and `@opscrew/agents`.

Feature 042 adds **GitLab** (GitLab.com and self-managed GitLab), and feature 043 follows with
**Forgejo** and **Gitea**. Following 026's rule (a contract when the second implementation arrives,
mirroring ADR 0029 for cloud server providers and ADR 0038 for edge providers), we introduce a
versioned git platform contract and registry first, with GitHub registered behind it, keeping PR 1
strictly scoped to the fields that have live readers today.

## Decision

- **D1: one package per git platform exporting one definition, with fields added alongside their
  first reader.** The definition is `GitPlatformDefinition` in `@opscrew/contracts`
  (`git-platform.ts`), `GIT_PLATFORM_CONTRACT_VERSION = 1`.
  - PR 1 carries only the fields read today: identity (`id`, `displayName`), credentials
    (`credentials.envVars`, `credentials.tokenRules`), `texts.remoteFixHint`, and `parseRemote`.
  - PR 2 (GitLab) adds the typed platform client, connector factory, token resolver, container
    image helper, `OPSCREW_GIT_PLATFORM` override, capability/CI metadata, and platform wording
    together with the callers in `@opscrew/agents` and `@opscrew/iac-templates` that read them.
- **D2: only plain data, regular expressions, and functions cross the contract.** Matching ADR
  0029 D2 and ADR 0038 D2, no zod schema or class instance crosses the boundary.
- **D3: one registry, `@opscrew/git-platforms`, is the single place consumers read git platform
  facts from.** It lists the built-in definitions in order (`GIT_PLATFORMS`), validates each
  definition at load (`validateGitPlatform`), exports `gitPlatform(id)` and `detectGitPlatform`,
  and guards every invariant with unit and conformance tests. No code outside the registry branches
  on a git platform's id for generic git-platform behaviour.
- **D4: package layout mirrors `packages/providers/*` and `packages/edge-providers/*`.**
  - `packages/git-platforms/<id>` as `@opscrew/git-<id>` (starting with `@opscrew/git-github`,
    followed by `gitlab` in PR 2 and `forgejo-gitea` in 043).
  - `packages/git-platforms/registry` as `@opscrew/git-platforms`.
- **D5: `@opscrew/git-github` wraps `@opscrew/connector-github` on purpose.** Unlike ADR 0029's D2
  and D6 (where each cloud server provider owns its connector directly inside its provider package),
  `@opscrew/git-github` imports and wraps the existing `@opscrew/connector-github` package. The
  core's lead accepted this difference to keep PR 1 small and avoid churning the existing
  `@opscrew/connector-github` callers before PR 2 moves them behind the unified client.

## Consequences

- PR 1 keeps every output for GitHub users unchanged — identical `opscrew init` wording, redactor
  registration, SecOps token rules, and workflow snapshots — while removing duplicated GitHub facts
  from `@opscrew/secops` and `init/checks.ts`.
- PR 2 (GitLab) and feature 043 (Forgejo / Gitea) extend `GitPlatformDefinition` only with fields
  and client methods backed by real callers and `fakeFetch` tests, one package per platform and one
  line in `@opscrew/git-platforms`.
