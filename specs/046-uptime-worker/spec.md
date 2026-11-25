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

### User Story 4 - The server checks itself and reports to the Worker (Priority: P1)

The founder, 2026-11-25: with `runner: cloudflare`, nothing may still need GitHub Actions. On each
server of the environment, a timer installed by a host plan approved by its hash (ADR 0011) checks
these things against the Actions check's own sources and thresholds:

- every 5 minutes:
  - the disk;
  - the last scheduled snapshot;
  - the last scheduled restore drill;
  - the days left on the certificates the server serves for the app;
- once a day, the age of each credential the Actions check dates, from the non-secret rotation
  dates that provision writes into the timer's config.

With `runner: cloudflare` on a server, nothing needs GitHub Actions any more (the founder,
2026-11-25).

It reports to the Worker's own address only when one of them fails or recovers, plus one
heartbeat a day. The Worker posts each change through the environment's webhook, and alerts when a
server's reports stop for more than 26 hours.

**Why this priority**: without it, a user who leaves Actions loses the disk, snapshot and drill
alerts. With it, `runner: cloudflare` is a complete alternative.

**Independent Test**:

- **The server's script,** run in the shell harness against fixture files:
  - it reports on the same fixtures where `check.mjs` fails or passes;
  - it posts only on a change, or after 24 hours;
  - it keeps its state when the Worker refuses or can't be reached.
- **The Worker,** with a fake KV, a fake clock and real HMAC signatures, refuses an unsigned
  report, a stale one and a replayed one, and posts once per change.
- **Its cron** posts "reports stopped" once, after 26 hours.

**Acceptance Scenarios**:

1. **Given** an environment with `runner: cloudflare` on a server that provision reaches with a host plan,
   **When** provision runs, **Then**:
   - its host plan shows the step `uptime-report`, which installs a script, a systemd timer, a
     config and a key file (0600, root), with the key by name only;
   - the Cloudflare plan turns on the Worker's workers.dev address, if it is off, and the entry
     lists the server.
2. **Given** a disk that crosses 85%, **When** the timer runs, **Then** it sends one signed
   report, and the Worker posts one message with the percentage and the free space. Crossing
   95% posts again, and falling back under 85% posts once that it recovered.
3. **Given** a failed scheduled snapshot, its failed copy off the server, a failed restore drill or
   a drill that is late, **When** the timer runs, **Then** one report goes out and the Worker posts
   one message, with the texts of the Actions check's issues. The recovery posts once.
4. **Given** nothing changed, **When** the timer runs, **Then** nothing is sent, apart from one
   heartbeat 24 hours after the last report.
5. **Given** a report that is unsigned, signed with another key, more than 5 minutes off the
   Worker's clock, or not newer than the last accepted one, **When** it reaches the Worker,
   **Then** it is refused, and nothing is read from KV or written. Any other path or method gets
   404.
6. **Given** a server whose last report is more than 26 hours old, **When** the cron runs,
   **Then** one message says "reports from <app> (<env>) on <server> stopped". The first report
   after that posts "reports resumed".
7. **Given** a certificate served for the app with fewer than 14 days left, **When** the timer
   runs, **Then** one report goes out and the Worker posts the Actions check's text ("expires
   within 14 days", or "has expired"). A renewed certificate posts once that it recovered.
8. **Given** `observability.check.credentials` on and a credential older than its
   `credentials.maxAgeDays`, **When** the timer's daily credential check runs, **Then** one message
   names the credential and the `npx opscrew rotate` command.
   - After `opscrew rotate`, its host plan writes the new date into the timer's config. The
     next check posts once that it recovered.
9. **Given** the runner switched back to `actions`, **When** provision runs, **Then** its host
   plan removes the timer, the script's instance, the config and the key file. A destroy removes
   them with the app's teardown.

### Edge Cases

- **Nothing needs Actions on a server:** with `runner: cloudflare` on a server, every check of
  the Actions check runs without it:
  - the addresses, in the Worker;
  - the disk, the snapshots, the restore drills, the certificates' days and the credentials'
    age, on the server.
- **Targets with no server checks** print, in design and provision:
  "This target has no server OpsCrew reaches, so the Worker checks its address only: the disk, snapshot, restore-drill, certificate-days and credential-age checks need `runner: actions`."
  An expired or invalid certificate there still shows as down ("an invalid certificate").
- **A certificate the server doesn't serve over TLS** (a tunnel's origin served over plain HTTP)
  is `none`, and never posts.
- **No server checks on these targets** (the lead, 2026-11-25): a Portainer target, a site on
  Cloudflare's hosting or GitHub Pages, and a hosting account. They have no such server checks
  today, or are refused. The Worker checks their addresses only, and design and the guide say
  so.
- **A server that two environments share** gets one timer per environment, and each reports to its
  own entry, so a full disk is reported to each environment's webhook.
- **A server provision can't reach with a host plan** gets no timer. Design names it as not
  checked.
- **The workers.dev address:** the Worker gets its `fetch` handler there, at `POST /report` only.
  An account with no workers.dev subdomain yet gets a finding before anything changes, which says
  to open Workers & Pages in the dashboard once.
- **A moved app:** the entry lists its servers. A report from a server that isn't listed is
  refused, and the plan deletes the report keys of servers that left, so a server removed by a
  retarget never raises "reports stopped".
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
  environment, and both design and provision print the line of the edge case "What stays with
  Actions".
