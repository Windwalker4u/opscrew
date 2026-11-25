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

**What the live pass (T4692) showed:**
- A secret's `PUT` also deploys the new version, as Wrangler's `secret put` does.
- An upload at the same moment as another app's secret `PUT` does not keep that secret: the
  secret is lost. So the apply reads its secret and its entry back at its end, and when either
  is missing it fails, reporting no success: "Another app changed the shared uptime Worker at
  the same moment, so this app's settings didn't stick. Run provision again."

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
