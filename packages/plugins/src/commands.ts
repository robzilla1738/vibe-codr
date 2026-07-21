import type { EngineCommand } from "@vibe/shared";

/** What running a slash command produces for the engine to act on. */
export type SlashResult =
  | { kind: "prompt"; text: string }
  | { kind: "command"; command: EngineCommand }
  | { kind: "notice"; message: string };

export interface SlashCommand {
  name: string;
  description: string;
  source: "builtin" | "file" | "plugin";
  run(args: string): SlashResult | Promise<SlashResult>;
}

/** Slash command names the parser can actually dispatch. */
export function isSlashCommandName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** Registry of slash commands, keyed by name (without the leading slash). */
export class CommandRegistry {
  #commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand): void {
    if (!isSlashCommandName(cmd.name)) {
      throw new Error(
        `Invalid slash command name "${cmd.name}". Use only letters, numbers, underscores, and hyphens.`,
      );
    }
    this.#commands.set(cmd.name, cmd);
  }

  /** Remove a command by name (plugin register rollback — BUG-070). */
  unregister(name: string): void {
    this.#commands.delete(name);
  }

  get(name: string): SlashCommand | undefined {
    return this.#commands.get(name);
  }

  list(): SlashCommand[] {
    return [...this.#commands.values()];
  }
}

/** Parse a raw input line into a slash invocation, or null if not a command. */
export function parseSlash(line: string): { name: string; args: string } | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const rest = trimmed.slice(1);
  const space = rest.indexOf(" ");
  const name = space === -1 ? rest : rest.slice(0, space);
  if (!isSlashCommandName(name)) return null;
  return space === -1 ? { name, args: "" } : { name, args: rest.slice(space + 1).trim() };
}
