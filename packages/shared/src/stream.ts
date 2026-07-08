/**
 * Stream reading + truncation primitives, shared by every tool that captures a
 * child process's or HTTP response's output. Before this, six call sites
 * (`verify`, `bash`, `git`, `jobs`, `webfetch`, config hooks) each hand-rolled
 * the same "read a ReadableStream up to a cap, streaming-decode UTF-8, then
 * cancel the reader" loop — a subtle pattern (boundary-safe decode, cancel in
 * `finally`, never throw on cancel) that's easy to get wrong per-copy.
 *
 * @vibe/shared is the bottom layer, so this file has no dependencies. Everything
 * here works on the WHATWG `ReadableStream` / `TextDecoder` globals.
 */

/** Which end of an over-cap stream to retain. */
export type KeepPolicy = "head" | "tail" | "head+tail";

export interface CapOptions {
  /** Maximum characters to retain. */
  cap: number;
  /**
   * Which end to keep once `cap` is exceeded (default "head"):
   * - "head": the first `cap` chars (stop reading + cancel as soon as it fills).
   * - "tail": the last `cap` chars (a rolling ring — must drain the whole stream).
   * - "head+tail": the first `headRatio` of `cap` + the last `1 - headRatio`, so
   *   a trailing error line (e.g. a failing build's last message) survives.
   */
  keep?: KeepPolicy;
  /** For keep:"head+tail", the fraction of `cap` kept from the head (default 0.3). */
  headRatio?: number;
  /**
   * Elision marker inserted where content was dropped (receives the omitted char
   * count). For "head+tail" it goes BETWEEN the head and tail. Omit it when the
   * caller formats its own marker (e.g. `verify`) or wants silent truncation.
   */
  marker?: (omitted: number) => string;
}

/** Standard elision marker: its own line, showing how many chars were dropped. */
export function omittedMarker(omitted: number): string {
  return `\n…(${omitted} chars omitted)…\n`;
}

/**
 * A bounded text accumulator: push chunks in, get a capped string out. Keeps a
 * fixed head prefix and/or a rolling tail ring, so memory never grows past the
 * cap no matter how much is pushed. This is the shared engine behind
 * {@link readCappedText}, {@link capText}, and the two-stream capture in `bash`.
 */
export class CappedText {
  readonly #cap: number;
  readonly #headCap: number;
  readonly #tailCap: number;
  readonly #marker?: (omitted: number) => string;
  #head = "";
  #tail = "";
  #total = 0;

  constructor(opts: CapOptions) {
    this.#cap = Math.max(0, opts.cap);
    const keep = opts.keep ?? "head";
    if (keep === "head") {
      this.#headCap = this.#cap;
      this.#tailCap = 0;
    } else if (keep === "tail") {
      this.#headCap = 0;
      this.#tailCap = this.#cap;
    } else {
      // BUG-069: clamp headRatio to (0,1] so headCap never exceeds cap.
      const ratio = Math.min(1, Math.max(0, opts.headRatio ?? 0.3));
      this.#headCap = Math.floor(this.#cap * ratio);
      this.#tailCap = this.#cap - this.#headCap;
    }
    this.#marker = opts.marker;
  }

