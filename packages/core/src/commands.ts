import { join } from "node:path";
import type { ModelInfo } from "@vibe/providers";
import type { SlashCommand } from "@vibe/plugins";

export interface BuiltinCommandMeta {
  name: string;
  description: string;
}

/** Metadata for the built-in slash commands (used by /help and completion). */
export const BUILTIN_COMMANDS: BuiltinCommandMeta[] = [
  { name: "help", description: "Show available commands" },
  { name: "model", description: "Show or switch the active model (/model <id>)" },
  { name: "models", description: "List available models for configured providers" },
  { name: "plan", description: "Switch to read-only plan mode" },
  { name: "execute", description: "Switch to execute mode" },
  { name: "goal", description: "Set or clear the north-star goal (/goal <text>)" },
  { name: "agents", description: "List named subagents" },
  { name: "loop", description: "Run a prompt on a loop (/loop <interval> <prompt>)" },
  { name: "queue", description: "Show the prompt queue (/queue clear to empty it)" },
  { name: "compact", description: "Compact the conversation history" },
  { name: "clear", description: "Clear the conversation history" },
  { name: "init", description: "Scaffold .vibe/config.json and VIBE.md" },
];

/** Render the /help text, including any plugin/file commands. */
export function helpText(extra: SlashCommand[] = []): string {
  const lines = ["Commands:"];
  for (const c of BUILTIN_COMMANDS) {
    lines.push(`  /${c.name.padEnd(10)} ${c.description}`);
  }
  for (const c of extra) {
    lines.push(`  /${c.name.padEnd(10)} ${c.description} (${c.source})`);
  }
  return lines.join("\n");
}

/** Render a model list grouped by provider, with context window when known. */
export function formatModelList(models: ModelInfo[]): string {
  if (models.length === 0) {
    return "No models available. Set a provider API key (see .env.example) or start LM Studio.";
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
  // vibe-codr project config. See .env.example for provider keys.
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
  }
  if (!(await Bun.file(memoryPath).exists())) {
    await Bun.write(memoryPath, MEMORY_TEMPLATE);
    created.push("VIBE.md");
  }
  return created;
}
