import { test, expect } from "bun:test";
import { toolIcon, toolSummary, toolLabel } from "./tool-icons.ts";

test("known tools map to their distinct glyphs", () => {
  expect(toolIcon("bash")).toBe("$");
  expect(toolIcon("read")).toBe("→");
  expect(toolIcon("edit")).toBe("←");
  expect(toolIcon("write")).toBe("←");
  expect(toolIcon("glob")).toBe("✱");
  expect(toolIcon("grep")).toBe("✱");
  expect(toolIcon("websearch")).toBe("◈");
  expect(toolIcon("task")).toBe("✦");
  expect(toolIcon("update_tasks")).toBe("☑");
});

test("tool families and unknowns fall back sensibly", () => {
  expect(toolIcon("git_status")).toBe("±");
  expect(toolIcon("git_commit")).toBe("±");
  expect(toolIcon("mcp_fetch")).toBe("⊕");
  expect(toolIcon("totally_unknown")).toBe("⚒");
});

test("icon lookup is case-insensitive", () => {
  expect(toolIcon("BASH")).toBe("$");
  expect(toolIcon("Read")).toBe("→");
});

test("summaries read like actions, parsing object or JSON-string input", () => {
  // The `$` icon stands in for the shell prompt, so the summary is bare.
  expect(toolSummary("bash", { command: "bun test" })).toBe("bun test");
  expect(toolLabel("bash", { command: "bun test" })).toBe("$ bun test");
  expect(toolSummary("bash", '{"command":"ls -la"}')).toBe("ls -la");
  expect(toolSummary("read", { path: "src/app.tsx" })).toBe("read src/app.tsx");
  expect(toolSummary("glob", { pattern: "**/*.ts", path: "packages" })).toBe(
    'glob "**/*.ts" in packages',
  );
  expect(toolSummary("grep", { pattern: "TODO" })).toBe('grep "TODO"');
  expect(toolSummary("websearch", { query: "opentui solid" })).toBe('search "opentui solid"');
});

test("a long bash command is truncated with an ellipsis", () => {
  const long = "x".repeat(200);
  const out = toolSummary("bash", { command: long });
  expect(out.length).toBeLessThan(80);
  expect(out.endsWith("…")).toBe(true);
});

test("unknown tools summarize their args as key=value", () => {
  expect(toolSummary("frobnicate", { depth: 2, all: true })).toBe("frobnicate [depth=2, all=true]");
  expect(toolSummary("noargs", {})).toBe("noargs");
});

test("toolLabel joins the icon and the summary", () => {
  expect(toolLabel("read", { path: "a.ts" })).toBe("→ read a.ts");
  expect(toolLabel("git_status", {})).toBe("± git_status");
});
