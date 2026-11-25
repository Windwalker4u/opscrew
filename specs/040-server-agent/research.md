# Research: OpsCrew's agent on the server, for live logs and status

**Feature**: 040 | **Date**: 2026-11-25 | **Design**: [ADR 0036](../../docs/adr/0036-server-agent.md)
(Proposed), agreed with the hosted dashboard's lead, whose side (its feature 009) is built against
the ADR as of commit `db237378`.

ADR 0036 leaves four points to this research: the agent's image and where it is built (R1), how a
Portainer stack reaches Docker (R5), the deploy steps it reports (R3), and a self-hosted dashboard's
URL (R6). R2, R4 and R7–R9 settle what the build needs besides them. Nothing here changes the ADR's
names, messages, limits or token storage. What looked wrong or open is in the spec's "Questions for
the lead".

Sources: the ADR; the repository's code as of `bb029268`; the Docker Engine API v1.47 OpenAPI file
(docs.docker.com/reference/api/engine/version/v1.47.yaml, read 2026-11-25); undici's WebSocket
documentation (github.com/nodejs/undici, `docs/docs/api/WebSocket.md`, read 2026-11-25); RFC 6455
(The WebSocket Protocol).

## R1. The agent's program: a vendored script on the pinned Node image, no image of OpsCrew's

**Decision:** the agent is TypeScript in a new package, `@opscrew/server-agent`. It is bundled into
one JavaScript file, `agent.mjs`, which uses only Node's built-in modules at run time. The bundle
is committed as a generated module, the way `check.mjs` is (`packages/iac-templates/src/generated/`).
Provision writes it into the user's repository (`opscrew/runtime/agent/agent.mjs`), and the deploy
copies it to the server with the other runtime files. On the server it runs on the Node image
OpsCrew already pins by digest (`IMAGES.nodeAlpine`, `node:24-alpine@sha256:…`), mounted read-only.

**Why:**
- **No image to publish:** an OpsCrew image on a registry would need a build and a publishing step
  in each release, several architectures, and the founder's approval for each push. A pinned
  public image plus a file in the user's repository needs none of that.
- **The user owns it (constitution II):** the agent's code is a plain file in their repository,
  reviewed in the deploy-setup pull request like the Compose file. Deleting OpsCrew leaves it
  readable; removing it is deleting two services from the Compose file.
- **Updates are pinned:** a new OpsCrew release changes the file, `opscrew provision` shows the
  change in its pull request, and the next deploy runs it. The image changes only when
  `scripts/update-pins.mjs` refreshes the digest, as for every other pinned image.
- **One redactor (ADR 0036, 3):** bundling lets the agent use `@opscrew/core`'s `Redactor` and the
  protocol's zod schema, rather than a second copy of either.

**The bundler:** esbuild (already in the lockfile through tsup), as a devDependency of the new
package, run by its `gen:bundle` script. A test rebuilds the bundle and fails when the committed
one differs, as `gen:modules` does for the modules. A dependency is the lead's to add (T4000).

**Alternatives rejected:**
- **An image on GHCR built by OpsCrew's release:** needs a publishing pipeline and the founder's
  approval at each release. Kept as the way to Portainer (R5) once there is a reason.
- **A hand-written `.mjs` with no dependencies,** as `check.mjs`: it would need its own copy of the
  redactor's rules and of the protocol's checks, which drift.
- **`npx opscrew agent` on the server:** downloads from npm at every start, and needs the whole
  CLI on the server.

**The bundle's version:** `hello.agent` is `AGENT_VERSION`, a constant in the package's source,
raised when the agent's behaviour changes. `hello.opscrew` is the CLI version that rendered the
Compose file (`RenderContext.opscrewVersion`), passed in the agent's environment.

## R2. The WebSocket client: Node's `https` upgrade and RFC 6455 frames, written in the package

The ADR asks the agent to stop reconnecting when the upgrade is refused with HTTP 401 or 403.

- **Node's global `WebSocket`** (undici) takes extra handshake headers through a `WebSocketInit`
  object: "`headers` — Additional headers to send with the handshake request", "an undici
  extension and is not available in browsers". So `Authorization: Bearer <token>` is possible.
- **But a failed handshake's status isn't exposed:** the documentation names only the `error`
  event ("terminated abnormally") and `close`'s `code` and `reason`. A refused token and a
  dashboard that is down would look the same.

