import { test, expect, afterEach } from "bun:test";
import type { ToolContext } from "@vibe/shared";
import { webfetchTool } from "./webfetch.ts";

function ctx(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "s",
    emit: () => {},
    toolCallId: "t",
    abortSignal: new AbortController().signal,
  };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(body: string, contentType: string, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(body, { status, headers: { "content-type": contentType } })) as unknown as typeof fetch;
}

test("reduces HTML to readable text, stripping scripts/styles/tags", async () => {
  stubFetch(
    "<html><head><style>.x{color:red}</style><script>evil()</script></head><body><h1>Title</h1><p>Hello&nbsp;world</p></body></html>",
    "text/html",
  );
  const res = await webfetchTool.execute({ url: "https://example.com" }, ctx());
  expect(res.isError).toBeUndefined();
  const out = String(res.output);
  expect(out).toContain("Title");
  expect(out).toContain("Hello world");
  expect(out).not.toContain("evil()");
  expect(out).not.toContain("color:red");
  expect(out).not.toContain("<");
});

test("returns non-HTML bodies verbatim", async () => {
  stubFetch('{"ok":true}', "application/json");
  const res = await webfetchTool.execute({ url: "https://api.example.com/x" }, ctx());
  expect(String(res.output)).toBe('{"ok":true}');
});

test("a non-OK HTTP status is an error", async () => {
  stubFetch("not found", "text/plain", 404);
  const res = await webfetchTool.execute({ url: "https://example.com/missing" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("HTTP 404");
});

test("a network failure is reported cleanly, not thrown", async () => {
  globalThis.fetch = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  const res = await webfetchTool.execute({ url: "https://example.com" }, ctx());
  expect(res.isError).toBe(true);
  expect(String(res.output)).toContain("Fetch failed");
});
