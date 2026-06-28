import { test, expect } from "bun:test";
import { paletteState, applyPalette, PALETTE_COMMANDS } from "./commands-catalog.ts";

test("a plain prompt keeps the menu closed", () => {
  expect(paletteState("hello world")).toEqual({ open: false });
  expect(paletteState("")).toEqual({ open: false });
});

test("a slash opens the command list and filters by prefix", () => {
  const all = paletteState("/");
  expect(all.open && all.mode).toBe("command");
  if (all.open && all.mode === "command") {
    expect(all.items.length).toBe(PALETTE_COMMANDS.length);
  }
  const mod = paletteState("/mod");
  expect(mod.open && mod.mode === "command" && mod.items.map((c) => c.name)).toEqual([
    "model",
    "models",
  ]);
});

test("an unknown command closes the menu", () => {
  expect(paletteState("/zzz")).toEqual({ open: false });
});

test("enum commands drill into a value list after the space", () => {
  const v = paletteState("/approvals ");
  expect(v.open && v.mode).toBe("value");
  if (v.open && v.mode === "value") {
    expect(v.items).toEqual(["ask", "auto"]);
    expect(v.command.name).toBe("approvals");
  }
  expect(paletteState("/approvals as")).toMatchObject({ mode: "value", items: ["ask"] });
});

test("free-form arg commands show no value menu", () => {
  expect(paletteState("/model ")).toEqual({ open: false });
  expect(paletteState("/goal ship it")).toEqual({ open: false });
});

test("applyPalette completes a no-arg command as done", () => {
  const st = paletteState("/plan");
  expect(applyPalette(st, 0)).toEqual({ draft: "/plan", done: true });
});

test("applyPalette completes an enum command to a trailing space (not done)", () => {
  const st = paletteState("/approv");
  expect(applyPalette(st, 0)).toEqual({ draft: "/approvals ", done: false });
});

test("applyPalette completes a value as a runnable command", () => {
  const st = paletteState("/approvals ");
  expect(applyPalette(st, 1)).toEqual({ draft: "/approvals auto", done: true });
});
