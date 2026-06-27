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
  /** System instructions (the markdown body). */
  system?: string;
}

/**
 * Load named agents from `.vibe/agents/*.md`. Each file's frontmatter supplies
 * `description`, optional `model`, and optional `mode`; the body is the agent's
 * system instructions.
 */
export async function loadAgents(cwd: string): Promise<Map<string, NamedAgent>> {
  const agents = new Map<string, NamedAgent>();
  const glob = new Glob("*.md");
  const dir = `${cwd}/.vibe/agents`;
  try {
    for await (const file of glob.scan({ cwd: dir, absolute: true })) {
      const raw = await Bun.file(file).text();
      const { frontmatter, body } = parseSkillMarkdown(raw);
      const name = frontmatter.name ?? basename(file, ".md");
      const mode = frontmatter.mode === "plan" ? "plan" : undefined;
      agents.set(name, {
        name,
        description: frontmatter.description ?? name,
        ...(frontmatter.model ? { model: frontmatter.model } : {}),
        ...(mode ? { mode } : {}),
        ...(body ? { system: body } : {}),
      });
    }
  } catch {
    // No agents directory — that's fine.
  }
  return agents;
}