**Decision:** a small client in the package, on `node:https`:
- `https.request` with `Upgrade: websocket`, `Sec-WebSocket-Key`, version 13 and the bearer token;
- a `response` event (any status other than 101) gives the status, so 401 and 403 are told apart;
- the `upgrade` event gives the socket, and the client checks `Sec-WebSocket-Accept`;
- frames per RFC 6455: text, continuation, ping, pong and close; masked from the client; 7-, 16-
  and 64-bit lengths; a message above the ADR's 64 KiB closes the connection with 1009 before it
  is buffered.

The connection is injected (a function returning a duplex stream and the handshake's status), so
every test runs over in-memory streams. About 250 lines; no dependency.

**Rejected:** the `ws` package (a runtime dependency for what 250 lines do), and a probe `fetch`
after a failed connection (its answer depends on how the dashboard treats a plain GET).

## R3. The deploy steps it reports

The agent can only see what happens on the server, so it reports the steps the deploy runs there.
The build, the image scan and the outside check run on GitHub's runners, and the dashboard already
sees them through the run itself.

**Decision:** the deploy appends one line per change to `.deploy-progress` in the app's folder:

```text
<run id>\t<step>\t<state>\t<at>
```

| `step` | When the deploy writes it |
|---|---|
| `upload` | the runtime files and env files are being written (the file is emptied first) |
| `release` | the release command runs (only with `app.releaseCommand`) |
| `start` | the new copy started and waits for its health check |
| `switch` | the edge sends requests to the new copy, and the old one stops |

- **`state`:** `running` when a step begins. `done` with the last step when the deploy succeeded.
  `failed` with the step that failed.
- **A rollback** writes the same steps; it has no `release` unless it changes the database.
- **`at`:** `date -u +%Y-%m-%dT%H:%M:%SZ` on the server.
- **The run id:** `${{ github.run_id }}`, as a string (the agreed `deploy.deploy`).

The agent reads the file, never writes it. It sends one `deploy` message per new line. On a new
connection it sends every line of the newest deploy again when that deploy started or ended under
an hour ago, so a dashboard that reconnects mid-deploy sees where it is. The dashboard keys
progress by deploy id and step, so a resent step updates in place (its lead, 2026-11-25). A line that doesn't parse (a step or state outside the
lists, a run id that isn't digits) is skipped.

The lines are written only when the agent is installed, so every other deployment's workflow stays
byte for byte as it is.

## R4. Docker access: the add-ons' socket proxy, bound to the app's own containers

Feature 017 already runs a read-only Docker proxy for Beszel and Grafana Alloy
(`packages/iac-templates/src/addons/proxy.ts`):
- pinned Caddy, as root in the deploy user's group;
- no network, a read-only root, 32 MB;
- only `GET` and `HEAD` on an allow-list of API paths, and 403 for everything else.

The agent reuses it, with a list of its own. From the Engine API v1.47:

| Path | Why |
|---|---|
| `_ping` | whether Docker answers (`unavailable` otherwise) |
| `containers/json` | the app's containers, with `filters={"label":["com.docker.compose.project=<project>"]}` |
| `containers/<name>/json` | restarts (`RestartCount`), `State.StartedAt`, `State.Health.Status`, `HostConfig.Memory` |
| `containers/<name>/logs` | `follow`, `stdout`, `stderr`, `since` (a Unix time), `timestamps`, `tail` |
| `containers/<name>/stats` | memory now; `stream=false&one-shot=true` ("Only get a single stat instead of waiting for 2 cycles") |

- **The per-container paths are bound to the app:** they accept only the app's own container
  names, `<project>-(<service>|…)-<n>`, with the services known when the Compose file is rendered.
  The agent of one app on a shared server (ADR 0035) gets 403 for another app's container, whatever
  its code asks. The listing can't be bound that way, so the agent also checks each container's
  project label before it reads it.
- **Logs are multiplexed:** without a TTY (OpsCrew's containers have none) the logs come as frames
  with an 8-byte header, `[STREAM_TYPE, 0, 0, 0, SIZE1…SIZE4]`. `STREAM_TYPE` 1 is stdout and 2 is
  stderr, which gives the `stream` field. With `timestamps` each line starts with an RFC 3339 time,
  which becomes `ts`.
- **Inspect holds the app's environment** (`Config.Env`), as ADR 0021 says for Alloy. The agent
  parses inspect with a zod schema that keeps only the four fields above, so the environment never
  reaches a message.

## R5. Portainer: not in the first version

The ADR lists the Portainer stack, and leaves how its proxy reaches Docker to this research.
- **No files on the host:** the stack has none, so the agent's script would go inline in the
  stack file as a Compose `config`, a few hundred KB, at each stack update.
- **The proxy needs the host's socket:** that means a bind mount of `/var/run/docker.sock`, which a
  Portainer with "disable bind mounts for non-administrators" refuses for the token OpsCrew uses.
- **A published image** (R1's rejected option) would solve the first. The second stays a
  per-Portainer question.

**Decision (a departure from the ADR's list, which the lead accepted on 2026-11-25):** 0.2.13
installs the agent on servers only:
- a server OpsCrew created (Hetzner Cloud, DigitalOcean, Contabo);
- a server of the user's, at home or not, public or through a tunnel.

On a Portainer target with a token, provision says plainly that the agent isn't available there
yet and that the dashboard keeps reading logs through GitHub Actions. It changes nothing for that.

## R6. A self-hosted dashboard's URL

The URL is already the repository variable `OPSCREW_AGENT_URL` (agreed), so a self-hosted
dashboard sets its own address there; nothing else is needed. Provision accepts only a `wss://`
URL with a host and no credentials in it, and refuses any other with a plain message. The agent
checks the server's certificate against Node's own CA list. A private CA is left for later.

## R7. Where the agent runs, and what it reaches

- **The app's Compose project, on the app's server:** one agent per app environment, as the ADR
  decides (one token per environment). There is no agent on an extra server (feature 018). The
  `status` reply lists the services on the app's server; the services on other servers are left
  for later.
- **Its own network:** the agent is on a bridge network of its own, `agent`, never the project's
  `internal` network or the edge's. It reaches the internet and the proxy's socket (a volume), not
  the app or its database.
- **Its user:** the deploy user's uid and gid, so it can read `app.env` (mode 0600). The deploy
  writes them into the project's `.env` beside `APP_IMAGE`, as the edge's deploy does into
  `/srv/edge/.env`.
- **Hardening:** a read-only root, no capabilities, `no-new-privileges` (`hardened`), and the
  project's log rotation.
- **Memory:** 64 MB for the agent (Node with `--max-old-space-size=32`), and 32 MB for the proxy,
  as the add-ons have. Provision's server-fit check counts those 96 MB when the agent is on.
- **The edge's logs are left out:** the shared edge's lines include every app's requests on the
  server.

## R8. Redaction on the server

The ADR: every line and message passes the core's redactor, loaded with `app.env`'s values and the
agent's own token.
- **Also each service's env file:** the agent loads every `<service>.env` in the app's folder too
  (a database's password stands alone there, while `app.env` has it only inside `DATABASE_URL`).
  That adds to what the ADR lists and takes nothing away.
- **Reloaded on change:** the files are re-read when their modification time changes, checked at
  each request and every 10 seconds, since a deploy rewrites them.
- **What is masked:** `log.line`, `error.message`, and any `status` field a container controls.
- **Mounts:** the files are mounted read-only, one by one; the agent sees no other file of the app's
  folder. It never sends a value from its own environment.

## R9. Installing and removing it: the app's own files, not a host plan

The ADR has `opscrew provision` install it "as a container in the app's Compose project".
- **Nothing outside the project changes on the server:** no file outside the app's folder, no
  login, no system setting. So there is no host plan.
- **The gate is the one every Compose change already has:**
  - the generated files go into the deploy-setup pull request (the `pull-request` approval);
  - the deploy workflow applies them when it is merged;
  - the GitHub side (the token and the URL) is the dashboard's, written through its GitHub App.
- **Whether it's on:** provision reads whether the environment has its token, by name only, and
  never its value. It checks the deploy job's GitHub environment first, then the repository. It
  also reads the `OPSCREW_AGENT_URL` variable.
  - Both present: the agent's files are rendered and the workflow writes `agent.env`.
  - Either missing: neither is rendered.
- **Removal:** a token deleted on GitHub stays valid on the dashboard's side, which keeps only a
  hash (its lead, 2026-11-25). So the next deploy after the files go removes the agent's
  containers and deletes `agent.env`, through removal lines that stay in that environment's
  workflow from then on. A workflow that never had the agent gains none.
- **The other ways it goes:**
  - a server's destroy removes it with the server;
  - an own server's teardown (and a second app's, ADR 0035) removes the project's containers and
    deletes `agent.env`, even when the data is kept;
  - `opscrew destroy` deletes the environment's token with its other deploy secrets.
- **Shares:** each app has its own agent and proxy in its own project, so nothing is shared, and
  the last app's removal has nothing extra to do.

**Rendering elsewhere:** other callers that render the deploy files (`opscrew_render`, the checks
that compare with the committed files) use one helper. It asks GitHub the same way, and without
GitHub it keeps what the committed Compose file has.
