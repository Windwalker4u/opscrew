# Implementation Plan: OpsCrew's agent on the server, for live logs and status

**Branch**: `040-server-agent` | **Date**: 2026-11-25 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md); [research.md](research.md) R1–R9; [data-model.md](data-model.md);
[contracts/agent-protocol.md](contracts/agent-protocol.md); [ADR 0036](../../docs/adr/0036-server-agent.md).

## Summary

A new package, `@opscrew/server-agent`, holds:
- the agent: a WebSocket client, a read-only Docker reader and the protocol's session;
- the protocol's zod schema, exported for the dashboard and written as a JSON Schema file.

It is bundled into one `agent.mjs` that needs only Node's built-in modules. Provision writes it
into the user's repository when the environment has its agent token and the repository its
`OPSCREW_AGENT_URL`, with two services in the app's Compose project:
- the agent, on the pinned Node image;
- a read-only Docker proxy, the add-ons' Caddy proxy with an allow-list bound to the app's own
  containers.

The deploy workflow then:
- writes `agent.env` and the deploy user's ids;
- appends the deploy's steps to `.deploy-progress`;
- restarts the agent, or removes it when its files are gone.

Everything else stays as it is: without a token every generated file is byte for byte today's.

**First version (0.2.13):** servers only, the app's server only, logs, status, deploy progress
and ping. **Later:** Portainer (R5), extra servers' services and the edge's logs (R7), a private
CA for a self-hosted dashboard (R6).

## Technical Context

**Language/Version**: TypeScript (strict ESM), Node.js 22.9+ for OpsCrew. The agent runs on Node 24
(`IMAGES.nodeAlpine`).
**Primary Dependencies**:
- **At run time:** none new. The agent bundles `zod` and `@opscrew/core`'s redactor, both in the
  workspace already.
- **For development:** `esbuild`, already in the lockfile through tsup, as a devDependency of
  `@opscrew/server-agent` (the lead adds it, T4000).
**Storage**: files in the user's repository and in the app's folder on the server
(data-model 3–4).
**Testing**: Vitest, offline. The WebSocket client runs over in-memory duplex streams, Docker
through a fake Engine API, and GitHub and the host through the existing fakes. One Docker test runs
only with `OPSCREW_DOCKER_TESTS=1`.
**Target Platform**: Linux servers with Docker Compose v2: created (Hetzner Cloud, DigitalOcean,
Contabo) and the user's own.
**Project Type**: monorepo packages, plus a vendored runtime script.
**Performance Goals**: the latest 200 lines within 2 s, followed lines within 1 s (SC-4001,
SC-4002).
**Constraints**:
- 64 MB for the agent and 32 MB for the proxy;
- no inbound port;
- the ADR's limits;
- no secret in any message.
**Scale/Scope**:
- one new package of about 1,500 lines with tests;
- two renderers and the deploy's lines in iac-templates;
- one GitHub connector method, one ssh-host constant and its teardown;
- the provision, status and destroy hooks in agents;
- one guide page.

## Constitution Check

| Principle | How the plan meets it |
|---|---|
| **I. Safety gate** | The agent changes nothing. Its install and removal are the app's own generated files in the deploy-setup pull request (the `pull-request` approval), applied by the deploy as every Compose change is (R9). It is no standing approval and no new approval kind: it repeats no change, and its proxy refuses every write on the server itself (FR-4005). |
| **II. The user owns everything** | The agent's code is a readable file in the user's repository, on a public image pinned by digest. Nothing hidden is installed, and deleting OpsCrew leaves two services they can delete. |
| **III. Dual IaC engine** | No HCL changes. |
| **IV. Secrets never leak** | Every line and message passes the core's redactor, loaded with `app.env`, each service's env file and the token (FR-4011). Inspect's environment is dropped at parsing (R4). `agent.env` is 0600 and never logged. Provision reads secret names only. Tests end with a leak check. |
| **V. Deterministic first** | No model anywhere: the agent, the renderers and the protocol are plain code with zod checks on every message. |
| **VI. Contracts-first boundaries** | The protocol schema has one owner, `@opscrew/server-agent`, exported from its root. iac-templates imports only `AGENT_SCRIPT` from it. No change to `@opscrew/contracts` or `@opscrew/plan-schema`. |
| **VII. Test-first** | Every task starts with failing tests. No network in unit tests; the Docker test is gated. |
| **IX. Plain language** | The guide and the pull request say what the agent can and can't do, what it costs in memory, and who on the server can read its token. |
| **X. Simplicity** | No new runtime dependency; the add-ons' proxy is reused; one script, no image to publish. |

