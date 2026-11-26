# Tasks: An uptime check that doesn't use GitHub Actions

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [quickstart.md](quickstart.md).

Four build waves, then the lead's. Waves 3 and 4 are User Story 4 (the founder, 2026-11-25). Inside a wave, no two tasks share an Owns path.

## Wave 1

- [x] T4601 [US3] The setting `observability.check.runner` (the lead approves: `plan-schema` is
  shared)
  - **Owns:** `packages/plan-schema/src/**`.
  - **Reads:** plan.md 1., data-model.md "The plan's field", `observability.test.ts`.
  - **Depends:** none.
  - **Accept:**
    - **The field:** `ObservabilityCheckSchema.runner` takes `"actions"` or `"cloudflare"`, and is
      optional. Any other value is refused with `must be "actions" or "cloudflare"`.
    - **The refusal:** `runner: "cloudflare"` with `dns.provider` other than `cloudflare` is
      refused at `observability.check.runner`, with data-model.md's message.
    - **The rest:** a plan without `runner` parses exactly as before. The type test of
      `Observability["check"]` follows, and so do the JSON schema and its snapshot, if
      `json-schema.ts` derives them.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/plan-schema && pnpm lint`
  - **Effort:** medium

- [x] T4602 [US1] The Worker's script, embedded, and `checkHosts`
  - **Owns:**
    - `packages/iac-templates/uptime/**` (new: `worker.mjs`, `worker.d.mts`);
    - `packages/iac-templates/src/uptime/**` (new: index and tests);
    - `packages/iac-templates/scripts/gen-modules.ts`;
    - `packages/iac-templates/src/generated/uptime.ts` (new);
    - `packages/iac-templates/src/check/index.ts` (only the new `checkHosts` export) and its test;
    - `packages/iac-templates/src/index.ts` (the export line).
  - **Reads:** plan.md 2., data-model.md, research R1, R2, R5, R5b, `check/check.mjs` (its webhook
    posts and texts), `src/check/check-script.test.ts`.
  - **Depends:** none.
  - **Accept:**
    - **Tests first,** over several runs, with a fake KV (a `Map` with `list({ prefix })`, counting
      writes and deletes), a fake `fetch` and a fixed clock. Every row of data-model.md's
      transition table has a test:
      - **Healthy:** an up hostname makes exactly one fetch per run, no post, and no KV write.
      - **Suspect:** one failure writes `suspect` once and posts nothing.
      - **A blip:** a success from `suspect` clears it (one write or delete) and posts nothing.
      - **Down:** a second failure in a row writes `down` once, keeps `since` from `suspect`, and
        posts one message. A third failing run posts and writes nothing.
      - **Recovered:** one 2xx or 3xx after `down` gives one "up again" post, with the duration
        since `since`, and the `state:` key is deleted.
      - **No retry inside a run:** a failing hostname is fetched once per run.
      - **A failed post:** a post answered with 500 leaves the hostname `suspect`, with nothing
        written, and the next failing run posts again.
      - **The budget:** with 40 hostnames, a run sends at most 10 posts. The rest wait unwritten
        and go out in the next run.
      - **The reasons:** a timeout (`AbortSignal.timeout(10_000)`), a thrown error, and 520 to
        524 and 530 give "not reachable"; 525 and 526 give "an invalid certificate"; a 404 gives
        "answered with status 404".
      - **No redirects:** `fetch` is called with `redirect: "manual"`, and a 301 is up.
      - **The pool:** never more than 5 fetches at once.
      - **The formats:** Slack's, Discord's (`allowed_mentions: { parse: [] }`, cut at 2,000) and
        ntfy's (`Priority` 4 or 3, `Authorization` only with a token), each checked.
      - **What a message holds:** the response's body never appears in a message or a log line,
        and neither does the webhook's address.
      - **Odd entries:** an entry whose secret is missing is skipped with one log line, and a
        hostname dropped from its entry leaves the state at the next write.
    - **The script:** `worker.mjs` has no imports. It exports `runUptime(env, io)` and a default
      `{ scheduled }` that calls it inside `ctx.waitUntil`.
    - **Embedding:** `gen-modules.ts` embeds it as `UPTIME_WORKER_SCRIPT` with
      `UPTIME_WORKER_SHA256`, and a test fails when `src/generated/uptime.ts` is stale.
      `UPTIME_WORKER` holds plan.md's constants. All are exported from the package root.
    - **`checkHosts(plan)`** returns what `renderCheck` checks for that plan: the hostnames, with
      `/` on a serverless target. `renderCheck` uses it, and its snapshots don't change.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - **Effort:** high

- [x] T4603 [US1] [US2] The uptime adapter in the Cloudflare connector
  - **Owns:** `packages/connectors/cloudflare/src/client.ts` (the new methods),
    `packages/connectors/cloudflare/src/uptime.ts` (new), `uptime.test.ts` (new),
    `client-uptime.test.ts` (new), `src/index.ts` (exports), and `src/testing/**` (a fake
    Cloudflare API for Workers, KV and secrets, if the existing fakes don't cover it).
  - **Reads:** plan.md 3., data-model.md "The adapter's plan", research R2 to R4 and R6, ADR 0014,
    `shared.ts` (its plan, hash and apply-error pattern).
  - **Depends:** none. The script's content and SHA-256 come in through `desired`.
  - **Accept:**
    - **The client methods** in plan.md 3., each tested against an injected `fetch`:
      - the method, the path and the body;
      - the multipart upload's `metadata` part, with `main_module`, `compatibility_date`, the
        `UPTIME` KV binding and `keep_bindings: ["secret_text"]`;
      - the duplicate-title 400 mapped to a typed error;
      - errors redacted, as the client's other methods redact them.
    - **`CLOUDFLARE_UPTIME_PERMISSIONS`** is exported.
    - **`planUptime`:**
      - **First app:** an empty account gives `create-namespace`, `upload-script`, `put-secret` and
        `put-entry`, in that order.
      - **Second app:** it creates nothing shared, and `describeUptimePlan` names the kept entry.
      - **Updates:** a changed SHA-256 gives `upload-script`, and an unchanged entry gives no
        `put-entry`.
      - **Secrets:** with no secret given and one stored, there's no `put-secret`. With none of
        either, a finding.
      - **Removal:**
        - with others, only `delete-entry` and `delete-secret`;
        - as the last entry without `desired.destroy` (provision), the same two, and the Worker
          and namespace stay;
        - as the last entry with `desired.destroy`, it also gives `delete-script` and
          `delete-namespace`, with `destroys: true`.
      - **The cap:** a 41st hostname in the account gives a finding whose message names the cap of
        40.
      - **The hash** is the same for the same input, changes with `expect`, and never depends on
        the secret's value.
    - **`applyUptime`:**
      - **Before writing:** it refuses a different hash. A changed `expect` (a new entry, a new
        SHA-256) stops before any write.
      - **The order** is data-model.md's.
      - **Concurrency:**
        - Two applies interleaved on one fake end with one namespace, one script and both
          entries and secrets.
        - A last-entry removal that finds a new entry at its re-read keeps the script and the
          namespace, and says so.
      - **Verification:** a secret missing at the end fails with "run the command again".
      - **A failure part-way** lists the changes already applied.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare && pnpm lint`
  - **Effort:** xhigh

## Wave 2

- [x] T4604 [US1] [US2] [US3] The agents' wiring: provision, destroy, status, design, init, moves
  - **Owns:**
    - `packages/agents/src/check/**`, with the new `uptime.ts` and its tests;
    - `packages/agents/src/destroy/{common,run,own,portainer,serverless}.ts` and their tests;
    - `packages/agents/src/status/check-state.ts` and its test;
    - `packages/agents/src/init/checks.ts` and its scheduled-check test;
    - `packages/agents/src/cloudflare-move/prepare.ts` and its test;
    - `packages/agents/src/provision/{run,portainer-flow}.ts`, only where `--plan-only` lists the
      hashes;
    - `packages/iac-templates/src/check/index.ts` (`renderCheck`'s skip) and its tests.
  - **Reads:** plan.md 4., spec.md, `check/provision.ts`, `check/secrets.ts`,
    `provision/shared-cloudflare.ts`, `destroy/shared-rules.ts`.
  - **Depends:** T4601, T4602, T4603.
  - **Accept:**
    - **Refusals:** `runner: cloudflare` without the repository's webhook is refused in provision
      and design before any change, naming `opscrew/plan.yaml`. The default stays `actions`, and
      a plan without `runner` changes nothing in any existing test.
    - **Provision:**
      - **Plan and apply:** with `runner: cloudflare`, it inspects and plans in the zone's account,
        shows the plan, asks for `cloudflare-apply` by hash, applies, and audits.
      - **Left out:** it stores no check key and no GitHub check secrets.
      - **The address:** taken from `OPSCREW_CHECK_WEBHOOK`, or asked when no secret is stored.
      - **Leaving the Worker:** an environment that turns it off, or moves back to `actions`,
        gets the removal plan without `destroy`. Its entry, state and secret go, and the Worker,
        trigger and namespace stay, even when it was the last entry. No typed confirmation is asked.
      - **What it prints:** on a target with no server checks (Portainer, Cloudflare's hosting,
        GitHub Pages), plan.md 4.'s line. On a server, nothing is left to Actions.
      - **`--plan-only`** prints the uptime plan's hash.
    - **`renderCheck`** leaves out `runner: cloudflare` plans. With only those, no workflow is
      rendered, and its files are removed as when the check is off.
    - **Destroy,** in every flow that pauses the check today:
      - the uptime removal is planned before the typed confirmation, and its words are in the
        confirmation's details;
      - it is applied with `desired.destroy` and `allowDestroy` where the pause runs, under the
        destroy's own typed confirmation, with no GitHub pause for that environment and no other
        confirmation;
      - the last entry's destroy also removes the Worker and the namespace.
    - **`status`** shows the Worker's state for the environment, and says to run `provision` when
      the entry or the Worker is missing.
    - **Design** shows no Actions minutes for it, and prints the same line as provision.
    - **No pause:** a retarget's or a move's window changes nothing for a Cloudflare environment.
    - **`init`** names a missing Workers Scripts or Workers KV Storage permission.
    - **`cloudflare-move prepare`** refuses an app with an uptime entry, saying to switch
      `observability.check.runner` to `actions` and provision first.
    - **No secret leaks:** no test output, audit entry or plan text contains the webhook's
      address.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents --filter=@opscrew/iac-templates && pnpm lint`
  - **Effort:** xhigh

- [x] T4605 [US1] The guide
  - **Owns:** `docs/guide/alerts.md`, `docs/guide/security.md` (the Cloudflare token's list).
  - **Reads:** plan.md 5., spec.md, research R1 to R5, the rest of `alerts.md`.
  - **Depends:** none in code; written from the spec, and checked against T4604 at review.
  - **Accept:**
    - **The section:** `alerts.md` gains "In your Cloudflare account instead of GitHub Actions",
      with everything plan.md 5. lists. It is plain English, says each fact once, and links the
      existing webhook section instead of repeating it. It says plainly:
      - which targets have no server checks, with design's line;
      - that there is no maintenance pause, so a move or retarget may post a down and a recovered
        message;
      - that an empty Worker stays until the last app's destroy.
    - **The opening:** its first paragraph mentions the choice in one sentence.
    - **`security.md`** lists Workers KV Storage → Edit, only for this check.
  - **Verify:** `pnpm lint`
  - **Effort:** medium

## Wave 3 (User Story 4: the server reports its own checks)

- [x] T4606 [US4] The Worker's report handler and heartbeat alert
  - **Owns:** `packages/iac-templates/uptime/**`, `packages/iac-templates/src/uptime/**`,
    `packages/iac-templates/src/generated/uptime.ts`.
  - **Reads:** plan.md 6.2, data-model.md "Server reports", research R8 and R9, spec.md User
    Story 4 and FR-018 to FR-022, `check/check.mjs` (its server checks' texts).
  - **Depends:** T4602.
  - **Accept:**
    - **Tests first,** with a fake KV (counting every operation), a fixed clock, and reports
      signed with a test key generated in the test through `crypto.subtle`:
      - **Refused with no KV operation:** a body over 4 KB, a missing or wrong signature, a time
        6 minutes off, an entry whose secret is missing, and any path or method other than
        `POST /report` (404).
      - **Refused after the reads:** a server the entry doesn't list, and a time not newer than
        the stored report's (a replay).
      - **Changes:** a disk going `ok` to `warn` posts one message, with the percentage and the
        free space, and writes `report:` once, with metadata `{ at }`. `warn` to `high` posts
        again. Back to `ok` posts once that it recovered. A percentage moving within `warn`
        posts nothing.
      - **The other checks:** snapshot `failed` and `copy-failed`, and drill `failed` and
        `late`, each post the text of `check.mjs`'s issue and recover once. `unknown` never
        posts.
      - **Certificates and credentials:** a certificate going `warn` or `expired` and a
        credential going `old` each post `check.mjs`'s text, the credential's with
        `npx opscrew rotate <name>` and the entry's `rotate` flags, and each recovers once.
      - **A heartbeat** with no change writes once and posts nothing.
      - **A failed post** answers 502 and writes nothing.
      - **The cron:** a listed server silent for 26 hours and one minute posts "reports …
        stopped" once and writes `state:` once. Later runs post nothing. A newer report makes the
        next run post "reports resumed". A server listed less than 26 hours ago with no report
        posts nothing.
      - **The test-only limit:** an entry with `heartbeatMinutes: 10` posts "reports … stopped"
        after 10 minutes and one second. With values under 5, over 1,560, or absent, the limit is
        26 hours. Production entries never carry it (T4608 refuses it).
      - **One list per run:** the cron makes one `list` per run, and reads report times from its
        metadata.
      - **Nothing leaks:** no message or log line holds the report key, the webhook's address or
        the request's body.
    - **The script** keeps no imports, and the generated file and `UPTIME_WORKER_SHA256` follow.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/iac-templates && pnpm lint`
  - **Effort:** xhigh

- [x] T4607 [US4] The host step `uptime-report`: the server's script, units and config
  - **Owns:** `packages/connectors/ssh-host/src/uptime-report.ts` (new) and its tests (new,
    including a `uptime-report-script.test.ts` in the shell harness);
    `packages/connectors/ssh-host/src/{steps,facts,inspect,types,plan,index}.ts`, only for this
    step; `packages/connectors/ssh-host/src/__fixtures__/**` (new fixtures).
  - **Reads:** plan.md 6.1, data-model.md "The server's files", research R9, `dns-updater.ts`,
    its part of `steps.ts`, `dns-updater-script.test.ts`, `CHECK_KEY_COMMAND`, ADR 0011.
  - **Depends:** none.
  - **Accept:**
    - **The script's checks,** tests first, in the shell harness against fixture folders:
      - **The disk:** at 84%, 85% and 95% it gives `ok`, `warn` and `high`.
      - **The snapshot:**
        - a log ending with an id gives `ok`;
        - lines after the id give `copy-failed`;
        - no id gives `failed`;
        - a `.partial` folder under a held `.start.lock` gives `unknown`;
        - no log gives `none`.
      - **The drill:**
        - `healthy` gives `ok`;
        - `unhealthy`, `not-restored` and `failed` give `failed`;
        - none within twice the period plus an hour gives `late`, from the last drill or from
          `since`;
        - no schedule gives `none`.
      - **Certificates,** with a fake `openssl` on `PATH`: 15 days left gives `ok`, 13 gives
        `warn`, -1 gives `expired`, and no TLS answer gives `none`. It connects to `127.0.0.1:443`
        with each `host=` as SNI, and reads no file.
      - **Credentials:** checked once a day, kept in the state file in between. A date older than
        `max_age_days` gives `old`, for each of the `made`, `rotated` and `first-deploy` sources.
      - **Parity:** the same fixtures, read through `CHECK_KEY_COMMAND`'s output and `check.mjs`'s
        rules, fail and pass alike.
    - **When it sends,** with a fake `curl` and `openssl` on `PATH`:
      - It sends only on a status change, or 24 hours after its last report.
      - On a 2xx it updates the state file. On any other answer, or none, it keeps the file, and
        the next run sends again.
      - The signature is `HMAC-SHA256(key, time + "\n" + body)`, checked in the test with
        Node's `crypto`.
      - The key never appears in the journal line or the state file. If research R9's file or
        standard-input form works with the harness's `openssl`, the key isn't in the command
        line either.
      - The body has only data-model.md's fields.
    - **The step:**
      - **Planning:** inspection reads the instance, and the plan installs or replaces it, with
        the key's SHA-256 in its params and never the key, which comes on standard input.
      - **Files:** the files' modes and owners are as data-model.md says, and the units carry
        `User=` the deploy user and `LoadCredential=`.
      - **Packages:** `curl` and `openssl` are installed when missing.
      - **Removal:** it removes one instance, and the script and units with the last one.
      - **Versions:** a newer script on the server is never replaced.
      - The rendered units and script have snapshot tests.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/connector-ssh-host && pnpm lint`
  - **Effort:** xhigh

- [x] T4608 [US4] The adapter's additions: workers.dev, servers and report keys
  - **Owns:** `packages/connectors/cloudflare/src/uptime.ts` and its tests,
    `packages/connectors/cloudflare/src/client.ts` (the two subdomain methods),
    `packages/connectors/cloudflare/src/client-uptime.test.ts`,
    `packages/connectors/cloudflare/src/index.ts`, and `packages/connectors/cloudflare/src/testing/**`.
  - **Reads:** plan.md 6.3, data-model.md "Server reports", research R8.
  - **Depends:** T4603.
  - **Accept:**
    - **The client:**
      - `getWorkersSubdomain` and `setWorkerSubdomain` send research R8's method, path and body,
        each tested against an injected `fetch`;
      - an account with no subdomain gives `undefined`, not an error.
    - **`planUptime`:**
      - **The address:** `set-subdomain` only when workers.dev is off, and the finding
        `workers-dev-missing` without an account subdomain, saying to open Workers & Pages in the
        dashboard once.
      - **The servers:** `servers[].since` is kept from the existing entry, and `delete-report`
        is planned for a server that left.
      - **The report URL** is returned.
      - **The hash** covers the new changes and never the report key.
      - **`heartbeatMinutes`** in a desired entry gives the finding `test-only-field`, unless
        `planUptime` is called with `{ liveTest: true }`.
    - **`applyUptime`:** applies `set-subdomain` before `put-entry`. `delete-entry` deletes the
      entry's `report:` keys too.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/connector-cloudflare && pnpm lint`
  - **Effort:** high

- [x] T4610 [US4] The guide's server part
  - **Owns:** `docs/guide/alerts.md`.
  - **Reads:** plan.md 6.5, spec.md User Story 4 and its edge cases, research R8 and R9.
  - **Depends:** T4605.
  - **Accept:**
    - **The section:** the Cloudflare section gains what plan.md 6.5 lists, in plain English.
    - **What changes elsewhere in it:** the old line saying the disk, snapshot and drill checks
      need `runner: actions` is gone. With `runner: cloudflare` on a server, nothing needs Actions,
      and the section says that `opscrew rotate` updates the dates on the server.
    - **The table:** "What it checks" says where each check runs for each runner.
    - **"What it can't do"** names the targets with no server checks.
  - **Verify:** `pnpm lint`
  - **Effort:** medium

## Wave 4

- [x] T4609 [US4] The agents' server reports: the key, the host step, the entry's servers, status
  - **Owns:** `packages/agents/src/check/**`, `packages/agents/src/destroy/{common,own}.ts` and
    their tests, `packages/agents/src/status/check-state.ts` and its test,
    `packages/agents/src/rotate/uptime-report.ts` (new) and its test, and
    `packages/agents/src/rotate/{record,tokens}.ts`, only for the call after a date is
    written.
  - **Reads:** plan.md 6.4, data-model.md "Server reports", `check/key.ts`, `check/host.ts`,
    `check/servers.ts`, `home/` (how the address updater's step is planned and removed).
  - **Depends:** T4604, T4606, T4607, T4608.
  - **Accept:**
    - **The report key:** `ensureReportKey` makes 32 bytes once per environment with injected
      randomness, keeps them like the check key, and gives the same key on the next run. A lost
      key gives a new one, and the plan writes the entry's secret again.
    - **The config's dates:** with `observability.check.credentials` on, the step's config lists
      each credential's name, date and source, the same as `credentialsOf` gives `check.json`,
      plus `max_age_days`, the certificates' hostnames served there, and the entry's `rotate`
      flags. It never holds a value.
    - **`opscrew rotate`** writes the new date into the config through the server's host plan,
      approved by its hash, as `rotate/dns-updater.ts` does. A declined plan warns that the old
      date stays on the server.
    - **Never `heartbeatMinutes`:** no entry the agents build carries it, and a test checks that.
    - **Provision,** with `runner: cloudflare` on a server:
      - **Order:** the Cloudflare plan, with the entry's `servers`, comes first. Then, for each
        server `checkKeyStep` reaches today, a host plan with the step `uptime-report` is approved
        by its hash and applied.
      - **Config:** its config has the report URL, the entry id, the server id, the app folder and
        the drill schedule.
      - **`--plan-only`** prints its hash.
      - **No check key, no GitHub secret.** Without a server (Portainer, Cloudflare's hosting,
        GitHub Pages), no step, and design says "the Worker checks the address only".
    - **Leaving:** `runner: actions`, or the check off, plans the step's removal on each server
      with the entry's removal.
    - **Destroy:** on the user's own server, the teardown's host plan removes the step under the
      typed confirmation. A deleted cloud server needs none.
    - **`status`:** it shows each listed server's last report time and statuses, and "reports
      stopped" after 26 hours.
    - **No secret leaks:** the report key appears in no plan text, audit entry, log or test
      output.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/agents && pnpm lint`
  - **Effort:** xhigh

## The lead's wave

- [x] T4690 (lead) A fresh review of the merged waves, by a reviewer that didn't build them:
  safety (hashes, re-reads, `allowDestroy`, the host step), secrets (the report key), the
  report handler's refusals, and the guide against the code.
- [x] T4691 (lead) `/simplify` over the feature's diff.
- [x] T4692 (lead) The live pass of [quickstart.md](quickstart.md).
  - **Where:** the founder's own Cloudflare account. It's free and reversible, so it needs no
    extra go-ahead.
  - **Nothing left behind:** proven by listing the Workers, the KV namespaces and the secrets
    afterwards.
  - **The silence alert:** proven in minutes with the test-only `heartbeatMinutes`, which only
    the live test's own setup passes (quickstart step 12).
  - **The results** go into `docs/e2e-coverage.md`.
- [ ] T4694 (lead) The live pass's server part (quickstart steps 9–12a, and the timer's removal in
  13 and 14), on a throwaway server the pass creates and destroys, after a fresh review of
  T4606–T4610. The results go into `docs/e2e-coverage.md`.
- [ ] T4693 (lead) The changelog line for 0.2.12: "An uptime check in your own Cloudflare account,
  instead of GitHub Actions (`observability.check.runner: cloudflare`), with the server reporting
  its disk, snapshots and restore drills itself."
