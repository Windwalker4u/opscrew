# ADR 0036: OpsCrew's agent on the server, for the hosted dashboard's live logs and status

**Status**: Proposed (2026-11-21, feature 040). The founder approved it the same day, at the hosted
dashboard's request: its logs come from a GitHub Actions job, a 47-second median from request to
output, too slow for what should answer at once. The protocol below is what the dashboard builds
against; the feature's spec and research may change details before it is Accepted, and any change
is announced to the dashboard's lead first.

## Context

The hosted dashboard shows an app's logs, its containers' state and a deploy's progress. Today it
gets them by dispatching a `logs` job in the user's GitHub Actions, which SSHes to the server:
correct, but slow. Everything that changes the server stays in Actions and in plans approved by
their hash (constitution I); only reading needs to be fast.

## Decision

1. **A small agent, only where it's asked for.** `opscrew provision` installs it beside the app, as
   a container in the app's Compose project, on a server OpsCrew created (Hetzner Cloud,
   DigitalOcean, Contabo), a server of the user's, and a Portainer (in the stack).
   - It is installed only when the environment has an agent token (5). A deployment that doesn't
     use the dashboard never runs one.
   - There is none on a static site or a hosting account.
   - `opscrew provision` removes it when the token goes. Leaving the dashboard costs nothing.
2. **It only reads.** The agent sees the containers through a read-only Docker socket proxy that
   allows only the calls it needs: list, inspect, logs, stats. The agent itself never gets the
   socket.
   - **What it can do:** stream a service's logs, report the containers' state, and report a
     deploy's progress, read from the files the deploy writes.
   - **What it can't do:** no shell, no command, no write, no other file.
3. **Redaction before anything leaves the server.** Every log line and message passes the core's
   redactor, loaded with the values of the app's `app.env` and the agent's own token.
4. **One outbound connection.** A WebSocket (`wss://`) to the URL the deployment names, for example
   the dashboard's `wss://app.opscrew.dev/agent`, with the token as `Authorization: Bearer <token>`
   on the upgrade request.
   - Nothing listens inbound, so it works behind a home router and with the Cloudflare-only
     filter.
   - It reconnects with an exponential backoff, from 1 s to at most 60 s, with jitter.
   - **A token refused** (HTTP 401 or 403 on the upgrade) stops it reconnecting. It logs that the
     token was refused and waits for the next deploy, which writes `agent.env` again and restarts
     it.
   - **Liveness:** it answers every `ping` at once. The dashboard pings every 20 s, and counts it
     offline after 60 s with no message.
5. **The token.**
   - **One per environment,** minted by the dashboard and stored through the GitHub App, where the
     deploy job reads the environment's other secrets.
   - **Its name,** in every mode, is the one OpsCrew gives the environment's other deploy secrets
     (`deploySecretName`): `OPSCREW_<APP>_<ENV>_AGENT_TOKEN`, with the app's key and the
     environment's name in upper case and `_` for `-`. The first app's own part, and prod's, are
     left out:
     - `OPSCREW_AGENT_TOKEN` for the first app's prod;
     - `OPSCREW_STAGING_AGENT_TOKEN` for its staging;
     - `OPSCREW_DOCS_AGENT_TOKEN` and `OPSCREW_DOCS_STAGING_AGENT_TOKEN` for an app `docs`.

     GitHub falls back from a missing environment secret to a repository secret of the same name,
     and a name of its own per environment keeps one environment's agent from ever connecting with
     another's token.
   - **Where it's stored:**
     - **With a GitHub environment:** in the one the deploy job runs in (`production`, `<env>`,
       `<app>-production` or `<app>-<env>`, as `githubEnvironmentFor` names them).
     - **With prefixed repository secrets**, where there is no deploy environment: in the
       repository.
   - **The URL:** a repository variable, `OPSCREW_AGENT_URL`.
   - **To the server:** the deploy workflow writes both to the agent's own env file there
     (`agent.env`, mode 0600, owned by the deploy user), the way the app's other secrets reach the
     server, and never into a log.
   - **On the dashboard's side,** the token names exactly one app's environment. A token can read
     only that environment's agent.
6. **The protocol is versioned JSON, one object per WebSocket text message.** Every message has
   `v` (the protocol's major version, `1`) and `type`.
   - **Requests carry an `id`.** The dashboard picks it, the agent echoes it, and several requests
     can run at once.
   - **Unknown fields are ignored.** An unknown `type` gets an `error` with code `unknown_type`.
   - **A higher major version** gets the error `unsupported_version`, and the connection stays
     open.
   - **The limits:**
     - each message at most 64 KiB;
     - a follow stops after 30 minutes;
     - at most 4 follows at once;
     - log lines at most 200 a second per stream, beyond which the agent sends `dropped` counts
       instead.

### Messages, version 1

**From the agent:**

| `type` | Fields | When |
|---|---|---|
| `hello` | `agent` (its version), `app` (the app's name in `opscrew/plan.yaml`), `environment` (its name, `prod` for the default), `opscrew` (the CLI version that installed it), `services` (names) | first, on each connection; for display only, since the token alone decides which environment it is |
| `log` | `id`, `service`, `ts` (RFC 3339), `stream` (`stdout` \| `stderr`), `line` (redacted) | per line of a `logs` request |
| `dropped` | `id`, `count` | lines left out by the rate limit |
| `end` | `id`, `reason` (`done` \| `cancelled` \| `limit` \| `gone`) | a `logs` request finished |
| `status` | `id`, `services`: `[{name, state, health?, restarts, startedAt?, memoryMb, memoryLimitMb?, image}]` (`startedAt` is absent for a container that never started) | reply to `status` |
| `deploy` | `deploy` (the GitHub Actions run id, as a string), `step`, `state` (`running` \| `done` \| `failed`), `at` | as the deploy's steps change, with no request |
| `error` | `id?`, `code`, `message` (plain English, redacted) | a request it can't do |
| `pong` | `id` | reply to `ping` |

**From the dashboard:**

| `type` | Fields | Does |
|---|---|---|
| `logs` | `id`, `service`, `since?` (RFC 3339, or a duration: a number then `s`, `m`, `h` or `d`), `tail?` (lines, at most 5000), `follow?` (boolean) | streams lines, then `end` |
| `cancel` | `id` | stops that request |
| `status` | `id` | one `status` reply |
| `ping` | `id` | `pong` |

**Error codes:** `unknown_type`, `unsupported_version`, `no_such_service`, `too_many_follows`,
`bad_request`, `unavailable` (Docker didn't answer).

## Consequences

- **Fast reads:** logs and status answer in about a second, not 47.
- **Changes stay as they are:** in Actions and in plans approved by their hash.
- **A process on the server that holds a token.** It is read-only by construction (the socket
  proxy, no command message), it redacts, it is only outbound, and it is removed with the token.
- **A contract kept in two places.** The message shapes are a zod schema in the core, exported for
  the dashboard. A field is added with the same `v`; a removal or a change of meaning raises `v`.
- **Not decided here** (the feature's research):
  - the agent's image and where it is built;
  - how the Portainer stack reaches Docker through its own proxy;
  - the exact deploy steps it reports;
  - whether the dashboard's URL is configurable for a self-hosted dashboard.
