import { join } from "node:path";
import type { ModelInfo } from "@vibe/providers";
import type { SlashCommand } from "@vibe/plugins";
import { ensureVibeIgnored } from "./state-dir.ts";

export interface BuiltinCommandMeta {
  name: string;
  description: string;
}

/** A named group of related commands, for a readable `/help`. */
export interface CommandGroup {
  title: string;
  commands: BuiltinCommandMeta[];
}

/** Built-in slash commands, organised into groups (used by /help). */
export const COMMAND_GROUPS: CommandGroup[] = [
  {
    title: "Session",
    commands: [
      { name: "help", description: "Show available commands" },
      { name: "status", description: "Show model, mode, cwd, tokens, cost and more" },
      { name: "cost", description: "Show token usage and estimated cost" },
      { name: "context", description: "Show context-window usage and compaction threshold" },
      { name: "clear", description: "Clear the conversation history (alias /new)" },
      { name: "jobs", description: "Show background shell jobs + detected localhost servers" },
      { name: "compact", description: "Compact the conversation to free context" },
      { name: "resume", description: "List saved sessions to resume" },
      { name: "recall", description: "Search past sessions' memory (/recall <text>)" },
      { name: "sources", description: "List web sources gathered this session (citations)" },
      {
        name: "export",
        description: "Export the conversation to a Markdown file (/export [path])",
      },
      { name: "init", description: "Scaffold .vibe/config.json and VIBE.md" },
    ],
  },
  {
    title: "Model & mode",
    commands: [
      {
        name: "model",
        description:
          "Switch model + manage providers (persisted): /model <id> · /model sub <id> · /model key <provider> <key>",
      },
      {
        name: "models",
        description: "List available models (/models refresh to force-pull the latest)",
      },
      { name: "providers", description: "List providers + key status (/providers [filter])" },
      { name: "plan", description: "Switch to read-only plan mode" },
      {
        name: "execute",
        description: "Switch to gated execute — every action asks (the AGENT chip)",
      },
      { name: "yolo", description: "Execute with approvals off — tools run without prompting" },
      { name: "approvals", description: "Show or set approval mode (/approvals ask|auto)" },
      {
        name: "reasoning",
        description: "Show or set reasoning effort (/reasoning low|medium|high|off)",
      },
      {
        name: "details",
        description: "Transcript density (/details quiet|normal|verbose · cycles with no arg)",
      },
      {
        name: "mouse",
        description: "TUI mouse capture (/mouse on|off) — off keeps native selection",
      },
      { name: "vision", description: "Vision relay for non-multimodal models (/vision on|off)" },
      { name: "keys", description: "Show essential keyboard shortcuts" },
      { name: "theme", description: "Show or set the UI theme (/theme <name>)" },
      {
        name: "accent",
        description: "Show or set the accent color (/accent orange · /accent <hex>)",
      },
    ],
  },
  {
    title: "Steering",
    commands: [
      {
        name: "goal",
        description:
          "North-star run (/goal <text> · resume · clear · max 15 · plan first off · settings)",
      },
      {
        name: "loop",
        description:
          'Recurring prompt (/loop [interval] <prompt> [--until text | --until-cmd "command"] [--max N] · stop)',
      },
      { name: "queue", description: "Show the prompt queue (/queue clear to empty it)" },
    ],
  },
  {
    title: "Code & safety",
    commands: [
      { name: "diff", description: "Show the working-tree diff" },
      { name: "review", description: "Have the agent review the working-tree changes" },
      { name: "verify", description: "Run the configured verify command (typecheck/tests)" },
      {
        name: "undo",
        description: "Revert the workspace to the last checkpoint (or /undo <n> to jump)",
      },
      { name: "redo", description: "Re-apply the most recently undone checkpoint" },
      { name: "checkpoints", description: "List workspace checkpoints" },
    ],
  },
  {
    title: "Extensions & config",
    commands: [
      {
        name: "config",
        description:
          "Show or set config (natural language: /config goal max rounds 15 · loop default max 20)",
      },
      { name: "memory", description: "Show loaded project/global memory files" },
      { name: "permissions", description: "Show the tool permission rules" },
      { name: "tools", description: "List tools available in the current mode" },
      { name: "agents", description: "List named subagents" },
      { name: "skills", description: "List available skills" },
      { name: "skill", description: "Run a skill by name (/skill <name> [task])" },
      { name: "commands", description: "List custom slash commands" },
      { name: "mcp", description: "Show connected MCP servers" },
      { name: "doctor", description: "Run an environment health check" },
      { name: "sandbox", description: "Show the resolved OS-sandbox policy" },
      { name: "handoff", description: "Request /handoff cloud <e2b|vercel> or /handoff local" },
    ],
  },
];

