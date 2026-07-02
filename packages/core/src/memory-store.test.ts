import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendMemory, gatherMemoryDocs } from "./memory-store.ts";
import { MAX_MEMORY_BYTES } from "./memory.ts";
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

test("saving a user preference past the injection budget reports overBudget honestly", async () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vibe-mstore-userbudget-"));
  try {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-mstore-userbudget-cwd-"));
    const memDir = join(process.env.XDG_CONFIG_HOME!, "vibe-codr", "memory");
    await mkdir(memDir, { recursive: true });
    // Pre-fill USER.md well OVER the injection cap so the next save keeps it over.
    const filler = Array.from(
      { length: Math.ceil(MAX_MEMORY_BYTES / 30) },
      (_, i) => `- preexisting preference number ${i} kept as byte padding`,
    ).join("\n");
    await writeFile(join(memDir, "USER.md"), `${filler}\n`);
    const over = await appendMemory(cwd, { fact: "prefers dark mode everywhere", scope: "user" });
    expect(over.deduped).toBe(false);
    expect(over.overBudget).toBe(true);

    // A save that leaves USER.md WITHIN budget carries no overBudget flag.
    process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vibe-mstore-smallbudget-"));
    const ok = await appendMemory(cwd, { fact: "uses fish shell", scope: "user" });
    expect(ok.deduped).toBe(false);
    expect(ok.overBudget).toBeUndefined();
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("a fact equal to a USER.md header phrase is saved, not falsely deduped (real dup still dedups)", async () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "vibe-mstore-hdrphrase-"));
  try {
    const cwd = mkdtempSync(join(tmpdir(), "vibe-mstore-hdrphrase-cwd-"));
    const userPath = join(process.env.XDG_CONFIG_HOME!, "vibe-codr", "memory", "USER.md");
    // Materialize USER.md WITH its boilerplate header — whose prose contains the
    // phrase "all projects". A later short fact equal to that phrase must still save
    // (the header is boilerplate, not stored fact content).
    await appendMemory(cwd, { fact: "uses fish shell", scope: "user" });
    const saved = await appendMemory(cwd, { fact: "all projects", scope: "user" });
    expect(saved.deduped).toBe(false);
    expect(await Bun.file(userPath).text()).toContain("- all projects");
    // A genuine duplicate bullet (case + trailing punctuation) still dedups.
    const dup = await appendMemory(cwd, { fact: "All projects.", scope: "user" });
    expect(dup.deduped).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test("dated dedup excludes heading boilerplate (the timestamp) but keeps fact content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-datedhdr-"));
  await appendMemory(dir, { fact: "the API listens on port 8080" }, new Date("2026-06-30T12:00:00Z"));
  // "12:00:00" is the `## HH:MM:SS —` heading's timestamp boilerplate, not fact
  // content — a fact equal to it must NOT be swallowed as a duplicate.
  const ts = await appendMemory(dir, { fact: "12:00:00" }, new Date("2026-06-30T12:00:05Z"));
  expect(ts.deduped).toBe(false);
  // A real duplicate of a stored fact (which lives INSIDE its `## HH:MM:SS —`
  // heading) still dedups.
  const dup = await appendMemory(dir, { fact: "The API listens on port 8080." }, new Date("2026-06-30T12:00:06Z"));
  expect(dup.deduped).toBe(true);
});

test("appendMemory writes atomically and leaves no stray temp file on success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-atomic-"));
  const now = new Date("2026-06-30T08:00:00Z");
  await appendMemory(dir, { fact: "uses bun test for the suite" }, now);
  const memDir = join(dir, ".vibe", "memory");
  // The temp+rename append must clean up after itself — no `*.tmp` sibling left.
  expect(readdirSync(memDir).some((f) => f.includes(".tmp"))).toBe(false);
  expect(await Bun.file(join(memDir, "2026-06-30.md")).text()).toContain("uses bun test");
});

