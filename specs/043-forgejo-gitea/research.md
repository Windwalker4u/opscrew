# Research: Forgejo and Gitea (Feature 043)

**Date:** 2026-11-26 | **Issue:** `#41` | **Sources:** Official Forgejo documentation (`forgejo.org/docs`), official Gitea documentation (`docs.gitea.com`), and live official OpenAPI v1 specifications fetched on 2026-11-26 from `https://codeberg.org/swagger.v1.json` (Forgejo `17.0.0-121-39320c0+gitea-1.22.0`) and `https://gitea.com/swagger.v1.json` (Gitea `29.0.0+dev-160-g55186ca39b`).

---

## R1. Versions with Actions Secrets, Variables, and Workflow Dispatch APIs

| Capability | Forgejo | Gitea |
|---|---|---|
| REST API base | `/api/v1` (`Authorization: token <PAT>` or `Bearer <PAT>`) | `/api/v1` (`Authorization: token <PAT>` or `Bearer <PAT>`) |
| Actions Secrets API (`GET /actions/secrets`, `PUT /actions/secrets/{name}` with `{ data }`, `DELETE`) | Forgejo 1.20+ (inherited from Gitea 1.20; encrypted server-side under `[security].SECRET_KEY`, sent over HTTPS as JSON `{ "data": "..." }` — no client-side libsodium box) | Gitea 1.20+ (stabilized in 1.21; `PUT` body `{ "data": "...", "description"?: "..." }`) |
| Actions Variables API (`GET/POST/PUT/DELETE /actions/variables/{name}`) | Forgejo 1.21+ (`POST` creates with `{ "value" }`, `PUT` updates with `{ "name", "value" }`, `GET` returns `{ "name", "data" }`) | Gitea 1.21+ (`POST` creates with `{ "value" }`, `PUT` updates with `{ "name", "value" }`, `GET` returns `{ "name", "data" }`) |
| Workflow Dispatch API (`POST /actions/workflows/{workflow}/dispatches`) — **needed by 041** | **Supported** (Forgejo 7.0+): body `DispatchWorkflowOption` `{ ref, inputs?, return_run_info?: true }`; returns `201 DispatchWorkflowRun { id, run_number, jobs }` or `204` | **Supported** (Gitea 1.23+): body `CreateActionWorkflowDispatch` `{ ref, inputs? }` + optional query `?return_run_details=true`; returns `200 RunDetails` or `204` |
| List / Get / Rerun Workflow Runs | `GET /actions/runs` (query `ref`, `workflow_id`, `status`, `page`, `limit`), `GET /actions/runs/{run_id}`, `POST /actions/runs/{run_id}/rerun`; fallback `GET /actions/tasks` on older versions | `GET /actions/runs` (query `branch`, `status`, `page`, `limit`), `GET /actions/runs/{run}`, `POST /actions/runs/{run}/rerun`; fallback `GET /actions/tasks` on older versions |
| Deployment Environments (`/environments`) | **Not supported** (`[]` in `codeberg.org/swagger.v1.json`) | **Not supported** (`[]` in `gitea.com/swagger.v1.json`) |
| Deploy Keys (`GET/POST /keys`, `DELETE /keys/{id}`) | Supported (`{ title, key, read_only }`) | Supported (`{ title, key, read_only }`) |
| Pull Requests (`GET/POST /pulls`, `PATCH /pulls/{index}`) | Supported (`GET /pulls` accepts `base` & `head` query params) | Supported (`GET /pulls` accepts `base_branch`, no `head` param; client-side filter works identically on both) |
| Repository Files (`GET /contents/{filepath}?ref=...`) | Supported (base64 `content`) | Supported (base64 `content`) |
| Built-in Container Registry | OCI Distribution v2 at `/v2/<owner>/<image>/manifests/<tag>` (`Docker-Content-Digest`) + `/api/v1/packages/{owner}` | OCI Distribution v2 at `/v2/<owner>/<image>/manifests/<tag>` (`Docker-Content-Digest`) + `/api/v1/packages/{owner}` |

**Important security detail:** Because neither Forgejo nor Gitea supports deployment environments (`capabilities.environments: false`), OpsCrew always stores secrets at repository scope using its existing per-environment prefixing (`OPSCREW_<ENV>_*` / `OPSCREW_<KEY>_<ENV>_*`), matching the existing fallback behavior on GitHub Free private repositories.

---

