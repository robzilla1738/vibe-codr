import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { gitStatusTool, gitDiffTool, gitCommitTool, gitLogTool, gitPushTool } from "./git.ts";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();

function ctx(cwd: string): ToolContext {
  const events: UIEvent[] = [];
  return {
    cwd,
    sessionId: "ses",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "c1",
    freshness,
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

test("git_diff ref:HEAD shows committed changes the working tree no longer has", async () => {
  const cwd = await initRepo();
  await Bun.write(join(cwd, "a.txt"), "one\n");
  await gitCommitTool.execute({ message: "init", all: true }, ctx(cwd));
  await Bun.write(join(cwd, "a.txt"), "two\n");
  await gitCommitTool.execute({ message: "second", all: true }, ctx(cwd));

  // The change is committed, so a plain unstaged diff is empty...
  const unstaged = await gitDiffTool.execute({}, ctx(cwd));
  expect(String(unstaged.output)).toBe("(no changes)");
  // ...but diffing the range surfaces the committed edit.
  const ranged = await gitDiffTool.execute({ ref: "HEAD~1...HEAD" }, ctx(cwd));
  const text = String(ranged.output);
  expect(text).toContain("-one");
  expect(text).toContain("+two");
});

test("git_diff rejects a ref that looks like an option", async () => {
  const cwd = await initRepo();
  const r = await gitDiffTool.execute({ ref: "--output=/tmp/x" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("Invalid ref");
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

test("a very large diff is bounded in memory, keeping head AND the trailing tail", async () => {
  const cwd = await initRepo();
  // ~5MB of new content, staged so it shows in `git diff --staged` → a huge diff.
  // The wrapper must not materialize it all; the display is capped + marked. The
  // LAST line is distinctive: a diff's tail (a conflict marker, an error printed
  // last) has to survive — head+tail keep at both the read and the display cap.
  const big = [
    ...Array.from({ length: 120_000 }, (_, i) => `line ${i} ${"x".repeat(30)}`),
    "TRAILING_ERROR_LINE_zzz",
  ].join("\n");
  await Bun.write(join(cwd, "big.txt"), big);
  await Bun.spawn(["git", "add", "-A"], { cwd }).exited;
  const r = await gitDiffTool.execute({ staged: true }, ctx(cwd));
  const out = String(r.output);
  expect(out).toContain("chars omitted"); // the head+tail elision marker
  // The diff's START is still shown…
  expect(out).toContain("line 0 ");
  // …and so is its END — a head-only cap would have dropped this trailing line.
  expect(out).toContain("TRAILING_ERROR_LINE_zzz");
  // Bounded well under the 5MB the diff would be (read cap 64k + display cap 20k).
  expect(out.length).toBeLessThan(70_000);
});
