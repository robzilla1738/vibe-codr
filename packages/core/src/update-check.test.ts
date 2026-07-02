import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkForUpdate,
  isNewer,
  readUpdateCache,
  updateDoctorCheck,
  type UpdateCache,
} from "./update-check.ts";

test("isNewer: plain core-version comparison", () => {
  expect(isNewer("0.1.0", "0.2.0")).toBe(true);
  expect(isNewer("0.2.0", "0.1.0")).toBe(false);
  expect(isNewer("0.1.0", "0.1.0")).toBe(false);
  expect(isNewer("1.0.0", "1.0.1")).toBe(true);
  expect(isNewer("0.9.0", "1.0.0")).toBe(true);
});

test("isNewer: a -dev build never claims an update against its own base", () => {
  // A dev build of X is treated as at-least X — the released X is NOT an update.
  expect(isNewer("0.3.0-dev", "0.3.0")).toBe(false);
  // But a higher core version does update a dev build.
  expect(isNewer("0.3.0-dev", "0.4.0")).toBe(true);
  expect(isNewer("0.0.0-dev", "0.1.0")).toBe(true);
});

test("isNewer: an -rc/prerelease build is behind the final of the same core", () => {
  expect(isNewer("0.3.0-rc.1", "0.3.0")).toBe(true);
  expect(isNewer("0.3.0-beta.2", "0.3.0")).toBe(true);
  // A final release is not behind a same-core prerelease.
  expect(isNewer("0.3.0", "0.3.0-rc.9")).toBe(false);
});

test("isNewer: an unparseable version on either side never nags", () => {
  expect(isNewer("not-a-version", "1.0.0")).toBe(false);
  expect(isNewer("1.0.0", "garbage")).toBe(false);
});

test("checkForUpdate: gated off returns null (config flag or env)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  const fetchImpl = (() => {
    throw new Error("fetch must not be called when gated off");
  }) as unknown as typeof fetch;

  expect(await checkForUpdate({ current: "0.1.0", enabled: false, cacheFile, fetchImpl })).toBeNull();
  expect(
    await checkForUpdate({
      current: "0.1.0",
      enabled: true,
      cacheFile,
      fetchImpl,
      env: { VIBE_NO_UPDATE_CHECK: "1" },
    }),
  ).toBeNull();
});

test("checkForUpdate: fetches on cache miss, persists, and reports availability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ tag_name: "v0.5.0" }), { status: 200 });
  }) as unknown as typeof fetch;

  const status = await checkForUpdate({
    current: "0.1.0",
    now: () => 1_000,
    cacheFile,
    fetchImpl,
    env: {},
  });
  expect(status).toEqual({ current: "0.1.0", latest: "0.5.0", updateAvailable: true });
  expect(calls).toBe(1);

  // Cache was written with the current version for /doctor.
  const persisted = JSON.parse(await readFile(cacheFile, "utf8"));
  expect(persisted).toEqual({ checkedAt: 1_000, latest: "0.5.0", current: "0.1.0" });
});

test("checkForUpdate: a fresh cache within TTL is used without fetching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ tag_name: "v9.9.9" }), { status: 200 });
  }) as unknown as typeof fetch;

  // Seed the cache at t=0.
  await checkForUpdate({ current: "0.1.0", now: () => 0, cacheFile, fetchImpl, env: {} });
  expect(calls).toBe(1);
  // 1 hour later — within the 24h TTL — no new fetch, uses cached latest.
  const status = await checkForUpdate({
    current: "0.1.0",
    now: () => 60 * 60 * 1000,
    cacheFile,
    fetchImpl,
    env: {},
  });
  expect(calls).toBe(1);
  expect(status?.latest).toBe("9.9.9");
});

test("checkForUpdate: past the TTL it re-fetches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ tag_name: `v0.${calls}.0` }), { status: 200 });
  }) as unknown as typeof fetch;

  await checkForUpdate({ current: "0.1.0", now: () => 0, cacheFile, fetchImpl, env: {} });
  const later = 25 * 60 * 60 * 1000; // 25h > 24h TTL
  await checkForUpdate({ current: "0.1.0", now: () => later, cacheFile, fetchImpl, env: {} });
  expect(calls).toBe(2);
});

