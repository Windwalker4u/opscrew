# Feature Specification: A move's maintenance window of about a minute

**Feature Branch**: `031-short-move-window`

**Created**: 2026-11-20

**Status**: Building (in 0.2.11, the founder's decision of 2026-11-20)

**Input**: The founder, 2026-11-20, through another session: "near-zero-downtime moves", a
maintenance window of about a minute instead of the length of a whole copy, for `opscrew retarget`
to a server (a server OpsCrew creates, a server of the user's, another app's server) and to a
Portainer. The PHP app's move (481 MB: 262 MB of files, 219 MB of MySQL) was estimated at about 12
minutes offline; its one real window ran 5½ minutes, with its rollback. Its move waits for this
feature and is its first live run. Research and decisions: [research.md](research.md).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The data is copied while the app still serves (Priority: P1)

A user moves a live app with its data. Today the app stops for the whole copy, which goes through
the user's computer. Instead, OpsCrew copies the data to the new side while the old side still
serves, starts the app there on that copy and checks it, all without downtime. Only then does the
maintenance window stop the app; it copies just what changed since, checks every copy as today,
and switches.

**Why this priority**: it is the feature: the window shrinks from the length of a full copy to
about a minute for a typical small app.

**Independent Test**: With fakes, a move whose volumes change between the pre-copy and the window:
the window copies only the changed and new files and removes the deleted ones; the digests of every
mount match on both sides; the old app was stopped only from the window's start.

**Acceptance Scenarios**:

1. **Given** a move that copies data, **When** the window's approval is shown, **Then** it says
   that the data is copied first while the app serves (its size and expected minutes), and that the
   window itself copies only what changed since (expected about a minute).
2. **Given** the pre-copy, **When** it runs, **Then** the old app keeps serving, nothing on the old
   side is stopped, and the new side receives every mount's data.
3. **Given** the window, **When** it runs, **Then** it stops the old app and the services whose
   data is copied, copies only the files that differ (new, changed, removed), and checks each
   mount's SHA-256 digest against the old side's, as today. A digest that differs stops and rolls
   back as today.
4. **Given** a failure in the pre-copy, **When** it happens, **Then** nothing of the old side was
   stopped, the move says what failed, and a rerun starts the pre-copy again.

---

### User Story 2 - The app is checked on the new side before the window (Priority: P1)

The app starts on the new side on the pre-copied data, runs its release command there, and passes
its health check, while the old side still serves. In the window, after the delta, the release
command runs once more on the final data and the app restarts in place: no deploy run of GitHub
Actions is in the window.

**Why this priority**: a deploy run takes minutes on its own; a failure found before the window
costs no downtime.

**Independent Test**: With fakes: the deploy run that starts the app on the new side runs before the
window's approval; the window runs no workflow; an app that fails its health check on the
pre-copied data stops the move before any downtime.

**Acceptance Scenarios**:

1. **Given** a move to a server, **When** the pre-copy is done, **Then** the deploy workflow runs
   with the deployed image's digest on the pre-copied data (the move's marker says `copied`), the
   release command runs, the app starts, and OpsCrew checks it over SSH. The old side still serves.
2. **Given** that check fails, **When** it fails, **Then** the move stops before the window, the
   new side's app is stopped, and the old side was never stopped.
3. **Given** the window, **When** the delta is copied, **Then** the release command runs on the final
   data and the app starts again in place, then OpsCrew checks it, then DNS switches. No workflow
   runs in the window.

---

### User Story 3 - A new server whose first boot failed is repaired (Priority: P2)

