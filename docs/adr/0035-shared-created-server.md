# ADR 0035: Apps from several repositories on a server OpsCrew created

**Status**: Accepted (2026-11-19, feature 030). The founder asked on 2026-11-19 for a second app,
from another repository, on the Hetzner server OpsCrew created for his first app, and chose to
build that rather than create a second server. Details: `specs/030-shared-created-server/`
(research R1–R6, plan).

## Context

A server OpsCrew creates (Hetzner Cloud, DigitalOcean, Contabo) belongs to one app's
infrastructure state. cloud-init gives it a single login, `deploy`, with no root and no sudo; it
is in the docker group. The server already has the layout for several apps: `/srv/apps`,
`/srv/data` and a shared edge with a site file and certificates per app. But nothing on it says
which apps it holds, and the first app's commands (destroy, retarget, closing public SSH,
whole-server restore) act on the whole server.

A server the user owns can already hold apps from several repositories (ADR 0011). Records in
`/etc/opscrew/apps` and host plans approved by hash keep them apart. That path needs root or
passwordless sudo.

## Decision

- **D1. A second app is an own-server app that names the first** (`target.shares: { app,
  provider }`), not a new provider kind. Its address and login stay in `.opscrew/server.json`, as
  for every own server.
- **D2. The first app is read from its repository folder on this computer.** That gives its
  plan, its server's addresses, its pinned host key and its deploy login. Only the public host key
  is copied. The first app's deploy key logs in once, to apply the host plan that authorizes the
  second app's own key. From then on the second app uses its own key.
- **D3. The second app's host plan holds only its own parts:**
  - its deploy key line, added or removed alone, with every other line kept;
  - its folders;
  - its record, which names the first app;
  - its check key, drills and runner.

  Root steps (only the record) run through the login's Docker access. The server's shared setup
  (Docker, SSH, the firewalls, fail2ban, updates, the edge's shared files) is the first app's and
  is never planned.
- **D4. No record is written for the first app.** Its description comes fresh from its plan each
  time, since a copy on the server would go stale.
- **D5. The second app is never the last app** on the server. Its teardown never removes the
  edge, the check key or another line.
- **D6. The first app's commands look before they harm.** Destroy, retarget, a server replace, a
  whole-server restore, closing public SSH, a serving switch, a private network and server
  add-ons refuse while a second app's record is on the server. A resize must still hold every
  app. When the server can't be reached they stop, unless `--skip-other-apps-check` is given.
- **D7. The shared access is said plainly.** Both apps run as `deploy`, which can become root
  through Docker, so anyone who can change the second app's deploy workflow or its deploy key
  reaches the first app's data and secrets. Design, the host plan's approval and the guide say so.

## Consequences

- One cheap server can hold several small apps, each set up, deployed and removed on its own,
  with every change approved by hash.
- The first app's repository folder must be on the computer that runs the second app's design
  and provision. The other commands need only the second app's own state.
- Apps on a shared server are kept apart by convention and by their records, not by a security
  boundary (D7). A user who needs that boundary gives the app a server of its own.
- Moving the first app to another server while second apps run on it is not offered. They are
  removed or moved off first.
