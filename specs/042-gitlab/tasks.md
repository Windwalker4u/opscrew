# Tasks: GitLab, Opening the Contract for Git Platforms (Feature 042)

**Feature:** `042-gitlab` | **Issue:** `#38` | **Plan:** [plan.md](plan.md)

## Wave 1 — PR 1 (`042-git-platforms`): Contract + GitHub behind it

- [x] **T4201 — Research & Spec Kit artefacts**
  - Owns: `specs/042-gitlab/{research.md,spec.md,plan.md,tasks.md}`
  - Accept: Official `docs.gitlab.com` sources only; all shared-file changes recorded in `plan.md`.

- [ ] **T4202 — Git platform contract in `@opscrew/contracts`**
  - Owns: `packages/contracts/src/git-platform.ts`, `packages/contracts/src/index.ts`
  - Accept: FR-4201 (`GIT_PLATFORM_CONTRACT_VERSION = 1`, plain-data + function interfaces, no zod/class instances).

- [ ] **T4203 — `@opscrew/git-github` definition & adapter**
  - Owns: `packages/git-platforms/github/**`
  - Accept: FR-4203 (`definition: GitPlatformDefinition`, `GitHubPlatformClient` adapting `GitHubClient` to `GitPlatformClient`, unit tests).

- [ ] **T4204 — `@opscrew/git-platforms` registry, validator & conformance tests**
  - Owns: `packages/git-platforms/registry/**`, `pnpm-workspace.yaml`
  - Accept: FR-4202 (`GIT_PLATFORMS`, `gitPlatform`, `detectGitPlatform`, `parseGitRemote`, `validateGitPlatform`, conformance tests).

- [ ] **T4205 — Wire `@opscrew/git-platforms` into `@opscrew/agents` and `@opscrew/secops` (zero regression)**
  - Owns: `packages/agents/src/shared/git-platform.ts`, `packages/agents/src/init/checks.ts`, `packages/secops/src/**`
  - Accept: FR-4203, FR-4204; all existing GitHub tests and snapshots pass unchanged.

- [ ] **T4206 — Verify, commit, push, and open PR 1**
  - Accept: `pnpm format`, `pnpm lint`, `pnpm typecheck`, affected tests, and CLI build pass; PR 1 opened into `main`.

## Wave 2 — PR 2 (`042-gitlab`, stacked on PR 1): GitLab platform

- [ ] **T4207 — GitLab token redaction, `fakeSecret`, and `plan-schema` extensions**
  - Owns: `packages/core/src/**`, `packages/plan-schema/src/**`, `packages/plan-schema/plan.schema.json`
  - Accept: FR-4207, FR-4210 (`gitlab-ci`, `gitlab-registry`, `cicd.host`, `cicd.registryHost`, `glpat-`/`glrt-`/`gldt-` redaction & fake secrets).

- [ ] **T4208 — `@opscrew/git-gitlab` REST v4 client, remote parser & platform definition**
  - Owns: `packages/git-platforms/gitlab/**`, `packages/git-platforms/registry/**`
  - Accept: FR-4205, FR-4206 (full REST v4 client, Free-tier capability handling, smart secret masking/`variable_type: "file"`, nested subgroups + self-managed hosts, registered in `GIT_PLATFORMS`, conformance tests pass).

- [ ] **T4209 — `.gitlab-ci.yml` deploy & MR preview templates (`@opscrew/iac-templates`)**
  - Owns: `packages/iac-templates/src/workflow/{gitlab,gitlab-preview}.ts`, `packages/iac-templates/src/workflow/index.ts`, `packages/iac-templates/src/pins.ts`
  - Accept: FR-4208 (deploy pipeline, rolling/recreate/rollback, `$CI_REGISTRY_IMAGE`, `$DEPLOY_SSH_KEY` file handling, tagged server runner, MR preview with `on_stop` & ADR 0026 `opscrew-preview`, unit tests).

- [ ] **T4210 — GitLab Runner host support (`@opscrew/connector-ssh-host`) & agent wiring (`@opscrew/agents`)**
  - Owns: `packages/connectors/ssh-host/src/**`, `packages/agents/src/**`
  - Accept: FR-4205, FR-4209 (`opscrew init` detects GitLab `.com` and self-managed hosts & checks `GITLAB_TOKEN`/`GL_TOKEN`/`glab`; host runner unit & script support for `gitlab-runner` with stdin `glrt-` token).

- [ ] **T4211 — User documentation (`docs/guide/gitlab.md`, `docs/guide/runners.md`) & PR 2 verification**
  - Owns: `docs/guide/gitlab.md`, `docs/guide/runners.md`, `specs/042-gitlab/tasks.md`
  - Accept: FR-4210; `pnpm format`, `pnpm lint`, `pnpm typecheck`, all affected tests, and CLI build pass; PR 2 opened stacked on PR 1.
