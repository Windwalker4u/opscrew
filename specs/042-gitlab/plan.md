# Implementation Plan: GitLab, Opening the Contract for Git Platforms (Feature 042)

**Feature:** `042-gitlab` | **Issue:** `#38` | **Strategy:** 2 stacked PRs

## Architectural Decisions

1. **Contract pattern (mirrors ADR 0029 & Feature 036):**
   - `packages/contracts/src/git-platform.ts` exports `GIT_PLATFORM_CONTRACT_VERSION = 1` and plain TypeScript interfaces (`GitPlatformDefinition`, `GitPlatformRemote`, `GitPlatformCredentials`, `GitPlatformCapabilities`, `GitPlatformTexts`, `GitPlatformClient`, `GitPlatformConnector`, `GitPlatformConnectorDeps`). No zod schemas or class instances cross the contract.
   - Packages live under `packages/git-platforms/*`:
     - `packages/git-platforms/github` (`@opscrew/git-github`)
     - `packages/git-platforms/gitlab` (`@opscrew/git-gitlab`) — added in PR 2
     - `packages/git-platforms/registry` (`@opscrew/git-platforms`)
   - Dependencies flow strictly one way:
     - `@opscrew/git-<id>` -> `@opscrew/contracts`, `@opscrew/core` (and `@opscrew/git-github` wraps `@opscrew/connector-github`)
     - `@opscrew/git-platforms` -> `@opscrew/contracts`, `@opscrew/core`, `@opscrew/git-*`
     - Consumers (`@opscrew/agents`, `@opscrew/iac-templates`, `@opscrew/secops`, `opscrew`) -> `@opscrew/git-platforms`
   - Existing `@opscrew/connector-github` exports remain intact so every existing GitHub caller and test continues working without churn; new multi-platform callers go through `@opscrew/git-platforms`.

2. **Secret storage on GitLab (`variable_type` + `masked` + `raw`):**
   - Because GitLab rejects `masked: true` on multiline values, values containing whitespace/newlines, or values shorter than 8 characters (R2), `GitLabClient.setSecret` automatically selects:
     - `variable_type: "file", masked: false, raw: true` when the value contains `\n` or `\r` (ensuring a trailing `\n` for SSH keys and `.env` files);
     - `variable_type: "env_var", masked: true, raw: true` when the value matches GitLab's masking rules (`length >= 8`, no whitespace, valid masking characters);
     - `variable_type: "env_var", masked: false, raw: true` otherwise (never failing with 400 on short non-secret config values like port numbers or hostnames).
   - Every secret variable sets `protected` according to whether the target environment/branch is protected, and `environment_scope` to the environment name (or `*` for project-wide variables).

3. **Self-managed GitLab host detection:**
   - `parseGitLabRepo(url, env)` matches:
     - Any SSH/SCP/HTTPS URL on `gitlab.com` (including arbitrary nested subgroups like `org/team/sub/app`);
     - Any URL whose host matches `env.GITLAB_HOST` (stripped of scheme/trailing slash);
     - Any URL whose hostname contains `gitlab` (e.g. `gitlab.company.internal`);
     - Any valid git remote URL when `env.OPSCREW_GIT_PLATFORM === "gitlab"`.
   - `detectGitPlatform(remoteUrl, env)` checks every registered platform's `parseRemote(remoteUrl, env)` in registry order (GitHub, GitLab), honoring an explicit `OPSCREW_GIT_PLATFORM` override first.

