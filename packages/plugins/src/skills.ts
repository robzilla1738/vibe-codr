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

/** Char cap for one skill's prompt-resident summary line (see descriptions()). */
const MAX_PROMPT_LINE = 500;

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
    return this.list().map((s) => {
      const line = s.whenToUse
        ? `- ${s.name}: ${s.description} (use when: ${s.whenToUse})`
        : `- ${s.name}: ${s.description}`;
      // These lines ride the always-on system-prompt prefix EVERY turn, so each
      // is capped (the body has its own use_skill cap): a folded multi-line
      // description must not permanently inflate every request. Sliced by code
      // point so the cut can't strand half a surrogate pair.
      return line.length > MAX_PROMPT_LINE
        ? `${[...line].slice(0, MAX_PROMPT_LINE - 1).join("")}…`
        : line;
    });
  }
}

/** Parse a SKILL.md into frontmatter + body (lightweight YAML subset). */
export function parseSkillMarkdown(rawInput: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  // Strip a leading UTF-8 BOM (Notepad and some editors prepend one) and
  // normalize CRLF/CR so a Windows- or editor-authored SKILL.md, agent, or
  // command file still has its `---` frontmatter recognized (the fence match is
  // LF-anchored and `^`-anchored). Without this, such files silently lose all
  // frontmatter — the name falls back to the dir/file name and the raw `---`
  // block leaks into the body/prompt.
  const raw = rawInput.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match && raw.startsWith("---\n")) {
    throw new Error("Unclosed frontmatter fence: expected closing --- line");
  }
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  const lines = (match[1] ?? "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Only a top-level `key:` starts an entry — indented lines belong to a
    // block scalar (consumed below) or a nested structure we don't model.
    if (/^\s/.test(line)) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    const inline = line.slice(idx + 1).trim();
    // YAML block scalar (`|` literal / `>` folded, with optional chomping and
    // indentation indicators in either order — `>-`, `|2`, `>2-`, `>-2`):
    // real-world skills routinely write `description: >-` with the text on the
    // following indented lines. The old parser stored the literal ">-"/"|"
    // marker as the value — the "garbage description" bug in /skills listings.
    const scalar = /^([|>])(?:[1-9][+-]?|[+-][1-9]?)?$/.exec(inline);
    if (scalar) {
      const block: string[] = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1] ?? "") || (lines[i + 1] ?? "") === "")) {
        block.push((lines[++i] ?? "").trim());
      }
      // Trim trailing blank lines; join folded (`>`) with spaces, literal
      // (`|`) with newlines. Interior blank lines fold to a newline either way.
      while (block.length && block[block.length - 1] === "") block.pop();
      frontmatter[key] =
        scalar[1] === ">"
          ? block
              .map((l) => (l === "" ? "\n" : l))
              .join(" ")
              .replace(/\s*\n\s*/g, "\n")
              .trim()
          : block.join("\n").trim();
      continue;
    }
    frontmatter[key] = inline.replace(/^["']|["']$/g, "");
  }
  return { frontmatter, body: (match[2] ?? "").trim() };
}
