import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "./config-schema";
import { mcpServerTypeTemplate, switchMcpServerType } from "./mcp-server-edit";

describe("mcpServerTypeTemplate", () => {
  it("preserves enabled:false when switching stdio → remote", () => {
    const next = mcpServerTypeTemplate("remote", {
      command: "",
      args: [],
      enabled: false,
    });
    expect(next).toEqual({ url: "https://example.invalid/mcp", enabled: false, timeoutMs: undefined });
    expect(next.enabled).toBe(false);
  });

  it("preserves enabled:false and timeoutMs when switching remote → stdio", () => {
    const next = mcpServerTypeTemplate("stdio", {
      url: "https://example.com/mcp",
      enabled: false,
      timeoutMs: 5000,
    });
    expect(next).toMatchObject({
      command: "",
      args: [],
      enabled: false,
      timeoutMs: 5000,
    });
    expect("url" in next).toBe(false);
  });

  it("disables a filled stdio server while its new remote endpoint is reviewed", () => {
    const next = mcpServerTypeTemplate("remote", {
      command: "npx",
      args: ["-y", "pkg"],
      enabled: true,
      timeoutMs: 1000,
    });
    expect(next).toMatchObject({
      url: "https://example.invalid/mcp",
      enabled: false,
      timeoutMs: 1000,
    });
  });

  it("restores transport-specific drafts when toggling back", () => {
    const dollar = "$";
    const stdio: McpServerConfig = {
      command: "npx",
      args: ["-y", "@example/mcp"],
      env: { API_KEY: `${dollar}{MCP_KEY}` },
      enabled: true,
      timeoutMs: 5_000,
    };
    const remoteSwitch = switchMcpServerType("remote", stdio);
    const remote = {
      ...remoteSwitch.server,
      url: "https://mcp.example.com",
      headers: { Authorization: `Bearer ${dollar}{MCP_TOKEN}` },
      oauth: { scopes: ["tools.read"] },
      enabled: true,
    };
    const stdioSwitch = switchMcpServerType("stdio", remote, remoteSwitch.drafts);
    expect(stdioSwitch.server).toEqual(stdio);
    const restoredRemote = switchMcpServerType(
      "remote",
      stdioSwitch.server,
      stdioSwitch.drafts,
    );
    expect(restoredRemote.server).toEqual(remote);
  });

  it("does nothing when selecting the active transport", () => {
    const current = { command: "node", args: ["server.js"] };
    const result = switchMcpServerType("stdio", current);
    expect(result.server).toBe(current);
    expect(result.drafts).toEqual({});
  });
});
