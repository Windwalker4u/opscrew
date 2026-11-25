# 046 An uptime check that doesn't use GitHub Actions: research

The founder's decision (`specs/roadmap.md`, 046, 2026-11-25) settles the design: the setting
`observability.check.runner: actions | cloudflare`, one shared OpsCrew Worker per Cloudflare account
on the free plan's Cron Triggers, every 5 minutes, alerts to the existing webhook, state in KV
written only on change, no GitHub issue, each app owning only its own entry, every change through a
plan approved by its hash. This file records the facts the plan rests on. Official sources only,
read 2026-11-25.

## R1. Workers' free plan

Source: <https://developers.cloudflare.com/workers/platform/limits/>

- **Cron Triggers:** 5 per account.
- **CPU time:** 10 ms per invocation, for a Cron Trigger too. Waiting on `fetch()` is not CPU time.
- **Duration:** a Cron Trigger runs for at most 15 minutes of wall-clock time.
- **Subrequests:** 50 per invocation.
- **Simultaneous open connections:** 6 per invocation; KV calls count toward it while they wait
  for response headers. Further calls wait for a free connection.
- **Environment variables:** 64 per Worker, secrets and text variables together, each up to 5 KB.
- **Workers per account:** 100. **Requests:** 100,000 a day, reset at 00:00 UTC.

**What follows** (the lead's decision of 2026-11-25: one try per hostname per run, and the retry
comes from the next run; R5b):

- **The cap:** a run makes `H` fetches plus one webhook post per hostname that changed between
  down and up. **At most 40 hostnames per account** leaves 10 subrequests for posts. The plan
  refuses the 41st, naming the cap.
- **More than 10 changes in one run:** the posts that don't fit wait. Their state isn't written,
  so the next run posts them.
- **The 64 variables:** the entries' secrets never reach 64 first, since each entry has one secret
  and at least one hostname, and 40 hostnames make at most 40 entries.
- **The pool:** fetches run 5 at a time, under the 6-connection cap, so a queued fetch's 10-second
  timeout never starts while it waits. 40 hostnames take at most 8 rounds of 10 seconds.

## R2. Cron Triggers

Source: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>

- The handler is `export default { async scheduled(controller, env, ctx) { … } }`.
- Five-field cron with the `*/n` step form; cron triggers run on UTC.
- A changed trigger "may take several minutes (up to 15 minutes)" to reach the network, and runs
  may be missed until then. The guide says so for the first run.

API: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/schedules/methods/update/>

- `PUT /accounts/{account_id}/workers/scripts/{script_name}/schedules`, body
  `[{ "cron": "*/5 * * * *" }]`. The body is the full array, so it replaces the schedules. OpsCrew
  only ever sets this one, so a replace is what it wants.
