import { describe, expect, it } from "vitest";
import {
  composeInEditor,
  EDITOR_DRAFT_MAX_BYTES,
  type EditorComposeDeps,
  parseEditorCommand,
} from "./editor-compose";

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
    writeText: async (path, text) => { files.set(path, text); },
    readText: async (path) => files.get(path) ?? "",
    removeFile: async (path) => { files.delete(path); removed = true; },
    spawn: async (_command, args) => {
      const path = args.at(-1)!;
      files.set(path, editorEdit(files.get(path) ?? ""));
      return 0;
    },
    removed: () => removed,
  };
}

describe("external editor compose parity", () => {
  it("splits the binary from standard editor flags", () => {
    expect(parseEditorCommand("code -w")).toEqual({ command: "code", args: ["-w"] });
    expect(parseEditorCommand("  emacsclient  -nw ")).toEqual({ command: "emacsclient", args: ["-nw"] });
  });

  it("replaces the seeded draft and strips one editor newline", async () => {
    let seen = "";
    const deps = memDeps("vim", "seed me", (contents) => {
      seen = contents;
      return "replacement\n";
    });
    await expect(composeInEditor(deps)).resolves.toEqual({ kind: "replaced", draft: "replacement" });
    expect(seen).toBe("seed me");
    expect(deps.removed()).toBe(true);
  });

  it("keeps the draft for empty edits, nonzero exits, and missing configuration", async () => {
    await expect(composeInEditor(memDeps("vim", "keep", () => "  \n"))).resolves.toEqual({ kind: "kept" });
    await expect(composeInEditor({
      editor: "vim",
      draft: "keep",
      outPath: "/tmp/vibe-compose-nonzero.md",
      writeText: async () => {},
      removeFile: async () => {},
      spawn: async () => 1,
    })).resolves.toEqual({ kind: "kept" });
    await expect(composeInEditor({ editor: undefined, draft: "keep", spawn: async () => 0 })).resolves.toEqual({ kind: "unavailable" });
  });

  it("turns spawn failures into a result and cleans the temp file", async () => {
    const deps = memDeps("missing-editor", "keep", (text) => text);
    deps.spawn = async () => { throw new Error("ENOENT"); };
    await expect(composeInEditor(deps)).resolves.toEqual({ kind: "failed", reason: "ENOENT" });
    expect(deps.removed()).toBe(true);
  });

  it("rejects oversized editor output and cleans the temp file", async () => {
    const deps = memDeps("editor", "seed", () => "x".repeat(EDITOR_DRAFT_MAX_BYTES + 1));
    await expect(composeInEditor(deps)).resolves.toEqual({
      kind: "failed",
      reason: `Editor draft exceeds ${EDITOR_DRAFT_MAX_BYTES} bytes`,
    });
    expect(deps.removed()).toBe(true);
  });
});
