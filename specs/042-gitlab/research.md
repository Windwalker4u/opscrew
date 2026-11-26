# Research: GitLab, Opening the Contract for Git Platforms (Feature 042)

**Feature:** `042-gitlab` | **Issue:** `#38` | **Date:** 2026-11-26  
**Sources:** Official GitLab documentation (`docs.gitlab.com`) and existing OpsCrew architecture (`docs/adr/0029-cloud-provider-contract.md`, `packages/connectors/github/`).

---

## R1. Authentication, Host Resolution & REST API v4

- **Base URL:** `https://<host>/api/v4` (default host `gitlab.com`; self-managed instances use their own HTTPS host, e.g. `https://gitlab.example.com/api/v4`).
- **Authentication header:** `PRIVATE-TOKEN: <token>` (Personal Access Token `glpat-...`, Project Access Token `glpat-...`, or Group Access Token) or `Authorization: Bearer <token>` for OAuth2 tokens.
- **Project identifier (`:id`):** Either numeric project ID or URL-encoded full path (`encodeURIComponent("group/subgroup/project")`). Unlike GitHub's flat `<owner>/<repo>`, GitLab supports arbitrary nested subgroups (`group/sub/project`), so the git-platform contract must represent coordinates as `host`, `owner` (namespace/full group path), `repo` (project slug), and `fullPath` (`<owner>/<repo>`).
- **Current user identity:** `GET /user` returns `{ id, username, name }` for Personal Access Tokens; Project Access Tokens (`project_<id>_bot_...`) also succeed on `GET /user` when the `api` or `read_user` scope is granted.
- **Official docs:**
  - https://docs.gitlab.com/ee/api/rest/
  - https://docs.gitlab.com/ee/api/rest/authentication.html

---

## R2. Project CI/CD Variables (Secrets & Environment Scoping)

- **Tier availability:** Project-level CI/CD variables — including `masked`, `protected`, `raw`, `variable_type`, and `environment_scope` — are available on **GitLab Free, Premium, and Ultimate** (group-level environment scopes require Premium+, which OpsCrew does not need).
- **Endpoints:**
  - List: `GET /projects/:id/variables`
  - Get: `GET /projects/:id/variables/:key?filter[environment_scope]=<scope>`
  - Create: `POST /projects/:id/variables`
  - Update: `PUT /projects/:id/variables/:key?filter[environment_scope]=<scope>`
  - Delete: `DELETE /projects/:id/variables/:key?filter[environment_scope]=<scope>`
