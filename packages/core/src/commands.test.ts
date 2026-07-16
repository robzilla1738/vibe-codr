import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo } from "@vibe/providers";
import { formatModelList, helpText, initProject, BUILTIN_COMMANDS } from "./commands.ts";

test("formatModelList groups by provider and shows context window", () => {
  const models: ModelInfo[] = [
    { id: "claude-opus-4-8", providerId: "anthropic", contextWindow: 1_000_000 },
    { id: "gpt-x", providerId: "openai" },
  ];
  const out = formatModelList(models);
  expect(out).toContain("anthropic:");
  expect(out).toContain("anthropic/claude-opus-4-8 (1000k ctx)");
  expect(out).toContain("openai/gpt-x");
});

test("formatModelList handles the empty case with guidance", () => {
  expect(formatModelList([])).toContain("No models available");
});

test("helpText lists every built-in command", () => {
  const out = helpText();
  for (const c of BUILTIN_COMMANDS) expect(out).toContain(`/${c.name}`);
});

test("initProject creates config + memory once, idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-init-"));
  const first = await initProject(dir);
  expect(first).toContain(".vibe/config.json");
  expect(first).toContain("VIBE.md");
  expect(await Bun.file(join(dir, ".vibe", "config.json")).exists()).toBe(true);
  const second = await initProject(dir);
  expect(second).toEqual([]);
});
