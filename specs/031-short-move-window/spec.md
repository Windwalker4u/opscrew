# Feature Specification: A move's maintenance window of about a minute

**Feature Branch**: `031-short-move-window`

**Created**: 2026-11-20

**Status**: Building (in 0.2.11, the founder's decision of 2026-11-20)

**Input**: The founder, 2026-11-20, through the PHP app's session: "near-zero-downtime moves", a
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

### Edge Cases

- PostgreSQL: its data is still dumped and restored in the window, as today, so a large database
  still makes the window long; the window's estimate says so.
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
