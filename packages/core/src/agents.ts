import { Glob } from "bun";
import { basename } from "node:path";
import { parseSkillMarkdown } from "@vibe/plugins";
import type { Mode } from "@vibe/shared";

/** A named subagent defined in `.vibe/agents/<name>.md`. */
export interface NamedAgent {
  name: string;
  description: string;
  model?: string;
  mode?: Mode;
  /** Tool allowlist (frontmatter `tools:`): when set, the agent sees ONLY these
   * tools — defense-in-depth for a focused worker. */
  tools?: string[];
  /** Tool denylist (frontmatter `disallowed_tools:`): these are removed. */
  denyTools?: string[];
  /** System instructions (the markdown body). */
  system?: string;
}

/** Parse a comma/space-separated frontmatter list (e.g. "read, grep glob"). */
function parseToolList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = value
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * Built-in coding agents available out of the box, so multi-agent coding works
 * without the user authoring any `.vibe/agents/*.md`. `explore` and `review` are
 * read-only (plan mode), so they're inherently parallel-safe; `test` writes.
 * A user file of the same name overrides the default (see `loadAgents`).
 */
export function defaultAgents(): Map<string, NamedAgent> {
  const defs: NamedAgent[] = [
    {
      name: "explore",
      description: "Read-only codebase research — map files and answer a question",
      mode: "plan",
      system:
        "You are an exploration subagent. Investigate only — do NOT modify files " +
        "or run side-effecting commands. Read the relevant files and search the " +
        "codebase, then return a precise, self-contained map: the key files with " +
        "`path:line` references, the important code, and a direct answer to the " +
        "question you were given. Be concrete and skip preamble.",
    },
    {
      name: "review",
      description: "Adversarial code review of a diff or set of files",
      mode: "plan",
      system:
        "You are an adversarial code-review subagent. Your job is to try to " +
        "FALSIFY the claim that the work under review is correct — do not trust " +
        "any description, verify against the actual files. Check edge cases and " +
        "the unhappy path, error handling, security (injection, path traversal, " +
        "leaked secrets), and whether tests actually exercise real behavior (flag " +
        "no-op or trivially-passing assertions). Report concrete issues as " +
        "`path:line — problem`, ordered by severity, or exactly `REVIEW-CLEAN` if " +
        "you genuinely find nothing. Do not modify files.",
    },
    {
      name: "test",
      description: "Write and run tests against the project's existing framework",
      mode: "execute",
      system:
        "You are a test-author subagent. Turn each acceptance criterion into " +
        "concrete, executable tests using the project's existing test framework " +
        "and conventions (match neighbouring test files). Run the suite and leave " +
        "it green; if a test reveals a real product bug, report it rather than " +
        "weakening the test. Touch only test files unless told otherwise. Report " +
        "what you added and the pass/fail counts.",
    },
  ];
  return new Map(defs.map((a) => [a.name, a]));
}

/**
 * Load named agents from `.vibe/agents/*.md`, layered over the built-in
 * defaults. Each file's frontmatter supplies `description`, optional `model`,
 * and optional `mode`; the body is the agent's system instructions. A user file
 * whose name matches a built-in (e.g. `explore`) overrides it.
 */
export async function loadAgents(cwd: string): Promise<Map<string, NamedAgent>> {
  const agents = defaultAgents();
  const glob = new Glob("*.md");
  const dir = `${cwd}/.vibe/agents`;
  try {
    for await (const file of glob.scan({ cwd: dir, absolute: true })) {
      const raw = await Bun.file(file).text();
      const { frontmatter, body } = parseSkillMarkdown(raw);
      const name = frontmatter.name ?? basename(file, ".md");
      // Honor an explicit plan|execute; ignore (and don't crash on) anything else.
      const mode =
        frontmatter.mode === "plan" || frontmatter.mode === "execute"
          ? frontmatter.mode
          : undefined;
      const tools = parseToolList(frontmatter.tools);
      const denyTools = parseToolList(frontmatter.disallowed_tools ?? frontmatter.deny_tools);
      agents.set(name, {
        name,
        description: frontmatter.description ?? name,
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
        ...(mode ? { mode } : {}),
        ...(tools ? { tools } : {}),
        ...(denyTools ? { denyTools } : {}),
        ...(body ? { system: body } : {}),
      });
    }
  } catch {
    // No agents directory — that's fine.
  }
  return agents;
}
