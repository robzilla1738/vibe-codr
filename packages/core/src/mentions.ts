import { resolve, extname } from "node:path";
import { readdir, stat } from "node:fs/promises";

/** Image extensions that become multimodal attachments rather than text. */
const IMAGE_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Cap injected text per file so a stray `@huge.log` can't blow the context. */
const MAX_TEXT_BYTES = 64_000;
/** Cap an `@image` attachment so a huge file can't bloat the prompt / cost. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Max entries listed for an `@dir/` mention. */
const MAX_DIR_ENTRIES = 200;

/** Truncate `text` to at most `maxBytes` UTF-8 bytes (not UTF-16 code units). */
function capBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const kept = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, maxBytes))
    .replace(/�+$/, "");
  return { text: kept, truncated: true };
}

export interface ImageAttachment {
  path: string;
  mediaType: string;
  data: Uint8Array;
}

export interface ExpandedPrompt {
  /** Original prompt with referenced text-file contents appended. */
  text: string;
  /** Image files referenced by `@path`, for multimodal models. */
  images: ImageAttachment[];
  /** Human-readable notes (e.g. a file was truncated or not found). */
  notices: string[];
}

/** Extract `@path` mention tokens (after start/whitespace), trimming trailing punctuation. */
export function parseMentions(prompt: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\s)@([^\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const token = (m[1] as string).replace(/[.,;:)\]}'"]+$/, "");
    if (token) out.push(token);
  }
  return out;
}

/**
 * Expand `@file` mentions in a prompt: text files are read and appended as
 * fenced context blocks; image files become attachments for vision models.
 * Unresolvable mentions are left untouched (and noted). Pure I/O — no events.
 */
export async function expandMentions(prompt: string, cwd: string): Promise<ExpandedPrompt> {
  const tokens = [...new Set(parseMentions(prompt))];
  const blocks: string[] = [];
  const images: ImageAttachment[] = [];
  const notices: string[] = [];

  for (const token of tokens) {
    const full = resolve(cwd, token);
    // A directory mention (@src/ or @src) expands to a capped listing.
    const info = await stat(full).catch(() => null);
    if (info?.isDirectory()) {
      const entries = (await readdir(full).catch(() => []))
        .sort()
        .slice(0, MAX_DIR_ENTRIES);
      if (entries.length) {
        blocks.push(`--- ${token}/ (directory) ---\n${entries.join("\n")}`);
      }
      continue;
    }
    const file = Bun.file(full);
    if (!(await file.exists())) continue; // not a path — leave the literal text
    const size = info?.size ?? 0; // byte size from the stat above
    const ext = extname(token).toLowerCase();
    const mediaType = IMAGE_MEDIA[ext];
    if (mediaType) {
      // Check the size BEFORE reading, so a huge image isn't slurped into memory
      // just to be rejected (a partial image is useless, so oversize → skip).
      if (size > MAX_IMAGE_BYTES) {
        notices.push(
          `${token} skipped: image is ${(size / 1024 / 1024).toFixed(1)}MB (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
        );
        continue;
      }
      images.push({ path: token, mediaType, data: new Uint8Array(await file.arrayBuffer()) });
      continue;
    }
    // Bound the READ to the byte budget, not just the output: read only the first
    // MAX_TEXT_BYTES of an over-cap file instead of slurping a multi-hundred-MB
    // `@huge.log` into memory and only then truncating.
    let raw: string;
    let preTruncated = false;
    if (size > MAX_TEXT_BYTES) {
      const buf = await file.slice(0, MAX_TEXT_BYTES).arrayBuffer();
      raw = new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf)).replace(/�+$/, "");
      preTruncated = true;
    } else {
      raw = await file.text();
    }
    // A non-image binary file (PDF/wasm/mp4/zip/…) would otherwise be UTF-8
    // decoded into up to 64KB of mojibake and injected as "text" — wasted tokens
    // and polluted context. A NUL byte is the reliable binary tell; skip + notice.
    if (raw.includes("\0")) {
      notices.push(`${token} skipped: looks binary (not injected as text)`);
      continue;
    }
    // Truncate by ENCODED BYTES (not String.slice's UTF-16 units) so a CJK/emoji
    // file actually honors the byte budget it claims to enforce.
    const { text: capped, truncated } = capBytes(raw, MAX_TEXT_BYTES);
    const wasTruncated = truncated || preTruncated;
    const text = wasTruncated ? `${capped}\n… (truncated)` : capped;
    if (wasTruncated) notices.push(`${token} truncated to ${MAX_TEXT_BYTES} bytes`);
    blocks.push(`--- ${token} ---\n\`\`\`\n${text}\n\`\`\``);
  }

  const text = blocks.length
    ? `${prompt}\n\nReferenced files:\n\n${blocks.join("\n\n")}`
    : prompt;
  return { text, images, notices };
}
