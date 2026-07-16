import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CwdAllowlist,
  isAllowedRevealPath,
  isAllowedTerminalCwd,
  pathIsInsideRoot,
} from "./cwd-allowlist";

describe("CwdAllowlist", () => {
  it("accepts exact registered roots and their children", () => {
    const list = new CwdAllowlist(["/Users/rob/Code/acme"]);
    expect(list.has("/Users/rob/Code/acme")).toBe(true);
    expect(list.has("/Users/rob/Code/acme/src")).toBe(true);
    expect(list.hasExact("/Users/rob/Code/acme")).toBe(true);
    expect(list.hasExact("/Users/rob/Code/acme/src")).toBe(false);
    expect(list.has("/Users/rob/Code/other")).toBe(false);
  });

  it("rejects empty and foreign paths", () => {
    const list = new CwdAllowlist(["/proj"]);
    expect(list.has("")).toBe(false);
    expect(list.has("/etc")).toBe(false);
  });

  it("does not implicitly trust global state directories", () => {
    const list = new CwdAllowlist();
    expect(list.has(resolve("/Users/rob", ".vibe"))).toBe(false);
    expect(list.has(resolve("/Users/rob", ".config", "vibe-codr"))).toBe(false);
  });

  it("allows only the exact home directory as the terminal-specific exception", () => {
    const home = "/Users/rob";
    expect(isAllowedTerminalCwd(home, home)).toBe(true);
    expect(isAllowedTerminalCwd(`${home}/Desktop`, home)).toBe(false);
    expect(isAllowedTerminalCwd("/etc", home)).toBe(false);
  });

  it("uses path boundaries instead of prefix matching", () => {
    expect(pathIsInsideRoot("/proj/src", "/proj")).toBe(true);
    expect(pathIsInsideRoot("/project", "/proj")).toBe(false);
    expect(pathIsInsideRoot("/proj/../etc", "/proj")).toBe(false);
  });

  it("reveals external projects and only the app-owned clipboard temp root", () => {
    const list = new CwdAllowlist(["/Volumes/Work/acme"]);
    const clips = "/private/tmp/vibe-clips-123";
    expect(isAllowedRevealPath("/Volumes/Work/acme/src/app.ts", clips, list)).toBe(true);
    expect(isAllowedRevealPath(`${clips}/image.png`, clips, list)).toBe(true);
    expect(isAllowedRevealPath("/private/tmp/other/image.png", clips, list)).toBe(false);
    expect(isAllowedRevealPath("/Users/rob/Documents/private.txt", clips, list)).toBe(false);
  });

  it("does not authorize a symlinked child that resolves outside the project", () => {
    const base = mkdtempSync(join(tmpdir(), "vibe-cwd-"));
    try {
      const project = join(base, "project");
      const outside = join(base, "outside");
      mkdirSync(project);
      mkdirSync(outside);
      const link = join(project, "outside-link");
      symlinkSync(outside, link, "dir");
      const list = new CwdAllowlist([project]);
      expect(list.has(project)).toBe(true);
      expect(list.has(link)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
