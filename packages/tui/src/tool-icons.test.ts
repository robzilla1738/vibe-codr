import { test, expect } from "bun:test";
import {
  BUILTIN_TOOL_NAMES,
  displayPath,
  permissionPreview,
  toolIcon,
  toolSummary,
  toolLabel,
  isLongOutputTool,
} from "./tool-icons.ts";

test("known tools map to their distinct glyphs", () => {
  expect(toolIcon("bash")).toBe("$");
  expect(toolIcon("read")).toBe("→");
  expect(toolIcon("edit")).toBe("✎");
  expect(toolIcon("write")).toBe("←");
  expect(toolIcon("glob")).toBe("∗");
  expect(toolIcon("grep")).toBe("#");
  expect(toolIcon("websearch")).toBe("◈");
  expect(toolIcon("webfetch")).toBe("◎");
  expect(toolIcon("recall_memory")).toBe("◇");
  expect(toolIcon("task")).toBe("✦");
  expect(toolIcon("update_tasks")).toBe("☑");
  // Write vs edit must not share a glyph.
  expect(toolIcon("write")).not.toBe(toolIcon("edit"));
  // Glob vs grep must not share a glyph.
  expect(toolIcon("glob")).not.toBe(toolIcon("grep"));
  // Fetch vs search must not share a glyph.
  expect(toolIcon("webfetch")).not.toBe(toolIcon("web_search"));
});

test("every built-in tool has a non-fallback glyph", () => {
  for (const name of BUILTIN_TOOL_NAMES) {
    expect(toolIcon(name)).not.toBe("⚒");
  }
});

test("isLongOutputTool covers bash and git family", () => {
  expect(isLongOutputTool("bash")).toBe(true);
  expect(isLongOutputTool("git_status")).toBe(true);
  expect(isLongOutputTool("read")).toBe(false);
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
  // A long search query is truncated like other long args.
  expect(toolSummary("web_search", { query: "x".repeat(80) })).toMatch(/^search "x+…"$/);
});

test("displayPath shortens home + long absolute paths for scanable tool rows", () => {
  expect(displayPath("src/app.tsx")).toBe("src/app.tsx");
  expect(displayPath("/Users/robert/Code/vibe-codr/packages/tui/src/app.tsx")).toBe(
    "~/Code/vibe-codr/packages/tui/src/app.tsx",
  );
  // Long paths prefer a readable tail over a hard mid-path clip.
  const deep =
    "/Users/robert/Code/very-long-project-name/packages/core/src/orchestration/runner.ts";
  const short = displayPath(deep, 40);
  expect(short.startsWith("…/") || short.startsWith("~/")).toBe(true);
  expect(short.endsWith("runner.ts")).toBe(true);
  expect(short.length).toBeLessThanOrEqual(40);
  expect(toolSummary("read", { path: "/Users/me/proj/src/a.ts" })).toBe("read ~/proj/src/a.ts");
  expect(toolSummary("edit", { path: "/home/me/app/file.ts" })).toBe("edit ~/app/file.ts");
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
  // Unknown/family tools are humanized: snake_case reads as spaced words.
  expect(toolLabel("git_status", {})).toBe("± git status");
});

test("humanized fallback: snake_case reads as words and drops an mcp prefix", () => {
  expect(toolSummary("recall_memory", { query: "bt price" })).toBe('recall memory "bt price"');
  expect(toolSummary("mcp__linear__create_issue", { title: "x" })).toBe("linear create issue [title=x]");
});

test("save_memory summarizes the FACT it stores (the real schema field)", () => {
  // Regression: the summary read title/name/query — none exist on the schema —
  // so every save_memory row rendered as a bare "save memory".
  expect(toolSummary("save_memory", { fact: "prefers bun over npm" })).toBe(
    'save memory "prefers bun over npm"',
  );
});

test("glob reads its real `cwd` field for the directory clause", () => {
  expect(toolSummary("glob", { pattern: "**/*.ts", cwd: "packages/tui" })).toBe(
    'glob "**/*.ts" in packages/tui',
  );
});

test("spawn_tasks summarizes the DAG shape, never [object Object]", () => {
  const input = {
    tasks: [
      { id: "recon", objective: "map the repo" },
      { id: "impl", objective: "build it", deps: ["recon"] },
      { id: "verify", objective: "test it", deps: ["impl"] },
    ],
  };
  expect(toolSummary("spawn_tasks", input)).toBe("3 tasks: recon → impl → verify");
  expect(toolLabel("spawn_tasks", input).startsWith("✦")).toBe(true);
  expect(toolSummary("spawn_tasks", {})).toBe("spawn tasks");
});

