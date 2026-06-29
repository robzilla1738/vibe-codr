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
  { name: "compact", description: "Compact the conversation to free context" },
  { name: "resume", description: "List saved sessions to resume" },
  { name: "recall", description: "Search past sessions", arg: "<text>" },
  { name: "export", description: "Export the conversation to Markdown", arg: "[path]" },
  { name: "init", description: "Scaffold .vibe/config.json and VIBE.md" },
  // Model & mode
  { name: "model", description: "Switch the active model", arg: "<id>" },
  { name: "models", description: "List available models" },
  { name: "plan", description: "Switch to read-only plan mode" },
  { name: "execute", description: "Switch to execute mode" },
  { name: "approvals", description: "Set approval mode", values: ["ask", "auto"] },
  { name: "reasoning", description: "Set reasoning effort", values: ["low", "medium", "high", "off"] },
  { name: "theme", description: "Set the UI theme", values: ["default", "light", "contrast", "opencode"] },
  // Steering
  { name: "goal", description: "Set or clear the north-star goal", arg: "<text>" },
  { name: "loop", description: "Run a prompt on a loop", arg: "<interval> <prompt>" },
  { name: "queue", description: "Show the prompt queue" },
  // Code & safety
  { name: "diff", description: "Show the working-tree diff" },
  { name: "review", description: "Review the working-tree changes" },
  { name: "verify", description: "Run the configured verify command" },
  { name: "undo", description: "Revert to the last checkpoint" },
  { name: "checkpoints", description: "List workspace checkpoints" },
  // Extensions & config
  { name: "config", description: "Show the effective config" },
  { name: "memory", description: "Show loaded memory files" },
  { name: "permissions", description: "Show tool permission rules" },
  { name: "tools", description: "List tools in the current mode" },
  { name: "agents", description: "List named subagents" },
  { name: "skills", description: "List available skills" },
  { name: "commands", description: "List custom slash commands" },
  { name: "mcp", description: "Show connected MCP servers" },
  { name: "doctor", description: "Run an environment health check" },
  { name: "exit", description: "Exit vibe-codr (alias /quit)" },
];

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
 */
export function paletteState(draft: string): PaletteState {
  if (!draft.startsWith("/")) return { open: false };
  const space = draft.indexOf(" ");
  if (space === -1) {
    const query = draft.slice(1).toLowerCase();
    const items = PALETTE_COMMANDS.filter((c) => c.name.toLowerCase().startsWith(query));
    return items.length ? { open: true, mode: "command", query, items } : { open: false };
  }
  const name = draft.slice(1, space).toLowerCase();
  const command = PALETTE_COMMANDS.find((c) => c.name === name);
  if (!command?.values) return { open: false };
  const query = draft.slice(space + 1).trim().toLowerCase();
  const items = command.values.filter((v) => v.startsWith(query));
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
