# Implementation Plan: An uptime check that doesn't use GitHub Actions

**Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md) ·
**Data model**: [data-model.md](data-model.md)

## Summary

One Worker per Cloudflare account, `opscrew-uptime`, fetches every 5 minutes the health path of
each hostname that an environment with `observability.check.runner: cloudflare` lists. It posts
down and recovered messages to that environment's webhook, and keeps the down hostnames in Workers
KV, written only on change. OpsCrew manages the Worker through a new module of the typed Cloudflare
shared-resources adapter (ADR 0014), not Terraform. Each app's plan is approved by its hash
(`cloudflare-apply`), and each app writes only its own KV keys and its own secret.

With the founder's extension (User Story 4), each server of such an environment checks its own
disk, last snapshot and last restore drill with a systemd timer that a host plan installs. It
reports to the Worker's workers.dev address, signed, only on a change and once a day, so nothing
of that environment needs GitHub Actions (section 6).

## Technical Context

- **Code:** TypeScript strict ESM, in the packages `plan-schema`, `iac-templates`,
  `connector-cloudflare` and `agents`.
- **The Worker's script:** plain ES module JavaScript, with no imports.
- **Dependencies:** none new. The upload uses Node's built-in `fetch` and `FormData`.
- **Tests:** Vitest with fakes, run as `pnpm turbo run typecheck test --filter=<pkg>`.
- **Limits (research R1, R3):** at most 40 hostnames per account. A run makes 1 list request,
  2 reads per entry and 1 fetch per hostname, and lasts seconds. CPU stays well under 10 ms: the
  script does little apart from waiting on `fetch`.

## Constitution Check

- **I. Safety gate:**
  - Every change (script, trigger, namespace, entry, secret) is in a plan approved by its SHA-256
    hash, as `cloudflare-apply`, the approval kind of the Cloudflare shared-resources adapter that
    Principle I already names.
  - Only a `destroy` that removes the last entry deletes the Worker and the namespace, under
    that destroy's own `allowDestroy` and typed confirmation. Provision never deletes them.
  - The apply re-reads before it writes, and every change is audited.
  - The Worker itself changes nothing in the account: it only fetches, writes its own state keys
    and posts to the webhook, so it is no standing approval. **Pass.**
  - The server's timer is installed, changed and removed only by the host step `uptime-report`,
    in a host plan approved by its hash (ADR 0011). It changes nothing: it reads files and sends
    a report.
  - The Worker's `fetch` handler only verifies a report, writes that server's own `report:` key
    and posts to the webhook. **Pass.**