test("orchestration + session tools carry bespoke summaries", () => {
  expect(toolSummary("read_report", { task_id: "impl" })).toBe("read report impl");
  expect(toolSummary("use_skill", { name: "polish" })).toBe("skill polish");
  expect(toolSummary("run_check", { check: "test" })).toBe("run test");
  expect(toolSummary("post_note", { note: "api uses v2 auth" })).toBe('post note "api uses v2 auth"');
  expect(toolSummary("package_info", { name: "react", ecosystem: "npm" })).toBe("package react (npm)");
  expect(toolSummary("job_status", { id: "job_1" })).toBe("job job_1");
  expect(toolSummary("job_kill", { id: "job_1" })).toBe("kill job job_1");
  expect(toolSummary("crawl_docs", { url: "https://docs.x.dev", query: "auth" })).toBe(
    'crawl https://docs.x.dev "auth"',
  );
});

test("MCP aggregate tools get the ⊕ glyph and list/read summaries", () => {
  expect(toolIcon("read_mcp_resource")).toBe("⊕");
  expect(toolIcon("get_mcp_prompt")).toBe("⊕");
  expect(toolSummary("read_mcp_resource", {})).toBe("list mcp resources");
  expect(toolSummary("read_mcp_resource", { uri: "db://schema" })).toBe("mcp resource db://schema");
  expect(toolSummary("get_mcp_prompt", { server: "linear", name: "triage" })).toBe(
    "mcp prompt linear/triage",
  );
});

test("kv digests object args as JSON, not [object Object]", () => {
  expect(toolSummary("frobnicate", { opts: { a: 1 } })).toBe('frobnicate [opts={"a":1}]');
  expect(toolSummary("frobnicate", { list: [1, 2] })).toBe("frobnicate [list=[1,2]]");
});

test("permissionPreview shows the full bash command ONLY when the label truncates it", () => {
  // Short single-line command: the 72-char label already tells the whole story.
  expect(permissionPreview("bash", { command: "git status" })).toBeNull();
  // Long command: the dangerous tail is exactly what the label cut off.
  const long = `git status && ${"x".repeat(70)} && rm -rf /tmp/cache`;
  const p = permissionPreview("bash", { command: long });
  expect(p).not.toBeNull();
  expect(p!.diff).toBe(false);
  expect(p!.lines.join("\n")).toContain("rm -rf /tmp/cache");
  // Multi-line commands always preview (the label collapses them to one line).
  expect(permissionPreview("bash", { command: "a\nb" })!.lines).toEqual(["a", "b"]);
});

test("permissionPreview renders an edit as -/+ lines (single and multi-edit forms)", () => {
  const single = permissionPreview("edit", {
    path: "src/a.ts",
    oldString: "const x = 1;",
    newString: "const x = 2;",
  });
  expect(single).toEqual({ lines: ["- const x = 1;", "+ const x = 2;"], diff: true });
  const multi = permissionPreview("multiedit", {
    path: "src/a.ts",
    edits: [
      { oldString: "a", newString: "b" },
      { oldString: "c", newString: "d" },
    ],
  });
  expect(multi!.lines).toEqual(["- a", "+ b", "- c", "+ d"]);
});

test("permissionPreview shows a write's content head, capped with a +N marker", () => {
  const short = permissionPreview("write", { path: "x.txt", content: "hello\nworld" });
  expect(short).toEqual({ lines: ["+ hello", "+ world"], diff: true });
  const big = permissionPreview("write", {
    path: "x.txt",
    content: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"),
  });
  expect(big!.lines).toHaveLength(13); // 12 + the "+N more" marker
  expect(big!.lines[12]).toContain("+18 more");
});

test("permissionPreview is null when the label suffices (read, short URL, no content)", () => {
  expect(permissionPreview("read", { path: "a.ts" })).toBeNull();
  expect(permissionPreview("webfetch", { url: "https://x.dev" })).toBeNull();
  expect(permissionPreview("webfetch", { url: `https://x.dev/${"p".repeat(80)}` })).not.toBeNull();
  expect(permissionPreview("write", { path: "a.ts" })).toBeNull();
});
