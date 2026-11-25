# Tasks: OpsCrew's agent on the server, for live logs and status

**Input**: [spec.md](spec.md), [plan.md](plan.md) (sections written "plan N."),
[research.md](research.md) R1–R9, [data-model.md](data-model.md),
[contracts/agent-protocol.md](contracts/agent-protocol.md), [ADR 0036](../../docs/adr/0036-server-agent.md).

**Numbering**: T4000–T4099. Ships in 0.2.13 with 032.

**Format**: `- [ ] T#### [P] [USn] description` + `Owns / Reads / Depends / Accept / Verify /
Effort`. Implementers never edit `tasks.md`, specs, root configuration, a `package.json`'s
dependencies or the lockfile.

**Rules for every task:**
- **The ADR's protocol is fixed:** names, messages, fields, limits, error codes and the token's
  name and place stay exactly as ADR 0036 has them. Anything that seems wrong is reported, not
  changed.
- **Read-only:** no code path in the agent writes a file, calls a Docker write, or runs a
  process. A reviewer greps for `writeFile`, `spawn`, `exec` and `method: "POST"` in
  `packages/server-agent/src`, tests excepted.
- **Leaks:** every test that sends a line or a message ends with a leak check over everything
  sent. Secrets come from `fakeSecret(kind)` (`@opscrew/core/testing`), never a literal.
- **No network in unit tests:**
  - the WebSocket client runs over in-memory duplex streams;
  - Docker through a fake Engine API;
  - GitHub and the host through the existing fakes.
  The one Docker test is gated by `OPSCREW_DOCKER_TESTS=1`.
- **Unchanged without a token:** every existing snapshot in iac-templates and agents stays
  byte for byte. A task that changes one has a bug.
- **Words:** user-facing text says "OpsCrew's agent" (or "the agent") and "the dashboard", never a
  feature or task number. Errors are plain English and say what to do next.
- **Scope:** build only what Accept asks. Report anything else as a finding.
- **Temp files:** `OPSCREW_TEST_TMP=D:/opscrew-test-tmp`.
- **Examples:** neutral only: `example.com`, `shop`, `shop-admin`, `203.0.113.10`.
- **Writing files:** long files with the Write or Edit tool, not shell heredocs.
- **Worktrees:** each task in its own worktree branched from `040-server-agent`; `pnpm install`
  first; commit there with the Co-Authored-By trailer.

## Phase 1: Foundation (lead)

