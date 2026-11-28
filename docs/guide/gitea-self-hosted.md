# Self-Hosted Gitea: Provisioning & App Integration

OpsCrew can provision and operate a hardened, self-hosted [Gitea](https://about.gitea.com/) instance
on your server (a cloud VPS or your own server), route it over HTTPS behind OpsCrew's reverse proxy,
include it in snapshots and restore drills, and wire up the API token and HMAC webhook contract so
your application can integrate with Gitea the same way it integrates with GitHub.

> Looking to deploy a repository hosted on an existing Gitea instance (`gitea.com` or your own)?
> See [Gitea (`gitea.com` and self-hosted)](gitea.md).

## Provisioning self-hosted Gitea

Every change goes through OpsCrew's safety gate:
`plan -> SecOps policy checks -> SHA-256 plan-hash approval -> apply`.

### SQLite (default, single container)

```bash
npx opscrew addon enable gitea \
  --hostname git.example.com \
  --admin-email admin@example.com \
  --webhook-path /api/webhooks/gitea
```

### Dedicated PostgreSQL 17

For higher concurrency or teams, use a dedicated PostgreSQL 17 container isolated on Gitea's own
internal Docker network (`gitea-internal`):

```bash
npx opscrew addon enable gitea \
  --hostname git.example.com \
  --admin-email admin@example.com \
  --database postgres \
  --webhook-path /api/webhooks/gitea
```

### Non-interactive / plan-first workflow

```bash
# 1. Preview the host plan, SecOps checks, and SHA-256 plan hash (changes nothing)
npx opscrew addon enable gitea \
  --hostname git.example.com \
  --admin-email admin@example.com \
  --plan-only

# 2. Approve and apply the exact plan hash
npx opscrew addon enable gitea \
  --hostname git.example.com \
  --admin-email admin@example.com \
  --approve <sha256-hash>
```

## Hardened defaults

OpsCrew enforces these security controls via `evaluateGiteaPolicies` before asking for approval:

- **Pinned rootless image:** runs `gitea/gitea:28.4.0-rootless@sha256:...` (UID/GID `1000`, non-root,
  `no-new-privileges:true`, `cap_drop: ["ALL"]`, memory limits, and log rotation).
- **Web installer locked (`GITEA__security__INSTALL_LOCK=true`):** eliminates interactive `/install`
  takeover on fresh boots.
- **Open registration disabled (`GITEA__service__DISABLE_REGISTRATION=true`):** only administrators
  create accounts.
- **Behind the reverse proxy only:** port `3000` is never published on `0.0.0.0`. Gitea joins
  `opscrew-edge` under alias `opscrew-gitea` and is served over HTTPS with HSTS and security headers
  by your server's configured proxy (**Caddy**, **nginx**, or **OpenLiteSpeed**).
- **Git over HTTPS by default:** built-in SSH is disabled by default so the firewall stays locked to
  ports 22, 80, and 443. Opt in with `--ssh --ssh-port 2222` (ports 22, 80, and 443 are refused).
- **Webhook SSRF protection:** `GITEA__webhook__ALLOWED_HOST_LIST` allows `external` plus your app's
  domain (never `*`), and `GITEA__webhook__SKIP_TLS_VERIFY=false`.
- **Zero plaintext secrets in Git, plans, or logs:** `adminPassword`, `SECRET_KEY`, `INTERNAL_TOKEN`,
  JWT secrets, optional Postgres password, and `GITEA_WEBHOOK_SECRET` are generated locally into
  `gitea_secrets.json` (mode `0600`), registered with OpsCrew's redactor, and delivered to the server
  strictly over stdin into `0600` env files.

## Connecting your app to Gitea (API token & webhooks)

Apps that display repositories, pull requests, issues, commits, and activity can plug into
self-hosted Gitea alongside GitHub using four standard environment variables:

| Variable | Value | Secret? |
| --- | --- | --- |
| `GITEA_URL` | `https://git.example.com` | No |
| `GITEA_API_URL` | `https://git.example.com/api/v1` | No |
| `GITEA_TOKEN` | Scoped Personal Access Token (`opscrew-app`) | **Yes** |
| `GITEA_WEBHOOK_SECRET` | 64-char hex HMAC-SHA256 signing secret | **Yes** |

### 1. Least-privilege API token & REST v1 endpoints

During provisioning, OpsCrew's idempotent host bootstrap creates the initial admin user and generates
a scoped Personal Access Token (`opscrew-app`) with read-only defaults:

`read:repository,read:issue,read:organization,read:user`

Authenticate API calls with the `Authorization: token <GITEA_TOKEN>` header:

| Capability | GitHub REST v3 | Gitea REST v1 (`$GITEA_API_URL`) |
| --- | --- | --- |
| List repositories | `GET /user/repos` | `GET /user/repos` |
| List pull requests | `GET /repos/{owner}/{repo}/pulls` | `GET /repos/{owner}/{repo}/pulls` |
| List issues | `GET /repos/{owner}/{repo}/issues` | `GET /repos/{owner}/{repo}/issues` |
| List commits | `GET /repos/{owner}/{repo}/commits` | `GET /repos/{owner}/{repo}/commits` |
| Activity feed | `GET /repos/{owner}/{repo}/events` | `GET /repos/{owner}/{repo}/activities/feeds` |
| User heatmap | GraphQL contributions | `GET /users/{username}/heatmap` |
| Manage webhooks | `POST /repos/{owner}/{repo}/hooks` | `POST /repos/{owner}/{repo}/hooks` |

### 2. Registering a repository webhook

Create a webhook via the Gitea REST API (requires `write:repository` or admin token):

```bash
curl -sS -X POST "$GITEA_API_URL/repos/<owner>/<repo>/hooks" \
  -H "Authorization: token $GITEA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "gitea",
    "active": true,
    "events": ["push", "pull_request", "issues", "issue_comment", "release"],
    "config": {
      "url": "https://app.example.com/api/webhooks/gitea",
      "content_type": "json",
      "secret": "'"$GITEA_WEBHOOK_SECRET"'"
    }
  }'
```

### 3. Verifying `X-Gitea-Signature` (HMAC-SHA256)

Gitea signs the **raw** JSON request body using HMAC-SHA256 and sends the **lowercase hex** digest
in `X-Gitea-Signature` — note that unlike GitHub's `X-Hub-Signature-256: sha256=<hex>`, Gitea does
**not** include a `sha256=` prefix. Always compare signatures in constant time:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGiteaWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !/^[0-9a-f]{64}$/i.test(signatureHeader)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const actualBuf = Buffer.from(signatureHeader.toLowerCase(), "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
}
```

## Snapshots and restore drills

When `plan.gitea.enabled` is `true`, Gitea is automatically included in OpsCrew snapshots and
restore drills:

- **SQLite mode:** `opscrew snapshot` stops Gitea cleanly to flush SQLite WAL and Git packfiles,
  archives `gitea_data` (`/var/lib/gitea`) and `gitea_config` (`/etc/gitea`) into `gitea.tar`, and
  restarts Gitea.
- **PostgreSQL mode:** takes both an online `pg_dump -Fc` (`gitea-db.dump`) and the volume archive
  (`gitea.tar`).
- **Restore drills (`opscrew restore --drill`):** restores `gitea.tar` (and verifies `gitea-db.dump`)
  inside isolated throwaway volumes/containers with `--network none`, never touching production data.

## Status and disabling

```bash
# Check status and connection details (never prints secrets)
npx opscrew addon status

# Stop Gitea and remove the reverse proxy route while keeping data volumes (default)
npx opscrew addon disable gitea

# Permanently remove Gitea AND all repositories/database volumes (requires typed app name)
npx opscrew addon disable gitea --delete-data
```
