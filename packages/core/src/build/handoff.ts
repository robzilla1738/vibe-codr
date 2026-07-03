import type { Handoff } from "@vibe/shared";

/**
 * Structured task handoffs: a finishing subagent ends its report with a fenced
 * ```handoff block whose fields propagate VERBATIM to dependent tasks (the
 * full prose report is pull-only via read_report). Parsing is tolerant by
 * design — a child that omits the block degrades to legacy prose-excerpt
 * behavior, never an error.
 *
 * Wire format (inside the fence):
 *   key_facts:
 *   - fact one
 *   - fact two
 *   files_touched:
 *   - src/a.ts
 *   open_questions:
 *   - anything unresolved
 */

/** The instruction block appended to task kickoffs. */
export const HANDOFF_INSTRUCTION = `End your final report with a fenced handoff block for the tasks that depend on yours — the ONLY part of your report they see by default:
\`\`\`handoff
key_facts:
- the 2-6 load-bearing facts/decisions a dependent task must know
files_touched:
- every file you created or modified (exact paths)
open_questions:
- anything unresolved a dependent should verify (omit if none)
\`\`\``;

const SECTIONS = ["key_facts", "files_touched", "open_questions"] as const;
type Section = (typeof SECTIONS)[number];

/** Parse the LAST ```handoff fence in `text`. Returns null when absent or
 * empty — callers fall back to prose excerpts. Never throws. */
export function parseHandoff(text: string): Handoff | null {
  const fences = [...(text ?? "").matchAll(/```handoff\s*\n([\s\S]*?)```/g)];
  const body = fences.at(-1)?.[1];
  if (!body) return null;
  const out: Record<Section, string[]> = { key_facts: [], files_touched: [], open_questions: [] };
  let current: Section | null = null;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const header = /^(\w+)\s*:\s*$/.exec(line)?.[1] as Section | undefined;
    if (header && SECTIONS.includes(header)) {
      current = header;
      continue;
    }
    // Inline form: `key_facts: one fact` on a single line.
    const inline = /^(\w+)\s*:\s*(.+)$/.exec(line);
    if (inline && SECTIONS.includes(inline[1] as Section)) {
      out[inline[1] as Section].push(inline[2]!.trim());
      current = inline[1] as Section;
      continue;
    }
    if (!current) continue;
    const item = line.replace(/^[-*]\s+/, "").trim();
    if (item) out[current].push(item.slice(0, 500));
  }
  const handoff: Handoff = {
    keyFacts: out.key_facts.slice(0, 12),
    filesTouched: out.files_touched.slice(0, 50),
    openQuestions: out.open_questions.slice(0, 12),
  };
  return handoff.keyFacts.length || handoff.filesTouched.length || handoff.openQuestions.length
    ? handoff
    : null;
}

/** Render a dependency's handoff for a dependent task's kickoff — compact,
 * fields verbatim, with the read_report pointer for the full text. */
export function formatHandoffForKickoff(taskId: string, handoff: Handoff): string {
  const lines: string[] = [`[${taskId}] handoff:`];
  if (handoff.keyFacts.length) {
    lines.push("  key facts:");
    for (const f of handoff.keyFacts) lines.push(`  - ${f}`);
  }
  if (handoff.filesTouched.length) lines.push(`  files touched: ${handoff.filesTouched.join(", ")}`);
  if (handoff.openQuestions.length) {
    lines.push("  open questions:");
    for (const q of handoff.openQuestions) lines.push(`  - ${q}`);
  }
  lines.push(`  (full report: read_report("${taskId}"))`);
  return lines.join("\n");
}

/** Strip the handoff fence from a report for display/prose contexts where the
 * structured block would be noise (the UI shows it separately). */
export function stripHandoffFence(text: string): string {
  const t = text ?? "";
  // Anchor to the LAST ```handoff, not a global `$`-anchored lazy scan: with N
  // ```handoff markers and no closing fence, `[\s\S]*?```\s*$` retries to EOF at
  // every marker → O(n²) (a large/garbled report froze this ~4.9s at 344KB). A
  // trailing fence is the last marker, so match from there with ONE `^`-anchored
  // attempt.
  const idx = t.lastIndexOf("```handoff");
  if (idx === -1) return t.trimEnd();
  const tail = t.slice(idx);
  return /^```handoff\s*\n[\s\S]*```\s*$/.test(tail) ? t.slice(0, idx).trimEnd() : t.trimEnd();
}
