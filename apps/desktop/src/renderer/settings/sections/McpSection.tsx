import { useEffect, useRef, useState } from "react";
import type { McpServerConfig } from "../../../shared/config-schema";
import {
  type McpTransportDrafts,
  switchMcpServerType,
} from "../../../shared/mcp-server-edit";
import { KeyValueTextArea, NumberInput, SettingBadge, SettingField, SettingSection, TextArea, TextInput, ToggleSwitch } from "../FormControls";
import type { SectionProps } from "./types";

export function McpSection({
  config,
  scope,
  updateConfig,
  cwd,
  onInvalidDraftChange,
  draftResetVersion = 0,
}: SectionProps) {
  const servers = config.mcp?.servers ?? {};
  const serverNames = Object.keys(servers);
  const [expanded, setExpanded] = useState<string | null>(serverNames[0] ?? null);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const transportDrafts = useRef(new Map<string, McpTransportDrafts>());
  const addDraftKey = `mcp:${scope}:${cwd ?? ""}:new-name`;

  useEffect(() => {
    const pending = showAdd && Boolean(newName.trim());
    onInvalidDraftChange?.(addDraftKey, pending);
    return () => onInvalidDraftChange?.(addDraftKey, false);
  }, [addDraftKey, newName, onInvalidDraftChange, showAdd]);

  useEffect(() => {
    transportDrafts.current.clear();
    setNewName("");
    setShowAdd(false);
  }, [scope, cwd, draftResetVersion]);

  const updateServer = (name: string, server: McpServerConfig) => {
    const next = { ...servers, [name]: server };
    updateConfig({ mcp: { servers: next } });
  };

  const removeServer = (name: string) => {
    transportDrafts.current.delete(name);
    const next = { ...servers };
    delete next[name];
    updateConfig({ mcp: { servers: next } });
  };

  const switchServerType = (
    name: string,
    kind: "stdio" | "remote",
    server: McpServerConfig,
  ) => {
    const switched = switchMcpServerType(
      kind,
      server,
      transportDrafts.current.get(name),
    );
    transportDrafts.current.set(name, switched.drafts);
    updateServer(name, switched.server);
  };

  const confirmAdd = () => {
    const name = newName.trim();
    if (!name || servers[name]) return;
    // Disabled until the user fills command/url — empty enabled stdio blocks all settings saves.
    updateServer(name, { command: "", args: [], enabled: false });
    setExpanded(name);
    setNewName("");
    setShowAdd(false);
  };

  return (
    <SettingSection title="MCP Servers" description="Model Context Protocol server connections. Tools register as mcp__<server>__<tool>.">
      {serverNames.length === 0 && !showAdd && (
        <p className="setting-empty">No MCP servers configured. Add a stdio or remote server to extend the agent's tools.</p>
      )}
      {serverNames.length > 0 && (
        <div className="setting-list">
          {serverNames.map((name) => {
            const server = servers[name];
            const isStdio = "command" in server;
            const isExpanded = expanded === name;
            return (
              <div key={name} className={`setting-card${isExpanded ? " expanded" : ""}`}>
                <div className="setting-card-header">
                  <button type="button" className="setting-card-toggle" onClick={() => setExpanded(isExpanded ? null : name)}>
                    <span className="setting-card-title">{name}</span>
                    <SettingBadge>{isStdio ? "stdio" : "remote"}</SettingBadge>
                    {server.enabled === false ? <SettingBadge tone="warn">disabled</SettingBadge> : <SettingBadge>enabled</SettingBadge>}
                  </button>
                  <button type="button" className="button danger" onClick={() => removeServer(name)}>Remove</button>
                </div>
                <div
                  className="setting-card-body"
                  hidden={!isExpanded}
                  aria-hidden={!isExpanded}
                >
                    <SettingField label="Type">
                      <div className="setting-radio-group">
                        <label>
                          <input
                            type="radio"
                            name={`mcp-type-${name}`}
                            checked={isStdio}
                            onChange={() => switchServerType(name, "stdio", server)}
                          />
                          Stdio (local process)
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`mcp-type-${name}`}
                            checked={!isStdio}
                            onChange={() => switchServerType(name, "remote", server)}
                          />
                          Remote (HTTP/SSE)
                        </label>
                      </div>
                    </SettingField>
                    {isStdio ? (
                      <>
                        <SettingField label="Command" description="Executable only; put flags and package names in Args. Supports ${VAR} expansion.">
                          <TextInput
                            value={server.command}
                            onChange={(v) => updateServer(name, { ...server, command: v })}
                            placeholder="npx"
                            monospace
                          />
                        </SettingField>
                        <SettingField label="Args" description="One per line. Each supports ${VAR} / ${VAR:-default} expansion.">
                          <TextArea
                            value={(server.args ?? []).join("\n")}
                            onChange={(v) => updateServer(name, { ...server, args: v.split("\n").map((s) => s).filter((s, i, arr) => s.trim() || i < arr.length - 1) })}
                            placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/path/to/project"}
                            rows={3}
                            monospace
                          />
                        </SettingField>
                        <SettingField label="Environment" description="One per line: KEY=value. Values support ${VAR} expansion.">
                          <KeyValueTextArea
                            value={server.env}
                            onChange={(env) => updateServer(name, { ...server, env })}
                            separator="="
                            resetKey={`mcp:${draftResetVersion}:${scope}:${cwd ?? ""}:${name}:env`}
                            placeholder={"API_KEY=$" + "{MY_API_KEY}"}
                            trimValues={false}
                            onInvalidDraftChange={onInvalidDraftChange}
                          />
                        </SettingField>
                        <SettingField label="Working directory" description="cwd for the spawned server process.">
                          <TextInput
                            value={server.cwd ?? ""}
                            onChange={(v) => updateServer(name, { ...server, cwd: v || undefined })}
                            placeholder="inherit"
                            monospace
                          />
                        </SettingField>
                      </>
                    ) : (
                      <>
                        <SettingField label="URL" description="Streamable HTTP or SSE endpoint. Supports ${VAR} expansion.">
                          <TextInput
                            value={server.url}
                            onChange={(v) => updateServer(name, { ...server, url: v })}
                            placeholder="https://api.example.com/mcp"
                            type="url"
                            monospace
                          />
                        </SettingField>
                        <SettingField label="Transport" description="http (Streamable HTTP, modern) or sse (legacy).">
                          <div className="setting-radio-group">
                            <label>
                              <input
                                type="radio"
                                name={`mcp-transport-${name}`}
                                checked={!server.transport || server.transport === "http"}
                                onChange={() => updateServer(name, { ...server, transport: "http" })}
                              />
                              HTTP
                            </label>
                            <label>
                              <input
                                type="radio"
                                name={`mcp-transport-${name}`}
                                checked={server.transport === "sse"}
                                onChange={() => updateServer(name, { ...server, transport: "sse" })}
                              />
                              SSE
                            </label>
                          </div>
                        </SettingField>
                        <SettingField label="Headers" description="Auth/identity headers. One per line: key: value. Values support ${VAR}.">
                          <KeyValueTextArea
                            value={server.headers}
                            onChange={(headers) => updateServer(name, { ...server, headers })}
                            separator=":"
                            resetKey={`mcp:${draftResetVersion}:${scope}:${cwd ?? ""}:${name}:headers`}
                            placeholder={"Authorization: Bearer $" + "{MCP_TOKEN}"}
                            onInvalidDraftChange={onInvalidDraftChange}
                          />
                        </SettingField>
                        <SettingField
                          label="OAuth 2.1"
                          description="Refreshes persisted OAuth tokens. The first authorization grant is currently out-of-band; place existing tokens in the configured store."
                        >
                          <ToggleSwitch
                            checked={server.oauth !== undefined}
                            onChange={(enabled) => updateServer(name, {
                              ...server,
                              oauth: enabled ? server.oauth ?? {} : undefined,
                            })}
                          />
                        </SettingField>
                        {server.oauth !== undefined && (
                          <>
                            <SettingField label="OAuth scopes" description="One requested scope per line.">
                              <TextArea
                                value={(server.oauth.scopes ?? []).join("\n")}
                                onChange={(value) => updateServer(name, {
                                  ...server,
                                  oauth: {
                                    ...server.oauth,
                                    scopes: value.split("\n").map((scopeName) => scopeName.trim()).filter(Boolean),
                                  },
                                })}
                                placeholder={"openid\noffline_access"}
                                rows={3}
                                monospace
                              />
                            </SettingField>
                            <SettingField label="Client ID" description="Pre-registered client ID. Leave empty for dynamic client registration.">
                              <TextInput
                                value={server.oauth.clientId ?? ""}
                                onChange={(clientId) => updateServer(name, {
                                  ...server,
                                  oauth: { ...server.oauth, clientId: clientId || undefined },
                                })}
                                monospace
                              />
                            </SettingField>
                            <SettingField label="Client name" description="Name advertised during dynamic client registration.">
                              <TextInput
                                value={server.oauth.clientName ?? ""}
                                onChange={(clientName) => updateServer(name, {
                                  ...server,
                                  oauth: { ...server.oauth, clientName: clientName || undefined },
                                })}
                                placeholder="vibe-codr"
                              />
                            </SettingField>
                            <SettingField label="Redirect URI" description="Registered HTTP callback URI for this OAuth client.">
                              <TextInput
                                value={server.oauth.redirectUri ?? ""}
                                onChange={(redirectUri) => updateServer(name, {
                                  ...server,
                                  oauth: { ...server.oauth, redirectUri: redirectUri || undefined },
                                })}
                                placeholder="http://localhost:8765/callback"
                                type="url"
                                monospace
                              />
                            </SettingField>
                            <SettingField label="Token store" description="Optional token file override. Defaults to the engine's per-server config path.">
                              <TextInput
                                value={server.oauth.tokenStore ?? ""}
                                onChange={(tokenStore) => updateServer(name, {
                                  ...server,
                                  oauth: { ...server.oauth, tokenStore: tokenStore || undefined },
                                })}
                                placeholder="~/.config/vibe-codr/mcp/server.json"
                                monospace
                              />
                            </SettingField>
                          </>
                        )}
                      </>
                    )}
                    <SettingField label="Enabled">
                      <ToggleSwitch
                        checked={server.enabled !== false}
                        onChange={(v) => updateServer(name, { ...server, enabled: v })}
                      />
                    </SettingField>
                    <SettingField label="Timeout (ms)" description="Per-server connect/list deadline. Leave empty for the hub default.">
                      <NumberInput
                        value={server.timeoutMs}
                        onChange={(v) => updateServer(name, { ...server, timeoutMs: v })}
                        min={1}
                        placeholder="default"
                      />
                    </SettingField>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {showAdd ? (
        <div className="git-create-row">
          <input
            type="text"
            className="setting-input is-mono"
            value={newName}
            placeholder="server-name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmAdd();
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setShowAdd(false);
                setNewName("");
              }
            }}
          />
          <button type="button" className="button primary" disabled={!newName.trim() || Boolean(servers[newName.trim()])} onClick={confirmAdd}>Add</button>
          <button type="button" className="button" onClick={() => { setShowAdd(false); setNewName(""); }}>Cancel</button>
        </div>
      ) : (
        <div className="setting-actions">
          <button type="button" className="button" onClick={() => setShowAdd(true)}>Add MCP server</button>
        </div>
      )}
    </SettingSection>
  );
}
