# 032 A Codex plugin: research

Read 2026-11-21 from OpenAI's own documentation (developers.openai.com, which now redirects its
Codex pages to learn.chatgpt.com). The openai/codex repository's docs and changelog were not read
yet. "Not documented" means the pages read don't say; check it before building on it.

## R1. Plugins

Codex has plugins. A plugin bundles skills, MCP servers, browser extensions and hooks.

- **Where they work:** the ChatGPT desktop app and the Codex CLI. The plugins page says they don't
  work in the IDE extension.
- **The manifest:** `plugin.json` at the plugin's root, with a `$schema` (the Agent Plugins schema).
  - Required: `name` (kebab-case, also the namespace) and `version`.
  - Optional: `description`, `author`, `homepage`, `repository`, `license`, `keywords`.
  - OpenAI's own settings go under `extensions.com.openai`: `interface` (display name, descriptions,
    category, website, privacy and terms URLs, default prompt, colour, icons), `hooks`, `apps` and
    `onboardingSkill`, a SKILL.md run after the install.
  - An optional `.codex-plugin/plugin.json` overlay applies only when the root manifest has no
    `extensions.com.openai`; the two aren't merged.
- **The layout:** `plugin.json`, `mcp.json`, `skills/<name>/SKILL.md`, `hooks/hooks.json`,
  `assets/`. Every path starts with `./` and stays inside the plugin.
- **The marketplace file:**
  - Where: `.agents/plugins/marketplace.json` in a repository, or `~/.agents/plugins/marketplace.json`.
    Codex also reads `.claude-plugin/marketplace.json`, for compatibility.
  - Each plugin entry has `name`, `source`, `policy` and `category`.
  - Sources: `local`, `url`, `git-subdir` and `npm`. npm packages are fetched without their
    lifecycle scripts.
- **The install:**
  1. `codex plugin marketplace add owner/repo` (also `@ref`, `--ref`, a git URL or a local path).
  2. `/plugins` inside Codex.
  3. A new session.

  `codex plugin marketplace list`, `upgrade` and `remove` manage it. No single
  `codex plugin install <name>` command is documented.
- **Per repository:** `[plugins."<plugin>@<marketplace>"] enabled = true` in `.codex/config.toml`,
  for trusted projects only.
- **Hooks:** they get `PLUGIN_ROOT` and `PLUGIN_DATA`, and `CLAUDE_PLUGIN_ROOT` and
  `CLAUDE_PLUGIN_DATA` for compatibility. They run only for plugins installed by hand in the desktop
  app, and the user must trust them.

## R2. Skills

- **The format:** a folder with `SKILL.md`, whose frontmatter needs `name` and `description`, and
  optional `scripts/`, `references/` and `assets/`. It builds on the open agent skills standard
  (agentskills.io), the same core as Claude Code's skills.
- **An optional `agents/openai.yaml`:** `interface`, `policy.allow_implicit_invocation` (default
  true), and `dependencies.tools`, which names tools the skill needs, such as an MCP server.
- **Claude-specific frontmatter** (`allowed-tools`) isn't documented for Codex.
- **Where Codex looks:** `.agents/skills` in the repository (from the current folder up to the
  root), `~/.agents/skills`, `/etc/codex/skills`, and its own bundled skills. Two skills of the same
  name aren't merged.
- **How they're used:** only names and descriptions load at first, within 2% of the context window.
  The user calls one with `/skills` or `$name`, or Codex picks one by its description. Skills are
  distributed as plugins.
- **Custom prompts** (`~/.codex/prompts/`) are deprecated in favour of skills.

## R3. MCP servers

- **Where:** `[mcp_servers.<name>]` in `~/.codex/config.toml`, or `.codex/config.toml` in a trusted
  project. The CLI, the desktop app and the IDE extension share this configuration.