The build-time bundle, the one step that goes past "packages consumed from source", is
justified under Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/040-server-agent/
├── spec.md
├── research.md
├── plan.md
├── data-model.md
├── contracts/agent-protocol.md
├── quickstart.md
└── tasks.md
```

### Source code

```text
packages/server-agent/                    (new, @opscrew/server-agent)
├── package.json, tsconfig.json, vitest.config.ts      (T4000, lead)
├── scripts/gen-schema.ts                 (T4001) z.toJSONSchema → schemas/
├── scripts/gen-bundle.ts                 (T4010) esbuild src/main.ts → src/generated/bundle.ts
├── schemas/agent-protocol-v1.json        (T4001, generated)
└── src/
    ├── index.ts                          (T4001) protocol, AGENT_SCRIPT, AGENT_VERSION
    ├── protocol.ts                       (T4001)
    ├── ws/                               (T4002) handshake, frames, client with backoff
    ├── docker/                           (T4003) Engine API over the proxy's socket
    ├── session/                          (T4008) requests, follows, limits, redaction, progress
    ├── main.ts                           (T4008) the bundle's entry: env, real deps, start
    └── generated/bundle.ts               (T4000 stub, T4010 generated)
packages/iac-templates/src/
├── runtime/agent.ts                      (T4004) the two services, the agent's files
├── runtime/index.ts                      (T4004) renderCompose / renderRuntimeFiles hooks
├── addons/proxy.ts                       (T4004) the agent's allow-list
├── types.ts                              (T4004) RenderContext.serverAgent
├── workflow/agent.ts                     (T4005) agent.env, .env ids, progress, restart, removal
└── workflow/index.ts, switch.ts          (T4005) hooks
packages/connectors/github/src/github.ts  (T4006) environmentSecretExists
packages/connectors/ssh-host/src/         (T4007) agent.env a secret runtime file; teardown
packages/agents/src/
├── provision/agent.ts                    (T4009) serverAgentOf, refusals, the PR's words
├── provision/render.ts, server-fit.ts    (T4009) hooks
├── status/agent.ts                       (T4009) the status line
└── destroy/…                             (T4009) the token deleted with the deploy secrets
docs/guide/server-agent.md                (T4012)
```

## Design

### 1. The package and its bundle (T4000, T4010)

- **`@opscrew/server-agent`:** private and consumed from source like every package. It depends on
  `@opscrew/core` and `zod`, with `esbuild` as a devDependency.
- **`gen:bundle`:** bundles `src/main.ts` for `platform: "node"`, `format: "esm"` and
  `target: "node24"`, unminified, with a header naming `AGENT_VERSION` and saying it is generated.
  It writes `src/generated/bundle.ts` with `export const AGENT_SCRIPT = "…"`.
- **Its test** (T4010):
  - rebuilds and compares with the committed bundle;
  - checks the bundle imports only `node:` modules;
  - checks it is under 512 KiB;
  - checks it holds no secret-shaped literal.
- **T4000's stub:** `AGENT_SCRIPT = ""`, so iac-templates builds before the session exists. The
  renderer refuses an empty script with `INTERNAL`, so a stub can never ship.

### 2. The protocol (T4001)

`src/protocol.ts` holds data-model 9: the two unions, `PROTOCOL_VERSION`, `LIMITS` and
`ERROR_CODES`. `parseDashboardMessage(text)` returns the parsed message or the error to send,
following the contract's order of checks. `gen:schema` writes the JSON Schema, and a test fails when
the file differs.

### 3. The WebSocket client (T4002)

- **`ws/frames.ts`:** encode (masked, client to server) and decode (unmasked) for text, ping, pong
  and close frames, with continuation. A message above 64 KiB closes with 1009, never buffered.
- **`ws/handshake.ts`:** builds the upgrade request's headers and checks the 101 answer and
  `Sec-WebSocket-Accept`. It returns `{ kind: "open" }`, `{ kind: "refused", status }` for 401 or
  403, or `{ kind: "failed", reason }`.
- **`ws/client.ts`:** `runConnection(deps)`:
  - connects through an injected `open(url, headers)`, which is `https.request` in `main.ts` and
    in-memory streams in tests;
  - answers pings at the frame level;
  - hands each text message to a callback;
  - reconnects with the backoff, and ends for good on `refused`.

  The clock, randomness and the sleep are injected.

### 4. The Docker reader (T4003)

`docker/api.ts`: `DockerApi`, a small interface with one implementation over `node:http` and
`socketPath` (the proxy's socket from `DOCKER_HOST`), and a fake for tests.
- **`containers(project)`:** `containers/json?all=1&filters=…` with the project's label, each entry
  parsed for name, service label, state, image and created time.
- **`inspect(name)`:** `RestartCount`, `State.StartedAt` (absent when Docker's zero time),
  `State.Health.Status` and `HostConfig.Memory`. The schema strips every other field, `Config.Env`
  included.
- **`stats(name)`:** `stream=false&one-shot=true`, memory used without the page cache, in MB.
- **`logs(name, {tail, since, follow}, signal)`:** an async iterator of `{stream, ts, text}` from
  the multiplexed frames. The lines are split at newlines, and a frame split across chunks is kept
  until it is whole.

Every name is checked against `<project>-<service>-<n>` before it reaches a path, and the label
again on each result.

### 5. The session and the entry (T4008)

- **`session/env.ts`:** reads and checks data-model 8. A missing or malformed variable stops the
  agent with exit code 1 and a plain message naming the variable, never its value.
- **`session/redaction.ts`:** a `Redactor` with `registerEnvSecrets` over every file in
  `/run/opscrew/env/`, and the token. It re-reads a file when its mtime changes (checked at each
  request and every 10 s). The deploy writes the env files in place (`cat >`), so the read-only
  bind mounts see the new content.
- **`session/requests.ts`:** the contract's request table.
  - **Requests:** a map of running requests by `id`, each with an `AbortController`.
  - **Follows:** at most 4.
  - **The rate limit:** a per-request bucket of 200 lines a second, with `dropped` counts once a
    second.
  - **Limits:** the 30-minute timer, and lines cut to fit 64 KiB.
  - **Merging:** the tail of several containers is merged by `ts`.
- **`session/progress.ts`:** polls `.deploy-progress` every second and parses lines (data-model 7)
  into `deploy` messages. On connect it sends every line of the newest deploy again when that
  deploy started or ended under an hour ago.
- **`session/send.ts`:** one outgoing queue. `pong` and `error` go ahead of queued `log`s, and
  every message is checked against `AgentMessageSchema` and redacted before it is framed.
- **`main.ts`:** wires `process.env`, `node:https`, `node:http` over the socket, `node:fs`, the
  clock and the timers. It logs only its own events (FR-4012) and exits cleanly on SIGTERM, closing
  with code 1001.

### 6. The services and the proxy (T4004)

`runtime/agent.ts`: `agentServices(plan)` returns data-model 5's two services, the `agent` network
and the `docker_ro` volume, and `agentFiles(plan)` returns `agent/agent.mjs` and `agent/Caddyfile`.
`renderCompose` merges the services, and `renderRuntimeFiles` adds the files, only with
`ctx.serverAgent: "on"`, so the renderers that take it gain the context field.
- **`addons/proxy.ts`:** gains `agentPathPattern(project, services)` and
  `renderProxyCaddyfile("agent", …)`. The existing kinds stay byte for byte (their snapshots).
- **`proxyService`:** takes the Caddyfile's path (`./agent/Caddyfile` for the agent).
- **The offered services:** the plan's components on the app's server, computed in iac-templates
  from the plan the same way `plannedComponents` does in agents (not imported from there).
- **Refused:** a plan service, worker or process named `opscrew-agent` or `opscrew-agent-proxy`,
  with `INVALID_INPUT`, and the agent on a target of FR-4002's other kinds.

### 7. The deploy's lines (T4005)

With `ctx.serverAgent: "on"`, in the server deploy (`sshDeploy` and the runner-machine variant):
- **The upload step:**
  - writes `agent.env` from `${{ secrets.<deploySecretName(plan, AGENT_TOKEN_SECRET)> }}` and
    `${{ vars.OPSCREW_AGENT_URL }}` through an env-file write like `envFileWrites` (0600, stdin,
    never in the command line);
  - adds `OPSCREW_DEPLOY_UID`/`GID` to `.env` (`WRITE_ENV`);
  - creates `.deploy-progress` and writes its `upload running` line, emptying it first.
- **The server script:**
  - a `progress <step> <state>` function, called at the release command, the start and the switch;
  - `done` or `failed` from the existing exits;
  - after the switch, `docker compose up -d --no-deps --force-recreate opscrew-agent-proxy opscrew-agent`.

  A failure there warns and never fails the deploy.
- **Removal, with `ctx.serverAgent: "removed"`:** the deploy runs
  `docker compose rm -sf opscrew-agent opscrew-agent-proxy` and
  `rm -f agent.env .deploy-progress` before the switch. A token deleted on GitHub stays valid on
  the dashboard's side, so `agent.env` must not outlive the agent (FR-4018). The switch's existing
  `--remove-orphans` would remove the containers anyway; the explicit line also covers the file.
  The lines stay from then on, a no-op once done; a workflow that never had the agent gains none.

`AGENT_TOKEN_SECRET` and `AGENT_URL_VARIABLE` are exported from `workflow/agent.ts`.

### 8. GitHub and the host (T4006, T4007)

- **`GitHubClient.environmentSecretExists(owner, repo, environment, name)`:**
  `GET /repos/{owner}/{repo}/environments/{environment}/secrets/{name}`. A 404 is `false`; any
  other failure throws as the client's other calls do.
- **`connector-ssh-host`:**
  - `agent.env` joins `SECRET_RUNTIME_FILES`;
  - `planTeardown`, with the data kept or not and in the second-app mode, removes `agent.env` and
    `.deploy-progress`;
  - the project's containers go by label as today, so the agent's go with them.

### 9. Provision, status and destroy (T4009)

- **`provision/agent.ts`:** `serverAgentOf(plan, github)` answers `on`, or `off` with a reason.
  An `off` becomes `removed` when the committed workflow has the agent's lines (either form), so
  the next deploy removes the agent and its `agent.env`.
  - It asks for the token in the deploy job's environment, then the repository, and for the
    variable `OPSCREW_AGENT_URL`, checked as FR-4021 asks.
  - For FR-4002's other targets it answers `off` with the reason, which provision prints when a
    token exists.
  - Without GitHub access (offline rendering) it keeps what the committed `compose.yaml` has.
- **`render.ts`:**
  - passes `serverAgent` into the context;
  - when the agent is added or removed, the pull request's body gains a paragraph: what the agent
    does, can't do and costs, linking the guide.
- **`server-fit.ts`:** counts 96 MB with the agent.
- **`status/agent.ts`:** a line under the app's containers, `OpsCrew's agent for the dashboard:
  running` (or `stopped`, with the next step), read through the access `status` already uses.
- **Destroy:** the environment's deploy secrets it deletes gain the agent token's name. The
  repository variable `OPSCREW_AGENT_URL` stays: it is the dashboard's, shared by every app.

### 10. The Docker test (T4011)

`packages/iac-templates/src/runtime/agent.docker.test.ts`, only with `OPSCREW_DOCKER_TESTS=1`.

**The setup:**
- render a plan's agent services and files with the real bundle;
- a stand-in app container that prints known lines, a value from a fake `app.env`
  (`fakeSecret`) and the token;
- a second project's container;
- a fake dashboard: a WebSocket server in the test process, on a self-signed certificate the
  agent trusts through `NODE_EXTRA_CA_CERTS` in the test only.

**It checks:**
- `hello`, a tail, a follow with new lines, `status`, `ping`, the rate limit's `dropped`, a
  `deploy` line;
- the leak check over every message;
- the proxy's 403 for every write call and for the other project's container;
- 401 at the upgrade, after which the agent stops reconnecting;
- memory under the limits during 4 follows (`docker stats`).

**It cleans up** its containers, network, volume and images, by name.

### 11. The guide (T4012)

`docs/guide/server-agent.md`, linked from `logs-and-status.md`, `shared-server.md` and `index.md`.
It covers FR-4024.

### 12. Risks

| Risk | Mitigation |
|---|---|
| The bundle pulls too much of `@opscrew/core` | The bundle test's size and `node:`-only checks. If needed the entry imports a narrower root export that the core adds (a lead decision). |
| A Compose bind mount of a missing file makes a folder | The deploy creates `.deploy-progress` and every env file before `up` (FR-4017, Accept). |
| Docker's `since` takes Unix time, the protocol takes RFC 3339 or a duration | The session converts both to Unix seconds, and tests cover each form. |
| The proxy's name pattern drifts from Compose's container names | The Docker test reads real container names. |
| The dashboard's side differs from this reading of the ADR | Questions for the lead, before the ADR is Accepted. |

## Requirements coverage

| Requirement | Tasks |
|---|---|
| FR-4001, FR-4021 | T4006, T4009 |
| FR-4002, FR-4003 | T4004, T4009 |
| FR-4004–FR-4006 | T4003, T4004, T4008, T4011 |
| FR-4007–FR-4009 | T4001, T4008 |
| FR-4010 | T4005, T4008 |
| FR-4011, FR-4012 | T4008, T4011 |
| FR-4013–FR-4015 | T4002, T4008 |
| FR-4016–FR-4018 | T4004, T4005, T4010 |
| FR-4019 | T4007, T4009 |
| FR-4020, FR-4022 | T4009 |
| FR-4023 | every task; T4011 |
| FR-4024 | T4012 |

## Complexity Tracking

| Deviation | Why | Simpler option rejected |
|---|---|---|
| A generated bundle of a workspace package, committed like `check.mjs` (packages are otherwise consumed from source) | The server has no workspace; the agent must be one file with no dependencies, and must reuse the core's redactor (ADR 0036, 3) | A hand-written `.mjs` with its own redactor copy (drift), an image published per release (a pipeline and approvals) |
| A hand-written WebSocket client | The ADR's "a refused token stops it" needs the handshake's status, which Node's `WebSocket` doesn't expose (R2) | `ws` (a dependency for about 250 lines) |
