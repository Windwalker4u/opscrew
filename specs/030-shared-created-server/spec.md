# Feature Specification: Apps from several repositories on a server OpsCrew created

**Feature Branch**: `030-shared-server`

**Created**: 2026-11-19

**Status**: Draft

**Input**: User description (founder, 2026-11-19): deploy a second app, from another repository,
onto the Hetzner server OpsCrew created for his first app, instead of creating a second server.
OpsCrew can't do that today: a server OpsCrew created has only the `deploy` login, with no root or
sudo, and the "server you already have" path needs root or sudo. He chose to build it.

Research and the lead's decisions: [research.md](research.md). The words used here:

- the **first app**: the app (and environment) whose server it is, created by OpsCrew and kept in
  its infrastructure state;
- a **second app**: any other OpsCrew app that runs on that server, from another repository or as
  another app of the same one. A third or fourth app is a second app too.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Put a second app on the first app's server (Priority: P1)

A user has an app running on a server OpsCrew created for it (say on Hetzner Cloud), with room to
spare. They want a second app, from another repository, on the same server, at its own domain,
with no new server to pay for. In the second app's repository they tell the interview the app runs
on a server another of their OpsCrew apps runs on, and name that app's repository folder on this
computer. Design looks at the server and checks that the second app fits:
- its memory beside the first app's;
- its own hostnames and name;
- the same way of serving as the first app (behind Cloudflare's proxy, or DNS only).

Design says plainly what sharing means, then proposes the server at no extra cost. Provision
shows its plans, each approved by hash:
- the Cloudflare rules for the second app's zone;
- the DNS records pointing at the server;
- the changes on the server, which are only the second app's own.

The first deploy then serves the second app over HTTPS through the server's shared edge, while
the first app keeps serving.

**Why this priority**: it is the feature: one cheap server holding several small apps, set up and
kept with the same safety as one.

**Independent Test**: A first app on a throwaway created server, then a second app with its own
domain. Interview, design, provision and the first deploy run. Both sites answer over HTTPS. A
request loop against the first app's site sees no failed request during the second app's
provision and deploy.

**Acceptance Scenarios**:

1. **Given** a first app provisioned from this computer on a server OpsCrew created, **When** the
   second app's interview names the first app's repository folder, **Then** design proposes that
   server with no server cost and shows the memory left after both apps.
2. **Given** the plans shown by the second app's provision, **When** the user reads the host
   plan, **Then** it lists only the second app's own changes:
   - its deploy key line;
   - its folders;
   - its record;
   - its scheduled-check key, drills and runner as set up.

   Docker, the deploy user, SSH, the firewall, fail2ban, updates and the edge's shared files are
   never in it.
3. **Given** the plans are approved by hash, **When** the second app's first deploy runs, **Then**
   it serves at its own hostnames, with its own origin certificate and origin protection when
   proxied, and the first app's containers are not restarted.
4. **Given** a second app that would not fit, **When** design runs, **Then** it stops before any
   change and says how much memory is missing. It warns when less than 15% would stay free.
5. **Given** a first app served behind Cloudflare's proxy and a second app whose domain is not
   on Cloudflare, **When** design runs, **Then** it stops. The server's firewall lets web traffic
   in only from Cloudflare, so the second app must be proxied too. It says so and names the
   alternatives.

---

### User Story 2 - The first app's commands never break the second (Priority: P1)

The first app's own commands keep working as before, but none of them destroys, cuts off or
starves a second app without the user hearing about it first. Before a change that would remove
the server or its disk, or close the way the second app is reached, OpsCrew looks at the server,
finds the second app, refuses, and names the app and the command that removes or moves it. A
resize that still fits says that the second app restarts with the server too.

**Why this priority**: without it, an everyday command in the first app's repository (a
`destroy`, a move to another provider, closing public SSH) silently takes down an app the user
set up from somewhere else.

**Independent Test**: With a second app on the server, each command below is run in the first
app's repository and refuses before any change; after the second app's destroy each of them
works again.

**Acceptance Scenarios**:

