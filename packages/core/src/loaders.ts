import { Glob } from "bun";
import { basename, dirname } from "node:path";
import { parseSkillMarkdown, type SlashCommand, type Skill } from "@vibe/plugins";

/**
 * Substitute `$ARGUMENTS` (all args) and `$1`..`$99` (positional) in a template.
 * Single-pass so a value containing `$N` isn't re-substituted and `$10` isn't
 * mangled by an earlier `$1` match. Unknown placeholders are left verbatim.
 */
export function applyArgs(body: string, args: string): string {
  const trimmed = args.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  return body.replace(/\$(ARGUMENTS|\d{1,2})/g, (match, key: string) => {
    if (key === "ARGUMENTS") return trimmed;
    const value = parts[Number(key) - 1];
    return value ?? match;
  });
}

/**
 * Load custom slash commands from `.vibe/commands/*.md`. Each file becomes a
 * `/name` command whose body (with arg substitution) is injected as a prompt.
 */
export async function loadCommandFiles(cwd: string): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  const glob = new Glob("*.md");
  const dir = `${cwd}/.vibe/commands`;
  try {
    for await (const file of glob.scan({ cwd: dir, absolute: true })) {
      const raw = await Bun.file(file).text();
      const { frontmatter, body } = parseSkillMarkdown(raw);
      const name = frontmatter.name ?? basename(file, ".md");
      commands.push({
        name,
        description: frontmatter.description ?? `Custom command /${name}`,
        source: "file",
        run: (args) => ({ kind: "prompt", text: applyArgs(body, args) }),
      });
    }
  } catch {
    // No commands directory — fine.
  }
  return commands;
}

/**
 * Load skills from `<root>/*​/SKILL.md`. Only name + description are surfaced
 * up front; the full body is loaded on demand via the `use_skill` tool.
 */
export async function loadSkillsFrom(root: string): Promise<Skill[]> {
  const skills: Skill[] = [];
  const glob = new Glob("*/SKILL.md");
  try {
    for await (const file of glob.scan({ cwd: root, absolute: true })) {
      const raw = await Bun.file(file).text();
      const { frontmatter, body } = parseSkillMarkdown(raw);
      const dir = dirname(file);
      const name = frontmatter.name ?? basename(dir);
      skills.push({
        name,
        description: frontmatter.description ?? name,
        ...(frontmatter.when_to_use
          ? { whenToUse: frontmatter.when_to_use }
          : {}),
        dir,
        load: async () => body,
      });
    }
  } catch {
    // No skills directory — fine.
  }
  return skills;
}

/** Load skills from the project's `.vibe/skills` directory. */
export function loadSkills(cwd: string): Promise<Skill[]> {
  return loadSkillsFrom(`${cwd}/.vibe/skills`);
}
