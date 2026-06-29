import { test, expect } from "bun:test";
import type { ToolDefinition } from "@vibe/shared";
import { McpHub, toToolDefinition, mcpToolName, renderContent, type McpClient } from "./mcp.ts";

/** A fake MCP server exposing one echo tool. */
function fakeClient(calls: { name: string; args: unknown }[]): McpClient {
  return {
    async listTools() {
      return [
        {
          name: "echo",
          description: "Echo back",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      ];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      return { content: [{ type: "text", text: `echo: ${(args as { text: string }).text}` }] };
    },
    async close() {},
  };
}

test("hub registers MCP tools as gated mcp__<server>__<tool> definitions", async () => {
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({
    registerTool: (def) => registered.push(def),
    connect: async () => fakeClient([]),
  });
  await hub.start({ demo: { command: "irrelevant" } });

  expect(registered).toHaveLength(1);
  const tool = registered[0]!;
  expect(tool.name).toBe("mcp__demo__echo");
  expect(tool.readOnly).toBe(false); // side-effecting → permission-gated, execute-only
  expect(tool.inputSchema).toMatchObject({ type: "object" });
});

test("mcpToolName sanitizes disallowed chars and caps length for hosted providers", () => {
  const NAME = /^[A-Za-z0-9_-]+$/;
  // Clean names pass through unchanged.
  expect(mcpToolName("demo", "echo")).toBe("mcp__demo__echo");
  // Dots (and other illegal chars) become underscores.
  expect(mcpToolName("gh", "github.search")).toBe("mcp__gh__github_search");
  expect(mcpToolName("a b", "x/y:z")).toBe("mcp__a_b__x_y_z");
  // Over-long names are truncated to ≤64 chars but stay unique + valid.
  const long = mcpToolName("server", "a".repeat(120));
  expect(long.length).toBeLessThanOrEqual(64);
  expect(long).toMatch(NAME);
  const longB = mcpToolName("server", `${"a".repeat(119)}b`);
  expect(longB).not.toBe(long); // different source → different hash suffix
  for (const n of [mcpToolName("gh", "github.search"), long])
    expect(n).toMatch(NAME);
});

test("a sanitized MCP tool still calls the server with its real name", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const client: McpClient = {
    listTools: async () => [{ name: "github.search" }],
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { content: "ok", isError: false };
    },
    close: async () => {},
  };
  const def = toToolDefinition("gh", (await client.listTools())[0]!, client);
  expect(def.name).toBe("mcp__gh__github_search"); // sanitized for the model
  await def.execute({ q: "x" }, {} as never);
  expect(calls).toEqual([{ name: "github.search", args: { q: "x" } }]); // real name to server
});

test("an adapted tool calls through to the MCP client and renders text", async () => {
  const calls: { name: string; args: unknown }[] = [];
  const client = fakeClient(calls);
  const def = toToolDefinition("demo", (await client.listTools())[0]!, client);

  const res = await def.execute({ text: "hi" }, {} as never);
  expect(calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
  expect(res.output).toBe("echo: hi");
});

test("a server that fails to connect is skipped, not fatal", async () => {
  const registered: ToolDefinition[] = [];
  const hub = new McpHub({
    registerTool: (def) => registered.push(def),
    connect: async (name) => {
      if (name === "bad") throw new Error("boom");
      return fakeClient([]);
    },
  });
  await hub.start({ bad: { command: "x" }, good: { command: "y" } });
  expect(registered.map((t) => t.name)).toEqual(["mcp__good__echo"]);
});

test("renderContent flattens text parts and falls back to JSON", () => {
  expect(renderContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  expect(renderContent("plain")).toBe("plain");
  expect(renderContent([{ type: "image", data: "x" }])).toContain("image");
});
