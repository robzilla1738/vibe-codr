import { test, expect } from "bun:test";
import type { ToolDefinition } from "@vibe/shared";
import { ConfigSchema } from "@vibe/config";
import {
  formatStatus,
  formatCost,
  formatConfig,
  formatTools,
  formatMcp,
  formatPermissions,
  formatNamedList,
  type StatusInfo,
} from "./introspect.ts";

const usage = {
  inputTokens: 1200,
  outputTokens: 340,
  totalTokens: 1540,
  costUSD: 0.0123,
};

const status: StatusInfo = {
  sessionId: "sess_abc",
  model: "anthropic/claude-opus-4-8",
  mode: "execute",
  approvalMode: "ask",
  goal: "ship it",
  cwd: "/work",
  toolCount: 12,
  readOnlyCount: 5,
  mcpServerCount: 1,
  skillCount: 2,
  commandCount: 3,
  agentCount: 0,
  usage,
};

test("formatStatus shows the key session fields", () => {
  const out = formatStatus(status);
  expect(out).toContain("anthropic/claude-opus-4-8");
  expect(out).toContain("execute");
  expect(out).toContain("ship it");
  expect(out).toContain("/work");
  expect(out).toContain("$0.0123");
  expect(out).toContain("12 (5 read-only)");
});

test("formatStatus renders a missing goal as a dash", () => {
  expect(formatStatus({ ...status, goal: null })).toContain("goal");
});

test("formatCost includes the per-1M rate when known", () => {
  const out = formatCost(usage, "anthropic/claude-opus-4-8", { input: 5, output: 25 });
  expect(out).toContain("$5 in");
  expect(out).toContain("$25 out");
  expect(out).toContain("$0.0123");
});

test("formatCost explains a zero cost", () => {
  const out = formatCost({ ...usage, costUSD: 0 }, "x/y");
  expect(out).toContain("no pricing");
});

test("formatConfig masks secrets", () => {
  const config = ConfigSchema.parse({
    providers: { anthropic: { apiKey: "sk-secret-123" } },
    search: { enabled: true, apiKey: "tf-secret" },
  });
  const out = formatConfig(config);
  expect(out).not.toContain("sk-secret-123");
  expect(out).not.toContain("tf-secret");
  expect(out).toContain("***");
});

test("formatTools groups read-only vs side-effecting", () => {
  const tools: ToolDefinition[] = [
    { name: "read", description: "Read a file", inputSchema: {}, readOnly: true, execute: async () => ({ output: "" }) },
    { name: "write", description: "Write a file", inputSchema: {}, readOnly: false, execute: async () => ({ output: "" }) },
  ];
  const out = formatTools(tools, "execute");
  expect(out).toContain("read-only:");
  expect(out).toContain("side-effecting:");
  expect(out).toContain("read");
  expect(out).toContain("write");
});

test("formatMcp reports per-server status", () => {
  const out = formatMcp(
    [
      { name: "github", connected: true, toolCount: 8 },
      { name: "broken", connected: false, toolCount: 0, error: "boom" },
    ],
    ["github", "broken"],
  );
  expect(out).toContain("github — connected, 8 tool(s)");
  expect(out).toContain("broken — failed: boom");
});

test("formatMcp guides when nothing is configured", () => {
  expect(formatMcp([], [])).toContain("No MCP servers configured");
});

test("formatPermissions shows the default and any rules", () => {
  const out = formatPermissions([{ tool: "bash", action: "deny" }], "ask");
  expect(out).toContain("default for unmatched");
  expect(out).toContain("ask");
  expect(out).toContain("deny");
  expect(out).toContain("bash");
});

test("formatNamedList falls back when empty", () => {
  expect(formatNamedList("Skills:", [], "none here")).toBe("none here");
  expect(formatNamedList("Skills:", [{ name: "x", description: "y" }], "none")).toContain(
    "x — y",
  );
});
