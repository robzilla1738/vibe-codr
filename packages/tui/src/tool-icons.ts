/**
 * Per-tool glyphs + one-line summaries for the transcript, inspired by
 * opencode's tool rendering (each tool reads as a distinct icon + a concise
 * action label rather than a generic "tool" line + raw JSON).
 *
 * Pure presentation logic with no OpenTUI/Solid dependency, so it's unit-tested
 * directly and reused by both the OpenTUI app and the headless renderer.
 *
 * Icon rules: family → shape, action → stroke. Prefer widely-supported glyphs
 * (avoid rare emoji that mojibake on Windows Terminal). Color stays semantic in
 * ToolBlockView (error / live / done) — never rainbow-per-tool.
 */

/** Exact-match icon table. Unknown tools fall back via {@link toolIcon}. */
const ICONS: Record<string, string> = {
  // Shell
  bash: "$",
  shell: "$",
  // Files — direction for read/write; pencil for edit; patch for apply_patch
  read: "→",
  write: "←",
  edit: "✎",
  multiedit: "✎",
  apply_patch: "▤",
  // Search / listing
  glob: "∗",
  grep: "#",
  repo_map: "⌗",
  list: "☰",
  ls: "☰",
  // Web
  webfetch: "◎",
  web_fetch: "◎",
  crawl_docs: "◎",
  websearch: "◈",
  web_search: "◈",
  // Orchestration
  task: "✦",
  subagent: "✦",
  spawn_subagent: "✦",
  spawn_tasks: "✦",
  continue_subagent: "↻",
  check_task: "✓",
  read_report: "↩",
  // Session / planning
  update_tasks: "☑",
  todowrite: "☑",
  todo_write: "☑",
  present_plan: "◑",
  // Memory / notes
  recall: "◇",
  memory: "◇",
  recall_memory: "◇",
  save_memory: "◇",
  post_note: "◇",
  read_notes: "◇",
  // Skills / checks / packages / jobs
  use_skill: "❋",
  run_check: "✓",
  package_info: "⊙",
  job_status: "◷",
  job_kill: "■",
  // MCP
  read_mcp_resource: "⊕",
  get_mcp_prompt: "⊕",
  think: "✎",
};

/** Every built-in tool name we expect to have a non-fallback glyph (for tests). */
export const BUILTIN_TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "ls",
  "repo_map",
  "webfetch",
  "web_search",
  "crawl_docs",
  "package_info",
  "git_status",
  "git_diff",
  "git_commit",
  "git_log",
  "git_push",
  "job_status",
  "job_kill",
  "present_plan",
  "spawn_subagent",
  "spawn_tasks",
  "continue_subagent",
  "check_task",
  "read_report",
  "update_tasks",
  "recall_memory",
  "save_memory",
  "post_note",
  "read_notes",
  "use_skill",
  "run_check",
  "read_mcp_resource",
  "get_mcp_prompt",
] as const;

/** Resolve a tool name to its glyph, with sensible prefixes for families. */
export function toolIcon(name: string): string {
  const key = name.toLowerCase();
  const exact = ICONS[key];
  if (exact) return exact;
  if (key.startsWith("git_") || key.startsWith("git")) return "±";
  if (key.startsWith("mcp")) return "⊕";
  return "⚒";
}

/** Coerce a tool's `input` (object or JSON string) into a plain record. */
function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>;
  if (typeof input === "string" && input.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* not JSON — fall through */
    }
  }
  return {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function quote(v: unknown): string {
  const s = str(v);
  return s ? `"${s}"` : "";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Shorten a filesystem path for a one-line tool summary (opencode-style
 * scanability). Prefers a readable tail over a hard mid-path clip: long
 * absolute paths become `…/pkg/src/file.ts` instead of
 * `/Users/me/Code/very-long-pr…`. Leading home directories collapse to `~/`.
 * Pure — no `process.cwd()` / `os.homedir()` — so unit tests stay hermetic.
 */
export function displayPath(path: string, max = 48): string {
  if (!path) return "";
  let norm = path.replace(/\\/g, "/");
  // /Users/<name>/… or /home/<name>/… → ~/…
  const home = norm.match(/^\/(?:Users|home)\/[^/]+(\/.*)?$/);
  if (home) norm = `~${home[1] ?? ""}`;
  if (norm.length <= max) return norm;
  const parts = norm.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return truncate(norm, max);
  // Grow the tail until the next segment would overflow, then prefix `…/`.
  let out = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    // +2 for the `…/` ellipsis prefix once we drop earlier segments.
    if (next.length + 2 > max) return `…/${out}`;
    out = next;
  }
  return truncate(out, max);
}

/** Compact `key=value` digest of remaining args, e.g. `[depth=2, all=true]`.
 * Objects/arrays digest as truncated JSON (a raw `String(v)` would print the
 * useless `[object Object]`). */
function kv(args: Record<string, unknown>, max = 3): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v != null && v !== "")
    .slice(0, max)
    .map(([k, v]) => {
      const val = typeof v === "object" ? safeJson(v) : str(v);
      return `${k}=${truncate(val, 24)}`;
    });
  return parts.length ? ` [${parts.join(", ")}]` : "";
}

