# Forgejo (Codeberg and self-hosted)

OpsCrew supports repositories hosted on [Forgejo](https://forgejo.org/) — including
[Codeberg](https://codeberg.org/) and self-hosted Forgejo instances — through the same safety model
as GitHub: every infrastructure change goes through a plan approved by its SHA-256 hash, and no
secret is written to your repository, logs, or audit trail.

## Prerequisites

- **Forgejo version:** Forgejo **1.21+** for Actions secrets and variables, and **7.0+** for
  triggering workflows through the API (`workflow_dispatch`, required by `opscrew rollback`,
  `opscrew promote`, and OpsCrew cloud runs).
- **Forgejo Actions enabled** on the instance and repository, with at least one `forgejo-runner`
  attached (instance, organization, or repository level).
- **Personal Access Token (`FORGEJO_TOKEN`):** create one at
  `https://<your-forgejo-host>/user/settings/applications` with:
  - `write:repository` (files, pull requests, deploy keys, Actions secrets/variables/runs/runners)
  - `write:package` (container images in Forgejo's OCI package registry)

## Remote detection

`opscrew init` recognises Forgejo automatically when `origin` points to:

- `codeberg.org` or `code.forgejo.org`;
- any hostname with a `forgejo` DNS label (for example `forgejo.company.internal`);
- any custom hostname configured in `FORGEJO_HOST` (or when `OPSCREW_GIT_PLATFORM=forgejo`).

```bash
export FORGEJO_TOKEN="<your-token>"
# Optional for custom domains that do not contain "forgejo":
export FORGEJO_HOST="git.example.com"
npx opscrew init
```

## Deploy workflow & secrets

- OpsCrew renders the deploy workflow to `.forgejo/workflows/opscrew-deploy.yml` (and
  `.forgejo/workflows/opscrew-deploy-<env>.yml` for additional environments), based on OpsCrew's
  GitHub Actions workflow template.
- **Registry:** images are pushed to your Forgejo instance's built-in OCI container registry
  (`<host>/<owner>/<repo>`, or `cicd.registryHost` when overridden). Both build and server-side
  deploy logins authenticate with `${{ secrets.OPSCREW_REGISTRY_TOKEN || secrets.GITHUB_TOKEN }}`
  (prefixed per environment outside `prod`); if your instance's job token cannot access private
  packages, export `OPSCREW_REGISTRY_TOKEN` when running `opscrew provision` so it is stored
  alongside the other deploy secrets after approval.
- **Secrets:** Forgejo does not have deployment environments, so OpsCrew stores deploy secrets at
  repository scope with per-environment prefixes (`OPSCREW_*` for prod, `OPSCREW_STAGING_*` for
  staging).
- **`runs-on` labels:** standard docker-mode jobs request `ubuntu-latest`; self-hosted OpsCrew
  server runners (`environment.runner: server`) request `opscrew-<app>-<env>` directly.
- **Action mirrors:** OpsCrew keeps commit-pinned shorthand action references (such as
  `actions/checkout@<sha>`), which respect your Forgejo instance's `DEFAULT_ACTIONS_URL` (default
  `https://data.forgejo.org/`).

## Live verification checklist

Unit tests verify Forgejo's REST v1 API, workflow rendering, and approval-gated provisioning
against fake endpoints. Before relying on a new Forgejo instance:

1. Run `npx opscrew init` with `FORGEJO_TOKEN` and confirm it signs in against `/api/v1/user`.
2. Verify `Settings -> Actions -> Secrets` and `Variables` are enabled on the repository.
3. Confirm a `forgejo-runner` matching `ubuntu-latest` (or `opscrew-<app>-<env>:host`) is online
   and can push to `https://<host>/v2/<owner>/<repo>`.
