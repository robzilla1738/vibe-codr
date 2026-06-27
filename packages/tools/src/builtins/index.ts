import type { ToolDefinition } from "@vibe/shared";
import { readTool } from "./read.ts";
import { globTool } from "./glob.ts";
import { lsTool } from "./ls.ts";
import { grepTool } from "./grep.ts";
import { bashTool } from "./bash.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { webfetchTool } from "./webfetch.ts";
import { webSearchTool } from "./web-search.ts";
import { presentPlanTool } from "./present-plan.ts";

export interface BuiltinToolOptions {
  /** Web search (TinyFish). Omit or set `enabled: false` to leave it out. */
  search?: { enabled?: boolean; apiKey?: string };
}

/** All file/shell/web/plan built-in tools (subagent tools are added by core). */
export function builtinTools(opts: BuiltinToolOptions = {}): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    readTool,
    globTool,
    lsTool,
    grepTool,
    webfetchTool,
    writeTool,
    editTool,
    bashTool,
    presentPlanTool,
  ];
  if (opts.search?.enabled !== false) {
    tools.push(webSearchTool({ apiKey: opts.search?.apiKey }));
  }
  return tools;
}

export {
  readTool,
  globTool,
  lsTool,
  grepTool,
  bashTool,
  writeTool,
  editTool,
  webfetchTool,
  webSearchTool,
  presentPlanTool,
};
