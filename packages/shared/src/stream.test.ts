import { test, expect } from "bun:test";
import {
  CappedText,
  capText,
  drainTextStream,
  omittedMarker,
  readCappedBytes,
  readCappedText,
} from "./stream.ts";

const enc = new TextEncoder();

/** A stream that emits the given chunks then closes. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

/** A stream that yields `chunk` on every pull and never ends, recording cancel. */
function endlessStream(chunk: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk.slice());
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

test("CappedText head-only keeps the first `cap` chars", () => {
  const b = new CappedText({ cap: 5 });
  b.push("abc");
  b.push("defgh");
  expect(b.truncated).toBe(true);
  expect(b.toString()).toBe("abcde");
});

test("CappedText not truncated returns the full text (head + tail joined in order)", () => {
  const b = new CappedText({ cap: 100, keep: "head+tail" });
  b.push("hello ");
  b.push("world");
  expect(b.truncated).toBe(false);
  expect(b.toString()).toBe("hello world");
});

test("CappedText head+tail keeps both ends with an accurate omitted count", () => {
  const b = new CappedText({ cap: 10, headRatio: 0.4, keep: "head+tail", marker: omittedMarker });
  b.push("0123456789ABCDEF"); // 16 chars, cap 10 → head 4 + tail 6, 6 omitted
  expect(b.toString()).toBe(`0123${omittedMarker(6)}ABCDEF`);
});

test("CappedText tail keeps only the last `cap` chars", () => {
  const b = new CappedText({ cap: 4, keep: "tail" });
  b.push("0123456789");
  expect(b.toString()).toBe("6789");
});

test("capText leaves a short string untouched and truncates a long one head+tail", () => {
  expect(capText("short", { cap: 100, keep: "head+tail", marker: omittedMarker })).toBe("short");
  const out = capText("A".repeat(20) + "Z".repeat(20), {
    cap: 10,
    headRatio: 0.5,
    keep: "head+tail",
    marker: omittedMarker,
  });
  expect(out.startsWith("AAAAA")).toBe(true);
  expect(out.endsWith("ZZZZZ")).toBe(true);
  expect(out).toContain("chars omitted");
});

test("readCappedText head+tail drains a stream and preserves the true tail", async () => {
  const chunks = Array.from({ length: 50 }, (_, i) => enc.encode(`line${i}\n`));
  const { text, truncated } = await readCappedText(streamOf(...chunks), {
    cap: 40,
    keep: "head+tail",
    marker: omittedMarker,
  });
  expect(truncated).toBe(true);
  expect(text).toContain("line0"); // head kept
  expect(text).toContain("line49"); // tail kept — this is the point of head+tail
  expect(text).toContain("chars omitted");
});

test("readCappedText head-only stops early and cancels the reader (SIGPIPEs the writer)", async () => {
  const { stream, cancelled } = endlessStream(enc.encode("aaaa"));
  const { text, truncated } = await readCappedText(stream, { cap: 10 });
  expect(text).toBe("aaaaaaaaaa"); // exactly the cap
  expect(truncated).toBe(true);
  expect(cancelled()).toBe(true); // the endless producer was cut off, not drained
});

test("readCappedText cancels promptly when the signal is already aborted", async () => {
  const { stream, cancelled } = endlessStream(enc.encode("x"));
  const { text } = await readCappedText(stream, { cap: 1_000, signal: AbortSignal.abort() });
  expect(text).toBe("");
  expect(cancelled()).toBe(true);
});

test("drainTextStream forwards every chunk and is UTF-8 boundary-safe", async () => {
  // "🚀" is 4 bytes; split it across two chunks — a per-chunk decoder would
  // corrupt it into replacement chars, the streaming decoder must not.
  const rocket = enc.encode("🚀"); // 4 bytes
  const received: string[] = [];
  await drainTextStream(
    streamOf(enc.encode("hi "), rocket.subarray(0, 2), rocket.subarray(2)),
    (t) => received.push(t),
  );
  expect(received.join("")).toBe("hi 🚀");
  expect(received.join("")).not.toContain("�");
});

test("readCappedBytes caps at the byte ceiling and flags truncation", async () => {
  const { bytes, truncated } = await readCappedBytes(
    streamOf(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6]), new Uint8Array([7, 8, 9])),
    4,
  );
  expect([...bytes]).toEqual([1, 2, 3, 4]);
  expect(truncated).toBe(true);
});

test("readCappedBytes returns the whole body untruncated when it fits", async () => {
  const { bytes, truncated } = await readCappedBytes(
    streamOf(new Uint8Array([1, 2]), new Uint8Array([3])),
    100,
  );
  expect([...bytes]).toEqual([1, 2, 3]);
  expect(truncated).toBe(false);
});

test("makeYieldGate fires each time the accumulated budget crosses the threshold", async () => {
  const { makeYieldGate } = await import("./stream.ts");
  const gate = makeYieldGate(100);
  expect(gate(50)).toBe(false);
  expect(gate(49)).toBe(false);
  expect(gate(1)).toBe(true); // 100 reached — fire and reset
  expect(gate(99)).toBe(false);
  expect(gate(200)).toBe(true); // a single huge chunk still fires once
  expect(gate(1)).toBe(false); // …and the budget restarted from zero
});