test("checkForUpdate: a fetch failure falls back to the stale cached value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ tag_name: "v0.4.0" }), { status: 200 });
    return new Response("nope", { status: 500 });
  }) as unknown as typeof fetch;

  await checkForUpdate({ current: "0.1.0", now: () => 0, cacheFile, fetchImpl, env: {} });
  const later = 25 * 60 * 60 * 1000;
  const status = await checkForUpdate({ current: "0.1.0", now: () => later, cacheFile, fetchImpl, env: {} });
  expect(calls).toBe(2);
  expect(status?.latest).toBe("0.4.0"); // stale-on-failure
});

test("checkForUpdate reconciles a stale cached `current` after an in-TTL upgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  const fetchOnce = (async () =>
    new Response(JSON.stringify({ tag_name: "v0.5.0" }), { status: 200 })) as unknown as typeof fetch;

  // Seed the cache from the pre-upgrade binary: running 0.3.0, latest 0.5.0.
  await checkForUpdate({ current: "0.3.0", now: () => 0, cacheFile, fetchImpl: fetchOnce, env: {} });
  // Pre-heal, /doctor (which reads `current` from disk) would falsely nag on the
  // freshly-upgraded 0.5.0 binary because the cache still says current=0.3.0.
  const stale = await readUpdateCache(cacheFile);
  expect(stale?.current).toBe("0.3.0");
  expect(updateDoctorCheck(stale).ok).toBeNull(); // "update available" — wrong once upgraded

  // The upgraded 0.5.0 binary starts WITHIN the 24h TTL: no fetch, but the cache
  // heals so /doctor stops lying.
  const noFetch = (() => {
    throw new Error("must not fetch on a warm cache");
  }) as unknown as typeof fetch;
  const status = await checkForUpdate({
    current: "0.5.0",
    now: () => 60 * 60 * 1000,
    cacheFile,
    fetchImpl: noFetch,
    env: {},
  });
  expect(status).toEqual({ current: "0.5.0", latest: "0.5.0", updateAvailable: false });

  const healed = await readUpdateCache(cacheFile);
  expect(healed?.current).toBe("0.5.0"); // reconciled to the live version
  expect(healed?.latest).toBe("0.5.0"); // latest preserved
  expect(healed?.checkedAt).toBe(0); // checkedAt preserved — no re-fetch happened
  expect(updateDoctorCheck(healed)).toMatchObject({ ok: true });
});

test("checkForUpdate does not rewrite the cache when `current` already matches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  const cacheFile = join(dir, "update-check.json");
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify({ tag_name: "v0.5.0" }), { status: 200 });
  }) as unknown as typeof fetch;

  await checkForUpdate({ current: "0.5.0", now: () => 100, cacheFile, fetchImpl, env: {} });
  // Same version, within TTL: no fetch, and no gratuitous rewrite (checkedAt kept).
  await checkForUpdate({ current: "0.5.0", now: () => 200, cacheFile, fetchImpl, env: {} });
  expect(calls).toBe(1);
  const c = await readUpdateCache(cacheFile);
  expect(c?.checkedAt).toBe(100);
});

test("readUpdateCache tolerates a missing/corrupt file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibe-upd-"));
  expect(await readUpdateCache(join(dir, "nope.json"))).toBeNull();
  const bad = join(dir, "bad.json");
  await Bun.write(bad, "{ not json");
  expect(await readUpdateCache(bad)).toBeNull();
});

test("updateDoctorCheck: honest ok states", () => {
  expect(updateDoctorCheck(null)).toMatchObject({ ok: null, detail: "not checked yet" });

  const upToDate: UpdateCache = { checkedAt: 0, latest: "0.3.0", current: "0.3.0" };
  expect(updateDoctorCheck(upToDate)).toMatchObject({ ok: true });

  const behind: UpdateCache = { checkedAt: 0, latest: "0.5.0", current: "0.3.0" };
  const check = updateDoctorCheck(behind);
  expect(check.ok).toBeNull(); // informational (○), not a failure
  expect(check.detail).toContain("0.3.0 → 0.5.0");
});
