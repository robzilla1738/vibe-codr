import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, gatherMemoryDocs } from "./memory-store.ts";
import { chunkMarkdown } from "./chunk.ts";

test("appendMemory writes a single day header, then one heading per fact", async () => {
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
  // Each fact gets its own `## ` heading so chunking splits per fact (not a day blob).
  expect(text.match(/^## /gm)).toHaveLength(2);
});

test("each saved fact becomes its own chunk (no day-blob dilution)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-chunk-"));
  const facts = ["uses Postgres via Neon", "Tailwind dark theme", "deploys on Fly.io"];
  // Same day, distinct seconds so each fact gets a distinct timestamped heading.
  await appendMemory(dir, { fact: facts[0]! }, new Date("2026-06-30T14:00:01Z"));
  await appendMemory(dir, { fact: facts[1]! }, new Date("2026-06-30T14:00:02Z"));
  await appendMemory(dir, { fact: facts[2]! }, new Date("2026-06-30T14:00:03Z"));

  const source = ".vibe/memory/2026-06-30.md";
  const md = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  const chunks = chunkMarkdown(source, md);

  // At least one chunk per fact (a small day-title chunk may also be present).
  expect(chunks.length).toBeGreaterThanOrEqual(3);
  // Each fact lands in EXACTLY one chunk, and that chunk carries ONLY its fact —
  // proving per-fact isolation rather than a diluted day-blob chunk.
  for (const fact of facts) {
    const matching = chunks.filter((c) => c.text.includes(fact));
    expect(matching).toHaveLength(1);
    for (const other of facts) {
      if (other !== fact) expect(matching[0]!.text).not.toContain(other);
    }
  }
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

test("always-injected curated files (USER/VIBE/AGENTS/CLAUDE.md) are excluded from the recall corpus", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore4-"));
  const memDir = join(dir, ".vibe", "memory");
  await mkdir(memDir, { recursive: true });
  // A curated always-injected file must NOT enter the searchable corpus (it's
  // already permanently in the system prompt — double-embedding wastes the budget).
  await writeFile(join(memDir, "USER.md"), "# user preferences\nalways-injected curated notes");
  await writeFile(join(memDir, "2026-01-01.md"), "# fact\nan actual saved fact about turborepo");
  const docs = await gatherMemoryDocs(dir);
  const sources = docs.map((d) => d.source);
  expect(sources.some((s) => s.endsWith("USER.md"))).toBe(false);
  expect(sources.some((s) => s.endsWith("2026-01-01.md"))).toBe(true);
});

test("concurrent saves to the same dated file don't lose entries (atomic append)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-race-"));
  const now = new Date("2026-06-30T09:00:00Z");
  // Fire many saves at once — the non-atomic read-modify-write used to drop all
  // but the last (each read the same empty file, last write won).
  const N = 25;
  await Promise.all(
    Array.from({ length: N }, (_, i) => appendMemory(dir, { fact: `fact number ${i}` }, now)),
  );
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  for (let i = 0; i < N; i++) expect(text).toContain(`fact number ${i}`);
  // Exactly N per-fact headings and a single day header.
  expect(text.match(/^## /gm)).toHaveLength(N);
  expect(text.match(/# Memory/g)).toHaveLength(1);
});