- [ ] T4000 (lead) The package, its dependencies and the stub
  - **Owns:**
    - `packages/server-agent/{package.json,tsconfig.json,vitest.config.ts}`;
    - `packages/server-agent/src/index.ts` (exports only the stub, which T4001 extends);
    - `packages/server-agent/src/generated/bundle.ts` (`export const AGENT_SCRIPT = ""`,
      `export const AGENT_VERSION = "1.0.0"`);
    - `packages/iac-templates/package.json` (`@opscrew/server-agent: workspace:*`);
    - `pnpm-lock.yaml`;
    - `AGENTS.md`'s package list (one line).
  - **Accept:**
    - `@opscrew/server-agent` is private and exports from `./src/index.ts`;
    - it depends on `@opscrew/core` and `zod`, with `esbuild` (the lockfile's version) as a
      devDependency;
    - `pnpm check` is green.
  - **Effort:** lead

## Phase 2: Wave 1 (parallel)

- [ ] T4001 [P] [US1] [US2] The protocol schema and its JSON Schema file
  - **Owns:**
    - `packages/server-agent/src/{protocol,index}.ts`, colocated tests;
    - `packages/server-agent/scripts/gen-schema.ts`;
    - `packages/server-agent/schemas/**`.
  - **Reads:** ADR 0036 (Messages, version 1), data-model 9, the contract's checks and their
    order.
  - **Accept:**
    - **The schemas:** `AgentMessageSchema` and `DashboardMessageSchema`, as the ADR's tables, field
      for field, with `v: 1` on each. Objects accept and drop unknown fields. `PROTOCOL_VERSION`,
      `LIMITS` and `ERROR_CODES` match the ADR.
    - **`parseDashboardMessage(text)`** returns the message or the `error` to send, following the
      contract's order. A test covers each:
      - not JSON;
      - no `type`;
      - `v: 2` → `unsupported_version`;
      - an unknown type;
      - a missing `id`;
      - `tail: 0` and `5001`;
      - `since` as RFC 3339, as `30s`, `15m`, `2h`, `3d`, and as `5w` (refused);
      - an extra field, kept out of the result.
    - **The JSON Schema:** `gen:schema` writes `schemas/agent-protocol-v1.json` with
      `z.toJSONSchema`, and a test fails when the committed file differs.
    - **`index.ts`** exports the schemas, the constants, `AGENT_SCRIPT` and `AGENT_VERSION`.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/server-agent && pnpm lint`
  - **Effort:** medium

- [ ] T4002 [P] [US1] [US3] The WebSocket client
  - **Owns:** `packages/server-agent/src/ws/**`, colocated tests.
  - **Reads:** plan 3., research R2, RFC 6455 sections 4.1–4.2 (handshake) and 5 (framing), the
    contract's Connection.
  - **Accept:**
    - **The upgrade's headers:** `Upgrade`, `Connection`, `Sec-WebSocket-Version: 13`, a random
      16-byte key (injected randomness) and `Authorization: Bearer <token>`. Only a 101 with the
      right `Sec-WebSocket-Accept` opens; a wrong accept fails.
    - **401 and 403** give `refused`, and the client never connects again (a test advances the fake
      clock by an hour). Any other status, an error or a close leads to a retry after
      `min(60, 2^n) s × (0.5 + random/2)`. `n` is reset after a connection that lasted 60 s.
    - **Frames:**
      - client frames masked;
      - text, ping (answered with pong at once), pong, close (answered, then reconnect) and
        continuation frames;
      - 7-, 16- and 64-bit lengths;
      - a message over 64 KiB closes the connection with 1009 from its header, its payload never
        held, and the client reconnects with the backoff;
      - a binary frame reported to the caller as `binary`, the connection kept.
    - **Chunking:** a frame split at every byte boundary decodes the same (a test over each split).
    - **The log:** the client prints only the URL's origin, never its path, query, credentials or
      the token (a leak check).
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/server-agent && npx vitest run --root packages/server-agent src/ws && pnpm lint`
  - **Effort:** high

- [ ] T4003 [P] [US1] [US2] [US5] The Docker reader
  - **Owns:** `packages/server-agent/src/docker/**`, colocated tests and `__fixtures__`.
  - **Reads:** plan 4., research R4, data-model 6, the Engine API v1.47 file's
    `/containers/json`, `/containers/{id}/json`, `/containers/{id}/logs` and
    `/containers/{id}/stats`.
  - **Accept:**
    - **The interface:** `DockerApi` with `containers(project)`, `inspect(name)`, `stats(name)` and
      `logs(name, query, signal)`. One implementation over `node:http` with `socketPath`, one fake.
      Only `GET` is ever sent; a test over the fake's recorded calls proves it.
    - **The listing:** `containers` sends the project's label filter and also drops any entry whose
      label differs. It works for `shop` beside `shop-admin`, and a fixture where Docker returns
      both keeps only `shop`'s.
    - **Inspect:** parsing keeps only `RestartCount`, `StartedAt` (absent for Docker's zero time),
      `Health.Status` and `HostConfig.Memory`. A fixture with `Config.Env` holding a `fakeSecret`
      value yields an object without it.
    - **Logs:**
      - the multiplexed frames are decoded, stdout and stderr told apart, and each line split into
        `ts` and its text;
      - a frame split across chunks decodes the same;
      - `follow` ends when the signal aborts or Docker closes.
    - **Names:** a name that isn't `<project>-<service>-<n>` for an offered service is refused
      before a path is built.
    - **Docker failing:** an error or no answer gives one typed `unavailable` error.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/server-agent && npx vitest run --root packages/server-agent src/docker && pnpm lint`
  - **Effort:** high

- [ ] T4004 [P] [US3] [US4] [US5] The agent's services, files and proxy in the rendered runtime
  - **Owns:**
    - `packages/iac-templates/src/runtime/agent.ts` (new) and its tests;
    - `packages/iac-templates/src/runtime/index.ts` (the `renderCompose` and
      `renderRuntimeFiles` hooks only);
    - `packages/iac-templates/src/addons/proxy.ts` and its tests;
    - `packages/iac-templates/src/types.ts` (`RenderContext.serverAgent`);
    - `packages/iac-templates/src/index.ts` (exports).
  - **Reads:** plan 6., data-model 2, 3, 5 and 6, research R4 and R7;
    `addons/{proxy,beszel,compose}.ts`; `runtime/services.ts` (`hardened`, `serviceLogging`);
    `pins.ts` (`IMAGES.nodeAlpine`); agents' `status/components.ts` (`plannedComponents`, read
    only).
  - **Accept:**
    - **Without `ctx.serverAgent`, or with `"removed"`:** every existing snapshot is unchanged.
    - **With `"on"`,** on a created or own server: `compose.yaml` gains data-model 5's two services,
      the `agent` network and the `docker_ro` volume (a new snapshot), and `renderRuntimeFiles`
      adds `agent/agent.mjs` (`AGENT_SCRIPT`) and `agent/Caddyfile`. An empty `AGENT_SCRIPT` throws
      `INTERNAL`.
    - **The proxy's allow-list:** `agentPathPattern(project, services)` matches data-model 6.
      Tests:
      - `GET /v1.47/containers/shop-app-1/logs` and `/containers/shop-worker-2/json` pass;
      - `/containers/shop-admin-app-1/logs`, `/containers/shop-opscrew-agent-1/json`,
        `/containers/shop-app-1/exec`, `/containers/create`, `/images/json` and `/volumes` don't;
      - a service name with `.` is escaped.
      The Beszel and Alloy Caddyfiles stay byte for byte.
    - **Isolation:** the agent mounts no Docker socket; only the proxy does, with
      `network_mode: none`. The agent is on `agent` only, never `internal` or the edge's network,
      and is read-only, without capabilities, with 64 MB. The proxy has 32 MB.
    - **The offered services** in `OPSCREW_SERVICES`: `app`, the enabled workers, `cron` with an
      enabled job, and the enabled services on the app's server. A service on an extra server, the
      edge, `release` and `seed` are left out.
    - **Each mount exists:** the agent mounts `app.env` and each `<service>.env` the deploy writes,
      read-only. A test checks each name against the deploy's env files.
    - **Refusals** (`INVALID_INPUT`, plain words):
      - a plan whose service, worker or process is named `opscrew-agent` or `opscrew-agent-proxy`;
      - `serverAgent` with a Portainer, serverless, hosting or `localhost` target.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/runtime src/addons && pnpm lint`
  - **Effort:** high

- [ ] T4006 [P] [US4] The GitHub client reads whether an environment secret exists
  - **Owns:**
    - `packages/connectors/github/src/github.ts` (`environmentSecretExists` only) and its tests;
    - the connector's exported types, if the method must be listed there.
  - **Reads:** plan 8.; `actionsSecretExists` and `setEnvironmentSecret` beside it.
  - **Accept:**
    - `environmentSecretExists(owner, repo, environment, name)` calls
      `GET /repos/{owner}/{repo}/environments/{environment}/secrets/{name}`, with the environment's
      name URL-encoded.
    - A 200 is `true` and a 404 `false`; any other answer throws as `actionsSecretExists` does.
    - The value is never asked for, since GitHub returns none. A test with the injected `fetch`.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/connector-github && npx vitest run --root packages/connectors/github && pnpm lint`
  - **Effort:** medium

- [ ] T4007 [P] [US4] [US5] The host adapter treats `agent.env` as a secret file and removes it
  - **Owns:** `packages/connectors/ssh-host/src/{constants,plan,steps}.ts` (the parts named here),
    colocated tests and `__fixtures__`.
  - **Reads:** plan 8., research R9; `SECRET_RUNTIME_FILES`, `planTeardown` (with and without
    `deleteData`, and with `shares`), the inspection of runtime files.
  - **Accept:**
    - **Inspection:** `agent.env` joins `SECRET_RUNTIME_FILES`. Inspection reports only whether it
      exists, its owner and its mode; a fixture with the file shows no content and no hash.
    - **Teardown:** `planTeardown`, with the data kept or deleted and in the second-app mode, removes
      `agent.env` and `.deploy-progress` from the app's folder, in the same teardown that removes
      the project's containers, the agent's among them. A test lists the step's script with the
      data kept, and the first app's folder and agent stay in the second-app mode.
    - Every existing ssh-host test passes unchanged, a snapshot aside where the teardown's script
      gains exactly those two files.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/connector-ssh-host && npx vitest run --root packages/connectors/ssh-host && pnpm lint`
  - **Effort:** medium

## Phase 3: Wave 2

- [ ] T4008 [US1] [US2] [US3] The agent's session and its entry
  - **Owns:** `packages/server-agent/src/{session/**,main.ts}`, colocated tests.
  - **Reads:** plan 5., the contract (all of it), data-model 7 and 8, research R3 and R8;
    `@opscrew/core`'s `Redactor` and `registerEnvSecrets`.
  - **Depends:** T4001, T4002, T4003
  - **Accept:** tests over the fake connection, the fake Docker API, a fake clock and files in a temp
    folder.
    - **`hello`** first, as FR-4009, from the environment variables. A missing or malformed
      variable exits 1 with a message naming it and no value.
    - **Each request** behaves as the contract's table says:
      - `status`: one entry per offered service, `missing` without a container;
      - `logs` without `follow`, as a tail;
      - `logs` with `follow`, then `cancel`;
      - a follow past 30 minutes (`limit`), and with its containers gone (`gone`);
      - a fifth follow refused;
      - an `id` already running refused;
      - `no_such_service` for `edge`, `release` and `opscrew-agent`;
      - `unavailable` when Docker fails, with the connection kept.
    - **The rate limit:** 1,000 lines in a second give 200 `log`s and `dropped` counts that add up
      to 800, before `end`.
    - **Pings:** a `ping` during a flood is answered before the queued lines.
    - **Size:** a line that would pass 64 KiB is cut and ends with `…`. No message sent is over
      64 KiB, which a check of every sent frame proves.
    - **Redaction:**
      - a `fakeSecret` value from `app.env`, from a `db.env` and the token, printed in lines and in
        a Docker error, never appears in what is sent (the leak check);
      - after `app.env` changes, its new value is masked.
    - **Deploy progress:** a line appended to `.deploy-progress` gives a `deploy` message within
      the next poll. A malformed line is skipped. On a new connection every line of the newest
      deploy comes again, in order, when it started or ended under an hour ago, and none when
      older. A shorter file means a new deploy, read from
      its start.
    - **Read-only:** across the whole suite the fake Docker API saw only `GET`, and the session
      opened files only under `/run/opscrew/` (an injected `fs` records it).
    - **`main.ts`** only wires the real dependencies; SIGTERM closes with 1001.
  - **Verify:** `pnpm turbo run typecheck test --filter=@opscrew/server-agent && pnpm lint`
  - **Effort:** xhigh

- [ ] T4005 [US2] [US4] The deploy writes `agent.env`, the ids and the progress, and restarts the agent
  - **Owns:**
    - `packages/iac-templates/src/workflow/agent.ts` (new) and its tests;
    - the agent's hooks in `packages/iac-templates/src/workflow/{index,switch}.ts`;
    - the workflow snapshots that gain them;
    - the `index.ts` export lines for `workflow/agent.ts` only.
  - **Reads:** plan 7., data-model 1, 4 and 7, research R3; `sshDeploy`, `envFileWrites`,
    `WRITE_ENV`, `switchLines`, the `.start.outcome` writes, the runner-machine deploy.
  - **Depends:** T4004
  - **Accept:**
    - **Without `ctx.serverAgent`:** every workflow snapshot is unchanged.
    - **With `"removed"`:** the deploy runs `docker compose rm -sf opscrew-agent
      opscrew-agent-proxy` and `rm -f agent.env .deploy-progress` before the switch, and writes no
      agent line otherwise. A test runs the lines twice to show they're a no-op the second time.
    - **With `"on"`:**
      - **The upload step** writes `agent.env` with `OPSCREW_AGENT_URL` from
        `${{ vars.OPSCREW_AGENT_URL }}` and `OPSCREW_AGENT_TOKEN` from
        `${{ secrets.<deploySecretName(plan, "OPSCREW_AGENT_TOKEN")> }}`, through stdin with
        `umask 077`. Neither value is on a command line or in an `echo`. The names are tested for
        the first app's prod, its staging, and an app `docs`'s prod and staging.
      - **`.env`** gains `OPSCREW_DEPLOY_UID` and `OPSCREW_DEPLOY_GID` from `id -u` and `id -g` on
        the server; `snapshot_running`'s parse still finds `APP_IMAGE`.
      - **`.deploy-progress`** is emptied and gets `upload running` before the first `up`. Then
        come `release running` (with a release command only), `start running` and `switch running`,
        and `done` or `failed` at the existing exits, each with `${{ github.run_id }}` and the
        server's UTC time.
      - **A rollback** writes the same lines.
      - **After the switch** the deploy runs
        `docker compose up -d --no-deps --force-recreate opscrew-agent-proxy opscrew-agent`. Its
        failure is a `::warning::` and never fails the deploy.
      - Both GitHub's runners and the runner machine are covered.
    - **The export:** `AGENT_TOKEN_SECRET` and `AGENT_URL_VARIABLE` are exported.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/iac-templates && npx vitest run --root packages/iac-templates src/workflow && pnpm lint`
  - **Effort:** high

## Phase 4: Wave 3

- [ ] T4009 [US4] [US5] Provision, status and destroy
  - **Owns:**
    - `packages/agents/src/provision/agent.ts` (new) and its tests;
    - the agent's hooks in `packages/agents/src/provision/{render,server-fit,run}.ts`;
    - `packages/agents/src/status/agent.ts` (new) and its hook in `status/run.ts`;
    - the token's name in destroy's list of the environment's deploy secrets;
    - `environmentSecretExists` in the GitHub fakes under `packages/agents/src/testing/`.
  - **Reads:** plan 9., research R5, R6 and R9, FR-4001, FR-4002 and FR-4019–FR-4022;
    `provision/render.ts` (how `checkKeyLine` reaches the context), `provision/server-fit.ts`,
    `check/secrets.ts` (`actionsSecretExists`), `status/components.ts`, destroy's deploy-secret
    deletion.
  - **Depends:** T4004, T4005, T4006
  - **Accept:**
    - **`serverAgentOf(plan, github)`:**
      - `on` when the token's name is in the deploy job's environment (or, without one, the
        repository; with one, also the repository, GitHub's fallback) and `OPSCREW_AGENT_URL` is a
        `wss://` URL with a host and no credentials;
      - otherwise `off`, with the reason: no token, no URL, a bad URL, or a target of FR-4002's
        other kinds;
      - `removed` instead of `off` when the committed workflow has the agent's lines;
      - without GitHub access, it keeps what the committed `compose.yaml` has.
      Tests cover each, the first app's prod and a further app's staging.
    - **Provision:**
      - passes `serverAgent` to rendering;
      - prints the reason when a token exists and the agent stays off (a Portainer target, a bad
        URL);
      - gives the pull request's body a paragraph on adding or removing the agent: what it does,
        what it can't, 96 MB, a link to `docs/guide/server-agent.md`;
      - never reads a value.
      A test leak-checks every GitHub call and printed line.
    - **The server-fit check** counts 96 MB with the agent; a fixture just fitting without it gets
      the existing too-small message with it.
    - **`opscrew status`** prints `OpsCrew's agent for the dashboard: running` (or `stopped`, with
      `opscrew provision` as the next step) when the project has the agent's containers, and
      nothing otherwise.
    - **Destroy** deletes the environment's agent token with its other deploy secrets. It leaves
      `OPSCREW_AGENT_URL`. A test covers repository secrets and a GitHub environment.
    - **No stale `agent.env`:** a test destroys an own server's app with the agent, with the data
      kept, through the fake host. After that one teardown, no agent container and no `agent.env`
      remain in the fake's state.
    - **No change elsewhere:** every existing provision, status and destroy test passes unchanged.
  - **Verify:** `pnpm turbo run typecheck --filter=@opscrew/agents && OPSCREW_TEST_TMP=D:/opscrew-test-tmp npx vitest run --root packages/agents src/provision src/status src/destroy && pnpm lint`
  - **Effort:** high

- [ ] T4010 [P] [US1] The bundle
  - **Owns:**
    - `packages/server-agent/scripts/gen-bundle.ts`;
    - `packages/server-agent/src/generated/bundle.ts` (generated);
    - `packages/server-agent/src/bundle.test.ts`.
  - **Reads:** plan 1., research R1; `packages/iac-templates/scripts/gen-modules.ts` and its
    test.
  - **Depends:** T4008
  - **Accept:**
    - **`gen:bundle`** bundles `src/main.ts` with esbuild (`platform: "node"`, `format: "esm"`,
      `target: "node24"`, unminified) into `AGENT_SCRIPT`, with a header naming `AGENT_VERSION`
      and the regeneration command.
    - **The test:**
      - rebuilds and fails when the committed bundle differs;
      - fails on an import that isn't `node:`;
      - fails above 512 KiB;
      - fails on a secret-shaped literal (the scanner's rules).
    - **On Node:** the bundle starts with the test's environment and a fake socket path, and exits 1
      with the missing-variable message when one is removed.
  - **Verify:** `pnpm --filter @opscrew/server-agent gen:bundle && pnpm turbo run typecheck test --filter=@opscrew/server-agent && pnpm lint`
  - **Effort:** medium

## Phase 5: Wave 4

- [ ] T4011 [US1] [US2] [US3] [US5] The Docker test
  - **Owns:** `packages/iac-templates/src/runtime/agent.docker.test.ts` (new).
  - **Reads:** plan 10.; `workflow/migrations.docker.test.ts`, `workflow/snapshots.docker.test.ts`
    (how Docker tests are gated, named and cleaned up).
  - **Depends:** T4004, T4005, T4010
  - **Accept:** with `OPSCREW_DOCKER_TESTS=1` only (skipped with a clear message otherwise), it runs
    plan 10.'s checks against the rendered services and the real bundle:
    - `hello`;
    - a tail and a follow;
    - `status`;
    - `ping`;
    - `dropped`;
    - a `deploy` line;
    - the leak check;
    - the proxy's 403 for create, start, stop, kill, exec, remove and the other project's
      container;
    - 401 stops the reconnects;
    - memory under 64 MB and 32 MB during 4 follows.

    It removes its containers, network, volume and pulled images by name, checked by listing.
  - **Verify:** `OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp npx vitest run --root packages/iac-templates src/runtime/agent.docker.test.ts && pnpm lint`
  - **Effort:** high

- [ ] T4012 [P] [US3] [US4] The guide
  - **Owns:**
    - `docs/guide/server-agent.md` (new);
    - a link and one sentence in each of `docs/guide/{logs-and-status,shared-server,index}.md`.
  - **Reads:** spec (all), plan 9., FR-4024; `docs/guide/beszel.md` and `grafana-cloud.md` for
    tone.
  - **Depends:** T4009
  - **Accept:**
    - **The page** says, in plain English, without task or feature numbers:
      - what the agent is and why (logs in about a second);
      - where it runs, and where not yet (Portainer, extra servers);
      - what it reads, and that it changes nothing;
      - the proxy;
      - what it masks;
      - its one outbound connection, with nothing open inbound;
      - the token and the URL, and who sets them;
      - that anything with the deploy user's access on the server can read the token and send the
        dashboard false logs with it;
      - how it's added and removed;
      - 96 MB.
    - The commands and names match the code.
  - **Verify:** `pnpm lint`
  - **Effort:** medium

## Phase 6: The lead

- [ ] T4013 (lead) A fresh review of the merged feature: a new Opus reviewer over the whole diff
  against the spec, the constitution I and IV, and the ADR's protocol. Every finding fixed or
  answered.
- [ ] T4014 (lead) A `/simplify` pass over the feature's code.
- [ ] T4015 (lead) The live pass ([quickstart.md](quickstart.md)) on one of the founder's existing
  test servers, against `wss://app.opscrew.dev/agent`. A few days before it, the lead asks the
  dashboard's lead to turn on the token card in an operator's workspace, and mints the token
  there. A new server, or anything else that costs money, waits for the founder. It is recorded
  in `docs/e2e-coverage.md`.
- [ ] T4016 (lead) ADR 0036 to Accepted, with what this feature settled (its research R1–R9). Any
  difference from the dashboard's build goes to the dashboard's lead first. Then the changelog's
  0.2.13 line, and the roadmap's 040 entry pointing here.

## Order

```text
T4000 → wave 1: T4001, T4002, T4003, T4004, T4006, T4007
      → wave 2: T4008 (T4001–T4003), T4005 (T4004)
      → wave 3: T4009 (T4004–T4006), T4010 (T4008)
      → wave 4: T4011 (T4004, T4005, T4010), T4012 (T4009)
      → T4013 → T4014 → T4015 → T4016
```

Within each wave the `Owns` are disjoint:
- **Wave 1:** T4001, T4002 and T4003 share the new package in separate folders, and only T4001
  owns its `index.ts`.
- **Wave 2:** T4005's iac-templates files differ from T4004's, merged a wave earlier.
