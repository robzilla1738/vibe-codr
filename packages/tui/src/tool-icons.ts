/**
 * Per-tool glyphs + one-line summaries for the transcript, inspired by
 * opencode's tool rendering (each tool reads as a distinct icon + a concise
 * action label rather than a generic "tool" line + raw JSON).
 *
 * Pure presentation logic with no OpenTUI/Solid dependency, so it's unit-tested
 * directly and reused by both the OpenTUI app and the headless renderer.
 */

/** Exact-match icon table. Unknown tools fall back via {@link toolIcon}. */
const ICONS: Record<string, string> = {
  bash: "$",
  shell: "$",
  read: "→",
  write: "←",
  edit: "←",
  multiedit: "←",
  apply_patch: "%",
  glob: "✱",
  grep: "✱",
  repo_map: "⌗",
  list: "☰",
  ls: "☰",
  webfetch: "%",
  web_fetch: "%",
  websearch: "◈",
  web_search: "◈",
  task: "✦",
  subagent: "✦",
  spawn_subagent: "✦",
  spawn_tasks: "✦",
  read_report: "→",
  update_tasks: "☑",
  todowrite: "☑",
  todo_write: "☑",
  present_plan: "◑",
  recall: "❖",
  memory: "❖",
  recall_memory: "❖",
  save_memory: "❖",
  post_note: "❖",
  read_notes: "❖",
  use_skill: "❋",
  run_check: "✓",
  crawl_docs: "%",
  package_info: "⊙",
  job_status: "☰",
  job_kill: "■",
  read_mcp_resource: "⊕",
  get_mcp_prompt: "⊕",
  think: "✎",
};

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
  const path = str(a.path || a.file || a.filePath || a.file_path);
  switch (key) {
    case "bash":
    case "shell":
      // The `$` icon already reads as a shell prompt, so the summary is just
      // the command (avoids a doubled `$ $`).
      return truncate(str(a.command || a.cmd), 72);
    case "read":
      return `read ${path}`;
    case "write":
      return `write ${path}`;
    case "edit":
    case "multiedit":
      return `edit ${path}`;
    case "apply_patch":
      return `patch ${path}`;
    case "glob":
      return `glob ${quote(a.pattern || a.glob)}${a.cwd || a.path ? ` in ${str(a.cwd || a.path)}` : ""}`.trim();
    case "grep":
      return `grep ${quote(a.pattern || a.query)}${a.path ? ` in ${str(a.path)}` : ""}`.trim();
    case "list":
    case "ls":
      return `list ${str(a.path) || "."}`;
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
    case "spawn_tasks": {
      // A task-DAG fan-out: show the shape (`3 tasks: recon → impl → verify`),
      // not the raw objects (which would stringify uselessly).
      const tasks = Array.isArray(a.tasks) ? (a.tasks as Record<string, unknown>[]) : [];
      const ids = tasks.map((t) => str(t?.id)).filter(Boolean);
      const n = tasks.length;
      return n
        ? `${n} task${n === 1 ? "" : "s"}: ${truncate(ids.join(" → "), 56)}`
        : "spawn tasks";
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
      return a.name ? `mcp prompt ${[str(a.server), str(a.name)].filter(Boolean).join("/")}` : "list mcp prompts";
    case "update_tasks":
    case "todowrite":
    case "todo_write":
      return "update tasks";
    case "present_plan":
      return "present plan";
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
  return name.replace(/^mcp__/i, "").replace(/[_-]+/g, " ").trim();
}

/** The full transcript label: `{icon} {summary}`. */
export function toolLabel(name: string, input: unknown): string {
  return `${toolIcon(name)} ${toolSummary(name, input)}`;
}