- **IV. Secrets:**
  - The webhook's address is only a Worker secret. Its value is never in a plan, a hash, a log, a
    KV value or a file, and the plan names only the secret.
  - A message never carries the app's answer, its headers or an address.
  - The Worker holds no GitHub or Cloudflare token.
  - The report key exists in three places only: a 0600 root file on each server, the entry's
    Worker secret, and the OpsCrew home. It reaches the server on standard input, and a plan
    names it by its SHA-256.
  - A leaked key can only send reports for that one environment, which the guide says (research
    R9 on `openssl`'s command line). **Pass.**
- **VII. Test first:**
  - The script's state machine is tested over several runs, with a fake KV, fetch and clock.
  - The adapter is tested with an injected `fetch` fake of the Cloudflare API.
  - The agents' wiring is tested with the existing fakes.
  - The server's script runs in the ssh-host shell harness against fixture files, with parity
    tests against `check.mjs`'s rules on the same fixtures.
  - Nothing live in tests. The live pass is the lead's, on the founder's account (T4692). **Pass.**
- **X. Simplicity:**
  - No new dependency, no new approval kind, no constitution change.
  - The webhook stays the repository's setting.
  - An empty Worker stays until a destroy, so there is no extra confirmation flow.
  - Left out of v1 (the lead's decisions of 2026-11-25): a maintenance pause and a per-entry
    interval. The server checks (section 6)
    reuse the address updater's pattern: a POSIX script, systemd template units and a host step.
    **Pass.**

## Design

### 1. The setting (`packages/plan-schema`, T4601)

- **The field:** `runner` in `ObservabilityCheckSchema`, as data-model.md shows.
- **The refusal:** a `checkObservability` refusal of `runner: cloudflare` without
  `dns.provider: cloudflare`.
- **The rest:** the JSON schema and its snapshot follow, if `json-schema.ts` derives them, and the
  tests sit beside the existing ones in `observability.test.ts`.

The lead approves this change, since `plan-schema` is shared.

### 2. The Worker's script (`packages/iac-templates/uptime/`, T4602)

`uptime/worker.mjs`, with its types in `uptime/worker.d.mts` as `check/check.d.mts` has them.

- **`export async function runUptime(env, io)`:** the whole run.
  - `env` is `{ UPTIME: KVNamespace, [HOOK_…]: string }`.
  - `io` is `{ fetch, now }`, injected so tests need no globals.
- **`export default { async scheduled(controller, env, ctx) { … } }`:** calls `runUptime` with
  the runtime's `fetch` and `Date.now`, inside `ctx.waitUntil`.
- **The steps of a run:**
  1. `list({ prefix: "entry:" })`, then a `get` of each entry and its `state:` key.
  2. One try per hostname, through a pool of 5 at once:
     `fetch("https://" + hostname + healthPath, { redirect: "manual", signal:
     AbortSignal.timeout(10_000), headers: { "user-agent": "OpsCrew uptime check" } })`. A status
     from 200 to 399 is up. Anything else is a failure, with its reason (FR-010).
  3. Each hostname's next state follows data-model.md's table: `suspect` after one failure,
     `down` after two in a row.
  4. The posts, one per hostname that went `down` or recovered from it, go to the address in
     `env[entry.secret]`.
     - **The budget:** a run sends at most `50 − fetches made` posts, and the ones past it wait
       for the next run.
     - **Writing:** an entry's state is written (or its key deleted, when it holds no hostname)
       only when it changed. A change that posts counts only once its post was accepted (2xx). A
       failed or waiting post leaves that hostname's old state, so the next run posts again.
     - **A missing secret:** an entry whose secret is missing logs one line and writes no change
       that would post.
  5. Each run logs one line per entry: its id and its counts of hostnames up, `suspect` and
     `down`. It logs no address.
- **Message formats,** the same as `check.mjs`'s:
  - Slack: `{ text }`, cut at 4,000 characters.
  - Discord: `{ content, allowed_mentions: { parse: [] } }`, cut at 2,000.
  - ntfy: a plain-text body, with the headers `Title`, `Priority` (4 down, 3 up), and
    `Authorization: Bearer <token>` when the secret has one.
- **The texts:**
  - Down: `OpsCrew uptime check: <app> (<env>) is down on <hostname>: <reason>, since <UTC time>.
    Run npx opscrew status to see more.`
  - Up: `OpsCrew uptime check: <app> (<env>) is up again on <hostname>, after <duration>.`
- **The retry,** across runs and not inside one (the lead's decision, research R5b):
  - Two failures in a row, 5 minutes apart, alert. One blip, or a container restarting during a
    deploy, never does.
  - It allows 40 hostnames (research R1). A run of 40 takes at most 8 rounds of 10 seconds.
  - It costs one KV write per isolated failure (`suspect`, then cleared).

**Embedding the script:**
- `scripts/gen-modules.ts` also embeds `uptime/worker.mjs` into `src/generated/uptime.ts`, as
  `UPTIME_WORKER_SCRIPT` and its `UPTIME_WORKER_SHA256`.
- `src/uptime/index.ts` exports them from the package root, beside `UPTIME_WORKER`:
  `{ name: "opscrew-uptime", namespace: "opscrew-uptime", binding: "UPTIME", cron: "*/5 * * * *",
  compatibilityDate: "2026-10-01", maxHostnames: 40, subrequests: 50 }`.
- A test fails when the generated file is stale, as the check's does.

`src/check/index.ts` also exports `checkHosts(plan)`, the hosts and health path that `renderCheck`
uses today, so the entry lists the same hostnames. This export is T4602's; `renderCheck`'s skip
of `runner: cloudflare` is T4604's, after the schema.

### 3. The adapter (`packages/connectors/cloudflare/src/uptime.ts`, T4603)

**New client methods (`client.ts`),** each with its fake-`fetch` test, and the paths checked
against research R2 to R4:

- `listKvNamespaces`, `createKvNamespace` (it maps the duplicate-title 400 to a typed error),
  `deleteKvNamespace`;
- `listKvKeys(prefix)`, `getKv`, `putKv`, `deleteKv`;
- `uploadWorkerModule(accountId, name, { content, compatibilityDate, bindings, keepBindings })`,
  a multipart upload through `FormData`;
- `putWorkerSchedules`, `deleteWorkerScript`;
- `listWorkerSecrets`, `putWorkerSecret`, `deleteWorkerSecret`.

`CLOUDFLARE_UPTIME_PERMISSIONS` holds "Account → Workers Scripts → Edit" and "Account → Workers KV
Storage → Edit". It is exported and checked with the existing `accountPermissions`.

**`inspectUptime(client, accountId)`** only reads:
- the namespace, by its title;
- the `opscrew:worker` key;
- the `entry:` keys and their values;
- whether the script exists, and its secrets' names.

**`planUptime(facts, desired)`** makes the plan in data-model.md. It is pure, and its hash covers
`accountId`, `changes` and `expect`.
- **Shared pieces:** it creates the namespace, the script and the schedule only when missing, and
  uploads the script when its SHA-256 differs.
- **Its own entry:** `put-entry` when it differs, and `put-secret` only when `desired.secret` is
  given.
  - With no secret given and none stored, the plan has a finding instead. The agents ask for the
    address before planning.
- **Removal:** with no desired entry, it plans `delete-entry` and `delete-secret`.
  - Only with `desired.destroy` and no other entry left does it add `delete-script` and
    `delete-namespace` (`destroys: true`).
  - Without `desired.destroy`, as in provision, the Worker, its trigger and the namespace stay,
    even with no entry left.
- **The cap:** a finding when the other entries' hostnames plus this entry's pass 40. Its message
  names the cap and the hostnames already counted, and its hint says to keep `runner: actions`
  for this app.
- **The words:** `describeUptimePlan(plan)` gives the plan in plain English. It names each
  change, and "Keeps the entries of: acme/blog (prod), acme/shop (staging)".

**`applyUptime(client, plan, desired, approvedHash)`:**
- **Before writing:** it refuses a hash that differs. It reads the entries' keys, the
  `opscrew:worker` key and the namespace again, and stops with "changed since the plan" when they
  differ from `expect`.
- **Order:** it applies in the order of data-model.md, and `put-entry` comes last, so the Worker
  never reads an entry whose secret isn't set yet.
- **Two apps at once:**
  - A `create-namespace` that fails because the title already exists lists the namespaces and
    uses that one.
  - After an `upload-script`, it writes `opscrew:worker`. An `upload-script` sends
    `keep_bindings: ["secret_text"]` and binds `UPTIME` to the namespace id.
- **Removing the last entry in a destroy:** just before `delete-script`, it lists the `entry:` keys again.
  When any other key is there, it skips both deletes and reports that the Worker stays for that
  entry.
- **At the end:** it reads its secret's name and its entry back. A missing one (a concurrent
  upload dropped it) fails with "run the command again", which puts it back.
- **Results:** it returns what it applied, and on a failure part-way, an error that lists the
  changes already made, as `SharedApplyError` does.

**What concurrency can't catch,** as ADR 0014 puts it ("caught by the re-check, not prevented"):

- **A provision against the last destroy:** an entry written after the destroy's last re-read
  loses the Worker.
  - The next run of that app's provision creates it again, since every step is idempotent.
  - `status` reads whether the Worker and the entry exist, and says to run `provision` when
    either is gone.
- **KV's eventual consistency:** a just-written key can take up to a minute to show in a list. The
  re-read narrows the window and doesn't close it.

### 4. The agents (`packages/agents`, T4604)

- **Settings** (`check/settings.ts`): `checkRunner(plan)` returns `"actions"` when absent.
  `requireUptimeWebhook(paths, plan)` is called where `requireCheckSettingsPlace` is (provision
  and design). It refuses `runner: cloudflare` when the repository's settings have no webhook,
  with `ARTIFACT_INVALID` and the hint to set `observability.check.webhook` in `opscrew/plan.yaml`.
- **The entry** (`check/uptime.ts`, new): `uptimeEntry(plan, repository)` builds the entry from
  `checkHosts(plan)`. `uptimeId(plan, repository)` gives the key.
- **Provision** (`check/provision.ts`): `provisionCheck` with runner `cloudflare` skips the check
  key and the GitHub secrets.
  - **The plan:** it inspects the account of the app's zone, with the same Cloudflare client as
    the shared plan. It takes the webhook's address from `OPSCREW_CHECK_WEBHOOK`, or asks with
    `askCheckWebhook` when the entry's secret doesn't exist yet.
  - **The approval and the apply:** it shows `describeUptimePlan`, asks for the
    `cloudflare-apply` approval by hash, and applies.
  - **`--plan-only`** lists the uptime plan's hash next to the others.
  - **Leaving the Worker:** an environment whose plan no longer chooses it (`actions`, or the check
    off) while an entry exists gets the removal plan instead, without `destroy`. Only its entry,
    state and secret go.
  - **What it prints:** on a target with no server checks, provision says "This target has no server OpsCrew reaches, so the Worker checks its address only: the disk, snapshot, restore-drill, certificate-days and credential-age checks need `runner: actions`."
  - **Pausing:** none in v1. `resumeCheck` and the move and retarget pauses change nothing for a
    Cloudflare environment.
- **Rendering:** `renderCheck` (`packages/iac-templates/src/check/index.ts`) leaves out plans with
  `runner: cloudflare`. The existing removal of the workflow follows when no environment is left.
- **Destroy** (`destroy/common.ts` and the flows that call `pauseCheckForTeardown`): with runner
  `cloudflare`, `checkPauseNote` instead says that the uptime entry is removed, and with the last
  entry, the Worker.
  - The removal is planned before the typed confirmation, and its hash is printed with the
    others.
  - Where the pause runs today, it is applied with `desired.destroy`, under that confirmation
    (`allowDestroy`). No other confirmation is asked.
- **`status`** (`status/check-state.ts`): for a Cloudflare environment, it reads the entry and the
  state from KV and reports "Checked every 5 minutes by the Cloudflare Worker opscrew-uptime",
  with the hostnames down and their times. A missing entry or Worker says to run `provision`.
- **Design** (`check/design.ts`): shows no Actions minutes for the environment, prints the same
  line as provision on a target with no server checks, and states the 40-hostname cap.
- **Init** (`init/checks.ts`): when a plan chooses `cloudflare`, it checks
  `CLOUDFLARE_UPTIME_PERMISSIONS` and names any that is missing.
- **Cloudflare move** (`cloudflare-move/prepare.ts`): it refuses an app with an uptime entry, and
  says to switch `observability.check.runner` to `actions` and provision first.

### 5. The guide (T4605)

- **`docs/guide/alerts.md`:** a section "In your Cloudflare account instead of GitHub Actions". It
  covers:
  - the setting, and what it needs (DNS on Cloudflare, a webhook, the two token permissions);
  - what the plan shows, and the shared Worker;
  - what counts as down: one try per run, and two failures in a row, with the reasons;
  - the messages;
  - the free limits (5 Cron Triggers, 40 hostnames, KV shared with the user's own Workers);
  - which targets have no server checks, said plainly, with design's line;
  - the first run's delay of up to 15 minutes;
  - no maintenance pause: a move or retarget may post a down and a recovered message;
  - `cloudflare-move` needs `runner: actions` first;
  - turning it off: the entry goes and the empty Worker stays until the last app's destroy.
- **`docs/guide/security.md`:** the token list gains Workers KV Storage → Edit, marked "only with
  the Cloudflare uptime check".

### 6. Server reports (User Story 4, T4606 to T4610)

The lead's design (2026-11-25), from the founder's extension.

**6.1 The server's script and host step (`packages/connectors/ssh-host`, T4607).** This is a new
host step, `uptime-report`, built like `dns-updater` (`dns-updater.ts`, and its part of
`steps.ts`).

- **What it installs:** a versioned POSIX script, two systemd template units, and per instance
  (`<hex16>`) a config and a key file, 0600 root (data-model.md). The units:
  - run the script as the deploy user, the user the check key's command already runs as;
  - hand it the config and the key through `LoadCredential=`;
  - give it a `StateDirectory`;
  - run it from a timer every 5 minutes.
- **Packages:** the step installs `curl` and `openssl` when the server lacks them, as
  `dns-updater` does with `curl` and `jq`.
- **The script's checks:** it reads its own app folder's files as `CHECK_KEY_COMMAND` reads them,
  and evaluates them against research R9's rules. Its texts are statuses only.
  - **Certificates:** for each of the app's hostnames in its config, `openssl s_client -connect
    127.0.0.1:443 -servername <hostname>`, then `openssl x509 -noout -enddate`, gives the days
    left against `cert_days` (14). This reads what Caddy serves, with no root and no access to
    its data volume, which only root can read. No TLS answer gives `none`.
  - **Credentials:** once a day (the state file keeps when), each `credential=` line of its config
    is compared with `max_age_days`, as `check.mjs`'s `checkCredential` does.
- **When it sends:** when the statuses differ from its state file, or 24 hours after its last
  report. It signs the report (research R9 on the key's handling), sends it with `curl --max-time
  20`, and updates the state file only on a 2xx. It logs one line per run to the journal, with
  the statuses, and never the key, the URL's answer or a log line.
- **Its parts:**
  - inspection reads whether the instance exists, its version, and its config's and key's
    SHA-256;
  - the plan adds or replaces the instance, with the key's SHA-256 in its params, never the key;
  - removal stops and deletes the instance, and the script and units once no instance is left;
  - verify runs the service once and reads its journal line.
- **The key** reaches the step on standard input, like the address updater's token.

**6.2 The Worker (`packages/iac-templates/uptime/worker.mjs`, T4606).**

- **The `fetch` handler:** `POST /report` only, and 404 for anything else. It checks, in order:
  - the body's size;
  - the headers;
  - the entry's secret, by its computed name, with no KV operation;
  - the HMAC, with `crypto.subtle.verify`;
  - the time's skew, within 5 minutes.

  Only then does it read the entry, refusing a server it doesn't list, and the server's
  `report:` key, refusing a time that isn't newer.
  - For each check whose status changed (`unknown` never counts), it posts the Actions check's
    text through the entry's webhook.
  - It then writes the `report:` key, with metadata `{ at }`.
  - A failed post answers 502 and writes nothing.
  - The answers are plain: 204, 400, 401, 404, 409, 413 or 502, each with no body.
- **The cron:**
  - Its one list per run lists every key, with metadata, instead of only `entry:`.
  - For each listed server whose last report, or its `since`, is over 26 hours old, it posts
    "reports from <app> (<env>) on <server> stopped" once and records it in `state:`.
  - When a newer report has come, it posts "reports resumed" and clears that record.
  - The hostname checks are unchanged.
- **The texts** come from `check.mjs`'s titles and what-lines:
  - disk over 85% or 95% full;
  - the scheduled snapshot failed, or its off-server copy failed;
  - a drill failed, or none ran within twice the schedule;
  - a certificate expires within 14 days, or has expired;
  - a credential is older than `maxAgeDays`, with `npx opscrew rotate <name><flags>`, the flags
    taken from the entry's `rotate`.
- **The heartbeat limit** is `entry.heartbeatMinutes`, when that is between 5 and 1,560, and 26
  hours otherwise. Each "recovered" text names the check and how long it lasted.

**6.3 The adapter (`packages/connectors/cloudflare/src/uptime.ts`, T4608).**

- **The client:** gains `getWorkersSubdomain(accountId)` and `setWorkerSubdomain(accountId,
  name, { enabled, previewsEnabled })` (research R8).
- **`inspectUptime`** reads the account's subdomain and whether the script's workers.dev is on.
- **`planUptime`:**
  - adds `set-subdomain` when it is off;
  - carries `servers[].since` over from the existing entry;
  - adds `delete-report` for each `report:` key of a server that left;
  - gives the finding `workers-dev-missing` without an account subdomain;
  - returns the report URL.
- **`delete-entry`** deletes the entry's `report:` keys too.
- **The secret's value** gains `report`. Its hash stays out of the plan.

**6.4 The agents (`packages/agents`, T4609).**

- **The report key:** `ensureReportKey(paths, plan)` keeps 32 random bytes per environment as a
  secret file in the OpsCrew home, like the check key (`check/key.ts`), with randomness
  injected.
  - A new key, whose old file was lost, makes provision write the entry's secret again, with the
    webhook's address asked as for a changed address.
- **Provision:** with `runner: cloudflare`, where `checkKeyStep` runs today and for the same
  servers, `provisionCheck` plans the host step `uptime-report` per server.
  - It plans it with the report URL from the Cloudflare plan, the entry id, the server id, the
    app folder, the drill schedule, the thresholds, the hostnames whose certificates the server
    serves, and, with `observability.check.credentials` on, each credential's name and date and
    `maxAgeDays`. The dates are the same ones `renderCheck`'s `credentialsOf` gives `check.json`.
  - **After a rotation:** `opscrew rotate` writes the new date the same way, as
    `rotate/dns-updater.ts` replaces the address updater's token: the server's host plan, with
    the step's new config SHA-256, is approved by its hash.
  - The step goes through the existing host-plan approval by hash.
  - The Cloudflare plan comes first, so the Worker accepts the first report.
  - The entry lists the servers that got the step.
  - A server provision can't reach with a host plan is named in design's summary and gets no
    timer.
- **Leaving:** `runner: actions`, or the check off, plans the step's removal on each server, as
  well as the entry's removal.
- **Destroy:** a server the destroy keeps (the user's own) gets the step's removal in the
  teardown's host plan, under its typed confirmation. A server the destroy deletes needs none.
- **`status`:** for each listed server, it reads its `report:` key and shows the last report's
  time and statuses, and "reports stopped" when it is over 26 hours old.
- **Design:** for Portainer, Cloudflare's hosting and GitHub Pages it prints the line of 4.
  (hosting accounts are refused already).

**6.5 The guide (T4610).** In `alerts.md`'s Cloudflare section:

- what the server checks and how it reports;
- the timer, and how to see it (`systemctl list-timers 'opscrew-uptime-report@*'`);
- the report key, and what a leaked one can do: send reports for one environment;
- the certificates' and credentials' checks on the server, and that `opscrew rotate` updates the
  dates there;
- the 26-hour silence alert;
- the targets with no server checks;
- the workers.dev address, and the requests it can receive.

## Order

- **Wave 1, in parallel:** T4601 (the schema, which the lead approves), T4602 (the script), T4603
  (the adapter).
- **Wave 2, in parallel:** T4604 (the agents, which needs all of wave 1) and T4605 (the guide).
- **Wave 3, in parallel:** T4606 (the Worker's report handler), T4607 (the server's host step),
  T4608 (the adapter's additions) and T4610 (the guide's server part).
- **Wave 4:** T4609 (the agents' server reports, which needs wave 3).
- **The lead's wave:** a fresh review, `/simplify`, the live pass (the lead's, on the founder's
  account), and the changelog line.

## Complexity Tracking

| Choice | Why not simpler |
|---|---|
| A typed adapter, not Terraform | The Worker is shared by apps with separate states (research R6, ADR 0014) |
| A KV key and a secret per entry | No read-modify-write of a shared list, so two apps never overwrite each other |
| A cap of 40 hostnames | The free plan's 50 subrequests per run: one fetch each, plus room for posts (research R1) |
| A `suspect` state in KV | The retry across runs needs one remembered failure (research R5b) |
| Reports only on change, plus a daily heartbeat | KV's 1,000 free writes a day (research R8) |
| A timer by host plan, not a container | It must work when the app's containers don't; it reuses the address updater's pattern (feature 029) |
| One writer per KV key | The `fetch` handler and the cron run at once, and KV has no lock |