- **FR-014**: Tests use fakes only. No test calls Cloudflare.
- **FR-015**: With `runner: cloudflare`, a host plan step `uptime-report`, approved by its hash,
  installs one timer instance per environment on each of its servers that provision reaches
  with a host plan. These are servers OpsCrew created and the user's own, including ones behind a
  tunnel or at home, since the timer only connects out. The step is removed by provision when the
  runner goes back to `actions` or the check is turned off, and by destroy with the teardown.
- **FR-016**: Every 5 minutes, the server's script reads the disk, the last scheduled snapshot
  and the last scheduled restore drill. It reads them from the same files as the check key's
  command, against the same thresholds:
  - the disk at 85% and 95%;
  - a snapshot fails when it, or its copy off the server, failed;
  - a certificate fails with fewer than 14 days left (`certDays`), read from what the server
    serves for each of the app's hostnames on its own port 443;
  - a credential fails when it was made or last rotated more than `maxAgeDays` ago. This one is
    checked once a day, from the dates in the timer's config;
  - a drill fails when it didn't restore, the app was unhealthy or the copy failed, or when none
    ran within twice its schedule plus an hour.
- **FR-017**: The script keeps its last sent state in a local file. It sends a report only when a
  check's status changes, or 24 hours after its last report (the heartbeat). It updates the file
  only when the Worker answers 2xx, so a failed send is retried at the next run.
- **FR-018**: A report is `POST /report` to the Worker's workers.dev address, a JSON body of
  fixed fields: the entry id, the server's id in the plan, the time, and each check's status with
  its figures. It never holds an address, a log line or a secret.
  - It is signed with HMAC-SHA256 over the time and the body, with the environment's own report
    key.
  - The key is 32 random bytes, kept in a 0600 root file on the server and in the entry's Worker
    secret, beside the webhook's address.
- **FR-019**: The Worker's `fetch` handler serves only `POST /report`. It refuses, before any KV
  operation:
  - a body over 4 KB;
  - a missing or wrong signature, compared in constant time;
  - a time more than 5 minutes from its clock;
  - a server the entry doesn't list.

  It then refuses a time that isn't newer than the last accepted report's. Everything else gets
  404.
- **FR-020**: For each check whose status changed, the Worker posts one message through the
  entry's webhook, with the Actions check's texts. It then writes the server's report key, with
  the report's time as KV metadata. A failed post answers 502 and writes nothing, so the server
  sends again.
- **FR-021**: On its cron, the Worker posts "reports from <app> (<env>) on <server> stopped" once
  when a listed server's last report, or its listing when none came yet, is more than 26 hours
  old. It posts "reports resumed" once when a report comes after that.
- **FR-022**: KV writes happen only on an accepted report (a change or a heartbeat) and on a
  stopped or resumed alert. Each key has one writer: `report:` keys the `fetch` handler, and
  `state:` keys the cron.
- **FR-024**: Provision writes the credentials' names and dates (never a value) into the timer's
  config, with the rotation record's rule: the last rotation, else when the credential was made,
  else the first deploy. It also writes `maxAgeDays`. `opscrew rotate` writes the new date the
  same way, through the server's host plan approved by its hash.
- **FR-025**: The heartbeat limit is 26 hours. An entry may carry a shorter `heartbeatMinutes`
  only when the adapter is called with the live test's own flag. The plan refuses it for every
  other entry, and the agents never set it.
- **FR-023**: Server checks exist only on servers. Portainer, Cloudflare's hosting, GitHub Pages and
  hosting accounts get the address check only, said plainly in design and the guide.

### Key Entities

- **Uptime entry**: one environment's KV value (data-model.md).
- **Uptime state**: each hostname that is `suspect` or `down`, as the Worker last wrote it.
- **Uptime plan**: the adapter's changes, what it expected to find, and its hash.
- **Report key**: an environment's 32-byte HMAC key, on its servers and in its Worker secret.
- **Server report**: a server's last accepted report in KV (`report:<id>/<server>`).

## Success Criteria *(mandatory)*

- **SC-001**: An app on the free plans of GitHub and Cloudflare gets one down alert, within about
  10 minutes of going down (two runs 5 minutes apart), and one recovered alert within about 5
  minutes of answering again, at no cost.
- **SC-002**: A healthy day costs no KV write. Each run makes one list request and two reads per
  entry.
- **SC-003**: The live pass (quickstart) shows both messages, with two entries sharing the Worker,
  and leaves nothing behind. Listing the Workers, the KV namespaces and the secrets proves it.
- **SC-004**: With `runner: cloudflare` on a server, the repository runs no GitHub Actions workflow
  for that environment. A full disk, a failed snapshot, a failed drill or a certificate close to
  expiry still alerts within about 5 minutes of the server seeing it, and an old credential within
  a day.
- **SC-007**: The live pass proves the "reports stopped" alert in minutes, with a heartbeat limit
  that only the live test's own setup may set. Production entries always use 26 hours, which unit
  tests prove.
- **SC-005**: A healthy server costs one KV write a day (its heartbeat), and its reports never
  reach the free plan's limits: 1,000 KV writes and 100,000 requests a day per account (research
  R1, R3).
- **SC-006**: The live pass shows a disk alert and its recovery from a real server, the refusal
  of an unsigned report, and the timer gone after the switch back to `actions`.

## Assumptions

- The webhook stays the repository's (`opscrew/plan.yaml`), as today. Each entry stores its own
  copy as a secret.
- GitHub Pages environments can use the Worker when their DNS is on Cloudflare. Hosting-account
  environments can't yet (the lead, 2026-11-25): their provision has no check step, so a plan with
  `runner: cloudflare` on a hosting target is refused, naming `runner: actions`.
  Localhost can't, as today.
