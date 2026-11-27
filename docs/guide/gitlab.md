# Deploy from GitLab

OpsCrew supports **GitLab.com** and **self-managed GitLab** instances alongside GitHub through its
git platform contract. Repositories on GitLab build images into **GitLab Container Registry**,
store deploy secrets as **GitLab CI/CD variables** scoped to the app's environment, deploy via
`.gitlab-ci.yml`, and support **self-hosted GitLab Runners** and **merge-request previews**.

## What you need

- A GitLab project on `gitlab.com` or your own GitLab server, with `origin` pointing to it
  (nested subgroups such as `group/subgroup/project` work as-is).
- A **GitLab Personal Access Token** or **Project Access Token** in `GITLAB_TOKEN` (or `GL_TOKEN`,
  or a `glab auth login` session):
  - `api` scope (for repository files, merge requests, CI/CD variables, environments, pipelines, and
    the container registry);
  - `create_runner` scope as well if you install a self-hosted GitLab Runner on your server.
- For a self-managed host whose hostname does not contain `gitlab`, set `GITLAB_HOST=<your-host>`
  (or `OPSCREW_GIT_PLATFORM=gitlab`).

Run `npx opscrew init` in your repository to verify that OpsCrew detects your GitLab remote and
token.

## How GitLab maps to OpsCrew

| OpsCrew concept | GitLab |
|---|---|
| Deploy pipeline | `.gitlab-ci.yml` (or `.gitlab/opscrew-deploy-<suffix>.yml` for further apps/environments) |
| Container registry | `registry.gitlab.com/<namespace>/<project>` (or `registry.<host>` / `cicd.registryHost` on self-managed GitLab), authenticated in CI with `$CI_JOB_TOKEN` |
| Secrets & environment scoping | Project CI/CD variables (`masked: true`, `raw: true`, `environment_scope`) — **works on GitLab Free** |
| Multiline secrets (SSH deploy key, `.env` files) | Stored as `variable_type: file` (`raw: true`) per GitLab's SSH key guidelines, never echoed in logs |
| Protected environments | Probed automatically; used when available (GitLab Premium/Ultimate) and skipped cleanly on Free |
| Merge-request previews | Review Apps (`$CI_MERGE_REQUEST_IID` + `environment.on_stop`), excluding forks, invoking the same server-side `opscrew-preview` standing approval |
| Self-hosted runner | Pinned `gitlab-runner` binary registered with a `glrt-` token passed on stdin, running as `deploy`'s systemd user service |

## Plan fields

In `opscrew/plan.yaml`:

```yaml
cicd:
  provider: gitlab-ci
  registry: gitlab-registry
  branch: main
  # Optional, for self-managed GitLab:
  host: gitlab.company.internal
  registryHost: registry.gitlab.company.internal
```

## Self-hosted GitLab Runner

When `environment.runner` is `server` or `host`, OpsCrew tags the pipeline's `build` and `deploy`
jobs with `opscrew-<app>-<env>` and installs a pinned `gitlab-runner` binary under `/srv/runners/<app>`
running as the `deploy` user's systemd user service (`opscrew-runner-<app>.service`). The `glrt-`
authentication token created through GitLab's `POST /user/runners` API is delivered only on
standard input during registration and is never written to any plan, log, or file in your
repository. See [Self-hosted runners](runners.md).
