import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { readTool } from "./read.ts";
import { editTool } from "./edit.ts";
import { writeTool } from "./write.ts";
import { FreshnessRegistry } from "./freshness.ts";

// One per-test-suite registry; cleared before each test for isolation. This is
// the test pattern, NOT a module-level singleton — production code paths
// construct their own `FreshnessRegistry` (one per Session tree, owned by the
// engine), so the test registry never shares state with anything else.
const freshness = new FreshnessRegistry();

function ctx(cwd: string, sessionId = "ses_test"): ToolContext {
  const events: UIEvent[] = [];
  return {
    cwd,
    sessionId,
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
    freshness,
  };
}

/** Push a file's mtime into the future so it reads as changed-on-disk. */
function touchFuture(path: string): void {
  const future = new Date(Date.now() + 60_000);
  utimesSync(path, future, future);
}

beforeEach(() => freshness.clear());

// ── Tool integration ───────────────────────────────────────────────────────

test("read → external touch → edit is refused as a stale write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-stale-"));
  const path = "a.txt";
  await Bun.write(join(cwd, path), "hello world\n");

  await readTool.execute({ path }, ctx(cwd));
  touchFuture(join(cwd, path)); // an external editor rewrites it after our read

  const r = await editTool.execute({ path, oldString: "world", newString: "there" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("changed on disk since you last read it");
  // The clobbering edit must NOT have been applied.
  expect(await Bun.file(join(cwd, path)).text()).toBe("hello world\n");
});

test("read → edit → edit again: our own writes never self-flag as stale", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-own-"));
  const path = "a.txt";
  await Bun.write(join(cwd, path), "one two three\n");

  await readTool.execute({ path }, ctx(cwd));
  const first = await editTool.execute({ path, oldString: "one", newString: "1" }, ctx(cwd));
  expect(first.isError).toBeUndefined();
  // The second edit sees only our own prior write — not stale.
  const second = await editTool.execute({ path, oldString: "two", newString: "2" }, ctx(cwd));
  expect(second.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("1 2 three\n");
});

test("edit of a never-read file is allowed (no read-before-edit requirement)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-noread-"));
  const path = "a.txt";
  await Bun.write(join(cwd, path), "alpha\n");
  touchFuture(join(cwd, path)); // even if it changed on disk — we never read it

  const r = await editTool.execute({ path, oldString: "alpha", newString: "beta" }, ctx(cwd));
  expect(r.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("beta\n");
});

test("read → external touch → write is refused as a stale write", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-wstale-"));
  const path = "a.txt";
  await Bun.write(join(cwd, path), "old\n");

  await readTool.execute({ path }, ctx(cwd));
  touchFuture(join(cwd, path));

  const r = await writeTool.execute({ path, content: "new\n" }, ctx(cwd));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("changed on disk since you last read it");
  expect(await Bun.file(join(cwd, path)).text()).toBe("old\n");
});

test("write to a never-read file (create or blind overwrite) is allowed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-wnew-"));
  // New file — never read, never existed.
  const created = await writeTool.execute({ path: "new.txt", content: "fresh\n" }, ctx(cwd));
  expect(created.isError).toBeUndefined();

  // Existing file changed on disk but never read → blind overwrite still allowed.
  await Bun.write(join(cwd, "b.txt"), "v1\n");
  touchFuture(join(cwd, "b.txt"));
  const over = await writeTool.execute({ path: "b.txt", content: "v2\n" }, ctx(cwd));
  expect(over.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, "b.txt")).text()).toBe("v2\n");
});

test("per-session isolation: one session's read doesn't guard another's edit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-iso-"));
  const path = "a.txt";
  await Bun.write(join(cwd, path), "shared\n");

  // Session A reads (recording its baseline).
  await readTool.execute({ path }, ctx(cwd, "ses_A"));

  // Session B never read it → its edit is NOT stale-guarded by A's read.
  const b = await editTool.execute(
    { path, oldString: "shared", newString: "B-edit" },
    ctx(cwd, "ses_B"),
  );
  expect(b.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("B-edit\n");

  // Contrast: the file now moves on disk past A's baseline; A, which DID read it,
  // is still guarded. (Touched explicitly because B's write reset mtime to now.)
  touchFuture(join(cwd, path));
  const a = await editTool.execute(
    { path, oldString: "B-edit", newString: "A-edit" },
    ctx(cwd, "ses_A"),
  );
  expect(a.isError).toBe(true);
  expect(a.output).toContain("changed on disk since you last read it");
});

// ── Module unit tests ──────────────────────────────────────────────────────

test("assertFresh: unseen path is fresh; recorded-then-touched path is stale", () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-unit-"));
  const path = join(cwd, "f.txt");
  // A synchronously-present file so the module's statSync sees it immediately.
  writeFileSync(path, "x");

  // Never recorded → fresh.
  expect(freshness.assertFresh("s1", path).stale).toBe(false);

  freshness.recordRead("s1", path);
  expect(freshness.assertFresh("s1", path).stale).toBe(false);

  touchFuture(path);
  const res = freshness.assertFresh("s1", path);
  expect(res.stale).toBe(true);
  expect(res.ageMs).toBeGreaterThan(0);
});

test("clearSession drops a session's tracking so its files read as fresh again", () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-clear-"));
  const path = join(cwd, "f.txt");
  writeFileSync(path, "x");

  freshness.recordRead("s1", path);
  touchFuture(path);
  expect(freshness.assertFresh("s1", path).stale).toBe(true);

  freshness.clearSession("s1");
  expect(freshness.assertFresh("s1", path).stale).toBe(false);
});

test("the per-session registry has no LRU cap (tracking persists past any size)", () => {
  // bug2.md C-3: the old 2000-file LRU silently evicted the oldest entries, so
  // a file a session had read days ago suddenly read as fresh and a stale edit
  // slipped through. The fix removes the cap — the tree's lifetime is bounded
  // by `freshness.clear()` at root-session teardown, so worst-case memory is
  // O(files_in_tree). Record well past what the old cap would have allowed
  // and assert the FIRST file is still guarded: the stale-detection must not
  // silently degrade under any real workload.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-fresh-cap-"));
  const first = join(cwd, "file-0.txt");
  writeFileSync(first, "0");
  freshness.recordRead("s1", first);
  touchFuture(first);
  expect(freshness.assertFresh("s1", first).stale).toBe(true); // tracked, changed

  for (let i = 1; i <= 2100; i++) {
    const p = join(cwd, `file-${i}.txt`);
    writeFileSync(p, String(i));
    freshness.recordRead("s1", p);
  }
  // The FIRST path is still tracked → still stale. No silent degradation.
  expect(freshness.assertFresh("s1", first).stale).toBe(true);
});
