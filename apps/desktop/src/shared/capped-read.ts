/**
 * Byte-capped text file reads — never load the full file into memory when the
 * caller only needs the first N bytes (diff/file preview).
 */

export interface CappedReadFs {
  open(path: string, flags: string): Promise<{
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
}

export type CappedReadResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Read at most `maxBytes` of UTF-8 text from `path`. Detects binary via NUL in
 * the first chunk. Never allocates more than maxBytes+1 for file content.
 */
export async function readTextFileCapped(
  path: string,
  maxBytes: number,
  fs: CappedReadFs,
): Promise<CappedReadResult> {
  const cap = Math.max(1, Math.trunc(maxBytes));
  let handle: Awaited<ReturnType<CappedReadFs["open"]>> | null = null;
  try {
    handle = await fs.open(path, "r");
    const buf = Buffer.alloc(cap + 1);
    const { bytesRead } = await handle.read(buf, 0, cap + 1, 0);
    const slice = buf.subarray(0, bytesRead);
    if (slice.includes(0)) {
      return { ok: false, error: "Binary file — reveal in Finder instead" };
    }
    const truncated = bytesRead > cap;
    const text = slice.subarray(0, Math.min(bytesRead, cap)).toString("utf8");
    return { ok: true, text, truncated };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn’t read file" };
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
  }
}
