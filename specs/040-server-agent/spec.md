# Feature Specification: OpsCrew's agent on the server, for live logs and status

**Feature Branch**: `040-server-agent`

**Created**: 2026-11-25

**Status**: Draft

**Input**: The founder's decision of 2026-11-21, at the hosted dashboard's request: a small agent
on the server streams an app's logs, its containers' state and a deploy's progress to the
dashboard in about a second, rather than the 47-second median of a GitHub Actions job. Design and
protocol: [ADR 0036](../../docs/adr/0036-server-agent.md) (Proposed). Research:
[research.md](research.md). Ships in 0.2.13 with 032.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The dashboard shows an app's logs at once (Priority: P1)

A user opens their app in the hosted dashboard and asks for its logs. The latest lines appear in
about a second and new ones follow as they come, without a GitHub Actions run. Secrets the app
prints are masked before they leave the server.

**Why this priority**: it is the feature's reason: the dashboard's logs take 47 seconds today.

**Independent Test**: with a fake dashboard (a WebSocket server in the test), the agent answers a
`logs` request with the service's latest lines, then `end`; with `follow`, it sends new lines until
`cancel`.

**Acceptance Scenarios**:

1. **Given** an app with the agent installed and connected, **When** the dashboard sends
   `logs {service: "app", tail: 200}`, **Then** the agent sends up to 200 `log` messages with
   `ts`, `stream` and the redacted `line`, oldest first, then `end {reason: "done"}`.
2. **Given** a `follow` request, **When** the app prints new lines, **Then** each arrives as a
   `log` message within a second, until `cancel` (`end {reason: "cancelled"}`), 30 minutes
   (`limit`), or the containers stop (`gone`).
3. **Given** an app that prints a value of its `app.env` or the agent's own token, **When** the
   line is sent, **Then** the value is masked.
4. **Given** an app printing more than 200 lines a second, **When** it follows, **Then** the agent
   sends at most 200 a second and a `dropped` count for the rest.

---

### User Story 2 - The dashboard shows the containers' state and a deploy's progress (Priority: P1)

The dashboard shows whether each part of the app runs, is healthy, how often it restarted and how
much memory it uses. While a deploy runs, it shows which step the server is at, and whether it
succeeded or failed.

**Why this priority**: status and deploy progress are the other two reads the ADR covers, and the
dashboard is built against them.

**Independent Test**: with a fake Docker API and a progress file, the agent answers `status` with
each service, and sends a `deploy` message for each new line of the progress file.

**Acceptance Scenarios**:

1. **Given** a connected agent, **When** the dashboard sends `status`, **Then** the reply lists
   every service of the app on its server with `state`, `health` where it has a health check,
   `restarts`, `startedAt` (absent for a container that never started), `memoryMb`,
   `memoryLimitMb` where it has a limit, and `image`.
2. **Given** a deploy running, **When** it reaches each step on the server, **Then** the agent sends
   `deploy {deploy: <run id>, step, state: "running", at}`, and at the end `state: "done"` or
   `"failed"` with the step that failed.
3. **Given** Docker not answering, **When** a request needs it, **Then** the agent answers `error`
   with code `unavailable` and a plain-English message, and keeps the connection open.

---

### User Story 3 - The agent can't change anything, and leaks nothing (Priority: P1)

The user lets a process on their server talk to a hosted service. It can only read, it never
sends a secret, and taking over the dashboard gives nobody a way to change their server.

**Why this priority**: constitution I and IV. A command channel on the server would let whoever
took over the dashboard run commands on every user's server (roadmap 041).

**Independent Test**: the Compose file's agent has no Docker socket, and its proxy refuses every
method but `GET` and `HEAD` and every path but the app's own containers' reads. The protocol has
no message that changes anything. A test sends every message type with hostile fields and finds
no Docker call besides the allowed reads, and no secret in any message.

**Acceptance Scenarios**:

1. **Given** the rendered Compose file, **When** it is read, **Then** only the proxy mounts Docker's
   socket, the proxy has no network, and the agent is on a network of its own, apart from the app.
2. **Given** the proxy, **When** anything asks it to create, start, stop, exec, remove or read
   another app's container, **Then** it answers 403 (a Docker test with the real proxy).
3. **Given** any message from the dashboard, **When** the agent handles it, **Then** it calls only
   the proxy's allowed reads and reads only its mounted files. A message of an unknown type gets
   `error {code: "unknown_type"}`.
