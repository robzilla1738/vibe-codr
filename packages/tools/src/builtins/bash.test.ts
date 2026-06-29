import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { bashTool } from "./bash.ts";

function ctx(cwd: string, events: UIEvent[] = []): ToolContext {
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
  };
}
const cwd = () => mkdtempSync(join(tmpdir(), "vibe-bash-"));

test("runs a command and returns exit 0 with stdout", async () => {
  const events: UIEvent[] = [];
  const r = await bashTool().execute({ command: "echo hello-bash" }, ctx(cwd(), events));
  expect(r.isError).toBe(false); // bash sets isError = (code !== 0)
  expect(String(r.output)).toContain("exit 0");
  expect(String(r.output)).toContain("hello-bash");
  // Output is streamed as progress events too.
  expect(events.some((e) => e.type === "tool-call-progress")).toBe(true);
});

test("a non-zero exit is reported as an error", async () => {
  const r = await bashTool().execute({ command: "exit 3" }, ctx(cwd()));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("exit 3");
});

test("multibyte UTF-8 output is preserved intact (streaming decode)", async () => {
  // Guards the per-stream streaming TextDecoder: a multibyte char must never
  // be corrupted into a replacement char.
  const r = await bashTool().execute(
    { command: "printf 'café — déjà vu 🚀\\n'" },
    ctx(cwd()),
  );
  expect(String(r.output)).toContain("café — déjà vu 🚀");
});

test("stderr is captured alongside stdout", async () => {
  const r = await bashTool().execute({ command: "echo oops 1>&2" }, ctx(cwd()));
  expect(String(r.output)).toContain("oops");
});

test("background run without a job registry is rejected cleanly", async () => {
  const r = await bashTool().execute({ command: "sleep 1", background: true }, ctx(cwd()));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("unavailable");
});
