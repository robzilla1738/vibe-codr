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
  update_tasks: "☑",
  todowrite: "☑",
  todo_write: "☑",
  present_plan: "◑",
  recall: "❖",
  memory: "❖",
  recall_memory: "❖",
  save_memory: "❖",
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

/** Compact `key=value` digest of remaining args, e.g. `[depth=2, all=true]`. */
function kv(args: Record<string, unknown>, max = 3): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v != null && v !== "")
    .slice(0, max)
    .map(([k, v]) => `${k}=${truncate(str(v), 24)}`);
  return parts.length ? ` [${parts.join(", ")}]` : "";
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
      return `glob ${quote(a.pattern || a.glob)}${a.path ? ` in ${str(a.path)}` : ""}`.trim();
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
    case "recall":
    case "recall_memory":
      return `recall memory ${quote(truncate(str(a.query || a.q || a.prompt), 48))}`.trim();
    case "save_memory":
    case "memory":
      return `save memory ${quote(truncate(str(a.title || a.name || a.query), 48))}`.trim();
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
