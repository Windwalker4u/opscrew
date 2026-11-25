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
- **IV. Secrets:**
  - The webhook's address is only a Worker secret. Its value is never in a plan, a hash, a log, a
    KV value or a file, and the plan names only the secret.
  - A message never carries the app's answer, its headers or an address.
  - The Worker holds no GitHub or Cloudflare token. **Pass.**
- **VII. Test first:**
  - The script's state machine is tested over several runs, with a fake KV, fetch and clock.
  - The adapter is tested with an injected `fetch` fake of the Cloudflare API.
  - The agents' wiring is tested with the existing fakes.
  - Nothing live in tests. The live pass is the lead's, on the founder's account (T4692). **Pass.**
- **X. Simplicity:**
  - No new dependency, no new approval kind, no constitution change.
  - The webhook stays the repository's setting.
  - An empty Worker stays until a destroy, so there is no extra confirmation flow.
  - Left out of v1 (the lead's decisions of 2026-11-25): a maintenance pause, a per-entry
    interval, and the disk, snapshot, restore-drill and certificate-days checks. **Pass.**

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
  - **What it prints:** when the runner is `cloudflare`, provision says "The disk, snapshot,
    restore-drill and certificate-days checks need `runner: actions`."
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
  line as provision ("The disk, snapshot, restore-drill and certificate-days checks need
  `runner: actions`."), and states the 40-hostname cap.
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
  - what it doesn't check, said plainly: "these checks need `runner: actions`";
  - the first run's delay of up to 15 minutes;
  - no maintenance pause: a move or retarget may post a down and a recovered message;
  - `cloudflare-move` needs `runner: actions` first;
  - turning it off: the entry goes and the empty Worker stays until the last app's destroy.
- **`docs/guide/security.md`:** the token list gains Workers KV Storage → Edit, marked "only with
  the Cloudflare uptime check".

## Order

- **Wave 1, in parallel:** T4601 (the schema, which the lead approves), T4602 (the script), T4603
  (the adapter).
- **Wave 2, in parallel:** T4604 (the agents, which needs all of wave 1) and T4605 (the guide).
- **The lead's wave:** a fresh review, `/simplify`, the live pass (the lead's, on the founder's
  account), and the changelog line.

## Complexity Tracking

| Choice | Why not simpler |
|---|---|
| A typed adapter, not Terraform | The Worker is shared by apps with separate states (research R6, ADR 0014) |
| A KV key and a secret per entry | No read-modify-write of a shared list, so two apps never overwrite each other |
| A cap of 40 hostnames | The free plan's 50 subrequests per run: one fetch each, plus room for posts (research R1) |
| A `suspect` state in KV | The retry across runs needs one remembered failure (research R5b) |
