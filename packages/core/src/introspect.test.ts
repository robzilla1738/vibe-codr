import { test, expect } from "bun:test";
import type { Message, ToolDefinition } from "@vibe/shared";
import { ConfigSchema } from "@vibe/config";
import {
  formatStatus,
  formatCost,
  formatConfig,
  formatTools,
  formatMcp,
  formatPermissions,
  formatNamedList,
  formatTranscript,
  formatDoctor,
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

test("formatConfig masks secrets, including MCP env and HTTP headers", () => {
  const config = ConfigSchema.parse({
    providers: {
      anthropic: { apiKey: "sk-secret-123" },
      codex: { headers: { Authorization: "Bearer header-secret" } },
    },
    search: { enabled: true, apiKey: "tf-secret" },
    mcp: {
      servers: {
        gh: { command: "npx", args: ["x"], env: { GITHUB_TOKEN: "ghp-secret" } },
      },
    },
  });
  const out = formatConfig(config);
  expect(out).not.toContain("sk-secret-123");
  expect(out).not.toContain("tf-secret");
  expect(out).not.toContain("header-secret");
  expect(out).not.toContain("ghp-secret");
  expect(out).toContain("***");
  // Non-secret structure is preserved.
  expect(out).toContain("npx");
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

test("formatTranscript renders user/assistant/tool turns as Markdown", () => {
  const history: Message[] = [
    {
      id: "1",
      role: "user",
      parts: [{ type: "text", text: "fix the bug" }],
      createdAt: 0,
    },
    {
      id: "2",
      role: "assistant",
      parts: [
        { type: "text", text: "On it." },
        { type: "tool-call", toolCallId: "t1", toolName: "edit", input: { path: "a.ts" } },
      ],
      createdAt: 1,
    },
    {
      id: "3",
      role: "tool",
      parts: [{ type: "tool-result", toolCallId: "t1", toolName: "edit", output: "ok" }],
      createdAt: 2,
    },
  ];
  const md = formatTranscript(history, {
    sessionId: "ses_1",
    model: "anthropic/claude-opus-4-8",
    goal: "ship",
  });
  expect(md).toContain("# vibe-codr transcript");
  expect(md).toContain("ses_1");
  expect(md).toContain("goal: ship");
  expect(md).toContain("## User");
  expect(md).toContain("fix the bug");
  expect(md).toContain("## Assistant");
  expect(md).toContain("`edit(");
  expect(md).toContain("> ok");
});

test("formatDoctor marks failures and summarizes", () => {
  const out = formatDoctor([
    { label: "provider", ok: true, detail: "anthropic: ok" },
    { label: "git", ok: false, detail: "not a repo" },
    { label: "mcp", ok: null, detail: "none configured" },
  ]);
  expect(out).toContain("✓ provider");
  expect(out).toContain("✗ git");
  expect(out).toContain("○ mcp");
  expect(out).toContain("1 issue(s) found");
});

test("formatDoctor reports all-clear", () => {
  expect(formatDoctor([{ label: "git", ok: true, detail: "ok" }])).toContain(
    "All checks passed.",
  );
});