4. **Shared file changes (recorded per `#38` for lead approval at review):**
   - **PR 1 (`042-git-platforms`):**
     - `pnpm-workspace.yaml`: add `- "packages/git-platforms/*"`.
     - `pnpm-lock.yaml`: lockfile update for the two workspace packages `@opscrew/git-github` and `@opscrew/git-platforms` (zero new external npm dependencies).
     - `packages/contracts/src/git-platform.ts` and `packages/contracts/src/index.ts`: add `GIT_PLATFORM_CONTRACT_VERSION` and git platform contract interfaces.
     - `packages/secops/package.json` & `packages/agents/package.json`: add `"@opscrew/git-platforms": "workspace:*"`.
   - **PR 2 (`042-gitlab`, stacked on PR 1):**
     - `pnpm-lock.yaml`: lockfile update for workspace package `@opscrew/git-gitlab` (zero new external npm dependencies).
     - `packages/plan-schema/src/plan.ts`, `packages/plan-schema/src/apps.ts`, `packages/plan-schema/src/index.ts`, `packages/plan-schema/plan.schema.json`: add `"gitlab-ci"` to `cicd.provider`, `"gitlab-registry"` to `cicd.registry`, optional `cicd.host` and `cicd.registryHost`, and platform-aware workflow/image helpers.
     - `packages/core/src/testing/fake-secrets.ts` & `packages/core/src/redaction.ts`: add `gitlab-token`, `gitlab-runner-token`, `gitlab-deploy-token` fake-secret kinds and redaction patterns.
     - `packages/iac-templates/package.json`: add `"@opscrew/git-platforms": "workspace:*"` if needed.

## Stacked PR Breakdown

### PR 1 — `042-git-platforms`: Git platform contract + GitHub behind it
1. Add `packages/contracts/src/git-platform.ts` and export from `@opscrew/contracts`.
2. Add `packages/git-platforms/github` (`@opscrew/git-github`) exporting `definition: GitPlatformDefinition` wrapping `@opscrew/connector-github`.
3. Add `packages/git-platforms/registry` (`@opscrew/git-platforms`) with `GIT_PLATFORMS`, `gitPlatform`, `detectGitPlatform`, `parseGitRemote`, `validateGitPlatform`, and conformance tests.
4. Wire `@opscrew/git-platforms` into `@opscrew/agents` (`src/shared/git-platform.ts`, `src/init/checks.ts`) and `@opscrew/secops` (`src/rules/secrets.ts` token rules) with byte-for-byte unchanged GitHub behavior.
5. Verify `pnpm format`, `pnpm lint`, `pnpm typecheck`, affected tests, and CLI build; open PR 1.

### PR 2 — `042-gitlab` (stacked on PR 1): GitLab platform support
1. Extend `@opscrew/core` (redaction + `fakeSecret` for `glpat-`, `glrt-`, `gldt-`) and `@opscrew/plan-schema` (`gitlab-ci`, `gitlab-registry`, `cicd.host`, `cicd.registryHost`, `plan.schema.json`).
2. Build `packages/git-platforms/gitlab` (`@opscrew/git-gitlab`) with full `GitLabClient` (REST v4), `parseGitLabRepo`, `resolveGitLabToken`, `gitlabConnector`, `definition: GitPlatformDefinition`, and comprehensive unit tests against fake fetch.
3. Register `gitlab` in `@opscrew/git-platforms` (`GIT_PLATFORMS = [github, gitlab]`) and verify conformance + `plan-schema` enum parity tests pass.
4. Add `.gitlab-ci.yml` deploy & MR-preview pipeline rendering in `@opscrew/iac-templates` (`src/workflow/gitlab.ts`, `src/workflow/gitlab-preview.ts`) and dispatch cleanly in `renderWorkflow`.
5. Add GitLab Runner pin + host setup/teardown support in `@opscrew/iac-templates` (`pins.ts`) and `@opscrew/connector-ssh-host` (`runner-unit.ts` / `gitlab-runner` helper).
6. Wire GitLab into `@opscrew/agents` (`init` remote & token detection for `gitlab.com` and self-managed hosts, `shared/git-platform.ts`, `runners`, `provision` secret/pipeline dispatch).
7. Add `docs/guide/gitlab.md` and update `docs/guide/runners.md`.
8. Verify `pnpm format`, `pnpm lint`, `pnpm typecheck`, all affected test suites, and CLI build; open PR 2.
