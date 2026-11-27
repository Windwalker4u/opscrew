# Implementation Plan: Forgejo and Gitea (Feature 043)

**Feature:** `043-forgejo-gitea` | **Issue:** `#41` | **Stacked on:** `042-gitlab` (PR #40)

## Architectural Decisions

1. **One connector engine, two registered definitions (`@opscrew/git-forgejo-gitea`):**
   - Live OpenAPI v1 verification (`codeberg.org` Forgejo `17.0.0` vs `gitea.com` Gitea `29.0.0+dev`, `research.md` R1 & R5) confirmed that ~90% of endpoints match, with 4 concrete differences:
     1. Runner registration token HTTP method (`GET` on Forgejo vs `POST` on Gitea);
     2. Workflow dispatch run-info parameter (`return_run_info: true` in body on Forgejo vs `?return_run_details=true` query on Gitea);
     3. Run object fields & filter param (`prettyref`/`commit_sha`/`created` + `?ref=` on Forgejo vs `head_branch`/`head_sha`/`created_at`/`conclusion` + `?branch=` on Gitea);
     4. Platform identity, default host, workflow folder, env vars, and runner binary (`forgejo` / `codeberg.org` / `.forgejo/workflows/` / `FORGEJO_TOKEN` / `forgejo-runner` vs `gitea` / `gitea.com` / `.gitea/workflows/` / `GITEA_TOKEN` / `act_runner`).
   - Package `packages/git-platforms/forgejo-gitea` (`@opscrew/git-forgejo-gitea`) houses ONE typed client (`ForgejoGiteaClient`, parameterized by `flavor: "forgejo" | "gitea"`) and exports both `forgejoDefinition` (`id: "forgejo"`) and `giteaDefinition` (`id: "gitea"`).
   - `@opscrew/git-platforms` registers `[github, gitlab, forgejo, gitea]` and validates all four against `validateGitPlatform`.

2. **Workflow rendering — reuse GitHub's template with minimal documented deltas:**
   - Rather than duplicating `packages/iac-templates/src/workflow/index.ts`, introduce a focused post-adaptation / parameterization helper `packages/iac-templates/src/workflow/forgejo-gitea.ts` (and make `githubEnvironment`, `buildRunner`, `deployJob`, `GHCR_LOGIN` / registry host cleanly aware of `forgejo-actions` and `gitea-actions` via small helper predicates, without breaking a single byte of existing GitHub Actions snapshots!).
   - Specifically:
     - `isForgejoOrGitea(plan)`: `plan.cicd.provider === "forgejo-actions" || plan.cicd.provider === "gitea-actions"`.
     - `workflowPathFor(app, env, provider)` supports `"github-actions"`, `"gitlab-ci"`, `"forgejo-actions"` (`.forgejo/workflows/...`), `"gitea-actions"` (`.gitea/workflows/...`).
     - `registryHostFor(plan)`: returns `plan.cicd.registryHost ?? plan.cicd.host ?? defaultHost` for Forgejo (`codeberg.org`) and Gitea (`gitea.com`), and `"ghcr.io"` for GitHub.
     - `githubEnvironment(plan)` returns `undefined` for Forgejo/Gitea (neither supports deployment environments).
     - `runs-on:` emits `<runnerLabel>` (single label) when self-hosted on Forgejo/Gitea and `ubuntu-latest` otherwise (never `ubuntu-24.04-arm` or `[self-hosted, ...]`).
     - Registry login & image references target `registryHostFor(plan)` using `${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}`.
     - Existing GitHub Actions workflows stay **byte-for-byte identical**!

3. **Self-hosted runners (`forgejo-runner` and `act_runner`):**
   - Add `forgejoRunnerUnitText`, `forgejoRunnerInstallScript`, `giteaRunnerUnitText`, and `giteaRunnerInstallScript` in `packages/connectors/ssh-host/src/runner-unit.ts` (sharing a single internal helper since both daemons take `--config`, `sg docker`, `KillMode=control-group`, SHA-256 verification, and stdin-only registration token).

4. **Shared file changes (noted in PR description per `AGENTS.md`):**
   - `packages/plan-schema/src/plan.ts`, `packages/plan-schema/src/apps.ts`, `packages/plan-schema/schemas/plan.schema.json`: add `"forgejo-actions"`, `"gitea-actions"` to `cicd.provider` and `"forgejo-registry"`, `"gitea-registry"` to `cicd.registry`, and update `workflowPathFor`.
   - `packages/core/src/testing/fake-secrets.ts`: add `forgejo-token` and `gitea-token` fake-secret kinds for clean secret-free tests.
   - `packages/git-platforms/registry/package.json` & `src/index.ts`: add `@opscrew/git-forgejo-gitea` and register `forgejo` and `gitea`.
   - `pnpm-lock.yaml`: workspace link for `@opscrew/git-forgejo-gitea` (zero external npm dependencies).

## Delivery Structure

Single clean PR `feat(043): add Forgejo and Gitea git platform support` stacked on `042-gitlab` (or split if large; all pieces are cohesive and ~1,400 LOC total including tests & docs).
