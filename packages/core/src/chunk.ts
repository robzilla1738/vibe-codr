import { createHash } from "node:crypto";

/** One indexable unit of a markdown memory file. */
export interface Chunk {
  /** Content-addressed id (`<source>::<hash>`) — stable across edits to OTHER
   * chunks, so re-indexing only re-embeds what actually changed. */
  id: string;
  /** Logical source (file path / label) the chunk came from. */
  source: string;
  /** SHA-256 of the chunk text (hex) — the change-detection key. */
  hash: string;
  /** The nearest enclosing heading, for display/snippet context. */
  heading: string;
  /** The chunk text (a heading section, or a size-bounded slice of one). */
  text: string;
}

/** Soft cap on chunk size; large sections are split on paragraph boundaries so a
 * single embedding stays focused and within typical embedder input limits. */
const MAX_CHUNK_CHARS = 2_000;

/** SHA-256 hex digest of `text`. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Split `text` into pieces ≤ maxChars, preferring blank-line (paragraph)
 * boundaries; a single oversized paragraph is hard-split by length. */
function splitToSize(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > maxChars) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      for (let i = 0; i < para.length; i += maxChars) out.push(para.slice(i, i + maxChars));
      continue;
    }
    if (buf && buf.length + para.length + 2 > maxChars) {
      out.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * Chunk a markdown document by ATX heading, splitting any oversized section.
 * Each chunk's id is content-addressed (`source::sha256(text)`), so re-chunking
 * a file after an edit yields the same ids for unchanged sections and new ids
 * only for what changed — the basis for idempotent, minimal re-embedding.
 * Identical text within a source collapses to one chunk (same hash → same id).
 */
export function chunkMarkdown(source: string, markdown: string): Chunk[] {
  const lines = markdown.split("\n");
  const sections: { heading: string; body: string[] }[] = [];
  let current: { heading: string; body: string[] } = { heading: "", body: [] };
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (current.heading || current.body.some((l) => l.trim())) sections.push(current);
      current = { heading: line.replace(/^#{1,6}\s+/, "").trim(), body: [line] };
    } else {
      current.body.push(line);
    }
  }
  if (current.heading || current.body.some((l) => l.trim())) sections.push(current);

  const chunks: Chunk[] = [];
  const seen = new Set<string>();
  for (const sec of sections) {
    const sectionText = sec.body.join("\n").trim();
    if (!sectionText) continue;
    for (const piece of splitToSize(sectionText, MAX_CHUNK_CHARS)) {
      const text = piece.trim();
      if (!text) continue;
      const hash = sha256(text);
      const id = `${source}::${hash}`;
      if (seen.has(id)) continue; // dedup identical chunks within the file
      seen.add(id);
      chunks.push({ id, source, hash, heading: sec.heading, text });
    }
  }
  return chunks;
}
