import { resolve, extname } from "node:path";

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
    const file = Bun.file(full);
    if (!(await file.exists())) continue; // not a path — leave the literal text
    const ext = extname(token).toLowerCase();
    const mediaType = IMAGE_MEDIA[ext];
    if (mediaType) {
      images.push({ path: token, mediaType, data: new Uint8Array(await file.arrayBuffer()) });
      continue;
    }
    let text = await file.text();
    if (text.length > MAX_TEXT_BYTES) {
      text = `${text.slice(0, MAX_TEXT_BYTES)}\n… (truncated)`;
      notices.push(`${token} truncated to ${MAX_TEXT_BYTES} bytes`);
    }
    blocks.push(`--- ${token} ---\n\`\`\`\n${text}\n\`\`\``);
  }

  const text = blocks.length
    ? `${prompt}\n\nReferenced files:\n\n${blocks.join("\n\n")}`
    : prompt;
  return { text, images, notices };
}
