import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { editTool } from "./edit.ts";
import { writeTool } from "./write.ts";

function ctx(cwd: string, events: UIEvent[]): ToolContext {
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
  };
}

async function seed(content: string): Promise<{ cwd: string; path: string }> {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-edit-"));
  const path = "a.txt";
  await Bun.write(join(cwd, path), content);
  return { cwd, path };
}

test("single edit replaces a unique match and emits a file-changed diff", async () => {
  const { cwd, path } = await seed("hello world\n");
  const events: UIEvent[] = [];
  const r = await editTool.execute(
    { path, oldString: "world", newString: "there" },
    ctx(cwd, events),
  );
  expect(r.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("hello there\n");
  const changed = events.find((e) => e.type === "file-changed");
  expect(changed && changed.type === "file-changed" && changed.action).toBe("edit");
  expect(changed && changed.type === "file-changed" && changed.added).toBe(1);
});

test("non-unique match errors unless replaceAll is set", async () => {
  const { cwd, path } = await seed("x x x\n");
  const events: UIEvent[] = [];
  const fail = await editTool.execute(
    { path, oldString: "x", newString: "y" },
    ctx(cwd, events),
  );
  expect(fail.isError).toBe(true);
  // File is untouched after the failed edit.
  expect(await Bun.file(join(cwd, path)).text()).toBe("x x x\n");

  const ok = await editTool.execute(
    { path, oldString: "x", newString: "y", replaceAll: true },
    ctx(cwd, events),
  );
  expect(ok.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("y y y\n");
});

test("multi-edit is atomic: a bad hunk writes nothing", async () => {
  const { cwd, path } = await seed("one\ntwo\nthree\n");
  const events: UIEvent[] = [];
  const r = await editTool.execute(
    {
      path,
      edits: [
        { oldString: "one", newString: "1" },
        { oldString: "NOPE", newString: "x" }, // fails -> whole op rolls back
      ],
    },
    ctx(cwd, events),
  );
  expect(r.isError).toBe(true);
  expect(await Bun.file(join(cwd, path)).text()).toBe("one\ntwo\nthree\n");
  expect(events.some((e) => e.type === "file-changed")).toBe(false);
});

test("multi-edit applies all hunks in order when valid", async () => {
  const { cwd, path } = await seed("one\ntwo\nthree\n");
  const events: UIEvent[] = [];
  const r = await editTool.execute(
    {
      path,
      edits: [
        { oldString: "one", newString: "1" },
        { oldString: "three", newString: "3" },
      ],
    },
    ctx(cwd, events),
  );
  expect(r.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("1\ntwo\n3\n");
});

test("write emits a file-changed event with an all-additions diff for a new file", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-write-"));
  const events: UIEvent[] = [];
  const r = await writeTool.execute(
    { path: "new.txt", content: "alpha\nbeta\n" },
    ctx(cwd, events),
  );
  expect(r.isError).toBeUndefined();
  const changed = events.find((e) => e.type === "file-changed");
  expect(changed && changed.type === "file-changed" && changed.action).toBe("write");
  expect(changed && changed.type === "file-changed" && changed.added).toBe(2);
  expect(changed && changed.type === "file-changed" && changed.removed).toBe(0);
});
