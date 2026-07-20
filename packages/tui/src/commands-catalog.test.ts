import { test, expect } from "bun:test";
import {
  paletteState,
  applyPalette,
  isExactCommand,
  skillsPickerFilter,
  PALETTE_COMMANDS,
} from "./commands-catalog.ts";
import { ACCENT_NAMES, THEME_NAMES } from "./themes.ts";

test("isExactCommand recognizes a full command word, with or without args", () => {
  // Names come from the engine snapshot (built-ins + custom commands + skills).
  const names = new Set(["goal", "model", "myskill"]);
  expect(isExactCommand("/goal", names)).toBe(true);
  expect(isExactCommand("/goal ship it", names)).toBe(true);
  expect(isExactCommand("/MODEL", names)).toBe(true); // case-insensitive
  expect(isExactCommand("/myskill", names)).toBe(true); // skills/custom names too
  expect(isExactCommand("/goa", names)).toBe(false); // partial prefix is not exact
  expect(isExactCommand("/nope", names)).toBe(false);
  expect(isExactCommand("/", names)).toBe(false);
  expect(isExactCommand("hello", names)).toBe(false);
});

test("a plain prompt keeps the menu closed", () => {
  expect(paletteState("hello world")).toEqual({ open: false });
  expect(paletteState("")).toEqual({ open: false });
});

test("a slash opens the command list; prefix matches lead the tiers", () => {
  const all = paletteState("/");
  expect(all.open && all.mode).toBe("command");
  if (all.open && all.mode === "command") {
    expect(all.items.length).toBe(PALETTE_COMMANDS.length);
  }
  // "/mod" ranks the prefix match (/model) first; description hits ("plan MODe",
  // "Model, mode, cwd…") trail behind it instead of displacing it.
  const mod = paletteState("/mod");
  expect(mod.open && mod.mode === "command" && mod.items[0]?.name).toBe("model");
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

test("memory controls are discoverable without inventing a client-side command path", () => {
  const memory = PALETTE_COMMANDS.find((command) => command.name === "memory");
  expect(memory?.description).toContain("manage saved notes");
  expect(memory?.arg).toContain("pin <id>");
  expect(memory?.arg).toContain("merge <ids>");
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

test("/theme values track the palette registry (no hardcoded drift)", () => {
  const theme = PALETTE_COMMANDS.find((c) => c.name === "theme");
  // Every registered theme is offered (the `dark` alias is hidden by design).
  expect(theme?.values).toEqual(THEME_NAMES.filter((n) => n !== "dark"));
  expect(theme?.values).toContain("tokyonight");
  expect(theme?.values).toContain("flexoki");
});

test("/accent offers the named presets as a value submenu, and a hex still closes it", () => {
  const accent = PALETTE_COMMANDS.find((c) => c.name === "accent");
  expect(accent?.values).toEqual(ACCENT_NAMES);
  const menu = paletteState("/accent ");
  expect(menu.open && menu.mode === "value" && menu.items).toEqual(ACCENT_NAMES);
  // Typing a hex matches no preset → the menu closes so Enter submits it raw.
  expect(paletteState("/accent #fab283")).toEqual({ open: false });
});

test("palette matching is tiered fuzzy: prefix, then name-substring, then description", () => {
  // Description tier: "sessions" isn't any command name, but /resume's
  // description ("List saved sessions to resume") carries it.
  const byDesc = paletteState("/sessions");
  expect(byDesc.open).toBe(true);
  expect(byDesc.open && byDesc.mode === "command" && byDesc.items[0]?.name).toBe("resume");
  // Name-substring tier: a mid-word typo like "/oal" still finds /goal.
  const bySub = paletteState("/oal");
  expect(bySub.open && bySub.mode === "command" && bySub.items[0]?.name).toBe("goal");
  // Prefix stays first: "/co" ranks cost/context/compact/config/commands (all
  // prefix matches, catalog order) ahead of any substring/description hit.
  const byPrefix = paletteState("/co");
  expect(byPrefix.open && byPrefix.mode === "command" && byPrefix.items[0]?.name).toBe("cost");
  const names =
    byPrefix.open && byPrefix.mode === "command" ? byPrefix.items.map((c) => c.name) : [];
  const prefixNames = names.filter((n) => n.startsWith("co"));
  expect(names.slice(0, prefixNames.length)).toEqual(prefixNames);
  // Nothing matches anywhere → closed, not an empty shell.
  expect(paletteState("/zzzznope").open).toBe(false);
});

test("skills picker matches ONLY the plural — the /skill prefill must not re-open the menu", () => {
  // Regression: `/skills?` (optional s) also matched the singular `/skill <name>`
  // the menu prefills on Enter, so choosing a skill re-opened the picker and
  // Enter re-prefilled forever — the invocation could never be submitted.
  expect(skillsPickerFilter("/skills")).toBe("");
  expect(skillsPickerFilter("/skills rev")).toBe("rev");
  expect(skillsPickerFilter("/skill review ")).toBeNull(); // the prefilled invocation
  expect(skillsPickerFilter("/skill")).toBeNull();
  expect(skillsPickerFilter("/skillz")).toBeNull();
  expect(skillsPickerFilter("hello /skills")).toBeNull();
});