4. **Given** the token refused (HTTP 401 or 403 on the upgrade), **When** the agent sees it,
   **Then** it stops reconnecting and says so in its own log, until the next deploy restarts it.

---

### User Story 4 - It runs only where the dashboard is used, and goes with it (Priority: P2)

A deployment that doesn't use the dashboard never runs an agent. Once the dashboard stores the
environment's token and the URL, the next `opscrew provision` adds the agent in its pull request.
When the token goes, the next provision removes it, and destroying the app removes it with
everything else.

**Why this priority**: leaving the dashboard must cost nothing and leave nothing (ADR 0036, 1).

**Independent Test**: provision with fakes: with the token and the URL, the generated files
include the agent and the workflow writes `agent.env`. Without either, the files are byte for byte
those of today.

**Acceptance Scenarios**:

1. **Given** an environment with no agent token, **When** provision renders, **Then** no agent
   file, service or workflow line exists, and every existing snapshot is unchanged.
2. **Given** the token (in the deploy job's GitHub environment, or the repository) and
   `OPSCREW_AGENT_URL`, **When** provision runs, **Then** its pull request adds the agent's
   script, its proxy's settings and the two services, and says in plain words what the agent can
   and cannot do.
3. **Given** the agent installed, **When** the token is deleted and provision runs again, **Then**
   the files go, and the next deploy removes the agent's containers and deletes `agent.env`.
4. **Given** an app with the agent, **When** it is destroyed or torn down (data kept or not),
   **Then** no agent container and no `agent.env` stays on the server, and the environment's
   token is deleted with its other deploy secrets.
5. **Given** a Portainer target, a static site, a hosting account or this computer, **When** the
   environment has a token, **Then** provision installs nothing there and says why.

---

### User Story 5 - Several apps on one server each have their own (Priority: P2)

On a server shared by several apps (ADR 0035), each app environment that uses the dashboard has
its own agent, with its own token, which sees only that app's containers.

**Why this priority**: shared servers are shipped (0.2.11), and one app's token must never read
another app's logs.

**Independent Test**: two apps' rendered Compose files on one fake server. Each proxy's allow-list
accepts only its own app's container names, and each agent lists only containers with its own
project's label.

**Acceptance Scenarios**:

1. **Given** apps `shop` and `shop-admin` on one server, **When** `shop`'s agent asks its proxy for
   `shop-admin-app-1`'s logs, **Then** the proxy answers 403.
2. **Given** a second app's teardown, **When** it runs, **Then** the first app's agent keeps
   running.

---

### Edge Cases

- **The dashboard is down or unreachable:** the agent reconnects with a backoff from 1 s to 60 s,
  with jitter, and costs nothing meanwhile beyond its memory.
- **A request for a service the app doesn't have,** or for `edge`, `release` or the agent itself:
  `error {code: "no_such_service"}`.
- **A fifth follow:** `error {code: "too_many_follows"}`; the four running go on.
- **`tail` above 5000, a bad `since`, a missing `id`:** `error {code: "bad_request"}`.
- **A message above 64 KiB from the dashboard:** the agent closes the connection with code 1009
  and reconnects. A malformed or binary message gets `bad_request`, the connection kept. A log line too long for one message is cut so the message
  fits, and ends with `…`.
- **A higher major `v`:** `error {code: "unsupported_version"}`, and the connection stays open.
- **A deploy while a follow runs:** the old containers stop (`end {reason: "gone"}`); the
  dashboard asks again for the new ones.
- **The app scaled to two copies during a switch:** `status` reports each service once, from its
  newest container, with `name` the service's name and a service without one as `missing` (the
  dashboard's lead, 2026-11-25);
  `logs` reads every container of the service, merged by time.
- **A server at home or behind a tunnel:** the connection is outbound only, so it works with no
  port open and with the Cloudflare-only filter.
- **A plan service named `opscrew-agent` or `opscrew-agent-proxy`:** rendering refuses it with a
  plain message, since the names are the agent's.
- **`OPSCREW_AGENT_URL` not `wss://`:** provision refuses to install the agent, says what the
  variable must hold, and changes nothing else.
- **The environment has the token but the repository has no URL variable** (or the other way
  round): no agent, and provision says which one is missing.

## Requirements *(mandatory)*

### Functional Requirements

**Where it runs**

- **FR-4001**: OpsCrew MUST install the agent only for an app environment that has an agent token
  and an `OPSCREW_AGENT_URL`. The token is named `deploySecretPrefix(appKey, env) + "AGENT_TOKEN"`,
  stored in the deploy job's GitHub environment when it has one, else in the repository. The URL is
  a repository variable. Provision MUST read only the names, never a value.
- **FR-4002**: In this version the agent MUST run on the app's server of a server OpsCrew created
  (Hetzner Cloud, DigitalOcean, Contabo) and of a server the user owns, in public or tunnel mode,
  at home or not. On a Portainer target, a static site, a hosting account, this computer, an extra
  server (018) and a preview, provision MUST install none, and with a token it MUST say why.
- **FR-4003**: The agent MUST run as two services of the app environment's own Compose project:
  `opscrew-agent` and its Docker proxy, `opscrew-agent-proxy`. So there is one per app environment,
  and on a shared server each app has its own.

**What it can do**

- **FR-4004**: The agent MUST only read:
  - a service's logs;
  - the app's containers' state;
  - the deploy's progress file;
  - its mounted env files, for redaction.
  It MUST have no message, code path or mount that changes the server, starts a process or reads
  another file.
- **FR-4005**: The agent MUST NOT mount Docker's socket. Its proxy MUST pass only `GET` and `HEAD`
  on `_ping`, the container listing, and the inspect, logs and stats of the app's own containers
  (named `<project>-<service>-<n>`, the services known when the file is rendered). It MUST answer
  403 to everything else.
- **FR-4006**: The agent MUST read only the containers whose Compose project label is its own
  project, and MUST offer only the app's services on the app's server. The shared edge, one-off
  containers (`release`, `seed`) and its own two services are never offered.
- **FR-4007**: The agent MUST implement ADR 0036's protocol version 1 exactly:
  - its messages, fields, error codes and limits;
  - 64 KiB per message, a follow ending after 30 minutes, 4 follows at once, 200 lines a second per
    stream with `dropped` counts, and a tail of at most 5000;
  - unknown fields ignored, `unknown_type` and `unsupported_version` answered with the connection
    kept.
- **FR-4008**: The protocol's messages MUST be one zod schema, exported from `@opscrew/server-agent`
  and also written as a JSON Schema file in the repository, for the dashboard. The agent MUST
  parse every message it receives with it, and a test MUST fail when the JSON Schema file is out of
  date.
- **FR-4009**: The `hello` message MUST carry:
  - `agent`: the agent's version;
  - `app`: the app's name in its plan;
  - `environment`: its name, `prod` for the default;
  - `opscrew`: the CLI version that rendered it;
  - `services`: the offered services.
  `app` and `environment` are for display only.
- **FR-4010**: The deploy MUST write the deploy's progress on the server (R3): the steps `upload`,
  `release` (with a release command), `start` and `switch`, each `running`, then `done` or `failed`,
  with the GitHub Actions run id. The agent MUST send them as `deploy` messages, the run id as a
  string. On a new connection it MUST send every step of the newest deploy again when that deploy
  started or ended under an hour ago; the dashboard keys progress by deploy id and step, so a
  resent step updates in place.

**What it never sends**

- **FR-4011**: Every `log` line, `error` message and container-controlled `status` field MUST pass
  `@opscrew/core`'s redactor before it is sent. The redactor is loaded with:
  - the values of `app.env`;
  - the values of every `<service>.env` of the app;
  - the agent's own token.
  The files are re-read when they change.
- **FR-4012**: The agent MUST NOT send any value of its environment, any container's environment
  (inspect's `Config.Env`), any file's content but redacted log lines, or the server's addresses.
  It MUST log to its own output only what it does (connected, refused, reconnecting), never a
  token, a URL's credentials or a log line.

**Its connection**

- **FR-4013**: The agent MUST open one outbound `wss://` connection to `OPSCREW_AGENT_URL`, with
  `Authorization: Bearer <token>` on the upgrade, and listen on no port. It MUST check the server's
  certificate.
- **FR-4014**: It MUST reconnect with an exponential backoff from 1 s to at most 60 s, with
  jitter. On HTTP 401 or 403 at the upgrade, it MUST stop reconnecting, say in its log that the
  token was refused, and wait to be restarted.
- **FR-4015**: It MUST answer every `ping` with a `pong` of the same `id` at once, also while
  follows stream.

**Install, update and removal**

- **FR-4016**: Provision MUST install the agent through the app's own generated files, in the
  deploy-setup pull request: the agent's script, its proxy's settings and the two services. The
  deploy MUST apply them, under the same approval every Compose change has. The agent's image MUST
  be OpsCrew's pinned Node image, by digest, and its script a file in the user's repository.
- **FR-4017**: Every deploy of an environment with the agent MUST:
  - write `agent.env` in the app's folder, mode 0600, owned by the deploy user, holding the URL and
    the token, never in a log;
  - write the deploy user's uid and gid into the project's `.env`;
  - restart the agent.
- **FR-4018**: When the agent's files are no longer rendered, the next deploy MUST stop and remove
  its containers and delete `agent.env` and `.deploy-progress`. A token deleted on GitHub stays
  valid on the dashboard's side (it keeps only a hash), so a stale `agent.env` MUST never stay.
  The removal lines stay in that environment's workflow from then on, a no-op once done; a
  workflow that never had the agent gains none.
- **FR-4019**: Destroying the app environment, and the teardown of an app on a server the user
  owns or a shared server (ADR 0035), MUST remove the agent's containers with the app's, inside
  its Compose project, and delete `agent.env` in the same teardown, even when the data is kept.
  Destroy MUST delete the environment's agent token with its other deploy secrets. Revoking the
  token on the dashboard's side is the dashboard's, when it starts a destroy (041).
- **FR-4020**: Provision's server-fit check MUST count the agent's 96 MB (64 for the agent, 32 for
  its proxy) when the agent is on.
- **FR-4021**: Provision MUST accept only a `wss://` URL with a host and no credentials, and refuse
  any other with a plain message that says what to set.
- **FR-4022**: `opscrew status` MUST say when the app runs OpsCrew's agent, and whether its
  containers run.

**Tests and docs**

- **FR-4023**: Every unit test MUST run without the network:
  - the WebSocket client over in-memory streams;
  - Docker through a fake API;
  - GitHub through its fakes.
  A Docker test, run only with `OPSCREW_DOCKER_TESTS=1`, MUST run the rendered agent and proxy
  against a fake dashboard in the test.
- **FR-4024**: A guide page MUST say, in plain English:
  - what the agent is and does;
  - what it can't do;
  - what it sends and what it masks;
  - that anything with the deploy user's access on the server can read its token, and send
    the dashboard false logs with it;
  - how it's installed and removed;
  - what it costs in memory.

### Key Entities

- **Agent token**: one per app environment, minted by the dashboard and stored in GitHub. It lets
  the agent connect and names exactly one environment on the dashboard's side.
- **Agent URL**: the repository variable `OPSCREW_AGENT_URL`, the dashboard's `wss://` address.
- **The agent**: the script, its pinned image, its service and its proxy in the app's Compose
  project; `agent.env` on the server.
- **Progress file**: `.deploy-progress` in the app's folder, one line per deploy step change.
- **Protocol v1**: the zod schema and its JSON Schema file.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-4001**: The latest 200 lines of a service reach the dashboard within 2 seconds of its
  request (the live pass; ADR 0036 aims at about one second).
- **SC-4002**: A followed new line reaches the dashboard within 1 second of the app writing it.
- **SC-4003**: Under 4 follows at the rate limit, the agent stays under 64 MB and the proxy under
  32 MB (the Docker test).
- **SC-4004**: A secret value of `app.env`, a service's env file, or the token, printed by the app,
  never appears in any message (every test that sends a line ends with a leak check).
- **SC-4005**: An environment that never had the agent renders exactly today's files (every
  existing snapshot unchanged).
- **SC-4006**: Every write path to Docker the proxy is asked for gets 403 (the Docker test runs the
  create, start, stop, kill, exec, remove and another app's logs calls).

## Assumptions

- The dashboard mints the token, stores it through its GitHub App under the agreed name and place,
  sets `OPSCREW_AGENT_URL`, and asks the user to run `opscrew provision` (or, after 041, runs it).
- The dashboard's side of the protocol is built against ADR 0036 as of `db237378`. Any change found
  here goes to its lead before the ADR is Accepted.
- Outbound HTTPS is open on every target: cloud firewalls OpsCrew writes leave outbound open, and
  own servers' outbound policy is the user's.
- Portainer, extra servers and the edge's logs are left for later (research R5, R7; the lead's
  decision of 2026-11-25).
- The live pass uses the dashboard's real endpoint, `wss://app.opscrew.dev/agent` (there is no
  staging), with a token minted in an operator's workspace whose token card the dashboard's lead
  turns on for it. The card opens to every workspace once 0.2.13 is out.
