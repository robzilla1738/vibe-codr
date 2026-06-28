import { ansi } from "./ansi.ts";

/**
 * Render a focused subset of Markdown to ANSI for the terminal: headings,
 * bold/italic, inline code, bullet/numbered lists, and fenced code blocks.
 * Color codes are no-ops when stdout is not a TTY, so piped output stays plain.
 * Intentionally small — not a full CommonMark parser.
 */
export function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      inFence = !inFence;
      // Drop the fence line itself; show a dim rule so the block is legible.
      out.push(ansi.dim("────"));
      continue;
    }
    if (inFence) {
      out.push(ansi.cyan(line));
      continue;
    }

    // Headings -> bold, with the leading #'s removed.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      out.push(ansi.bold(inline(heading[2] as string)));
      continue;
    }

    // Bullet lists -> "• ".
    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}${ansi.dim("•")} ${inline(bullet[2] as string)}`);
      continue;
    }

    out.push(inline(line));
  }
  return out.join("\n");
}

/** Apply inline spans: `**bold**`, `*italic*`, and `` `code` ``. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, (_, c: string) => ansi.cyan(c))
    .replace(/\*\*([^*]+)\*\*/g, (_, c: string) => ansi.bold(c))
    .replace(/__([^_]+)__/g, (_, c: string) => ansi.bold(c))
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_, pre: string, c: string) => `${pre}${ansi.italic(c)}`)
    .replace(/(^|[^_])_([^_\s][^_]*)_/g, (_, pre: string, c: string) => `${pre}${ansi.italic(c)}`);
}
