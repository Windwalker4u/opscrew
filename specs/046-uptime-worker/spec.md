# Feature Specification: An uptime check that doesn't use GitHub Actions

**Feature Branch**: `046-uptime-worker`

**Created**: 2026-11-25

**Status**: Draft (in 0.2.12, the founder's decision of 2026-11-25; the lead's decisions of
2026-11-25 on v1's scope, the retry and the empty Worker)

**Input**: `specs/roadmap.md`, 046. In a private repository the scheduled check costs Actions
minutes, so a user who turns it off has no down alert at all. Cloudflare's Health Checks need the
Pro plan, but Workers' free plan has Cron Triggers. Research: [research.md](research.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Down and recovered alerts from a Worker in the user's account (Priority: P1)

A user whose app's DNS is on Cloudflare sets `observability.check.runner: cloudflare` and a webhook,
and runs `npx opscrew provision`. The provision shows a Cloudflare plan with its hash:

- the shared Worker `opscrew-uptime`, its trigger every 5 minutes and its KV namespace, each
  created only when missing;
- this environment's entry: its hostnames and health path;
- its webhook secret, by name only.

Once the plan is approved, the Worker checks the app every 5 minutes. When the app fails two
checks in a row, one message goes to Slack, Discord or ntfy. When it answers again, one more
goes, with how long it was down.

**Why this priority**: it is the feature. A private repository's user gets down alerts without
Actions minutes.

**Independent Test**: The Worker's script runs against a fake KV, a fake `fetch` and a fake clock,
over several runs:

- an up hostname writes nothing;
- a first failure writes `suspect` and posts nothing;
- a second failure in a row writes `down` and posts one "down" message;
- later failing runs post and write nothing;
- a success clears `suspect` silently, or posts one "recovered" message from `down`.

The adapter is tested against a fake Cloudflare API: its plan, its hash, and its apply.

**Acceptance Scenarios**:

1. **Given** a healthy app, **When** the Worker runs, **Then** it fetches each hostname once, posts nothing and
   writes nothing to KV.
2. **Given** a hostname whose one try fails, **When** the run ends, **Then** its state becomes `suspect`, written once,
   and nothing is posted.
3. **Given** a `suspect` hostname that answers at the next run, **When** that run ends, **Then** `suspect` is cleared, with no
   message.
4. **Given** a `suspect` hostname that fails again at the next run, **When** that run ends,
   **Then**:
   - its state becomes `down`, written once;
   - one message says the app (and environment) is down on that hostname;
   - the reason is in plain words: "not reachable", "an invalid certificate", or "answered with
     status 503".
5. **Given** a `down` hostname, **When** it answers with a 2xx or 3xx, **Then** one message says
   it is up again and how long it was down, and the state is cleared.
6. **Given** a webhook post that fails, or one that doesn't fit in the run's subrequests, **When** the run ends, **Then** that hostname's
   state isn't written, so the next run posts again.

### User Story 2 - Several apps share one Worker, each owning its own entry (Priority: P1)

A second app in the same Cloudflare account chooses the Worker. Its plan adds only its own entry
and secret, and names the entries of the other apps that it keeps. Two apps that provision at about
the same time both end with their entries, and neither removes the other's.

**Why this priority**: the free plan has 5 Cron Triggers per account, so a Worker per app would
run out at five apps.

**Independent Test**: With a fake Cloudflare API holding another app's entry and secret:

- the plan lists that entry as kept and changes neither;
- two applies run at once (interleaved fakes) both end with their entries, and with one namespace
  and one Worker;
- removing an entry through provision keeps the Worker, even when it was the last;
- destroying the last app removes the Worker, its trigger and its namespace.

**Acceptance Scenarios**:

1. **Given** the Worker with app A's entry, **When** app B provisions, **Then** B's plan creates
   nothing shared, adds B's entry and secret, and says it keeps A's entry (by repository, app and
   environment).
2. **Given** an environment that switches back to `runner: actions`, or turns the check off,
   **When** it provisions, **Then** its plan removes only its entry, its state and its secret.
   The Worker, its trigger and the namespace stay, even with no entry left: they cost nothing,
   they do nothing, and the next app reuses them.
3. **Given** two entries, **When** one app is destroyed, **Then** its entry, its state and its
   secret are removed under destroy's typed confirmation, and the Worker stays.
4. **Given** the last entry, **When** its app is destroyed, **Then** the plan also deletes the Worker (with its trigger and secrets) and the
   namespace, under that destroy's own `allowDestroy` and typed confirmation. Just before deleting
   them, the apply reads the entries again, and keeps both, saying so, when another entry
   appeared meanwhile.
5. **Given** the entries already list 40 hostnames in the account, **When** an app adds another,
   **Then** its plan refuses it before anything changes. The refusal names the cap of 40, and says
   to use the Actions check for that app.

### User Story 3 - A wrong setting is refused before anything changes (Priority: P2)

**Acceptance Scenarios**:

1. **Given** `runner: cloudflare` while `dns.provider` isn't `cloudflare`, **When** the plan is validated, **Then** it is
   refused, with the field to set.
2. **Given** `runner: cloudflare` with no `observability.check.webhook` in
   `opscrew/plan.yaml`, **When** the user runs provision, **Then** it stops before any change and says to set
   the webhook, since the Worker opens no GitHub issue.
3. **Given** a Cloudflare token without Workers Scripts → Edit or Workers KV Storage → Edit,
   **When** `init` or provision checks it, **Then** the missing permission is named.
4. **Given** no runner, **When** provision runs, **Then** everything behaves as today (`actions`).

### Edge Cases

- **v1 is Worker-only.** With `runner: cloudflare`, these checks don't run for that environment:
  the disk, the scheduled snapshots, the restore drills, and the certificate's days left. A Worker
  can't reach the server, and no Actions workflow runs for it.
  - Design and provision print it when the runner is chosen: "The disk, snapshot, restore-drill
    and certificate-days checks need `runner: actions`."
  - The guide says the same, and `status` still shows those figures when asked.
- **The Actions workflow:** an environment with `runner: cloudflare` is left out of `check.json`.
  When no environment uses Actions any more, the workflow and `opscrew/check/` are removed, as
  when the check is turned off.
- **A first run:** a new trigger can take up to 15 minutes to start, and the guide says so.
- **The webhook kind, or its address, changed:** a new address in `OPSCREW_CHECK_WEBHOOK`
  replaces the entry's secret. Without one, the stored secret is kept, as in the GitHub path.
- **Moves:** `opscrew cloudflare-move` (another Cloudflare account) refuses an app with an uptime
  entry, and says to switch `observability.check.runner` to `actions` and provision first.
- **No maintenance pause in v1:** during `retarget`'s window or a move, the Worker isn't paused, so
  it may post a down message and then a recovered one. The guide says so.
- **Concurrency:** Cloudflare has no lock. Plan.md, 3., says what is caught and what isn't, as ADR
  0014 does.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `observability.check.runner` is `actions` or `cloudflare`. Absent means `actions`.
  It is set per environment, like `enabled`.
- **FR-002**: The schema refuses `runner: cloudflare` unless `dns.provider` is `cloudflare`.
  Provision refuses it, before any change, when the repository's `observability.check.webhook`
  is unset.
- **FR-003**: There is one Worker named `opscrew-uptime` per Cloudflare account, the account of the
  app's zone. It has one Cron Trigger `*/5 * * * *` and one KV namespace titled `opscrew-uptime`,
  bound as `UPTIME`.
- **FR-004**: Each environment owns one KV key, `entry:<owner>/<repo>/<app>/<env>`, which holds
  its hostnames, health path, webhook kind and secret name, and never a secret. It also owns the
  key `state:<same>`, which only the Worker writes, and one secret, `HOOK_<16 hex of the key's
  SHA-256>`. The secret holds the webhook's address and, for ntfy, its token.
- **FR-005**: Every change to the Worker, its trigger, its namespace, an entry or a secret goes
  through a Cloudflare plan approved by its hash (`cloudflare-apply`), shown in plain English. The
  plan names the other entries it keeps.
  - Provision never deletes the Worker, its trigger or the namespace.
  - Only a `destroy` that leaves no entry deletes them, under that destroy's own `allowDestroy`
    and typed confirmation. There is no other confirmation flow.
- **FR-006**: The apply reads again, just before it writes, what the plan expected: the others'
  entries and the Worker's version. It stops when that changed, and says to run the command again.
- **FR-007**: The Worker's script is a pinned file that OpsCrew ships, with no dependency. OpsCrew
  uploads it only when it is missing or its SHA-256 differs from the one recorded in KV, and it
  keeps the existing secrets on upload.
- **FR-008**: Each run makes one try per hostname. A try fails on a status outside 200 to 399, a
  network error, or no answer within 10 seconds. Redirects aren't followed, and a 3xx is an
  answer.
  - A failure from up makes the hostname `suspect`.
  - A failure from `suspect` makes it `down`, and posts.
  - A success clears `suspect` silently, and posts "recovered" from `down`.
- **FR-009**: The Worker writes an entry's state only on a change.
  - A change that posts is written only after the webhook accepted the message.
  - Posts that don't fit in the run's subrequests (research R1) wait for the next run, unwritten.
- **FR-010**: A message holds fixed text: the app, the environment, the hostname, the reason, the
  times and the command `npx opscrew status`. It never holds the response's body or headers, an
  address or a secret.
  - The reasons are "not reachable" (a network error, a timeout, or Cloudflare's 520 to 524 and
    530), "an invalid certificate" (525, 526), and "answered with status N".
  - Slack's text is cut at 4,000 characters, Discord's at 2,000 with no mentions. ntfy sends
    priority 4 for down and 3 for up.
- **FR-011**: At most 40 hostnames across the account's entries. The plan refuses the 41st,
  naming the cap.
- **FR-012**: `status` says that the check runs in the Cloudflare Worker, and lists the hostnames
  the Worker's state has `down`, with their times. It only reads.
- **FR-013**: When the runner is `cloudflare`, design shows no Actions minutes for that
  environment, and both design and provision print the line of the first edge case.
- **FR-014**: Tests use fakes only. No test calls Cloudflare.

### Key Entities

- **Uptime entry**: one environment's KV value (data-model.md).
- **Uptime state**: each hostname that is `suspect` or `down`, as the Worker last wrote it.
- **Uptime plan**: the adapter's changes, what it expected to find, and its hash.

## Success Criteria *(mandatory)*

- **SC-001**: An app on the free plans of GitHub and Cloudflare gets one down alert, within about
  10 minutes of going down (two runs 5 minutes apart), and one recovered alert within about 5
  minutes of answering again, at no cost.
- **SC-002**: A healthy day costs no KV write. Each run makes one list request and two reads per
  entry.
- **SC-003**: The live pass (quickstart) shows both messages, with two entries sharing the Worker,
  and leaves nothing behind. Listing the Workers, the KV namespaces and the secrets proves it.

## Assumptions

- The webhook stays the repository's (`opscrew/plan.yaml`), as today. Each entry stores its own
  copy as a secret.
- GitHub Pages environments can use the Worker when their DNS is on Cloudflare. Hosting-account
  environments can't yet (the lead, 2026-11-25): their provision has no check step, so a plan with
  `runner: cloudflare` on a hosting target is refused, naming `runner: actions`.
  Localhost can't, as today.
