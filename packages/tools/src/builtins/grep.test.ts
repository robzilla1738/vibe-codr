import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { grepTool } from "./grep.ts";

function ctx(cwd: string): ToolContext {
  const events: UIEvent[] = [];
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
  };
}

test("returns matching lines and reports no matches distinctly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-grep-"));
  await Bun.write(join(cwd, "a.txt"), "alpha\nneedle here\nbeta\n");
  const hit = await grepTool.execute({ pattern: "needle" }, ctx(cwd));
  expect(hit.isError).toBeUndefined();
  expect(hit.output).toContain("needle here");

  const miss = await grepTool.execute({ pattern: "zzznope" }, ctx(cwd));
  expect(miss.output).toBe("(no matches)");
});

test("appends a truncation marker past the 500-match cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-grep-cap-"));
  const body = Array.from({ length: 600 }, (_, i) => `match ${i}`).join("\n");
  await Bun.write(join(cwd, "big.txt"), `${body}\n`);
  const r = await grepTool.execute({ pattern: "match" }, ctx(cwd));
  const lines = (r.output as string).split("\n");
  expect(lines.length).toBe(501); // 500 matches + the marker line
  expect(lines[lines.length - 1]).toContain("truncated at 500 matches");
});
