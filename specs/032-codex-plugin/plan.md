# Implementation Plan: A Codex plugin

**Branch**: `032-codex-plugin` | **Date**: 2026-11-21 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/032-codex-plugin/spec.md`; research in
[research.md](research.md) (R1–R6 from OpenAI's docs, R7 from Codex's source, R8 the decisions).

## Summary

OpsCrew's plugin folder becomes a Codex plugin as well as a Claude Code plugin:
- **The manifest:** a `.codex-plugin/plugin.json` beside `.claude-plugin/plugin.json`, reading the
  same skills.
- **The MCP server:** the CLI's own Codex entry, inline in that manifest. It starts
  `npx -y opscrew@<release> mcp`, with the credential variables passed by name and time limits
  long enough for an apply.
- **The marketplace file:** `.agents/plugins/marketplace.json`.
- **The tools:** every MCP tool states whether it reads, changes or deletes, so Codex's default mode
  prompts at changes only. OpsCrew's approval bound to the plan's hash stays the gate.
- **The rest:** a guide page and the release step.

## Technical Context

**Language/Version**: TypeScript (strict ESM), Node.js 22.9+; the plugin's files are JSON.
**Primary Dependencies**: none new. It uses the MCP server (`packages/mcp-server`) and the CLI's
MCP client entries (`packages/cli/src/mcp-clients`).
**Storage**: N/A.
**Testing**: Vitest, offline. `plugin/validate.mjs`, and `claude plugin validate`, for the Claude
side.
**Target Platform**: the Codex CLI and the ChatGPT desktop app on macOS, Linux and Windows. The IDE
extension uses the MCP setup without the plugin.
**Project Type**: CLI and plugin.
**Performance Goals**: a first start of the MCP server within Codex's start limit, which covers
npx's download.
**Constraints**:
- Codex installs no npm package for a plugin (R7).
- Paths must stay inside the plugin's folder.
- No token is ever written into a Codex file.
**Scale/Scope**: one manifest, one marketplace file, one generated server entry, an annotation
rule over every MCP tool, one guide page and one release step.

## Constitution Check

| Principle | How the plan meets it |
|---|---|
| **I. Safety gate:** every mutation needs a plan approved by its hash | Unchanged: the MCP server and the CLI enforce it whatever Codex's approval mode. The annotations only decide where Codex adds its own prompt. |
| **II. The user owns everything** | The plugin runs on the user's machine with the user's tokens; nothing is hosted. |
| **IV. Secrets never leak** | Tokens reach the server by `env_vars`, names only. No value is ever written into a Codex file, a test or a doc. |
| **V. Deterministic first** | The MCP server makes no model call; Codex's model drives the skills. |
| **VI. Contracts-first boundaries** | No contract changes. The plugin reuses `codexEntry`, the CLI's existing export. |
| **VII. Test-first** | Tests cover the manifest, its server entry, the marketplace and the annotation rule before the files are written. |
| **IX. Plain language** | The guide page says the settings in plain words. The network error names Codex's setting. |
| **X. Simplicity, lean dependencies** | No new dependency, and one copy of the skills. |

No violations.

## Project Structure

### Documentation (this feature)

```text
specs/032-codex-plugin/
├── spec.md
├── research.md
├── plan.md
├── quickstart.md
├── contracts/plugin-files.md
├── checklists/requirements.md
└── tasks.md
```

### Source code (repository root)

```text
plugin/
├── .claude-plugin/plugin.json      (unchanged)
├── .codex-plugin/plugin.json       (new: the Codex manifest, its server inline)
├── .mcp.json                       (Claude's, unchanged)
├── skills/                         (one copy, both tools read it)
└── validate.mjs                    (checks the Codex manifest too)
.claude-plugin/marketplace.json     (unchanged)
.agents/plugins/marketplace.json    (new: Codex's marketplace file)
packages/cli/src/mcp-clients/entry.ts      (codexEntry gains tool_timeout_sec)
packages/mcp-server/src/                   (every tool's annotations; the network hint)
docs/guide/codex-plugin.md                 (new)
docs/guide/mcp-clients.md, index.md        (links)
docs/releasing.md                          (step 6)
```

**Structure decision:** one plugin folder for both tools, as R8 decides.

## Design

1. **`codexEntry`** (`packages/cli/src/mcp-clients/entry.ts`) gains `tool_timeout_sec` (1800 s)
   and `cwd`, if Codex needs it for npx. That covers `npx opscrew mcp`'s `config.toml` table too,
   and the guide's TOML follows it.
2. **The Codex manifest** (`plugin/.codex-plugin/plugin.json`):
   - `name` and `version` (the Claude manifest's), `description`, `skills: "./skills/"`, and an
     `interface` (display name and descriptions, website, developer, category);
   - `mcpServers: { opscrew: codexEntry(<pinned release>) }`, written out as JSON.

   A test (`packages/cli/src/mcp-clients/codex-plugin.test.ts`) reads it and checks:
   - its server equals `codexEntry` of the release that `plugin/package.json` pins;
   - its version equals the Claude manifest's;
   - its skills path holds every skill.
3. **The marketplace file** (`.agents/plugins/marketplace.json`): the plugin with a `local` source
   (`./plugin`) for this repository, its `policy` and `category`. The same test checks its name and
   version against Claude's marketplace file.
4. **The annotations:** a test over every tool the MCP server registers.
   - Each states `readOnlyHint`.
   - Each that isn't read-only also states `destructiveHint` and `openWorldHint`.
   - Any tool missing them gets them, each set to what the tool does.
5. **The network hint:** the MCP server's error for an unreachable network adds Codex's setting
   when the server runs under Codex. The manifest's entry sets `env: { OPSCREW_MCP_CLIENT: "codex" }`
   (R8), and the CLI's table gets the same.
6. **`plugin/validate.mjs`** also checks the Codex manifest's shape: `./` paths, the skills folder,
   and a server with no token value.
7. **The guide** (`docs/guide/codex-plugin.md`) covers:
   - install, upgrade and removal;
   - the settings (network access in the sandbox; the time limits, already set by the plugin; the
     user's tokens in their shell environment, which the plugin forwards by name);
   - approvals: OpsCrew's hash-bound one, plus where Codex prompts;
   - the IDE extension (the MCP setup, `npx opscrew mcp`);
   - Codex cloud, which isn't supported, and why.
8. **The release step:** `docs/releasing.md` step 6 adds the Codex manifest's version and its
   pinned `opscrew@<release>`. The test in 2 fails when they drift.

## Complexity Tracking

None.
