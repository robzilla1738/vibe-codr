import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, gitPushTool } from "./git.ts";

function ctx(cwd: string): ToolContext {
  const events: UIEvent[] = [];
  return {
    cwd,
    sessionId: "ses",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "c1",
  };
}

async function initRepo(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-git-"));
  const run = (args: string[]) => Bun.spawn(["git", ...args], { cwd }).exited;
  await run(["init", "-q"]);
  await run(["config", "user.email", "t@example.com"]);
  await run(["config", "user.name", "Test"]);
  return cwd;
}

test("git_status reports an untracked file then a clean tree after commit", async () => {
  const cwd = await initRepo();
  await Bun.write(join(cwd, "a.txt"), "hello\n");

  const status = await gitStatusTool.execute({}, ctx(cwd));
  expect(String(status.output)).toContain("a.txt");

  const commit = await gitCommitTool.execute({ message: "add a", all: true }, ctx(cwd));
  expect(commit.isError).toBeUndefined();

  const after = await gitStatusTool.execute({}, ctx(cwd));
  expect(String(after.output)).toContain("clean working tree");
});

test("git_diff shows unstaged changes", async () => {
  const cwd = await initRepo();
  await Bun.write(join(cwd, "a.txt"), "one\n");
  await gitCommitTool.execute({ message: "init", all: true }, ctx(cwd));
  await Bun.write(join(cwd, "a.txt"), "two\n");

  const diff = await gitDiffTool.execute({}, ctx(cwd));
  const text = String(diff.output);
  expect(text).toContain("-one");
  expect(text).toContain("+two");
});

test("git_commit with nothing staged is an error", async () => {
  const cwd = await initRepo();
  const r = await gitCommitTool.execute({ message: "noop" }, ctx(cwd));
  expect(r.isError).toBe(true);
});

test("git_log shows commit subjects", async () => {
  const cwd = await initRepo();
  await Bun.write(join(cwd, "a.txt"), "x\n");
  await gitCommitTool.execute({ message: "first commit", all: true }, ctx(cwd));
  await Bun.write(join(cwd, "b.txt"), "y\n");
  await gitCommitTool.execute({ message: "second commit", all: true }, ctx(cwd));

  const log = await gitLogTool.execute({ max: 5 }, ctx(cwd));
  expect(log.isError).toBeUndefined();
  expect(String(log.output)).toContain("first commit");
  expect(String(log.output)).toContain("second commit");
});

test("git_push fails clearly when there is no remote", async () => {
  const cwd = await initRepo();
  await Bun.write(join(cwd, "a.txt"), "x\n");
  await gitCommitTool.execute({ message: "init", all: true }, ctx(cwd));
  // No 'origin' remote configured -> push errors rather than throwing.
  const r = await gitPushTool.execute({}, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(String(r.output).length).toBeGreaterThan(0);
});
