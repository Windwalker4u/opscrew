# Contract: the Codex plugin's files

These are the files Codex reads (research R7). Their shapes are checked by
`packages/cli/src/mcp-clients/codex-plugin.test.ts` and `plugin/validate.mjs`.

## `plugin/.codex-plugin/plugin.json`

```json
{
  "name": "opscrew",
  "version": "<the Claude manifest's version>",
  "description": "<one sentence>",
  "skills": "./skills/",
  "mcpServers": {
    "opscrew": {
      "command": "npx",
      "args": ["-y", "opscrew@<release>", "mcp"],
      "startup_timeout_sec": 120,
      "tool_timeout_sec": 1800,
      "env": { "OPSCREW_MCP_CLIENT": "codex" },
      "env_vars": ["<every name of CREDENTIAL_VARIABLES>"]
    }
  },
  "interface": {
    "displayName": "OpsCrew",
    "shortDescription": "<…>",
    "developerName": "OpsCrew",
    "category": "<…>",
    "websiteURL": "https://opscrew.dev"
  }
}
```

- **The server's entry** is `codexEntry(<release>)` from `packages/cli/src/mcp-clients/entry.ts`,
  key for key. `<release>` is the exact `opscrew` version that `plugin/package.json` pins.
- **Never a value:** `env_vars` holds names only. No key holds a token.

## `.agents/plugins/marketplace.json`

```json
{
  "name": "opscrew",
  "interface": { "displayName": "OpsCrew" },
  "plugins": [
    {
      "name": "opscrew",
      "source": { "source": "local", "path": "./plugin" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "<…>"
    }
  ]
}
```

The exact `source` and `policy` keys follow Codex's marketplace parser, which the build checks.
Each plugin entry's `name` matches Claude's `.claude-plugin/marketplace.json`.
