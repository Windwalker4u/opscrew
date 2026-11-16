/**
 * `opscrew mcp install` and `opscrew mcp uninstall`: OpsCrew's MCP server in Claude Code (its
 * plugin), Claude Desktop, Codex, Cursor and VS Code, without a token in any file.
 */
export { CREDENTIAL_VARIABLES } from "./entry";
export { MCP_CLIENTS_GUIDE, type McpClientsOptions, runMcpClients } from "./run";
export { CLIENT_IDS, type ClientId, type McpClientsAction, type McpSystem } from "./types";
