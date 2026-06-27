import { tool, jsonSchema, type Tool } from "ai";
import type { ZodType } from "zod";
import type {
  CheckPermission,
  Mode,
  ToolContext,
  ToolDefinition,
} from "@vibe/shared";
import { builtinTools } from "./builtins/index.ts";

/** Zod schemas expose `.parse`; raw JSON Schema objects don't. */
function isZodSchema(s: unknown): boolean {
  return typeof (s as { parse?: unknown })?.parse === "function";
}

/** The session-scoped parts of a ToolContext supplied by the engine. */
export type ToolRuntimeBase = Pick<ToolContext, "cwd" | "sessionId" | "emit"> & {
  /** Optional gate for side-effecting tools (allow/deny/ask). */
  checkPermission?: CheckPermission;
};

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

  /** Tools permitted in `mode`. Plan mode -> read-only only; respects `modes`. */
  forMode(mode: Mode): ToolDefinition[] {
    return this.all().filter((t) => {
      if (t.modes && !t.modes.includes(mode)) return false;
      if (mode === "plan" && !t.readOnly) return false;
      return true;
    });
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
  // Built-ins carry a Zod schema; bridged tools (MCP) carry a JSON Schema that
  // the AI SDK accepts once wrapped with `jsonSchema()`.
  const inputSchema = isZodSchema(def.inputSchema)
    ? (def.inputSchema as ZodType<unknown>)
    : jsonSchema(def.inputSchema as Parameters<typeof jsonSchema>[0]);
  return tool({
    description: def.description,
    inputSchema,
    async execute(input, options) {
      const ctx: ToolContext = {
        ...base,
        toolCallId: options.toolCallId,
        abortSignal: options.abortSignal ?? new AbortController().signal,
      };

      // Gate side-effecting tools through the permission layer.
      if (!def.readOnly && base.checkPermission) {
        const decision = await base.checkPermission(def.name, input);
        if (!decision.allowed) {
          const reason = decision.reason ?? "denied";
          base.emit({
            type: "notice",
            level: "warn",
            message: `Blocked ${def.name}: ${reason}`,
          });
          return `ERROR: tool "${def.name}" was not permitted (${reason}). Choose a different approach.`;
        }
      }

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