test("a mid-append write failure leaves the existing dated file intact with no temp", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-atomicfail-"));
  await appendMemory(dir, { fact: "first durable fact about neon" }, new Date("2026-06-30T08:00:00Z"));
  const file = join(dir, ".vibe", "memory", "2026-06-30.md");
  const before = await Bun.file(file).text();
  const orig = Bun.write;
  try {
    (Bun as unknown as { write: unknown }).write = () => {
      throw new Error("injected append failure");
    };
    await expect(
      appendMemory(dir, { fact: "second fact about postgres" }, new Date("2026-06-30T08:00:05Z")),
    ).rejects.toThrow("injected append failure");
  } finally {
    (Bun as unknown as { write: typeof orig }).write = orig;
  }
  // The prior day file is byte-for-byte intact (temp+rename never replaced it) …
  expect(await Bun.file(file).text()).toBe(before);
  // … and no temp leaked from the failed write.
  expect(readdirSync(join(dir, ".vibe", "memory")).some((f) => f.includes(".tmp"))).toBe(false);
});

test("a paraphrased near-duplicate DIGEST is fuzzily deduped (exact-substring misses it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-fuzzy-"));
  // A reordering of the same session summary — NOT a verbatim substring, so the
  // exact `containsFact` check misses it; the session-digest fuzzy guard catches it.
  const d1 = "atomic temp file rename added to edit and write tools plus fuzzy digest dedup guard";
  const d2 = "fuzzy digest dedup guard plus atomic temp file rename added to edit and write tools now";
  const first = await appendMemory(dir, { fact: d1, tags: ["session-digest"] }, new Date("2026-06-30T09:00:01Z"));
  expect(first.deduped).toBe(false);
  const second = await appendMemory(dir, { fact: d2, tags: ["session-digest"] }, new Date("2026-06-30T09:00:02Z"));
  expect(second.deduped).toBe(true);
  // No second heading was appended.
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  expect(text.match(/^## /gm)).toHaveLength(1);
});

test("a genuinely different DIGEST still saves (fuzzy guard doesn't over-dedup)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-fuzzy2-"));
  const d1 = "atomic temp file rename added to edit and write tools plus fuzzy digest dedup guard";
  const d3 = "the build pipeline now runs turbo across every workspace and caches compiled outputs remotely";
  await appendMemory(dir, { fact: d1, tags: ["session-digest"] }, new Date("2026-06-30T09:00:01Z"));
  const other = await appendMemory(dir, { fact: d3, tags: ["session-digest"] }, new Date("2026-06-30T09:00:02Z"));
  expect(other.deduped).toBe(false);
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  expect(text.match(/^## /gm)).toHaveLength(2);
});

test("a SHORT digest is never fuzzily deduped away (min-token guard against false positives)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-fuzzyshort-"));
  // Two SHORT digests that are pure reorderings (Jaccard 1.0) — but below the
  // fuzzy min-token threshold, so the near-match guard does NOT apply and both save.
  const s1 = "uses bun turbo and biome";
  const s2 = "biome and turbo bun uses";
  const first = await appendMemory(dir, { fact: s1, tags: ["session-digest"] }, new Date("2026-06-30T09:00:01Z"));
  expect(first.deduped).toBe(false);
  const second = await appendMemory(dir, { fact: s2, tags: ["session-digest"] }, new Date("2026-06-30T09:00:02Z"));
  expect(second.deduped).toBe(false);
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  expect(text.match(/^## /gm)).toHaveLength(2);
});

test("an untagged plain save is NOT fuzzily deduped (fuzzy guard is digest-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-mstore-fuzzyuntagged-"));
  const d1 = "atomic temp file rename added to edit and write tools plus fuzzy digest dedup guard";
  const d2 = "fuzzy digest dedup guard plus atomic temp file rename added to edit and write tools now";
  // Without the session-digest tag, only exact-substring dedup applies — a
  // reworded near-dup still saves (a model-intended save is never fuzzily dropped).
  await appendMemory(dir, { fact: d1 }, new Date("2026-06-30T09:00:01Z"));
  const second = await appendMemory(dir, { fact: d2 }, new Date("2026-06-30T09:00:02Z"));
  expect(second.deduped).toBe(false);
  const text = await Bun.file(join(dir, ".vibe", "memory", "2026-06-30.md")).text();
  expect(text.match(/^## /gm)).toHaveLength(2);
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