- **Key parameters:**
  - `key`: variable name (`[A-Za-z0-9_]+`).
  - `value`: variable content.
  - `variable_type`: `"env_var"` (default) or `"file"` (GitLab writes the content to a temporary file on the runner and sets the variable to that file's path).
  - `protected`: `true` restricts exposure to pipelines running on protected branches or protected tags.
  - `masked`: `true` hides the value in job logs.
  - `raw`: `true` disables `$VAR` expansion inside the value (essential so secrets containing `$` are never corrupted).
  - `environment_scope`: `"*"` (default) or an environment name/wildcard (e.g. `"production"`, `"staging"`).
- **Critical masking constraints (official GitLab rules):**
  - Masked values must be **single-line** (no `\n` or `\r`), **no whitespace**, at least **8 characters**, and only characters from the supported masking alphabet (RFC 4648 Base64, `@`, `:`, `.`, `~`, etc.).
  - **Multiline secrets (SSH private keys, `.env` blobs, PEM certificates) CANNOT be `masked: true`.**
  - GitLab's official recommendation for SSH private keys is `variable_type: "file"`, `masked: false`, `raw: true`, ensuring a trailing LF newline, and passing the file path directly to `ssh -i "$DEPLOY_SSH_KEY"` without ever printing the file contents.
  - Single-line secrets meeting GitLab's masking rules (passwords, API tokens, single-line credentials) are stored with `variable_type: "env_var"`, `masked: true`, `raw: true`.
- **Official docs:**
  - https://docs.gitlab.com/ee/api/project_level_variables.html
  - https://docs.gitlab.com/ee/ci/variables/index.html#mask-a-cicd-variable
  - https://docs.gitlab.com/ee/ci/jobs/ssh_keys.html

---

## R3. Environments & Protected Environments (Free vs Paid)

- **Environments API (Free, Premium, Ultimate):**
  - `GET /projects/:id/environments`
  - `POST /projects/:id/environments` (`{ name, external_url? }`)
  - `DELETE /projects/:id/environments/:environment_id` (requires stopping the environment first via `POST /projects/:id/environments/:environment_id/stop`)
- **Protected Environments API (Premium & Ultimate ONLY):**
  - `GET /projects/:id/protected_environments`
  - `POST /projects/:id/protected_environments`
  - Returns `403 Forbidden` or `404 Not Found` on GitLab Free (or when CI/CD is disabled).
- **Design consequence for OpsCrew:**
  - Basic environments and per-environment `environment_scope` CI/CD variables work on **GitLab Free**, so OpsCrew's multi-environment secret isolation works on Free tier out of the box.
  - Environment protection rules (required reviewers / deploy access levels) are gated on capability probing (`environmentCapability`), degrading cleanly on Free tier just as GitHub private repositories on Free tier degrade gracefully today.
- **Official docs:**
  - https://docs.gitlab.com/ee/api/environments.html
  - https://docs.gitlab.com/ee/api/protected_environments.html

---

## R4. Deploy Keys, Repository Files, Branches & Merge Requests

- **Deploy Keys API (Free, Premium, Ultimate):**
  - `GET /projects/:id/deploy_keys`
  - `POST /projects/:id/deploy_keys` (`{ title, key, can_push }`)
  - `DELETE /projects/:id/deploy_keys/:key_id`
- **Branches API (Free, Premium, Ultimate):**
  - `GET /projects/:id/repository/branches`
  - `GET /projects/:id/repository/branches/:branch`
  - `POST /projects/:id/repository/branches` (`{ branch, ref }`)
  - `DELETE /projects/:id/repository/branches/:branch`
- **Repository Files API (Free, Premium, Ultimate):**
  - `GET /projects/:id/repository/files/:file_path?ref=<branch>` (metadata + base64 `content`)
  - `GET /projects/:id/repository/files/:file_path/raw?ref=<branch>`
  - `POST / PUT / DELETE /projects/:id/repository/files/:file_path`
- **Merge Requests API (Free, Premium, Ultimate):**
  - `GET /projects/:id/merge_requests?state=opened&source_branch=<head>`
  - `POST /projects/:id/merge_requests` (`{ source_branch, target_branch, title, description }`)
  - `PUT /projects/:id/merge_requests/:merge_request_iid` (`{ title, description }`)
- **Official docs:**
  - https://docs.gitlab.com/ee/api/deploy_keys.html
  - https://docs.gitlab.com/ee/api/branches.html
  - https://docs.gitlab.com/ee/api/repository_files.html
  - https://docs.gitlab.com/ee/api/merge_requests.html

---

## R5. Pipelines, Pipeline Triggers & Jobs API

- **Pipelines API (Free, Premium, Ultimate):**
  - Create pipeline directly (with PAT / Project Access Token): `POST /projects/:id/pipeline` (`{ ref, variables?: [{ key, value, variable_type? }] }`). Works on Free tier and requires no separate trigger token for OpsCrew's own dispatch (`opscrew provision`, `opscrew rollback`, `opscrew promote`, and future 041 dashboard runs).
  - Pipeline Triggers API (also Free tier): `POST /projects/:id/trigger/pipeline` (form fields `token`, `ref`, `variables[KEY]`).
  - List pipelines: `GET /projects/:id/pipelines?ref=<branch>&per_page=<n>`
  - Get pipeline: `GET /projects/:id/pipelines/:pipeline_id`
  - Retry pipeline: `POST /projects/:id/pipelines/:pipeline_id/retry`
  - List pipeline jobs: `GET /projects/:id/pipelines/:pipeline_id/jobs`
  - Download job artifacts: `GET /projects/:id/jobs/:job_id/artifacts`
- **Official docs:**
  - https://docs.gitlab.com/ee/api/pipelines.html
  - https://docs.gitlab.com/ee/api/pipeline_triggers.html
  - https://docs.gitlab.com/ee/api/jobs.html

---

## R6. GitLab Container Registry & Tokens

- **Default registry host:** `registry.gitlab.com` for `gitlab.com`; for self-managed GitLab, derived from `project.container_registry_image_prefix` (returned by `GET /projects/:id`) or `registry.<host>` / user-configured `cicd.registryHost`.
- **Image naming:** `<registry_host>/<namespace>/<project>` (lower-case) for the first app, `<registry_host>/<namespace>/<project>/<key>` for a further app in a multi-app repository.
- **CI/CD authentication:** GitLab automatically injects `$CI_REGISTRY`, `$CI_REGISTRY_USER`, `$CI_REGISTRY_PASSWORD` (`$CI_JOB_TOKEN`), and `$CI_REGISTRY_IMAGE` into every job. Pushing and pulling the project's own images inside CI requires zero stored registry credentials.
- **External pulls (on target servers / Portainer / local):**
  - Project **Deploy Tokens** (`POST /projects/:id/deploy_tokens` with `scopes: ["read_registry"]`, prefix `gldt-...`) grant read-only pull access without tying to a personal account.
  - Project Access Tokens or Personal Access Tokens with `read_registry` (and `write_registry` for pushes) also authenticate via `docker login <registry> -u <user> --password-stdin`.
- **Registry REST API (Free, Premium, Ultimate):**
  - `GET /projects/:id/registry/repositories`
  - `GET /projects/:id/registry/repositories/:repository_id/tags`
  - `GET /projects/:id/registry/repositories/:repository_id/tags/:tag_name` (returns `digest`, `revision`, `created_at`)
  - `DELETE /projects/:id/registry/repositories/:repository_id/tags/:tag_name`
- **Official docs:**
  - https://docs.gitlab.com/ee/user/packages/container_registry/
  - https://docs.gitlab.com/ee/api/container_registry.html
  - https://docs.gitlab.com/ee/user/project/deploy_tokens/

---

## R7. Self-Hosted GitLab Runner on the User's Server

- **Modern runner creation workflow (GitLab 16+, replacing deprecated registration tokens):**
  - Create a project runner via `POST /user/runners` with `{ runner_type: "project_type", project_id, description, tag_list: ["opscrew-<app>-<env>"], run_untagged: false, locked: true }` (requires `create_runner` scope on PAT or Maintainer/Owner role).
  - Returns `{ id, token }` where `token` is a runner authentication token starting with `glrt-`.
  - List project runners: `GET /projects/:id/runners`.
  - Delete runner: `DELETE /runners/:id`.
- **Server installation & execution:**
  - Standalone Linux binary (`gitlab-runner-linux-amd64` / `gitlab-runner-linux-arm64`) downloaded from official GitLab Runner release URLs (`https://s3.dualstack.us-east-1.amazonaws.com/gitlab-runner-downloads/v<version>/binaries/gitlab-runner-linux-<arch>`), verified against a pinned SHA-256 checksum before execution.
  - Registered non-interactively with `gitlab-runner register --non-interactive --url "<instanceUrl>" --token "$RUNNER_TOKEN" --executor "shell" --config "/srv/runners/<app>/config.toml"` with the `glrt-` token delivered only on stdin (never in a plan, plan hash, log, audit entry, or committed file).
  - Run under the `deploy` user's systemd user service (`opscrew-runner-<app>.service`), matching OpsCrew's existing `sg docker` and `KillMode=control-group` isolation model (`runner-unit.ts`).
- **Official docs:**
  - https://docs.gitlab.com/ee/api/users.html#create-a-runner-linked-to-a-user
  - https://docs.gitlab.com/ee/api/runners.html
  - https://docs.gitlab.com/runner/install/linux-manually.html
  - https://docs.gitlab.com/runner/executors/shell.html

---

## R8. Merge Request Previews (Feature 022 Parity & ADR 0026)

- **Pipeline trigger:** `rules: - if: $CI_MERGE_REQUEST_IID` (excluding fork MRs where `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID != $CI_PROJECT_ID` so untrusted forks never receive preview deploy secrets).
- **Lifecycle & teardown:** GitLab's native Review Apps pattern (`environment: { name: "review/mr-$CI_MERGE_REQUEST_IID", url: "https://...", on_stop: "stop_preview", auto_stop_in: "7 days" }`) automatically invokes the `stop_preview` job when the MR is merged or closed.
- **Standing approval (ADR 0026):** The preview server's `opscrew-preview` script enforces the exact same recipe-bound standing approval over SSH (`up <mr_number> <image> <commit>` and `down <mr_number>`), using the project's preview SSH key (`variable_type: "file"`) and `$CI_JOB_TOKEN` on stdin for pulling the preview image from the project's registry.
- **Official docs:**
  - https://docs.gitlab.com/ee/ci/pipelines/merge_request_pipelines.html
  - https://docs.gitlab.com/ee/ci/review_apps/

---

## R9. GitLab Pages Assessment

- GitLab Pages supports custom domains with automated Let's Encrypt TLS on GitLab Free, requiring a DNS TXT ownership verification record (`_gitlab-pages-verification-code.<domain>`) plus `A`/`ALIAS`/`CNAME` records, and deployment via a `pages` job in `.gitlab-ci.yml`.
- **Decision (aligned with `specs/roadmap.md` 042):** Static-site hosting targets (`github-pages`, `cloudflare-pages`, `cloudflare-workers`) are separate target kinds with their own deployment/DNS flows. Keeping GitHub Pages as GitHub-specific in 042 keeps the git platform contract focused on git + CI/CD + registry + runners + previews. GitLab Pages can be added cleanly later as a dedicated static-site target if requested.
- **Official docs:**
  - https://docs.gitlab.com/ee/user/project/pages/custom_domains_ssl_tls_certification/

---

## R10. GitLab Token Prefixes for Redaction & Secret Scanning (`opscrew scan`)

Official GitLab token prefixes documented in GitLab's token prefix reference:
- Personal / Project / Group Access Token: `glpat-` (20+ chars `[A-Za-z0-9_-]`)
- Runner Authentication Token: `glrt-` (20+ chars `[A-Za-z0-9_-]`)
- Deploy Token: `gldt-` (20+ chars `[A-Za-z0-9_-]`)
- Pipeline Trigger Token: `glptt-` (40 hex chars)
- **Official docs:**
  - https://docs.gitlab.com/ee/security/tokens/
