import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

export const ACP_STDIO_LIMITS = Object.freeze({
  frameBytes: 1024 * 1024,
  pendingRequests: 64,
  shutdownMs: 5_000,
} as const);

/** NDJSON transport with hard per-frame bounds in both directions. */
export function boundedNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  maxFrameBytes = ACP_STDIO_LIMITS.frameBytes,
): Stream {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
    throw new Error("maxFrameBytes must be a positive safe integer");
  }
  const encoder = new TextEncoder();
  const outputWriter = output.getWriter();
  const writable = new WritableStream<AnyMessage>({
    async write(message) {
      const encoded = encoder.encode(`${JSON.stringify(message)}\n`);
      if (encoded.byteLength - 1 > maxFrameBytes) throw new Error("ACP output frame exceeds limit");
      await outputWriter.write(encoded);
    },
    async close() {
      await outputWriter.close();
    },
    async abort(reason) {
      await outputWriter.abort(reason);
    },
  });

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      const reader = input.getReader();
      let buffered = new Uint8Array(0);
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          const joined = new Uint8Array(buffered.byteLength + value.byteLength);
          joined.set(buffered);
          joined.set(value, buffered.byteLength);
          buffered = joined;
          while (true) {
            const newline = buffered.indexOf(10);
            if (newline < 0) break;
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (line.byteLength > maxFrameBytes) throw new Error("ACP input frame exceeds limit");
            if (line.byteLength === 0) continue;
            controller.enqueue(parseMessage(line));
          }
          if (buffered.byteLength > maxFrameBytes) throw new Error("ACP input frame exceeds limit");
        }
        if (buffered.byteLength > 0) controller.enqueue(parseMessage(buffered));
        controller.close();
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => undefined);
      } finally {
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      await input.cancel(reason).catch(() => undefined);
    },
  });
  return { readable, writable };
}

function parseMessage(bytes: Uint8Array): AnyMessage {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("invalid ACP NDJSON frame");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("ACP frame must be a JSON object");
  }
  return value as AnyMessage;
}
