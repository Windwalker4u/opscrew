# Tasks: A Codex plugin

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md) (R7, R8),
[contracts/plugin-files.md](contracts/plugin-files.md), [quickstart.md](quickstart.md).

One build task. The founder's usage is near its weekly limit, and the pieces share their tests and
files.

## Wave 1

- [ ] T3201 [US1] [US2] [US3] The Codex plugin, its server entry, the annotation rule and the guide
  - **Owns:**
    - `plugin/.codex-plugin/**`, `plugin/validate.mjs`, `plugin/README.md`;
    - `.agents/plugins/marketplace.json`;
    - `packages/cli/src/mcp-clients/**` (`codexEntry`, `codexTable`, and a new
      `codex-plugin.test.ts`);
    - `packages/mcp-server/src/**` (tool annotations, the network hint), colocated tests;
    - `docs/guide/codex-plugin.md` (new), `docs/guide/mcp-clients.md`, `docs/guide/index.md` (a
      link), `docs/releasing.md` (step 6).
  - **Reads:** research.md R7 and R8, plan.md's Design, the contract, `plugin/.claude-plugin/`,
    `.claude-plugin/marketplace.json`, `plugin/.mcp.json`, `docs/guide/claude-code-plugin.md`.
  - **Accept:**
    - **`codexEntry(version)`** gains `tool_timeout_sec: 1800` and
      `env: { OPSCREW_MCP_CLIENT: "codex" }`, and `codexTable` writes both. The existing
      `config.toml` tests follow, and `docs/guide/mcp-clients.md`'s TOML matches it.
    - **The manifest:** `plugin/.codex-plugin/plugin.json` is as the contract says.
      - Its `mcpServers.opscrew` equals `codexEntry` of the `opscrew` version that
        `plugin/package.json` pins.
      - Its `version` equals `plugin/.claude-plugin/plugin.json`'s.
      - Its `skills` is `"./skills/"`, and each skill folder has a `SKILL.md` whose frontmatter has
        `name` and `description`.
      - A test checks all of it, and fails on a token value anywhere in the file.
    - **The marketplace file:** `.agents/plugins/marketplace.json` lists the plugin from
      `./plugin`. Check the source and policy keys against Codex's marketplace parser in the
      openai/codex repository, and record the source you read in research.md. Its name and version
      match Claude's marketplace file, and a test checks that.
    - **The annotations:**
      - a test over every tool the MCP server registers: each states `readOnlyHint`, and each that
        isn't read-only also states `destructiveHint` and `openWorldHint`;
      - any tool that lacks one gets it, true to what the tool does;
      - the planning tools' existing assertions stay.
    - **The network hint:** a tool whose call fails because the network can't be reached, with
      `OPSCREW_MCP_CLIENT=codex` set, adds a sentence naming Codex's setting
      (`[sandbox_workspace_write] network_access = true`, or `sandbox_mode`). Without that variable
      the message is unchanged. Test both.
    - **`plugin/validate.mjs`** also checks the Codex manifest's shape (`./` paths, the skills
      folder) and the marketplace file. `node plugin/validate.mjs` passes.
    - **The guide:** `docs/guide/codex-plugin.md`, in plain English like
      `claude-code-plugin.md`. It covers:
      - install, upgrade and removal;
      - Node.js 22 or newer;
      - network access in Codex's sandbox;
      - the time limits, which the plugin sets;
      - the tokens, kept in the user's shell environment and forwarded by name;
      - approvals: OpsCrew's hash-bound one, and where Codex adds its own prompt;
      - the IDE extension (the MCP setup through `npx opscrew mcp`);
      - Codex cloud: not supported, and why.

      Link it from `mcp-clients.md` and `index.md`.
    - **The release step:** `docs/releasing.md` step 6 names the Codex manifest's `version` and its
      pinned `opscrew@<release>`, beside the Claude ones.
  - **Verify:** `pnpm turbo run typecheck --filter=opscrew --filter=@opscrew/mcp-server && npx vitest run --root packages/cli src/mcp-clients && npx vitest run --root packages/mcp-server && node plugin/validate.mjs && pnpm lint`
  - **Effort:** high

## Wave 2 (lead)

- [ ] T3202 (lead) The live pass in the Codex CLI ([quickstart.md](quickstart.md)), with the
  founder's OpenAI account; recorded in `docs/e2e-coverage.md`.
- [ ] T3203 (lead) A `/simplify` pass over the feature's code, then the release (0.2.12, by
  `docs/releasing.md`).
