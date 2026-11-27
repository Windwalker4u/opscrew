# Specification: Forgejo and Gitea (Feature 043)

**Feature:** `043-forgejo-gitea` | **Issue:** `#41` | **Depends on:** Feature `042-gitlab` (`@opscrew/git-platforms` contract)

## Overview

Add Forgejo (including Codeberg and self-hosted Forgejo instances) and Gitea (including `gitea.com` and self-hosted Gitea instances) as first-class git platforms through Feature 042's `GitPlatformDefinition` contract (`GIT_PLATFORM_CONTRACT_VERSION = 1`). No code outside the platform package branches on `"forgejo"` or `"gitea"`.

## User Stories

### US1 — Detect and Authenticate Forgejo & Gitea Remotes
- `opscrew init` detects `codeberg.org`, `gitea.com`, hosts containing `forgejo` or `gitea`, custom `FORGEJO_HOST` / `GITEA_HOST` hosts, and `OPSCREW_GIT_PLATFORM=forgejo|gitea` remotes automatically from `origin`.
- Resolves tokens from `FORGEJO_TOKEN` / `GITEA_TOKEN` (never printing or logging tokens; always redacting them).
- Verifies credentials against `/api/v1/user` and prints plain-English next steps when missing or invalid.

### US2 — Manage Repositories, PRs, Deploy Keys, Secrets, Variables, Runs, Runners, and Images
- Implements every method of `GitPlatformClient` against Forgejo's and Gitea's `/api/v1` REST APIs (plus OCI v2 digest lookup on `<host>/v2/<owner>/<image>/manifests/<tag>`):
  - `whoAmI`, `getRepo`, `fileText`
  - `findOpenChangeRequest`, `createChangeRequest`, `updateChangeRequest`
  - `listDeployKeys`, `addDeployKey`, `removeDeployKey`
  - `environmentCapability` (reports `available: false` cleanly so OpsCrew uses repository-scoped prefixed secrets), `ensureEnvironment`, `deleteEnvironment`
  - `setSecret`, `secretExists`, `deleteSecret` (`/actions/secrets`)
  - `getVariable`, `setVariable`, `deleteVariable` (`/actions/variables`)
  - `triggerPipeline` (`POST /actions/workflows/{workflow}/dispatches` — Forgejo `return_run_info` body vs Gitea `return_run_details` query), `listPipelineRuns` (`/actions/runs` with `/actions/tasks` fallback), `getPipelineRun`, `retryPipelineRun`
  - `listRunners`, `createRunnerToken` (`GET` on Forgejo vs `POST` on Gitea), `deleteRunner`
  - `taggedDigest` (OCI Distribution v2 `HEAD` manifest with Bearer challenge fallback)

### US3 — Render Forgejo & Gitea Deploy Workflows from GitHub's Template
- `plan.cicd.provider` accepts `"forgejo-actions"` and `"gitea-actions"`; `plan.cicd.registry` accepts `"forgejo-registry"` and `"gitea-registry"`.
- Default workflow path resolves to `.forgejo/workflows/opscrew-deploy[-<key>][-<env>].yml` (Forgejo) and `.gitea/workflows/opscrew-deploy[-<key>][-<env>].yml` (Gitea).
- `renderWorkflow()` reuses GitHub's deploy workflow template with ONLY the documented differences from `research.md`:
  1. Native workflow path (`.forgejo/workflows/` or `.gitea/workflows/`);
  2. Registry host `<cicd.registryHost ?? cicd.host ?? defaultHost>` instead of `ghcr.io` for Docker login, image build/push, digest regex checks, and labeling, authenticating with `${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}`;
  3. No `environment:` block on deploy jobs (neither Forgejo nor Gitea supports deployment environments; secrets are always prefixed at repository scope);
  4. `runs-on:` uses `<runnerLabel>` (single label) for self-hosted runners and `ubuntu-latest` for docker-mode runners (never GitHub-only `ubuntu-24.04-arm` or `[self-hosted, ...]`).
- Verified with snapshot tests covering both Forgejo and Gitea (default runner + self-hosted runner + custom self-hosted domain).

### US4 — Self-Hosted `forgejo-runner` and `act_runner` Support & User Docs
- `@opscrew/connector-ssh-host` provides systemd user units and stdin-token install/register scripts for `forgejo-runner` and `act_runner` (matching `runner-unit.ts`'s `sg docker`, `KillMode=control-group`, and SHA-256 verification pattern; registration token passed exclusively via stdin, never in argv/logs/plans).
- User guide pages `docs/guide/forgejo.md` and `docs/guide/gitea.md`, plus Forgejo/Gitea sections in `docs/guide/runners.md`.

## Non-Goals / Constraints
- Live tests against a paid/real Codeberg/Forgejo/Gitea account are not run locally; all automated tests use injected fake `fetch` and `CommandRunner` fixtures. A clear live-verification checklist is documented in the PR description and guides.
- No secret-shaped literals in code or tests (use `fakeSecret()` from `@opscrew/core/testing`).
- No new external npm dependencies.
