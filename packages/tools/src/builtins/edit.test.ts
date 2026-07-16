import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, statSync, chmodSync, symlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext, UIEvent } from "@vibe/shared";
import { editTool } from "./edit.ts";
import { writeTool } from "./write.ts";
import { readTool } from "./read.ts";
import { FreshnessRegistry } from "./freshness.ts";

const freshness = new FreshnessRegistry();

function ctx(cwd: string, events: UIEvent[]): ToolContext {
  return {
    cwd,
    sessionId: "ses_test",
    abortSignal: new AbortController().signal,
    emit: (e) => events.push(e),
    toolCallId: "call_1",
    freshness,
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
  // The diff is attributed to the originating tool call so the UI can fold it
  // into the exact tool block (no positional guessing).
  expect(changed && changed.type === "file-changed" && changed.toolCallId).toBe("call_1");
});

test("refuses to edit a non-UTF-8 (binary) file instead of corrupting its bytes", async () => {
  // `file.text()` would map the 0xFF to U+FFFD and the rewrite would persist that
  // corruption far from the edit. The tool must refuse and leave the bytes intact.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-edit-"));
  const path = "bin.dat";
  const original = Buffer.concat([Buffer.from("foo\n"), Buffer.from([0xff]), Buffer.from("bar")]);
  await Bun.write(join(cwd, path), original);
  const r = await editTool.execute({ path, oldString: "foo", newString: "baz" }, ctx(cwd, []));
  expect(r.isError).toBe(true);
  expect(r.output).toContain("not valid UTF-8");
  // The file is byte-for-byte unchanged — no corruption.
  const after = new Uint8Array(await Bun.file(join(cwd, path)).arrayBuffer());
  expect([...after]).toEqual([...original]);
});

