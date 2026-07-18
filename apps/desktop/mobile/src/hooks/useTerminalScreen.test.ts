import { describe, it, expect } from "vitest";
import { reduceScreen, initialScreen } from "./useTerminalScreen";

function text(screen: ReturnType<typeof initialScreen>): string {
  return screen.lines.map((line) => line.map((c) => c.ch).join("")).join("\n");
}

describe("terminal screen model", () => {
  it("writes plain text and wraps on newline", () => {
    const s = reduceScreen(initialScreen(), "hello\nworld");
    expect(text(s)).toBe("hello\nworld");
    expect(s.row).toBe(1);
  });
  it("carriage return resets column (overwrites line)", () => {
    const s = reduceScreen(initialScreen(), "abc\rXY");
    expect(text(s)).toBe("XYc");
  });
  it("backspace moves the cursor back", () => {
    const s = reduceScreen(initialScreen(), "abcd\b\be");
    // after abcd, two backspaces → col 2, then 'e' overwrites 'c' → abed
    expect(text(s)).toBe("abed");
  });
  it("strips SGR sequences and applies color", () => {
    const s = reduceScreen(initialScreen(), "\x1b[32mgreen\x1b[0m text");
    expect(text(s)).toBe("green text");
    expect(s.lines[0]![0]!.color).toBe("#4fd6be");
    expect(s.lines[0]![6]!.color).toBeNull();
  });
  it("strips OSC sequences (title set)", () => {
    const s = reduceScreen(initialScreen(), "\x1b]0;my title\x07prompt$ ");
    expect(text(s)).toBe("prompt$ ");
  });
  it("strips cursor-move CSI without breaking text (simplified: no cursor motion)", () => {
    const s = reduceScreen(initialScreen(), "a\x1b[2Cb");
    // The simplified model strips cursor-move CSI rather than emulating motion,
    // so the 'b' lands right after 'a'.
    expect(text(s)).toBe("ab");
  });
  it("caps line count", () => {
    let s = initialScreen();
    for (let i = 0; i < 3000; i++) s = reduceScreen(s, `line ${i}\n`);
    expect(s.lines.length).toBeLessThanOrEqual(2000);
  });
});
