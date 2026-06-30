import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@vibe/shared";
import { SessionStore } from "./store.ts";
import { searchSessions, formatRecall } from "./recall.ts";

function msg(role: Message["role"], text: string): Message {
  return { id: `m_${role}_${text.slice(0, 4)}`, role, parts: [{ type: "text", text }], createdAt: 1 };
}

async function seed(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vibe-recall-"));
  const store = new SessionStore(dir);
  await store.save(
    { id: "ses_a", model: "m", mode: "execute", goal: "ship the JSONC config loader", createdAt: 1, updatedAt: 1000 },
    [],
    [msg("user", "Refactor the config loader to support JSONC"), msg("assistant", "Done — added a JSONC parser with comment stripping.")],
  );
  await store.save(
    { id: "ses_b", model: "m", mode: "execute", goal: "auth", createdAt: 2, updatedAt: 2000 },
    [],
    [msg("user", "Add OAuth login"), msg("assistant", "Wired the OAuth redirect flow.")],
  );
  return dir;
}

test("searchSessions finds the matching session and ranks it first", async () => {
  const dir = await seed();
  const hits = await searchSessions(dir, "JSONC config loader");
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0]!.sessionId).toBe("ses_a");
  expect(hits[0]!.snippet.toLowerCase()).toContain("jsonc");
});

test("searchSessions returns nothing for an empty query or no matches", async () => {
  const dir = await seed();
  expect(await searchSessions(dir, "   ")).toEqual([]);
  expect(await searchSessions(dir, "kubernetes helm chart")).toEqual([]);
});

test("searchSessions can exclude the live session", async () => {
  const dir = await seed();
  const hits = await searchSessions(dir, "oauth", { excludeId: "ses_b" });
  expect(hits.every((h) => h.sessionId !== "ses_b")).toBe(true);
});

test("searchSessions on a dir with no sessions yields no hits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-recall-empty-"));
  expect(await searchSessions(dir, "anything")).toEqual([]);
});

test("scores whole-word matches, not substrings ('the' is not inside 'other')", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-recall-bm25-"));
  const store = new SessionStore(dir);
  await store.save(
    { id: "has_the", model: "m", mode: "execute", goal: null, createdAt: 1, updatedAt: 1000 },
    [],
    [msg("user", "the cat sat on the mat"), msg("assistant", "ok")],
  );
  await store.save(
    { id: "substr_only", model: "m", mode: "execute", goal: null, createdAt: 2, updatedAt: 2000 },
    [],
    [msg("user", "mother brother another bother"), msg("assistant", "ok")],
  );
  const hits = await searchSessions(dir, "the");
  // Old substring scoring matched "the" inside mother/brother/another/bother.
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.every((h) => h.sessionId === "has_the")).toBe(true);
});

test("a rarer (higher-IDF) term outranks a ubiquitous one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vibe-recall-idf-"));
  const store = new SessionStore(dir);
  // "config" appears everywhere (low IDF); "zylphqx" is unique (high IDF).
  for (let i = 0; i < 6; i++) {
    await store.save(
      { id: `common_${i}`, model: "m", mode: "execute", goal: null, createdAt: i, updatedAt: 100 + i },
      [],
      [msg("user", "update the config settings here"), msg("assistant", "ok")],
    );
  }
  await store.save(
    { id: "rare", model: "m", mode: "execute", goal: null, createdAt: 9, updatedAt: 50 },
    [],
    [msg("user", "the zylphqx config tweak"), msg("assistant", "ok")],
  );
  const hits = await searchSessions(dir, "zylphqx config");
  expect(hits[0]!.sessionId).toBe("rare");
});

test("formatRecall renders matches and a clear no-match message", async () => {
  const dir = await seed();
  const hits = await searchSessions(dir, "oauth");
  const out = formatRecall("oauth", hits);
  expect(out).toContain("ses_b");
  expect(out).toContain("match");
  expect(formatRecall("nothere", [])).toContain('No matches for "nothere"');
});
