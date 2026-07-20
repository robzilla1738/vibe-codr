import { expect, test } from "bun:test";
import { drainSseFrames, VibeApiError, VibeClient } from "./index.ts";

test("client sends bearer authorization and validates JSON responses", async () => {
  let authorization = "";
  const client = new VibeClient({
    baseUrl: "http://127.0.0.1:4242",
    token: "secret",
    fetch: (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return Response.json({
        apiVersion: 1,
        workspace: "/repo",
        transport: "loopback",
        events: "authenticated-sse",
        capabilities: [],
        commandTypes: [],
      });
    }) as typeof fetch,
  });
  expect((await client.capabilities()).apiVersion).toBe(1);
  expect(authorization).toBe("Bearer secret");
});

test("fetch-based SSE parser supports Authorization and fragmented frames", async () => {
  const frame = { type: "ready", cursor: { epoch: "epoch-1", sequence: 0 }, truncated: false };
  const payload = `event: ready\ndata: ${JSON.stringify(frame)}\n\n`;
  let authorization = "";
  const client = new VibeClient({
    baseUrl: "http://127.0.0.1:4242",
    token: "secret",
    fetch: (async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload.slice(0, 12)));
          controller.enqueue(new TextEncoder().encode(payload.slice(12)));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch,
  });
  const values: unknown[] = [];
  for await (const value of client.events("ses-1")) values.push(value);
  expect(values).toEqual([frame]);
  expect(authorization).toBe("Bearer secret");
});

test("malformed responses and non-loopback origins fail closed", async () => {
  expect(() => new VibeClient({ baseUrl: "https://example.com", token: "secret" })).toThrow(
    "127.0.0.1",
  );
  const client = new VibeClient({
    baseUrl: "http://127.0.0.1:4242",
    token: "secret",
    fetch: (async () => Response.json({ apiVersion: 999 })) as unknown as typeof fetch,
  });
  await expect(client.capabilities()).rejects.toBeInstanceOf(VibeApiError);
  expect(() => drainSseFrames("data: not-json\n\n")).toThrow("not valid JSON");
});
