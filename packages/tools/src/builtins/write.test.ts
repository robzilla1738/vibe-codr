import { test, expect, beforeEach } from "bun:test";
import {
  mkdtempSync,
  utimesSync,
  readdirSync,
  statSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { writeTool } from "./write.ts";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();

beforeEach(() => freshness.clear());

function ctx(cwd: string, sessionId = "ses_write"): { ctx: ToolContext; events: UIEvent[] } {
  const events: UIEvent[] = [];
  return {
    events,
    ctx: {
      cwd,
      sessionId,
      abortSignal: new AbortController().signal,
      emit: (e) => events.push(e),
      toolCallId: "call_1",
      freshness,
    },
  };
}

/** The file-changed event a successful write emits (narrowed for assertions). */
function fileChanged(events: UIEvent[]) {
  return events.find((e) => e.type === "file-changed") as
    | Extract<UIEvent, { type: "file-changed" }>
    | undefined;
}

test("creates a new file and emits a file-changed diff event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-new-"));
  const { ctx: c, events } = ctx(dir);
  const res = await writeTool.execute({ path: "hello.txt", content: "line1\nline2\n" }, c);

  expect(res.isError).toBeUndefined();
  expect(res.output).toContain("Created hello.txt");
  expect(await Bun.file(join(dir, "hello.txt")).text()).toBe("line1\nline2\n");

  const ev = fileChanged(events);
  expect(ev).toBeDefined();
  expect(ev!.action).toBe("write");
  expect(ev!.path).toBe("hello.txt");
  expect(ev!.added).toBe(2);
  expect(ev!.removed).toBe(0);
  // The full diff rides the event (for the UI), even though it stays out of output.
  expect(ev!.diff).toContain("line1");
});

test("overwrites an existing file and reports the delta", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-over-"));
  await Bun.write(join(dir, "f.txt"), "old-a\nold-b\n");
  const { ctx: c, events } = ctx(dir);
  const res = await writeTool.execute({ path: "f.txt", content: "new-a\n" }, c);

  expect(res.isError).toBeUndefined();
  expect(res.output).toContain("Overwrote f.txt");
  expect(await Bun.file(join(dir, "f.txt")).text()).toBe("new-a\n");
  const ev = fileChanged(events);
  expect(ev!.added).toBe(1);
  expect(ev!.removed).toBe(2);
});

test("creates missing parent directories automatically", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-mkdir-"));
  const { ctx: c } = ctx(dir);
  const res = await writeTool.execute({ path: "a/b/c/deep.txt", content: "nested\n" }, c);
  expect(res.isError).toBeUndefined();
  expect(await Bun.file(join(dir, "a/b/c/deep.txt")).text()).toBe("nested\n");
});

test("the diff text is kept OUT of the tool output (only the +N -M summary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-nodiff-"));
  const { ctx: c } = ctx(dir);
  const res = await writeTool.execute({ path: "x.txt", content: "unique-marker-line\n" }, c);
  const out = res.output as string;
  // The summary is present…
  expect(out).toContain("(+1 -0)");
  // …but the diff body (the `+`-prefixed content line) is NOT — README invariant:
  // write keeps its diff out of the output, unlike edit which echoes a capped diff.
  expect(out).not.toContain("+unique-marker-line");
  expect(out).not.toMatch(/^[+-]/m);
});

test("stale-write guard: an external touch after a read blocks the write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-stale-"));
  const full = join(dir, "shared.txt");
  await Bun.write(full, "original\n");
  const { ctx: c } = ctx(dir, "ses_stale");

  // Simulate the session having read the file earlier (records its mtime baseline).
  freshness.recordRead("ses_stale", full);
  // An external process edits it → bump the on-disk mtime past the baseline.
  utimesSync(full, new Date(), new Date(Date.now() + 10_000));

  const res = await writeTool.execute({ path: "shared.txt", content: "clobber\n" }, c);
  expect(res.isError).toBe(true);
  expect(res.output).toContain("changed on disk");
  // The write was refused — the external content is intact.
  expect(await Bun.file(full).text()).toBe("original\n");
});

