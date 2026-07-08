import { Glob } from "bun";
import { z } from "zod";
import { join, resolve, relative, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import type { ToolDefinition } from "@vibe/shared";

const Input = z.object({
  pattern: z.string().describe('Glob pattern, e.g. "**/*.ts".'),
  cwd: z.string().optional().describe("Directory to search, relative to cwd."),
});

/** Resolve a user `cwd` under the session root; reject escapes (BUG-051). */
export function resolveContainedDir(sessionCwd: string, sub?: string): string | { error: string } {
  if (!sub?.trim()) return sessionCwd;
  const root = resolve(sessionCwd);
  const candidate = isAbsolute(sub) ? resolve(sub) : resolve(sessionCwd, sub);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `cwd escapes the workspace root (${sessionCwd}): ${sub}` };
  }
  return candidate;
}

export const globTool: ToolDefinition<z.infer<typeof Input>> = {
  name: "glob",
  description:
    "Find files by glob pattern (newest-first by modification time, node_modules/.git excluded). Returns matching paths relative to the search directory.",
  inputSchema: Input,
  readOnly: true,
  concurrencySafe: true,
  async execute({ pattern, cwd }, ctx) {
    const resolved = resolveContainedDir(ctx.cwd, cwd);
    if (typeof resolved === "object") {
      return { output: resolved.error, isError: true };
    }
    const searchDir = resolved;
    const LIMIT = 1000;
    const glob = new Glob(pattern);
    const matches: string[] = [];
    let truncated = false;
    for await (const file of glob.scan({ cwd: searchDir, dot: false })) {
      // Bun's Glob doesn't auto-ignore these, so a broad "**/*.ts" would otherwise
      // drown real results in dependencies / VCS internals.
      if (file.includes("node_modules/") || file === ".git" || file.startsWith(".git/") || file.includes("/.git/")) continue;
      matches.push(file);
      // Probe for one MORE than the cap so a directory with exactly `LIMIT`
      // matches isn't falsely flagged truncated (the old `>= LIMIT` broke early).
      if (matches.length > LIMIT) {
        truncated = true;
        break;
      }
    }
    if (!matches.length) return { output: "(no matches)" };
    // Sort newest-first by mtime — the "what did I just touch" intent. A stat that
    // fails (a file removed mid-scan) sorts last via a 0 timestamp.
    const timed = await Promise.all(
      matches.map(async (f) => ({
        f,
        mtime: await stat(join(searchDir, f)).then((s) => s.mtimeMs).catch(() => 0),
      })),
    );
    timed.sort((a, b) => b.mtime - a.mtime);
    const shown = timed.slice(0, LIMIT).map((x) => x.f);
    const note = truncated
      ? `\n…(truncated at ${LIMIT} matches; narrow the pattern)`
      : "";
    return { output: shown.join("\n") + note };
  },
};
