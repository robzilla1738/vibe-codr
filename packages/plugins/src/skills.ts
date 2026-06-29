/**
 * A skill = a folder with a SKILL.md (frontmatter + body). Only the name and
 * description are injected into the system prompt; the body is loaded on
 * demand (progressive disclosure) when the model calls `use_skill`.
 */
export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  dir: string;
  /** Load the full SKILL.md body (everything after frontmatter). */
  load(): Promise<string>;
}

export class SkillRegistry {
  #skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.#skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.#skills.get(name);
  }

  list(): Skill[] {
    return [...this.#skills.values()];
  }

  /** One-line summaries for the system prompt (progressive disclosure). The
   * `whenToUse` trigger guidance (if the author provided it) is included so the
   * model knows when to reach for the skill. */
  descriptions(): string[] {
    return this.list().map((s) =>
      s.whenToUse
        ? `- ${s.name}: ${s.description} (use when: ${s.whenToUse})`
        : `- ${s.name}: ${s.description}`,
    );
  }
}

/** Parse a SKILL.md into frontmatter + body (lightweight YAML subset). */
export function parseSkillMarkdown(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: (match[2] ?? "").trim() };
}