test("write via temp+rename leaves no stray temp file (create and overwrite)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-temp-"));
  const { ctx: c } = ctx(dir, "ses_temp");
  await writeTool.execute({ path: "new.txt", content: "hi\n" }, c);
  await writeTool.execute({ path: "new.txt", content: "bye\n" }, c);
  expect(await Bun.file(join(dir, "new.txt")).text()).toBe("bye\n");
  // No `*.tmp` sibling survives either the create or the overwrite.
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("overwriting preserves the existing file mode across the temp+rename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-mode-"));
  const full = join(dir, "run.sh");
  await Bun.write(full, "echo v1\n");
  chmodSync(full, 0o755);
  const { ctx: c } = ctx(dir, "ses_mode");
  const res = await writeTool.execute({ path: "run.sh", content: "echo v2\n" }, c);
  expect(res.isError).toBeUndefined();
  // rename swaps the inode; without carrying the mode the +x bit would be lost.
  expect(statSync(full).mode & 0o777).toBe(0o755);
});

test("a mid-write failure leaves the existing file intact with no temp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-fail-"));
  const full = join(dir, "f.txt");
  await Bun.write(full, "original\n");
  const { ctx: c } = ctx(dir, "ses_fail");
  const orig = Bun.write;
  try {
    (Bun as unknown as { write: unknown }).write = () => {
      throw new Error("injected write failure");
    };
    await expect(writeTool.execute({ path: "f.txt", content: "clobber\n" }, c)).rejects.toThrow(
      "injected write failure",
    );
  } finally {
    (Bun as unknown as { write: typeof orig }).write = orig;
  }
  // The overwrite target keeps its original bytes; no temp leaked.
  expect(await Bun.file(full).text()).toBe("original\n");
  expect(readdirSync(dir).some((f) => f.includes(".tmp"))).toBe(false);
});

test("writing THROUGH a symlink preserves the link and updates its real target", async () => {
  // Temp+rename swaps the inode at the written path. Writing a symlink must
  // dereference to the target so the link survives and its target is overwritten —
  // never replace the link with a regular file and strand the target stale.
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-link-"));
  await Bun.write(join(dir, "real.txt"), "v1\n");
  symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
  const { ctx: c } = ctx(dir, "ses_link");
  const res = await writeTool.execute({ path: "link.txt", content: "v2\n" }, c);
  expect(res.isError).toBeUndefined();
  expect(res.output).toContain("Overwrote link.txt");
  // The link stays a link; its target got the new content.
  expect(lstatSync(join(dir, "link.txt")).isSymbolicLink()).toBe(true);
  expect(await Bun.file(join(dir, "real.txt")).text()).toBe("v2\n");
  // No stray temp beside either the link or its target.
  expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("write on a previously-seen then-deleted path is treated as a fresh create (C-2)", async () => {
  // C-2 regression at the tool level. A sibling process unlinks the file
  // between the session's earlier read and the current write call. The OLD
  // write.ts did `await file.exists()` then `await file.text()` as two
  // awaits; if the file vanished between them, text() threw ENOENT and the
  // toolset handler surfaced "ERROR: write threw: ENOENT" — the user's
  // intent (write the new content) was blocked by a race. The NEW code does
  // ONE read via readTextIfExists (Bun's native FD lifecycle is
  // race-free against unlink); on ENOENT the helper returns null and we
  // treat the path as a fresh create with no stale-check baseline to
  // compare against, so the write proceeds cleanly.
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-stale-deleted-"));
  const full = join(dir, "shared.txt");
  await Bun.write(full, "original\n");
  const { ctx: c } = ctx(dir, "ses_stale_deleted");
  // Simulate the session having read the file (records mtime baseline).
  freshness.recordRead("ses_stale_deleted", full);
  // A sibling unlinks the file between the read baseline and the write.
  unlinkSync(full);
  const res = await writeTool.execute({ path: "shared.txt", content: "new\n" }, c);
  expect(res.isError).toBeUndefined();
  // No prior content to diff against → reported as a fresh create.
  expect(res.output).toContain("Created shared.txt");
  expect(await Bun.file(full).text()).toBe("new\n");
});

test("write after our own write does not self-flag as stale (baseline advances)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-self-"));
  const { ctx: c } = ctx(dir, "ses_self");
  // First write creates the file and records our own mtime as the baseline.
  const first = await writeTool.execute({ path: "f.txt", content: "v1\n" }, c);
  expect(first.isError).toBeUndefined();
  // A second write in the same session must NOT be flagged stale by our own edit.
  const second = await writeTool.execute({ path: "f.txt", content: "v2\n" }, c);
  expect(second.isError).toBeUndefined();
  expect(second.output).toContain("Overwrote f.txt");
});
