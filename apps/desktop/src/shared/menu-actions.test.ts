import { describe, expect, it } from "vitest";
import { isMenuAction, MENU_ACTIONS } from "./menu-actions";

describe("menu actions", () => {
  it("accepts every declared action", () => {
    for (const action of MENU_ACTIONS) expect(isMenuAction(action)).toBe(true);
  });

  it("rejects malformed and unknown IPC payloads", () => {
    for (const value of [null, 1, {}, "", "toggleDevTools", "new-session"]) {
      expect(isMenuAction(value)).toBe(false);
    }
  });
});
