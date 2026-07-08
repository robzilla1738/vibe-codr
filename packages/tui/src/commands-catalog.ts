import { ACCENT_NAMES, THEME_NAMES } from "./themes.ts";

/**
 * Slash-command catalogue for the in-TUI command menu (the palette that opens
 * when you type `/`). This is presentation metadata owned by the UI — the engine
 * stays the source of truth for execution. Mirrors `COMMAND_GROUPS` in
 * @vibe/core; keep them roughly in sync when commands are added.
 */
export interface PaletteCommand {
  name: string;
  description: string;
  /** Enum argument values shown as a second-level menu (e.g. ask|auto). */
  values?: string[];
  /** Free-form argument hint (e.g. "<id>"); no value menu. */
  arg?: string;
}

export const PALETTE_COMMANDS: PaletteCommand[] = [
  // Session
  { name: "help", description: "Show available commands" },
  { name: "status", description: "Model, mode, cwd, tokens, cost" },
  { name: "cost", description: "Token usage and estimated cost" },
  { name: "context", description: "Context-window usage" },
  { name: "clear", description: "Clear the conversation (alias /new)" },
  { name: "jobs", description: "Show background shell jobs + localhost servers" },
  { name: "compact", description: "Compact the conversation to free context" },
  { name: "resume", description: "List saved sessions to resume" },
  { name: "recall", description: "Search past sessions", arg: "<text>" },
  { name: "sources", description: "Web sources gathered this session (citations)" },
  { name: "export", description: "Export the conversation to Markdown", arg: "[path]" },
  { name: "init", description: "Scaffold .vibe/config.json and VIBE.md" },
  // Model & mode
  { name: "model", description: "Pick the model (Tab: main ⇄ subagents · /model refresh)", arg: "[filter]" },
  { name: "models", description: "List available models (/models refresh to force-pull)" },
  { name: "providers", description: "Providers + keys (Enter to configure)", arg: "[filter]" },
  { name: "plan", description: "Read-only plan mode — present a plan for approval" },
  { name: "execute", description: "Gated execute — every action asks (ASK)" },
  { name: "yolo", description: "Execute with approvals off — no prompts" },
  { name: "approvals", description: "Set approval mode", values: ["ask", "auto"] },
  { name: "reasoning", description: "Set reasoning effort", values: ["low", "medium", "high", "off"] },
  // Values derive from the palette registry so a new theme/accent shows up here
  // automatically ("dark" is an alias of default — hidden to keep the menu tight).
  { name: "theme", description: "Set the UI theme", values: THEME_NAMES.filter((n) => n !== "dark") },
  { name: "accent", description: "Set the accent color (or /accent <hex>)", values: ACCENT_NAMES },
  // Steering
  {
    name: "goal",
    description: "Set a north-star goal + start an autonomous run (resume re-arms · clear stops)",
    arg: "[text|resume|clear]",
  },
  { name: "loop", description: "Run a prompt on a loop (/loop stop ends it)", arg: "[interval] <prompt> [--until <cond>] [--max N]" },
  { name: "queue", description: "Show the prompt queue" },
  // Code & safety
  { name: "diff", description: "Show the working-tree diff" },
  { name: "review", description: "Review the working-tree changes" },
  { name: "verify", description: "Run the configured verify command" },
  { name: "undo", description: "Revert to the last checkpoint (or /undo <n> to jump)" },
  { name: "redo", description: "Re-apply the most recently undone checkpoint" },
  { name: "checkpoints", description: "List workspace checkpoints" },
  // Extensions & config
  { name: "config", description: "Show the effective config" },
  { name: "memory", description: "Show loaded memory files" },
  { name: "permissions", description: "Show tool permission rules" },
  { name: "tools", description: "List tools in the current mode" },
  { name: "agents", description: "Named subagents — set a model or create one", arg: "[new <name>]" },
  { name: "skills", description: "Browse skills — searchable menu", arg: "[filter]" },
  { name: "skill", description: "Run a skill by name (never shadowed by built-ins)", arg: "<name> [task]" },
  { name: "commands", description: "List custom slash commands" },
  { name: "mcp", description: "Show connected MCP servers" },
  { name: "doctor", description: "Run an environment health check" },
  { name: "exit", description: "Exit vibe-codr (alias /quit)" },
];