- Permission: Workers Scripts Write (the token builder's "Account → Workers Scripts → Edit").

## R3. Workers KV's free plan

Sources: <https://developers.cloudflare.com/kv/platform/limits/>,
<https://developers.cloudflare.com/kv/platform/pricing/>

- **A day, per account:** 100,000 key reads, 1,000 writes, 1,000 deletes, 1,000 list requests. Daily limits reset at
  00:00 UTC, and once a limit is hit, further operations of that kind fail.
- **Per key:** 1 write per second to the same key; key 512 bytes, metadata 1,024 bytes, value
  25 MiB.
- **Per invocation:** 1,000 operations. **Namespaces:** 1,000 per account. **Storage:** 1 GB.

**What follows** for a run every 5 minutes (288 a day) with `N` entries:

- one `list` per run: 288 list requests a day, under 1,000;
- two `get`s per entry (its entry and its state): `576 × N` reads a day, under 100,000 up to 173
  entries, and R1 caps entries at 40;
- writes and deletes only on a state change: up to `suspect`, `suspect` to `down`, and back.
  - A single failure costs two writes: `suspect`, then cleared.
  - An outage costs three: `suspect`, `down`, then cleared.
  - 1,000 writes a day allow hundreds of failures.

These limits are the account's, shared with the user's own Workers, and the guide says so.

KV namespace API: <https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/>

- `POST /accounts/{account_id}/storage/kv/namespaces` with `{ "title": … }`.
- It "Returns `400` if the account already owns a namespace with that title." Two apps that create
  `opscrew-uptime` at the same moment therefore get one namespace: the second create fails, and its
  apply lists the namespaces and uses that one.
- Permission: Workers KV Storage Write ("Account → Workers KV Storage → Edit").

## R4. The Worker's script and its secrets

Upload: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/>

- `PUT /accounts/{account_id}/workers/scripts/{script_name}`, `multipart/form-data`.
  - A `metadata` JSON part with `main_module`, `compatibility_date` and `bindings`. A KV binding is
    `{ "type": "kv_namespace", "name": …, "namespace_id": … }`.
  - `keep_bindings`, "List of binding types to keep from previous_upload".
  - Each module is a part of type `application/javascript+module`.
- Node's built-in `fetch` and `FormData` send this body, so no new dependency is needed.
- OpsCrew already relies on `keep_bindings = ["secret_text", "plain_text"]` in
  `packages/iac-templates/modules/cloudflare-workers/main.tf`. The uptime Worker's upload sends
  `keep_bindings: ["secret_text"]`, so re-uploading the script keeps every app's webhook secret.

Secrets: <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/>

- `PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets` with
  `{ "name", "text", "type": "secret_text" }`. It creates a new version with that secret.
- Each app writes only its own secret's name, so two apps never write the same one.
- Listing a Worker's secrets and deleting one by name are documented beside it, under
  `…/scripts/{script_name}/secrets`. The build checks the exact paths in the same API reference.

Permissions for all of R4: Workers Scripts Write.

**To confirm in the live pass:**
- that a secret's `PUT` also deploys the new version, as Wrangler's `secret put` does;
- that an upload which happens at the same moment as another app's secret `PUT` keeps that secret.

The apply checks the second at its end (plan.md, 3.).

## R5. `fetch()` and certificates

- **The certificate.** <https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-526/>
  - Subrequests from Workers to hostnames that Cloudflare doesn't proxy "are always made using the
    Full (strict) SSL mode". Error 526 means "Cloudflare is unable to verify the SSL certificate on
    your origin server".
  - So a Worker's `fetch()` never accepts an invalid certificate. It gets a 526 response, not an
    exception, and the Worker reports 525 and 526 as "an invalid certificate".
  - A proxied hostname is served with Cloudflare's own edge certificate, and Cloudflare reports
    its origin's invalid certificate with the same 526 under Full (strict), which OpsCrew's
    `opscrew-strict-tls` rule sets.
- **Redirects and timeouts.** <https://developers.cloudflare.com/workers/runtime-apis/request/>
  - `redirect` supports `follow` (the default) and `manual`, and `error` throws. The Worker sends
    `redirect: "manual"`, so a 3xx counts as an answer, as in the Actions check.
  - `signal` takes an `AbortSignal`, so a fetch is cut off with `AbortSignal.timeout(10_000)`.
- **Cloudflare's own errors.** A Cloudflare error from 520 to 524, or 530, is Cloudflare saying
  the origin didn't answer. The Worker reports it as "not reachable", and so it reports a network
  error or a timeout.

## R5b. The retry (the lead's decision, 2026-11-25)

- **The rule:** one try per hostname per run, with a 10-second timeout and redirects not followed.
  - The first failure records `suspect` in KV.
  - The second failure in a row, at the next run 5 minutes later, records `down` and posts.
  - A success clears `suspect` silently, or posts "recovered" from `down`.
- **Why across runs, not inside one:**
  - A blip as long as a deploy's restart doesn't alert.
  - The cap is 40 hostnames instead of 12, and a run lasts seconds, not minutes.
  - The cost is one KV write per isolated failure, and an alert about 5 minutes later than the
    Actions check's rule (three tries 30 seconds apart within one run).

## R6. Terraform's resources, and why they aren't used

Source: <https://raw.githubusercontent.com/cloudflare/terraform-provider-cloudflare/main/docs/resources/workers_cron_trigger.md>

- Provider 5 (OpsCrew pins `~> 5.27`) has `cloudflare_workers_cron_trigger` (`account_id`,
  `script_name`, `schedules = [{ cron }]`).
- Beside it are `cloudflare_workers_script` (bindings, `secret_text` among them),
  `cloudflare_workers_kv_namespace` and `cloudflare_workers_kv`.
- **Why not Terraform:** each OpsCrew app has its own Terraform state, and one Worker that every
  app in the account shares can't belong to any one app's state. A second app's apply would try to
  create it again, and the first app's destroy would delete it under the others.
- **ADR 0014 is the same problem, already solved:** a zone's rule sets and the account's Zero
  Trust organization left Terraform for the typed Cloudflare shared-resources adapter
  (`packages/connectors/cloudflare/src/shared.ts`), with `cloudflare-apply` approvals bound to the
  plan's hash and a re-read before writing.
- Constitution I already names that adapter "for Cloudflare resources several OpsCrew apps share".
  The uptime Worker follows the same path: a new module of the same connector, with no
  constitution change, no new approval kind and no new dependency.

## R7. How OpsCrew does it today (repository)

- **The Actions check:**
  - The script is `packages/iac-templates/check/check.mjs`, embedded by
    `packages/iac-templates/scripts/gen-modules.ts` into `src/generated/check.ts`, and rendered by
    `renderCheck` (`packages/iac-templates/src/check/index.ts`).
  - Its thresholds are 3 tries, 30 seconds apart, and a 10-second timeout.
  - The settings are `ObservabilityCheckSchema` (`packages/plan-schema/src/plan.ts`). `intervalMinutes` and
    `webhook` are the repository's, set only in `opscrew/plan.yaml`
    (`packages/agents/src/check/settings.ts`).
  - The webhook's address comes from `OPSCREW_CHECK_WEBHOOK` or a prompt
    (`askCheckWebhook`, `packages/agents/src/check/secrets.ts`), and ntfy's token from
    `OPSCREW_CHECK_NTFY_TOKEN`.
- **Where provision and destroy touch the check:** provision calls `provisionCheck` and
  `resumeCheck` near its end (`packages/agents/src/check/provision.ts`). Every destroy flow calls
  `pauseCheckForTeardown` (`packages/agents/src/destroy/common.ts`), under its typed confirmation
  with `checkPauseNote`.
- **Cloudflare Workers today:**
  - An app on Cloudflare's hosting gets its Worker's shell from Terraform
    (`modules/cloudflare-workers`), and the deploy workflow uploads its code with Wrangler.
  - The typed client (`packages/connectors/cloudflare/src/client.ts`) reads Worker versions,
    deployments, domains, logs and analytics, and has no script upload, schedules, KV or secret
    write yet.

## R8. The server's reports: limits and the workers.dev address (2026-11-25)

The founder's extension: with `runner: cloudflare` the server reports its own checks, so nothing
needs Actions.

- **KV writes:** 1,000 a day per account on the free plan, reset at 00:00 UTC, with 1 write per
  second to one key. See R3 and its sources, <https://developers.cloudflare.com/kv/platform/limits/>
  and <https://developers.cloudflare.com/kv/platform/pricing/>.
  - A healthy server costs one write a day, its heartbeat.
  - A change costs one write, as does a "stopped" or "resumed" alert.
  - 40 servers (the most the 40-hostname cap allows) cost about 40 writes a day when healthy. A
    report every 5 minutes would cost 288 writes a day per server, which is why the server
    reports only on change.
- **Requests:** 100,000 a day per account on the free plan, reset at 00:00 UTC
  (<https://developers.cloudflare.com/workers/platform/limits/>).
  - Cron runs are invocations, not requests. Reports are a few a day per server.
  - Unsigned requests from anyone also count. The Worker refuses them before any KV operation, so
    they cost requests and no KV.
  - The guide names the risk: a flood would hold the user's other Workers back until 00:00 UTC.
- **The workers.dev address:**
  - <https://developers.cloudflare.com/workers/configuration/routing/workers-dev/>: a Worker's
    route is `<worker>.<account subdomain>.workers.dev`, and an account "comes with" a workers.dev
    subdomain.
  - Each Worker can turn it on or off, in the dashboard or with Wrangler's `workers_dev`. The page
    doesn't say what an upload through the API sets by default.
  - It is treated as a Free website. Browser Integrity Check always applies and refuses some
    default library User-Agents (error 1010), so the server's `curl` sends
    `User-Agent: OpsCrew uptime report`.
  - <https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/subdomain/methods/create/>:
    `POST /accounts/{account_id}/workers/scripts/{script_name}/subdomain` with `{ "enabled": true,
    "previews_enabled": false }` (Workers Scripts Write). No defaults are stated.
  - So the adapter sets it explicitly, the way `modules/cloudflare-workers` does with
    `cloudflare_workers_script_subdomain`.
  - <https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/get/>:
    `GET /accounts/{account_id}/workers/subdomain` returns `result.subdomain`. The page doesn't
    say what an account without one gets, so a 404 or an empty value is a finding (spec,
    edge cases).

## R9. What the server reads, and the thresholds (repository)

- **The sources:** `CHECK_COMMAND` in `packages/iac-templates/check/check.mjs`, copied as
  `CHECK_KEY_COMMAND` in `@opscrew/connector-ssh-host`. It reads:
  - `df -P -B1 /`;
  - per app folder `/srv/apps/<app>/`, `.snapshots/scheduled.log`: when it was last written, the
    last snapshot id line, and how many lines follow it;
  - a `.partial` folder while `.start.lock` is held, meaning a snapshot is being taken;
  - the last scheduled line of `.snapshots/drills.log`, with its end time and result;
  - the times of `.drill-recipe/schedule` and of the oldest snapshot.
- **The rules,** in `check.mjs`:
  - **The disk:** `THRESHOLDS` `diskWarn` 85 and `diskHigh` 95, as a percentage rounded up from
    used over used plus free.
  - **The snapshot:** `scheduledFailed`. It failed without an id line, and only its copy failed
    with lines after the id. It is unknown while a snapshot is being taken.
  - **The drill:**
    - `not-restored`, `unhealthy` and `failed` fail;
    - it is late when none ran within twice its period (`weekly` or `daily`) plus an hour
      (`DRILL_GRACE_MS`), counted from the last one;
    - with none yet, it is late counted from `since`.
  - There is no age threshold for a snapshot. A missed slot shows only through `scheduled.log`, so
    the server applies the same rule.
  - **The certificate:** `checkCertificate` fails under `certDays` (14), reading the days left of
    what the hostname serves over TLS. On the server, `openssl s_client` to `127.0.0.1:443`, with
    the hostname as SNI, reads what Caddy serves. Caddy's own files sit in its data volume, which
    only root can read, so they aren't read.
  - **The credential:** `checkCredential` fails when a credential was made or last rotated more
    than `maxAgeDays` ago (default 365, `credentials.maxAgeDays`). Its date is the last
    rotation, else when it was made, else the first deploy (`credentialsOf` in `renderCheck`).
    Those dates are names and times only, so they may sit in the server's config.
- **Who runs it:** the check key's command runs as the deploy user, so the timer runs as the
  deploy user too. The key and the config reach it through systemd's `LoadCredential=` from 0600
  root files, as the home address updater's token does (`dns-updater.ts`, feature 029).
- **The HMAC:** with `openssl dgst -sha256 -mac HMAC -macopt hexkey:…`, the key is on `openssl`'s
  command line for the few milliseconds the process runs. Local users with a shell could read it
  in `/proc`, and containers can't, since they have their own PID namespace.
  - The build checks whether the server's OpenSSL can read the key from a file or from standard
    input instead, and uses that when it can.
  - Otherwise the plan, the design summary and the guide say what the key can do: send reports
    for this one environment.
