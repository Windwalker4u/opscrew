# Tasks: An uptime check that doesn't use GitHub Actions

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md),
[data-model.md](data-model.md), [quickstart.md](quickstart.md).

Two build waves, then the lead's. Inside a wave, no two tasks share an Owns path.

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

- [ ] T4602 [US1] The Worker's script, embedded, and `checkHosts`
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

- [ ] T4603 [US1] [US2] The uptime adapter in the Cloudflare connector
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

- [ ] T4604 [US1] [US2] [US3] The agents' wiring: provision, destroy, status, design, init, moves
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
      - **What it prints:** with `runner: cloudflare`, "The disk, snapshot, restore-drill and
        certificate-days checks need `runner: actions`."
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

- [ ] T4605 [US1] The guide
  - **Owns:** `docs/guide/alerts.md`, `docs/guide/security.md` (the Cloudflare token's list).
  - **Reads:** plan.md 5., spec.md, research R1 to R5, the rest of `alerts.md`.
  - **Depends:** none in code; written from the spec, and checked against T4604 at review.
  - **Accept:**
    - **The section:** `alerts.md` gains "In your Cloudflare account instead of GitHub Actions",
      with everything plan.md 5. lists. It is plain English, says each fact once, and links the
      existing webhook section instead of repeating it. It says plainly:
      - that the disk, snapshot, restore-drill and certificate-days checks need `runner: actions`;
      - that there is no maintenance pause, so a move or retarget may post a down and a recovered
        message;
      - that an empty Worker stays until the last app's destroy.
    - **The opening:** its first paragraph mentions the choice in one sentence.
    - **`security.md`** lists Workers KV Storage → Edit, only for this check.
  - **Verify:** `pnpm lint`
  - **Effort:** medium

## The lead's wave

- [ ] T4690 (lead) A fresh review of the merged waves, by a reviewer that didn't build them:
  safety (hashes, re-reads, `allowDestroy`), secrets, and the guide against the code.
- [ ] T4691 (lead) `/simplify` over the feature's diff.
- [ ] T4692 (lead) The live pass of [quickstart.md](quickstart.md).
  - **Where:** the founder's own Cloudflare account. It's free and reversible, so it needs no
    extra go-ahead.
  - **Nothing left behind:** proven by listing the Workers, the KV namespaces and the secrets
    afterwards.
  - **The results** go into `docs/e2e-coverage.md`.
- [ ] T4693 (lead) The changelog line for 0.2.12: "An uptime check in your own Cloudflare account,
  instead of GitHub Actions (`observability.check.runner: cloudflare`)."
