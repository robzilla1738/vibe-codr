import { describe, expect, it } from "vitest";
import { applyComposerPaste } from "./composer-edit";

describe("composer clipboard edits", () => {
  it("replaces the selected range with clipboard text", () => {
    expect(applyComposerPaste("hello old world", 6, 9, { kind: "text", text: "new" })).toEqual({
      value: "hello new world",
      caret: 9,
    });
  });

  it("inserts an image mention at the caret with token boundaries", () => {
    expect(applyComposerPaste("inspectthis", 7, 7, { kind: "image", path: ".vibe/clipboard/a.png" })).toEqual({
      value: "inspect @.vibe/clipboard/a.png this",
      caret: 31,
    });
  });

  it("quotes image paste paths that contain spaces", () => {
    const result = applyComposerPaste("", 0, 0, {
      kind: "image",
      path: ".vibe/clipboard/my clip.png",
    });
    expect(result.value).toBe('@".vibe/clipboard/my clip.png" ');
  });

  it("clamps stale selections without losing draft text", () => {
    expect(applyComposerPaste("draft", 99, 120, { kind: "text", text: "!" })).toEqual({
      value: "draft!",
      caret: 6,
    });
  });
});
