import { expect, test } from "bun:test";
import { macosTool } from "./macos.ts";

test("macOS tool delegates a bounded durable request and returns its resolution", async () => {
  let request: unknown;
  const tool = macosTool(async (value) => { request = value; return { id: value.id, status: "resolved", result: { opened: true } }; });
  const result = await tool.execute({ action: "open-application", target: "Finder" }, {
    cwd: "/repo", sessionId: "session", toolCallId: "turn_1", abortSignal: new AbortController().signal,
    emit() {}, freshness: { recordRead() {}, recordWrite() {}, assertFresh: () => ({ stale: false }), clearSession() {} },
  });
  expect(request).toMatchObject({ integration: "macos", toolName: "macos", arguments: { action: "open-application", target: "Finder" }, originatingTurn: "turn_1", status: "pending" });
  expect(result).toEqual({ output: { status: "resolved", result: { opened: true } } });
});
