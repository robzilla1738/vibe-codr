import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@vibe/shared";
import { lsTool } from "./ls.ts";

function ctx(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    emit: () => {},
    toolCallId: "call_1",
  };
}

test("lists files and marks directories with a trailing slash, sorted", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-ls-"));
  await Bun.write(join(cwd, "b.txt"), "");
  await Bun.write(join(cwd, "a.txt"), "");
  mkdirSync(join(cwd, "sub"));
  const r = await lsTool.execute({}, ctx(cwd));
  expect(r.isError).toBeUndefined();
  expect(String(r.output).split("\n")).toEqual(["a.txt", "b.txt", "sub/"]);
});

test("reports an empty directory distinctly", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-ls-empty-"));
  const r = await lsTool.execute({}, ctx(cwd));
  expect(r.output).toBe("(empty directory)");
});

test("a missing directory is a clean error, not a throw", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-ls-miss-"));
  const r = await lsTool.execute({ path: "does-not-exist" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("Cannot list");
});
