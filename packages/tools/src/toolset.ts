import { tool, type Tool } from "ai";
import type { Mode, ToolContext, ToolDefinition } from "@vibe/shared";
import { builtinTools } from "./builtins/index.ts";

/** The session-scoped parts of a ToolContext supplied by the engine. */
export type ToolRuntimeBase = Pick<ToolContext, "cwd" | "sessionId" | "emit">;

/**
 * Holds tool definitions and produces the AI-SDK tool map for a given mode.
 * Plan mode exposes only read-only tools, so the model literally cannot emit a
 * side-effecting tool call while planning.
 */
export class Toolset {
  #tools = new Map<string, ToolDefinition>();

  constructor(defs: ToolDefinition[] = builtinTools()) {
    for (const def of defs) this.register(def);
  }

  register(def: ToolDefinition): void {
    this.#tools.set(def.name, def);
  }

  all(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  /** Tools permitted in `mode`. Plan mode -> read-only only. */
  forMode(mode: Mode): ToolDefinition[] {
    const all = this.all();
    return mode === "plan" ? all.filter((t) => t.readOnly) : all;
  }

  /** Names permitted in `mode` (for AI-SDK `activeTools`). */
  names(mode: Mode): string[] {
    return this.forMode(mode).map((t) => t.name);
  }

  /** Build the AI-SDK `tools` map for `mode`, bound to the session context. */
  aiTools(mode: Mode, base: ToolRuntimeBase): Record<string, Tool> {
    const map: Record<string, Tool> = {};
    for (const def of this.forMode(mode)) {
      map[def.name] = toAISDKTool(def, base);
    }
    return map;
  }
}

/** Adapt one ToolDefinition into an AI-SDK `tool()`. */
export function toAISDKTool(
  def: ToolDefinition,
  base: ToolRuntimeBase,
): Tool {
  return tool({
    description: def.description,
    inputSchema: def.inputSchema,
    async execute(input, options) {
      const ctx: ToolContext = {
        ...base,
        toolCallId: options.toolCallId,
        abortSignal: options.abortSignal ?? new AbortController().signal,
      };
      const result = await def.execute(input, ctx);
      if (result.isError) {
        const text =
          typeof result.output === "string"
            ? result.output
            : JSON.stringify(result.output);
        return `ERROR: ${text}`;
      }
      return result.output;
    },
  });
}