test("replacement text containing $ sequences is inserted literally", async () => {
  // `$&`, `$1`, `$$` are special in String.replace's string form — they must
  // be preserved verbatim when the model edits regex/shell/jQuery code.
  const { cwd, path } = await seed("const re = OLD;\n");
  const events: UIEvent[] = [];
  const r = await editTool.execute(
    { path, oldString: "OLD", newString: "/foo$1$&bar$$/" },
    ctx(cwd, events),
  );
  expect(r.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("const re = /foo$1$&bar$$/;\n");
});

test("non-unique match errors unless replaceAll is set", async () => {
  const { cwd, path } = await seed("x x x\n");
  const events: UIEvent[] = [];
  const fail = await editTool.execute({ path, oldString: "x", newString: "y" }, ctx(cwd, events));
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

test("a large diff is capped in the model output but full in the UI event", async () => {
  // The model-facing output must stay bounded (context-cap invariant), while the
  // file-changed event keeps the complete diff for the UI to render.
  const lines = Array.from({ length: 5000 }, (_, i) => `old line ${i}`).join("\n");
  const { cwd, path } = await seed(`${lines}\n`);
  const events: UIEvent[] = [];
  const r = await editTool.execute(
    { path, oldString: "old line", newString: "new line", replaceAll: true },
    ctx(cwd, events),
  );
  expect(r.isError).toBeUndefined();
  // Output is capped well under the raw diff size and carries the marker.
  expect(r.output.length).toBeLessThan(21_000);
  expect(r.output).toContain("…(diff truncated at 20000 chars)");
  // The UI event still carries the full, uncapped diff.
  const changed = events.find((e) => e.type === "file-changed");
  expect(changed && changed.type === "file-changed" && changed.diff.length).toBeGreaterThan(50_000);
});

test("edit writes via temp+rename and leaves no stray temp file on success", async () => {
  const { cwd, path } = await seed("hello world\n");
  const r = await editTool.execute({ path, oldString: "world", newString: "there" }, ctx(cwd, []));
  expect(r.isError).toBeUndefined();
  expect(await Bun.file(join(cwd, path)).text()).toBe("hello there\n");
  // The atomic temp+rename must clean up after itself — no `*.tmp` sibling left.
  expect(readdirSync(cwd).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("edit preserves the original file mode across the temp+rename", async () => {
  // rename drops the original inode, so its mode would be lost unless carried
  // onto the temp — an edited executable script must stay +x.
  const { cwd, path } = await seed("#!/bin/sh\necho old\n");
  const full = join(cwd, path);
  chmodSync(full, 0o755);
  const r = await editTool.execute({ path, oldString: "old", newString: "new" }, ctx(cwd, []));
  expect(r.isError).toBeUndefined();
  expect(statSync(full).mode & 0o777).toBe(0o755);
});

test("a mid-write failure leaves the ORIGINAL file intact with no temp", async () => {
  // Temp+rename means the original is only ever replaced by a COMPLETE rename;
  // a crash while writing the temp can't truncate the target. Inject a write
  // failure and assert the original bytes survive and no temp leaks.
  const { cwd, path } = await seed("keep me\n");
  const full = join(cwd, path);
  const orig = Bun.write;
  try {
    (Bun as unknown as { write: unknown }).write = () => {
      throw new Error("injected write failure");
    };
    await expect(
      editTool.execute({ path, oldString: "keep me", newString: "clobber" }, ctx(cwd, [])),
    ).rejects.toThrow("injected write failure");
  } finally {
    (Bun as unknown as { write: typeof orig }).write = orig;
  }
  expect(await Bun.file(full).text()).toBe("keep me\n");
  expect(readdirSync(cwd).some((f) => f.includes(".tmp"))).toBe(false);
});

test("editing a missing file reports 'File not found' (C-2), not 'looks binary'", async () => {
  // C-2 regression at the tool level. The OLD edit.ts did
  //   if (!(await file.exists())) return "File not found";
  //   before = new TextDecoder({fatal:true}).decode(await file.arrayBuffer());
  // and the arrayBuffer() call landed an ENOENT in the TextDecoder catch arm,
  // misreporting a missing file as "is not valid UTF-8 (looks binary)". The
  // NEW code uses readBytesIfExists: one atomic read, ENOENT → null
  // (→ "File not found"), and the strict-decode is reserved for the
  // genuinely-binary case (see the existing "refuses to edit a non-UTF-8"
  // test). The "binary" wording must NOT appear in the missing-file path.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-edit-missing-"));
  const path = "absent.txt";
  const r = await editTool.execute({ path, oldString: "x", newString: "y" }, ctx(cwd, []));
  expect(r.isError).toBe(true);
  expect(String(r.output)).toContain("File not found");
  expect(String(r.output)).not.toContain("looks binary");
  expect(String(r.output)).not.toContain("not valid UTF-8");
});

test("editing THROUGH a symlink preserves the link and updates its real target", async () => {
  // Temp+rename swaps the inode at the edited path. Editing a symlink must
  // dereference to the target so the link survives and its target is updated —
  // never replace the link with a regular file and strand the target stale.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-edit-link-"));
  await Bun.write(join(cwd, "real.txt"), "hello world\n");
  symlinkSync(join(cwd, "real.txt"), join(cwd, "link.txt"));
  const r = await editTool.execute(
    { path: "link.txt", oldString: "world", newString: "there" },
    ctx(cwd, []),
  );
  expect(r.isError).toBeUndefined();
  // The link is still a link, not clobbered into a regular file…
  expect(lstatSync(join(cwd, "link.txt")).isSymbolicLink()).toBe(true);
  // …and the real target now carries the edit.
  expect(await Bun.file(join(cwd, "real.txt")).text()).toBe("hello there\n");
  // No stray temp beside either the link or its target.
  expect(readdirSync(cwd).filter((f) => f.includes(".tmp"))).toEqual([]);
});

test("edit after an external chmod lands at the CURRENT target mode (C-1: captured on target, not on full)", async () => {
  // C-1 regression directly. The OLD edit.ts captured `statSync(full).mode`
  // outside atomicReplace — if a chmod happens between the read and the
  // atomicReplace, the OLD code would land at the pre-read mode; the NEW code
  // captures the mode INSIDE atomicReplace on the post-deref target, so it
  // lands at the CURRENT post-chmod mode (the user's intent). `chmod` updates
  // ctime only — mtime is unchanged — so the freshness guard still allows
  // the edit on the same file.
  const cwd = mkdtempSync(join(tmpdir(), "vibe-edit-chmod-"));
  const path = "exec.sh";
  const full = join(cwd, path);
  await Bun.write(full, "#!/bin/sh\necho original\n");
  chmodSync(full, 0o755);

  // Simulate the session having read the file (records mtime baseline).
  await readTool.execute({ path }, ctx(cwd, []));
  // An external chmod (does NOT touch mtime, so the freshness guard still
  // allows the edit). The user's intent is now 0o700.
  chmodSync(full, 0o700);

  const r = await editTool.execute({ path, oldString: "original", newString: "new" }, ctx(cwd, []));
  expect(r.isError).toBeUndefined();
  // The file lands at the CURRENT post-chmod mode, not the pre-read one.
  expect(statSync(full).mode & 0o777).toBe(0o700);
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

test("a trailing-newline-only edit reports the change honestly, not a misleading +0 -0", async () => {
  // Removing the final newline is a real byte change but leaves the line-based
  // diff empty — the output must say so rather than read as a no-op.
  const { cwd, path } = await seed("foo\n");
  const events: UIEvent[] = [];
  const r = await editTool.execute(
    { path, oldString: "foo\n", newString: "foo" },
    ctx(cwd, events),
  );
  expect(r.isError).toBeFalsy();
  expect(String(r.output)).not.toContain("(+0 -0)");
  expect(String(r.output).toLowerCase()).toContain("newline");
  // The file really changed on disk.
  expect(await Bun.file(join(cwd, path)).text()).toBe("foo");
  // And a file-changed event still fired.
  expect(events.some((e) => e.type === "file-changed")).toBe(true);
});
