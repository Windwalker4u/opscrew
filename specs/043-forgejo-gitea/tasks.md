# Tasks: Forgejo and Gitea (Feature 043)

**Feature:** `043-forgejo-gitea` | **Issue:** `#41`

## Phase 1 — Research & Spec
- [x] T4301 Research official Forgejo & Gitea docs and live OpenAPI v1 specs (`research.md`)
- [x] T4302 Write specification (`spec.md`), plan (`plan.md`), and task breakdown (`tasks.md`)

## Phase 2 — Schema & Core Helpers
- [x] T4303 Add `forgejo-token` and `gitea-token` kinds to `@opscrew/core/testing` (`fake-secrets.ts`)
- [x] T4304 Extend `@opscrew/plan-schema` (`cicd.provider`: `"forgejo-actions" | "gitea-actions"`, `cicd.registry`: `"forgejo-registry" | "gitea-registry"`, `workflowPathFor`, `plan.schema.json`) with tests

## Phase 3 — Shared Forgejo & Gitea Connector Package
- [x] T4305 Create `packages/git-platforms/forgejo-gitea` (`@opscrew/git-forgejo-gitea`):
  - `src/remote.ts`: `parseForgejoRepo`, `parseGiteaRepo` (Codeberg, `gitea.com`, `*forgejo*`/`*gitea*`, `FORGEJO_HOST`/`GITEA_HOST`, `OPSCREW_GIT_PLATFORM`)
  - `src/client.ts`: shared `ForgejoGiteaClient` (`flavor: "forgejo" | "gitea"`) covering all `GitPlatformClient` methods + OCI v2 digest lookup
  - `src/index.ts`: `forgejoDefinition`, `giteaDefinition`, token resolvers (`FORGEJO_TOKEN`, `GITEA_TOKEN`), connectors
  - `src/index.test.ts`: comprehensive test suite covering both flavors, protocol differences (`GET` vs `POST` registration-token, dispatch run info, run normalization, `/actions/tasks` fallback, OCI Bearer challenge, secret/variable CRUD, deploy keys, PRs)
- [x] T4306 Register `forgejo` and `gitea` in `@opscrew/git-platforms` (`GIT_PLATFORMS`) and verify conformance tests

## Phase 4 — Workflows, Runners, Init & Docs
- [x] T4307 Adapt `@opscrew/iac-templates` workflow renderer for `forgejo-actions` and `gitea-actions` (GitHub's template + documented differences only) with snapshot tests (`forgejo-gitea.test.ts`) while keeping GitHub snapshots byte-for-byte unchanged
- [x] T4308 Add `forgejo-runner` and `act_runner` systemd user units & stdin-token install scripts in `@opscrew/connector-ssh-host` with unit tests
- [x] T4309 Add `opscrew init` remote & token verification tests for Forgejo (Codeberg + self-hosted) and Gitea (`gitea.com` + self-hosted) in `@opscrew/agents`
- [x] T4310 Add user documentation `docs/guide/forgejo.md`, `docs/guide/gitea.md`, and update `docs/guide/runners.md`

## Phase 5 — Verification & PR
- [x] T4311 Run `pnpm install --offline`, `pnpm format`, `pnpm lint`, `pnpm typecheck`, all affected test suites, and CLI build; commit, push to `fork/043-forgejo-gitea`, and open PR referencing `#41`
