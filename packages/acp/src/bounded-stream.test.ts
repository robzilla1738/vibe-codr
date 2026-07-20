import { describe, expect, test } from "bun:test";
import { boundedNdJsonStream } from "./bounded-stream.ts";

function byteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("boundedNdJsonStream", () => {
  test("decodes split and multiple frames", async () => {
    const stream = boundedNdJsonStream(new TransformStream().writable, byteStream('{"jsonrpc":"2.0",', '"id":1,"method":"x"}\n{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    const reader = stream.readable.getReader();
    expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 1, method: "x" });
    expect((await reader.read()).value).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("rejects oversized and malformed input", async () => {
    for (const input of ["12345\n", "{nope}\n"]) {
      const stream = boundedNdJsonStream(new TransformStream().writable, byteStream(input), 4);
      await expect(stream.readable.getReader().read()).rejects.toThrow();
    }
  });

  test("rejects oversized output", async () => {
    const sink = new WritableStream<Uint8Array>({ write() {} });
    const stream = boundedNdJsonStream(sink, byteStream(), 8);
    await expect(stream.writable.getWriter().write({ jsonrpc: "2.0", method: "long" } as never)).rejects.toThrow("exceeds limit");
  });
});
