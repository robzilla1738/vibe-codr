import { describe, expect, it, vi } from "vitest";
import type { ComposerAttachment } from "../composer/Composer";
import { updateSessionComposerStates } from "./useSessionComposerState";

describe("session composer state", () => {
  it("keeps drafts and attachments isolated by session key", () => {
    let states = new Map();
    states = updateSessionComposerStates(states, "project-a\0session-1", "draft", "first");
    states = updateSessionComposerStates(states, "project-a\0session-2", "draft", "second");
    states = updateSessionComposerStates(
      states,
      "project-a\0session-1",
      "attachments",
      [{
        id: "a",
        name: "a.png",
        path: "/a.png",
        token: "@/a.png",
        isImage: true,
        size: 1,
        previewUrl: null,
      }],
    );
    expect(states.get("project-a\0session-1")?.draft).toBe("first");
    expect(states.get("project-a\0session-2")?.draft).toBe("second");
    expect(states.get("project-a\0session-2")?.attachments).toEqual([]);
  });

  it("evicts the least-recently-updated composer and releases previews", () => {
    const released = vi.fn<(attachments: readonly ComposerAttachment[]) => void>();
    const attachment: ComposerAttachment = {
      id: "a",
      name: "a.png",
      path: "/a.png",
      token: "@/a.png",
      isImage: true,
      size: 1,
      previewUrl: "blob:a",
    };
    let states = updateSessionComposerStates(
      new Map(),
      "old",
      "attachments",
      [attachment],
      { maxEntries: 2, release: released },
    );
    states = updateSessionComposerStates(states, "new", "draft", "two", {
      maxEntries: 2,
      release: released,
    });
    states = updateSessionComposerStates(states, "newest", "draft", "three", {
      maxEntries: 2,
      release: released,
    });
    expect(states.has("old")).toBe(false);
    expect(released).toHaveBeenCalledWith([attachment]);
  });

  it("keeps input history isolated like other composer state", () => {
    let states = new Map();
    states = updateSessionComposerStates(states, "one", "history", ["first", "second"]);
    states = updateSessionComposerStates(states, "two", "history", ["other"]);
    expect(states.get("one")?.history).toEqual(["first", "second"]);
    expect(states.get("two")?.history).toEqual(["other"]);
  });
});