/**
 * `/skills [filter]` picker query — the PLURAL only. The singular
 * `/skill <name>` is the invocation the menu itself prefills; if the picker
 * matched it too, choosing a skill would re-open the menu and Enter would
 * re-prefill forever instead of submitting. Returns the filter text ("" for a
 * bare `/skills`), or null when the draft isn't the skills picker.
 */
export function skillsPickerFilter(draft: string): string | null {
  const m = /^\/skills(?:\s+(.*))?$/is.exec(draft);
  return m ? (m[1] ?? "").trim() : null;
}

/**
 * True when the draft is a slash line whose command word exactly matches a known
 * invocable name (with or without trailing args). `names` is the authoritative
 * set from the engine snapshot (built-ins + custom commands + skills), lowercased.
 * Drives the input's "command registered" color cue — distinct from
 * `paletteState`, which stays open on partial prefixes too.
 */
export function isExactCommand(draft: string, names: ReadonlySet<string>): boolean {
  if (!draft.startsWith("/")) return false;
  const space = draft.indexOf(" ");
  const name = (space === -1 ? draft.slice(1) : draft.slice(1, space)).toLowerCase();
  return name.length > 0 && names.has(name);
}

export type PaletteState =
  | { open: false }
  | { open: true; mode: "command"; query: string; items: PaletteCommand[] }
  | { open: true; mode: "value"; command: PaletteCommand; query: string; items: string[] };

/**
 * Derive the palette from the current draft text. Opens while the draft is a
 * slash line: a command list before the first space, then (for enum commands) a
 * value list after it. Returns closed for plain prompts or free-form args.
 *
 * Command matching is tiered fuzzy, not prefix-only: name-PREFIX matches rank
 * first (muscle memory stays deterministic), then name-substring, then
 * description words — so `/sessions` surfaces `/resume` ("List saved sessions")
 * and `/oal` still finds `/goal` instead of dead-ending. Stable within a tier
 * (catalog order).
 */
export function paletteState(draft: string): PaletteState {
  if (!draft.startsWith("/")) return { open: false };
  const space = draft.indexOf(" ");
  if (space === -1) {
    const query = draft.slice(1).toLowerCase();
    const tier = (c: PaletteCommand): number => {
      const name = c.name.toLowerCase();
      if (!query || name.startsWith(query)) return 0;
      if (name.includes(query)) return 1;
      if (c.description.toLowerCase().includes(query)) return 2;
      return 3;
    };
    const items = PALETTE_COMMANDS.map((c) => ({ c, t: tier(c) }))
      .filter(({ t }) => t < 3)
      .sort((a, b) => a.t - b.t)
      .map(({ c }) => c);
    return items.length ? { open: true, mode: "command", query, items } : { open: false };
  }
  const name = draft.slice(1, space).toLowerCase();
  const command = PALETTE_COMMANDS.find((c) => c.name === name);
  if (!command?.values) return { open: false };
  const query = draft.slice(space + 1).trim().toLowerCase();
  // BUG-081: prefix → substring (same tiers as the command menu, minus fuzzy).
  const tier = (v: string): number => {
    const n = v.toLowerCase();
    if (!query || n.startsWith(query)) return 0;
    if (n.includes(query)) return 1;
    return 3;
  };
  const items = command.values
    .map((v) => ({ v, t: tier(v) }))
    .filter(({ t }) => t < 3)
    .sort((a, b) => a.t - b.t)
    .map(({ v }) => v);
  return items.length ? { open: true, mode: "value", command, query, items } : { open: false };
}

/**
 * Apply the highlighted entry. Returns the new draft text and whether it's a
 * complete command ready to run (`done`). Completing a no-arg command or a value
 * is done; completing a command that still needs an argument is not.
 */
export function applyPalette(
  state: PaletteState,
  selIdx: number,
): { draft: string; done: boolean } | null {
  if (!state.open) return null;
  if (state.mode === "command") {
    const cmd = state.items[selIdx];
    if (!cmd) return null;
    if (cmd.values || cmd.arg) return { draft: `/${cmd.name} `, done: false };
    return { draft: `/${cmd.name}`, done: true };
  }
  const value = state.items[selIdx];
  if (!value) return null;
  return { draft: `/${state.command.name} ${value}`, done: true };
}