1. **Given** a second app on the server, **When** the first app runs `opscrew destroy`, **Then**
   OpsCrew refuses before any change, naming the second app (its name and repository) and saying
   to run `opscrew destroy` in that repository first.
2. **Given** a second app on the server, **When** the first app runs any of the commands below,
   **Then** each refuses the same way:
   - `opscrew retarget` or `opscrew retarget --finish`;
   - a design that replaces the server, such as another location;
   - a whole-server restore;
   - `opscrew secure --close-public-ssh`;
   - a switch between proxied and DNS only;
   - a private network or VPN;
   - an add-on that serves on the server (Beszel, Portainer);
   - previews on that server.
3. **Given** a second app on the server, **When** the first app's design picks a smaller server,
   **Then** provision refuses when the two apps' memory limits no longer fit. When they fit, its
   plan says the second app restarts with the server.
4. **Given** the server can't be reached over SSH, **When** a refused-while-shared command runs,
   **Then** it says it couldn't look for other apps and stops. The user can run it again with
   `--skip-other-apps-check`, after a warning, and a destroy still needs its typed confirmation.
5. **Given** a second app on the server, **When** the first app runs `opscrew drift` or `opscrew
   status`, **Then** nothing of the second app counts as drift, and `status` lists it as also on
   this server.

---

### User Story 3 - The second app's own commands leave the first app alone (Priority: P1)

The second app has a full lifecycle of its own: provision again, deploys, `verify`, `drift`,
`status`, logs, snapshots and restores of its own data, credential rotation, and `destroy`.
None of them touches what belongs to the first app.

**Why this priority**: a second app that can't be updated or removed cleanly is worse than none.

**Independent Test**: The second app runs provision again (no changes), drift (none), a snapshot
and restore of its database, then a destroy. Afterwards, `deploy`'s `authorized_keys` holds
exactly the lines it held before the second app came, the edge serves the first app, and the
first app's next deploy and scheduled check pass.

**Acceptance Scenarios**:

1. **Given** a provisioned second app, **When** its provision runs again with nothing changed,
   **Then** every plan shows no changes.
2. **Given** a provisioned second app, **When** its commands log in to the server, **Then** they
   use the second app's own deploy key. The first app's repository folder is needed again only
   for design and provision, which compare against the first app's plan.
3. **Given** a provisioned second app, **When** it runs `opscrew destroy`, **Then** it removes
   only its own parts:
   - its containers, folders and site file;
   - its certificates;
   - its key lines and its record;
   - its DNS records and its Cloudflare rules.

   It keeps its data unless asked to delete it, and never removes the edge, another app's key
   line, or the server.
4. **Given** a second app, **When** it runs `opscrew secure`, **Then** it checks its own site and
   says that the server's hardening is the first app's, checked by `opscrew secure` in that
   repository.
5. **Given** a second app, **When** it asks for a whole-server snapshot or an add-on that runs on
   the server, **Then** OpsCrew refuses: those belong to the first app.

---

### User Story 4 - More apps and environments on the same server (Priority: P2)

A third app joins the same server, beside the first two, with the same checks. A second app's
staging environment can join the same server too, with its own hostname.

**Why this priority**: one server for several small apps is the point; two is just the start.

**Independent Test**: A third app joins. Design counts both other apps' memory and refuses a
hostname the second app uses. Destroying the second app leaves the first and third serving.

**Acceptance Scenarios**:

1. **Given** a first and a second app on the server, **When** a third app's design runs,
   **Then** it counts the memory limits of both, and refuses a name or hostname either one uses.
2. **Given** a second app, **When** `opscrew env add staging` runs in its repository, **Then**
   it offers the same server, at no extra cost, as one more app on it.
3. **Given** the third app's interview names the second app's repository, **When** it resolves
   the server, **Then** it says the server is the first app's, and asks for that app's
   repository folder instead.

---

### User Story 5 - Move a second app to a server of its own (Priority: P3)

When the second app outgrows the shared server, `opscrew retarget` in its repository moves it to
a server of its own (any target retarget supports). The old side removes only the second app's
own parts, and the first app keeps serving.

