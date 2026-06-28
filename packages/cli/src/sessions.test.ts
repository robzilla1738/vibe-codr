import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@vibe/core";
import { formatSessions } from "./index.ts";

test("formatSessions reports 'no saved sessions' for an empty dir", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-sess-"));
  expect(await formatSessions(cwd)).toBe("No saved sessions.\n");
});

test("formatSessions lists saved sessions newest-first with model, cost, goal", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vibe-sess-"));
  const store = new SessionStore(cwd);
  await store.save(
    {
      id: "ses_old",
      model: "anthropic/claude-opus-4-8",
      mode: "execute",
      goal: "ship it",
      usage: { inputTokens: 10, outputTokens: 5, costUSD: 0.0123 },
      createdAt: 1,
      updatedAt: 1000,
    },
    [],
    [],
  );
  await store.save(
    {
      id: "ses_new",
      model: "openai/gpt-x",
      mode: "plan",
      goal: null,
      createdAt: 2,
      updatedAt: 2000,
    },
    [],
    [],
  );

  const out = await formatSessions(cwd);
  const lines = out.trimEnd().split("\n");
  expect(lines[0]).toContain("ses_new"); // newest first
  expect(lines[1]).toContain("ses_old");
  expect(out).toContain("anthropic/claude-opus-4-8");
  expect(out).toContain("$0.0123");
  expect(out).toContain("ship it");
});
