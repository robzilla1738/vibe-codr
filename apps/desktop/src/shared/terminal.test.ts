import { describe, expect, it } from "vitest";
import { terminalSessionNeedsReopen } from "./terminal";

describe("terminalSessionNeedsReopen", () => {
  it("recognizes stale PTY failures without retrying unrelated errors", () => {
    expect(terminalSessionNeedsReopen("Terminal session is no longer open")).toBe(true);
    expect(terminalSessionNeedsReopen("Terminal session exited before input could be written")).toBe(true);
    expect(terminalSessionNeedsReopen("Terminal input is too large")).toBe(false);
  });
});
