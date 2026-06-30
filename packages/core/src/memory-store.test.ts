import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, gatherMemoryDocs } from "./memory-store.ts";

test("appendMemory writes a dated file with a single day header, then appends", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-"));
  const now = new Date("2026-06-30T14:05:00Z");
  const path = await appendMemory(dir, { fact: "the project uses Postgres" }, now);
  await appendMemory(dir, { fact: "dark theme by default", tags: ["ui"] }, now);

  expect(path).toBe(".vibe/memory/2026-06-30.md");
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  expect(text).toContain("# Memory — 2026-06-30");
  expect(text).toContain("the project uses Postgres");
  expect(text).toContain("dark theme by default");
  expect(text).toContain("(ui)");
  // The day header is written once, not per entry.
  expect(text.match(/# Memory/g)).toHaveLength(1);
});

test("gatherMemoryDocs reads saved project memory as indexable docs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore2-"));
  await appendMemory(dir, { fact: "uses turborepo and bun" }, new Date("2026-01-01T00:00:00Z"));
  const docs = await gatherMemoryDocs(dir);
  expect(docs.length).toBeGreaterThan(0);
  expect(docs[0]!.source).toContain(".vibe/memory");
  expect(docs[0]!.text).toContain("turborepo");
});

test("gatherMemoryDocs returns [] for a project with no saved memory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore3-"));
  expect(await gatherMemoryDocs(dir)).toEqual([]);
});