  push(text: string): void {
    if (!text) return;
    this.#total += text.length;
    let rest = text;
    if (this.#head.length < this.#headCap) {
      const room = this.#headCap - this.#head.length;
      if (rest.length <= room) {
        this.#head += rest;
        return;
      }
      this.#head += rest.slice(0, room);
      rest = rest.slice(room);
    }
    if (this.#tailCap === 0) return; // head-only: the overflow is dropped
    this.#tail += rest;
    if (this.#tail.length > this.#tailCap) this.#tail = this.#tail.slice(-this.#tailCap);
  }

  /** True once the head prefix has filled — a head-only reader can stop here. */
  get headFull(): boolean {
    return this.#head.length >= this.#headCap;
  }

  /** True if more was pushed than the cap can retain. */
  get truncated(): boolean {
    return this.#total > this.#cap;
  }

  toString(): string {
    if (!this.truncated) return this.#head + this.#tail;
    const omitted = this.#total - this.#head.length - this.#tail.length;
    return this.#head + (this.#marker ? this.#marker(omitted) : "") + this.#tail;
  }
}

/** Bytes drained between cooperative macrotask yields (see forEachTextChunk). */
const DRAIN_YIELD_BYTES = 64 * 1024;

/**
 * A cooperative-yield budget: accumulates units (bytes, stream parts) and
 * returns true — resetting — each time the running total crosses `threshold`.
 * Pure, so hot loops can gate an `await setTimeout(0)` on it and tests can
 * assert the cadence without timers.
 */
export function makeYieldGate(threshold: number): (n: number) => boolean {
  let acc = 0;
  return (n: number) => {
    acc += n;
    if (acc < threshold) return false;
    acc = 0;
    return true;
  };
}

/**
 * Iterate a byte stream, streaming-decoding each chunk to text and handing it to
 * `onText`. One `TextDecoder` in streaming mode spans chunk boundaries, so a
 * multibyte UTF-8 char split across reads is never corrupted into `�`. `onText`
 * returning `true` stops early (and cancels — the writer gets SIGPIPE). The
 * reader is ALWAYS cancelled in `finally`; a cancel failure is swallowed. An
 * optional `signal` cancels the in-flight read (used to unblock a read that's
 * wedged on a pipe a lingering child process is holding open).
 */
async function forEachTextChunk(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => boolean | void,
  signal?: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => {});
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  }
  const yieldGate = makeYieldGate(DRAIN_YIELD_BYTES);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const text = decoder.decode(value, { stream: true });
      if (text && onText(text) === true) break;
      // Cooperative yield: a hot pipe (`yes`, `ls -R`) resolves read() from
      // its buffer on the MICROTASK queue, so this loop can spin without ever
      // returning to the macrotask queue — starving stdin (frozen keyboard)
      // in the shared engine+UI process. A setTimeout(0) every ~64 KB lets
      // input and timers run between bursts; chunk order is untouched.
      if (text && yieldGate(text.length)) await new Promise((r) => setTimeout(r, 0));
    }
    const flush = decoder.decode(); // trailing partial bytes, if any
    if (flush) onText(flush);
  } catch {
    // Reader cancelled (e.g. via `signal`) — return whatever was captured.
  } finally {
    if (signal) signal.removeEventListener("abort", cancel);
    cancel();
  }
}

/**
 * Drain a text stream fully, forwarding every decoded chunk to `onChunk` (e.g.
 * to stream progress to the UI or append to a rolling job buffer). Never stops
 * early; cancels the reader in `finally`.
 */
export function drainTextStream(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  return forEachTextChunk(stream, (text) => void onChunk(text), opts.signal);
}

/**
 * Read a stream into a capped string. "head" keep stops + cancels as soon as the
 * cap fills (halting a runaway producer); "tail"/"head+tail" drain the whole
 * stream (bounded in memory by the ring) so the true end is captured.
 */
export async function readCappedText(
  stream: ReadableStream<Uint8Array>,
  opts: CapOptions & { signal?: AbortSignal },
): Promise<{ text: string; truncated: boolean }> {
  const buf = new CappedText(opts);
  const headOnly = (opts.keep ?? "head") === "head";
  await forEachTextChunk(
    stream,
    (text) => {
      buf.push(text);
      return headOnly && buf.headFull;
    },
    opts.signal,
  );
  return { text: buf.toString(), truncated: buf.truncated };
}

/** Apply the same cap policy to an in-memory string (no stream involved). */
export function capText(text: string, opts: CapOptions): string {
  if (text.length <= opts.cap) return text;
  const buf = new CappedText(opts);
  buf.push(text);
  return buf.toString();
}

/**
 * Read a stream into a capped byte buffer (head-only). Stops + cancels the reader
 * the moment `maxBytes` is exceeded, so an unbounded response can't OOM the
 * process. Returns the assembled bytes and whether the body was truncated.
 */
export async function readCappedBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.length > maxBytes) {
        const room = Math.max(0, maxBytes - total);
        if (room) chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return { bytes: buf, truncated };
}