## R2. Workflow Dispatch Through the API (041 Readiness)

Both Forgejo and Gitea support starting a workflow via API (`POST /api/v1/repos/{owner}/{repo}/actions/workflows/{workflow}/dispatches`) when the workflow file declares `on: workflow_dispatch:` (with optional `inputs` of type `string`, `boolean`, `number`, `choice`; Forgejo defaults `LIMIT_DISPATCH_INPUTS = 10`).

- **Forgejo:** accepts `return_run_info: true` in the JSON body (`DispatchWorkflowOption`) and returns HTTP `201` with `{ id, run_number, jobs }` (or `204` when `return_run_info` is false or unsupported on older instances).
- **Gitea:** accepts `?return_run_details=true` as a query parameter (body `CreateActionWorkflowDispatch` has only `{ ref, inputs }`) and returns HTTP `200` with run details (or `204`).

This means **041** (OpsCrew running in CI, triggered from the dashboard) can dispatch workflows on both Forgejo and Gitea through the exact same `GitPlatformClient.triggerPipeline()` method!

---

## R3. Workflow Folder and `runs-on` Labels

### Workflow folder
- **Forgejo:** primary path is `.forgejo/workflows/*.yml` (falls back to `.github/workflows/` if `.forgejo/workflows/` is absent).
- **Gitea:** primary path is `.gitea/workflows/*.yml` (falls back to `.github/workflows/` if `.gitea/workflows/` is absent).
- **Decision:** OpsCrew writes to `.forgejo/workflows/opscrew-deploy[-<key>][-<env>].yml` for `forgejo-actions` and `.gitea/workflows/opscrew-deploy[-<key>][-<env>].yml` for `gitea-actions` (native paths; avoids accidental runs if a repository is mirrored to GitHub).

### `runs-on` labels
- Neither Forgejo nor Gitea provides GitHub's managed `ubuntu-24.04-arm` label; all jobs run on instance/org/repo runners registered with explicit `<label>:<mode>` mappings (e.g., `ubuntu-latest:docker://...` or `opscrew-<app>-<env>:host`).
- On both `forgejo-runner` and `act_runner`, an array `runs-on: [self-hosted, opscrew-demo-prod]` requires a runner to advertise **every** label in the array. Registering a dedicated OpsCrew server runner with `<runnerLabel>:host` and targeting `runs-on: <runnerLabel>` directly guarantees exact routing without colliding with generic `self-hosted` runners.
- For non-self-hosted jobs (docker-mode runners provided by the instance or org), `runs-on: ubuntu-latest` is the universal convention across both Forgejo and Gitea.

### Action resolution (`DEFAULT_ACTIONS_URL`)
- Forgejo defaults `DEFAULT_ACTIONS_URL` to `https://data.forgejo.org/` (which mirrors standard `actions/*` and `docker/*` actions) and also supports full URLs (`https://github.com/...`).
- Gitea defaults `DEFAULT_ACTIONS_URL` to `github` (`https://github.com/`), or `self` on air-gapped mirrors.
- Keeping OpsCrew's commit-pinned `uses: actions/checkout@<sha>` and `uses: docker/login-action@<sha>` references works on both Forgejo and Gitea while honoring any self-hosted instance's configured `DEFAULT_ACTIONS_URL`.

---

## R4. Runner Differences vs. GitHub Actions Runner

