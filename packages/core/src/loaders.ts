import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseSkillMarkdown, type SlashCommand, type Skill } from "@vibe/plugins";
import { vibeConfigDir } from "./memory.ts";

/** Char cap on a loaded command/skill body. Same head-cap discipline as
 * `use_skill`'s MAX_SKILL_BODY: both bodies land in the prompt verbatim (a
 * command body via handlePrompt, a skill body via use_skill / /skill), so a
 * runaway multi-MB file must not blow the context window — the model gets the
 * head plus a pointer to the full file. */
export const MAX_BODY_CHARS = 32 * 1024;

/** Lazily (re-)read a command/skill markdown body at invocation time, capped.
 * Only name/description are held from startup — the body is NOT retained, so a
 * huge file bloats neither memory nor context, and an edit to the file between
 * load and invocation is picked up live. */
function readBody(file: string): string {
  const body = parseSkillMarkdown(readFileSync(file, "utf8")).body;
  return body.length > MAX_BODY_CHARS
    ? `${body.slice(0, MAX_BODY_CHARS)}\n\n…(body truncated at ${MAX_BODY_CHARS} chars — read the full file at ${file} for the rest)`
    : body;
}

/** User-global skills directory (`~/.config/vibe-codr/skills`). */
export function globalSkillsDir(): string {
  return join(vibeConfigDir(), "skills");
}

/** User-global commands directory (`~/.config/vibe-codr/commands`). */
export function globalCommandsDir(): string {
  return join(vibeConfigDir(), "commands");
}

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

/** Load custom slash commands from a `commands/*.md` directory. */
export async function loadCommandsFrom(dir: string): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];
  const glob = new Glob("*.md");
  try {
    for await (const file of glob.scan({ cwd: dir, absolute: true })) {
      // Guard EACH file: one unreadable file (permission error, a name that
      // resolves to a directory) must not abort the whole scan and silently drop
      // every command discovered after it.
      try {
        // Startup reads the file for frontmatter (name/description) only; the
        // body is deliberately not captured — `run` re-reads it lazily via
        // `readBody`, so a giant command file costs nothing until invoked.
        const raw = await Bun.file(file).text();
        const { frontmatter } = parseSkillMarkdown(raw);
        // `||`, not `??`: a bare `name:`/`description:` line parses to "" and
        // must fall back the same as an absent field (a ""-named command is
        // uninvocable).
        const name = frontmatter.name?.trim() || basename(file, ".md");
        commands.push({
          name,
          description: frontmatter.description?.trim() || `Custom command /${name}`,
          source: "file",
          run: (args) => {
            try {
              return { kind: "prompt", text: applyArgs(readBody(file), args) };
            } catch (err) {
              // The file vanished/broke between startup and invocation — report
              // it instead of throwing into the slash dispatcher.
              return {
                kind: "notice",
                message: `/${name}: could not read ${file}: ${(err as Error).message}`,
              };
            }
          },
        });
      } catch {
        // Skip this one file; keep scanning the rest.
      }
    }
  } catch {
    // No commands directory — fine.
  }
  return commands;
}

/**
 * Load custom slash commands from the project's `.vibe/commands/*.md`. Each file
 * becomes a `/name` command whose body (with arg substitution) is a prompt.
 */
export function loadCommandFiles(cwd: string): Promise<SlashCommand[]> {
  return loadCommandsFrom(`${cwd}/.vibe/commands`);
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
      // Guard EACH skill file so one unreadable SKILL.md doesn't drop the rest.
      try {
        // Frontmatter only at startup — the body is re-read lazily in `load()`
        // (true progressive disclosure: previously the full body string was
        // captured in the closure despite the on-demand `load` shape).
        const raw = await Bun.file(file).text();
        const { frontmatter } = parseSkillMarkdown(raw);
        const dir = dirname(file);
        // `||`, not `??`: a bare `name:` frontmatter line parses to "" — the
        // skill would register unreachable (no `/skill ""`) and inject a blank
        // `- : …` line into the system prompt's skills block.
        const name = frontmatter.name?.trim() || basename(dir);
        skills.push({
          name,
          description: frontmatter.description?.trim() || name,
          ...(frontmatter.when_to_use
            ? { whenToUse: frontmatter.when_to_use }
            : {}),
          dir,
          load: async () => {
            try {
              return readBody(file);
            } catch (err) {
              // Never throw into use_skill / /skill: an honest placeholder
              // beats a failed tool call for a file deleted mid-session.
              return `(SKILL.md body unavailable — ${file} could not be read: ${(err as Error).message})`;
            }
          },
        });
      } catch {
        // Skip this one skill; keep scanning the rest.
      }
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