*(Added 2026-11-20, the founder's decision after the live run: in 0.2.11.)* A server OpsCrew just
created, for a provision or as a move's new side, can come up without its network at the first
boot. Its setup then fails (no Docker, no firewall), and a restart alone doesn't run the setup
again. Today OpsCrew waits, then stops with "did not finish its first-boot setup". Instead, it
says what failed, and offers the repair: a restart when the server answers nothing, a fresh
install of the same server (same image, first-boot file and addresses) when its setup failed. It
then pins the server's new host key itself and goes on.

**Why this priority**: a user can't repair it by hand. `deploy` has no root, root login is off,
and the provider's install needs the first-boot file OpsCrew rendered.

**Independent Test**: With fakes, for each provider that creates servers: a new server that never
answers is restarted after the approval; one whose setup failed is installed again after the
approval, its new host key pinned, and the run goes on to the deploy. Without the approval,
nothing is restarted or installed.

**Acceptance Scenarios**:

1. **Given** a new server whose first-boot setup failed, **When** the wait ends, **Then** OpsCrew
   names the failed steps from the server's own cloud-init result (for example "the package install
   failed"), says the server holds nothing yet, and asks to install it again, typing the app's name
   to confirm.
2. **Given** the approval, **When** the install runs, **Then** it uses the same image and first-boot
   file, keeps the server's id and addresses, forgets the old host key, pins the new one on the
   first connection, and waits for the setup again.
3. **Given** a new server that never opens SSH, **When** the wait ends, **Then** OpsCrew asks to
   restart it through the provider, then waits again.
4. **Given** a server that holds data (any server after its first deploy), **When** it doesn't
   answer, **Then** OpsCrew never offers to install it again.

---

### User Story 4 - The plan records every cost, so the portal shows it (Priority: P2)

*(Added 2026-11-20, the founder's decision: "it should show every single cost", in 0.2.11.)* A
move ends one server's billing and starts another's, Contabo charges a setup fee, backups and
snapshots come and go. `opscrew/plan.yaml`'s `cost` then records each item's billing model
(hourly up to a monthly cap, a monthly term, or free), its hourly price, when it started, the items
that ended this month or last (with when), and one-time fees, so the hosted portal can show what
has run up and mark forecasts as approximate. The field names are agreed with the portal (research
R4).

**Acceptance Scenarios**:

1. **Given** a design on Hetzner or DigitalOcean, **When** the plan is written, **Then** each item
   has `billing: hourly`, its `hourly` price and its monthly cap; on Contabo `billing: monthly`; a
   second app's item `billing: free`.
2. **Given** a provision that creates a server, **When** it applies, **Then** each billed item gets
   `since`, and Contabo's setup fee goes into `oneTime` with its time.
3. **Given** a move's finish, a destroy, backups turned off or a snapshot deleted, **When** it
   applies, **Then** the item moves to `ended` with its `until`.
4. **Given** any plan write, **Then** `ended` and `oneTime` keep only the current and the previous
   calendar month.
5. **Given** a domain bought with `opscrew domain buy`, **When** the purchase finishes, **Then** its
   price, registrar and time go into `oneTime`, and its renewal (price per year, next date,
   auto-renew) into `renewals`.
6. **Given** a domain whose expiry moved on since the plan's `next`, **When** a command reads the
   registrar, **Then** the renewal goes into `oneTime` at its date and `next` moves on.

---

### Edge Cases

- PostgreSQL: its data is still dumped and restored in the window, as today, so a large database
  still makes the window long; the window's estimate says so.
- MySQL and MariaDB: dumped and restored before the window, so the app's check runs on consistent
  data. In the window, their data folder is copied as files with the service stopped, about its
  whole size, so a large one still lengthens the window (research R2).
- Workers and cron: they run on the new side only during the app's check before the window, and
  stop right after it, so no job runs on both servers.
- A file that changes again during the window's copy cannot: the services writing it are stopped.
- A mount that has no change since the pre-copy is checked by its digest only.
- Many changed files (a busy app): the window copies them all; its estimate counts the pre-copy's
  size only as the upper bound.
- A Portainer new side: the pre-copy and the delta work there too; its app starts as it does
  today.
- A move with nothing to copy: no pre-copy and no window, as today.
- The pre-copy runs while the app writes: a live copy of a database's files can be inconsistent;
  it only seeds the new side, and the window's delta makes the copy exact.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-3101**: A move that copies data MUST copy every mount to the new side while the old side
  still serves (the pre-copy), before the window stops anything.
- **FR-3102**: The window MUST copy only the paths whose type, mode, owner, group, size, link target
  or content (SHA-256) differ between the old side and the new side's pre-copied mount, and remove
  the paths the old side no longer has. It MUST then check each mount's digest as today.
- **FR-3103**: On a server new side, the app MUST start on the pre-copied data before the window,
  through the deploy workflow with the image's digest (the release command runs, the app starts),
  and pass OpsCrew's health check over SSH, while the old side serves. A failure there stops the
  move before any downtime.
- **FR-3104**: In the window, after the delta, the release command MUST run on the final data and
  the app MUST start again in place on the new side, with no workflow run, then pass the health
  check before the switch.
- **FR-3105**: The window's approval and summary MUST give the pre-copy's size and minutes apart
  from the window's expected minutes.
- **FR-3106**: Every plan, approval by hash, digest check and the window's rollback stay as they
  are. The pre-copy needs no downtime approval and changes nothing on the old side.
- **FR-3107**: No secret, address or key appears in output, logs, audit entries or fixtures.
- **FR-3108**: When a server OpsCrew just created doesn't finish its first-boot setup, OpsCrew MUST
  name the failed steps it can read on the server (cloud-init's result, which the deploy user
  reads) instead of only "did not finish".
- **FR-3109**: For such a server, OpsCrew MUST offer the repair through the provider's connector:
  - **A restart, when it never opened SSH,** after an approval in which the user types the app's
    name.
  - **An install of the same image with the same first-boot file, when its setup failed,** after
    an approval bound to the install's hash (its provider, server, image and first-boot file),
    with the app's name typed: `--approve <hash> --confirm <app>` in a script, as a whole-server
    restore is approved.
  - **The install's conditions:** only when the deploy user logged in and found no ready marker,
    no app folder and no running container. Never when the server didn't answer, and never after
    its first deploy.
  - **At most one of each per run.** The attempts are audited.
- **FR-3110**: After an install OpsCrew made, it MUST forget the server's old host key and pin the
  new one on the first connection, with no changed-key question.
- **FR-3111**: `cost.breakdown` items MAY carry `billing` (`hourly` | `monthly` | `free`), `hourly`
  (money) and `since` (time); `cost.oneTime` lists `{item, price, at}`; `cost.ended` lists
  `{item, monthly, billing, hourly?, since, until}`. All are optional; old plans stay valid.
- **FR-3112**: Design MUST write `billing` and `hourly` from the providers' price data; provision,
  retarget, destroy, the backups switch and snapshot deletion MUST write `since`, `until`, `ended`
  and `oneTime` as they apply; every plan write MUST prune `ended` and `oneTime` older than the
  previous calendar month.
- **FR-3113**: `opscrew domain buy` MUST record the purchase in `cost.oneTime` and the domain's
  renewal in `cost.renewals` (`{item, provider, price, next, autoRenew}`, optional). An `opscrew
  status` or `opscrew domain status` run once `next` is within 30 days or past MUST read the
  registrar, record a renewal that happened in `oneTime` at its date and move `next` on; with
  auto-renew off it warns that the domain expires (research R4).

### Key Entities

- **Manifest**: a mount's entries (path, type, mode, owner, group, size, link target, a file's
  SHA-256), read on each side by a short-lived carrier.
- **Delta**: the paths to copy and the paths to remove, from the two manifests.

## Success Criteria *(mandatory)*

- **SC-3101**: For the PHP app's move (481 MB, little change), the app is offline for about a minute,
  against 5½ minutes before.
- **SC-3102**: Every mount's digest matches on both sides after the window, as today.
- **SC-3103**: No workflow run happens inside the window.

## Assumptions

- The data still passes through the user's computer; only the window's delta does so during
  downtime. A direct transfer between the servers is left for later (research R3).
- Portainer's new side keeps its own start; it gains the pre-copy and the delta.
