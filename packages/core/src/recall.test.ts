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

test("formatRecall renders matches and a clear no-match message", async () => {
  const dir = await seed();
  const hits = await searchSessions(dir, "oauth");
  const out = formatRecall("oauth", hits);
  expect(out).toContain("ses_b");
  expect(out).toContain("match");
  expect(formatRecall("nothere", [])).toContain('No matches for "nothere"');
});