/** JSON.stringify that never throws (circular input digests as its type). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return Array.isArray(v) ? "[…]" : "{…}";
  }
}

/**
 * Human-readable, single-line summary of a tool call — the text shown after the
 * icon. Falls back to `name [k=v, …]` for tools without a bespoke formatter.
 */
export function toolSummary(name: string, input: unknown): string {
  const a = asRecord(input);
  const key = name.toLowerCase();
  const path = displayPath(str(a.path || a.file || a.filePath || a.file_path));
  switch (key) {
    case "bash":
    case "shell":
      // The `$` icon already reads as a shell prompt, so the summary is just
      // the command (avoids a doubled `$ $`).
      return truncate(str(a.command || a.cmd), 72);
    case "read":
      return path ? `read ${path}` : "read";
    case "write":
      return path ? `write ${path}` : "write";
    case "edit":
    case "multiedit":
      return path ? `edit ${path}` : "edit";
    case "apply_patch":
      return path ? `patch ${path}` : "patch";
    case "glob":
      return `glob ${quote(a.pattern || a.glob)}${a.cwd || a.path ? ` in ${displayPath(str(a.cwd || a.path), 32)}` : ""}`.trim();
    case "grep":
      return `grep ${quote(a.pattern || a.query)}${a.path ? ` in ${displayPath(str(a.path), 32)}` : ""}`.trim();
    case "list":
    case "ls":
      return `list ${displayPath(str(a.path)) || "."}`;
    case "repo_map":
      return a.path || a.cwd ? `map ${displayPath(str(a.path || a.cwd), 40)}` : "map repo";
    case "webfetch":
    case "web_fetch":
      return `fetch ${truncate(str(a.url), 64)}`;
    case "websearch":
    case "web_search":
      return `search ${quote(truncate(str(a.query || a.q), 56))}`.trim();
    case "task":
    case "subagent":
    case "spawn_subagent":
      return `subagent ${quote(truncate(str(a.description || a.title || a.prompt), 56))}`.trim();
    case "continue_subagent":
      return `continue ${str(a.id || a.subagent_id || a.subagentId || a.task_id)}`.trim();
    case "check_task":
      return `check ${str(a.id || a.task_id || a.taskId)}`.trim();
    case "spawn_tasks": {
      // A task-DAG fan-out: show the shape (`3 tasks: recon → impl → verify`),
      // not the raw objects (which would stringify uselessly).
      const tasks = Array.isArray(a.tasks) ? (a.tasks as Record<string, unknown>[]) : [];
      const ids = tasks.map((t) => str(t?.id)).filter(Boolean);
      const n = tasks.length;
      return n ? `${n} task${n === 1 ? "" : "s"}: ${truncate(ids.join(" → "), 56)}` : "spawn tasks";
    }
    case "read_report":
      return `read report ${str(a.task_id || a.taskId)}`.trim();
    case "recall":
    case "recall_memory":
      return `recall memory ${quote(truncate(str(a.query || a.q || a.prompt), 48))}`.trim();
    case "save_memory":
    case "memory":
      return `save memory ${quote(truncate(str(a.fact || a.title || a.name), 48))}`.trim();
    case "post_note":
      return `post note ${quote(truncate(str(a.note), 48))}`.trim();
    case "read_notes":
      return "read shared notes";
    case "use_skill":
      return `skill ${str(a.name)}`.trim();
    case "run_check":
      return `run ${str(a.check) || "check"}`.trim();
    case "crawl_docs":
      return `crawl ${truncate(str(a.url), 40)} ${quote(truncate(str(a.query), 32))}`.trim();
    case "package_info":
      return `package ${str(a.name)}${a.ecosystem ? ` (${str(a.ecosystem)})` : ""}`.trim();
    case "job_status":
      return `job ${str(a.id)}`.trim();
    case "job_kill":
      return `kill job ${str(a.id)}`.trim();
    case "read_mcp_resource":
      return a.uri ? `mcp resource ${truncate(str(a.uri), 56)}` : "list mcp resources";
    case "get_mcp_prompt":
      return a.name
        ? `mcp prompt ${[str(a.server), str(a.name)].filter(Boolean).join("/")}`
        : "list mcp prompts";
    case "update_tasks":
    case "todowrite":
    case "todo_write":
      return "update tasks";
    case "present_plan":
      return "present plan";
    case "git_status":
      return "git status";
    case "git_diff":
      return a.path || a.file ? `git diff ${displayPath(str(a.path || a.file), 40)}` : "git diff";
    case "git_commit":
      return `git commit ${quote(truncate(str(a.message || a.msg), 48))}`.trim();
    case "git_log":
      return a.n || a.count ? `git log -${str(a.n || a.count)}` : "git log";
    case "git_push":
      return a.remote || a.branch
        ? `git push ${[str(a.remote), str(a.branch)].filter(Boolean).join(" ")}`.trim()
        : "git push";
    default:
      if (key.startsWith("git_") || key.startsWith("git")) {
        return `${humanize(name)}${kv(a, 2)}`;
      }
      return `${humanize(name)}${kv(a)}`;
  }
}

