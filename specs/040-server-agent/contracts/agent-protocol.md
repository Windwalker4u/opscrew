# Contract: the agent's protocol, version 1

The messages, fields, error codes and limits are ADR 0036's tables, unchanged. This file adds how
the agent behaves for each one, which the tests check. A change to a message goes to the
dashboard's lead first.

## The connection

1. **The upgrade:** `GET <OPSCREW_AGENT_URL>` with `Upgrade: websocket`, `Connection: Upgrade`,
   `Sec-WebSocket-Version: 13`, a random `Sec-WebSocket-Key`, and
   `Authorization: Bearer <token>`. It is refused unless the answer is 101 with the right
   `Sec-WebSocket-Accept`.
2. **Refusals:**
   - **401 or 403:** the agent logs `The dashboard refused this agent's token; it waits for the
     next deploy.` and stops reconnecting.
   - **Any other failure:** it logs one line without the URL's path or query, and retries after
     `min(60, 2^n) s × (0.5 + random/2)`, with `n` reset after a connection that lasted 60 s.
3. **The first message:** `hello`, with no `id`.
4. **Text frames only:** one JSON object per message.
   - A binary frame, like a malformed message, gets `error {code: "bad_request"}`, and the
     connection stays open.
   - A message above 64 KiB closes the connection with code 1009, never buffered past the limit;
     the agent then reconnects with the backoff.

## Requests

| Request | The agent's answer |
|---|---|
| `ping {id}` | `pong {id}` at once, ahead of queued `log` messages |
| `status {id}` | one `status {id, services}`: one entry per offered Compose service, `name` the service's name; `state`, `restarts`, memory and `image` from its newest container. `state` is Docker's (`running`, `exited`, `restarting`, …), or `missing` when the service has no container |
| `logs {id, service, since?, tail?, follow?}` | `log` messages, oldest first, then `end {id, reason}`. `tail` defaults to 200. Without `follow`, `end` is `done`; with `follow`, it is `cancelled`, `limit` (30 minutes) or `gone` (every container of the service stopped) |
| `cancel {id}` | stops request `id`, which then sends `end {id, reason: "cancelled"}`; an unknown `id` is ignored |

## Checks, in order, and their error codes

1. Not JSON, or a message without `type` → `bad_request` (with no `id`).
2. `v` above 1 → `unsupported_version`.
3. An unknown `type` → `unknown_type`.
4. A message that fails its schema (a missing `id`, `tail` outside 1–5000, a `since` that is neither
   RFC 3339 nor `<n>s|m|h|d`) → `bad_request`.
5. A `logs` `service` that isn't offered → `no_such_service`.
6. A fifth running follow → `too_many_follows`.
7. Docker doesn't answer, or answers with an error → `unavailable`.
8. A request `id` already running → `bad_request`.

Every `error.message` is plain English, redacted, and names no path, address or value.

## Lines

- **`ts`:** the RFC 3339 timestamp Docker put in front of the line, unchanged.
- **`stream`:** from the multiplexed frame's type.
- **`line`:** without the timestamp and the trailing newline, redacted. If its message would pass
  64 KiB, it is cut at a character boundary and ends with `…`.
- **The rate limit:** 200 lines a second per request. Lines above it are counted, and a
  `dropped {id, count}` goes out at most once a second while it lasts and once at the end, before
  `end`.
- **Several containers of one service:** each is read; a tail is merged by `ts`, and the tail
  counts across them.

## Deploy progress

- **A new line of `.deploy-progress`** → `deploy {deploy, step, state, at}`.
- **On each new connection,** after `hello`: every line of the newest deploy again, in order, when
  its first or last line's `at` is under an hour old. A resent step updates in place on the
  dashboard, which keys progress by deploy id and step.
- **The file is checked** every second, and read from where the last check stopped. A shorter file
  means a new deploy, which is read from the start.

## The schema's home

- `@opscrew/server-agent` exports `AgentMessageSchema`, `DashboardMessageSchema`,
  `PROTOCOL_VERSION`, `LIMITS` and `ERROR_CODES` from its root.
- `packages/server-agent/schemas/agent-protocol-v1.json` is the same as a JSON Schema, for the
  dashboard.