/** Flat list of every built-in command (used for completion). */
export const BUILTIN_COMMANDS: BuiltinCommandMeta[] = [
  ...COMMAND_GROUPS.flatMap((g) => g.commands),
  { name: "new", description: "Start a fresh conversation (alias of /clear)" },
  { name: "exit", description: "Exit vibe-codr (alias /quit)" },
  { name: "quit", description: "Exit vibe-codr (alias of /exit)" },
];

/** Render the /help text, including any plugin/file commands. */
export function helpText(extra: SlashCommand[] = []): string {
  const pad = 12;
  const lines: string[] = ["Commands"];
  for (const group of COMMAND_GROUPS) {
    lines.push(`\n${group.title}`);
    for (const c of group.commands) {
      lines.push(`  /${c.name.padEnd(pad)} ${c.description}`);
    }
  }
  if (extra.length) {
    lines.push("\nCustom");
    for (const c of extra) {
      lines.push(`  /${c.name.padEnd(pad)} ${c.description} (${c.source})`);
    }
  }
  lines.push(`\n  /${"exit".padEnd(pad)} Exit vibe-codr (alias /quit)`);
  lines.push(
    "\nTip: @file mentions attach file contents; end a line with \\ for multi-line input.",
  );
  return lines.join("\n");
}

/** Render a model list grouped by provider, with context window when known. */
export function formatModelList(models: ModelInfo[]): string {
  if (models.length === 0) {
    return "No models available. Add a provider key (run `vibe setup` or /model key <provider> <key>) or start Ollama/LM Studio.";
  }
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const list = byProvider.get(m.providerId) ?? [];
    list.push(m);
    byProvider.set(m.providerId, list);
  }
  const lines: string[] = [];
  for (const [provider, list] of [...byProvider.entries()].sort()) {
    lines.push(`${provider}:`);
    for (const m of list.sort((a, b) => a.id.localeCompare(b.id))) {
      const ctx = m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k ctx)` : "";
      lines.push(`  ${provider}/${m.id}${ctx}`);
    }
  }
  return lines.join("\n");
}

const CONFIG_TEMPLATE = `{
  // vibe-codr project config — overrides the user-global config for this repo.
  // Provider keys live in the global config (run \`vibe setup\` or /model key).
  "model": "anthropic/claude-opus-4-8",
  "mode": "execute"
}
`;

const MEMORY_TEMPLATE = `# Project notes

Describe this project for the agent: stack, conventions, how to run and test.
These notes are injected into every system prompt.
`;

/** Create .vibe/config.json and VIBE.md if absent. Returns created paths. */
export async function initProject(cwd: string): Promise<string[]> {
  const created: string[] = [];
  const configPath = join(cwd, ".vibe", "config.json");
  const memoryPath = join(cwd, "VIBE.md");
  if (!(await Bun.file(configPath).exists())) {
    await Bun.write(configPath, CONFIG_TEMPLATE);
    created.push(".vibe/config.json");
    // The in-project .vibe/ just came into existence — keep it out of git.
    await ensureVibeIgnored(cwd);
  }
  if (!(await Bun.file(memoryPath).exists())) {
    await Bun.write(memoryPath, MEMORY_TEMPLATE);
    created.push("VIBE.md");
  }
  return created;
}