/** Turn a raw tool identifier into a human label: drop the `mcp__` marker (keeping
 * the server name for context) and read `snake_case`/`kebab-case` as spaced words,
 * so `mcp__linear__create_issue` → "linear create issue" and `recall_memory` →
 * "recall memory". Keeps the fallback line readable instead of code-y. */
function humanize(name: string): string {
  return name
    .replace(/^mcp__/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
}

/** The full transcript label: `{icon} {summary}`. */
export function toolLabel(name: string, input: unknown): string {
  return `${toolIcon(name)} ${toolSummary(name, input)}`;
}

/** Cap for permission-preview body lines — enough to judge the action, small
 * enough that the card never crowds out the input. */
const PREVIEW_MAX_LINES = 12;

/** Bound `lines` to the preview cap, appending a "+N more" marker. */
function capLines(lines: string[]): string[] {
  if (lines.length <= PREVIEW_MAX_LINES) return lines;
  const hidden = lines.length - PREVIEW_MAX_LINES;
  return [...lines.slice(0, PREVIEW_MAX_LINES), `… +${hidden} more line${hidden === 1 ? "" : "s"}`];
}

/**
 * What an approval prompt should SHOW before the user grants it — the part the
 * one-line `toolLabel` cannot carry. An ask-mode user was otherwise approving
 * blind: bash truncated at 72 chars (the dangerous tail is exactly what got cut)
 * and edit/write showing only a path with no content at all.
 *
 * Returns the full bash command (only when the label truncated it), a `-`/`+`
 * preview of each edit, the head of a write's content, or the full URL — capped
 * at {@link PREVIEW_MAX_LINES}. `diff` marks `-`/`+` lines for red/green
 * rendering. Null when the label already tells the whole story.
 */
export function permissionPreview(
  name: string,
  input: unknown,
): { lines: string[]; diff: boolean } | null {
  const a = asRecord(input);
  const key = name.toLowerCase();
  switch (key) {
    case "bash":
    case "shell": {
      const cmd = str(a.command || a.cmd);
      // The label shows ≤72 chars of a single line; only preview what it hides.
      if (!cmd || (cmd.length <= 72 && !cmd.includes("\n"))) return null;
      return { lines: capLines(cmd.split("\n")), diff: false };
    }
    case "edit":
    case "multiedit": {
      // Single-edit form or the atomic `edits` array — both become one -/+ run
      // per edit so the user sees WHAT changes, not just which file.
      const edits = Array.isArray(a.edits)
        ? (a.edits as Record<string, unknown>[])
        : a.oldString != null || a.newString != null
          ? [a]
          : [];
      const lines: string[] = [];
      for (const e of edits) {
        for (const l of str(e.oldString).split("\n")) lines.push(`- ${l}`);
        for (const l of str(e.newString).split("\n")) lines.push(`+ ${l}`);
      }
      return lines.length ? { lines: capLines(lines), diff: true } : null;
    }
    case "write": {
      const content = str(a.content);
      if (!content) return null;
      return { lines: capLines(content.split("\n").map((l) => `+ ${l}`)), diff: true };
    }
    case "webfetch":
    case "web_fetch": {
      const url = str(a.url);
      // The label truncates URLs at 64 chars — show the full one past that.
      return url.length > 64 ? { lines: [url], diff: false } : null;
    }
    default:
      return null;
  }
}

/** Long successful shell dumps stay collapsed after land (line-count meta). */
export const LONG_OUTPUT_COLLAPSE_LINES = 12;

/** Tools whose long success output should force-collapse when landing. */
export function isLongOutputTool(toolName: string): boolean {
  const k = toolName.toLowerCase();
  return k === "bash" || k === "shell" || k.startsWith("git_");
}