- **The keys:**
  - `command`, `args`, `cwd`;
  - `env` (values) and `env_vars` (names forwarded from the user's environment);
  - `startup_timeout_sec` (default 10) and `tool_timeout_sec` (default 60);
  - `enabled_tools` and `disabled_tools`;
  - `default_tools_approval_mode` (`auto`, `prompt`, `writes`, `approve`) and a per-tool
    `tools.<tool>.approval_mode`.
- **The CLI:** `codex mcp add <name> --env K=V -- <command…>`, `codex mcp list`, and
  `codex mcp login <name>` for HTTP servers.
- **A plugin's `mcp.json`:** servers sit under `mcpServers` with a `type` and a `url`. OpenAI's only
  example is a streamable-HTTP server. **Whether it takes a stdio server is not documented.**
- **Approvals:**
  - Codex can ask before an MCP call whose tool advertises side effects. A destructive annotation
    always needs approval unless the tool is also marked read-only.
  - `approval_policy`: `on-request`, `never`, or a granular table.
  - `sandbox_mode`: `read-only`, `workspace-write`, `danger-full-access`. The OS sandbox is Seatbelt
    on macOS, bwrap and seccomp on Linux.
  - **Not documented:** whether a stdio MCP server's own process runs inside the sandbox.

## R4. What limits OpsCrew there

- **Network:** off by default in `workspace-write`. `[sandbox_workspace_write] network_access =
  true` turns it on, and a network proxy can allow-list domains. OpsCrew's `tofu`, `ssh` and `git`
  calls need it. Writes outside the workspace (`~/.ssh`, `~/.opscrew`) are restricted too.
- **Timeouts:** 60 seconds per tool call by default, much shorter than an apply or a deploy.
  `tool_timeout_sec` raises it; **where a plugin sets it is not documented.**
- **Tokens:** through `env_vars` (forwarded from the user's shell, preferred), `env`, or
  `codex mcp add --env`.
- **Codex cloud:** its setup scripts have the internet, but the agent phase is offline by default,
  and secrets are removed before it. Whether it loads repository skills, MCP servers or plugins is
  not documented, so only `AGENTS.md` is confirmed there. A poor fit for OpsCrew's cloud calls.

## R5. The public directory

- **How to submit:** OpenAI's plugin portal. Review needs 5 positive and 3 negative test cases, a
  demo video and a verified organisation.
- **Which plugins it takes:**
  - none with hooks or apps;
  - a remote MCP server only at a public HTTPS endpoint;
  - local MCP servers only through "Skills only", whose desktop rules weren't read.

So a local, stdio OpsCrew plugin is not clearly eligible: it ships through the repository's
marketplace, as Claude Code's does.

## R6. What OpsCrew would ship (to confirm in the build)

| Claude Code plugin | Codex plugin |
|---|---|
| `.claude-plugin/plugin.json` | `plugin.json` (or the `.codex-plugin/plugin.json` overlay) |
| `skills/<name>/SKILL.md` | the same, plus an optional `agents/openai.yaml` naming the MCP server |
| `.mcp.json` (stdio) | `mcp.json`, if it takes stdio; else the guide's `codex mcp add opscrew -- npx -y opscrew mcp` |
| `.claude-plugin/marketplace.json` | `.agents/plugins/marketplace.json` (Codex also reads Claude's) |

The user's `config.toml` then needs, besides the plugin:
- `startup_timeout_sec` about 30 and `tool_timeout_sec` about 900;
- `env_vars` naming their tokens;
- network access in the sandbox.

## Sources (2026-11-21)

- https://learn.chatgpt.com/docs/plugins
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://learn.chatgpt.com/docs/agent-approvals-security
- https://learn.chatgpt.com/docs/custom-prompts
- https://learn.chatgpt.com/docs/environments/cloud-environment
- https://learn.chatgpt.com/docs/codex/ide

## R7. The plugin's files, read from Codex's source (2026-11-21)

From the openai/codex repository on main: `codex-rs/core-plugins/src/manifest.rs` and `loader.rs`,
`codex-rs/codex-mcp/src/plugin_config.rs` and `agent_plugin_config.rs`, and
`codex-rs/config/src/mcp_types.rs` and `types.rs`.

- **Two formats.**
  - The Claude-compatible one is `.codex-plugin/plugin.json`, with `.mcp.json` by default.
  - The newer Agent Plugin format is a root `plugin.json` with a `mcp.json` that needs a `$schema`.
- **The manifest's fields** (camelCase):
  - `skills`: a `./` path, or a list of paths;
  - `mcpServers`: a `./` path, or the servers inline as an object;
  - `interface`: the plugin's display fields;
  - every path must start with `./` and must not contain `..`.
- **A stdio server is accepted** in the Claude-compatible format. Each server is Codex's own
  `McpServerConfig`, with these keys:
  - `command`, `args`, `env`, `env_vars`, `cwd`;
  - `startup_timeout_sec`, `tool_timeout_sec`, `enabled`.

  Unknown keys are refused. A relative `cwd` resolves against the plugin's folder. The format
  expands no `${…}` variable, so Claude's `${CLAUDE_PLUGIN_ROOT}` can't be shared.
- **No npm install.** Codex copies a plugin to `~/.codex/plugins/cache/…`; an `npm` source runs
  `npm pack --ignore-scripts`. Nothing runs `npm install`, so a plugin can't count on
  `node_modules`.
- **The server's environment** is a short default list (HOME, PATH, USER and the like), plus `env`
  and the names in `env_vars`.
- **Approvals** (`core/src/mcp_tool_call.rs`, `requires_mcp_tool_approval`). In the default `auto`
  mode, a tool marked `readOnlyHint: true` never prompts. Any other tool prompts when
  `destructiveHint` or `openWorldHint` is true or missing. `writes` prompts unless the tool is
  read-only.
- **The user's plugin settings** (`[plugins.<plugin>.mcp_servers.<server>]`) take the approval
  mode and the enabled tools, but no time limit.
- **The IDE extension** loads no plugin, but it reads the same `[mcp_servers]` configuration as the
  CLI (OpenAI's MCP page). Codex cloud: not documented anywhere, so it is left out.

## R8. Decisions (lead, 2026-11-21)

- **Format: the Claude-compatible one, in the same `plugin/` folder.**
  - `.codex-plugin/plugin.json` sits beside `.claude-plugin/plugin.json`.
  - `skills: "./skills/"` points at the one copy of the skills both tools read.
  - The MCP server goes inline in `mcpServers`, so Codex's file never collides with Claude's
    `.mcp.json`.
  - *Rationale:* one folder, one copy of the skills, and the only format whose server takes
    `env_vars` and the time limits.
  - *Rejected:* the Agent Plugin format, which takes neither; a second plugin folder, which would
    need a second copy of the skills, since paths can't leave the plugin's folder.
- **The server: the CLI's own Codex entry** (`codexEntry` in
  `packages/cli/src/mcp-clients/entry.ts`), the same that `npx opscrew mcp` already writes into
  `config.toml`. That is `npx -y opscrew@<release> mcp`, `startup_timeout_sec`, and `env_vars` from
  `CREDENTIAL_VARIABLES`. A test checks the manifest's server equals `codexEntry` of the pinned
  release.
  - *Rationale:* one source, and npx works with no install step, as Codex needs.
  - *Rejected:* bundling `node_modules` into a separate npm package, which would mean a second
    package to publish each release.
- **Time limit:** `codexEntry` gains `tool_timeout_sec`, long enough for an apply. That also fixes
  the hand-written Codex setup, which is cut off at Codex's 60 seconds today.
- **Marketplace:** `.agents/plugins/marketplace.json`, Codex's own file, with the same plugin and
  version as `.claude-plugin/marketplace.json`.
- **Approvals:** every MCP tool states `readOnlyHint`. A tool that isn't read-only also states
  `destructiveHint` and `openWorldHint`, so Codex's default mode prompts exactly where it should. A
  test fails on a tool that leaves one out.
- **The release:** step 6 of `docs/releasing.md` also bumps the Codex manifest's version and the
  pinned `opscrew@<release>`. The test above fails when they differ from the Claude plugin's.
- **The live pass** in the Codex CLI needs an OpenAI account, so it waits for the founder.
