/**
 * Pure helpers for MCP server settings edits (stdio ↔ remote type switch, etc.).
 */

import type { McpServerConfig } from "./config-schema";

export type McpTransportDrafts = {
  stdio?: McpServerConfig;
  remote?: McpServerConfig;
};

export function mcpServerKind(server: McpServerConfig): "stdio" | "remote" {
  return "command" in server ? "stdio" : "remote";
}

/** Transport-independent fields preserved while the new endpoint is disabled. */
export function mcpCommonFields(server: McpServerConfig): Pick<McpServerConfig, "timeoutMs"> {
  return {
    timeoutMs: server.timeoutMs,
  };
}

/**
 * Replace a server with a blank template of the chosen kind while preserving
 * `timeoutMs`. A transport switch is disabled until the user confirms the new
 * endpoint; remote templates use a reserved, schema-valid placeholder because
 * the engine requires a valid URL even for disabled servers.
 */
export function mcpServerTypeTemplate(
  kind: "stdio" | "remote",
  previous: McpServerConfig,
): McpServerConfig {
  const common = mcpCommonFields(previous);
  if (kind === "stdio") {
    return { command: "", args: [], ...common, enabled: false };
  }
  return { url: "https://example.invalid/mcp", ...common, enabled: false };
}

/**
 * Switch transports without destroying the form the user already filled out.
 * The inactive transport stays local to Settings and is not written into the
 * mutually-exclusive engine config union. A first-time target still starts
 * disabled so an unfinished endpoint cannot connect on the next bootstrap.
 */
export function switchMcpServerType(
  kind: "stdio" | "remote",
  current: McpServerConfig,
  drafts: McpTransportDrafts = {},
): { server: McpServerConfig; drafts: McpTransportDrafts } {
  const currentKind = mcpServerKind(current);
  if (currentKind === kind) return { server: current, drafts };
  const nextDrafts: McpTransportDrafts = { ...drafts, [currentKind]: current };
  return {
    server: nextDrafts[kind] ?? mcpServerTypeTemplate(kind, current),
    drafts: nextDrafts,
  };
}
