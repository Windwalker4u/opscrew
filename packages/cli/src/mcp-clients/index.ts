/**
 * `opscrew mcp install` and `opscrew mcp uninstall`: OpsCrew's MCP server in Claude Code (its
 * plugin), Claude Desktop, Codex, Cursor and VS Code, without a token in any file.
 */
export { runMcpClients } from "./run";
export { CLIENT_IDS, type McpClientsAction } from "./types";