**Why this priority**: growth is the expected next step, but it can wait until an app needs it.

**Independent Test**: The second app is retargeted to its own throwaway created server; then the
first app's site answers, `deploy`'s keys are as they were before the second app came, and the
first app's destroy is no longer refused.

**Acceptance Scenarios**:

1. **Given** a second app, **When** its `retarget --finish` runs, **Then** the old side removes only its own
   parts, as its destroy does, and keeps the edge for the first app.

---

### User Story 6 - Move an app onto another app's server (Priority: P2)

*(Added 2026-11-19, founder: in 0.2.11, both directions.)* An app already runs somewhere: on a
server of its own (one OpsCrew created for it, one of the user's, or their Portainer), or as a
second app on another server. The user wants it beside another of their OpsCrew apps instead, on
that app's server, to stop paying for a server or to group small apps. `opscrew retarget --to own`
in its repository, with answers naming that app's repository folder (`server.shares`), moves it
there as retarget moves every app:
1. the new side is set up beside the first app, with design's sharing checks, while DNS still
   points at the old side;
2. the app is deployed and checked there;
3. its data is copied in a maintenance window;
4. DNS switches;
5. `--finish` removes the old side.

**Why this priority**: an app set up before sharing existed, or one that outgrew a shared server,
should reach another app's server without a destroy and a fresh setup.

**Independent Test**: An app on a throwaway server of its own moves onto another app's throwaway
server. A request every second against the first app's site sees no failed request through the
move. After `--finish`, the old server is gone, the moved app serves from the first app's server,
and the first app's destroy refuses, naming it.

**Acceptance Scenarios**:

1. **Given** an app on a server of its own, **When** `opscrew retarget --to own` names another
   app's server through `server.shares`, **Then** before any change it refuses what design refuses
   for a second app, and otherwise its summary shows no new server cost, the memory left after both
   apps and the shared-access warning.
2. **Given** the move's new side, **When** its host plan is shown, **Then** it holds only the
   moving app's own parts, as a second app's provision does. The first app's containers are not
   restarted through the deploy, the copy and the switch.
3. **Given** a second app on one shared server, **When** it moves onto another app's server,
   **Then** the new side is set up as a second app there, and `--finish` removes the old side as a
   second app's, keeping the edge and the first app there.
4. **Given** a move onto another app's server before its switch, **When** `--abort` runs, **Then**
   only the moving app's parts on that server are removed, and the first app keeps serving.
5. **Given** the switch is done, **When** the first app runs a command that US2 refuses, **Then**
   it refuses, naming the moved app.

---

### User Story 7 - Share a server of the user's own (Priority: P2)

*(Added 2026-11-19, founder: in 0.2.11.)* The named app runs on a server the user owns, reached at
its public address (behind Cloudflare's proxy or DNS only). The interview's "a server another of
your OpsCrew apps runs on" accepts it. The second app takes that app's address, SSH login and
way of serving, and the server's pinned host key, from this computer, so nothing about the server
is asked again. From then on it is one more app on the user's server, as several apps on one
server already are: its own deploy key, its own record, and host plans approved by hash. Its
first app's commands go on as before: OpsCrew never deletes a server the user owns.

**Why this priority**: the user shouldn't have to look up and retype a login OpsCrew already
holds, and the sharing checks and warning should be the same on every kind of server.

**Independent Test**: With fakes: a first app on an own server in public mode, a second app's
interview naming its folder, then design and provision. The second app's local state holds the
server's login, nothing of it is committed, and design shows the shared-access warning.

**Acceptance Scenarios**:

1. **Given** an app on a server the user owns, in public mode, **When** another app's interview
   names its folder, **Then** the second app's local state holds the server's address, port,
   login, key path and way of serving, and its pinned host key. Nothing of it is committed, and no
   server question is asked again.
2. **Given** such a second app, **When** design runs, **Then** it runs the own server's checks
   (name, hostnames, way of serving, proxy, memory beside every app there) and shows the
   shared-access warning.
3. **Given** a named app served through a Cloudflare Tunnel or at home, **When** the interview
   resolves it, **Then** it refuses before any change and says to answer the server questions
   with the server's own login instead.
4. **Given** such a server, **When** an app moves onto it with `opscrew retarget --to own` and
   `server.shares`, **Then** the move runs as a move to the user's server beside the apps there.

---

### Edge Cases

- The first app's repository folder is missing or not provisioned on this computer: the second
  app's design and provision say to run them where the first app was provisioned, or to name its
  folder again in its interview.
- The named app is itself a second app on someone's server: OpsCrew names the first app instead.
- The first app is a preview environment, runs previews on the server, or has its public SSH
  closed, a private network, or a VPN: the server can't take a second app. OpsCrew says why and
  what to change.
- The first app is on DigitalOcean or Contabo instead of Hetzner: same behaviour. What a provider
  offers comes from its definition, never from code that names it.
- The two apps' Cloudflare zones are in different Cloudflare accounts: each app's Cloudflare
  plan changes only its own zone.
- Both apps deploy at the same moment: the edge's lock serialises their edge changes, and each
  app's deploy waits its turn.
- The first app's edge is newer or older than the second app's OpsCrew version: a deploy keeps the
  newer one, as on every shared edge.
- The second app's services need a setting that only root on the whole server can change (the
  `vm.max_map_count` kernel setting for OpenSearch or Elasticsearch): OpsCrew refuses, since the
  server's setup is the first app's.
- The second app's name looks like the first app's previews (`<first>-pr-<n>`) or equals another
  app's: refused.
- The first app rotates its deploy key: the second app is unaffected, since it has its own.
- The first app is destroyed with `--skip-other-apps-check` while the second app runs: the second
  app's commands find no server and say so. Its destroy removes its DNS records and Cloudflare
  rules and records the deployment gone.
- A second app was destroyed with its data kept: its record stays as data kept, and the first
  app's destroy still refuses until that data is deleted or the user accepts losing it.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-3001**: The interview MUST offer "a server another of your OpsCrew apps runs on" and, for
  it, ask for that app's repository folder on this computer, its app key and its environment
  (prod by default). In a script, the answers file carries the same. The folder is kept only in
  this computer's local state, never committed.
- **FR-3002**: The named app MUST be provisioned from this computer on a server OpsCrew created
  (at any provider that creates servers), reached over public SSH, with no private network or VPN,
  no previews on that server, and not a preview environment. A named app that is itself a second
  app MUST be refused with the first app's name. Each refusal comes before any change and says
  what to change.
- **FR-3003**: Design MUST inspect the server through the first app's deploy login, checking the
  server's host key against the first app's pinned one. It MUST read the server's memory, disk and
  architecture and every second app's record, and refuse before any change when:
  - the name or a hostname is taken by the first app or another second app;
  - the name has the form `<app>-pr-<n>`;
  - the way of serving or the proxy differs from the first app's;
  - a service needs a server-wide root setting;
  - the memory doesn't fit beside the first app's limits, the other second apps' limits, the edge
    and the system reserve.

  It MUST warn when less than 15% would stay free. The option shows no server cost.
- **FR-3004**: Design's summary and the host plan's approval MUST say plainly that anyone who can
  change the second app's deploy workflow or its deploy key reaches the first app's data and
  secrets: both run as the same `deploy` user, which can become root through Docker.
- **FR-3005**: Provision of a second app MUST show and apply, each approved by its own SHA-256
  hash:
  - its Cloudflare plan (when its domain is on Cloudflare);
  - its infrastructure plan, which holds only the DNS records pointing at the server, never the
    server or its firewall;
  - its host plan.

  It then stores the deploy secrets in GitHub and opens the deploy workflow's pull request, as
  for every own-server app.
- **FR-3006**: A second app's host plan MUST hold only its own steps: its deploy key line (added
  or removed alone, every other line of `deploy`'s `authorized_keys` kept as it is), its folders,
  its record, and its scheduled-check key, drills and runner as configured. It MUST never change
  Docker, the deploy user, SSH settings, the firewall, fail2ban, automatic updates or the edge's
  shared files.
- **FR-3007**: The second app's record on the server MUST name the first app, in the format the
  own-server records use, written through the login's Docker access. No record is written for the
  first app.
- **FR-3008**: A second app's deploys MUST reach the server as `deploy` with the second app's own
  key and serve through the shared edge with its own site file and certificates. They MUST never
  recreate the first app's containers.
- **FR-3009**: After its first provision, a second app's commands MUST log in with its own deploy
  key. They need the first app's repository folder only in design, provision, `drift` and
  `rotate deploy-key`, which compare against the first app's plan; destroy and the rest never
  need it.
- **FR-3010**: A second app's destroy MUST remove only its own parts on the server and in its
  zone (FR-3006's, plus containers, site file, certificates, DNS records and Cloudflare rules). It
  keeps its data unless `--delete-data` is given, and never removes the edge, the check key line
  of another repository, another app's key line or the server.
- **FR-3011**: A second app's `drift`, `status`, `verify`, logs, snapshots and restores of its
  data and credential rotation MUST work on its own parts only. Its `secure` checks its own site
  and refers to the first app for the server's hardening. A whole-server snapshot or restore and
  server add-ons (Beszel, Portainer) MUST be refused for it.
- **FR-3012**: While the server holds a second app (an active record, or one with its data kept),
  the first app's commands MUST refuse before any change, naming each second app and the command
  to run in its repository:
  - destroy;
  - retarget (start and finish);
  - a design that replaces the server;
  - a whole-server restore;
  - closing public SSH;
  - switching the serving mode;
  - a private network or VPN;
  - Beszel or Portainer;
  - previews on that server.
- **FR-3013**: While the server holds a second app, the first app's provision MUST refuse a
  resize whose memory no longer holds both apps. One that fits MUST say the second app restarts
  with the server.
- **FR-3014**: The first app's check MUST inspect the server through the first app's deploy
  login. When the server can't be reached, or holds only a second app's kept data, it MUST say so
  and stop, unless `--skip-other-apps-check` is given, after a plain warning. The flag MUST never
  let a command go on past a second app that runs there. Typed confirmations stay as they are.
- **FR-3015**: The first app's `drift` MUST not report a second app's parts (its key lines,
  folders, record, site file, certificates) as drift. Its `status` MUST name each second app on the
  server.
- **FR-3016**: The first app's design and `advise` MUST count the second apps' memory limits,
  read from their records, whenever they inspect the server.
- **FR-3017**: `opscrew env add` for a second app MUST offer the same server by default, set up as
  one more second app, with its own hostname.
- **FR-3018**: `opscrew retarget` of a second app MUST remove only its own parts at the old side,
  keeping the edge and the first app's parts.
- **FR-3019**: The first app's deploy key MUST never leave this computer or be copied into the
  second app's state or GitHub secrets. Only the server's public host key is copied, pinned for
  the second app. No secret, key or server address appears in output, logs, audit entries,
  reports, commits or fixtures.
- **FR-3020**: The guide MUST explain sharing a created server (how to set it up, what each app
  can do, what is refused and why, and the shared-access warning). The pages of the first app's
  refused commands MUST link to it. The matching MCP tools MUST take the same inputs as the CLI.
- **FR-3021**: `opscrew retarget --to own` MUST accept the `server.shares` answers (in
  `--answers <file>` and in the terminal's questions) and move the app onto that app's server. The
  old side may be any that retarget moves from: a server OpsCrew created for the app, a server of
  the user's, a Portainer, or another shared server. Each step runs as in every move: the new side
  beside the first app with DNS on the old side; the deploy and its check; the copy in a
  maintenance window; the switch; `--finish` removing the old side through its usual path (a
  second app's old side as FR-3018).
- **FR-3022**: Before any change, such a move MUST run the checks design runs for a second app
  (FR-3002, FR-3003) with the moving app's plan, and show no server cost, the memory left and the
  shared-access warning (FR-3004).
- **FR-3023**: A move onto a server OpsCrew created for another app MUST set the new side up as
  that server's second app. Its infrastructure plan holds only the DNS records, changed at the
  switch, and its host plan is the second app's, through the first app's deploy login. Each is
  approved by its hash. `--abort` removes only the moving app's parts there, as a second app's
  destroy does, and leaves its DNS on the old side.
- **FR-3024**: Provision MUST run design's shared-server memory check, with its warning below 15%
  free, before it plans anything: for a second app, for an app on a server of the user's that
  holds other apps, and for a first app's resize (FR-3013). A second app's hand-edited plan can't
  overcommit a shared server: provision refuses in design's words, before any change. A first
  app on a server OpsCrew created that raises its own limits without a resize is not checked:
  provision looks at that server only when it changes it, and a look on every provision is left
  for later (tasks: the follow-up after T3020).
- **FR-3025**: The interview MUST accept, for FR-3001's option, a named app on a server the user
  owns in public mode. It copies that app's address, port, login, key path and way of serving from
  this computer's local state, and the server's pinned host key, into the second app's local
  state. It MUST refuse a named app served through a Cloudflare Tunnel or at home, saying to answer
  the server questions with the server's own login instead. Design MUST show the shared-access
  warning whenever a server the user owns already holds another OpsCrew app.
- **FR-3026**: With `server.shares`, the interview MUST neither ask for nor require a monthly
  budget. One given in an answers file is kept, validated as usual.
- **FR-3027** *(found live, 2026-11-20)*: A move that copies data to a server MUST NOT run the
  app's release command or start the app there before the copy:
  - **Before the copy,** while the new side waits for its data, the new side's deploys bring up
    only the image and the app's services.
  - **In the maintenance window, after the copy,** the deploy runs once more with the same image.
    The release command then runs on the copied data, the app starts and passes its health check,
    and only then does the switch come.

  An app whose release command or health check needs its existing schema (the framework's `migrate`
  needs its `settings` table) otherwise fails on the new side's empty database.

### Key Entities

- **First app**: the app and environment whose infrastructure state holds the server. Its plan
  gives the second apps their comparisons (name, hostnames, serving mode, proxy, memory).
- **Second app**: an app on the first app's server, with its own state, deploy key, workflow,
  approvals and record on the server.
- **Second app's record**: on the server, in the own-server records' format. It holds the app's
  name and project, hostnames, folders, memory limits, deploy key, state (active or data kept)
  and the first app's name.
- **Sharing reference**: in the second app's local state, the first app's repository folder, app
  key and environment on this computer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-3001**: A user with a first app on a created server has a second app, from another
  repository, answering over HTTPS beside it within 30 minutes of starting its interview, with no
  new server.
- **SC-3002**: During a second app's provision, first deploy and destroy, a request every second
  against the first app's site sees no failed request.
- **SC-3003**: After a second app's destroy, `deploy`'s `authorized_keys` on the server holds
  exactly the lines it held before that app came, and the first app's next deploy and scheduled
  check pass.
- **SC-3004**: Every first-app command listed in FR-3012 refuses before any change while a second
  app is on the server, and runs again once it is gone.
- **SC-3005**: A second app's provision run twice shows no changes the second time, and the
  first app's `drift` reports nothing of the second app.
- **SC-3006**: No token, key or server address appears in any output, log, commit or report of
  the feature's live passes.

## Assumptions

- The first app was provisioned on this computer, which keeps its state, its deploy key and the
  server's pinned host key. The second app's design and provision run there.
- The first app's server allows public SSH (from GitHub Actions and this computer), as servers
  OpsCrew creates do by default.
- Every app on the server has its own domain or subdomain. With the first app behind Cloudflare's
  proxy, the second app's domain is on Cloudflare too.
- The second app and the first share one `deploy` user. OpsCrew keeps them apart by convention
  and by their own folders, records and key lines, not by a security boundary. The user is told
  so (FR-3004).
- Own-server records, `claimFindings`, the memory check, the shared edge, root through Docker and
  host plans approved by hash already exist and are reused, not rebuilt (research R3).
