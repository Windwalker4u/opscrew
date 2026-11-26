# Feature Specification: GitLab, Opening the Contract for Git Platforms (Feature 042)

**Feature:** `042-gitlab` | **Issue:** `#38` | **Status:** In Progress

## Overview

OpsCrew currently assumes every repository lives on GitHub (`@opscrew/connector-github`, `github-actions`, `ghcr`). Feature 042 introduces a versioned **git platform contract** (`GitPlatformDefinition`, mirroring ADR 0029 and Feature 036's edge-provider contract), moves GitHub behind it with zero behavior change for existing users, and adds **GitLab** (both `gitlab.com` and self-managed GitLab hosts) as the second git platform.

## Functional Requirements

### Contract & Registry (PR 1)

- **FR-4201 (Versioned contract):** `@opscrew/contracts` defines `GIT_PLATFORM_CONTRACT_VERSION = 1`, `GitPlatformDefinition`, `GitPlatformRemote`, `GitPlatformCredentials`, `GitPlatformCapabilities`, `GitPlatformTexts`, and `GitPlatformClient`. Only plain data, regular expressions, and functions cross the contract (ADR 0029 D2).
- **FR-4202 (Single registry):** `@opscrew/git-platforms` (`packages/git-platforms/registry`) is the single source of truth for registered git platforms (`GIT_PLATFORMS`, `gitPlatform(id)`, `detectGitPlatform(remoteUrl, env)`, `parseGitRemote(remoteUrl, env)`), validating every definition on load and running conformance tests over all registered platforms.
- **FR-4203 (GitHub behind the contract, zero regression):** `@opscrew/git-github` (`packages/git-platforms/github`) implements `GitPlatformDefinition` for GitHub (`id: "github"`, `cicdProvider: "github-actions"`, `registryId: "ghcr"`) wrapping `@opscrew/connector-github`. Every existing GitHub plan, workflow file, secret name, message, and test remains byte-for-byte unchanged.
- **FR-4204 (Token scanning via contract):** `opscrew scan` (`@opscrew/secops`) reads git-platform token rules from `@opscrew/git-platforms` while preserving existing GitHub rule IDs and evidence formatting.

### GitLab Platform Support (PR 2, stacked on PR 1)

- **FR-4205 (Remote detection for `gitlab.com` and self-managed hosts):** `opscrew init` and remote helpers detect GitLab from `origin` URLs on `gitlab.com` (HTTPS, SSH, SCP-like, including nested subgroups `group/sub/project`), or self-managed GitLab hosts (when host contains `gitlab`, matches `GITLAB_HOST`, or `OPSCREW_GIT_PLATFORM=gitlab`).
- **FR-4206 (GitLab REST API v4 adapter):** `@opscrew/git-gitlab` (`packages/git-platforms/gitlab`) implements `GitLabClient` and `GitPlatformDefinition` (`id: "gitlab"`, `cicdProvider: "gitlab-ci"`, `registryId: "gitlab-registry"`) covering:
  - project metadata & identity (`GET /projects/:id`, `GET /user`);
  - repository files & branches (`GET/POST/PUT/DELETE` repository files and branches);
  - merge requests (`GET/POST/PUT /projects/:id/merge_requests`);
  - deploy keys (`GET/POST/DELETE /projects/:id/deploy_keys`);
  - environments (`GET/POST/DELETE /projects/:id/environments`) and Free-tier-safe protected-environment capability probing;
  - CI/CD variables (`GET/POST/PUT/DELETE /projects/:id/variables`) with `environment_scope`, `protected`, `raw: true`, automatic `masked: true` for single-line maskable secrets and `variable_type: "file"` (`masked: false`) for multiline secrets (SSH private keys, `.env` blobs);
  - pipelines (`POST /projects/:id/pipeline`, `GET /projects/:id/pipelines`, `GET /projects/:id/pipelines/:id`, retry, jobs, artifacts);
  - container registry (`GET /projects/:id/registry/repositories`, tag listing & digest lookup, tag deletion, deploy token creation for read-only pulls);
  - project runners (`POST /user/runners` returning `glrt-` token, `GET /projects/:id/runners`, `DELETE /runners/:id`).
- **FR-4207 (Plan schema):** `packages/plan-schema` accepts `cicd.provider: "github-actions" | "gitlab-ci"` (default `"github-actions"`), `cicd.registry: "ghcr" | "gitlab-registry"` (default `"ghcr"`), optional `cicd.host` / `cicd.registryHost` for self-managed GitLab, and `.gitlab-ci.yml` as the default workflow path when `cicd.provider === "gitlab-ci"`.
- **FR-4208 (Deploy & preview pipelines — `.gitlab-ci.yml`):** `@opscrew/iac-templates` renders `.gitlab-ci.yml` for `cicd.provider: "gitlab-ci"`:
  - builds and pushes images to `$CI_REGISTRY_IMAGE` using `$CI_REGISTRY_USER` / `$CI_JOB_TOKEN` (no stored registry password required);
  - deploys to the target server over SSH using file-type `$DEPLOY_SSH_KEY` (never echoed/logged) or directly on a tagged self-hosted GitLab Runner (`tags: [opscrew-<app>-<env>]`), reusing OpsCrew's exact server-side rolling/recreate switch, rollback, and health checks;
  - supports per-MR previews (`$CI_MERGE_REQUEST_IID`, fork exclusion, `environment.on_stop`) invoking the same server-side `opscrew-preview` standing approval (ADR 0026).
- **FR-4209 (Self-hosted GitLab Runner on the user's server):** `@opscrew/connector-ssh-host` supports installing, registering (`glrt-` token passed only on stdin), and removing a pinned `gitlab-runner` under the `deploy` user's systemd user service (`opscrew-runner-<app>.service`), approved by host-plan hash (constitution I).
- **FR-4210 (Redaction, secret scanning & docs):** `glpat-`, `glrt-`, `gldt-`, `glptt-` tokens are redacted in `@opscrew/core`, generated by `fakeSecret()` in `@opscrew/core/testing`, scanned in `@opscrew/secops`, and documented in `docs/guide/gitlab.md` and `docs/guide/runners.md`.

## Non-Goals

- GitLab Pages as a static-site hosting target (stays out of 042 per roadmap & R9).
- Forgejo / Gitea (Feature 043, built next on top of this contract).
- Running live GitLab.com API / runner tests without credentials (all tests run deterministically against fakes; live test steps go in the PR description).
