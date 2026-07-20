import { expect, test } from "bun:test";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateLoopbackToken, matchesLoopbackBearer } from "./token.ts";

test("token state is stable with 0700 parent and 0600 token permissions", async () => {
  const directory = join(await mkdtemp(join(tmpdir(), "vibe-token-")), "state");
  const first = await loadOrCreateLoopbackToken(directory);
  const second = await loadOrCreateLoopbackToken(directory);
  expect(Buffer.from(first.token, "base64url")).toHaveLength(32);
  expect(second).toEqual(first);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  expect((await stat(first.path)).mode & 0o777).toBe(0o600);
});

test("bearer matching accepts only the exact token", () => {
  const token = "a".repeat(43);
  expect(matchesLoopbackBearer(token, `Bearer ${token}`)).toBe(true);
  expect(matchesLoopbackBearer(token, `Bearer ${token}x`)).toBe(false);
  expect(matchesLoopbackBearer(token, null)).toBe(false);
});
