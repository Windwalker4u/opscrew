# Quickstart: OpsCrew's agent on the server

## A user turns it on

1. **In the hosted dashboard,** the user connects their app. The dashboard:
   - mints the environment's token;
   - stores it through its GitHub App as `OPSCREW_AGENT_TOKEN` (or the environment's prefixed
     name), in the deploy job's GitHub environment or the repository;
   - sets the repository variable `OPSCREW_AGENT_URL` to `wss://app.opscrew.dev/agent`.
2. **They run `opscrew provision`.** It finds the token's name and the variable, and its deploy-setup
   pull request adds:
   - `opscrew/runtime/agent/agent.mjs`;
   - `opscrew/runtime/agent/Caddyfile`;
   - the services `opscrew-agent` and `opscrew-agent-proxy` in `opscrew/runtime/compose.yaml`;
   - the deploy's `agent.env` and progress lines in the workflow.

   The pull request says what the agent does and can't do, and that it uses 96 MB.
3. **They merge it.** The deploy writes `agent.env`, starts the agent, and the dashboard shows the
   app online within a few seconds. Logs open in about a second.
4. **To turn it off,** the dashboard deletes the token. The next `opscrew provision` removes the
   files, and the next deploy removes the containers.

## Running the fakes

```bash
OPSCREW_TEST_TMP=D:/opscrew-test-tmp pnpm turbo run typecheck test --filter=@opscrew/server-agent
OPSCREW_TEST_TMP=D:/opscrew-test-tmp npx vitest run --root packages/iac-templates src/runtime src/addons src/workflow
OPSCREW_TEST_TMP=D:/opscrew-test-tmp npx vitest run --root packages/agents src/provision src/status src/destroy
```

The Docker test (needs Docker and the network for the pinned images):

```bash
OPSCREW_DOCKER_TESTS=1 OPSCREW_TEST_TMP=D:/opscrew-test-tmp npx vitest run --root packages/iac-templates src/runtime/agent.docker.test.ts
```

## The lead's live pass (T4015)

**Where:** one of the founder's existing test servers (the Contabo server of 030's pass, or a
Hetzner server already running a test app). A new server costs money and waits for the founder.

**The dashboard:** the real endpoint, `wss://app.opscrew.dev/agent`; there is no staging.
- **A few days before the pass,** the lead asks the dashboard's lead to turn on the token card in an
  operator's workspace. It opens to every workspace once 0.2.13 is out.
- **The lead mints the token there.** The dashboard stores it and sets `OPSCREW_AGENT_URL` for the
  test app's repository.
- **The pass reads the messages** in that workspace's views, and times them there.

**The legs:**
1. **Provision with the token and the URL:** the pull request has the agent's files; merge; the
   deploy starts the agent.
2. **`hello`** arrives with the app's name, `prod` and the offered services.
3. **`logs` with `tail: 200`:** time from request to `end` under 2 s (SC-4001).
4. **A follow while the app is hit:** each new line within 1 s (SC-4002). A line printing an
   `app.env` value comes masked (SC-4004).
5. **`status`:** each service with its state, restarts and memory.
6. **A push deploys:** `deploy` messages for `upload`, `start`, `switch`, then `done`.
7. **`docker stats`** during 4 follows: the agent under 64 MB, the proxy under 32 MB (SC-4003).
8. **The token revoked in the workspace:** 401, and the agent logs once and stops
   reconnecting. A deploy restarts it.
9. **Delete the token and provision:** the files go; the next deploy removes the containers and
   `agent.env` (checked by listing the app's folder).
10. **Tear down the test app** (or put the server back as it was) and check by listing that no
   agent container, `agent.env` or test secret remains.

**What goes into `docs/e2e-coverage.md`:** the run, "N of 10 steps", each step's result and time,
and any fix it needed.
