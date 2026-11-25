# Data model: OpsCrew's agent on the server

No change to `opscrew/plan.yaml`, `opscrew/requirements.yaml` or `opscrew/architecture.json`:
whether the agent is on comes from GitHub (FR-4001), not the plan.

## 1. On GitHub (the dashboard writes both; OpsCrew reads names only)

| What | Name | Where |
|---|---|---|
| The token | `deploySecretPrefix(appKey, env) + "AGENT_TOKEN"`: `OPSCREW_AGENT_TOKEN`, `OPSCREW_STAGING_AGENT_TOKEN`, `OPSCREW_DOCS_AGENT_TOKEN`, `OPSCREW_DOCS_STAGING_AGENT_TOKEN` | the deploy job's GitHub environment (`githubEnvironmentFor(appKey, env)`) when it has one, else the repository |
| The URL | `OPSCREW_AGENT_URL` | a repository variable, for every app and environment |

`AGENT_TOKEN_SECRET = "OPSCREW_AGENT_TOKEN"` is a constant in `@opscrew/iac-templates`, passed
through `deploySecretName(plan, …)` like the other deploy secrets.

## 2. `RenderContext.serverAgent` (iac-templates)

```ts
/**
 * OpsCrew's agent for the hosted dashboard (ADR 0036): `on` when the environment has its token
 * and the repository its URL; `removed` when it had the agent before (the committed workflow has
 * its lines), so the deploy removes it and its `agent.env`; absent renders exactly what it did
 * before.
 */
serverAgent?: "on" | "removed";
```

No URL or token in the context: the workflow reads both from GitHub at deploy time.

## 3. Generated files in the repository (`runtimeDir(plan)`, with `serverAgent: "on"`)

| File | Content |
|---|---|
| `compose.yaml` | gains the services `opscrew-agent` and `opscrew-agent-proxy`, the network `agent` and the volume `docker_ro` (section 5) |
| `agent/agent.mjs` | `AGENT_SCRIPT` from `@opscrew/server-agent`, the bundle (research R1) |
| `agent/Caddyfile` | the proxy's settings: `renderProxyCaddyfile` with the agent's allow-list (section 6) |

The deploy copies them to `/srv/apps/<app>/` with the other runtime files.

## 4. Files on the server, in the app's folder

| File | Written by | Mode | Content |
|---|---|---|---|
| `agent.env` | each deploy, from the token secret and the URL variable | 0600, the deploy user | `OPSCREW_AGENT_URL=…` and `OPSCREW_AGENT_TOKEN=…` |
| `.env` | each deploy (exists today) | as today | gains `OPSCREW_DEPLOY_UID=` and `OPSCREW_DEPLOY_GID=` lines with the agent |
| `.deploy-progress` | each deploy, with the agent | 0644 | one line per step change (section 7) |

`agent.env` joins `SECRET_RUNTIME_FILES` in `@opscrew/connector-ssh-host`, so inspection reports
only whether it exists, its owner and its mode, and teardown removes it.

## 5. The two services (with `serverAgent: "on"`)

```yaml
opscrew-agent:
  image: <IMAGES.nodeAlpine.ref>              # node:24-alpine@sha256:…
  command: ["node", "--max-old-space-size=32", "/agent/agent.mjs"]
  restart: unless-stopped
  user: "${OPSCREW_DEPLOY_UID:?…}:${OPSCREW_DEPLOY_GID:?…}"
  env_file: ["agent.env"]
  environment:
    OPSCREW_APP: <plan.app.name>
    OPSCREW_ENVIRONMENT: <environmentName(plan)>
    OPSCREW_PROJECT: <the Compose project, plan.app.name>
    OPSCREW_SERVICES: <the offered services, comma-separated>
    OPSCREW_VERSION: <ctx.opscrewVersion>
    DOCKER_HOST: unix:///run/opscrew-docker-ro/docker.sock
  volumes:
    - ./agent/agent.mjs:/agent/agent.mjs:ro
    - ./app.env:/run/opscrew/env/app.env:ro
    - ./<service>.env:/run/opscrew/env/<service>.env:ro      # each service with an env file
    - ./.deploy-progress:/run/opscrew/deploy-progress:ro
    - docker_ro:/run/opscrew-docker-ro
  networks: [agent]
  read_only: true
  mem_limit: 64m
  memswap_limit: 64m
  # + hardened({ noCapabilities: true }): no capabilities, no-new-privileges, log rotation
opscrew-agent-proxy:
  # proxyService(32), the add-ons' proxy, with ./agent/Caddyfile
```

- **The offered services:** `app`, each enabled worker, `cron` with an enabled job, and each
  enabled service placed on the app's server (`plannedComponents` on `APP_SERVER`).
- **Not offered:** `release`, `seed`, the edge, and the agent's own two.
- **`.deploy-progress`:** the deploy creates it before the first `up`, so the bind mount never
  makes a folder in its place.

## 6. The proxy's allow-list (`kind: "agent"`)

```text
^(/v1\.[0-9]+)?/(_ping|containers/json|containers/<project>-(<s1>|<s2>|…)-[0-9]+/(json|logs|stats))$
```

`GET` and `HEAD` only, and 403 for the rest, as the add-ons' proxy. The service names are escaped.
The agent always addresses containers by name, never by id.

## 7. `.deploy-progress`

```text
<run id>\t<step>\t<state>\t<at>
```

- **`run id`:** digits (`${{ github.run_id }}`).
- **`step`:** `upload | release | start | switch`.
- **`state`:** `running | done | failed`.
- **`at`:** `YYYY-MM-DDTHH:MM:SSZ`.
- The `upload` line empties the file first, so it holds only the current deploy.
- The agent skips any line that doesn't match.

## 8. The agent's environment

| Variable | From | Used for |
|---|---|---|
| `OPSCREW_AGENT_URL` | `agent.env` | the connection; checked as `wss://` again |
| `OPSCREW_AGENT_TOKEN` | `agent.env` | the bearer header; registered with the redactor |
| `OPSCREW_APP`, `OPSCREW_ENVIRONMENT`, `OPSCREW_VERSION` | Compose | `hello` |
| `OPSCREW_PROJECT` | Compose | the label filter and container names |
| `OPSCREW_SERVICES` | Compose | `hello.services`, `no_such_service` |
| `DOCKER_HOST` | Compose | the proxy's socket |

The agent starts with a plain message and exits 1 when one is missing or malformed. It never
prints a value.

## 9. The protocol (`@opscrew/server-agent`, `src/protocol.ts`)

As ADR 0036's tables, as zod schemas:
- `AgentMessageSchema`: a discriminated union on `type` of `hello`, `log`, `dropped`, `end`,
  `status`, `deploy`, `error` and `pong`;
- `DashboardMessageSchema`: `logs`, `cancel`, `status` and `ping`;
- each object `z.looseObject`, so unknown fields are accepted and dropped;
- `PROTOCOL_VERSION = 1`;
- `LIMITS = { messageBytes: 65536, followMinutes: 30, follows: 4, linesPerSecond: 200, tail: 5000 }`;
- `ERROR_CODES`.

The JSON Schema file `packages/server-agent/schemas/agent-protocol-v1.json` comes from
`z.toJSONSchema`, regenerated by `gen:schema`, with a test that it's current.

## 10. Audit entries

None new. Provision's pull request and the deploy are audited as today. The agent changes nothing,
so it writes no audit entry.
