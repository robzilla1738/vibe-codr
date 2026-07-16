/**
 * Cap captured stdout/stderr so a huge subprocess dump cannot pin the main process.
 * Shared by git and gh spawn helpers.
 */

export const DEFAULT_CAPTURE_MAX_BYTES = 8 * 1024 * 1024;

export interface CaptureBuffers {
  stdout: string;
  stderr: string;
  truncated: boolean;
  maxBytes: number;
  capturedBytes: number;
}

export function createCaptureBuffers(maxBytes = DEFAULT_CAPTURE_MAX_BYTES): CaptureBuffers {
  return {
    stdout: "",
    stderr: "",
    truncated: false,
    maxBytes: Math.max(0, Math.trunc(maxBytes)),
    capturedBytes: 0,
  };
}

/** Return the longest prefix whose UTF-8 encoding fits within `maxBytes`. */
function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  // Do not retain half of a UTF-16 surrogate pair at the boundary.
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!)) low -= 1;
  return text.slice(0, low);
}

/** Append a chunk under one aggregate stdout+stderr UTF-8 byte ceiling. */
export function appendCapture(
  buf: CaptureBuffers,
  target: "stdout" | "stderr",
  chunk: Buffer | string,
): void {
  if (buf.truncated) return;
  const text = typeof chunk === "string" ? chunk : chunk.toString();
  const chunkBytes = Buffer.byteLength(text, "utf8");
  const remaining = Math.max(0, buf.maxBytes - buf.capturedBytes);
  if (chunkBytes > remaining) {
    const prefix = utf8Prefix(text, remaining);
    buf[target] += prefix;
    buf.capturedBytes += Buffer.byteLength(prefix, "utf8");
    buf.truncated = true;
    return;
  }
  buf[target] += text;
  buf.capturedBytes += chunkBytes;
}

export function captureOverflowError(buf: CaptureBuffers, label = "output"): string {
  return buf.stderr || `${label} exceeded ${buf.maxBytes} bytes`;
}

const ROLLING_OMISSION = "… earlier content omitted …\n";

/** Keep the newest text under a hard character budget with one stable marker. */
export function appendRollingText(current: string, chunk: string, maxChars: number): string {
  if (maxChars <= ROLLING_OMISSION.length) {
    return (current + chunk).slice(-Math.max(0, maxChars));
  }
  const wasOmitted = current.startsWith(ROLLING_OMISSION);
  const prior = wasOmitted
    ? current.slice(ROLLING_OMISSION.length)
    : current;
  const next = prior + chunk;
  if (!wasOmitted && next.length <= maxChars) return next;
  return ROLLING_OMISSION + next.slice(-(maxChars - ROLLING_OMISSION.length));
}
