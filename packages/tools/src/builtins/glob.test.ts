import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { globTool } from "./glob.ts";

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

test("matches files by pattern and reports no matches distinctly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-"));
  await Promise.all([
    Bun.write(join(cwd, "a.ts"), ""),
    Bun.write(join(cwd, "b.ts"), ""),
    Bun.write(join(cwd, "c.md"), ""),
  ]);
  const hit = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
  expect((hit.output as string).split("\n").sort()).toEqual(["a.ts", "b.ts"]);

  const miss = await globTool.execute({ pattern: "*.rs" }, ctx(cwd));
  expect(miss.output).toBe("(no matches)");
});

test("appends a truncation marker past the 1000-match cap", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-glob-cap-"));
  await Promise.all(
    Array.from({ length: 1001 }, (_, i) => Bun.write(join(cwd, `f${i}.ts`), "")),
  );
  const r = await globTool.execute({ pattern: "*.ts" }, ctx(cwd));
  const lines = (r.output as string).split("\n");
  expect(lines.length).toBe(1001); // 1000 matches + the marker line
  expect(lines[lines.length - 1]).toContain("truncated at 1000 matches");
});
