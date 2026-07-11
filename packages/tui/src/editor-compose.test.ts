import { test, expect } from "bun:test";
import { composeInEditor, parseEditorCommand, type EditorComposeDeps } from "./editor-compose.ts";

/** An in-memory fs so the round-trip is hermetic (no real temp files/editor). */
function memDeps(
  editor: string | undefined,
  draft: string,
  editorEdit: (contents: string) => string,
): EditorComposeDeps & { removed: () => boolean } {
  const files = new Map<string, string>();
  let removed = false;
  return {
    editor,
    draft,
    outPath: "/tmp/vibe-compose-test.md",
    writeText: async (p, t) => {
      files.set(p, t);
    },
    readText: async (p) => files.get(p) ?? "",
    removeFile: async (p) => {
      files.delete(p);
      removed = true;
    },
    // The "editor" mutates the file contents, mimicking a real editor session.
    spawn: async (_command, args) => {
      const path = args[args.length - 1]!;
      files.set(path, editorEdit(files.get(path) ?? ""));
      return 0;
    },
    removed: () => removed,
  };
}

test("parseEditorCommand splits the binary from its flags", () => {
  expect(parseEditorCommand("vim")).toEqual({ command: "vim", args: [] });
  expect(parseEditorCommand("code -w")).toEqual({ command: "code", args: ["-w"] });
  expect(parseEditorCommand("  emacsclient  -nw ")).toEqual({
    command: "emacsclient",
    args: ["-nw"],
  });
  expect(parseEditorCommand("")).toEqual({ command: "", args: [] });
});

test("a non-empty file on exit REPLACES the draft (trailing newline stripped)", async () => {
  const deps = memDeps("vim", "old draft", () => "brand new prompt\n");
  const res = await composeInEditor(deps);
  expect(res).toEqual({ kind: "replaced", draft: "brand new prompt" });
  expect(deps.removed()).toBe(true); // temp file cleaned up
});

test("the editor receives the current draft seeded in the file", async () => {
  let seen = "";
  const deps = memDeps("vim", "seed me", (contents) => {
    seen = contents;
    return `${contents} + edit`;
  });
  const res = await composeInEditor(deps);
  expect(seen).toBe("seed me");
  expect(res).toEqual({ kind: "replaced", draft: "seed me + edit" });
});

test("an EMPTY file on exit KEEPS the prior draft", async () => {
  const deps = memDeps("vim", "keep me", () => "   \n");
  expect(await composeInEditor(deps)).toEqual({ kind: "kept" });
});

test("no $VISUAL/$EDITOR → unavailable (nothing spawned)", async () => {
  let spawned = false;
  const res = await composeInEditor({
    editor: undefined,
    draft: "x",
    spawn: async () => {
      spawned = true;
      return 0;
    },
  });
  expect(res).toEqual({ kind: "unavailable" });
  expect(spawned).toBe(false);
});

test("a spawn failure (bad editor) degrades to failed, not a throw", async () => {
  const res = await composeInEditor({
    editor: "no-such-editor",
    draft: "x",
    outPath: "/tmp/vibe-compose-fail.md",
    writeText: async () => {},
    readText: async () => "",
    removeFile: async () => {},
    spawn: async () => {
      throw new Error("spawn no-such-editor ENOENT");
    },
  });
  expect(res.kind).toBe("failed");
  if (res.kind === "failed") expect(res.reason).toMatch(/ENOENT/);
});

test("non-zero editor exit keeps the prior draft (BUG-080)", async () => {
  const files = new Map<string, string>();
  const res = await composeInEditor({
    editor: "vim",
    draft: "keep me",
    outPath: "/tmp/vibe-compose-cq.md",
    writeText: async (p, t) => {
      files.set(p, t);
    },
    readText: async (p) => files.get(p) ?? "partial junk",
    removeFile: async () => {},
    spawn: async () => 1, // :cq / abort
  });
  expect(res).toEqual({ kind: "kept" });
});
