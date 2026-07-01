import type { ToolDefinition } from "@vibe/shared";
import { readTool } from "./read.ts";
import { globTool } from "./glob.ts";
import { lsTool } from "./ls.ts";
import { grepTool } from "./grep.ts";
import { bashTool } from "./bash.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { webfetchTool, type WebfetchOptions } from "./webfetch.ts";
import { repoMapTool } from "./repo-map.ts";
import { webSearchTool } from "./web-search.ts";
import { crawlDocsTool } from "./crawl-docs.ts";
import { packageInfoTool } from "./package-info.ts";
import { presentPlanTool } from "./present-plan.ts";
import { gitTools } from "./git.ts";
import { BackgroundJobs, backgroundJobTools } from "./jobs.ts";
import { createFetchCache } from "./fetch-cache.ts";

/** How long a fetched page stays cache-fresh (docs/changelogs get re-read a lot). */
const WEBFETCH_CACHE_TTL_MS = 5 * 60_000;

export interface BuiltinToolOptions {
  /** Web search (keyless by default; a TinyFish key adds a booster engine). */
  search?: { enabled?: boolean; apiKey?: string };
  /** webfetch SSRF policy + limits (timeout, byte cap, cache). */
  webfetch?: WebfetchOptions;
  /** Shared background-job registry; enables `bash background:true` + job tools. */
  jobs?: BackgroundJobs;
}

/** All file/shell/web/plan/git built-in tools (subagent tools are added by core). */
export function builtinTools(opts: BuiltinToolOptions = {}): ToolDefinition[] {
  const jobs = opts.jobs ?? new BackgroundJobs();
  // A per-toolset cache-through store so webfetch serves repeat/failed fetches of
  // the same URL from memory (callers can override via opts.webfetch.cache).
  const fetchCache = opts.webfetch?.cache ?? createFetchCache({ ttlMs: WEBFETCH_CACHE_TTL_MS });
  const tools: ToolDefinition[] = [
    readTool,
    globTool,
    lsTool,
    grepTool,
    repoMapTool,
    webfetchTool({ ...opts.webfetch, cache: fetchCache }),
    packageInfoTool,
    writeTool,
    editTool,
    bashTool(jobs),
    presentPlanTool,
    ...gitTools,
    ...backgroundJobTools(jobs),
  ];
  if (opts.search?.enabled !== false) {
    tools.push(webSearchTool({ apiKey: opts.search?.apiKey }));
    // Same policy as webfetch: the crawler runs the identical hardened pipeline.
    tools.push(
      crawlDocsTool({
        ...(opts.webfetch?.allowPrivateHosts || opts.webfetch?.allowHosts
          ? {
              policy: {
                ...(opts.webfetch.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
                ...(opts.webfetch.allowHosts ? { allowHosts: opts.webfetch.allowHosts } : {}),
              },
            }
          : {}),
        ...(opts.webfetch?.lookup ? { lookup: opts.webfetch.lookup } : {}),
      }),
    );
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
  crawlDocsTool,
  packageInfoTool,
  presentPlanTool,
  repoMapTool,
  gitTools,
};
export { BackgroundJobs, backgroundJobTools } from "./jobs.ts";
