import { describe, expect, it } from "vitest";
import { appendAttachmentTokens, type MobileComposerAttachment } from "./attachment-commands";

const attachment = (token: string): MobileComposerAttachment => ({ id: token, name: token, path: token, token, size: 1 });

describe("mobile attachment prompt routing", () => {
  it("adds upload mentions only to prompt commands", () => {
    expect(appendAttachmentTokens([
      { type: "set-mode", mode: "plan" },
      { type: "submit-prompt", text: "review these" },
    ], [attachment("@one.png"), attachment('@"two words.txt"')])).toEqual([
      { type: "set-mode", mode: "plan" },
      { type: "submit-prompt", text: 'review these @one.png @"two words.txt"' },
    ]);
  });

  it("supports an attachment-only prompt", () => {
    expect(appendAttachmentTokens([{ type: "submit-prompt", text: "" }], [attachment("@photo.png")]))
      .toEqual([{ type: "submit-prompt", text: "@photo.png" }]);
  });
});
