import { describe, expect, it, vi } from "vitest";
import { mayReloadSettingsContext } from "./settings-load-guard";

describe("mayReloadSettingsContext", () => {
  it("allows reload when clean without prompting", () => {
    const confirmDiscard = vi.fn(() => false);
    expect(mayReloadSettingsContext({ dirty: false, confirmDiscard })).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("blocks reload when dirty and user cancels discard", () => {
    const confirmDiscard = vi.fn(() => false);
    expect(mayReloadSettingsContext({ dirty: true, confirmDiscard })).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("allows reload when dirty and user confirms discard", () => {
    const confirmDiscard = vi.fn(() => true);
    expect(mayReloadSettingsContext({ dirty: true, confirmDiscard })).toBe(true);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });
});
