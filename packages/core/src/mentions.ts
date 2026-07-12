import { resolve, extname } from "node:path";
import { homedir } from "node:os";
import { readdir } from "node:fs/promises";
import { statResolve } from "@vibe/tools";

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
/**
 * Cap bare (non-@) image paths auto-attached from the prompt. Users often paste
 * absolute screenshot paths without `@`; attaching a handful is enough for a
 * visual rebuild and avoids slurping a long dump of image paths.
 */
const MAX_BARE_IMAGES = 4;

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

/** Shell `\ ` → space; other `\.` escapes drop the backslash. */
function unescapeShellPath(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

/** Expand `~` / `~/…` against the real home directory. */
function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
}

/**
 * Extract bare (non-@) image paths from a prompt. Users paste absolute screenshot
 * paths without the `@` prefix; without this, vision never receives the bytes
 * and the model invents content from memory.
 *
 * Handles shell-escaped spaces (`Screenshot\ 2026…png`), quoted paths, absolute
 * `/…` and `~/…` paths, and relative paths that exist under `cwd`. Walks left
 * from each image extension so multi-word macOS screenshot names are kept whole.
 */
export function parseBareImagePaths(prompt: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\.(png|jpe?g|gif|webp)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const end = m.index + m[0].length;
    // Skip if this extension sits inside an @mention token (handled separately).
    let at = m.index - 1;
    while (at >= 0 && !/\s/.test(prompt[at]!)) {
      if (prompt[at] === "@") break;
      at--;
    }
    if (at >= 0 && prompt[at] === "@") continue;

    let i = m.index - 1;
    while (i >= 0) {
      const ch = prompt[i]!;
      if (ch === "\n" || ch === "\r" || ch === '"' || ch === "'" || ch === "`") break;
      if (ch === "@") break;
      if (ch === " " || ch === "\t") {
        // Shell-escaped space (`\ `) is part of the path.
        if (i > 0 && prompt[i - 1] === "\\") {
          i -= 2;
          continue;
        }
        // Unescaped space: allow only inside the FINAL path segment (filename),
        // e.g. macOS "Screenshot 2026-… PM.png". If `soFar` already contains
        // `/` or `\`, the space is a separator between two paths
        // (`/a/ref-a.png /b/ref-b.png`) — stop so we don't glue them.
        const soFar = prompt.slice(i + 1, end);
        if (!/[/\\]/.test(soFar)) {
          i--;
          continue;
        }
        break;
      }
      // Path-ish characters (incl. backslash for escapes / Windows drives).
      if (/[a-zA-Z0-9_./~:+%,@()[\]-]/.test(ch) || ch === "\\") {
        i--;
        continue;
      }
      break;
    }
    let raw = prompt
      .slice(i + 1, end)
      .replace(/^[("'[`]+/, "")
      .replace(/[)"'\]]+$/, "");
    raw = unescapeShellPath(raw).trim();
    if (!raw || seen.has(raw)) continue;
    // Require a real path signal: absolute, home, relative with slash, or a
    // plain filename with an image ext (resolved against cwd later).
    const looksPath =
      raw.startsWith("/") ||
      raw.startsWith("~/") ||
      raw.startsWith("./") ||
      raw.startsWith("../") ||
      /^[A-Za-z]:[\\/]/.test(raw) ||
      raw.includes("/") ||
      Boolean(IMAGE_MEDIA[extname(raw).toLowerCase()]);
    if (!looksPath) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Read an image file into an attachment, or return a skip notice. */
async function readImageAttachment(
  token: string,
  full: string,
  size: number,
): Promise<{ image?: ImageAttachment; notice?: string }> {
  const ext = extname(token).toLowerCase() || extname(full).toLowerCase();
  const mediaType = IMAGE_MEDIA[ext];
  if (!mediaType) return {};
  if (size > MAX_IMAGE_BYTES) {
    return {
      notice: `${token} skipped: image is ${(size / 1024 / 1024).toFixed(1)}MB (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB)`,
    };
  }
  const file = Bun.file(full);
  // Bound the actual read too (not just the stat check above): read one byte
  // past the cap and reject if the file grew past it since the stat (TOCTOU) —
  // a partial image is useless, so oversize skips rather than truncates.
  const buf = await file.slice(0, MAX_IMAGE_BYTES + 1).arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return {
      notice: `${token} skipped: image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024}MB`,
    };
  }
  return { image: { path: token, mediaType, data: new Uint8Array(buf) } };
}

/**
 * Expand `@file` mentions in a prompt: text files are read and appended as
 * fenced context blocks; image files become attachments for vision models.
 * Bare (non-@) image paths that exist on disk are also attached — users paste
 * absolute screenshot paths without `@`, and without this vision never fires.
 * Unresolvable mentions are left untouched (and noted). Pure I/O — no events.
 */
export async function expandMentions(prompt: string, cwd: string): Promise<ExpandedPrompt> {
  const tokens = [...new Set(parseMentions(prompt))];
  const blocks: string[] = [];
  const images: ImageAttachment[] = [];
  const notices: string[] = [];
  /** Canonical absolute paths already attached, so bare-path scan won't double. */
  const attachedAbs = new Set<string>();

  for (const token of tokens) {
    const full = resolve(cwd, expandHome(token));
    // statResolve tries stat() directly, then falls back to Unicode-space
    // matching (macOS screenshots use U+202F before AM/PM). Returns the actual
    // on-disk path, which may differ from `full` when the fallback fired.
    const resolved = await statResolve(full);
    if (!resolved) continue; // not a path — leave the literal text
    const { info, actualPath: actual } = resolved;
    // A directory mention (@src/ or @src) expands to a capped listing.
    if (info.isDirectory()) {
      const entries = (await readdir(actual).catch(() => [])).sort().slice(0, MAX_DIR_ENTRIES);
      if (entries.length) {
        blocks.push(`--- ${token}/ (directory) ---\n${entries.join("\n")}`);
      }
      continue;
    }
    const file = Bun.file(actual);
    const size = info.size; // byte size from stat
    const ext = extname(token).toLowerCase();
    const mediaType = IMAGE_MEDIA[ext];
    if (mediaType) {
      // Check the size BEFORE reading, so a huge image isn't slurped into memory
      // just to be rejected (a partial image is useless, so oversize → skip).
      const got = await readImageAttachment(token, actual, size);
      if (got.notice) notices.push(got.notice);
      if (got.image) {
        images.push(got.image);
        attachedAbs.add(actual);
      }
      continue;
    }
    // Bound the READ to the byte budget, not just the output, and do it off the
    // ACTUAL bytes rather than the stat `size` — a file that grew between the
    // stat above and this read must still not be slurped whole (TOCTOU). Read
    // one extra byte to detect that there was more.
    const buf = await file.slice(0, MAX_TEXT_BYTES + 1).arrayBuffer();
    const readBytes = new Uint8Array(buf);
    const preTruncated = readBytes.length > MAX_TEXT_BYTES;
    const kept = preTruncated ? readBytes.subarray(0, MAX_TEXT_BYTES) : readBytes;
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(kept).replace(/�+$/, "");
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

  // Bare image paths (no `@`): attach existing files so "looks like these images"
  // with pasted absolute paths still reaches vision models.
  let bareAttached = 0;
  for (const token of parseBareImagePaths(prompt)) {
    if (bareAttached >= MAX_BARE_IMAGES) break;
    const full = resolve(cwd, expandHome(token));
    // statResolve handles Unicode-space fallback (macOS screenshot U+202F).
    const resolved = await statResolve(full);
    if (!resolved) continue;
    const { info, actualPath: actual } = resolved;
    if (attachedAbs.has(actual)) continue;
    if (!info.isFile()) continue;
    const got = await readImageAttachment(token, actual, info.size);
    if (got.notice) notices.push(got.notice);
    if (got.image) {
      images.push(got.image);
      attachedAbs.add(actual);
      bareAttached++;
    }
  }
  if (bareAttached > 0) {
    notices.push(
      `Attached ${bareAttached} image${bareAttached === 1 ? "" : "s"} from path${bareAttached === 1 ? "" : "s"} in the prompt.`,
    );
  }

  const text = blocks.length ? `${prompt}\n\nReferenced files:\n\n${blocks.join("\n\n")}` : prompt;
  return { text, images, notices };
}
