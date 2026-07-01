import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { writeTool } from "./write.ts";
import { recordSeen, _resetFreshness } from "./freshness.ts";

beforeEach(() => _resetFreshness());

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
  const res = await writeTool.execute(
    { path: "a/b/c/deep.txt", content: "nested\n" },
    c,
  );
  expect(res.isError).toBeUndefined();
  expect(await Bun.file(join(dir, "a/b/c/deep.txt")).text()).toBe("nested\n");
});

test("the diff text is kept OUT of the tool output (only the +N -M summary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-write-nodiff-"));
  const { ctx: c } = ctx(dir);
  const res = await writeTool.execute(
    { path: "x.txt", content: "unique-marker-line\n" },
    c,
  );
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
  recordSeen("ses_stale", full);
  // An external process edits it → bump the on-disk mtime past the baseline.
  utimesSync(full, new Date(), new Date(Date.now() + 10_000));

  const res = await writeTool.execute({ path: "shared.txt", content: "clobber\n" }, c);
  expect(res.isError).toBe(true);
  expect(res.output).toContain("changed on disk");
  // The write was refused — the external content is intact.
  expect(await Bun.file(full).text()).toBe("original\n");
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