| Aspect | GitHub Actions Runner | Forgejo Runner (`forgejo-runner`) | Gitea Runner (`act_runner`) |
|---|---|---|---|
| Binary & download | `actions/runner` (`run.sh` + `config.sh`, .NET) | Single static Go binary `forgejo-runner` (`code.forgejo.org/forgejo/runner`) | Single static Go binary `act_runner` (`dl.gitea.com/act_runner/`) |
| Registration token API | `POST /actions/runners/registration-token` | **`GET`** `/actions/runners/registration-token` (or `POST /actions/runners` returning `{ id, uuid, token }`) | **`POST`** `/actions/runners/registration-token` |
| Registration CLI | `./config.sh --url ... --token ... --labels ... --unattended` | `forgejo-runner register --no-interactive --instance <url> --token <tok> --name <name> --labels "<label>:host"` | `act_runner register --no-interactive --instance <url> --token <tok> --name <name> --labels "<label>:host"` |
| Daemon command | `./run.sh` | `forgejo-runner daemon --config <config.yml>` | `act_runner daemon --config <config.yaml>` |
| Execution modes | Host machine directly | Docker container (`docker://`), LXC (`lxc://`), or host (`host`) | Docker container (`docker://`) or host (`host`) |
| Default container image tooling | Batteries-included Ubuntu VM | Minimal container (often Debian bookworm / node-only) unless host mode or custom image | Minimal container (`gitea/runner-images`) unless host mode or custom image |
| Workflow YAML differences | Full `permissions:`, `environment:`, `continue-on-error:` | `permissions:` and job-level `continue-on-error:` ignored; no `environment:`; exposes both `GITHUB_*` and `FORGEJO_*` env vars | `permissions:` ignored; no `environment:`; exposes both `GITHUB_*` and `GITEA_*` env vars |
| Registry auth in workflows | `GITHUB_TOKEN` has `packages: write` on `ghcr.io` | Instance OCI registry at `<host>` (`<host>/<owner>/<repo>`); login via `${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}` | Instance OCI registry at `<host>` (`<host>/<owner>/<repo>`); login via `${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}` |

---

## R5. One Connector or Two? (Architecture Decision)

**Decision: One shared connector engine (`@opscrew/git-forgejo-gitea`) parameterized by `flavor: "forgejo" | "gitea"`, exporting two first-class `GitPlatformDefinition`s (`forgejo` and `gitea`).**

**Why:**
1. ~90% of the REST v1 endpoints and payloads (user, repo, file contents, PRs, deploy keys, actions secrets, actions variables, runners list/delete, workflow runs rerun, OCI v2 registry digest) are **identical** between Forgejo and Gitea.
2. Live Swagger inspection (`codeberg.org` vs `gitea.com`) revealed **four real divergences** that cannot be ignored:
   - Runner registration token method: `GET` on Forgejo vs `POST` on Gitea;
   - Workflow dispatch run-info parameter: `return_run_info: true` in JSON body on Forgejo vs `?return_run_details=true` query param on Gitea;
   - Run object fields & query filter: `prettyref`/`commit_sha`/`created` + `?ref=` on Forgejo vs `head_branch`/`head_sha`/`created_at`/`conclusion` + `?branch=` on Gitea;
   - Platform identity & conventions: workflow folder (`.forgejo/workflows/` vs `.gitea/workflows/`), default host (`codeberg.org` vs `gitea.com`), env vars (`FORGEJO_TOKEN`/`FORGEJO_HOST` vs `GITEA_TOKEN`/`GITEA_HOST`), and runner binary (`forgejo-runner` vs `act_runner`).
3. One shared client with an explicit `flavor: "forgejo" | "gitea"` avoids duplicating ~450 lines of HTTP/pagination/redaction code while accurately handling every protocol difference and registering `"forgejo"` and `"gitea"` cleanly in `GIT_PLATFORMS` with zero branching outside the platform package.

---

## R6. References (Official Sources Only)

- Forgejo Actions documentation: https://forgejo.org/docs/latest/user/actions/overview/ (accessed 2026-11-26)
- Forgejo Actions comparison with GitHub Actions: https://forgejo.org/docs/latest/user/actions/comparison/ (accessed 2026-11-26)
- Forgejo Actions reference (`workflow_dispatch`, secrets, variables, `DEFAULT_ACTIONS_URL`): https://forgejo.org/docs/latest/user/actions/reference/ (accessed 2026-11-26)
- Forgejo Runner installation & labels: https://forgejo.org/docs/latest/admin/actions/runner-installation/ (accessed 2026-11-26)
- Forgejo API usage & OpenAPI v1 spec: https://forgejo.org/docs/latest/user/api-usage/ & `https://codeberg.org/swagger.v1.json` (fetched 2026-11-26, Forgejo `17.0.0-121-39320c0+gitea-1.22.0`)
- Gitea Actions overview & comparison: https://docs.gitea.com/usage/actions/overview & https://docs.gitea.com/usage/actions/comparison (accessed 2026-11-26)
- Gitea `act_runner` documentation: https://docs.gitea.com/usage/actions/act-runner (accessed 2026-11-26)
- Gitea Container Registry documentation: https://docs.gitea.com/usage/packages/container (accessed 2026-11-26)
- Gitea OpenAPI v1 spec: `https://gitea.com/swagger.v1.json` (fetched 2026-11-26, Gitea `29.0.0+dev-160-g55186ca39b`)
