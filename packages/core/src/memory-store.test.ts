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
  const saved = await appendMemory(dir, { fact: "the project uses Postgres" }, now);
  await appendMemory(dir, { fact: "dark theme by default", tags: ["ui"] }, now);

  expect(saved.path).toBe(".vibe/memory/2026-06-30.md");
  expect(saved.deduped).toBe(false);
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

test("re-saving an equivalent fact is deduped — across days, case, and trailing punctuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-dedup-"));
  const first = await appendMemory(dir, { fact: "Deploys to Fly.io via GitHub Actions." }, new Date("2026-06-29T10:00:00Z"));
  expect(first.deduped).toBe(false);
  // Same knowledge, different casing/punctuation, saved a DAY later → skipped;
  // no second file, no second heading.
  const again = await appendMemory(dir, { fact: "deploys to fly.io via github actions" }, new Date("2026-06-30T10:00:00Z"));
  expect(again.deduped).toBe(true);
  expect(await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).exists()).toBe(false);
  const day1 = await Bun.file(join(dir, ".vibe", "memory", "2026-06-29.md")).text();
  expect(day1.match(/^## /gm)).toHaveLength(1);
});

test("dedup requires word boundaries — a fact is not swallowed by a longer token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-bound-"));
  const now = new Date("2026-06-30T10:00:00Z");
  await appendMemory(dir, { fact: "port 8012 serves the API" }, now);
  // "port 801" IS a raw substring of "port 8012", but the token continues ("2")
  // — a different fact, so it must save, not dedupe.
  const second = await appendMemory(dir, { fact: "port 801" }, now);
  expect(second.deduped).toBe(false);
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  expect(text.match(/^## /gm)).toHaveLength(2);
});

test("scope 'user' appends one-line bullets to the always-injected USER.md, with dedup", async () => {
  // XDG_CONFIG_HOME is redirected by the test preload; isolate further per-test.
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vibe-mstore-user-"));
  try {
    const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-user-cwd-"));
    const saved = await appendMemory(dir, {
      fact: "prefers tabs over\n  spaces in Go projects",
      scope: "user",
    });
    expect(saved).toEqual({ path: "~/.config/vibe-codr/memory/USER.md", deduped: false });
    const userPath = join(process.env.XDG_CONFIG_HOME!, "vibe-codr", "memory", "USER.md");
    const text = await Bun.file(userPath).text();
    // Header written once; the fact is a single collapsed-whitespace bullet.
    expect(text).toContain("# User memory");
    expect(text).toContain("- prefers tabs over spaces in Go projects");
    // Equivalent re-save (case + trailing period) is skipped, file unchanged.
    const again = await appendMemory(dir, { fact: "Prefers tabs over spaces in Go projects.", scope: "user" });
    expect(again.deduped).toBe(true);
    expect(await Bun.file(userPath).text()).toBe(text);
    // A genuinely new preference appends a second bullet, header not repeated.
    await appendMemory(dir, { fact: "never force-push to main", scope: "user" });
    const after = await Bun.file(userPath).text();
    expect(after).toContain("- never force-push to main");
    expect(after.match(/# User memory/g)).toHaveLength(1);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
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
