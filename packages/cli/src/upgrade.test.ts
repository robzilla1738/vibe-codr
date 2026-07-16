import { test, expect } from "bun:test";
import { detectChannel, upgradeInstructions } from "./upgrade.ts";

test("detectChannel: a bun runtime (source checkout or bun/npm global install)", () => {
  expect(detectChannel("/opt/homebrew/bin/bun")).toBe("bun");
  expect(detectChannel("/usr/local/bin/bun")).toBe("bun");
  expect(detectChannel("C:\\Users\\me\\.bun\\bin\\bun.exe")).toBe("bun");
  expect(detectChannel("/home/ci/.bun/bin/bun-canary")).toBe("bun");
});

test("detectChannel: a compiled standalone binary runs as itself", () => {
  expect(detectChannel("/usr/local/bin/vibecodr")).toBe("binary");
  expect(detectChannel("./dist/vibecodr")).toBe("binary");
  expect(detectChannel("C:\\tools\\vibecodr.exe")).toBe("binary");
});

test("upgradeInstructions: bun channel points at the package registry", () => {
  const out = upgradeInstructions({ execPath: "/usr/local/bin/bun", version: "0.3.0" });
  expect(out).toContain("bun add -g vibe-codr@latest");
  expect(out).toContain("0.3.0");
  expect(out).not.toContain("releases/latest");
});

test("upgradeInstructions: binary channel points at GitHub Releases + checksum", () => {
  const out = upgradeInstructions({ execPath: "/usr/local/bin/vibecodr", version: "0.3.0" });
  expect(out).toContain("releases/latest");
  expect(out).toContain("SHA256SUMS");
  expect(out).not.toContain("bun add -g");
});
