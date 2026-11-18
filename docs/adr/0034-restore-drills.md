# ADR 0034: Restore drills: a throwaway copy on the snapshot's own target, by hand or on a schedule

**Status**: Accepted (2026-11-18, in feature 029's release). The founder asked for restore drills
in 029's release on 2026-11-15 and decided on 2026-11-18 that scheduled drills are built now and
that drills cover every target with snapshots. Details: `specs/029-home-hosting/` (research
R15–R19, R24–R30; plan 19.).

## Context

Feature 024 takes snapshots on servers, in a Portainer, on hosting accounts and on this computer.
Nothing proves they restore until a real restore is needed. A restore into the running app
replaces production's data, so a proof needs a separate copy. That copy holds production's data,
so it must be reachable by no one outside and must not act on the world: send mail, charge cards,
call webhooks, consume queued jobs. The preview server (ADR 0026) is the least trusted machine
OpsCrew runs: anyone who can push a branch runs code there.

## Decision

- **D1. The drill runs where the snapshot is,** never on the preview server: a Compose project
  `<app>-drill` on a server or this computer, a second stack `opscrew-<app>-drill` in a Portainer,
  a standing drill database on a hosting account. The snapshot is read in place, read-only.
- **D2. The copy is cut off:** its network is `internal: true` (no outbound traffic); it has no
  published port, no hostname, no record and no proxy site; production's `.env` is never read
  (the preview values are used when there are some); workers and scheduled jobs don't start.
- **D3. What a drill proves is said per target:** on servers, a Portainer and this computer, the
  app starts on the restored data and passes its own health check; on a hosting account, the dump
  imports into an empty database and holds its tables (an account can't run a second, cut-off copy
  of the app); SFTP-only hosts, Cloudflare's hosting and GitHub Pages have no snapshots, so no drill.
- **D4. By hand, `opscrew restore --drill`,** through the target's own plan (a host plan, a stack
  plan, a hosting request) approved by its hash, with `allowDestroy` and `<app>-drill` typed, since
  it removes the copy it made.
- **D5. On a schedule** (weekly by default, daily at most, three hours after the snapshot's slot):
  the deploy user's crontab on servers; on a Portainer, one loop service per database part with no
  network, restoring each dump into a scratch server of its own (the dumps proven, not the app); on
  a hosting account, OpsCrew's agent into the drill database. No schedule on this computer, which
  isn't always on. The schedule is a standing approval under constitution 1.12.0's clause for a
  program a plan installs, and keeps fixed bounds the target's own script enforces: only its own
  names, only the latest snapshot, no outbound network, removes what it made (and a crashed run's
  leftovers), the app's lock (a deploy or snapshot running means skip), enough disk and memory or
  skip, a 30-minute limit.
- **D6. Every run is recorded on the target** and shown by `opscrew status`; the three outcomes are
  told apart (the backup didn't restore; restored but the app didn't start without the internet or
  production values; restored and healthy) and a skip is never a failure. On servers, the
  scheduled check (017) opens an issue for a failed drill or for no drill within twice the
  schedule.

## Consequences

- A drill costs a second copy's disk and memory for some minutes; it skips rather than squeezes.
- A hosting account's drill database counts against the plan's database limit; provision says so
  and refuses to turn drills on without room.
- An app that needs the internet or a production value to start fails its drill's health check;
  the report says the backup itself restored, and to add test values to the preview values.

## Alternatives considered

- **The preview server under its standing approval:** production data where every contributor's
  code runs, and the approval may reach no other environment's data.
- **A server created per drill:** a paid resource and a copy of the data across machines each time.
- **CI running scheduled drills:** a standing credential with reach into production.
- **Blanking named env vars instead of cutting the network:** a list nobody can keep complete.
