import type { ToolDefinition } from "@vibe/shared";
import { readTool } from "./read.ts";
import { globTool } from "./glob.ts";
import { lsTool } from "./ls.ts";
import { grepTool } from "./grep.ts";
import { bashTool } from "./bash.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { webfetchTool } from "./webfetch.ts";

/** All file/shell/web built-in tools (subagent + plan tools live in core). */
export function builtinTools(): ToolDefinition[] {
  return [
    readTool,
    globTool,
    lsTool,
    grepTool,
    webfetchTool,
    writeTool,
    editTool,
    bashTool,
  ];
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
};
